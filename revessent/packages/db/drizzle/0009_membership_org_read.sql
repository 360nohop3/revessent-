-- AUDIT FIX (live E2E): services.team() runs under withOrgTx — only app.org_id
-- is set, while the 0008 read policy required app.user_id. Team lists came back
-- silently empty. Members of the CURRENT org scope may read that org's rows:
-- app.org_id is a server-side GUC set only after requireOrgRole authorized the
-- caller, so this cannot widen access for clients (they cannot set GUCs).

drop policy if exists own_memberships_read on memberships;
create policy own_memberships_read on memberships for select to revessent_app
  using (
    user_id = nullif(current_setting('app.user_id', true), '')
    or org_id = nullif(current_setting('app.org_id', true), '')::uuid
    or public.caller_is_member(org_id)
  );
