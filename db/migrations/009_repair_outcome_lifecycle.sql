-- 009_repair_outcome_lifecycle.sql
-- Adds the second trust boundary behind VERIFIED_CASE -> REPAIR_RESOLVED ->
-- ESTIMATED -> INVOICED (the operational/authorization spine, unchanged).
--
-- REPAIR_COMPLETED / OUTCOME_CONFIRMED answer a different question than that
-- spine does: not "what did the mechanic authorize", but "did it actually
-- work". service_jobs.status stays a mutable current-state cache, same as
-- today. job_outcome_events is the actual truth store for that second
-- question, and it is append-only - corrections supersede, they never
-- overwrite. See src/core/evidence/confirmed.repair.case.js for the
-- application-level contract this table backs.

alter table service_jobs drop constraint if exists service_jobs_status_check;
alter table service_jobs add constraint service_jobs_status_check check (
  status in (
    'DIAGNOSING', 'TESTING', 'VERIFIED', 'ESTIMATED', 'INVOICED', 'DIAG_FAILED',
    'REPAIR_COMPLETED', 'OUTCOME_CONFIRMED'
  )
);

create table if not exists job_outcome_events (
  id uuid primary key default gen_random_uuid(),
  job_id text not null references service_jobs (job_id),
  event_type text not null check (event_type in ('REPAIR_COMPLETED', 'OUTCOME_RECORDED')),

  -- Lineage anchors. verified_case_fingerprint is the only one that's ever
  -- NOT NULL - a job can reach REPAIR_COMPLETED without ever having been
  -- priced through SKSK Estimate (side job, warranty work, cash job). The
  -- other three are optional but strictly validated against the job's
  -- actual chain when present (see resolveLineage in the JS contract).
  -- invoiced_estimate_fingerprint is deliberately not called
  -- "invoiceFingerprint" - there's no independently-fingerprinted invoice
  -- object yet (invoice.js only carries the estimateFingerprint it was
  -- built from), so this column proves "this job was invoiced, and that
  -- invoice matches this estimate lineage", not a separate invoice
  -- identity. Don't rename it to invoiceFingerprint until an invoice
  -- actually has its own fingerprint to back that claim.
  verified_case_fingerprint text not null,
  repair_resolution_fingerprint text,
  estimate_fingerprint text,
  invoiced_estimate_fingerprint text,

  -- Populated only on REPAIR_COMPLETED rows.
  performed_repair jsonb,

  -- Populated only on OUTCOME_RECORDED rows. References the specific
  -- REPAIR_COMPLETED event this outcome is reporting on, by that event's
  -- own fingerprint (not a DB id) so the binding survives independent of
  -- storage internals and is re-verifiable from the payload alone.
  completion_event_fingerprint text,
  outcome jsonb,

  recorded_by text,
  recorded_at timestamptz not null default now(),
  schema_version int not null default 1,

  -- unique (not just indexed) so it can itself be an FK target below -
  -- fingerprint, not the internal uuid id, is this table's one identity
  -- concept for cross-referencing rows.
  fingerprint text not null unique,

  -- Append-only correction chain. A correction is a new row whose
  -- supersedes_event_fingerprint points at the row it replaces, by that
  -- row's own content fingerprint - the same identity used everywhere
  -- else in this table and in the JS contract (confirmed.repair.case.js).
  -- Deliberately not a UUID FK to the internal id column: mixing UUID and
  -- fingerprint identity for the same concept is exactly the kind of seam
  -- bug this design is trying to prevent elsewhere. "Active" outcome for a
  -- job = the OUTCOME_RECORDED row that is not the target of any other
  -- row's supersedes_event_fingerprint.
  supersedes_event_fingerprint text references job_outcome_events (fingerprint),

  constraint job_outcome_events_completed_shape check (
    (event_type = 'REPAIR_COMPLETED' and performed_repair is not null and outcome is null and completion_event_fingerprint is null)
    or
    (event_type = 'OUTCOME_RECORDED' and outcome is not null and performed_repair is null and completion_event_fingerprint is not null)
  )
);

create index if not exists idx_job_outcome_events_job_id on job_outcome_events (job_id);
create index if not exists idx_job_outcome_events_type on job_outcome_events (job_id, event_type);
create index if not exists idx_job_outcome_events_supersedes on job_outcome_events (supersedes_event_fingerprint) where supersedes_event_fingerprint is not null;

alter table job_outcome_events enable row level security;
drop policy if exists "service role full access" on job_outcome_events;
create policy "service role full access" on job_outcome_events
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');

-- Belt-and-suspenders: Supabase's service_role key bypasses RLS entirely,
-- so an RLS policy alone does not actually stop the backend itself from
-- mutating history if application code ever tried (bug, bad merge,
-- compromised key). A trigger runs regardless of role and makes the table
-- physically append-only at the database level, not just by convention.
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

-- Atomic write path. job_outcome_events (truth) and service_jobs.status
-- (cached projection) are two persisted facts; the application must never
-- be able to write one without the other. This function does the insert
-- and the status update in a single transaction, and locks the job row
-- with FOR UPDATE so two concurrent calls can't both read a stale status
-- and both believe their transition is legal.
--
-- service_jobs carries the job's status in two places: a top-level status
-- column (what most of job.lifecycle.js reads/writes) and a copy embedded
-- in payload jsonb (what getJob() actually returns to callers, since it
-- selects payload, not status). Updating only the column and leaving the
-- embedded copy stale would mean the DB status, the JSON payload status,
-- and whatever the caller displays could all disagree with each other -
-- so both are set together here, in the same statement.
--
-- The application builds and fingerprints the event in JS
-- (src/core/evidence/confirmed.repair.case.js owns that validation - it
-- isn't duplicated here), then makes exactly one call to this function.
-- There is no code path that inserts a row without also moving the job's
-- status, or vice versa.
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
    v_next_status := 'REPAIR_COMPLETED';
  elsif p_event_type = 'OUTCOME_RECORDED' then
    if v_current_status not in ('REPAIR_COMPLETED', 'OUTCOME_CONFIRMED') then
      raise exception 'record_job_outcome_event: job % is %, cannot record OUTCOME_RECORDED', p_job_id, v_current_status;
    end if;
    v_next_status := 'OUTCOME_CONFIRMED';
  else
    raise exception 'record_job_outcome_event: invalid event_type %', p_event_type;
  end if;

  insert into job_outcome_events (
    job_id, event_type, verified_case_fingerprint, repair_resolution_fingerprint,
    estimate_fingerprint, invoiced_estimate_fingerprint, performed_repair,
    completion_event_fingerprint, outcome, supersedes_event_fingerprint, recorded_by,
    schema_version, fingerprint
  ) values (
    p_job_id, p_event_type, p_verified_case_fingerprint, p_repair_resolution_fingerprint,
    p_estimate_fingerprint, p_invoiced_estimate_fingerprint, p_performed_repair,
    p_completion_event_fingerprint, p_outcome, p_supersedes_event_fingerprint, p_recorded_by,
    p_schema_version, p_fingerprint
  )
  returning * into v_event;

  update service_jobs
    set status = v_next_status,
        payload = jsonb_set(coalesce(payload, '{}'::jsonb), '{status}', to_jsonb(v_next_status)),
        updated_at = now()
    where job_id = p_job_id;

  return v_event;
end;
$$;
