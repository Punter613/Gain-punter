-- 004_feedback_learning_loop.sql
-- Persists the mechanic feedback loop (src/core/learning/mechanic.feedback.loop.js)
-- so training examples and quick thumbs survive Render cold-starts/restarts.
-- Previously this data lived only in a JS Map/array in memory (feedback.memory.adapter.js)
-- and was wiped every deploy or restart.

create table if not exists feedback_examples (
  id text primary key,
  request_id text,
  mechanic_id text,
  weight numeric default 0,
  labels jsonb default '{}'::jsonb,
  metadata jsonb default '{}'::jsonb,
  signals jsonb default '[]'::jsonb,
  retrained boolean default false,
  stored_at timestamptz not null default now()
);

create index if not exists idx_feedback_examples_mechanic on feedback_examples (mechanic_id);
create index if not exists idx_feedback_examples_weight on feedback_examples (weight desc);
create index if not exists idx_feedback_examples_retrained on feedback_examples (retrained);

create table if not exists quick_feedback (
  id text primary key,
  request_id text,
  provider text,
  model text,
  verdict text check (verdict in ('up', 'down', 'neutral')),
  metadata jsonb default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_quick_feedback_verdict on quick_feedback (verdict);

alter table feedback_examples enable row level security;
alter table quick_feedback enable row level security;

-- Service role (backend) only - same lockdown pattern as 003_lock_down_tax_settings_and_scrapes_rls.sql
drop policy if exists "service role full access" on feedback_examples;
create policy "service role full access" on feedback_examples
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

drop policy if exists "service role full access" on quick_feedback;
create policy "service role full access" on quick_feedback
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
