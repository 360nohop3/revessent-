-- Phase 4B correction: Stripe event-id uniqueness is scoped to the delivery
-- identity (source + connected account), not globally. Two REVESSENT
-- organizations may connect the SAME Stripe account; each has its own
-- webhook endpoint and both legitimately receive the SAME event id. A global
-- unique would silently swallow the second org's delivery (cross-org data
-- loss). Scope = (source, account, external_id); the empty account (rare
-- account-less events) is folded to '' so NULLs cannot bypass uniqueness.
alter table webhook_events drop constraint if exists webhook_events_external_id_unique;
create unique index webhook_events_delivery_uq
  on webhook_events (source, coalesce(account, ''), external_id);
