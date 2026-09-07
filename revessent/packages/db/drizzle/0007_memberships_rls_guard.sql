-- AUDIT FIX (Phase 3 RLS deep audit): 0001's `own_memberships` was a FOR ALL
-- policy gated only on user_id = app.user_id, so the INSERT/UPDATE paths would
-- have allowed the app role to add itself to ANY organization with ANY role
-- (query-layer trust only). Split into per-command policies; all writes beyond
-- the bootstrap must pass a SECURITY DEFINER guard that runs as the table
-- owner (RLS-exempt, so referencing memberships here is not recursive):
--   · bootstrap: the target org has no members yet → first membership allowed
--   · otherwise the caller (app.user_id) must already be owner/admin of that org
--   · only an owner may grant/hold the 'owner' role
-- Invite redemption (later phase) must insert through this same guard by
-- acting as an owner/admin, or via a dedicated definer function.

create or replace function public.member_write_allowed(p_org_id uuid, p_role text)
returns boolean
language sql security definer set search_path = public stable as $$
  with caller as (
    select role from memberships
    where org_id = p_org_id
      and user_id = nullif(current_setting('app.user_id', true), '')
  )
  select
    -- bootstrap: org has no members yet (creator inserts the first membership)
    not exists (select 1 from memberships m where m.org_id = p_org_id)
    -- or caller administers this org…
    or (exists (select 1 from caller where role in ('owner', 'admin'))
        -- …and only an owner may create/change an 'owner' membership
        and (p_role <> 'owner' or exists (select 1 from caller where role = 'owner')))
$$;
revoke all on function public.member_write_allowed(uuid, text) from public;
grant execute on function public.member_write_allowed(uuid, text) to revessent_app;

drop policy if exists own_memberships on memberships;
create policy own_memberships_read on memberships for select to revessent_app
  using (user_id = nullif(current_setting('app.user_id', true), ''));

create policy own_memberships_insert on memberships for insert to revessent_app
  with check (
    user_id = nullif(current_setting('app.user_id', true), '')
    and public.member_write_allowed(org_id, role)
  );

create policy own_memberships_update on memberships for update to revessent_app
  using (user_id = nullif(current_setting('app.user_id', true), ''))
  with check (
    user_id = nullif(current_setting('app.user_id', true), '')
    and public.member_write_allowed(org_id, role)
  );

create policy own_memberships_delete on memberships for delete to revessent_app
  using (
    user_id = nullif(current_setting('app.user_id', true), '')
    and public.member_write_allowed(org_id, role)
  );
