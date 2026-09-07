-- Phase 4C: payment execution primitives. The architecture's execution
-- record IS recovery_attempts (idempotency_key unique, kind='manual_retry');
-- 0017 extends it into a full durable execution identity WITHOUT inventing a
-- second model. Columns hold only safe financial/operational facts — never
-- card data, credentials, or signing secrets.
alter table recovery_attempts
  add column org_id uuid,
  add column payment_id uuid,
  add column amount_cents bigint,
  add column currency char(3),
  add column stripe_connection_id uuid,
  add column provider_payment_intent_id text,
  add column request_hash text,
  add column error_code text,
  add column outcome_category text,   -- succeeded | declined | authentication_required |
                                      -- invalid_request | invalid_credentials | revoked |
                                      -- rate_limited | transient | network | unknown |
                                      -- no_provider_operation
  add column retry_classification text, -- never | later (classification ONLY — no worker exists)
  add column provider_meta jsonb,       -- safe subset (ids/statuses), never raw provider errors
  add column reconciled_at timestamptz;

-- Backfill org from the case (existing rows are all 4A 'skipped' fixtures —
-- keep them valid under the new NOT NULL + RLS).
update recovery_attempts ra
  set org_id = rc.org_id
  from recovery_cases rc
  where ra.case_id = rc.id;
alter table recovery_attempts alter column org_id set not null;

-- Execution identity is scoped to the organization (client-supplied keys from
-- different orgs must never collide). The old global unique is superseded.
alter table recovery_attempts drop constraint recovery_attempts_idempotency_key_unique;
create unique index recovery_attempts_org_key_uq
  on recovery_attempts (org_id, idempotency_key);

-- An execution is anchored to exactly one local payment (immutable target).
alter table recovery_attempts
  add constraint recovery_attempts_payment_fk
  foreign key (payment_id) references payments(id) on delete set null;

-- RLS: direct org anchor replaces the join-through-case policy (0001) — same
-- isolation, one fewer join, identical guarantees for the app role.
drop policy if exists org_isolation on recovery_attempts;
create policy org_isolation on recovery_attempts
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);

comment on table recovery_attempts is 'Payment execution records (Phase 4C): one explicit, idempotent payment operation. status: scheduled|executing|succeeded|failed|unknown|skipped|canceled — unknown = provider outcome not yet established, recoverable via reconciliation (never blindly re-executed).';
