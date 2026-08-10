// src/core/learning/guard.catch.recorder.js
// Bridges the deterministic completed-work-guard to the mechanic feedback
// loop. A guard catch is a claim, not verified fact - this records it as
// pending, and only recordVerification(id, true, ...) turns it into a
// real AI_HALLUCINATED-weighted training example via
// mechanic.feedback.loop.js. A false-positive verification stays logged
// for guard-tuning visibility but never reaches the training data.

const { supabase } = require('../../db');

async function recordGuardCatch({ requestId, route, vehicle, completedWork, removedItems, primaryCauseFlagged, model }) {
  if (!supabase) {
    console.log('[GuardCatchRecorder] Supabase not configured - guard catch logged to console only, not queued for verification.');
    return null;
  }

  try {
    const { data, error } = await supabase
      .from('guard_catches')
      .insert({
        request_id: requestId || null,
        route,
        vehicle: vehicle || {},
        completed_work: completedWork || [],
        removed_items: removedItems || [],
        primary_cause_flagged: !!primaryCauseFlagged,
        model: model || null
      })
      .select()
      .single();

    if (error) {
      console.warn('[GuardCatchRecorder] insert failed (non-fatal):', error.message);
      return null;
    }
    return data;
  } catch (err) {
    console.warn('[GuardCatchRecorder] insert threw (non-fatal):', err.message);
    return null;
  }
}

async function listPendingGuardCatches(limit = 50) {
  if (!supabase) return [];
  const { data, error } = await supabase
    .from('guard_catches')
    .select('*')
    .is('verified', null)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.warn('[GuardCatchRecorder] list failed:', error.message);
    return [];
  }
  return data || [];
}

// correct=true: mechanic confirms the AI really was about to re-recommend
// completed work - this is a real hallucination catch, feed it into the
// learning loop as a weighted training example.
// correct=false: false positive (e.g. mechanic wants the prior repair
// re-inspected because it actually failed) - stays logged, never trains.
async function recordVerification(id, correct, { mechanicId, note, feedbackLoop } = {}) {
  if (!supabase) throw new Error('Supabase is not configured - cannot verify a guard catch without persistence.');

  const { data: caught, error: fetchErr } = await supabase
    .from('guard_catches')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (fetchErr) throw new Error(`Lookup failed: ${fetchErr.message}`);
  if (!caught) throw new Error('Guard catch not found');

  const { data: updated, error: updateErr } = await supabase
    .from('guard_catches')
    .update({
      verified: !!correct,
      verified_by: mechanicId || null,
      verified_note: note || null,
      verified_at: new Date().toISOString()
    })
    .eq('id', id)
    .select()
    .single();

  if (updateErr) throw new Error(`Update failed: ${updateErr.message}`);

  let trainingExample = null;
  if (correct && feedbackLoop) {
    trainingExample = await feedbackLoop.recordRepairOutcome({
      requestId: caught.request_id,
      vehicle: caught.vehicle,
      aiRecommendation: { removedItems: caught.removed_items, primaryCauseFlagged: caught.primary_cause_flagged },
      mechanicAssessment: { aiWrong: caught.removed_items },
      mechanicId,
      metadata: { source: 'completed_work_guard_verified' }
    });
  }

  return { guardCatch: updated, trainingExample };
}

module.exports = { recordGuardCatch, listPendingGuardCatches, recordVerification };
