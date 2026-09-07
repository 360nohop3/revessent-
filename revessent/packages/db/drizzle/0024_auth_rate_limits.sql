-- PHASE 8 — durable auth rate limiting (§7.1: 5 attempts / 15 min / IP+email).
-- The Phase 3 limiter was per-process memory; on a multi-instance web tier it
-- protects nothing. This table is a shared fixed-window counter. Keys are
-- SHA-256 hashes of bucket:ip:email — no IP or address is stored in clear.
-- Not tenant data (pre-authentication), so no org_id / RLS; the app role gets
-- DML through the 0001 default privileges. Rows are tiny and self-expiring
-- (window_start is reset in place; a periodic delete of stale rows is safe).
create table if not exists auth_rate_limits (
  key_hash     text primary key,
  window_start timestamptz not null default now(),
  hits         integer not null default 1
);
--> statement-breakpoint
create index if not exists auth_rate_limits_window_idx on auth_rate_limits (window_start);
--> statement-breakpoint
grant select, insert, update, delete on auth_rate_limits to revessent_app;
