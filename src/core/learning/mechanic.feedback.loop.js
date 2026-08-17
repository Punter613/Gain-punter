// src/core/learning/mechanic.feedback.loop.js
// Mechanic Feedback Loop foundation (passive, adapter-driven).
// Uses adapter implementing save/getExamples/getMechanicStats/getBlindspots/markRetrained.
// Exposes methods:
//  - recordRepairOutcome(feedbackData)
//  - recordQuickFeedback(quick)
//  - getTrainingDataset(limit)
//  - getAIBlindspots()
//  - markRetrained(requestIds)

const DEFAULT_WEIGHTS = {
  DIAGNOSIS_CORRECT: 1.0,
  DIAGNOSIS_WRONG: 5.0,
  DIAGNOSIS_PARTIAL: 3.0,
  FIX_WORKED: 0.5,
  FIX_FAILED: 4.0,
  AI_MISSED_CRITICAL: 5.0,
  AI_HALLUCINATED: 4.0,
  ESTIMATE_ACCURATE: 0.5,
  ESTIMATE_WRONG: 3.0
};

const { eligibleForTrustedLearning } = require('../evidence/confirmed.repair.case');

function nowISO() {
  return new Date().toISOString();
}

class MechanicFeedbackLoop {
  constructor(adapter) {
    if (!adapter) throw new Error('MechanicFeedbackLoop requires a storage adapter');
    this.adapter = adapter;
  }

  // Calculate teaching signal based on provided mechanicAssessment and economicActual
  _calculateTeachingSignal(mechanicAssessment = {}, economicActual = null) {
    let totalWeight = 0;
    const signals = [];

    const diag = mechanicAssessment.diagnosisCorrect;
    if (diag === 'wrong') {
      totalWeight += DEFAULT_WEIGHTS.DIAGNOSIS_WRONG;
      signals.push({ type: 'DIAGNOSIS_WRONG', weight: DEFAULT_WEIGHTS.DIAGNOSIS_WRONG });
    } else if (diag === 'partial') {
      totalWeight += DEFAULT_WEIGHTS.DIAGNOSIS_PARTIAL;
      signals.push({ type: 'DIAGNOSIS_PARTIAL', weight: DEFAULT_WEIGHTS.DIAGNOSIS_PARTIAL });
    } else if (diag === 'correct') {
      totalWeight += DEFAULT_WEIGHTS.DIAGNOSIS_CORRECT;
      signals.push({ type: 'DIAGNOSIS_CORRECT', weight: DEFAULT_WEIGHTS.DIAGNOSIS_CORRECT });
    }

    if (mechanicAssessment.fixWorked === false) {
      totalWeight += DEFAULT_WEIGHTS.FIX_FAILED;
      signals.push({ type: 'FIX_FAILED', weight: DEFAULT_WEIGHTS.FIX_FAILED });
    } else if (mechanicAssessment.fixWorked === true) {
      totalWeight += DEFAULT_WEIGHTS.FIX_WORKED;
      signals.push({ type: 'FIX_WORKED', weight: DEFAULT_WEIGHTS.FIX_WORKED });
    }

    const aiMissed = mechanicAssessment.aiMissed || [];
    if (aiMissed.length > 0) {
      const w = aiMissed.length * DEFAULT_WEIGHTS.AI_MISSED_CRITICAL;
      totalWeight += w;
      signals.push({ type: 'AI_MISSED_CRITICAL', weight: w, count: aiMissed.length });
    }

    const aiWrong = mechanicAssessment.aiWrong || [];
    if (aiWrong.length > 0) {
      const w = aiWrong.length * DEFAULT_WEIGHTS.AI_HALLUCINATED;
      totalWeight += w;
      signals.push({ type: 'AI_HALLUCINATED', weight: w, count: aiWrong.length });
    }

    if (economicActual && economicActual.estimatedTotal != null && economicActual.totalCost != null) {
      const variance = Math.abs(economicActual.totalCost - (economicActual.estimatedTotal || 0));
      const pct = (economicActual.estimatedTotal || 1) ? variance / (economicActual.estimatedTotal || 1) : 0;
      if (pct > 0.3) {
        totalWeight += DEFAULT_WEIGHTS.ESTIMATE_WRONG;
        signals.push({ type: 'ESTIMATE_WRONG', weight: DEFAULT_WEIGHTS.ESTIMATE_WRONG, variancePct: pct });
      } else {
        totalWeight += DEFAULT_WEIGHTS.ESTIMATE_ACCURATE;
        signals.push({ type: 'ESTIMATE_ACCURATE', weight: DEFAULT_WEIGHTS.ESTIMATE_ACCURATE, variancePct: pct });
      }
    }

    const priority = totalWeight > 10 ? 'HIGH' : totalWeight > 5 ? 'MEDIUM' : 'LOW';

    return { totalWeight, signals, priority };
  }

  // Record a full repair outcome (primary learning input)
  async recordRepairOutcome(feedbackData) {
    // Expected feedbackData shape (enforced, but non-throwing)
    const {
      requestId,
      vehicle,
      aiRecommendation,
      mechanicAssessment,
      actualRepair,
      economicActual,
      mechanicId,
      shopId,
      metadata = {},
      source = 'mechanic_feedback_form'
    } = feedbackData;

    // Build learning example preserving rawAiOutput and mechanic assessment
    const teachingSignal = this._calculateTeachingSignal(mechanicAssessment || {}, economicActual || null);

    const example = {
      id: null, // adapter will set
      requestId: requestId || null,
      vehicle: vehicle || null,
      rawAiOutput: aiRecommendation || null,
      mechanicAssessment: mechanicAssessment || null,
      actualRepair: actualRepair || null,
      economicActual: economicActual || null,
      mechanicId: mechanicId || null,
      shopId: shopId || null,
      teachingSignal,
      metadata: {
        feedbackVersion: metadata.feedbackVersion || 1,
        createdAt: metadata.createdAt || nowISO(),
        source: metadata.source || source,
        processed: metadata.processed || false,
        usedInRetrain: metadata.usedInRetrain || false,
        // Free-form, self-reported feedback is useful signal for UX/prompt
        // quality but must never silently promote itself into the trusted
        // training corpus - only recordConfirmedOutcome() (fed by a real
        // CONFIRMED_REPAIR_CASE, bound to a job's fingerprint lineage) can
        // set this true. See getTrainingDataset().
        trustedForTraining: false
      }
    };

    return this.adapter.save(example);
  }

  // The only path into the trusted learning corpus. confirmedRepairCase
  // must already be a valid, integrity-checked CONFIRMED_REPAIR_CASE
  // (src/core/evidence/confirmed.repair.case.js) - this method re-verifies
  // that itself via eligibleForTrustedLearning rather than trusting the
  // caller, since nothing else is allowed around this gate.
  async recordConfirmedOutcome({ confirmedRepairCase, aiRecommendation = null, vehicle = null, mechanicId = null, shopId = null, metadata = {} } = {}) {
    if (!eligibleForTrustedLearning(confirmedRepairCase)) {
      throw new Error('recordConfirmedOutcome requires a valid, non-superseded CONFIRMED_REPAIR_CASE');
    }

    const result = confirmedRepairCase.outcome.result;
    const mechanicAssessment = {
      diagnosisCorrect: result === 'CORRECT' ? 'correct' : result === 'PARTIAL' ? 'partial' : 'wrong',
      fixWorked: result === 'CORRECT' ? true : result === 'WRONG' ? false : null
    };
    const teachingSignal = this._calculateTeachingSignal(mechanicAssessment, null);

    const example = {
      id: null,
      requestId: confirmedRepairCase.jobId,
      vehicle,
      rawAiOutput: aiRecommendation,
      mechanicAssessment,
      actualRepair: confirmedRepairCase.performedRepair,
      economicActual: null,
      mechanicId,
      shopId,
      teachingSignal,
      confirmedRepairCase: {
        fingerprint: confirmedRepairCase.fingerprint,
        verifiedCaseFingerprint: confirmedRepairCase.verifiedCaseFingerprint,
        sourceEventFingerprint: confirmedRepairCase.sourceEventFingerprint
      },
      metadata: {
        feedbackVersion: metadata.feedbackVersion || 1,
        createdAt: metadata.createdAt || nowISO(),
        source: 'confirmed_repair_case',
        processed: false,
        usedInRetrain: false,
        trustedForTraining: true
      }
    };

    return this.adapter.save(example);
  }

  async recordQuickFeedback(quick) {
    // quick: { requestId, provider, model, verdict, timestamp, metadata }
    if (typeof this.adapter.saveQuick !== 'function') {
      throw new Error('Adapter does not support saveQuick');
    }
    return this.adapter.saveQuick(quick);
  }

  async getTrainingDataset(limit = 1000) {
    // Returns only trusted examples. Presence of the four raw fields used
    // to be treated as sufficient - that's exactly the seam that let
    // self-reported feedback masquerade as ground truth. Now it requires
    // the example to actually be tagged trustedForTraining, which only
    // recordConfirmedOutcome() (a real CONFIRMED_REPAIR_CASE) can set.
    const all = await this.adapter.getExamples(limit * 2);
    const valid = all.filter(e =>
      e.rawAiOutput && e.mechanicAssessment && e.actualRepair && e.metadata?.trustedForTraining === true
    );
    valid.sort((a, b) => (b.teachingSignal?.totalWeight || 0) - (a.teachingSignal?.totalWeight || 0));
    return valid.slice(0, limit);
  }

  async getAIBlindspots() {
    return this.adapter.getBlindspots();
  }

  async markRetrained(ids = []) {
    return this.adapter.markRetrained(ids);
  }

  async getMechanicInsights(mechanicId) {
    return this.adapter.getMechanicStats(mechanicId);
  }
}

module.exports = MechanicFeedbackLoop;
