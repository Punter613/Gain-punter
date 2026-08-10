const { decodeVinNhtsa } = require('./vin');
const { scrapeLEMONManuals } = require('./lemon');
const { harvestVehicleTsbs } = require('./tsb.harvester');
const { buildVehicleCacheKey } = require('../db');

const warmups = new Map();
const decodedVinCache = new Map();

function clean(value) {
  return String(value || '').trim();
}

function mergeVehicleProfile(decoded = {}, supplied = {}, vin = '') {
  const driveType = decoded.driveType || supplied.driveType || supplied.drivetrain || supplied.drive || '';
  return {
    vin: clean(vin || supplied.vin),
    year: decoded.year || supplied.year || '',
    make: decoded.make || supplied.make || '',
    model: decoded.model || supplied.model || '',
    trim: supplied.trim || decoded.trim || '',
    engine: decoded.engine || supplied.engine || supplied.trim || '',
    engineCylinders: decoded.engineCylinders || supplied.engineCylinders || '',
    driveType,
    drivetrain: driveType || supplied.drivetrain || '',
    bodyClass: decoded.bodyClass || supplied.bodyClass || '',
    transmissionStyle: decoded.transmissionStyle || supplied.transmissionStyle || ''
  };
}

async function resolveVehicleProfile(vin = '', supplied = {}) {
  const normalizedVin = clean(vin || supplied.vin).toUpperCase();
  if (normalizedVin.length === 17) {
    let decoded = decodedVinCache.get(normalizedVin);
    if (!decoded) {
      decoded = await decodeVinNhtsa(normalizedVin);
      if (!decoded) throw new Error('VIN decoded without a usable vehicle profile');
      decodedVinCache.set(normalizedVin, decoded);
    }
    return mergeVehicleProfile(decoded, supplied, normalizedVin);
  }
  return mergeVehicleProfile({}, supplied, normalizedVin);
}

function warmupKey(vehicle) {
  return buildVehicleCacheKey(vehicle);
}

function warmVehicleEvidence(vehicle, options = {}) {
  if (!vehicle?.year || !vehicle?.make || !vehicle?.model) {
    return { status: 'SKIPPED', key: '', reason: 'vehicle identity incomplete', promise: Promise.resolve(null) };
  }

  const key = warmupKey(vehicle);
  const existing = warmups.get(key);
  if (existing) return { status: existing.status, key, promise: existing.promise };

  const entry = { status: 'PENDING', startedAt: Date.now(), finishedAt: null, promise: null };
  entry.promise = Promise.allSettled([
    scrapeLEMONManuals(vehicle, {}),
    harvestVehicleTsbs(vehicle, {}, { maxPages: options.maxPages })
  ]).then(results => {
    entry.finishedAt = Date.now();
    entry.results = results;

    const successful = results.filter(result => result.status === 'fulfilled' && !result.value?.error).length;
    const failed = results.length - successful;
    entry.status = successful === results.length ? 'READY' : successful > 0 ? 'PARTIAL' : 'FAILED';

    if (entry.status === 'READY') {
      console.log(`[Vehicle Warmup] READY ${key} in ${entry.finishedAt - entry.startedAt}ms`);
    } else {
      entry.error = `${failed} of ${results.length} evidence warmup source(s) failed`;
      console.warn(`[Vehicle Warmup] ${entry.status} ${key}: ${entry.error}`);
    }
    return results;
  }).catch(error => {
    entry.status = 'FAILED';
    entry.finishedAt = Date.now();
    entry.error = error.message;
    console.warn(`[Vehicle Warmup] FAILED ${key}: ${error.message}`);
    return null;
  });

  warmups.set(key, entry);
  console.log(`[Vehicle Warmup] STARTED ${key}`);
  return { status: 'STARTED', key, promise: entry.promise };
}

async function waitForVehicleWarmup(vehicle, timeoutMs = 2500) {
  if (!vehicle?.year || !vehicle?.make || !vehicle?.model) return { status: 'SKIPPED' };
  const key = warmupKey(vehicle);
  const entry = warmups.get(key);
  if (!entry) return { status: 'NOT_STARTED', key };
  if (entry.status !== 'PENDING') return { status: entry.status, key, elapsedMs: entry.finishedAt ? entry.finishedAt - entry.startedAt : 0 };

  let timer;
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => resolve('PENDING'), Math.max(0, Number(timeoutMs) || 0));
  });
  const settled = entry.promise.then(() => entry.status);
  const status = await Promise.race([settled, timeout]);
  clearTimeout(timer);
  return { status, key, elapsedMs: Date.now() - entry.startedAt };
}

function getVehicleWarmupStatus(vehicle) {
  if (!vehicle?.year || !vehicle?.make || !vehicle?.model) return { status: 'SKIPPED' };
  const key = warmupKey(vehicle);
  const entry = warmups.get(key);
  return entry ? { status: entry.status, key, startedAt: entry.startedAt, finishedAt: entry.finishedAt } : { status: 'NOT_STARTED', key };
}

module.exports = {
  mergeVehicleProfile,
  resolveVehicleProfile,
  warmVehicleEvidence,
  waitForVehicleWarmup,
  getVehicleWarmupStatus
};
