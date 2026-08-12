-- 008_tsb_corpus_ymm_index.sql
-- vehicle_tsb_corpus.vehicle_key is built by buildVehicleCacheKey(), which
-- requires engine/drivetrain to produce a specific key. NHTSA's bulk TSB
-- data only has Make/Model/Model Year — no trim/engine granularity — so
-- NHTSA-sourced rows cannot use exact vehicle_key matching the way
-- LEMON-sourced rows do. Future lookups against NHTSA-sourced rows need
-- to query year/make/model directly instead. Index that path.

create index if not exists idx_vehicle_tsb_ymm
  on vehicle_tsb_corpus (year, lower(make), lower(model));
