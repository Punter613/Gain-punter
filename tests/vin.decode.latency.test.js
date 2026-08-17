const test = require('node:test');
const assert = require('node:assert/strict');

const vinPath = require.resolve('../src/services/vin');

function loadVinService() {
  delete require.cache[vinPath];
  return require(vinPath);
}

function nhtsaResponse() {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      Results: [{
        ModelYear: '2020',
        Make: 'KIA',
        Model: 'Optima',
        Trim: 'LX',
        DisplacementL: '2.4',
        EngineCylinders: '4',
        DriveType: 'FWD/Front-Wheel Drive',
        BodyClass: 'Sedan/Saloon',
        TransmissionStyle: 'Automatic'
      }]
    })
  };
}

test('concurrent requests for the same VIN share one NHTSA fetch and subsequent calls hit memory cache', async () => {
  const originalFetch = global.fetch;
  let fetchCalls = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });

  global.fetch = async () => {
    fetchCalls += 1;
    await gate;
    return nhtsaResponse();
  };

  try {
    const { decodeVinNhtsa, clearVinDecodeCache } = loadVinService();
    clearVinDecodeCache();
    const vin = '5XXGT4L38LG384941';
    const first = decodeVinNhtsa(vin, { timeoutMs: 500, cacheTtlMs: 5000 });
    const second = decodeVinNhtsa(vin.toLowerCase(), { timeoutMs: 500, cacheTtlMs: 5000 });
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(fetchCalls, 1);
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.model, 'Optima');
    assert.deepEqual(a, b);

    const cached = await decodeVinNhtsa(vin, { timeoutMs: 500, cacheTtlMs: 5000 });
    assert.equal(cached.make, 'KIA');
    assert.equal(fetchCalls, 1, 'successful VIN decode should be reused on the same process');
  } finally {
    global.fetch = originalFetch;
    delete require.cache[vinPath];
  }
});

test('VIN decode aborts when NHTSA exceeds the configured request budget', async () => {
  const originalFetch = global.fetch;
  global.fetch = (_url, options = {}) => new Promise((_resolve, reject) => {
    options.signal?.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
  });

  try {
    const { decodeVinNhtsa, clearVinDecodeCache } = loadVinService();
    clearVinDecodeCache();
    const startedAt = Date.now();
    await assert.rejects(
      () => decodeVinNhtsa('5XXGT4L38LG384941', { timeoutMs: 20, cacheTtlMs: 5000 }),
      /VIN decode timed out after 20ms/
    );
    assert.ok(Date.now() - startedAt < 200, 'VIN timeout must bound the external dependency');
  } finally {
    global.fetch = originalFetch;
    delete require.cache[vinPath];
  }
});
