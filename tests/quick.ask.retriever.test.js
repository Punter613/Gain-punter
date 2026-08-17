const test = require('node:test');
const assert = require('node:assert/strict');
const { QuickAskRetriever, QUICK_ASK_SCAN_BOUNDS } = require('../src/core/knowledge/quick.ask.retriever');

function fieldValue(row, field) {
  return String(field).split(/->>?/).filter(Boolean).reduce((value, key) => value?.[key], row);
}

function fakeClient(tables) {
  return {
    from(name) {
      let rows = [...(tables[name] || [])];
      const q = {
        select() { return q; },
        eq(field, value) { rows = rows.filter(r => String(fieldValue(r, field)) === String(value)); return q; },
        ilike(field, value) { rows = rows.filter(r => String(fieldValue(r, field) || '').toLowerCase() === String(value).toLowerCase()); return q; },
        order(field, { ascending = true } = {}) {
          rows.sort((a, b) => {
            const av = fieldValue(a, field) ?? '';
            const bv = fieldValue(b, field) ?? '';
            const cmp = String(av).localeCompare(String(bv));
            return ascending ? cmp : -cmp;
          });
          return q;
        },
        range(from, to) { return Promise.resolve({ data: rows.slice(from, to + 1), error: null }); },
        limit(n) { return Promise.resolve({ data: rows.slice(0, n), error: null }); }
      };
      return q;
    }
  };
}

const noManual = async () => ({ source: 'LEMON_MANUALS', items: [] });

function trusted({ id, job, cause, result = 'correct', correctionCount = 0, createdAt = '2026-08-17T00:00:00Z', vehicle = { year: 2008, make: 'Kia', model: 'Sorento' } }) {
  return {
    id,
    request_id: job,
    stored_at: createdAt,
    metadata: { trustedForTraining: true, createdAt },
    labels: {
      vehicle,
      rawAiOutput: cause,
      mechanicAssessment: { diagnosisCorrect: result },
      actualRepair: { notes: cause },
      confirmedRepairCase: { fingerprint: `fp-${id}`, correctionCount }
    }
  };
}

test('Quick Ask keeps TSB evidence separate from confirmed-repair share', async () => {
  const client = fakeClient({
    vehicle_tsb_corpus: [
      { id: '1', year: 2008, make: 'Kia', model: 'Sorento', title: 'A/C compressor noise', bulletin_number: 'AC-1', bulletin_date: '2009-01-01', group_name: 'HVAC', subject: 'compressor', body_text: 'whine with air conditioning', source: 'NHTSA_BULK', source_url: 'nhtsa://1' }
    ],
    feedback_examples: [
      trusted({ id: 'a', job: 'J1', cause: 'A/C compressor clutch bearing' }),
      trusted({ id: 'b', job: 'J2', cause: 'A/C compressor clutch bearing' }),
      trusted({ id: 'c', job: 'J3', cause: 'Idler pulley bearing' })
    ]
  });
  const out = await new QuickAskRetriever(client, noManual).ask({
    vehicle: { year: 2008, make: 'Kia', model: 'Sorento' },
    query: 'whining when ac is on'
  });
  assert.equal(out.mode, 'RETRIEVAL_ONLY');
  assert.equal(out.queryMode, 'QUERY');
  assert.equal(out.confirmedRepairSampleSize, 2);
  assert.equal(out.commonConfirmedRepairs[0].confirmedCases, 2);
  assert.equal(out.commonConfirmedRepairs[0].observedRepairShare, 1);
  assert.equal(out.commonConfirmedRepairs[0].evidenceStrength, 'LOW');
  assert.equal(out.publishedEvidence[0].bulletin_number, 'AC-1');
  assert.equal(out.retrievalTelemetry.tsbs.pageSize, QUICK_ASK_SCAN_BOUNDS.tsbs.pageSize);
  assert.equal(out.retrievalTelemetry.confirmedRepairs.maxScan, QUICK_ASK_SCAN_BOUNDS.confirmedRepairs.maxScan);
  assert.match(out.warnings.join(' '), /not diagnostic probability/i);
});

test('Quick Ask filters unrelated vehicle evidence for an A/C clutch query', async () => {
  const client = fakeClient({
    vehicle_tsb_corpus: [
      { id: '1', year: 2008, make: 'Kia', model: 'Sorento', title: 'Load carrying capacity labels', bulletin_number: 'TSB-022', bulletin_date: '2009-05-01', group_name: 'Labels', subject: 'FMVSS load carrying capacity', body_text: 'Label requirements for accessories added before retail sale.', source: 'NHTSA_BULK', source_url: 'nhtsa://labels' },
      { id: '2', year: 2008, make: 'Kia', model: 'Sorento', title: 'Engine controls', bulletin_number: 'KT2008090302', bulletin_date: '2008-09-03', group_name: 'Engine', subject: 'P2135 and P2138', body_text: 'Throttle position sensor and accelerator pedal sensor guidance.', source: 'LEMON_MANUALS', source_url: 'lemon://etc' },
      { id: '3', year: 2008, make: 'Kia', model: 'Sorento', title: 'A/C compressor noise', bulletin_number: 'AC-1', bulletin_date: '2009-02-01', group_name: 'HVAC', subject: 'Air conditioning compressor noise', body_text: 'Inspect compressor operation when the A/C is engaged.', source: 'LEMON_MANUALS', source_url: 'lemon://ac' }
    ],
    feedback_examples: [
      trusted({ id: 'ac', job: 'J1', cause: 'A/C compressor clutch bearing' }),
      trusted({ id: 'brake', job: 'J2', cause: 'Brake caliper sticking' })
    ]
  });

  const out = await new QuickAskRetriever(client, noManual).ask({
    vehicle: { year: 2008, make: 'Kia', model: 'Sorento' },
    query: 'ac clutch'
  });

  assert.deepEqual(out.publishedEvidence.map(x => x.bulletin_number), ['AC-1']);
  assert.equal(out.confirmedRepairSampleSize, 1);
  assert.deepEqual(out.commonConfirmedRepairs.map(x => x.cause), ['A/C compressor clutch bearing']);
});

test('Quick Ask ranks relevant TSBs beyond the first 250 vehicle rows', async () => {
  const filler = Array.from({ length: 275 }, (_, i) => ({
    id: String(i).padStart(4, '0'),
    year: 2008,
    make: 'Kia', model: 'Sorento',
    title: `Unrelated bulletin ${i}`,
    bulletin_number: `FILL-${i}`,
    bulletin_date: '2008-01-01',
    group_name: 'Body',
    subject: 'trim information',
    body_text: 'Unrelated body trim information.',
    source: 'NHTSA_BULK',
    source_url: `nhtsa://fill/${i}`
  }));
  filler.push({
    id: '9999', year: 2008, make: 'Kia', model: 'Sorento',
    title: 'A/C compressor clutch whine', bulletin_number: 'AC-LATE', bulletin_date: '2009-01-01',
    group_name: 'HVAC', subject: 'Air conditioning compressor clutch noise',
    body_text: 'Whine when the A/C compressor clutch engages.', source: 'NHTSA_BULK', source_url: 'nhtsa://late'
  });

  const client = fakeClient({ vehicle_tsb_corpus: filler, feedback_examples: [] });
  const out = await new QuickAskRetriever(client, noManual).ask({
    vehicle: { year: 2008, make: 'Kia', model: 'Sorento' },
    query: 'ac clutch whine'
  });

  assert.deepEqual(out.publishedEvidence.map(x => x.bulletin_number), ['AC-LATE']);
  assert.equal(out.retrievalTelemetry.tsbs.scanLimitReached, false);
});

test('Quick Ask keeps older vehicle outcomes after 500 newer global feedback rows', async () => {
  const newerOtherVehicles = Array.from({ length: 500 }, (_, i) => trusted({
    id: `other-${String(i).padStart(3, '0')}`,
    job: `OTHER-${i}`,
    cause: 'Unrelated repair',
    createdAt: `2026-08-17T${String(23 - Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00Z`,
    vehicle: { year: 2020, make: 'Ford', model: 'F-150' }
  }));
  const olderTarget = trusted({
    id: 'target-old', job: 'KIA-1', cause: 'A/C compressor clutch bearing',
    createdAt: '2026-08-01T00:00:00Z'
  });
  const client = fakeClient({ vehicle_tsb_corpus: [], feedback_examples: [...newerOtherVehicles, olderTarget] });

  const out = await new QuickAskRetriever(client, noManual).ask({
    vehicle: { year: 2008, make: 'Kia', model: 'Sorento' },
    query: 'ac clutch'
  });

  assert.equal(out.confirmedRepairSampleSize, 1);
  assert.deepEqual(out.commonConfirmedRepairs.map(x => x.cause), ['A/C compressor clutch bearing']);
  assert.equal(out.retrievalTelemetry.confirmedRepairs.rowsScanned, 1);
  assert.equal(out.retrievalTelemetry.confirmedRepairs.vehicleFilterStage, 'database-json');
});

test('Quick Ask surfaces a partial-results warning at the TSB maximum scan bound', async () => {
  const maxScan = QUICK_ASK_SCAN_BOUNDS.tsbs.maxScan;
  const rows = Array.from({ length: maxScan }, (_, i) => ({
    id: String(i).padStart(6, '0'), year: 2008, make: 'Kia', model: 'Sorento',
    title: `Unrelated bulletin ${i}`, bulletin_number: `FILL-${i}`, bulletin_date: '2008-01-01',
    group_name: 'Body', subject: 'trim information', body_text: 'Unrelated body trim information.',
    source: 'NHTSA_BULK', source_url: `nhtsa://fill/${i}`
  }));
  rows.push({
    id: '999999', year: 2008, make: 'Kia', model: 'Sorento',
    title: 'A/C compressor clutch whine', bulletin_number: 'AC-OUTSIDE-BOUND', bulletin_date: '2009-01-01',
    group_name: 'HVAC', subject: 'Air conditioning compressor clutch noise',
    body_text: 'Whine when the A/C compressor clutch engages.', source: 'NHTSA_BULK', source_url: 'nhtsa://outside-bound'
  });

  const out = await new QuickAskRetriever(fakeClient({ vehicle_tsb_corpus: rows, feedback_examples: [] }), noManual).ask({
    vehicle: { year: 2008, make: 'Kia', model: 'Sorento' }, query: 'ac clutch whine'
  });

  assert.deepEqual(out.publishedEvidence, []);
  assert.equal(out.retrievalTelemetry.tsbs.rowsScanned, maxScan);
  assert.equal(out.retrievalTelemetry.tsbs.scanLimitReached, true);
  assert.equal(out.retrievalTelemetry.tsbs.resultsMayBePartial, true);
  assert.match(out.warnings.join(' '), /TSB retrieval reached.*results may be partial/i);
});

test('Quick Ask surfaces a partial-results warning at the confirmed-repair maximum scan bound', async () => {
  const maxScan = QUICK_ASK_SCAN_BOUNDS.confirmedRepairs.maxScan;
  const rows = Array.from({ length: maxScan }, (_, i) => trusted({
    id: `target-${String(i).padStart(6, '0')}`, job: `KIA-${i}`, cause: 'Brake caliper sticking'
  }));
  rows.push(trusted({
    id: 'target-999999', job: 'KIA-OUTSIDE', cause: 'A/C compressor clutch bearing'
  }));

  const out = await new QuickAskRetriever(fakeClient({ vehicle_tsb_corpus: [], feedback_examples: rows }), noManual).ask({
    vehicle: { year: 2008, make: 'Kia', model: 'Sorento' }, query: 'ac clutch'
  });

  assert.equal(out.confirmedRepairSampleSize, 0);
  assert.deepEqual(out.commonConfirmedRepairs, []);
  assert.equal(out.retrievalTelemetry.confirmedRepairs.rowsScanned, maxScan);
  assert.equal(out.retrievalTelemetry.confirmedRepairs.scanLimitReached, true);
  assert.equal(out.retrievalTelemetry.confirmedRepairs.resultsMayBePartial, true);
  assert.match(out.warnings.join(' '), /Confirmed-repair retrieval reached.*shares may be partial/i);
});

test('Quick Ask returns relevant Repair and Diagnosis references separately', async () => {
  const client = fakeClient({ vehicle_tsb_corpus: [], feedback_examples: [] });
  const manualProvider = async () => ({
    source: 'CHARM',
    fromCache: false,
    items: [
      {
        title: 'Compressor Clutch Relay — 2008 Kia Sorento Service Manual',
        url: 'https://charm.li/Kia/2008/Sorento%204WD%20V6-3.8L/Repair%20and%20Diagnosis/Relays%20and%20Modules/HVAC/Compressor%20Clutch%20Relay/',
        meta: { headings: 'Repair and Diagnosis | HVAC | Compressor Clutch Relay', snippet: 'Heating and air conditioning compressor clutch relay testing and inspection.', matchedKeywords: 'air conditioning, hvac, compressor clutch', facts: '{}' }
      },
      {
        title: 'Steering Rack Inspection',
        url: 'https://charm.li/example/steering',
        meta: { headings: 'Steering', snippet: 'Inspect steering rack bushings for play.', matchedKeywords: 'steering', facts: '{}' }
      },
      {
        title: 'Technical Service Bulletin - Engine Controls',
        url: 'https://charm.li/example/tsb',
        meta: { headings: 'Technical Service Bulletins', snippet: 'Service bulletin for throttle control.', matchedKeywords: 'tsb', facts: '{}' }
      }
    ]
  });

  const out = await new QuickAskRetriever(client, manualProvider).ask({
    vehicle: { year: 2008, make: 'Kia', model: 'Sorento', engine: 'V6-3.8L' },
    query: 'ac clutch'
  });

  assert.equal(out.repairDiagnosisEvidence.length, 1);
  assert.equal(out.repairDiagnosisEvidence[0].source, 'CHARM');
  assert.match(out.repairDiagnosisEvidence[0].title, /compressor clutch relay/i);
  assert.doesNotMatch(out.repairDiagnosisEvidence[0].title, /steering|bulletin/i);
  assert.equal(out.repairDiagnosisSource, 'CHARM');
});

test('Quick Ask dedupes corrected trusted outcomes and ignores wrong outcomes', async () => {
  const client = fakeClient({
    vehicle_tsb_corpus: [],
    feedback_examples: [
      trusted({ id: 'old', job: 'J1', cause: 'Wrong old cause', result: 'correct', correctionCount: 0, createdAt: '2026-08-17T00:00:00Z' }),
      trusted({ id: 'new', job: 'J1', cause: 'Brake caliper sticking', result: 'correct', correctionCount: 1, createdAt: '2026-08-17T01:00:00Z' }),
      trusted({ id: 'wrong', job: 'J2', cause: 'Wheel bearing', result: 'wrong' })
    ]
  });
  const out = await new QuickAskRetriever(client, noManual).ask({
    vehicle: { year: 2008, make: 'Kia', model: 'Sorento' },
    query: ''
  });
  assert.equal(out.queryMode, 'VEHICLE_ONLY');
  assert.equal(out.confirmedRepairSampleSize, 1);
  assert.equal(out.commonConfirmedRepairs.length, 1);
  assert.equal(out.commonConfirmedRepairs[0].cause, 'Brake caliper sticking');
  assert.equal(out.commonConfirmedRepairs[0].observedRepairShare, 1);
  assert.deepEqual(out.repairDiagnosisEvidence, []);
  assert.deepEqual(out.publishedEvidence, []);
  assert.match(out.warnings.join(' '), /manual evidence are not ranked without a query/i);
});

test('Quick Ask collapses duplicate drivetrain bulletin copies and cleans LEMON text', async () => {
  const dirtyBody = 'Engine Management DTCs - P2135 and P2138 - &#09; Description KMA has found this condition. Engine Controls — 2008 Kia Sorento 4WD V6-3.8L Service Manual ~ LEMON Manuals LEMON Manuals : Even more car manuals for everyone: 1960-2025 Home >> Kia >> 2008';
  const client = fakeClient({
    vehicle_tsb_corpus: [
      { id: '1', year: 2008, make: 'Kia', model: 'Sorento', title: 'Engine Controls - P2135/P2138', bulletin_number: 'KT2008090302', bulletin_date: 'Wednesday, September 03, 2008 Area N.America Subject Engine Management', group_name: 'Engine Controls', subject: 'Engine Management DTCs - P2135 and P2138', body_text: dirtyBody, source: 'LEMON_MANUALS', source_url: 'https://example.test/2wd' },
      { id: '2', year: 2008, make: 'Kia', model: 'Sorento', title: 'Engine Controls - P2135/P2138', bulletin_number: 'KT2008090302', bulletin_date: 'Wednesday, September 03, 2008 Area N.America Subject Engine Management', group_name: 'Engine Controls', subject: 'Engine Management DTCs - P2135 and P2138', body_text: `${dirtyBody} duplicate 4wd copy`, source: 'LEMON_MANUALS', source_url: 'https://example.test/4wd' },
      { id: '3', year: 2008, make: 'Kia', model: 'Sorento', title: 'Electronic throttle control', bulletin_number: 'KT2008110401', bulletin_date: 'Tuesday, November 04, 2008 Area N.America', group_name: 'Engine Controls', subject: 'Electronic throttle control guidance', body_text: 'Throttle initialization occurs every time the ignition is turned on.', source: 'LEMON_MANUALS', source_url: 'https://example.test/etc' }
    ],
    feedback_examples: []
  });

  const out = await new QuickAskRetriever(client, noManual).ask({
    vehicle: { year: 2008, make: 'Kia', model: 'Sorento' },
    query: 'P2135 throttle position sensor'
  });

  assert.equal(out.publishedEvidence.filter(x => x.bulletin_number === 'KT2008090302').length, 1);
  assert.equal(out.publishedEvidence[0].bulletin_date, 'September 03, 2008');
  assert.doesNotMatch(out.publishedEvidence[0].body_text, /&#09;|LEMON Manuals|Home >>/i);
  assert.match(out.publishedEvidence[0].body_text, /KMA has found this condition/i);
  assert.ok(out.publishedEvidence[0].body_text.length <= 320);
});

test('Quick Ask requires make and model', async () => {
  const client = fakeClient({ vehicle_tsb_corpus: [], feedback_examples: [] });
  await assert.rejects(() => new QuickAskRetriever(client, noManual).ask({ vehicle: { make: 'Kia' } }), /requires vehicle\.make and vehicle\.model/);
});
