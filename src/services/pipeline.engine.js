/**
 * PIPELINE ENGINE (PLANNER + DETERMINISTIC CONTEXT ADAPTER)
 * - NO AI CALLS INSIDE
 * - RETURNS THE CONTRACT CURRENTLY CONSUMED BY /api/diagnose
 *
 * This module used to return only { type, steps }, while diagnose.js destructured
 * richer fields from it. That mismatch failed open as undefined values and silently
 * disconnected vehicle-profile context. Keep this adapter deterministic and explicit
 * until the Diagnose route is migrated to the canonical diagnostic evidence packet.
 */

const { getVehicleRiskProfile } = require('../knowledge/vehicle.risk.table');

function runDiagnosticPipeline(input = {}) {
  const plan = buildPlan(input);
  const profile = getVehicleRiskProfile(input.vehicle || {}, input.vin || '') || null;

  return {
    ...plan,
    profile,
    vinBuildProfile: null,
    localSafetyTriggered: false,
    safetyNotes: '',
    matchedPatterns: [],
    assemblyData: null,
    dynamicRisk: 0,
    confidence: { percentage: 30, rating: 'LOW' },
    symptomTelemetry: {
      hasMismatchedSignals: false,
      categories: {},
      overlappingClassesCount: 0
    }
  };
}

/**
 * Pure deterministic planner.
 */
function buildPlan(input) {
  return {
    type: 'diagnostic_plan',
    steps: [
      {
        step: 'analyze_symptoms',
        input
      },
      {
        step: 'generate_diagnosis'
      }
    ]
  };
}

module.exports = {
  runDiagnosticPipeline,
  buildPlan
};
