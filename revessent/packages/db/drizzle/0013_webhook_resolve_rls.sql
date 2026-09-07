-- Phase 4B: webhook connection resolution under RLS.
-- The receiver has no user session; it must resolve the connection named by
-- the unguessable {orgRef} (the connection id) BEFORE any org scope exists.
-- Follows the established Phase 3 pattern (0005/0007): a narrowly scoped
-- SECURITY DEFINER lookup — select-only, exact-id, safe columns. Everything
-- AFTER resolution runs under the normal org_isolation RLS path.
create or replace function resolve_webhook_connection(p_ref uuid)
returns table (
  org_id uuid,
  mode text,
  stripe_account_id text,
  status text,
  webhook_secret_enc text,
  webhook_endpoint_id text
)
language sql security definer set search_path = public stable
as $$
  select org_id, mode, stripe_account_id, status, webhook_secret_enc, webhook_endpoint_id
  from stripe_connections
  where id = p_ref
$$;

revoke all on function resolve_webhook_connection(uuid) from public;
grant execute on function resolve_webhook_connection(uuid) to revessent_app;
