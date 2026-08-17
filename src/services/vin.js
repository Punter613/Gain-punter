const vinCache = new Map();
const vinInFlight = new Map();

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeVin(vin) {
  return String(vin || '').trim().toUpperCase();
}

async function fetchVinNhtsa(vin, timeoutMs) {
  const url = `https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValuesExtended/${encodeURIComponent(vin)}?format=json`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`VIN decode failed: ${res.status}`);
    const data = await res.json();

    const v = data?.Results?.[0];
    if (!v || !v.Make) return null;

    return {
      year: v.ModelYear || '',
      make: v.Make || '',
      model: v.Model || '',
      trim: v.Trim || '',
      engine: v.DisplacementL ? `${v.DisplacementL}L` : (v.EngineModel || ''),
      engineCylinders: v.EngineCylinders || '',
      driveType: v.DriveType || '',
      bodyClass: v.BodyClass || '',
      transmissionStyle: v.TransmissionStyle || ''
    };
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`VIN decode timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function decodeVinNhtsa(vin, options = {}) {
  const normalizedVin = normalizeVin(vin);
  const timeoutMs = positiveNumber(options.timeoutMs ?? process.env.VIN_DECODE_TIMEOUT_MS, 5000);
  const cacheTtlMs = positiveNumber(options.cacheTtlMs ?? process.env.VIN_DECODE_CACHE_TTL_MS, 60 * 60 * 1000);

  const cached = vinCache.get(normalizedVin);
  if (cached && cached.expiresAt > Date.now()) return cached.vehicle;
  if (cached) vinCache.delete(normalizedVin);

  const existing = vinInFlight.get(normalizedVin);
  if (existing) return existing;

  const task = fetchVinNhtsa(normalizedVin, timeoutMs)
    .then(vehicle => {
      if (vehicle) {
        vinCache.set(normalizedVin, {
          vehicle,
          expiresAt: Date.now() + cacheTtlMs
        });
      }
      return vehicle;
    })
    .finally(() => {
      if (vinInFlight.get(normalizedVin) === task) vinInFlight.delete(normalizedVin);
    });

  vinInFlight.set(normalizedVin, task);
  return task;
}

function clearVinDecodeCache() {
  vinCache.clear();
  vinInFlight.clear();
}

module.exports = {
  decodeVinNhtsa,
  clearVinDecodeCache,
  normalizeVin
};
