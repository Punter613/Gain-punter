'use strict';

const { supabase } = require('../db');

const MAX_CORPUS_ROWS = 500;
const DEFAULT_LIMIT = 8;
const MAX_EVIDENCE_EXCERPT = 800;

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalize(value) {
  return clean(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function normalizeBulletinId(value) {
  return clean(value).replace(/[^a-z0-9]/gi, '').toUpperCase();
}

function contextText(context = {}) {
  return normalize([
    context.symptoms,
    ...(Array.isArray(context.mechanicNotices) ? context.mechanicNotices : []),
    ...(Array.isArray(context.keywords) ? context.keywords : [])
  ].filter(Boolean).join(' '));
}

function contextCodes(context = {}) {
  return (Array.isArray(context.obdCodes) ? context.obdCodes : [])
    .map(code => clean(code).toUpperCase())
    .filter(Boolean);
}

function boundedExcerpt(value, max = MAX_EVIDENCE_EXCERPT) {
  return clean(value).slice(0, max);
}

function rowToReference(row = {}) {
  const bulletinNumber = clean(row.bulletin_number);
  const component = clean(row.group_name || row.subject);
  const summary = clean(row.body_text);
  const excerpt = boundedExcerpt(summary);
  return {
    title: bulletinNumber ? `${bulletinNumber}: ${component || 'Manufacturer communication'}` : (component || 'Manufacturer communication'),
    url: '',
    evidenceType: 'TSB_CANDIDATE',
    sourceAuthority: 'NHTSA_BULK',
    source: 'NHTSA_BULK',
    bulletinNumber,
    bulletinDate: clean(row.bulletin_date),
    groupName: component,
    subject: clean(row.subject || row.group_name),
    snippet: summary.slice(0, 3500),
    bodyText: summary,
    excerpt,
    extractedFacts: {
      ...(row.extracted_facts || {}),
      source: 'NHTSA_BULK',
      evidenceExcerpt: excerpt,
      matchedSignals: []
    },
    matchedKeywords: [],
    matchedSignals: [],
    relevanceScore: 0
  };
}

function scoreReference(reference, context = {}) {
  const symptoms = contextText(context);
  const codes = contextCodes(context);
  const haystack = normalize([
    reference.title,
    reference.subject,
    reference.groupName,
    reference.snippet,
    JSON.stringify(reference.extractedFacts || {})
  ].filter(Boolean).join(' '));
  const rawHaystack = clean(reference.snippet).toUpperCase();
  let score = 0;
  const matched = [];
  const matchedSignals = [];

  for (const code of codes) {
    if (rawHaystack.includes(code) || clean(reference.subject).toUpperCase().includes(code)) {
      score += 30;
      matched.push(code);
      matchedSignals.push(`DTC:${code}`);
    }
  }

  const tokens = [...new Set(symptoms.split(' ').filter(token => token.length >= 4))];
  for (const token of tokens) {
    if (haystack.includes(token)) {
      score += 3;
      matched.push(token);
      matchedSignals.push(`SYMPTOM:${token}`);
    }
  }

  const boosts = [
    [/clunk|noise|chatter|vibration|knock|thud|bump/, 8, 'noise-family'],
    [/deceler|throttle release|accelerator release|load change|torque reversal/, 10, 'load-change'],
    [/steering|full lock|rack|tie rod/, 8, 'steering'],
    [/driveshaft|propeller shaft|transfer case|differential|driveline|u joint|universal joint/, 10, 'driveline'],
    [/misfire|lean|fuel trim|vacuum|intake|ignition/, 10, 'engine-performance'],
    [/brake|braking/, 6, 'brakes']
  ];

  for (const [pattern, points, label] of boosts) {
    if (pattern.test(symptoms) && pattern.test(haystack)) {
      score += points;
      matched.push(label);
      matchedSignals.push(`OVERLAP:${label}`);
    }
  }

  const uniqueSignals = [...new Set(matchedSignals)];
  return {
    ...reference,
    relevanceScore: score,
    matchedKeywords: [...new Set(matched)],
    matchedSignals: uniqueSignals,
    extractedFacts: {
      ...(reference.extractedFacts || {}),
      source: reference.sourceAuthority || reference.source || 'NHTSA_BULK',
      evidenceExcerpt: boundedExcerpt(reference.excerpt || reference.snippet || reference.bodyText),
      matchedSignals: uniqueSignals
    }
  };
}

function referenceKey(reference = {}) {
  const bulletinId = normalizeBulletinId(reference.bulletinNumber);
  const fallback = normalize(`${reference.subject}|${reference.snippet}`).slice(0, 240);
  return bulletinId || fallback;
}

function union(valuesA = [], valuesB = []) {
  return [...new Set([...(valuesA || []), ...(valuesB || [])].filter(Boolean))];
}

function dedupeReferencesKeepingHighestScore(references = []) {
  const strongest = new Map();
  for (const reference of references) {
    const key = referenceKey(reference);
    if (!key) continue;
    const existing = strongest.get(key);
    if (!existing || Number(reference.relevanceScore || 0) > Number(existing.relevanceScore || 0)) {
      strongest.set(key, reference);
    } else if (Number(reference.relevanceScore || 0) === Number(existing.relevanceScore || 0)) {
      strongest.set(key, {
        ...existing,
        matchedKeywords: union(existing.matchedKeywords, reference.matchedKeywords),
        matchedSignals: union(existing.matchedSignals, reference.matchedSignals),
        extractedFacts: {
          ...(existing.extractedFacts || {}),
          matchedSignals: union(existing.matchedSignals, reference.matchedSignals)
        }
      });
    }
  }
  return [...strongest.values()];
}

function rankNhtsaRows(rows = [], context = {}, options = {}) {
  const minScore = Number.isFinite(options.minScore) ? options.minScore : 1;
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : DEFAULT_LIMIT;
  const scored = rows.map(rowToReference).map(ref => scoreReference(ref, context));
  return dedupeReferencesKeepingHighestScore(scored)
    .filter(ref => ref.relevanceScore >= minScore)
    .sort((a, b) => b.relevanceScore - a.relevanceScore)
    .slice(0, limit);
}

async function loadNhtsaCorpus(vehicle, context = {}, options = {}) {
  if (!supabase || !vehicle?.year || !vehicle?.make || !vehicle?.model) {
    return { references: [], totalFetched: 0, available: false };
  }

  const rowLimit = Number.isInteger(options.rowLimit) && options.rowLimit > 0
    ? Math.min(options.rowLimit, MAX_CORPUS_ROWS)
    : MAX_CORPUS_ROWS;

  try {
    const { data, error } = await supabase
      .from('vehicle_tsb_corpus')
      .select('bulletin_number, bulletin_date, group_name, subject, body_text, extracted_facts, source')
      .eq('year', Number(vehicle.year))
      .ilike('make', clean(vehicle.make))
      .ilike('model', clean(vehicle.model))
      .eq('source', 'NHTSA_BULK')
      .limit(rowLimit);

    if (error) throw error;
    const rows = data || [];
    return {
      references: rankNhtsaRows(rows, context, options),
      totalFetched: rows.length,
      available: rows.length > 0,
      truncated: rows.length >= rowLimit,
      source: 'NHTSA_BULK'
    };
  } catch (err) {
    console.warn('[NHTSA TSB Corpus] lookup failed (non-fatal):', err.message);
    return { references: [], totalFetched: 0, available: false, error: err.message };
  }
}

function mergeTsbReferences(primary = [], nhtsa = [], limit = 15) {
  const merged = new Map();

  for (const reference of primary) {
    const id = normalizeBulletinId(reference.bulletinNumber);
    const key = id || `PRIMARY:${normalize(`${reference.subject}|${reference.snippet}`).slice(0, 240)}`;
    merged.set(key, { ...reference });
  }

  for (const reference of nhtsa) {
    const id = normalizeBulletinId(reference.bulletinNumber);
    const key = id || `NHTSA:${normalize(`${reference.subject}|${reference.snippet}`).slice(0, 240)}`;
    if (merged.has(key)) {
      const existing = merged.get(key);
      const existingScore = Number(existing.relevanceScore || 0);
      const nhtsaScore = Number(reference.relevanceScore || 0);
      const strongest = nhtsaScore > existingScore ? reference : existing;
      const matchedSignals = union(existing.matchedSignals || existing.extractedFacts?.matchedSignals, reference.matchedSignals || reference.extractedFacts?.matchedSignals);
      const matchedKeywords = union(existing.matchedKeywords, reference.matchedKeywords);
      const strongestExcerpt = boundedExcerpt(strongest.excerpt || strongest.snippet || strongest.bodyText || strongest.extractedFacts?.evidenceExcerpt);

      merged.set(key, {
        ...existing,
        relevanceScore: Math.max(existingScore, nhtsaScore),
        matchedKeywords,
        matchedSignals,
        excerpt: strongestExcerpt || existing.excerpt,
        extractedFacts: {
          ...(existing.extractedFacts || {}),
          evidenceExcerpt: strongestExcerpt || existing.extractedFacts?.evidenceExcerpt || boundedExcerpt(existing.snippet),
          matchedSignals,
          nhtsaVerified: true
        },
        nhtsaVerified: true,
        nhtsaReference: reference
      });
    } else {
      merged.set(key, { ...reference });
    }
  }

  return [...merged.values()]
    .sort((a, b) => Number(b.relevanceScore || 0) - Number(a.relevanceScore || 0))
    .slice(0, limit);
}

module.exports = {
  MAX_CORPUS_ROWS,
  MAX_EVIDENCE_EXCERPT,
  normalizeBulletinId,
  boundedExcerpt,
  rowToReference,
  scoreReference,
  dedupeReferencesKeepingHighestScore,
  rankNhtsaRows,
  loadNhtsaCorpus,
  mergeTsbReferences
};
