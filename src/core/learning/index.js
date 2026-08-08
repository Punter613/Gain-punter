// src/core/learning/index.js
// Single place that wires MechanicFeedbackLoop to a storage adapter.
// Prefers the Supabase adapter (persists across restarts). Falls back to
// the in-memory adapter only if Supabase env vars aren't configured, so
// local dev without Supabase still works - but production on Render
// should always have SUPABASE_URL/SUPABASE_KEY set for this to persist.

const MechanicFeedbackLoop = require('./mechanic.feedback.loop');

let adapter;
let usingSupabase = false;

try {
  const FeedbackSupabaseAdapter = require('./feedback.supabase.adapter');
  adapter = new FeedbackSupabaseAdapter();
  usingSupabase = true;
  console.log('[Learning] Feedback loop backed by Supabase (persistent)');
} catch (err) {
  const FeedbackMemoryAdapter = require('./feedback.memory.adapter');
  adapter = new FeedbackMemoryAdapter();
  console.warn('[Learning] Supabase not configured, feedback loop falling back to IN-MEMORY adapter:', err.message);
  console.warn('[Learning] WARNING: feedback data will NOT survive a server restart until SUPABASE_URL/SUPABASE_KEY are set.');
}

const feedbackLoop = new MechanicFeedbackLoop(adapter);

module.exports = { feedbackLoop, usingSupabase };
