-- 005_guard_catches.sql
-- The deterministic completed-work-guard (src/core/orchestrator/completed.work.guard.js)
-- catches the AI trying to re-recommend work the mechanic already did.
-- That catch itself isn't proof the AI was wrong to a training-data
-- standard - a human needs to confirm it before it becomes a real
-- teaching signal fed into mechanic_feedback_loop. This table is the
-- pending queue between "guard fired" and "verified real catch."

create table if not exists guard_catches (
  id uuid primary key default gen_random_uuid(),
  request_id text,
  route text not null, -- '/api/diagnose', '/api/full-estimate', etc.
  vehicle jsonb default '{}'::jsonb,
  completed_work jsonb default '[]'::jsonb,       -- normalized aliases the guard matched against, e.g. ["upper control arm"]
  removed_items jsonb default '[]'::jsonb,        -- the actual AI-written strings that got filtered/flagged
  primary_cause_flagged boolean default false,    -- true if the AI's main diagnosis itself was the bad recommendation
  model text,
  verified boolean,                                -- null = pending, true = confirmed real catch, false = false positive
  verified_by text,
  verified_note text,
  verified_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_guard_catches_pending on guard_catches (verified) where verified is null;
create index if not exists idx_guard_catches_route on guard_catches (route);

alter table guard_catches enable row level security;
drop policy if exists "service role full access" on guard_catches;
create policy "service role full access" on guard_catches
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
