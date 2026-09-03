'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  SOURCE_RESILIENCE_POLICY,
  SOURCE_STATUS,
  isOptionalExternalSourceEnabled,
  sourceHealthEntry,
  summarizeSourceHealth,
  sourceStatusMessage,
  publicSourceHealth
} = require('../src/core/evidence/source.resilience');
const { buildDiagnosticEvidencePacket } = require('../src/core/evidence/diagnostic.evidence.packet');
const { BoundedQuickAskRetriever } = require('../src/core/knowledge/quick.ask.bounded');

test('optional manual outage degrades source health but diagnostic operation continues', () => {
  const summary = summarizeSourceHealth([
    sourceHealthEntry('LEMON_MANUALS', SOURCE_STATUS.UNAVAILABLE, { reason: 'HTTP 451' }),
    sourceHealthEntry('NHTSA_BULK', SOURCE_STATUS.AVAILABLE, { evidenceCount: 3 })
  ]);

  assert.equal(summary.policy, SOURCE_RESILIENCE_POLICY);
  assert.equal(summary.diagnosticOperation, 'CONTINUE');
  assert.equal(summary.mode, 'DEGRADED');
  assert.equal(summary.durableAvailable, true);
  assert.equal(summary.optionalUnavailableCount, 1);
  assert.match(sourceStatusMessage(summary), /continuing with other available evidence sources/i);
});

test('LEMON_EVIDENCE_ENABLED is an immediate optional-source kill switch', () => {
  const prior = process.env.LEMON_EVIDENCE_ENABLED;
  try {
    process.env.LEMON_EVIDENCE_ENABLED = 'false';
    assert.equal(isOptionalExternalSourceEnabled('LEMON_MANUALS'), false);
    assert.equal(isOptionalExternalSourceEnabled('LEMON_TSB_CORPUS'), false);
    assert.equal(isOptionalExternalSourceEnabled('NHTSA_BULK'), true);
  } finally {
    if (prior === undefined) delete process.env.LEMON_EVIDENCE_ENABLED;
    else process.env.LEMON_EVIDENCE_ENABLED = prior;
  }
});

test('model-facing packet gets source status without raw provider error details', () => {
  const summary = summarizeSourceHealth([
    sourceHealthEntry('LEMON_MANUALS', SOURCE_STATUS.UNAVAILABLE, { reason: 'private upstream failure detail' }),
    sourceHealthEntry('NHTSA_BULK', SOURCE_STATUS.AVAILABLE, { evidenceCount: 1 })
  ]);

  const packet = buildDiagnosticEvidencePacket({
    vehicle: { year: 2008, make: 'Kia', model: 'Sorento' },
    customerObservations: ['clunk on throttle release'],
    sourceHealth: summary,
    evidenceAvailable: true,
    sources: ['NHTSA_BULK']
  });

  assert.equal(packet.evidence.sourceHealth.policy, SOURCE_RESILIENCE_POLICY);
  assert.equal(packet.evidence.sourceHealth.diagnosticOperation, 'CONTINUE');
  assert.equal(packet.evidence.sourceHealth.optionalUnavailableCount, 1);
  assert.equal(JSON.stringify(packet).includes('private upstream failure detail'), false);
  assert.equal(Object.hasOwn(publicSourceHealth(summary).entries[0], 'reason'), false);
});

test('Quick Ask remains successful when the optional manual provider throws', async () => {
  const retriever = new BoundedQuickAskRetriever(null, null, {
    confirmedRepairsMs: 100,
    tsbsMs: 100,
    manualMs: 100
  });

  retriever._confirmedRepairs = async () => ({
    sampleSize: 1,
    ranked: [{ repair: 'Verified prior repair example' }],
    telemetry: { source: 'feedback_examples', rowsScanned: 1, scanLimitReached: false, resultsMayBePartial: false }
  });
  retriever._tsbs = async () => ({
    ranked: [{ bulletin_number: 'TEST-001', subject: 'Stored published evidence' }],
    telemetry: { source: 'vehicle_tsb_corpus', rowsScanned: 1, scanLimitReached: false, resultsMayBePartial: false }
  });
  retriever._manualEvidence = async () => {
    throw new Error('manual provider unavailable');
  };

  const out = await retriever.ask({
    vehicle: { year: 2008, make: 'Kia', model: 'Sorento' },
    query: 'driveline clunk on throttle release',
    limit: 5
  });

  assert.equal(out.status, 'SUCCESS');
  assert.equal(out.publishedEvidence.length, 1);
  assert.equal(out.commonConfirmedRepairs.length, 1);
  assert.equal(out.repairDiagnosisEvidence.length, 0);
  assert.equal(out.sourceHealth.policy, SOURCE_RESILIENCE_POLICY);
  const manual = out.sourceHealth.entries.find(entry => entry.source === 'LEMON_MANUALS');
  assert.equal(manual.status, SOURCE_STATUS.UNAVAILABLE);
  assert.match(out.warnings.join(' '), /continuing with other evidence sources/i);
});
