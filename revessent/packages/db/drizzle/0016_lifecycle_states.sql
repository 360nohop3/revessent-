-- Phase 4B correction (lifecycle consistency): the Stripe webhook endpoint
-- lifecycle and the local connection lifecycle cannot share a transaction.
-- Make every transition idempotent, recoverable, and observable:
--
-- webhook_state (endpoint-specific lifecycle nuance; NULL = registered/healthy):
--   'creating'                     provider endpoint creation is in flight for
--                                  this row (durable intent, written BEFORE the
--                                  provider call) — a crash here is recoverable:
--                                  reconciliation locates the endpoint via the
--                                  self-registered URL and cleans it up
--   'registration_failed'          endpoint could not be created; the read-only
--                                  connection is valid and the sync delta path
--                                  covers delivery (surfaced, never fatal)
--   'cleanup_pending'              a provider endpoint still needs deletion and
--                                  the sealed key to do it is retained
--   'provider_deleted_local_stale' provider endpoint confirmed deleted but the
--                                  local finalization did not commit — a retry
--                                  or reconciliation completes it locally
--   'orphan_cleanup'               an orphaned row's endpoint still requires
--                                  provider-side cleanup
--
-- status gains two NON-USABLE lifecycle values: 'provisioning' (durable intent
-- before/while the provider call runs; never surfaced as a connection) and
-- 'orphaned' (provider endpoint exists but local finalization failed AND
-- compensation failed — recorded, sealed key retained for cleanup auth).
--
-- The one-USABLE-connection-per-(org,mode) rule becomes a partial unique
-- index on ACTIVE rows only: lifecycle transitions briefly coexist with
-- superseded history rows ('error' with retained cleanup material,
-- 'provisioning' intent, 'orphaned' records) — exactly one ACTIVE row is
-- the invariant the connection readers depend on. The connect finalization
-- supersedes the old ACTIVE row before activating the new one, inside one
-- transaction, so the invariant holds at every statement boundary.
alter table stripe_connections add column webhook_state text;
comment on column stripe_connections.webhook_state is 'endpoint lifecycle: null=registered/healthy | creating | registration_failed | cleanup_pending | provider_deleted_local_stale | orphan_cleanup (secrets never expressed here)';

alter table stripe_connections drop constraint stripe_connections_org_mode_uq;
create unique index stripe_connections_org_mode_usable_uq
  on stripe_connections (org_id, mode)
  where status = 'active';
