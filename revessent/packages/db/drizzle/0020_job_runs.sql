-- PHASE 5: durable job lifecycle (architecture §10 — at-least-once enqueue,
-- exactly-once effects). Redis/BullMQ is the delivery mechanism; this table is
-- the durable authority for what work was intended, for whom, and whether it
-- ran. The worker stays a delivery mechanism: financial eligibility remains
-- Phase 4D's, execution remains Phase 4C's.
create table job_runs (
  id uuid primary key,
  org_id uuid not null references organizations(id) on delete cascade,
  queue text not null,                                   -- §10.1 queue name ('retries')
  job_type text not null,                                -- §10.2 job name ('retry.execute')
  dedupe_key text not null,                              -- deterministic business identity
  case_id uuid references recovery_cases(id) on delete set null,
  status text not null default 'queued',                 -- queued|leased|succeeded|failed|canceled
  outcome text,                                          -- delivered result: executed|blocked|waiting|exhausted|disabled|not_due|no_such_case
  attempts integer not null default 0,                   -- infrastructure attempts consumed
  max_attempts integer not null default 5,               -- §10.2: 5 then dead-letter
  run_after timestamptz not null default now(),
  leased_at timestamptz,
  lease_expires_at timestamptz,
  last_attempted_at timestamptz,
  finished_at timestamptz,
  last_error_category text,                              -- safe category only — never provider bodies
  last_error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index job_runs_org_created_idx on job_runs (org_id, created_at desc);
create index job_runs_status_idx on job_runs (status);
-- Queue-amplification guard: at most ONE live (queued|leased) job per
-- deterministic identity, enforced by the database — two scheduler instances
-- or repeated discovery cannot create duplicate logical jobs.
create unique index job_runs_dedupe_live_uq
  on job_runs (dedupe_key)
  where status in ('queued', 'leased');
-- RLS: standard org isolation — a job belongs to exactly one organization.
alter table job_runs enable row level security;
create policy org_isolation on job_runs
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
-- app role: standard DML (0010 convention — default privileges no longer cover
-- new tables for update/delete after the audit WORM revoke in 0002)
grant select, insert, update, delete on job_runs to revessent_app;
