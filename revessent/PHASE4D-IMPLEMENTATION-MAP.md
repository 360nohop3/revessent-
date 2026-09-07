# PHASE 4D — IMPLEMENTATION MAP (pre-edit audit, written before any code)

## A. What the architecture assigns to automated retries (audit result)

From `REVESSENT-Architecture-v1.md`:

- **§5.2 / DDL**: `recovery_attempts.kind` includes **`auto_retry`** with `status ∈ scheduled|executing|succeeded|failed|unknown|skipped|canceled`, `scheduled_at`, `idempotency_key` (unique per org since 0017), `error_code`, `outcome_category`, `retry_classification`, `reconciled_at`. `recovery_cases` carries `next_action_at` ("what the retry scheduler reads"), `attempt_no`, `retry_policy_version` (snapshot ref §8.4), `closed_reason`, `recovered_cents`. `retry_policies` = versioned per-org `rules` jsonb. `recovery_attributions` = unique(payment_id) guarantee ledger.
- **§J2 / §J**: retry executes **via the Stripe API** with idempotency key `rv:{org}:{case}:{attempt}`; success path: invoice.paid webhook → case=recovered → attribution row (source=retry). Decline branches (note/checkout) are LATER phases (AI/email = Phase 6+) — Phase 4D does NOT add messaging.
- **§5.3 recovery state machine (normative)**: detected→analyzing→retrying→recovered; retrying→contacting→recovered; →checkout→recovered; (any)→canceled; (any, **policy exhausted or 90d window over**)→**lost**. Guards: (1) one active case per failed payment; (2) recovered requires payments.status='paid' + exactly one attribution; (3) note gating (not 4D); **(4) NO retry executes when now() < next_action_at or case.status ∉ {retrying, contacting}** (job-time re-check kills stale/duplicate jobs); (5) terminal states never transition.
- **§8.4 policy engine**: versioned rules — `max_auto_retries` (demo/seed: 3; architecture example: 4), `per_decline` routing (insufficient_funds retries 4; expired_card retries 1 (token-first); do_not_honor/issuer retries 3 (spread); hard_decline no_retry), `timing.min_gap_hours` (24 arch; 48 in the seeded demo policy). Policy edits create NEW versions; running cases keep their snapshot — no retroactive behavior change.
- **§8.7 decline taxonomy default routes**: insufficient_funds → payday-aware retries; expired_card → token-first retry (1); transient → quick backoff retries; issuer_decline → spread retries; credential → **no retry**; hard → no outreach at all (case dismissed); balance → no retries.
- **§9.1/§9.2**: WHEN to retry = deterministic rules (LLM never decides to charge); timing model v1 = interpretable heuristics, deterministic, unit-testable. The per-member "best hour" histogram is the Phase 5 timing engine — 4D uses policy backoff only, no invented "smart hour".
- **§10**: BullMQ/Redis/workers are the DELIVERY mechanism of a later phase. Phase 4D brief §18: `runDueRetries()` as a deterministic server-side primitive only — no background process.
- **RBAC §7.3**: `operate` = manual retry. Automated execution is system-authorized but never exposed unauthenticated (brief §19).

**Not Phase 4D (from architecture + brief):** note drafting/sending, checkout, payment-hour histograms, AI anything, attribution dashboards, BullMQ queues, refund/capture, payment-method mutation.

## B. Design (smallest architecture-consistent build)

1. **Eligibility (pure, deterministic)** — `packages/domain/src/retry.ts`: `evaluateRetryEligibility(facts, policy, now)` → `{ verdict: eligible|waiting|blocked|exhausted|disabled, reason, nextEligibleAt? }`. Considers: case status (guard #4), payment status, connection active, local financial validity (invoice/amount/currency/customer present), auto-retry count vs policy max, per-category retryability + per-category cap, last outcome classification ('later' retryable / 'never' terminal / unknown blocks), unresolved executions (executing|unknown ⇒ blocked — §13), backoff elapsed (now ≥ nextEligibleAt), give-up window (90d). NO provider I/O — provider truth is enforced at execution time by the 4C boundary (preflight + post-lock revalidation).
2. **Retryable categories (default policy, from §8.4/§8.7 + 4C taxonomy)**: `rate_limited` ('later'); `transient_network`/`provider_outage` ONLY when provably pre-execution (classification 'later' — a lost-response becomes `unknown`, never retryable); `insufficient_funds` (≤4), `expired_card` (≤1), `card_declined`/issuer-generic (≤3, 'spread'). **Never**: `authentication_required`, `payment_method_failure`, `invalid_payment_context`, `unsupported_provider_state`, `idempotency_conflict`, `invalid_credentials`, `revoked`, `auth_failure`, `permission_failure`, any preflight financial mismatch (customer/currency/amount/already-paid/void), unresolved `unknown`, exhausted counts, non-'failed' payment, terminal/closed cases, inactive connection. Per-category caps default from §8.4/§8.7.
3. **Policy as data**: `retry_policies.rules` (already jsonb, versioned) gains an OPTIONAL `autoRetry` section (zod-validated in contracts, backward compatible): `{ perCategory: { [code]: { retryable, maxAttempts } }, backoffMultiplier, maxBackoffHours }`. Missing section → `DEFAULT_AUTO_RETRY_POLICY` (architecture defaults). Case snapshot = `retry_policy_version` → policy row of that version.
4. **Backoff**: `delayHours(n) = min(minGapHours × multiplier^(n−1), maxBackoffHours)` — integer math, exponent capped, deterministic (§17). `next_action_at = outcome time + delay(next attempt no)`. Demo policy minGapHours=48, multiplier 2, cap 168h.
5. **Durable attempt (§8/§9)**: under the **payment advisory lock** (`revessent:payment-exec` — the 4C lock, §10 reuse), attempt no = (count of case attempts)+1, key = `rv:{org}:{case}:{n}` (same sequence as manual — architecture format). INSERT kind='auto_retry' actor='system' status='scheduled' policy_version=case snapshot; unique(org,key) is the DB backstop: conflict → re-read → same attempt (never two). 0018 adds `policy_version int` to recovery_attempts (forward-only).
6. **Execution (§3/§11/§12)**: the 4C primitive is REFACTORED, not duplicated: `executePaymentAttempt(ctx, caseId, { idempotencyKey?, initiation })` — `manual` requires `can(role,'operate')`; `automated` is callable ONLY from the retry service (no HTTP route reaches it) and re-walks the identical authority chain + preflight + lock + post-lock revalidation + provider idempotency. Zero duplicated safety logic.
7. **runDueRetries (§18)**: `retryService.runDueRetries(ctx, { now?, caseId? })` — operate-gated; per eligible case: eligibility → lock → re-evaluate under lock (concurrency-safe numbering + max-attempt + unknown-block re-checks) → reserve → execute via the shared core → persist outcome (core) → update case (`attempt_no`, `next_action_at`) → guarded transitions: payment paid ⇒ case `recovered` (+ attribution if none, source 'retry' — guard #2); exhausted ⇒ case `lost` (closed_reason 'retries_exhausted') — guard #4/#5 respected. Audits: `retry.scheduled`, `retry.executed`, `retry.failed`, `retry.blocked`, `retry.exhausted` (actor = initiating user; attempt row actor='system'). No route, no worker, no cron.
8. **Crash recovery (§14/§20)**: reserved-but-dead ⇒ `scheduled` row re-picked next run (same identity); died-after-mark ⇒ `executing` + reconcileExecutions resolves (4C); Stripe-accepted-then-died ⇒ same, provider key stable from execution id; unknown ⇒ blocks eligibility until reconciled.
9. **DTO/UI (§23)**: `RecoveryCaseSchema` += `retry: { autoAttempts, maxAutoRetries, state, reason, nextEligibleAt, reconciliationRequired }` computed server-side from the pure eligibility function. Minimal line in the case view. Mock: honest static demo values.

## C. File plan

| File | Change |
|---|---|
| `packages/domain/src/retry.ts` | NEW — eligibility + backoff + default policy (pure) |
| `packages/domain/src/index.ts` | export |
| `packages/contracts/src/schemas.ts` | RetryPolicySchema += optional autoRetry; RecoveryCaseSchema += retry state |
| `packages/contracts/src/mock/mockApi.ts` | retry state on demo case(s) |
| `packages/db/drizzle/0018_retry_policy_version.sql` | NEW — recovery_attempts.policy_version |
| `packages/db/src/schema.ts` / `seed.ts` | parity |
| `packages/server/src/services/execute.ts` | refactor: shared core + initiation param (behavior-preserving for manual) |
| `packages/server/src/services/retry.ts` | NEW — policy resolution, runDueRetries, guarded case transitions, audits |
| `packages/server/src/services/recovery.ts` | case DTO += retry state |
| `packages/server/src/index.ts` | export retryService |
| `apps/web/src/views/recovery-detail-view.tsx` | minimal automated-retry status line |
| `packages/server/test/retry-automation.test.ts` + `packages/domain/test/retry-eligibility.test.ts` | NEW tests |

## D. Test matrix → brief §24 (all categories, limits, races, unknown, crash, backoff, authz)
