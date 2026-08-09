const { supabase } = require('../db');

/**
 * Throws a lightweight query at Supabase to force the container to stay active.
 */
async function sendCaffeineShot() {
  if (!supabase) {
    console.log('[Keep-Awake] Supabase client not configured. Skipping poke.');
    return;
  }

  try {
    console.log('[Keep-Awake] Sending caffeine shot to Supabase...');
    const startTime = Date.now();

    // Querying the database version via RPC 
    const { data, error } = await supabase.rpc('version');

    if (error) throw error;

    const duration = Date.now() - startTime;
    console.log(`[Keep-Awake] Database responded in ${duration}ms. Supabase is awake!`);
  } catch (err) {
    console.error('[Keep-Awake] Failed to nudge Supabase:', err.message || err);
  }
}

/**
 * Starts an automated interval loop to kick the database every 45 minutes.
 */
function startKeepAwakeLoop() {
  const intervalMs = 45 * 60 * 1000; // 45 minutes
  setInterval(sendCaffeineShot, intervalMs);
  console.log(`[Keep-Awake] Loop armed. Interval set to fire every 45 minutes.`);
}

module.exports = { startKeepAwakeLoop, sendCaffeineShot };
