-- Lemon Manuals evidence is stored as JSONB so the app can retain the source
-- pages, extracted facts, matched keywords, and future schema versions.
-- Run once in Supabase SQL Editor.

create index if not exists idx_scraped_manuals_data_gin
  on scraped_manuals using gin (data);

create index if not exists idx_scraped_manuals_vehicle
  on scraped_manuals (year, make, model, engine);
