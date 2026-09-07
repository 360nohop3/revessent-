-- PHASE 6: AI-assisted recovery communication — durable email state.
-- Extends recovery_messages (Phase 3 approval draft) into the durable
-- communication record: deterministic identity, application-controlled
-- recipient, send lifecycle, fallback provenance and the authoritative fact
-- snapshot used for interpolation. No new tables; RLS (org_isolation, 0001)
-- and the app-role DML grant already cover recovery_messages/ai_generations.
--
-- Rules decide WHETHER/WHEN money is recovered (Phase 4C/4D). AI decides only
-- HOW the recovery is described — downstream, schema-validated, replaceable by
-- a deterministic template at any point. Nothing here influences a payment.
alter table recovery_messages
  add column purpose text,                                   -- dunning_note | final_notice
  add column lifecycle_trigger text,                         -- retry_failed | case_lost
  add column trigger_ref text,                               -- e.g. auto attempt_no that fired the trigger
  add column dedupe_key text,                                -- comm:{org}:{case}:{purpose} — logical identity
  add column recipient_email text,                           -- application-resolved; never model-controlled
  add column send_status text not null default 'pending',    -- pending|sending|sent|failed|suppressed|unknown
  add column send_after timestamptz,                         -- deterministic timing (quiet hours / cooldown)
  add column send_attempts integer not null default 0,       -- infrastructure attempts (provider calls made)
  add column send_claimed_at timestamptz,                    -- claim boundary for concurrent deliveries
  add column last_send_error_code text,                      -- safe code only — never provider bodies
  add column suppressed_reason text,                         -- why a claimed message was not sent
  add column generation_source text,                         -- ai | fallback
  add column fallback_reason text,                           -- ai_timeout | ai_invalid_output | ai_prohibited_content | ai_unavailable | ai_disabled | ...
  add column fact_snapshot jsonb,                            -- authoritative facts used for interpolation (no secrets)
  add column auto_approved boolean not null default false,   -- policy (trust_level) approval; approved_by stays a user id
  add column updated_at timestamptz not null default now();
-- One logical communication per identity, enforced by the database: duplicate
-- prepare jobs (redelivery, concurrent schedulers, Redis reconstruction)
-- cannot create a second email for the same case + purpose.
create unique index recovery_messages_dedupe_uq
  on recovery_messages (dedupe_key)
  where dedupe_key is not null;
-- Delivery discovery: approved, pending messages whose send time has come.
create index recovery_messages_send_due_idx
  on recovery_messages (org_id, send_status, send_after);
