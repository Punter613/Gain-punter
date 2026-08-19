const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

let supabase = null;
if (supabaseUrl && supabaseKey) {
  supabase = createClient(supabaseUrl, supabaseKey);
}

const CURRENT_MANUAL_SCHEMA = 5;

function normalizeDriveType(vehicle = {}) {
  const raw = String(vehicle.drivetrain || vehicle.driveType || vehicle.drive || '').toLowerCase();
  if (/\b4wd\b|\b4x4\b|four[ -]?wheel drive/.test(raw)) return '4wd';
  if (/\bawd\b|all[ -]?wheel drive/.test(raw)) return 'awd';
  if (/\bfwd\b|front[ -]?wheel drive/.test(raw)) return 'fwd';
  if (/\brwd\b|rear[ -]?wheel drive/.test(raw)) return 'rwd';
  if (/\b2wd\b|two[ -]?wheel drive/.test(raw)) return '2wd';
  return 'drive-unknown';
}

function buildVehicleCacheKey({ year, make, model, engine, drivetrain, driveType, drive }) {
  const driveKey = normalizeDriveType({ drivetrain, driveType, drive });
  return [year, make, model, engine || 'base', driveKey]
    .map(v => String(v || '').toLowerCase().trim().replace(/\s+/g, '-'))
    .join('|');
}

function normalizeManualContext(context = {}) {
  const values = [
    context.query,
    context.symptoms,
    ...(Array.isArray(context.mechanicNotices) ? context.mechanicNotices : [context.mechanicNotices]),
    ...(Array.isArray(context.obdCodes) ? context.obdCodes : [context.obdCodes]),
    ...(Array.isArray(context.keywords) ? context.keywords : [context.keywords])
  ]
    .filter(Boolean)
    .map(value => String(value).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim())
    .filter(Boolean)
    .sort();
  return [...new Set(values)].join('|');
}

function buildManualCacheKey(vehicle, context = {}) {
  const vehicleKey = buildVehicleCacheKey(vehicle);
  const normalizedContext = normalizeManualContext(context);
  if (!normalizedContext) return vehicleKey;
  const contextHash = crypto.createHash('sha1').update(normalizedContext).digest('hex').slice(0, 16);
  return `${vehicleKey}|ctx-${contextHash}`;
}

function escapeLikePattern(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
}

function extractManualPathHint(manualData = {}) {
  const direct = String(manualData.resolved_url || manualData.resolvedUrl || '').trim();
  if (direct) return direct;

  for (const item of manualData.items || []) {
    const url = String(item?.url || '').trim();
    if (!url) continue;
    const marker = url.search(/\/Repair(?:%20| )and(?:%20| )Diagnosis\//i);
    if (marker >= 0) {
      return `${url.slice(0, marker)}/Repair%20and%20Diagnosis/`;
    }
  }
  return '';
}

async function getCachedManual(vehicle, context = {}) {
  if (!supabase) return null;
  const cacheKey = buildManualCacheKey(vehicle, context);

  try {
    const { data, error } = await supabase
      .from('scraped_manuals')
      .select('*')
      .eq('vehicle_key', cacheKey)
      .maybeSingle();

    if (error) {
      console.warn('[DB] getCachedManual lookup failed, treating as cache miss:', error.message);
      return null;
    }

    // Force one refresh of rows created by older scraper/cache schemas.
    if (data?.data?.schemaVersion !== CURRENT_MANUAL_SCHEMA) {
      console.log(`[DB] Legacy Lemon cache detected for ${cacheKey}; refreshing with schema v${CURRENT_MANUAL_SCHEMA}`);
      return null;
    }

    return data || null;
  } catch (err) {
    console.warn('[DB] getCachedManual threw, treating as cache miss:', err.message);
    return null;
  }
}

async function getCachedManualVehicleEvidence(vehicle, options = {}) {
  if (!supabase) return [];
  const vehicleKey = buildVehicleCacheKey(vehicle);
  const limit = Math.max(1, Math.min(25, Number(options.limit || 8)));
  const contextPattern = `${escapeLikePattern(vehicleKey)}|ctx-%`;

  try {
    const { data, error } = await supabase
      .from('scraped_manuals')
      .select('vehicle_key,data,scraped_at')
      .like('vehicle_key', contextPattern)
      .order('scraped_at', { ascending: false })
      .limit(limit);

    if (error) {
      console.warn('[DB] getCachedManualVehicleEvidence lookup failed, treating as empty:', error.message);
      return [];
    }

    return (Array.isArray(data) ? data : [])
      .filter(row => row?.data?.schemaVersion === CURRENT_MANUAL_SCHEMA);
  } catch (err) {
    console.warn('[DB] getCachedManualVehicleEvidence threw, treating as empty:', err.message);
    return [];
  }
}

async function getCachedManualPathHint(vehicle, context = {}) {
  if (!supabase) return '';
  const cacheKey = buildManualCacheKey(vehicle, context);

  try {
    const { data, error } = await supabase
      .from('scraped_manuals')
      .select('data')
      .eq('vehicle_key', cacheKey)
      .maybeSingle();
    if (!error) {
      const exactHint = extractManualPathHint(data?.data || {});
      if (exactHint) return exactHint;
    }

    const vehicleRows = await getCachedManualVehicleEvidence(vehicle, { limit: 4 });
    for (const row of vehicleRows) {
      const hint = extractManualPathHint(row?.data || {});
      if (hint) return hint;
    }
    return '';
  } catch (_) {
    return '';
  }
}

async function saveScrapedManual(vehicle, manualData, context = {}) {
  if (!supabase) return null;
  const cacheKey = buildManualCacheKey(vehicle, context);

  try {
    const { error } = await supabase
      .from('scraped_manuals')
      .upsert({
        vehicle_key: cacheKey,
        year: vehicle.year || null,
        make: vehicle.make || null,
        model: vehicle.model || null,
        engine: vehicle.engine || null,
        data: manualData,
        scraped_at: new Date().toISOString()
      }, { onConflict: 'vehicle_key' });

    if (error) {
      console.warn('[DB] saveScrapedManual failed (non-fatal, continuing):', error.message);
    }
  } catch (err) {
    console.warn('[DB] saveScrapedManual threw (non-fatal, continuing):', err.message);
  }
}

module.exports = {
  supabase,
  getCachedManual,
  getCachedManualVehicleEvidence,
  getCachedManualPathHint,
  saveScrapedManual,
  buildVehicleCacheKey,
  buildManualCacheKey,
  normalizeManualContext,
  extractManualPathHint,
  escapeLikePattern,
  CURRENT_MANUAL_SCHEMA,
  normalizeDriveType
};