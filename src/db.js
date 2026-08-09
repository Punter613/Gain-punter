const { createClient } = require('@supabase/supabase-js');

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

let supabase = null;
if (supabaseUrl && supabaseKey) {
  supabase = createClient(supabaseUrl, supabaseKey);
}

const CURRENT_MANUAL_SCHEMA = 2;

function buildVehicleCacheKey({ year, make, model, engine }) {
  return [year, make, model, engine || 'base']
    .map(v => String(v || '').toLowerCase().trim().replace(/\s+/g, '-'))
    .join('|');
}

async function getCachedManual(vehicle) {
  if (!supabase) return null;
  const cacheKey = buildVehicleCacheKey(vehicle);

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

    // Force one refresh of rows created by the old title/URL-only scraper.
    // New rows contain schemaVersion=2 and preserve actual manual text/facts.
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

async function saveScrapedManual(vehicle, manualData) {
  if (!supabase) return null;
  const cacheKey = buildVehicleCacheKey(vehicle);

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

module.exports = { supabase, getCachedManual, saveScrapedManual, buildVehicleCacheKey, CURRENT_MANUAL_SCHEMA };