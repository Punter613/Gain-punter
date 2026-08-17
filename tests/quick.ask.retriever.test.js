const test = require('node:test');
const assert = require('node:assert/strict');
const { QuickAskRetriever } = require('../src/core/knowledge/quick.ask.retriever');

function fakeClient(tables) {
  return {
    from(name) {
      let rows = [...(tables[name] || [])];
      const q = {
        select() { return q; },
        eq(field, value) { rows = rows.filter(r => String(r[field]) === String(value)); return q; },
        ilike(field, value) { rows = rows.filter(r => String(r[field] || '').toLowerCase() === String(value).toLowerCase()); return q; },
        order() { return q; },
        limit(n) { return Promise.resolve({ data: rows.slice(0, n), error: null }); }
      };
      return q;
    }
  };
}

function trusted({ id, job, cause, result = 'correct', correctionCount = 0, createdAt = '2026-08-17T00:00:00Z' }) {
  return {
    id,
    request_id: job,
    stored_at: createdAt,
    metadata: { trustedForTraining: true, createdAt },
    labels: {
      vehicle: { year: 2008, make: 'Kia', model: 'Sorento' },
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
      { year: 2008, make: 'Kia', model: 'Sorento', title: 'A/C compressor noise', bulletin_number: 'AC-1', bulletin_date: '2009-01-01', group_name: 'HVAC', subject: 'compressor', body_text: 'whine with air conditioning', source: 'NHTSA_BULK', source_url: 'nhtsa://1' }
    ],
    feedback_examples: [
      trusted({ id: 'a', job: 'J1', cause: 'A/C compressor clutch bearing' }),
      trusted({ id: 'b', job: 'J2', cause: 'A/C compressor clutch bearing' }),
      trusted({ id: 'c', job: 'J3', cause: 'Idler pulley bearing' })
    ]
  });
  const out = await new QuickAskRetriever(client).ask({
    vehicle: { year: 2008, make: 'Kia', model: 'Sorento' },
    query: 'whining when ac is on'
  });
  assert.equal(out.mode, 'RETRIEVAL_ONLY');
  assert.equal(out.queryMode, 'QUERY');
  assert.equal(out.confirmedRepairSampleSize, 3);
  assert.equal(out.commonConfirmedRepairs[0].confirmedCases, 2);
  assert.equal(out.commonConfirmedRepairs[0].observedRepairShare, 0.667);
  assert.equal(out.commonConfirmedRepairs[0].evidenceStrength, 'LOW');
  assert.equal(out.publishedEvidence[0].bulletin_number, 'AC-1');
  assert.match(out.warnings.join(' '), /not diagnostic probability/i);
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
  const out = await new QuickAskRetriever(client).ask({
    vehicle: { year: 2008, make: 'Kia', model: 'Sorento' },
    query: ''
  });
  assert.equal(out.queryMode, 'VEHICLE_ONLY');
  assert.equal(out.confirmedRepairSampleSize, 1);
  assert.equal(out.commonConfirmedRepairs.length, 1);
  assert.equal(out.commonConfirmedRepairs[0].cause, 'Brake caliper sticking');
  assert.equal(out.commonConfirmedRepairs[0].observedRepairShare, 1);
  assert.deepEqual(out.publishedEvidence, []);
  assert.match(out.warnings.join(' '), /published evidence is not ranked without a query/i);
});

test('Quick Ask collapses duplicate drivetrain bulletin copies and cleans LEMON text', async () => {
  const dirtyBody = 'Engine Management DTCs - P2135 and P2138 - &#09; Description KMA has found this condition. Engine Controls — 2008 Kia Sorento 4WD V6-3.8L Service Manual ~ LEMON Manuals LEMON Manuals : Even more car manuals for everyone: 1960-2025 Home >> Kia >> 2008';
  const client = fakeClient({
    vehicle_tsb_corpus: [
      { year: 2008, make: 'Kia', model: 'Sorento', title: 'Engine Controls - P2135/P2138', bulletin_number: 'KT2008090302', bulletin_date: 'Wednesday, September 03, 2008 Area N.America Subject Engine Management', group_name: 'Engine Controls', subject: 'Engine Management DTCs - P2135 and P2138', body_text: dirtyBody, source: 'LEMON_MANUALS', source_url: 'https://example.test/2wd' },
      { year: 2008, make: 'Kia', model: 'Sorento', title: 'Engine Controls - P2135/P2138', bulletin_number: 'KT2008090302', bulletin_date: 'Wednesday, September 03, 2008 Area N.America Subject Engine Management', group_name: 'Engine Controls', subject: 'Engine Management DTCs - P2135 and P2138', body_text: `${dirtyBody} duplicate 4wd copy`, source: 'LEMON_MANUALS', source_url: 'https://example.test/4wd' },
      { year: 2008, make: 'Kia', model: 'Sorento', title: 'Electronic throttle control', bulletin_number: 'KT2008110401', bulletin_date: 'Tuesday, November 04, 2008 Area N.America', group_name: 'Engine Controls', subject: 'Electronic throttle control guidance', body_text: 'Throttle initialization occurs every time the ignition is turned on.', source: 'LEMON_MANUALS', source_url: 'https://example.test/etc' }
    ],
    feedback_examples: []
  });

  const out = await new QuickAskRetriever(client).ask({
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
  await assert.rejects(() => new QuickAskRetriever(client).ask({ vehicle: { make: 'Kia' } }), /requires vehicle\.make and vehicle\.model/);
});
