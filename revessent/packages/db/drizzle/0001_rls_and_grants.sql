-- Phase 3 — Multi-tenant isolation, defense-in-depth (Architecture v1 §7.4)
-- Layer 2 of 3: Postgres RLS. The application connects as `revessent_app`
-- (non-owner ⇒ RLS binds). Two per-transaction GUCs:
--   app.user_id — identity scope (set for authz lookups + auth tables)
--   app.org_id  — tenant scope  (set by withOrgTx; all tenant reads/writes)
-- The migrator/owner bypasses RLS by design (migrations, seeds, WORM grants).

-- ============ identity-scoped tables (pre-org authorization reads) ============
alter table organizations enable row level security;
create policy org_member_read on organizations for select to revessent_app
  using (exists (select 1 from memberships m
                 where m.org_id = id
                   and m.user_id = nullif(current_setting('app.user_id', true), '')));
create policy org_insert_by_member on organizations for insert to revessent_app
  with check (true); -- creator membership row is inserted in the same transaction

alter table memberships enable row level security;
create policy own_memberships on memberships to revessent_app
  using (user_id = nullif(current_setting('app.user_id', true), ''))
  with check (user_id = nullif(current_setting('app.user_id', true), ''));

-- ============ tenant-scoped tables (org_id = current app.org_id) ============
do $$
declare t text;
begin
  foreach t in array array[
    'invitations','stripe_connections','plan_catalog',
    'customers','subscriptions','payments','recovery_cases','recovery_messages',
    'recovery_attributions','retry_policies','voice_profiles','expansion_signals',
    'expansion_opportunities','ai_generations','ai_usage_budgets','digests',
    'org_subscriptions','webhook_events'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format($f$create policy org_isolation on %I
      using (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
      with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid)$f$, t);
  end loop;
end $$;

-- ============ join-based tables (no org_id column, per §5.2) ============
alter table recovery_attempts enable row level security;
create policy org_isolation on recovery_attempts
  using (exists (select 1 from recovery_cases c
                 where c.id = case_id
                   and c.org_id = nullif(current_setting('app.org_id', true), '')::uuid))
  with check (exists (select 1 from recovery_cases c
                 where c.id = case_id
                   and c.org_id = nullif(current_setting('app.org_id', true), '')::uuid));

alter table payment_attempts enable row level security;
create policy org_isolation on payment_attempts
  using (exists (select 1 from payments p
                 where p.id = payment_id
                   and p.org_id = nullif(current_setting('app.org_id', true), '')::uuid))
  with check (exists (select 1 from payments p
                 where p.id = payment_id
                   and p.org_id = nullif(current_setting('app.org_id', true), '')::uuid));

alter table recovery_checkouts enable row level security;
create policy org_isolation on recovery_checkouts
  using (exists (select 1 from recovery_cases c
                 where c.id = case_id
                   and c.org_id = nullif(current_setting('app.org_id', true), '')::uuid))
  with check (exists (select 1 from recovery_cases c
                 where c.id = case_id
                   and c.org_id = nullif(current_setting('app.org_id', true), '')::uuid));

-- ============ audit_logs: append-only (WORM) ============
alter table audit_logs enable row level security;
revoke update, delete on audit_logs from revessent_app;
create policy audit_insert on audit_logs for insert to revessent_app with check (true);
create policy audit_read on audit_logs for select to revessent_app
  using (org_id = nullif(current_setting('app.org_id', true), '')::uuid);

-- ============ auth tables (Better Auth's; identity-scoped, never org data) ============
alter table "user" enable row level security;
alter table "session" enable row level security;
alter table "account" enable row level security;
alter table "verification" enable row level security;
alter table "idempotency_keys" enable row level security;
create policy auth_rows on "user" using (true) with check (true);
create policy auth_rows on "session" using (true) with check (true);
create policy auth_rows on "account" using (true) with check (true);
create policy auth_rows on "verification" using (true) with check (true);
create policy auth_rows on "idempotency_keys" using (true) with check (true);

-- ============ grants: app role = DML only ============
grant usage on schema public to revessent_app;
grant select, insert, update, delete on all tables in schema public to revessent_app;
grant usage, select on all sequences in schema public to revessent_app;
alter default privileges in schema public grant select, insert, update, delete on tables to revessent_app;
