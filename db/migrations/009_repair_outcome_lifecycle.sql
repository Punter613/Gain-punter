-- 009_repair_outcome_lifecycle.sql
-- Adds the second trust boundary behind VERIFIED_CASE -> REPAIR_RESOLVED ->
-- ESTIMATED -> INVOICED (the operational/authorization spine, unchanged).
--
-- REPAIR_COMPLETED / OUTCOME_CONFIRMED answer a different question than that
-- spine does: not "what did the mechanic authorize", but "did it actually
-- work". service_jobs.status and payload.status are mutable projections.
-- job_outcome_events is the append-only truth store for that second question;
-- corrections supersede by immutable event fingerprint, never by storage id.

alter table service_jobs drop constraint if exists service_jobs_status_check;
alter table service_jobs add constraint service_jobs_status_check check (
  status in (
    'DIAGNOSING', 'TESTING', 'VERIFIED', 'ESTIMATED', 'INVOICED', 'DIAG_FAILED',
    'REPAIR_COMPLETED', 'OUTCOME_CONFIRMED'
  )
);

-- Confirmed examples must round-trip with their lineage and source-event
-- fingerprint intact. Older feedback rows retain their existing structured
-- columns; the adapter falls back to those when payload is empty.
alter table feedback_examples
  add column if not exists payload jsonb not null default '{}'::jsonb;

create table if not exists job_outcome_events (
  id uuid primary key default gen_random_uuid(),
  job_id text not null references service_jobs (job_id),
  event_type text not null check (event_type in ('REPAIR_COMPLETED', 'OUTCOME_RECORDED')),

  -- Lineage anchors. verified_case_fingerprint is always required. A job can
  -- be completed without being priced; the other anchors are optional but
  -- application validation requires them to match the job when present.
  verified_case_fingerprint text not null,
  repair_resolution_fingerprint text,
  estimate_fingerprint text,
  invoiced_estimate_fingerprint text,

  performed_repair jsonb,
  completion_event_fingerprint text,
  outcome jsonb,

  -- Fingerprint, not UUID: the correction link is part of the canonical event
  -- contract and must survive storage round-trips without translation.
  supersedes_event_fingerprint text,

  recorded_by text,
  recorded_at timestamptz not null default now(),
  schema_version int not null default 1,
  fingerprint text not null,

  constraint job_outcome_events_fingerprint_key unique (fingerprint),
  constraint job_outcome_events_shape check (
    (
      event_type = 'REPAIR_COMPLETED'
      and performed_repair is not null
      and outcome is null
      and completion_event_fingerprint is null
      and supersedes_event_fingerprint is null
    )
    or
    (
      event_type = 'OUTCOME_RECORDED'
      and outcome is not null
      and performed_repair is null
      and completion_event_fingerprint is not null
    )
  )
);

-- Add self-referential foreign keys only after the table's fingerprint unique
-- constraint exists. This avoids depending on declaration order while keeping
-- both links storage-independent and database-enforced.
alter table job_outcome_events
  drop constraint if exists job_outcome_events_completion_event_fingerprint_fkey;
alter table job_outcome_events
  add constraint job_outcome_events_completion_event_fingerprint_fkey
  foreign key (completion_event_fingerprint)
  references job_outcome_events (fingerprint);

alter table job_outcome_events
  drop constraint if exists job_outcome_events_supersedes_event_fingerprint_fkey;
alter table job_outcome_events
  add constraint job_outcome_events_supersedes_event_fingerprint_fkey
  foreign key (supersedes_event_fingerprint)
  references job_outcome_events (fingerprint);

create index if not exists idx_job_outcome_events_job_id
  on job_outcome_events (job_id);
create index if not exists idx_job_outcome_events_type
  on job_outcome_events (job_id, event_type);
-- One event can be superseded only once. Together with the locked job row and
-- the active-target validation in the RPC, this prevents correction forks.
create unique index if not exists idx_job_outcome_events_superseded_once
  on job_outcome_events (supersedes_event_fingerprint)
  where supersedes_event_fingerprint is not null;

alter table job_outcome_events enable row level security;
drop policy if exists "service role full access" on job_outcome_events;
create policy "service role full access" on job_outcome_events
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

-- Supabase's service role bypasses RLS, so enforce append-only history with a
-- trigger that also applies to backend writes.
create or replace function job_outcome_events_append_only()
returns trigger as $$
begin
  raise exception 'job_outcome_events is append-only; % is not permitted', TG_OP;
end;
$$ language plpgsql;

drop trigger if exists job_outcome_events_no_update on job_outcome_events;
create trigger job_outcome_events_no_update
  before update on job_outcome_events
  for each row execute function job_outcome_events_append_only();

drop trigger if exists job_outcome_events_no_delete on job_outcome_events;
create trigger job_outcome_events_no_delete
  before delete on job_outcome_events
  for each row execute function job_outcome_events_append_only();

-- Atomic write path. The event insert, indexed service_jobs.status projection,
-- and payload.status projection move in one transaction while the job row is
-- locked. The application supplies an already-built, fingerprinted event; this
-- function enforces storage and transition invariants around it.
create or replace function record_job_outcome_event(
  p_job_id text,
  p_event_type text,
  p_verified_case_fingerprint text,
  p_repair_resolution_fingerprint text,
  p_estimate_fingerprint text,
  p_invoiced_estimate_fingerprint text,
  p_performed_repair jsonb,
  p_completion_event_fingerprint text,
  p_outcome jsonb,
  p_supersedes_event_fingerprint text,
  p_recorded_by text,
  p_schema_version int,
  p_fingerprint text
) returns job_outcome_events
language plpgsql
as $$
declare
  v_event job_outcome_events;
  v_current_status text;
  v_next_status text;
  v_updated_at timestamptz := now();
begin
  select status into v_current_status
    from service_jobs
    where job_id = p_job_id
    for update;

  if not found then
    raise exception 'record_job_outcome_event: job % not found', p_job_id;
  end if;

  if p_event_type = 'REPAIR_COMPLETED' then
    if v_current_status not in ('VERIFIED', 'ESTIMATED', 'INVOICED') then
      raise exception 'record_job_outcome_event: job % is %, cannot record REPAIR_COMPLETED', p_job_id, v_current_status;
    end if;
    if p_supersedes_event_fingerprint is not null then
      raise exception 'record_job_outcome_event: REPAIR_COMPLETED cannot supersede an outcome';
    end if;
    v_next_status := 'REPAIR_COMPLETED';
  elsif p_event_type = 'OUTCOME_RECORDED' then
    if v_current_status not in ('REPAIR_COMPLETED', 'OUTCOME_CONFIRMED') then
      raise exception 'record_job_outcome_event: job % is %, cannot record OUTCOME_RECORDED', p_job_id, v_current_status;
    end if;

    if not exists (
      select 1 from job_outcome_events
      where job_id = p_job_id
        and event_type = 'REPAIR_COMPLETED'
        and fingerprint = p_completion_event_fingerprint
    ) then
      raise exception 'record_job_outcome_event: completion event % does not belong to job %', p_completion_event_fingerprint, p_job_id;
    end if;

    if v_current_status = 'REPAIR_COMPLETED' and p_supersedes_event_fingerprint is not null then
      raise exception 'record_job_outcome_event: first outcome cannot supersede another outcome';
    end if;
    if v_current_status = 'OUTCOME_CONFIRMED' and p_supersedes_event_fingerprint is null then
      raise exception 'record_job_outcome_event: corrected outcome must supersede the active outcome';
    end if;

    if p_supersedes_event_fingerprint is not null then
      if not exists (
        select 1 from job_outcome_events
        where job_id = p_job_id
          and event_type = 'OUTCOME_RECORDED'
          and fingerprint = p_supersedes_event_fingerprint
          and completion_event_fingerprint = p_completion_event_fingerprint
      ) then
        raise exception 'record_job_outcome_event: superseded outcome % is not in this repair chain', p_supersedes_event_fingerprint;
      end if;

      if exists (
        select 1 from job_outcome_events
        where supersedes_event_fingerprint = p_supersedes_event_fingerprint
      ) then
        raise exception 'record_job_outcome_event: outcome % is already superseded', p_supersedes_event_fingerprint;
      end if;
    end if;

    v_next_status := 'OUTCOME_CONFIRMED';
  else
    raise exception 'record_job_outcome_event: invalid event_type %', p_event_type;
  end if;

  insert into job_outcome_events (
    job_id, event_type, verified_case_fingerprint, repair_resolution_fingerprint,
    estimate_fingerprint, invoiced_estimate_fingerprint, performed_repair,
    completion_event_fingerprint, outcome, supersedes_event_fingerprint,
    recorded_by, recorded_at, schema_version, fingerprint
  ) values (
    p_job_id, p_event_type, p_verified_case_fingerprint, p_repair_resolution_fingerprint,
    p_estimate_fingerprint, p_invoiced_estimate_fingerprint, p_performed_repair,
    p_completion_event_fingerprint, p_outcome, p_supersedes_event_fingerprint,
    p_recorded_by, v_updated_at, p_schema_version, p_fingerprint
  )
  returning * into v_event;

  update service_jobs
    set status = v_next_status,
        payload = jsonb_set(
          jsonb_set(payload, '{status}', to_jsonb(v_next_status), true),
          '{updatedAt}', to_jsonb(v_updated_at), true
        ),
        updated_at = v_updated_at
    where job_id = p_job_id;

  return v_event;
end;
$$;
