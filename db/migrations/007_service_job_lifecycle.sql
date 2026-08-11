-- 007_service_job_lifecycle.sql
-- One job_id follows the repair from DIAG -> TEST -> VERIFY -> ESTIMATE -> INVOICE.
-- The identifying customer/vehicle snapshot is indexed for garage/history lookup;
-- the full evolving lifecycle payload stays together for a clean first implementation.

create table if not exists service_jobs (
  id uuid primary key default gen_random_uuid(),
  job_id text not null unique,
  status text not null default 'DIAGNOSING',
  customer_name text,
  customer_phone text,
  customer_email text,
  vehicle_year integer,
  vehicle_make text,
  vehicle_model text,
  vehicle_vin text,
  mileage integer,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint service_jobs_status_check check (
    status in ('DIAGNOSING','TESTING','VERIFIED','ESTIMATED','INVOICED','DIAG_FAILED')
  )
);

create index if not exists idx_service_jobs_customer_phone on service_jobs(customer_phone);
create index if not exists idx_service_jobs_customer_name on service_jobs(lower(customer_name));
create index if not exists idx_service_jobs_vehicle_vin on service_jobs(vehicle_vin);
create index if not exists idx_service_jobs_vehicle_lookup on service_jobs(vehicle_year, lower(vehicle_make), lower(vehicle_model));
create index if not exists idx_service_jobs_status on service_jobs(status);

alter table service_jobs enable row level security;
drop policy if exists "service role full access" on service_jobs;
create policy "service role full access" on service_jobs
  for all using (auth.role() = 'service_role') with check (auth.role() = 'service_role');
