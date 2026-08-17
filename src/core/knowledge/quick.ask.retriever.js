// Quick Ask retrieval layer.
// Reads previously collected evidence + trusted confirmed repair outcomes.
// It does not call an LLM and it does not create verified repair truth.

const { supabase: defaultSupabase } = require('../../db');

const STOP = new Set(['the','a','an','and','or','of','to','in','on','for','with','is','it','this','that','what','would','could','cause','causes','issue','issues','problem','problems','most','common']);

function clean(v) { return String(v ?? '').trim(); }
function norm(v) { return clean(v).toLowerCase().replace(/\s+/g, ' '); }
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

class QuickAskRetriever {
  constructor(client = defaultSupabase) {
    this.client = client;
  }

  async _tsbs(vehicle, query, limit) {
    if (!this.client) return [];
    let q = this.client.from('vehicle_tsb_corpus').select('year,make,model,title,bulletin_number,bulletin_date,group_name,subject,body_text,source,source_url');
    if (vehicle.year) q = q.eq('year', Number(vehicle.year));
    if (vehicle.make) q = q.ilike('make', clean(vehicle.make));
    if (vehicle.model) q = q.ilike('model', clean(vehicle.model));
    const { data, error } = await q.limit(250);
    if (error) throw new Error(`vehicle_tsb_corpus lookup failed: ${error.message}`);
    const qt = tokens(query);
    return (data || [])
      .map(row => ({ ...row, relevance: overlapScore([row.title,row.group_name,row.subject,row.body_text].join(' '), qt) }))
      .sort((a,b) => b.relevance - a.relevance || String(b.bulletin_date || '').localeCompare(String(a.bulletin_date || '')))
      .slice(0, limit)
      .map(({ relevance, ...row }) => row);
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
    const [repairs, tsbs] = await Promise.all([
      this._confirmedRepairs(vehicle, query, capped),
      this._tsbs(vehicle, query, capped)
    ]);
    return {
      status: 'SUCCESS',
      mode: 'RETRIEVAL_ONLY',
      vehicle: { year: vehicle.year || null, make: clean(vehicle.make), model: clean(vehicle.model), engine: clean(vehicle.engine) || null },
      query: clean(query),
      commonConfirmedRepairs: repairs.ranked,
      confirmedRepairSampleSize: repairs.sampleSize,
      publishedEvidence: tsbs,
      warnings: [
        'Observed repair share is not diagnostic probability.',
        'Published TSB frequency is not repair probability.',
        'Quick Ask does not verify a fault or unlock repair authorization.'
      ]
    };
  }
}

module.exports = { QuickAskRetriever, tokens, activeTrustedExamples, vehicleMatches, causeFromExample };
