# REVESSENT — Phase 4D Report

## Automated Retries & Recovery Execution (Architecture v1 §8.4 policy / §8.7 taxonomy / §9.1 timing / J2 execution identity / brief §2–§29)

Phase 4D adds the missing decision layer on top of the Phase 4C payment primitive: **when a failed payment is eligible for another attempt, when it must never be retried, how retry state is persisted, and how an authorized automated retry is executed without double charging or retrying an unsafe outcome.**

**This report describes the FINAL, post-correction implementation.** The external review of the first delivery found an attempt-identity/limit inconsistency (mixed manual/automated numbering); it was corrected and re-verified — see **Final Correction Status** below and the historical addendum at the end. Everything here was verified from source and executed runs; nothing is claimed from prior reports.

---

## §A. What was implemented

1. **One deterministic eligibility function** (`packages/domain/src/retry.ts` — pure, no I/O): `evaluateRetryEligibility(facts, policy)` with a fixed gate order:
   `case_terminal → connection_inactive → case_not_retryable → payment_already_paid → payment_not_retryable → no_provider_invoice → amount_unknown → currency_unknown → customer_unmapped → unresolved_execution_reconcile_first → automation_disabled → max_auto_retries → give_up_after_days → outcome_not_retryable:{category} → category_exhausted:{category} → resume_scheduled_attempt → backoff(waiting) → eligible.`
   No scattered conditionals, no UI-text inference anywhere in the codebase (§4).
2. **Policy as data (§7) with the rule as the single retryability authority (fail-closed)**: `AutoRetryPolicySchema` in contracts — `perCategory: { retryable, maxAttempts 0–8 }`, `backoffMultiplier 1–4?`, `maxBackoffHours 1–720?`; `RetryPolicySchema.autoRetry?`. Server fallback merges partial rules over `DEFAULT_AUTO_RETRY_POLICY` (insufficient_funds 4, expired_card 1, card_declined 3, rate_limited 4, transient_network 4, provider_outage 4; multiplier 2; max 168h). Routing (verbatim gate): a category with **no policy rule, or `retryable=false`, is blocked — `outcome_not_retryable:{category}`**; `retryable=true` proceeds subject to the limits and all other gates. The pre-correction taxonomy-`classification` bypass **no longer exists** (`RetryFacts.lastOutcome` carries the category only). No category limit is ever invented.
3. **Two ceilings, both enforced; effective limit = min(global, category)**: global `policy.maxAutoRetries` (breach ⇒ `exhausted` / `max_auto_retries`) and category `perCategory[category].maxAttempts` (breach ⇒ `category_exhausted:{category}`). An automated retry is eligible only if BOTH permit another attempt.
4. **Deterministic backoff (§17)**: `min(minGapHours × 2^exp, maxBackoffHours)` with exp capped at 16 (no overflow). Measured with minGap 48h: 48 → 96 → 168 → 168 (capped). A fresh case with no prior automated execution waits `firstFailedAt + minGap`. Operational timestamps only — never financial.
5. **Durable attempt records (§8) with the AUTOMATED attempt number persisted (migration 0019)**: `recovery_attempts` rows carry org, case, payment, kind (`manual_retry` | `auto_retry`), **`attempt_no` — the sequential AUTOMATED retry attempt number for the case (null for manual rows)**, policy_version snapshot (migration 0018), request hash, idempotency key (`rv:{org}:{case}:{attempt}` for automated rows, J2), scheduled vs actual times, outcome, provider operation identity, failure reason, timestamps. DB-enforced guarantees: unique `(org, idempotency_key)` (0017) AND the partial unique index `recovery_attempts_case_auto_no_uq (case_id, attempt_no) WHERE kind='auto_retry' AND attempt_no IS NOT NULL` (0019) — *the same logical retry attempt cannot execute twice* and *two concurrent automated reservations of one case cannot receive the same number* are database guarantees, not application `if`s.
6. **Attempt identity semantics (final)**:
   - **Automated**: `attempt_no` = the sequential automated retry attempt number for that recovery case. Allocation derives from the durable rows — `max(persisted auto attempt_no) + 1` — computed **inside the payment advisory lock** (no drifting application counter; the durable attempt row is the source of truth). The J2 key for an automated attempt is `rv:{org}:{case}:{attempt_no}`.
   - **Manual**: rows remain durable and visible (`kind = manual_retry`, `attempt_no NULL` — outside the automated sequence and outside the partial unique index). A manual execution **without a supplied client key** defaults to **`rv:{org}:{case}:m{seq}`** — a sub-sequence counted over MANUAL rows only (verbatim: `` `rv:${ctx.org.id}:${caseId}:m${(countRow?.n ?? 0) + 1}` ``) — so it never occupies or collides with the automated number space. Manual and automated attempts do **not** share one sequence, and manual attempts never advance the automated one.
   - **Resume (crash recovery)**: a `scheduled` auto attempt is resumed with its exact row, its persisted number and its original key — no new number, no new identity, no second provider operation.
7. **Retry budgets count automated attempts only (§7)**: `autoRetryCount` = executed (`status ≠ scheduled`) `auto_retry` attempts; `categoryAttemptCounts[category]` = executed **automated** attempts per outcome category. Scheduled (merely reserved) rows are not counted; **manual attempts consume neither budget**. Identical semantics in `gatherFacts` (retry decisions) and `retryStateOf` (case DTO).
8. **Outcome routing uses payment outcomes, and fails closed on the first decision**: the routing category is the latest executed attempt's payment-outcome category; **when no prior executed payment outcome exists, the payment's own decline category (`case.declineCategory` / the payment record) is the available payment-outcome fact** — so an unlisted or non-retryable category is refused before any attempt is spent.
9. **`no_provider_operation` is an execution-RESOLUTION result, not a payment outcome**: when reconciliation proves no provider operation exists (4C: "a NEW execution is now provably safe"), that code never occupies a policy category bucket — routing resolves back to the payment's decline category, preserving Phase 4C's ability to re-execute safely.
10. **Controlled retry execution (§10–§12)**: `runDueRetries(ctx, { caseId?, now? })` — a deterministic server-side primitive (**no workers, no cron, no Redis, §18**) that (a) re-evaluates eligibility from local records, (b) audits blocked decisions, (c) reserves the attempt (persisted number + key) under the payment advisory lock, then (d) calls the **one and only** Phase 4C primitive `executePaymentAttempt` with the reserved identity. Manual and automated share the same preflight, the same gates, the same lock, the same idempotency, the same webhook/reconcile convergence — there is **no second payment execution implementation** (§3, §11).
11. **Crash-safe identity (§14, §20)**: a crash before execution leaves the row `scheduled`; the next run **resumes the same row, number and key** (test-proven). A crash after Stripe accepts (response lost) lands as `unknown` → **hard block on retry** until reconciliation resolves it (§13). Reconciliation to `paid` converges the case to `recovered` via `markCaseRecovered`; to a definitive failure re-opens the backoff schedule.
12. **Give-up semantics (§5, §16)**: max attempts are DB-backed; exhausted ⇒ case `lost` (`closed_reason max_auto_retries`) + audit + **zero Stripe calls on further runs** and **no new durable identity**; the concurrent final-attempt race admits exactly one winner. The 21-day `GIVE_UP_AFTER_DAYS` gate blocks retries for stale cases.
13. **Auditability (§22)**: `retry.scheduled | retry.executed | retry.failed | retry.exhausted | retry.outcome_unknown | retry.skipped | retry.blocked | retry.resumed` — eligible **and** blocked decisions are audited; actor `system` for automation; payloads carry only codes/counts/policy versions (never provider error bodies or secrets).
14. **Minimal read-side (§23)**: `RecoveryCaseSchema.retry` (required) exposes exactly: auto attempt count, max auto retries, state ∈ `eligible | waiting | blocked | exhausted | disabled`, machine reason, `nextEligibleAt | null`, `reconciliationRequired`. Rendered in the recovery detail view as one honest line (`data-testid="retry-state"`). Demo mock data carries six truthful retry states. **No customer messaging exists.**

## §B. Execution flow (exact)

```
runDueRetries(ctx, { caseId?, now? })
  ├─ resolvePolicy(org)            retry_policies latest (or case snapshot version); defaults merged
  ├─ load candidate cases          status retrying|contacting AND payment failed (org-scoped tx)
  ├─ evaluateRetryEligibility()    PURE function, local facts only (§4); routing falls back to
  │                                the payment's decline category when no executed outcome exists
  │    blocked ⇒ audit retry.blocked, continue            (§22: blocked is audited)
  │    resume scheduled ⇒ adopt the EXISTING attempt row  (§20: same row, number, key)
  ├─ RESERVE (inside withPgAdvisoryLock("revessent:payment-exec", payment.id)):
  │    re-evaluate under the lock
  │    attemptNo = max(persisted auto_retry attempt_no for the case) + 1   ← from DURABLE rows,
  │      not an application counter; manual rows excluded (0019 semantics)
  │    insert reserved row (kind auto_retry, actor "system", key rv:{org}:{case}:{n}, attempt_no n)
  │      DB backstops: unique (org, idempotency_key) AND partial unique (case_id, attempt_no):
  │      conflict ⇒ adopt the scheduled row (resume) | resolved ⇒ blocked attempt_already_resolved
  │    !acquired lock ⇒ blocked payment_execution_in_progress
  ├─ executeAutomatedRetry(ctx, caseId, { idempotencyKey: reserved key, policyVersion })
  │    = the 4C primitive: replay-before-gates → local state → Stripe invoice preflight
  │      (customer/currency/amount equality; payable whitelist) → advisory lock →
  │      post-lock re-read (local + provider) → payInvoice (ONE provider op) →
  │      finalize; webhook/reconcile truth wins
  └─ post-execution: durable row status ⇒
       succeeded ⇒ audit retry.executed; markCaseRecovered (attribution source "retry")
       failed    ⇒ nextActionAt = now + backoffDelayHours(...); audit retry.failed | retry.exhausted
       unknown   ⇒ nextActionAt = NULL (blocked until reconcile); audit retry.outcome_unknown
       skipped   ⇒ audit retry.skipped (safe code; zero provider ops)
```

Every boundary is honest: the reservation is durable *before* any provider call; the primitive persists terminal/unknown state before throwing; a lost response is read back from the durable row, never fabricated.

## §C. Migrations (forward-only, deterministic from empty DB)

Two Phase 4D migrations; 0000–0017 byte-identical.

- **`0018_retry_policy_version.sql`** — `alter table recovery_attempts add column policy_version integer` + column comment: the retry_policies.version snapshot authorizing an automated attempt (null for manual executions).
- **`0019_recovery_attempt_number.sql`** — the final-correction migration:
  - `alter table recovery_attempts add column attempt_no integer` — **durable, per-case sequential AUTOMATED attempt number**, persisted on the attempt row itself (the row is the source of truth);
  - **backfills existing automated attempts** from the already-durable J2 keys (`split_part(idempotency_key, ':', 4)::int`, `kind='auto_retry'` and key-shape guarded; manual rows stay `NULL`);
  - **partial unique index `recovery_attempts_case_auto_no_uq (case_id, attempt_no) WHERE kind='auto_retry' AND attempt_no IS NOT NULL`** — no two automated attempts of one case can ever hold the same number, even bypassing the application; manual rows are outside the index;
  - column comment states the semantics verbatim: *"sequential AUTOMATED retry attempt number for the recovery case (J2 key suffix); null for manual executions — manual attempts never consume the automated sequence"*.

**Verified (all re-run after the correction, on the restored toolchain):**

- **Fresh bootstrap**: empty database → `drizzle-kit migrate` → **20/20 migrations applied**; `attempt_no`, `policy_version`, the partial unique index and `recovery_attempts_org_key_uq (org_id, idempotency_key)` all present.
- **Upgrade from Phase 4C**: database rebuilt at exactly the 4C state (0000–0017 + journal rows restored verbatim) → migrate → **18→20**, applying exactly 0018 + 0019.
- **Upgrade from the first 4D review state (0000–0018)**: → migrate → **19→20**, applying exactly 0019.
- RLS enabled + org policies on `recovery_attempts`, `retry_policies`, `recovery_cases`, `recovery_attributions`; `recovery_attributions_payment_uq (payment_id)` present.

## §D. Final test numbers (exact — all suites re-run after the correction)

| Suite | Result |
|---|---|
| `packages/domain/test/retry-eligibility.test.ts` (gates, rule-authority routing ×18 + fail-closed cases, min(global,category) both directions, backoff curve incl. cap, give-up, resume, unknown boundaries) | **40/40** |
| `packages/server/test/retry-automation.test.ts` (full 4D integration matrix) | **21/21** |
| `packages/server/test/retry-identity.test.ts` (NEW — correction matrix: identity, concurrency, limits, counts, regression anchors) | **22/22** |
| `packages/server/test/payment-execution.test.ts` (4C regression, assertions unchanged) | **52/52** |
| **Full monorepo vitest** | **333/333 (34 files)** — includes 4A/4B regressions |
| tsc `--noEmit` (contracts, domain, db, server, web) | **5/5 OK** |
| eslint (contracts, domain, db, server, web) | **5/5 OK** |
| `next build` (`NEXT_PUBLIC_DEMO_MODE=off --webpack`) | **OK — BUILD_ID `k37dNyPYJ2gHAo2NV0RZm`** |
| Runtime probes | home **200**; unauth org API **401**; unauth retry POST **401**; cross-origin POST **403** (CSRF) |

**retry-identity coverage (22 tests — the correction matrix):** identity (no manual attempts → auto `#1`; two manual executions → first automated attempt is STILL `#1` with `attempt_no` NULL on manual rows; manual + auto + manual → next auto `#2`; identities sequential and stable; scheduled attempt resumed with same row/number/key and exactly one provider op). Concurrency (concurrent first-auto reservations → exactly one `#1`; concurrent second-auto → gapless `[1, 2]`; raw same-number inserts without any application lock → `WIN, UNIQUE_CONFLICT, UNIQUE_CONFLICT`, exactly 1 row — the DB backstop proven directly). Limits (global 2 / category 4 → exactly 2, then `lost`, zero ops; global 4 / category 2 → exactly 2, then `category_exhausted:insufficient_funds`; global `maxAutoRetries` 0 → `automation_disabled`, zero rows/ops; `retryable=false` → refused on the FIRST decision with zero rows/ops; category absent → fail closed `outcome_not_retryable:processing_error`; an exhausted case never gains a new durable identity; concurrent final-attempt race → ≤ 1 winner). Counts & regression anchors (a scheduled row is not counted as executed; unknown still blocks; duplicate run never executes twice; cross-org runner finds zero candidates; manual rows sequence-neutral; behavioral proof that mixed `attempts.length + 1` numbering is gone).

**retry-automation coverage (21 tests):** happy path (durable `scheduled→succeeded`, key `rv:{org}:{case}:1`, actor `system`, policy version 1, exactly one provider op, case `recovered`, attribution source `retry`); declined outcome recorded + backoff scheduled + rerun within gap refused with still one provider op; exhaustion (`max_auto_retries` lost + rerun performs zero ops); concurrent final-attempt race (exactly one executes); auto×auto and manual×auto concurrency (≤1 provider op); provider changes between eligibility and execution (paid / void / amount / currency / customer / unsupported ⇒ skipped + safe code + zero pay ops); `network_loss_after_success` ⇒ unknown, retry blocked, reconcile→paid→recovered, no retry; `ambiguous` ⇒ reconcile `no_provider_operation` ⇒ backdated ⇒ rerun executes; reserved-then-died resumed with the SAME row and key; duplicate run returns the same execution with no second op; viewer role 403; cross-org caseId ⇒ zero candidates; disconnected Stripe ⇒ `disabled` / `connection_inactive`; getCase retry DTO `{ autoAttempts, maxAutoRetries, state, reason }`.

## §E. Authority chain + provider security details

- **Stripe remains the only financial authority.** Automation adds *decision* logic; it never adds a second way to move money. The 4C invariants are intact and regression-tested: amount/currency resolved from local records only; explicit payable invoice whitelist with no defaults; replay-before-gates; post-lock local+provider re-read under the payment lock; unknown ≠ failed; webhook truth wins; different-key concurrent ops ≤ 1.
- **Authorization (§19):** automated runs are system-authorized but still organization-owned — every query runs inside an org-scoped transaction; a cross-org `caseId` yields zero candidates (test-proven). Manual execution keeps `operate` RBAC. **No unauthenticated or public retry-execution endpoint exists** (route inventory audited; `runDueRetries` is service-only).
- **Policy versioning:** every automated attempt snapshots the authorizing `retry_policies.version` (0018); a policy edit never retroactively rewrites the authorization of in-flight attempts.
- **Numbering security:** the automated sequence lives in durable rows protected by the partial unique index (0019); even an application bug or a lock bypass cannot produce duplicate automated attempt numbers for one case.

## §F. Idempotency, races, org-crossing (all test-proven)

- Same logical attempt twice ⇒ same execution, one provider op (DB unique + adoption).
- Concurrent auto+auto and manual+auto on one payment ⇒ ≤1 provider operation (shared advisory lock).
- Concurrent automated reservations ⇒ gapless, unique automated numbers (`[1]`, then `[1, 2]`; concurrent final attempt ⇒ exactly one winner) — enforced by the lock AND the `(case_id, attempt_no)` partial unique index (proven with raw concurrent inserts).
- Crash after reservation ⇒ resume same row, same number, same key, no re-creation.
- Crash after provider acceptance ⇒ unknown ⇒ blocked ⇒ reconciliation discovers the payment ⇒ recovered with no duplicate charge; a `no_provider_operation` resolution routes back to the payment's decline category so a provably-safe re-execution remains possible.
- Cross-org ids, viewer roles, inactive connections, unauthenticated calls ⇒ refused at the correct layer.

## §G. Failure semantics

`failed` ⇒ deterministic backoff (48/96/168… capped) with `nextActionAt`; `exhausted` ⇒ `lost` + audit + zero further Stripe calls and no new durable identity; `unknown` ⇒ **no promised next action** (`nextActionAt = null`), retry blocked until reconciliation; provider-side refusals (paid/void/mismatch/unsupported) ⇒ `skipped` with a safe code and zero provider ops, reconciled rather than retried; give-up after 21 days ⇒ blocked.

## §H. Live verification status (the honest boundary)

Automated retries were executed against the **fixture Stripe gateway** in tests. **Live Stripe execution of an automated retry has not been performed in this environment. No live Stripe execution was performed or claimed.** The same live-execution boundary documented in Phase 4C applies unchanged: the execution core is shared, so 4C's live-path evidence (or its absence) transfers exactly. No payment, retry, email, or reconciliation success has been simulated beyond fixtures, and no success is claimed. Verification classes are kept distinct throughout: local/fixture test verification, database/migration verification (fresh bootstrap, both upgrade paths, RLS, uniqueness), HTTP/security probes — and live Stripe verification, which does not exist in this environment.

**Operational note (verification environment):** the sandbox was rebuilt during the correction turn (toolchain, node_modules and the dev database are excluded from workspace snapshots), so Node/pnpm/dependencies and the development database (migrations + seed) had to be restored before verification. All gate numbers above come from the restored environment and were re-run after the correction.

## §I. Files created / changed (Phase 4D, final state)

**New:** `packages/domain/src/retry.ts`, `packages/domain/test/retry-eligibility.test.ts`, `packages/server/src/services/retry.ts` (new service; re-exports case transitions), `packages/server/test/retry-automation.test.ts`, `packages/server/test/retry-identity.test.ts` (correction matrix), `packages/db/drizzle/0018_retry_policy_version.sql` + `packages/db/drizzle/0019_recovery_attempt_number.sql` (journal idx 18, 19), this report.

**Changed:** `packages/db/src/schema.ts` (`policyVersion`, `attemptNo`), `packages/db/src/seed.ts` (auto_retry seed row valid; lint cleanup), `packages/domain/src/retry.ts` (rule-authority gate; `lastOutcome` carries the category only), `packages/server/src/services/execute.ts` (hosts `markCaseRecovered`/`markCaseLost`; core success + reconcile-success converge the case; explicit-key charset accepts the J2 colon format; manual default key `m{seq}` sub-sequence), `packages/server/src/services/retry.ts` (auto-only numbering from persisted rows under the lock; auto-only counts; decline-category routing fallback incl. `no_provider_operation` handling), `packages/server/src/services/recovery.ts` (`retryStateOf`/`retryStateForList` with the same fact semantics; `loadCases` reads wrapped in org-scoped transactions — **RLS fix, see §J**), `packages/server/src/index.ts` (exports), `packages/contracts/src/schemas.ts` (AutoRetryPolicy schemas, required `retry` block), `packages/contracts/src/mock/store.ts` (6 honest demo retry states), `apps/web/src/views/recovery-detail-view.tsx` (retry-state line), `apps/web/src/app/api/v1/orgs/[slug]/recovery/cases/[caseId]/retry/route.ts` (idempotency-key regex aligned to the core charset — one line).

## §J. Deviations / documented decisions

1. **RLS fix in `loadCases` (real latent bug found by the new tests):** the recovery list/detail queries ran on the raw pool without org scope. Under `revessent_app` (RLS enforced) they return **zero rows**; they only ever worked in dev because the dev server connects as the `postgres` superuser, which bypasses RLS. Fixed by wrapping `loadCases` in `withOrgTx`. Verified: app role sees 0 rows unscoped, its own rows scoped, 0 rows cross-org.
2. **Explicit-key charset widened** from `[A-Za-z0-9_-]` to `[A-Za-z0-9_:.-]` in the execution core and mirrored in the manual route: the architecture's J2 key format `rv:{org}:{case}:{attempt}` contains colons, which the previous charset rejected. Still bounded (8–120), still a fixed whitelist — not a weakening.
3. **Manual default identity `rv:{org}:{case}:m{seq}`** (correction §5): a manual execution without a client key keys itself from a sub-sequence over MANUAL rows only. The previous default (derived from an all-attempts count) mixed initiations and was removed.
4. **`no_provider_operation` routing** (correction §7): an execution-resolution code never occupies a policy category bucket; routing resolves to the payment's decline category, preserving 4C's "provably safe to execute again" semantics.
5. **`runDueRetries` accepts an explicit `now`** for deterministic tests/back-compat; production callers omit it.
6. **Blocked states are audited** (not silent): §22 requires auditability of both eligible and blocked decisions.
7. The 4C self-re-read in the primitive (`status ≠ scheduled ⇒ return it`) doubles as the automated resume path — no new read path was added for automation.

## §K. Security audit (each check backed by an executed assertion or a source audit this session)

1. RBAC bypass — viewer on retry ⇒ 403; manual route `operate`-gated. ✓
2. Arbitrary ids — case/payment/invoice ids resolved server-side under org scope; forged cross-org caseId ⇒ zero candidates. ✓
3. Cross-org retry — org-scoped tx + RLS verified at DB level (unscoped 0 / scoped 1 / cross-org 0). ✓
4. Secret leakage — audits carry codes/counts/versions only; no provider error bodies, no keys (source audit of every 4D audit call). ✓
5. Provider-error leakage — decline taxonomy codes only; raw Stripe errors never persisted. ✓
6. Duplicates — DB unique (org, idempotency_key); 3-way concurrent same-key insert ⇒ 1 row. ✓
7. Races — payment advisory lock shared manual/auto; concurrent final attempt ⇒ 1 winner; concurrent automated reservations ⇒ unique gapless numbers (lock + `(case_id, attempt_no)` partial unique index, both race-tested). ✓
8. Stale state — post-lock local+provider re-read (4C correction-2) inherited unchanged. ✓
9. Unknown → retry — hard-blocked until reconciliation (test-proven both success and failure resolutions). ✓
10. Unsafe endpoints — route inventory: no automated/unauthenticated retry endpoint exists; `runDueRetries` is not HTTP-exposed. ✓
11. CSRF/origin — cross-origin state mutation denied (probe 403). ✓
12. Migrations — forward-only; 0000–0017 untouched; upgrades apply exactly 0018+0019 (18→20) and 0019 (19→20). ✓

## §L. Explicitly NOT in Phase 4D (boundary)

No BullMQ, Redis, workers, cron, scheduled jobs, or any background process (`runDueRetries` is invoked only by tests/future callers). No AI, no email, no customer messaging, no checkout, refunds, captures, subscription changes, payment-method mutation, autonomous policy generation. The retry UI is read-only.

## §M. Gate decision

All 21 completion conditions pass on the final implementation: one eligibility function; policy as data with rule-authority fail-closed routing; durable attempts with persisted, DB-unique automated attempt numbers; concurrency-safe automated numbering (lock + unique index, race-tested); shared single execution primitive; preflight + post-lock re-read on automated paths; unknown ⇒ reconcile-first; crash recovery at every boundary; deterministic backoff; both ceilings enforced (min(global, category)) incl. concurrent final race; no background infra; authorization matrix green; audit coverage of eligible and blocked; minimal read-only DTO; full 333-test regression without weakened assertions; security audit; fresh bootstrap (20/20) + both upgrade paths (18→20, 19→20); tsc 5/5, eslint 5/5, build and probes green; scope-creep grep clean; honest live boundary stated.

Phase 4D is **complete and internally verified**; it is delivered for external review.

«Phase 5 / workers / Redis / AI / email / customer messaging / checkout / refunds / captures / subscription mutations / payment-method mutations / other later functionality has NOT started.»

---

# Final Correction Status

The Phase 4D external review (first delivery: 🟡 CONDITIONAL PASS) identified one design inconsistency and its review surfaced related gaps; all were corrected and re-verified. **The main body above describes the state AFTER these corrections** — the superseded pre-correction behavior is quoted only as history (below and in D1):

1. **Mixed manual/automated attempt numbering** — automated identity originally derived from *all* attempts (`attempts.length + 1`). **Final:** `attempt_no` is the sequential AUTOMATED number, allocated as `max(persisted auto attempt_no) + 1` inside the payment advisory lock, persisted by migration 0019 and unique per case by a partial unique index; manual rows carry `attempt_no NULL`.
2. **Manual attempts consuming automated retry budgets** — counts originally included any executed attempt. **Final:** `autoRetryCount` and `categoryAttemptCounts` count executed AUTOMATED attempts only; scheduled rows and manual attempts never count.
3. **Fail-open routing for absent policy rules** — a "later" taxonomy classification could previously make an unlisted category retryable. **Final:** the policy rule is the sole retryability authority — no rule or `retryable=false` ⇒ blocked; the classification bypass no longer exists; fresh cases route on the payment's decline category, so the first decision already fails closed.
4. **Resolution-code routing for `no_provider_operation`** — reconciliation's "provably no operation was sent" result is an execution-resolution code, not a payment outcome; it never occupies a policy bucket and routing resolves back to the payment's decline category, preserving Phase 4C's safe re-execution path.

The final implementation and every verification number in this report reflect these corrections (333/333; 20/20 migrations; upgrade paths 18→20 and 19→20; build `k37dNyPYJ2gHAo2NV0RZm`).

---

# PHASE 4D FINAL CORRECTION ADDENDUM — Automated Attempt Identity and Limit Semantics (2026-09-06)

> **Historical record.** This addendum documents the review findings and the correction as delivered. It quotes PRE-correction behavior (e.g. `attempts.length + 1`) as findings — those descriptions do NOT describe the current implementation; the main body and Final Correction Status above are authoritative.

External review verdict on the original report: **🟡 CONDITIONAL PASS** with one design inconsistency: automated exhaustion counted only `auto_retry` attempts while automated attempt identity used `all attempts + 1` (manual attempts leaked into the automated sequence). This addendum documents the correction, delivered without rebuilding any preserved layer.

## D1. Discovered inconsistency (and two adjacent gaps found while fixing it)

1. **Numbering mixed initiations** (`retry.ts` reservation): `attemptNo = fresh.attempts.length + 1` counted manual, automated and scheduled rows together, while `autoRetryCount` (limits) counted automated rows only — the same "attempt number" had two different meanings.
2. **Category counts mixed initiations**: `categoryAttemptCounts` was built from executed attempts of ANY kind, so a MANUAL attempt consumed the AUTOMATED category budget.
3. **Fail-open routing (pre-existing)**: a category with NO policy rule but a "later" taxonomy classification passed the outcome gate — automation would retry an unlisted category. Also, a fresh case (no executed attempts) never consulted the payment's decline category at all, so the first decision could not fail closed.

## D2. Final automated attempt identity semantics (correction §2, §4, §5)

- `attemptNo` (and the `attempt` component of the J2 key `rv:{org}:{case}:{attempt}`) **means: the sequential AUTOMATED retry attempt number for the recovery case.** Manual attempts are outside the sequence entirely.
- The number is **derived from the durable rows**: `max(attempt_no of the case's auto_retry rows) + 1`, computed **inside the payment advisory lock** — not an application counter. Migration **0019** persists `recovery_attempts.attempt_no` (backfilled from existing J2 keys) and enforces a **partial unique index `(case_id, attempt_no) WHERE kind='auto_retry' AND attempt_no IS NOT NULL`** — the durable attempt row is the source of truth and duplicate automated numbers are impossible at the database level.
- **Manual executions**: rows remain durable and visible (`kind = manual_retry`, `attempt_no NULL`). A manual execution without a client key now defaults to `rv:{org}:{case}:m{seq}` — a sub-sequence over MANUAL rows only — so it can never occupy or collide with the automated number space (the previous default derived from the all-attempts count; removed per §11).
- **Resume**: a `scheduled` auto attempt is resumed with its exact row, its persisted number and its original key — no new number, no new identity, no second provider operation.
- The `recovery_cases.attempt_no` column mirrors the automated sequence only (written exclusively by the automated reservation path; verified manual execution never writes it).

## D3. Global/category limit semantics (correction §6, §7, §8)

- The perCategory rule is the **single retryability authority**: no rule, or `retryable=false` ⇒ `outcome_not_retryable:{category}` — fail closed, no invented limits. The old taxonomy-classification bypass was removed (`lastOutcome.classification` no longer exists in `RetryFacts`).
- Eligibility requires **BOTH** ceilings to permit another attempt: `max_auto_retries` (global, `exhausted`) and `category_exhausted:{category}` (category). Effective limit = `min(policy.maxAutoRetries, rule.maxAttempts)`.
- Routing consults the **latest executed attempt's payment-outcome category**, or — before any automated attempt exists, or when the last resolved as `no_provider_operation` (an execution-RESOLUTION code, not a payment outcome; 4C: "a new execution is now provably safe") — the **case payment's own decline category**. Unlisted/non-retryable categories therefore fail closed on the FIRST decision, before any attempt is spent.
- Counts: `autoRetryCount` = executed (`status ≠ scheduled`) **automated** attempts; `categoryAttemptCounts` = executed **automated** attempts per outcome category. Scheduled rows are never counted; manual rows never counted. These semantics are identical in `gatherFacts` (retry decisions) and `retryStateOf` (case DTO).

## D4. Concurrency proof (correction §3)

Three independent layers, each proven: (1) allocation happens inside the Phase 4C payment advisory lock, serializing all automated reservations per payment; (2) unique `(org, idempotency_key)` index — the J2 key embeds the number, so a duplicate number cannot produce two rows; (3) NEW partial unique index `(case_id, attempt_no)` — verified with three raw concurrent inserts of the same number (distinct keys, no application lock): `WIN, UNIQUE_CONFLICT, UNIQUE_CONFLICT`, exactly 1 row. Application-level races: concurrent first-auto reservations → exactly `[1]`; concurrent second-auto → `[1, 2]` gapless; concurrent final-attempt race at the global cap → ≤ 1 winner, ≤ 1 provider operation.

## D5. Tests added (correction §9 — every existing test kept, none weakened)

- `packages/server/test/retry-identity.test.ts` — **NEW, 22/22**: identity (no-manual→#1; two-manuals→#1 with `attempt_no` NULL on manual rows; manual+auto+manual→#2; sequential/stable identities; scheduled resume with same row/number/key and exactly one op); concurrency (first-auto race→one #1; second-auto race→gapless #2; DB-backstop raw-insert race); limits (global 2/category 4→exactly 2 then `lost`; global 4/category 2→exactly 2 then `category_exhausted:insufficient_funds`; global 0→`automation_disabled` zero rows/ops; `retryable=false`→refused on the FIRST decision, zero ops; category absent→fail closed `processing_error`; exhausted case never gains a new identity; concurrent final race→one winner); counts & regression anchors (scheduled ≠ executed; unknown still blocks; duplicate run never executes twice; cross-org runner finds zero candidates; manual rows sequence-neutral; behavioral §11 no-mixed-count proof).
- `packages/domain/test/retry-eligibility.test.ts` — **40/40** (was 36): routing table rewritten to rule-authority semantics; +4: unlisted-category fail-closed (fail-open hole), explicit `retryable=false`, and both `min(global, category)` directions.
- Regression suites cited for §9.16–20: manual execution **52/52** (`payment-execution.test.ts`, assertions unchanged), automated-via-4C-primitive + unknown-blocking + idempotency **21/21** (`retry-automation.test.ts`, unchanged and still passing), RLS/org isolation (`retry-identity` cross-org + `rls-hardening`).

## D6. Final gate counts (all re-run after the correction)

| Gate | Result |
|---|---|
| Full monorepo vitest | **333/333 (34 files)** — 4A/4B regressions, 4C 52/52, 4D 21/21 + 22/22 new, domain 40/40 |
| tsc `--noEmit` × 5 packages | **5/5 OK** |
| eslint × 5 packages | **5/5 OK** |
| `next build` (`NEXT_PUBLIC_DEMO_MODE=off --webpack`) | **OK — BUILD_ID `k37dNyPYJ2gHAo2NV0RZm`** |
| Probes | home **200**; unauth org API **401**; unauth retry POST **401**; cross-origin POST **403** |
| Fresh bootstrap | **20/20 migrations** (`attempt_no` + partial unique index present) |
| Upgrade from Phase 4C (0000–0017) | **18→20, applies exactly 0018+0019** — all four columns/indexes verified |
| Upgrade from first 4D review state (0000–0018) | **19→20, applies exactly 0019** |
| RLS (fresh DB, `revessent_app` role) | unscoped **0** / scoped **1** / cross-org **0** on `recovery_cases` + `recovery_attempts` |
| Security audit (§K checks re-run) | all green — no new endpoints; no secrets/provider errors in any new audit payload |
| Scope-creep grep (§27, correction files) | clean — no workers/cron/Redis/AI/email/checkout/refunds vocabulary |

## D7. Confirmations required by the correction

- **Manual attempts do not affect automated numbering, counting, or identity** — proven by behavior (two real manual executions → automated identity still `#1`; manual+auto+manual → next `#2`), by schema (manual rows carry `attempt_no NULL` and live outside the partial unique index), and by source audit (the only case-level `attemptNo` writer is the automated reservation path; the primitive's manual default key now derives from manual rows only).
- **No application-only counter exists**: the sequence comes from `max(persisted attempt_no)` inside the advisory lock; a crash cannot reissue a spent number (the durable row holds it), and even a lock bypass cannot duplicate one (unique index).
- **No Phase 5 functionality started**: the correction added one forward migration, one focused test file, and semantics/audit fixes inside the existing 4D surface. No workers, Redis, cron, scheduled jobs, AI, email, customer messaging, checkout, refunds, captures, subscription or payment-method mutations were added.
- Live-Stripe boundary unchanged (§H): nothing was fabricated; all execution evidence is fixture-gateway-based.

## D8. Files changed by this correction

`packages/db/drizzle/0019_recovery_attempt_number.sql` (+journal idx 19) · `packages/db/src/schema.ts` (`attemptNo`) · `packages/domain/src/retry.ts` (rule-authority gate, facts shape) · `packages/domain/test/retry-eligibility.test.ts` · `packages/server/src/services/retry.ts` (auto-only numbering from persisted rows, auto-only counts, decline-category routing fallback) · `packages/server/src/services/recovery.ts` (same fact semantics for the DTO) · `packages/server/src/services/execute.ts` (manual default key `m{seq}` sub-sequence) · `packages/server/test/retry-identity.test.ts` (NEW). Nothing else.

Phase 4D remains delivered **for external review**; Phase 5 has not started.

«Phase 5 / workers / Redis / AI / email / customer messaging / checkout / refunds / captures / subscription mutations / payment-method mutations / other later functionality has NOT started.»
