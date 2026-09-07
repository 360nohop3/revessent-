-- Public /c/{token} reads under RLS: a request may pass the token-hash GUC
-- only after presenting the raw token; policies admit exactly the rows that
-- belong to the matched checkout. app.token_flow is set server-side only
-- AFTER the hash matched, and only for the same transaction.
drop policy if exists org_isolation on recovery_checkouts;
create policy org_or_token on recovery_checkouts
  using (
    case_id in (select c.id from recovery_cases c
                where c.org_id = nullif(current_setting('app.org_id', true), '')::uuid)
    or token_hash = nullif(current_setting('app.checkout_token_hash', true), '')
  )
  with check (
    case_id in (select c.id from recovery_cases c
                where c.org_id = nullif(current_setting('app.org_id', true), '')::uuid)
  );

drop policy if exists org_isolation on recovery_cases;
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

drop policy if exists org_isolation on customers;
create policy org_or_token on customers
  using (
    org_id = nullif(current_setting('app.org_id', true), '')::uuid
    or (
      nullif(current_setting('app.token_flow', true), '') = '1'
      and exists (
        select 1 from recovery_checkouts ck
        join recovery_cases c on c.id = ck.case_id
        where c.customer_id = customers.id
          and ck.token_hash = nullif(current_setting('app.checkout_token_hash', true), '')
      )
    )
  )
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);

drop policy if exists org_isolation on payments;
create policy org_or_token on payments
  using (
    org_id = nullif(current_setting('app.org_id', true), '')::uuid
    or (
      nullif(current_setting('app.token_flow', true), '') = '1'
      and exists (
        select 1 from recovery_checkouts ck
        join recovery_cases c on c.id = ck.case_id
        where c.payment_id = payments.id
          and ck.token_hash = nullif(current_setting('app.checkout_token_hash', true), '')
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
        join recovery_cases c on c.id = ck.case_id
        where c.org_id = organizations.id
          and ck.token_hash = nullif(current_setting('app.checkout_token_hash', true), '')
      )
    )
  );
