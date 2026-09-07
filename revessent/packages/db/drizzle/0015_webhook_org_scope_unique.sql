-- Phase 4B correction #2: the delivery scope of a Stripe event is the
-- CONNECTION that received it, i.e. the org (the endpoint is per-org). Two
-- orgs may connect the same Stripe account (same event ids) and most
-- account-scoped events carry the account id, but account-less events must
-- not collide across orgs either. Unique per (org, source, account,
-- external_id): same-org redelivery dedupes; cross-org deliveries never do.
drop index if exists webhook_events_delivery_uq;
create unique index webhook_events_delivery_uq
  on webhook_events (org_id, source, coalesce(account, ''), external_id);
