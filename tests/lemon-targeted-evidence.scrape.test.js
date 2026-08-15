const test = require('node:test');
const assert = require('node:assert/strict');

let fetchCalls = 0;
const originalFetch = global.fetch;
global.fetch = async () => {
  fetchCalls += 1;
  throw new Error('network should not run during module import');
};

const scraper = require('../scripts/scrape-lemon-targeted-evidence');

global.fetch = originalFetch;

const {
  getInput,
  checkDrivetrainCompatibility,
  buildDescendantQueueEntry,
  normalizedRetrievalPath,
  normalizedRetrievalKey,
  VALID_DRIVETRAINS
} = scraper;

test('requiring scraper does not execute main or cause network calls', () => {
  assert.equal(fetchCalls, 0);
});

function withInputEnv(drivetrain, fn) {
  const keys = [
    'LEMON_YEAR',
    'LEMON_MAKE',
    'LEMON_MODEL',
    'LEMON_TRIM',
    'LEMON_ENGINE',
    'LEMON_DRIVETRAIN',
    'LEMON_SCOPE',
    'LEMON_SYMPTOMS',
    'LEMON_DTCS',
    'LEMON_MECHANIC_NOTICES'
  ];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));

  process.env.LEMON_YEAR = '2008';
  process.env.LEMON_MAKE = 'KIA';
  process.env.LEMON_MODEL = 'SORENTO';
  process.env.LEMON_DRIVETRAIN = drivetrain;

  try {
    return fn();
  } finally {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

test('accepts valid drivetrain inputs case-insensitively while preserving trimmed raw input', () => {
  for (const canonical of VALID_DRIVETRAINS) {
    const raw = `  ${canonical.toLowerCase()}  `;
    withInputEnv(raw, () => {
      const { vehicle } = getInput();
      assert.equal(vehicle.drivetrain, canonical.toLowerCase());
    });
  }
});

test('rejects invalid nonempty drivetrain input', () => {
  withInputEnv('quattro', () => {
    assert.throws(
      () => getInput(),
      /LEMON_DRIVETRAIN must be one of 2WD, 4WD, AWD, FWD, or RWD/
    );
  });
});

test('2WD request is compatible with resolved FWD and RWD paths', () => {
  assert.doesNotThrow(() =>
    checkDrivetrainCompatibility(
      '2WD',
      'https://lemon-manuals.la/Kia/2008/Sorento%20FWD%20V6-3.8L/Repair%20and%20Diagnosis/'
    )
  );
  assert.doesNotThrow(() =>
    checkDrivetrainCompatibility(
      '2wd',
      'https://lemon-manuals.la/Kia/2008/Sorento%20RWD%20V6-3.8L/Repair%20and%20Diagnosis/'
    )
  );
});

test('4WD request rejects an FWD resolved path', () => {
  assert.throws(
    () =>
      checkDrivetrainCompatibility(
        '4WD',
        'https://lemon-manuals.la/Kia/2008/Sorento%20FWD%20V6-3.8L/Repair%20and%20Diagnosis/'
      ),
    /LEMON drivetrain mismatch/
  );
});

test('exact-DTC flag is inherited by generic descendants', () => {
  const entry = buildDescendantQueueEntry(
    { depth: 2, exactDtc: true },
    {
      url: 'https://lemon-manuals.la/Kia/2008/Sorento/P0300/Testing%20and%20Inspection/',
      text: 'Testing and Inspection'
    },
    { score: 8 },
    0
  );

  assert.equal(entry.depth, 3);
  assert.equal(entry.priority, 8);
  assert.equal(entry.exactDtc, true);
});

test('same title and section under distinct DTC paths produce different retrieval keys', () => {
  const relevance = { sectionType: 'TEST' };
  const p0300 = normalizedRetrievalKey(
    {
      title: 'Testing and Inspection',
      url: 'https://lemon-manuals.la/Kia/2008/Sorento/P0300/Testing%20and%20Inspection/'
    },
    relevance
  );
  const p0171 = normalizedRetrievalKey(
    {
      title: 'Testing and Inspection',
      url: 'https://lemon-manuals.la/Kia/2008/Sorento/P0171/Testing%20and%20Inspection/'
    },
    relevance
  );

  assert.notEqual(p0300, p0171);
});

test('tracking parameters do not change normalized retrieval path or key', () => {
  const cleanUrl =
    'https://lemon-manuals.la/Kia/2008/Sorento/P0300/Testing%20and%20Inspection/?mode=full&step=2';
  const trackedUrl =
    'https://lemon-manuals.la/Kia/2008/Sorento/P0300/Testing%20and%20Inspection/?utm_source=test&sid=abc&step=2&mode=full&gclid=123';

  assert.equal(normalizedRetrievalPath(cleanUrl), normalizedRetrievalPath(trackedUrl));

  const relevance = { sectionType: 'TEST' };
  assert.equal(
    normalizedRetrievalKey({ title: 'Testing and Inspection', url: cleanUrl }, relevance),
    normalizedRetrievalKey({ title: 'Testing and Inspection', url: trackedUrl }, relevance)
  );
});
