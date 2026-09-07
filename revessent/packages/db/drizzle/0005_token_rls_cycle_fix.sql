-- 0003 created mutually-recursive RLS policies (checkouts ↔ cases), which
-- Postgres rejects with 42P17 at query time. Break the cycle: the case→org
-- lookup moves into a SECURITY DEFINER function (owner path = no RLS), so
-- policy references form a DAG:
--   checkouts → func · cases → {org scope, checkouts} · customers/payments → {…, func}

create or replace function public.case_org_id(p_case_id uuid) returns uuid
language sql security definer set search_path = public stable as $$
  select org_id from recovery_cases where id = p_case_id
$$;
revoke all on function public.case_org_id(uuid) from public;
grant execute on function public.case_org_id(uuid) to revessent_app;

drop policy if exists org_or_token on recovery_checkouts;
create policy org_or_token on recovery_checkouts
  using (
    public.case_org_id(case_id) = nullif(current_setting('app.org_id', true), '')::uuid
    or token_hash = nullif(current_setting('app.checkout_token_hash', true), '')
  )
  with check (
    public.case_org_id(case_id) = nullif(current_setting('app.org_id', true), '')::uuid
  );

drop policy if exists org_or_token on recovery_cases;
create policy org_or_token on recovery_cases
  using (
    org_id = nullif(current_setting('app.org_id', true), '')::uuid
    or (
      nullif(current_setting('app.token_flow', true), '') = '1'
      and exists (select 1 from recovery_checkouts ck
                  where ck.case_id = id
                    and ck.token_hash = nullif(current_setting('app.checkout_token_hash', true), ''))
    )
  )
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);

drop policy if exists org_or_token on customers;
create policy org_or_token on customers
  using (
    org_id = nullif(current_setting('app.org_id', true), '')::uuid
    or (
      nullif(current_setting('app.token_flow', true), '') = '1'
      and exists (
        select 1 from recovery_checkouts ck
        where public.case_org_id(ck.case_id) = customers.org_id
          and ck.token_hash = nullif(current_setting('app.checkout_token_hash', true), '')
          and exists (select 1 from recovery_cases c where c.id = ck.case_id and c.customer_id = customers.id)
      )
    )
  )
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);

drop policy if exists org_or_token on payments;
create policy org_or_token on payments
  using (
    org_id = nullif(current_setting('app.org_id', true), '')::uuid
    or (
      nullif(current_setting('app.token_flow', true), '') = '1'
      and exists (
        select 1 from recovery_checkouts ck
        where public.case_org_id(ck.case_id) = payments.org_id
          and ck.token_hash = nullif(current_setting('app.checkout_token_hash', true), '')
          and exists (select 1 from recovery_cases c where c.id = ck.case_id and c.payment_id = payments.id)
      )
    )
  )
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);

drop policy if exists org_member_read on organizations;
create policy org_member_read on organizations for select to revessent_app
  using (
    exists (select 1 from memberships m
            where m.org_id = id
              and m.user_id = nullif(current_setting('app.user_id', true), ''))
    or (
      nullif(current_setting('app.token_flow', true), '') = '1'
      and exists (
        select 1 from recovery_checkouts ck
        where public.case_org_id(ck.case_id) = organizations.id
          and ck.token_hash = nullif(current_setting('app.checkout_token_hash', true), '')
      )
    )
  );
