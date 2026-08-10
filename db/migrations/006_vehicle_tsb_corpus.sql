-- 006_vehicle_tsb_corpus.sql
-- Persistent, vehicle-scoped TSB corpus harvested from LEMON Manuals.
-- Raw bulletin text is retained for retrieval/ranking; bulletin identity
-- stays source-attributed and should still be validated before being shown
-- as OEM-authoritative in a final diagnosis.

create table if not exists vehicle_tsb_corpus (
  id uuid primary key default gen_random_uuid(),
  vehicle_key text not null,
  year integer,
  make text,
  model text,
  trim text,
  engine text,
  title text not null,
  source_url text not null,
  bulletin_number text,
  bulletin_date text,
  group_name text,
  subject text,
  body_text text,
  headings jsonb default '[]'::jsonb,
  extracted_facts jsonb default '{}'::jsonb,
  source text not null default 'LEMON_MANUALS',
  scraped_at timestamptz not null default now(),
  unique(vehicle_key, source_url)
);

create index if not exists idx_vehicle_tsb_vehicle_key on vehicle_tsb_corpus(vehicle_key);
create index if not exists idx_vehicle_tsb_number on vehicle_tsb_corpus(bulletin_number);
create index if not exists idx_vehicle_tsb_title on vehicle_tsb_corpus using gin (to_tsvector('english', coalesce(title,'') || ' ' || coalesce(subject,'') || ' ' || coalesce(body_text,'')));

alter table vehicle_tsb_corpus enable row level security;
drop policy if exists "service role full access" on vehicle_tsb_corpus;
create policy "service role full access" on vehicle_tsb_corpus
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
