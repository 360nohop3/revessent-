-- PHASE 4D FINAL CORRECTION: automated attempt identity (J2 rv:{org}:{case}:{n})
-- must use the AUTOMATED retry sequence — manual attempts never increment it.
-- The durable attempt row itself is the source of truth: attempt_no is
-- persisted per automated attempt and made unique per case at the database
-- level, so two concurrent automated reservations can never receive the same
-- automated attempt number (partial unique index; manual rows are outside it).
alter table recovery_attempts add column attempt_no integer;
-- Backfill from the already-durable J2 keys (auto rows only; manual rows stay null).
update recovery_attempts
   set attempt_no = split_part(idempotency_key, ':', 4)::int
 where kind = 'auto_retry'
   and idempotency_key ~ '^rv:[^:]+:[^:]+:[0-9]+$';
create unique index recovery_attempts_case_auto_no_uq
  on recovery_attempts (case_id, attempt_no)
  where kind = 'auto_retry' and attempt_no is not null;
comment on column recovery_attempts.attempt_no is 'sequential AUTOMATED retry attempt number for the recovery case (J2 key suffix); null for manual executions — manual attempts never consume the automated sequence (Phase 4D correction)';
