const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildDtcRetrievalIntent,
  matchDtcAnchors,
  checkEngineApplicability,
  applyQuickAskRetrievalGuards
} = require('../src/core/knowledge/dtc.retrieval.intent');

const optima24 = {
  year: 2020,
  make: 'KIA',
  model: 'Optima',
  engine: 'LX, S, SE 4cyl 2.4L'
};

test('P1326 on Kia builds a DTC-anchored search instead of a generic engine search', () => {
  const intent = buildDtcRetrievalIntent(
    optima24,
    'Hit a big puddle of water check engine light came on and flashing P1326'
  );

  assert.equal(intent.mode, 'DTC_ANCHORED');
  assert.deepEqual(intent.dtcs, ['P1326']);
  assert.deepEqual(intent.unresolvedDtcs, []);
  assert.match(intent.searchQuery, /P1326/i);
  assert.match(intent.searchQuery, /knock sensor/i);
  assert.doesNotMatch(intent.searchQuery, /\bengine\b/i);
});

test('multiple DTCs remain independently represented in retrieval intent', () => {
  const intent = buildDtcRetrievalIntent(
    { year: 2008, make: 'Kia', model: 'Sorento', engine: '3.8L V6' },
    'rough running P0300 and P0171 under load'
  );

  assert.equal(intent.mode, 'DTC_ANCHORED');
  assert.deepEqual(intent.anchors.map(anchor => anchor.code), ['P0300', 'P0171']);
  assert.match(intent.searchQuery, /misfire/i);
  assert.match(intent.searchQuery, /system too lean/i);
});

test('unknown DTC never receives an invented meaning and falls back to symptoms', () => {
  const intent = buildDtcRetrievalIntent(optima24, 'P9999 rough idle after rain');
  assert.equal(intent.mode, 'SYMPTOM_FALLBACK_UNRESOLVED_DTC');
  assert.deepEqual(intent.unresolvedDtcs, ['P9999']);
  assert.doesNotMatch(intent.searchQuery, /P9999/i);
  assert.match(intent.searchQuery, /rough idle after rain/i);
});

test('no DTC preserves symptom-driven retrieval', () => {
  const intent = buildDtcRetrievalIntent(optima24, 'whine when air conditioning is turned on');
  assert.equal(intent.mode, 'SYMPTOM_FALLBACK');
  assert.deepEqual(intent.dtcs, []);
  assert.equal(intent.searchQuery, 'whine when air conditioning is turned on');
});

test('DTC anchor matcher accepts exact code or resolved code meaning but rejects generic engine text', () => {
  const intent = buildDtcRetrievalIntent(optima24, 'P1326 flashing check engine light');

  assert.equal(matchDtcAnchors('P1326 Knock Signal Range/Performance', intent).matched, true);
  assert.equal(matchDtcAnchors('Knock Sensor Detection System diagnosis', intent).matched, true);
  assert.equal(matchDtcAnchors('Engine Control System Diagnosis', intent).matched, false);
});

test('known 2.4L vehicle rejects explicit 1.6L source but allows matching or generic source', () => {
  assert.equal(
    checkEngineApplicability(optima24, 'Engine Control System Diagnosis - 1.6L — 2020 Kia Optima EX').compatible,
    false
  );
  assert.equal(
    checkEngineApplicability(optima24, 'Engine Control System Diagnosis - 2.4L — 2020 Kia Optima').compatible,
    true
  );
  assert.equal(
    checkEngineApplicability(optima24, 'Engine Control System Diagnosis — 2020 Kia Optima').compatible,
    true
  );
  assert.equal(
    checkEngineApplicability(optima24, 'Engine Control System Diagnosis - 1.6L / 2.4L').compatible,
    true
  );
});

test('Optima 2.4L P1326 guard removes the exact wrong 1.6L manual failure and generic engine-only pages', () => {
  const intent = buildDtcRetrievalIntent(optima24, 'P1326 flashing check engine light after puddle');
  const result = {
    repairDiagnosisEvidence: [
      {
        title: 'Engine Control System Diagnosis - 1.6L (1 Of 6) (Except HEV) — 2020 Kia Optima EX',
        headings: 'Engine Control System Diagnosis - 1.6L',
        url: 'https://example.test/Optima/Repair%20and%20Diagnosis/Engine/1.6L/',
        matchedKeywords: 'engine'
      },
      {
        title: 'Engine Control System Diagnosis — 2020 Kia Optima',
        headings: 'Engine Control System Diagnosis',
        url: 'https://example.test/Optima/Repair%20and%20Diagnosis/Engine/',
        matchedKeywords: 'engine'
      },
      {
        title: 'Knock Sensor Detection System Diagnosis - 2.4L — 2020 Kia Optima',
        headings: 'P1326 | Knock Sensor Detection System',
        url: 'https://example.test/Optima/Repair%20and%20Diagnosis/Engine/2.4L/P1326/',
        matchedKeywords: 'P1326, knock sensor'
      }
    ],
    publishedEvidence: [],
    commonConfirmedRepairs: [],
    confirmedRepairSampleSize: 0,
    retrievalTelemetry: {}
  };

  applyQuickAskRetrievalGuards(result, optima24, intent);

  assert.deepEqual(
    result.repairDiagnosisEvidence.map(item => item.title),
    ['Knock Sensor Detection System Diagnosis - 2.4L — 2020 Kia Optima']
  );
  assert.deepEqual(result.repairDiagnosisEvidence[0].matchedDtcs, ['P1326']);
  assert.equal(result.retrievalTelemetry.applicabilityGuard.manualEngineMismatchRejected, 1);
  assert.equal(result.retrievalTelemetry.applicabilityGuard.manualDtcMismatchRejected, 1);
});

test('DTC-anchored published evidence and confirmed repairs must relate to the resolved DTC context', () => {
  const intent = buildDtcRetrievalIntent(optima24, 'P1326 flashing MIL');
  const result = {
    repairDiagnosisEvidence: [],
    publishedEvidence: [
      {
        bulletin_number: 'GOOD-1',
        title: 'P1326 knock sensor signal logic',
        subject: 'Knock Sensor Detection System',
        body_text: 'Diagnostic information for P1326 on 2.4L applications.'
      },
      {
        bulletin_number: 'JUNK-1',
        title: 'Engine software information',
        subject: 'Engine controls',
        body_text: 'General 2.4L engine information.'
      }
    ],
    commonConfirmedRepairs: [
      { cause: 'Knock sensor harness signal fault', confirmedCases: 2, sampleSize: 2 },
      { cause: 'Engine mount failure', confirmedCases: 3, sampleSize: 3 }
    ],
    confirmedRepairSampleSize: 5,
    retrievalTelemetry: {}
  };

  applyQuickAskRetrievalGuards(result, optima24, intent);

  assert.deepEqual(result.publishedEvidence.map(item => item.bulletin_number), ['GOOD-1']);
  assert.deepEqual(result.commonConfirmedRepairs.map(item => item.cause), ['Knock sensor harness signal fault']);
  assert.equal(result.confirmedRepairSampleSize, 2);
});
