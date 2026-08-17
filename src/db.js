const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

let supabase = null;
if (supabaseUrl && supabaseKey) {
  supabase = createClient(supabaseUrl, supabaseKey);
}

const CURRENT_MANUAL_SCHEMA = 3;

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
  saveScrapedManual,
  buildVehicleCacheKey,
  buildManualCacheKey,
  normalizeManualContext,
  CURRENT_MANUAL_SCHEMA,
  normalizeDriveType
};