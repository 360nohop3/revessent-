-- PHASE 6 (safety fix): durable, authoritative customer communication
-- suppression (opt-out). Checked by the application at prepare time and —
-- mandatorily — after the durable send claim and before any provider call.
-- Written only by the server: via the existing unguessable /c/{token}
-- mechanism (public unsubscribe) or an org-scoped operator/system action.
-- No PII beyond the customer id; reason/source are safe enumerations.
create table communication_suppressions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  customer_id uuid not null references customers(id) on delete cascade,
  channel text not null default 'email',            -- only channel in Phase 6
  reason text not null,                             -- customer_unsubscribed | operator
  source text not null,                             -- unsubscribe_token | operator | system
  source_ref uuid,                                  -- e.g. recovery case id the link belonged to
  created_at timestamptz not null default now(),
  constraint communication_suppressions_org_customer_channel_uq unique (org_id, customer_id, channel)
);
--> statement-breakpoint
create index communication_suppressions_customer_idx on communication_suppressions (customer_id);
--> statement-breakpoint
alter table communication_suppressions enable row level security;
--> statement-breakpoint
-- Org isolation only: the public unsubscribe flow resolves the token under the
-- token-flow policies first, then writes under the resolved org scope.
create policy org_isolation on communication_suppressions
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
-- Suppressions are append-only for the app role (no delete/update: an opt-out
-- cannot be silently reversed by application code).
grant select, insert on communication_suppressions to revessent_app;
