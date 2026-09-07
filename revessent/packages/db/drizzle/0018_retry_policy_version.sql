-- PHASE 4D: automated retries carry the policy snapshot that authorized them
-- (architecture §8.4: running cases/attempt records keep their version — no
-- retroactive behavior change, the guarantee audit trail requires it).
alter table recovery_attempts add column policy_version integer;
comment on column recovery_attempts.policy_version is 'retry_policies.version snapshot authorizing an automated attempt (Phase 4D); null for manual executions';
