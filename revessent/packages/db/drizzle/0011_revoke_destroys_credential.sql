-- Phase 4A final-audit correction: credential lifecycle on revocation.
-- A revoked/disconnected connection keeps only SAFE metadata (last4, account
-- id, display name, timestamps) for history and audit; the sealed key
-- material is destroyed so the credential is cryptographically unusable by
-- any future provider operation. Forward migration only — no history edited.
alter table "stripe_connections" alter column "key_ciphertext" drop not null;
