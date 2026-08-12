/**
 * SKSK ProTech - Metrics Engine Interface Spine
 * Freezes the stable API surface to shield downstream modules from drift.
 */
const {
  calculateConfidence,
  computeDynamicRiskScore,
  calibrateProbabilityArray
} = require('../metrics.engine');

module.exports = {
  calculateConfidence,
  computeDynamicRiskScore,
  calibrateProbabilityArray
};
