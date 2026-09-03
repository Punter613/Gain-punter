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
  assert.equal(summary.affectedOptionalCount, 1);
  assert.match(sourceStatusMessage(summary), /continuing with other available evidence sources/i);
});

test('intentionally skipped official live API does not make stored-official operation degraded', () => {
  const summary = summarizeSourceHealth([
    sourceHealthEntry('NHTSA_BULK', SOURCE_STATUS.AVAILABLE, { evidenceCount: 2 }),
    sourceHealthEntry('NHTSA_ODI', SOURCE_STATUS.SKIPPED, { reason: 'disabled for Diagnose latency' })
  ]);

  assert.equal(summary.mode, 'NORMAL');
  assert.equal(summary.durableAvailable, true);
  assert.equal(summary.affectedOptionalCount, 0);
  assert.match(sourceStatusMessage(summary), /operating normally/i);
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
    ranked: [{ bulletin_number: 'TEST-001', subject: 'Stored published evidence', source: 'NHTSA_BULK' }],
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

test('Quick Ask kill switch omits LEMON manual and stored LEMON rows but keeps other stored evidence', async () => {
  const prior = process.env.LEMON_EVIDENCE_ENABLED;
  process.env.LEMON_EVIDENCE_ENABLED = 'false';
  try {
    const retriever = new BoundedQuickAskRetriever(null, null, {
      confirmedRepairsMs: 100,
      tsbsMs: 100,
      manualMs: 100
    });
    retriever._confirmedRepairs = async () => ({
      sampleSize: 0,
      ranked: [],
      telemetry: { source: 'feedback_examples', rowsScanned: 0, scanLimitReached: false, resultsMayBePartial: false }
    });
    retriever._tsbs = async () => ({
      ranked: [
        { bulletin_number: 'LM-1', subject: 'LEMON row', source: 'LEMON_MANUALS', source_url: 'https://lemon-manuals.la/test' },
        { bulletin_number: 'NH-1', subject: 'Official stored row', source: 'NHTSA_BULK', source_url: 'https://static.nhtsa.gov/test.pdf' }
      ],
      telemetry: { source: 'vehicle_tsb_corpus', rowsScanned: 2, scanLimitReached: false, resultsMayBePartial: false }
    });
    retriever._manualEvidence = async () => {
      throw new Error('manual lane should not execute while disabled');
    };

    const out = await retriever.ask({
      vehicle: { year: 2008, make: 'Kia', model: 'Sorento' },
      query: 'driveline clunk',
      limit: 5
    });

    assert.equal(out.status, 'SUCCESS');
    assert.deepEqual(out.publishedEvidence.map(row => row.bulletin_number), ['NH-1']);
    assert.equal(out.repairDiagnosisEvidence.length, 0);
    const manual = out.sourceHealth.entries.find(entry => entry.source === 'LEMON_MANUALS');
    assert.equal(manual.status, SOURCE_STATUS.SKIPPED);
    assert.equal(out.sourceHealth.mode, 'DEGRADED');
    assert.match(out.sourceStatusMessage, /LEMON_MANUALS/i);
  } finally {
    if (prior === undefined) delete process.env.LEMON_EVIDENCE_ENABLED;
    else process.env.LEMON_EVIDENCE_ENABLED = prior;
  }
});
