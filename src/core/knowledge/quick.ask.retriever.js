// Quick Ask retrieval layer.
// Reads previously collected evidence + trusted confirmed repair outcomes.
// It does not call an LLM and it does not create verified repair truth.

const { supabase: defaultSupabase } = require('../../db');

const STOP = new Set(['the','a','an','and','or','of','to','in','on','for','with','is','it','this','that','what','would','could','cause','causes','issue','issues','problem','problems','most','common']);
const LEMON_SHELL = /(?:\bservice manual\s*[~\-]?\s*lemon manuals\b|\blemon manuals\s*:\s*even more car manuals\b|\bhome\s*>>|\bjuly\s+1\s*:\s*so it begins\b)/i;

function clean(v) { return String(v ?? '').trim(); }
function norm(v) { return clean(v).toLowerCase().replace(/\s+/g, ' '); }
function decodeHtmlEntities(v) {
  return clean(v)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}
function cleanEvidenceText(v, max = 320) {
  let text = decodeHtmlEntities(v)
    .replace(/<[^>]*>/g, ' ')
    .replace(/[\t\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const shell = text.search(LEMON_SHELL);
  if (shell > 0) text = text.slice(0, shell).trim();
  text = text.replace(/\s+-\s+Description\s+/i, ' — ').replace(/^Description\s+/i, '');
  if (text.length > max) text = `${text.slice(0, max - 1).trimEnd()}…`;
  return text;
}
function cleanBulletinDate(v) {
  const text = cleanEvidenceText(v, 120);
  const iso = text.match(/\b\d{4}-\d{2}-\d{2}\b/);
  if (iso) return iso[0];
  const named = text.match(/\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2},\s+\d{4}\b/i);
  return named ? named[0] : text;
}
function tokens(v) {
  return [...new Set(norm(v).replace(/[^a-z0-9]+/g, ' ').split(' ').filter(t => t.length > 2 && !STOP.has(t)))];
}
function vehicleMatches(candidate = {}, requested = {}) {
  const sameMake = !requested.make || norm(candidate.make) === norm(requested.make);
  const sameModel = !requested.model || norm(candidate.model) === norm(requested.model);
  const sameYear = !requested.year || !candidate.year || Number(candidate.year) === Number(requested.year);
  return sameMake && sameModel && sameYear;
}
function overlapScore(text, queryTokens) {
  if (!queryTokens.length) return 0;
  const hay = new Set(tokens(text));
  return queryTokens.reduce((n, t) => n + (hay.has(t) ? 1 : 0), 0) / queryTokens.length;
}
function causeFromExample(example = {}) {
  const raw = example.labels?.rawAiOutput;
  if (typeof raw === 'string') return clean(raw);
  if (raw && typeof raw === 'object') return clean(raw.primaryCause || raw.confirmedCause || raw.result || raw.cause);
  return '';
}
function vehicleFromExample(example = {}) {
  return example.labels?.vehicle || example.metadata?.vehicle || {};
}
function repairText(example = {}) {
  const actual = example.labels?.actualRepair;
  const cause = causeFromExample(example);
  return [cause, typeof actual === 'string' ? actual : JSON.stringify(actual || {})].join(' ');
}
function activeTrustedExamples(rows = []) {
  const trusted = rows.filter(row => row.metadata?.trustedForTraining === true && row.labels?.confirmedRepairCase);
  const latestByJob = new Map();
  for (const row of trusted) {
    const jobId = row.request_id || row.requestId || row.id;
    const correctionCount = Number(row.labels?.confirmedRepairCase?.correctionCount || 0);
    const current = latestByJob.get(jobId);
    const currentCount = Number(current?.labels?.confirmedRepairCase?.correctionCount || 0);
    const rowDate = new Date(row.metadata?.createdAt || row.stored_at || 0).getTime();
    const currentDate = new Date(current?.metadata?.createdAt || current?.stored_at || 0).getTime();
    if (!current || correctionCount > currentCount || (correctionCount === currentCount && rowDate > currentDate)) {
      latestByJob.set(jobId, row);
    }
  }
  return [...latestByJob.values()];
}
function bulletinKey(row = {}) {
  const number = norm(row.bulletin_number);
  if (number) return `number:${number}`;
  return `fallback:${norm(row.subject || row.title)}|${cleanBulletinDate(row.bulletin_date)}`;
}
function normalizeTsbRow(row = {}) {
  const body = cleanEvidenceText(row.body_text, 320);
  return {
    ...row,
    title: cleanEvidenceText(row.title, 180),
    bulletin_number: cleanEvidenceText(row.bulletin_number, 80),
    bulletin_date: cleanBulletinDate(row.bulletin_date),
    group_name: cleanEvidenceText(row.group_name, 120),
    subject: cleanEvidenceText(row.subject, 220),
    body_text: body,
    source: cleanEvidenceText(row.source, 80),
    source_url: clean(row.source_url)
  };
}

class QuickAskRetriever {
  constructor(client = defaultSupabase) {
    this.client = client;
  }

  async _tsbs(vehicle, query, limit) {
    if (!this.client) return [];
    const qt = tokens(query);
    if (!qt.length) return [];
    let q = this.client.from('vehicle_tsb_corpus').select('year,make,model,title,bulletin_number,bulletin_date,group_name,subject,body_text,source,source_url');
    if (vehicle.year) q = q.eq('year', Number(vehicle.year));
    if (vehicle.make) q = q.ilike('make', clean(vehicle.make));
    if (vehicle.model) q = q.ilike('model', clean(vehicle.model));
    const { data, error } = await q.limit(250);
    if (error) throw new Error(`vehicle_tsb_corpus lookup failed: ${error.message}`);

    const scored = (data || []).map(raw => {
      const row = normalizeTsbRow(raw);
      const relevance = overlapScore([row.title,row.group_name,row.subject,row.body_text].join(' '), qt);
      return { row, relevance };
    });

    const bestByBulletin = new Map();
    for (const item of scored) {
      const key = bulletinKey(item.row);
      const current = bestByBulletin.get(key);
      const itemDate = String(item.row.bulletin_date || '');
      const currentDate = String(current?.row?.bulletin_date || '');
      const better = !current ||
        item.relevance > current.relevance ||
        (item.relevance === current.relevance && itemDate > currentDate) ||
        (item.relevance === current.relevance && itemDate === currentDate && item.row.body_text.length > current.row.body_text.length);
      if (better) bestByBulletin.set(key, item);
    }

    return [...bestByBulletin.values()]
      .sort((a,b) => b.relevance - a.relevance || String(b.row.bulletin_date || '').localeCompare(String(a.row.bulletin_date || '')))
      .slice(0, limit)
      .map(({ row }) => row);
  }

  async _confirmedRepairs(vehicle, query, limit) {
    if (!this.client) return { sampleSize: 0, ranked: [] };
    const { data, error } = await this.client
      .from('feedback_examples')
      .select('id,request_id,labels,metadata,stored_at')
      .order('stored_at', { ascending: false })
      .limit(500);
    if (error) throw new Error(`feedback_examples lookup failed: ${error.message}`);

    const qt = tokens(query);
    const matched = activeTrustedExamples(data || [])
      .filter(row => vehicleMatches(vehicleFromExample(row), vehicle))
      .filter(row => norm(row.labels?.mechanicAssessment?.diagnosisCorrect) === 'correct')
      .map(row => ({ row, cause: causeFromExample(row), relevance: overlapScore(repairText(row), qt) }))
      .filter(x => x.cause);

    const groups = new Map();
    for (const item of matched) {
      const key = norm(item.cause);
      const g = groups.get(key) || { cause: item.cause, count: 0, relevance: 0 };
      g.count += 1;
      g.relevance = Math.max(g.relevance, item.relevance);
      groups.set(key, g);
    }
    const total = matched.length;
    const ranked = [...groups.values()]
      .sort((a,b) => b.relevance - a.relevance || b.count - a.count)
      .slice(0, limit)
      .map(g => ({
        cause: g.cause,
        confirmedCases: g.count,
        sampleSize: total,
        observedRepairShare: total ? Number((g.count / total).toFixed(3)) : null,
        evidenceStrength: total >= 20 ? 'HIGH' : total >= 5 ? 'MEDIUM' : total > 0 ? 'LOW' : 'NONE'
      }));
    return { sampleSize: total, ranked };
  }

  async ask({ vehicle = {}, query = '', limit = 5 } = {}) {
    const capped = Math.min(10, Math.max(1, Number(limit) || 5));
    if (!clean(vehicle.make) || !clean(vehicle.model)) {
      throw new Error('Quick Ask requires vehicle.make and vehicle.model');
    }
    const queryText = clean(query);
    const [repairs, tsbs] = await Promise.all([
      this._confirmedRepairs(vehicle, queryText, capped),
      this._tsbs(vehicle, queryText, capped)
    ]);
    const warnings = [
      'Observed repair share is not diagnostic probability.',
      'Published TSB frequency is not repair probability.',
      'Quick Ask does not verify a fault or unlock repair authorization.'
    ];
    if (!tokens(queryText).length) {
      warnings.unshift('No question or symptom text was provided; published evidence is not ranked without a query.');
    }
    return {
      status: 'SUCCESS',
      mode: 'RETRIEVAL_ONLY',
      queryMode: tokens(queryText).length ? 'QUERY' : 'VEHICLE_ONLY',
      vehicle: { year: vehicle.year || null, make: clean(vehicle.make), model: clean(vehicle.model), engine: clean(vehicle.engine) || null },
      query: queryText,
      commonConfirmedRepairs: repairs.ranked,
      confirmedRepairSampleSize: repairs.sampleSize,
      publishedEvidence: tsbs,
      warnings
    };
  }
}

module.exports = { QuickAskRetriever, tokens, activeTrustedExamples, vehicleMatches, causeFromExample, cleanEvidenceText, cleanBulletinDate, bulletinKey, normalizeTsbRow };
