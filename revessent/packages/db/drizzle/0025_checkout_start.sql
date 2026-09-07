-- Phase 8 correction — Hosted Recovery Checkout.
-- Records when a member actually opened the Stripe-hosted payment surface
-- from /c/{token}. Completion is NEVER written here by the browser: the
-- checkout row moves to `completed` only when provider truth (invoice.paid
-- via webhook / sync / reconciliation) marks the payment paid.
alter table recovery_checkouts add column if not exists started_at timestamptz;
alter table recovery_checkouts add column if not exists start_count integer not null default 0;
