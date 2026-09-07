-- ============ PHASE 4A: Stripe connection identity + read-only sync state ============

-- Safe provider identity (§7) + validation tracking. No secret-bearing column
-- is added: the restricted key stays in key_ciphertext (AES-256-GCM, §7.5).
alter table stripe_connections add column if not exists display_name text;
alter table stripe_connections add column if not exists account_country char(2);
alter table stripe_connections add column if not exists default_currency char(3);
alter table stripe_connections add column if not exists last_validated_at timestamptz;
-- last validation failure: taxonomy CODE only (never provider internals)
alter table stripe_connections add column if not exists validation_error text;
-- status gains 'invalid' (validation failed): active | revoked | invalid | error
comment on column stripe_connections.status is 'active | revoked | invalid | error';

-- customers: provider deletion is a fact to preserve (Stripe is authority)
alter table customers add column if not exists deleted_at timestamptz;

-- payments: idempotent invoice upserts (§13) — one invoice per org, DB-enforced
create unique index if not exists payments_org_invoice_uq
  on payments (org_id, stripe_invoice_id)
  where stripe_invoice_id is not null;

-- durable per-entity sync state: cursors/checkpoints + freshness (§10)
create table if not exists sync_state (
  id uuid primary key,
  org_id uuid not null references organizations(id) on delete cascade,
  entity text not null, -- customers | subscriptions | invoices
  status text not null default 'idle', -- idle | running | ok | failed
  cursor text, -- provider checkpoint (starting_after / created-gt) for resume
  provider_account text,
  pages_synced integer not null default 0,
  records_upserted integer not null default 0,
  last_success_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  last_error text, -- safe taxonomy code only
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, entity)
);
alter table sync_state enable row level security;
create policy org_isolation on sync_state
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
grant select, insert, update, delete on sync_state to revessent_app;

-- webhook preparation ONLY (§15): webhook_events exists from Phase 3 schema;
-- no processing path exists in Phase 4A. Comment marks the boundary.
comment on table webhook_events is 'Phase 4B PREPARATION ONLY: events are persisted
(external_id-unique, raw payload) by the future webhook receiver. Nothing in Phase 4A
reads or processes rows here; recovery execution remains a later phase.';
