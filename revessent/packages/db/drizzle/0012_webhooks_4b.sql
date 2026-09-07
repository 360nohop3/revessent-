-- Phase 4B: webhooks & reconciliation. Narrow additions to the Phase 3
-- webhook_events preparation + per-connection webhook lifecycle columns.
-- Forward migration only; no history edited; RLS unchanged (webhook_events
-- is already inside the org_isolation policy family from 0001).

alter table "webhook_events" add column "account" text;
alter table "webhook_events" add column "provider_created_at" timestamptz;
alter table "webhook_events" add column "object_type" text;
alter table "webhook_events" add column "object_id" text;

-- Ordering guard + reconciliation lookups: which events touched an object.
create index "webhook_events_object_idx" on "webhook_events" ("org_id","object_type","object_id");

alter table "stripe_connections" add column "last_webhook_at" timestamptz;

-- The preparation comment is superseded: the table is now LIVE (4B).
comment on table webhook_events is 'Inbound provider events (Phase 4B): signature-verified,
durably persisted, DB-unique per provider event id, idempotently processed.
statuses: pending|processed|failed|skipped|reconciled';
