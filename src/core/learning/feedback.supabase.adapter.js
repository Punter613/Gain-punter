// feedback.supabase.adapter.js
// Persistent storage adapter for the mechanic feedback loop.
// Same interface as feedback.memory.adapter.js (save/saveQuick/getExamples/
// getMechanicStats/getBlindspots/markRetrained) so MechanicFeedbackLoop
// doesn't care which one it's handed - this one just survives a restart.
//
// Falls back to throwing a clear error if Supabase isn't configured, so
// the caller (see intelligence.routes.js) can decide whether to fall back
// to the in-memory adapter instead of failing the request.

const { supabase } = require('../../db');

class FeedbackSupabaseAdapter {
  constructor() {
    if (!supabase) {
      throw new Error('FeedbackSupabaseAdapter requires SUPABASE_URL/SUPABASE_KEY to be configured');
    }
  }

  // labels is a flexible jsonb bag, same as metadata - repurposed here to
  // carry the actual training-relevant payload (rawAiOutput,
  // mechanicAssessment, actualRepair, economicActual, confirmedRepairCase,
  // vehicle, teachingSignal). Previously only bookkeeping fields
  // (id/requestId/mechanicId/weight/metadata/signals) were persisted here
  // at all - getTrainingDataset()'s filters on rawAiOutput/mechanicAssessment
  // /actualRepair would always come back empty against real Supabase
  // storage even though everything looked fine against the memory adapter.
  async save(example) {
    example.metadata = example.metadata || {};
    if (!example.metadata.feedbackVersion) example.metadata.feedbackVersion = 1;
    if (!example.id) example.id = `fb_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
    example.storedAt = new Date().toISOString();

    const labels = {
      ...(example.labels || {}),
      rawAiOutput: example.rawAiOutput ?? null,
      mechanicAssessment: example.mechanicAssessment ?? null,
      actualRepair: example.actualRepair ?? null,
      economicActual: example.economicActual ?? null,
      confirmedRepairCase: example.confirmedRepairCase ?? null,
      vehicle: example.vehicle ?? null,
      teachingSignal: example.teachingSignal ?? null
    };

    const { error } = await supabase
      .from('feedback_examples')
      .upsert({
        id: example.id,
        request_id: example.requestId || null,
        mechanic_id: example.mechanicId || null,
        weight: example.weight || 0,
        labels,
        metadata: example.metadata || {},
        signals: example.signals || [],
        stored_at: example.storedAt
      }, { onConflict: 'id' });

    if (error) {
      console.warn('[FeedbackSupabaseAdapter] save failed (non-fatal):', error.message);
    }
    return example;
  }

  async saveQuick(quick) {
    const q = {
      id: quick.id || `q_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      requestId: quick.requestId,
      provider: quick.provider || null,
      model: quick.model || null,
      verdict: quick.verdict,
      metadata: quick.metadata || {}
    };

    const { error } = await supabase
      .from('quick_feedback')
      .upsert({
        id: q.id,
        request_id: q.requestId || null,
        provider: q.provider,
        model: q.model,
        verdict: q.verdict,
        metadata: q.metadata
      }, { onConflict: 'id' });

    if (error) {
      console.warn('[FeedbackSupabaseAdapter] saveQuick failed (non-fatal):', error.message);
    }
    return q;
  }

  async getExamples(limit = 100) {
    const { data, error } = await supabase
      .from('feedback_examples')
      .select('*')
      .order('weight', { ascending: false })
      .order('stored_at', { ascending: false })
      .limit(limit);

    if (error) {
      console.warn('[FeedbackSupabaseAdapter] getExamples failed:', error.message);
      return [];
    }

    return (data || []).map(row => ({
      id: row.id,
      requestId: row.request_id,
      mechanicId: row.mechanic_id,
      weight: row.weight,
      labels: row.labels,
      metadata: row.metadata,
      signals: row.signals,
      storedAt: row.stored_at,
      rawAiOutput: row.labels?.rawAiOutput ?? null,
      mechanicAssessment: row.labels?.mechanicAssessment ?? null,
      actualRepair: row.labels?.actualRepair ?? null,
      economicActual: row.labels?.economicActual ?? null,
      confirmedRepairCase: row.labels?.confirmedRepairCase ?? null,
      vehicle: row.labels?.vehicle ?? null,
      teachingSignal: row.labels?.teachingSignal ?? null
    }));
  }

  async getMechanicStats(mechanicId) {
    const { data, error } = await supabase
      .from('feedback_examples')
      .select('*')
      .eq('mechanic_id', mechanicId);

    if (error) {
      console.warn('[FeedbackSupabaseAdapter] getMechanicStats failed:', error.message);
      return { mechanicId, totalExamples: 0, correct: 0, wrong: 0, partial: 0, quick: { up: 0, down: 0 }, accuracy: null };
    }

    const byMechanic = data || [];
    const totalExamples = byMechanic.length;
    const correct = byMechanic.filter(e => e.labels?.diagnosis === 'correct').length;
    const wrong = byMechanic.filter(e => e.labels?.diagnosis === 'wrong').length;
    const partial = byMechanic.filter(e => e.labels?.diagnosis === 'partial').length;

    const { data: quickData } = await supabase
      .from('quick_feedback')
      .select('*')
      .contains('metadata', { mechanicId });

    const quickByMechanic = quickData || [];
    const quickUp = quickByMechanic.filter(q => q.verdict === 'up').length;
    const quickDown = quickByMechanic.filter(q => q.verdict === 'down').length;

    return {
      mechanicId,
      totalExamples,
      correct,
      wrong,
      partial,
      quick: { up: quickUp, down: quickDown },
      accuracy: totalExamples > 0 ? correct / totalExamples : null
    };
  }

  async getBlindspots() {
    const { data, error } = await supabase
      .from('feedback_examples')
      .select('*');

    if (error) {
      console.warn('[FeedbackSupabaseAdapter] getBlindspots failed:', error.message);
      return [];
    }

    const blindspotMap = {};
    for (const ex of (data || [])) {
      const tags = ex.labels?.issues || [];
      for (const t of tags) {
        if (t === 'ai_missed' || t === 'ai_hallucinated') {
          const key = ex.metadata?.vehicle?.vin || ex.metadata?.component || 'unknown';
          blindspotMap[key] = blindspotMap[key] || { key, count: 0, examples: [] };
          blindspotMap[key].count += 1;
          blindspotMap[key].examples.push({ id: ex.id, weight: ex.weight || 0 });
        }
      }
    }
    return Object.values(blindspotMap).sort((a, b) => b.count - a.count);
  }

  async markRetrained(ids = []) {
    if (!ids.length) return [];
    const { error } = await supabase
      .from('feedback_examples')
      .update({ retrained: true })
      .in('id', ids);

    if (error) {
      console.warn('[FeedbackSupabaseAdapter] markRetrained failed:', error.message);
    }

    const { data } = await supabase
      .from('feedback_examples')
      .select('id')
      .eq('retrained', true);

    return (data || []).map(r => r.id);
  }
}

module.exports = FeedbackSupabaseAdapter;
