-- PHASE 7: entitlements & plan enforcement — authoritative billing state.
-- org_subscriptions (0000) is Revessent's OWN billing record (§5.2). Phase 7
-- makes it the single billing truth synchronised from Stripe Billing webhooks:
-- verbatim provider status, provider ordering timestamp (out-of-order/duplicate
-- deliveries never regress state), and the linkage ids used to resolve the
-- tenant BEFORE any org scope exists (same SECURITY DEFINER pattern as 0013).
-- No pricing lives here; the plan→capability matrix is code (packages/domain).
alter table org_subscriptions
  add column if not exists current_period_end timestamptz,
  add column if not exists cancel_at_period_end boolean not null default false,
  add column if not exists provider_updated_at timestamptz,          -- Stripe event `created` of the last applied event
  add column if not exists last_event_id text,                       -- provenance: last applied Stripe event id
  add column if not exists plan_source text not null default 'default', -- default | stripe_billing | operator
  add column if not exists created_at timestamptz not null default now();
--> statement-breakpoint
create index if not exists org_subscriptions_stripe_customer_idx on org_subscriptions (stripe_customer_id);
--> statement-breakpoint
create index if not exists org_subscriptions_stripe_subscription_idx on org_subscriptions (stripe_subscription_id);
--> statement-breakpoint
-- Tenant resolution for the platform billing webhook: exact-match on the
-- provider ids we stored ourselves (never on payload-claimed org ids alone).
create or replace function resolve_billing_org(p_customer text, p_subscription text)
returns table (org_id uuid, stripe_customer_id text, stripe_subscription_id text)
language sql security definer set search_path = public stable
as $$
  select org_id, stripe_customer_id, stripe_subscription_id
  from org_subscriptions
  where (p_subscription is not null and stripe_subscription_id = p_subscription)
     or (p_customer is not null and stripe_customer_id = p_customer)
  order by (stripe_subscription_id = p_subscription) desc nulls last
  limit 1
$$;
--> statement-breakpoint
revoke all on function resolve_billing_org(text, text) from public;
--> statement-breakpoint
grant execute on function resolve_billing_org(text, text) to revessent_app;
--> statement-breakpoint
-- Binding a not-yet-linked org from provider metadata: the org must exist and
-- must not already be linked to a different subscription. Exact id, one row.
create or replace function resolve_billing_org_unlinked(p_org uuid)
returns table (org_id uuid, stripe_customer_id text, stripe_subscription_id text)
language sql security definer set search_path = public stable
as $$
  select org_id, stripe_customer_id, stripe_subscription_id
  from org_subscriptions
  where org_id = p_org and stripe_subscription_id is null
$$;
--> statement-breakpoint
revoke all on function resolve_billing_org_unlinked(uuid) from public;
--> statement-breakpoint
grant execute on function resolve_billing_org_unlinked(uuid) to revessent_app;
--> statement-breakpoint
-- organizations.plan mirrors org_subscriptions.plan for display (sidebar, /me).
-- The app role had no UPDATE policy on organizations; allow updating ONLY the
-- row of the CURRENT tenant scope (app.org_id is a server-side GUC set after
-- authorization — clients cannot set it). Column-level: plan + updated_at only.
-- The read policy must also admit the current tenant scope (an UPDATE's WHERE
-- reads the row): same GUC, same trust boundary as every org_isolation policy.
drop policy if exists org_member_read on organizations;
--> statement-breakpoint
create policy org_member_read on organizations for select to revessent_app
  using (
    exists (select 1 from memberships m
            where m.org_id = organizations.id
              and m.user_id = nullif(current_setting('app.user_id', true), ''))
    or organizations.id = nullif(current_setting('app.org_id', true), '')::uuid
    or (
      nullif(current_setting('app.token_flow', true), '') = '1'
      and exists (
        select 1 from recovery_checkouts ck
        where public.case_org_id(ck.case_id) = organizations.id
          and ck.token_hash = nullif(current_setting('app.checkout_token_hash', true), '')
      )
    )
  );
--> statement-breakpoint
create policy org_self_update on organizations for update to revessent_app
  using (id = nullif(current_setting('app.org_id', true), '')::uuid)
  with check (id = nullif(current_setting('app.org_id', true), '')::uuid);
--> statement-breakpoint
revoke update on organizations from revessent_app;
--> statement-breakpoint
grant update (plan, updated_at) on organizations to revessent_app;
