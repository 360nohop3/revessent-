# Phase 4C Implementation Map (pre-edit audit summary)

## Operation (from architecture, not invented)
J2 (§88): "retry job executes via Stripe API (idempotency key `rv:{org}:{case}:{attempt}`)".
Phase 4C implements exactly this as an EXPLICIT operator command (workers remain forbidden):
**manual retry of a failed invoice payment via Stripe `invoices.pay`**, recorded in the
architecture's own execution models:
- `recovery_attempts` — the durable execution record (already has `idempotency_key UNIQUE`,
  `kind='manual_retry'`, `actor`, `executed_at`, `status`, `decline_code`)
- `payment_attempts` — "every Stripe attempt we make" (source `revessent_retry`)
- the existing honest 501 `recovery.requestRetry` is replaced by the real execution.
RBAC §7.3: `operate` is defined as "manual retry" — operator+.

## Execution state machine (recovery_attempts.status mapping)
scheduled (=created) → executing → succeeded | failed | unknown → (reconciled_at set when
provider truth established). 0017 adds the missing columns:
org_id, payment_id, amount_cents, currency, stripe_connection_id,
provider_payment_intent_id, request_hash, error_code, outcome_category,
retry_classification, provider_meta, reconciled_at; uniqueness becomes (org_id, idempotency_key);
RLS policy simplified to direct org match.

## Idempotency (two layers)
- DB: unique (org_id, idempotency_key); server default key `rv:{orgId}:{caseId}:{nextSeq}`
  (deterministic per case); conflict detection via request_hash over
  payment|amount|currency|operation → same = return existing execution, different = 409.
- Provider: `rv:{orgId}:{executionId}` (derived from the durable execution UUID, never exposed).

## Files
- db: 0017_payment_execution.sql + schema parity
- integrations: gateway += payInvoice/getInvoicePaymentStatus; stripe-client impls
  (StripeCardError → extended codes); errors += payment-outcome codes; fixtures += pay fakes
  (failure plans incl. succeed-then-network-loss, idempotency replay, world mutation to paid)
- server: NEW services/execute.ts (executeManualRetry, reconcileExecutions wired into
  reconcileFromProvider); recovery.ts delegates the old 501
- api: existing retry route becomes real execution route (operate RBAC)
- contracts: RecoveryExecution DTO + api.recovery.executeRetry; mock = honest not-available
- web: recovery-detail-view minimal execute affordance (amount/currency/customer explicit,
  no double submit, pending/unknown distinct from failed/declined)

## Truth / hard cases
- amounts come ONLY from the local payments row (integer > 0, explicit currency) — request
  carries only case id + optional idempotency key (nothing financial from the browser).
- success → immediate persist via shared 4A appliers; webhooks stay authoritative.
- network loss after send → status 'unknown', retry_classification 'never', recoverable by
  reconcileExecutions (direct read-only provider status check establishes safety before any
  new operation). No blind re-execution. No BullMQ/Redis/workers anywhere.
