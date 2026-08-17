const test = require('node:test');
const assert = require('node:assert/strict');

const { BoundedQuickAskRetriever, sourceBudgets } = require('../src/core/knowledge/quick.ask.bounded');

function never() {
  return new Promise(() => {});
}

test('bounded Quick Ask returns completed evidence when one source stalls', async () => {
  const retriever = new BoundedQuickAskRetriever(null, null, {
    confirmedRepairsMs: 20,
    tsbsMs: 50,
    manualMs: 50
  });

  retriever._confirmedRepairs = () => never();
  retriever._manualEvidence = async () => ({
    references: [{ title: 'P1326 Testing and Inspection', url: 'https://example.test/p1326' }],
    source: 'LEMON_MANUALS',
    fromCache: false,
    error: null
  });
  retriever._tsbs = async () => ({
    ranked: [{ bulletin_number: 'TEST-1' }],
    telemetry: {
      source: 'vehicle_tsb_corpus',
      pageSize: 250,
      maxScan: 5000,
      rowsScanned: 1,
      scanLimitReached: false,
      resultsMayBePartial: false,
      vehicleFilterStage: 'database'
    }
  });

  const startedAt = Date.now();
  const result = await retriever.ask({
    vehicle: { year: 2020, make: 'KIA', model: 'Optima', engine: '2.4L' },
    query: 'P1326 knock signal',
    limit: 5
  });
  const elapsed = Date.now() - startedAt;

  assert.equal(result.status, 'SUCCESS');
  assert.equal(result.repairDiagnosisEvidence.length, 1);
  assert.equal(result.publishedEvidence.length, 1);
  assert.equal(result.commonConfirmedRepairs.length, 0);
  assert.equal(result.retrievalTelemetry.confirmedRepairs.timedOut, true);
  assert.equal(result.retrievalTelemetry.manual.timedOut, false);
  assert.equal(result.retrievalTelemetry.tsbs.timedOut, false);
  assert.match(result.warnings.join(' '), /Confirmed-repair history exceeded/);
  assert.ok(elapsed < 200, `bounded retrieval should not wait for stalled source; elapsed=${elapsed}ms`);
});

test('bounded Quick Ask marks a stalled manual source partial instead of failing the route', async () => {
  const retriever = new BoundedQuickAskRetriever(null, null, {
    confirmedRepairsMs: 50,
    tsbsMs: 50,
    manualMs: 20
  });

  retriever._confirmedRepairs = async () => ({
    sampleSize: 1,
    ranked: [{ cause: 'Known repair', confirmedCases: 1, sampleSize: 1 }],
    telemetry: {
      source: 'feedback_examples', pageSize: 500, maxScan: 5000, rowsScanned: 1,
      scanLimitReached: false, resultsMayBePartial: false, vehicleFilterStage: 'database-json'
    }
  });
  retriever._manualEvidence = () => never();
  retriever._tsbs = async () => ({
    ranked: [],
    telemetry: {
      source: 'vehicle_tsb_corpus', pageSize: 250, maxScan: 5000, rowsScanned: 0,
      scanLimitReached: false, resultsMayBePartial: false, vehicleFilterStage: 'database'
    }
  });

  const result = await retriever.ask({
    vehicle: { year: 2020, make: 'KIA', model: 'Optima' },
    query: 'P1326',
    limit: 5
  });

  assert.equal(result.status, 'SUCCESS');
  assert.deepEqual(result.repairDiagnosisEvidence, []);
  assert.equal(result.retrievalTelemetry.manual.timedOut, true);
  assert.equal(result.retrievalTelemetry.manual.resultsMayBePartial, true);
  assert.match(result.warnings.join(' '), /Repair & Diagnosis lookup unavailable/);
});

test('source budget defaults keep ancillary database sources short and manual retrieval bounded', () => {
  const budgets = sourceBudgets({});
  assert.equal(budgets.confirmedRepairsMs, 5000);
  assert.equal(budgets.tsbsMs, 5000);
  assert.equal(budgets.manualMs, 32000);
});
