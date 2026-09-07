-- 0001/0005 wrote `m.org_id = id` / `ck.case_id = id` inside EXISTS subqueries;
-- Postgres binds the unqualified `id` to the INNERMOST relation (m.id / ck.id),
-- so those member-matching branches never matched. Qualify with the outer table.

drop policy if exists org_member_read on organizations;
create policy org_member_read on organizations for select to revessent_app
  using (
    exists (select 1 from memberships m
            where m.org_id = organizations.id
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

drop policy if exists org_or_token on recovery_cases;
create policy org_or_token on recovery_cases
  using (
    org_id = nullif(current_setting('app.org_id', true), '')::uuid
    or (
      nullif(current_setting('app.token_flow', true), '') = '1'
      and exists (select 1 from recovery_checkouts ck
                  where ck.case_id = recovery_cases.id
                    and ck.token_hash = nullif(current_setting('app.checkout_token_hash', true), ''))
    )
  )
  with check (org_id = nullif(current_setting('app.org_id', true), '')::uuid);
