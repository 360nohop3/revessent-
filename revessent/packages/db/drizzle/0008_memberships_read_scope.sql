-- AUDIT FIX: 0007 fixed membership WRITE escalation but kept the read policy
-- identity-only (user_id = app.user_id). services.team() must list ALL members
-- of the caller's org — under 0007 it silently returned only the caller's own
-- row (RLS filtering without an error). Final per-command policy set:
--   read   = your own rows, or any row in an org you belong to
--   insert = bootstrap or owner/admin caller (guard), any target user (invite)
--   update = owner/admin caller (guard), evaluated on old AND new row
--   delete = leave-org (own row) or owner/admin caller (guard)
-- The helpers are SECURITY DEFINER (owner path, RLS-exempt) so referencing
-- memberships from its own policies is not recursive.

create or replace function public.caller_is_member(p_org_id uuid) returns boolean
language sql security definer set search_path = public stable as $$
  select exists (
    select 1 from memberships m
    where m.org_id = p_org_id
      and m.user_id = nullif(current_setting('app.user_id', true), '')
  )
$$;
revoke all on function public.caller_is_member(uuid) from public;
grant execute on function public.caller_is_member(uuid) to revessent_app;

drop policy if exists own_memberships_read on memberships;
create policy own_memberships_read on memberships for select to revessent_app
  using (
    user_id = nullif(current_setting('app.user_id', true), '')
    or public.caller_is_member(org_id)
  );

drop policy if exists own_memberships_insert on memberships;
create policy own_memberships_insert on memberships for insert to revessent_app
  with check (public.member_write_allowed(org_id, role));

drop policy if exists own_memberships_update on memberships;
create policy own_memberships_update on memberships for update to revessent_app
  using (public.member_write_allowed(org_id, role))
  with check (public.member_write_allowed(org_id, role));

drop policy if exists own_memberships_delete on memberships;
create policy own_memberships_delete on memberships for delete to revessent_app
  using (
    user_id = nullif(current_setting('app.user_id', true), '')
    or public.member_write_allowed(org_id, role)
  );
