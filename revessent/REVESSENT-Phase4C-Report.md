# REVESSENT — Phase 4C Report

## Payment Execution & Recovery Primitives (Architecture v1 J2 / §7.3 RBAC / §11 idempotency / §16 unknown outcomes / §23)

Date: 2026-09-06 · Baseline: Phase 4B delivered + externally reviewed (report incl. FINAL CORRECTION ADDENDUM L1–L10) · Pre-implementation audit map: `PHASE4C-IMPLEMENTATION-MAP.md`

---

## §23-A. What was implemented

Exactly ONE controlled, server-side payment execution primitive per Architecture J2:

- **`executeManualRetry`** (`packages/server/src/services/execute.ts`) — an explicit, authenticated **operator-initiated manual retry of a failed invoice payment via Stripe `invoices.pay`**. It replaces the Phase-2-era honest-501 stub that `recovery.requestRetry` used to be.
- The execution record is the architecture's own model: **`recovery_attempts`** with `kind='manual_retry'` (extended by migration 0017 into the durable execution identity), and the observed provider attempt is recorded in **`payment_attempts`** with `source='revessent_retry'`.
- The full authority chain is resolved **server-side only**: session → org (from ctx, never body) → org-anchored case ⋈ payment ⋈ customer records → latest `status='active'` Stripe connection → decrypted key → provider invoice. The browser supplies **only the case id and an optional idempotency key** — never a secret key, never an account id as authority, never arbitrary org/customer/provider ids.
- Provider result persistence: success → execution `succeeded`, local payment mirror set `paid` (**webhooks remain authoritative for final state** — the 4B truth path is untouched); failure → classified via the extended ProviderErrorCode taxonomy, **declines are not system failures and are never auto-retried**.
- The §16 hard case is first-class: Stripe succeeds → response lost → the execution stays **`unknown` (recoverable, never assumed failed, never immediately re-operated)** until reconciliation or a webhook establishes truth.
- Reconciliation primitive `reconcileExecutions` (read-only provider lookup) wired into the existing 4B `reconcileFromProvider` flow — execution repairs are reported alongside lifecycle reconciliation.
- HTTP: `POST /api/v1/orgs/[slug]/recovery/cases/[caseId]/retry` on the existing conventions (session, RBAC `operate`, problem+json, narrow DTO — no raw Stripe responses).
- UI: one minimal affordance on the case detail page (explicit amount + currency + customer from the case DTO, single-submit guard, and honest outcome states where **pending/unknown is distinct from failed and declined is distinct from system error**). Demo-mode contract unchanged: the mock API returns an honest **501 `/errors/not-in-this-phase`** ("nothing was attempted") — it never fabricates a payment outcome.

**No autonomous charging of any kind exists**: no scheduled collection, no retry-execution workers, no BullMQ/Redis, no background execution, no AI- or email-triggered charges, no "charge all overdue", no recurring automation. Every execution originates from an explicit authenticated server-side command. `retry_classification` is persisted ('never'/'later') as **classification only** — nothing consumes it automatically.

## §23-B. Execution flow (exact)

1. Route: `requireOrgRole(headers, slug, "operate")` (Layer-3 RBAC) → `recoveryService.requestRetry(ctx, caseId, {idempotencyKey?}, {ip, userAgent})` → `executeManualRetry`.
2. **Service-level defense-in-depth**: the primitive re-asserts `can(ctx.role, "operate")` → 403 (see §23-J.2).
3. Key format gate: optional client key must match `^[A-Za-z0-9][A-Za-z0-9_-]{7,119}$` → 400.
4. Single org-anchored select (case ⋈ payment ⋈ customer, `org_id = ctx.org.id`) + latest `status='active'` connection. Unknown case → **404** (org-crossing is indistinguishable from non-existence, §20).
5. **Idempotency identity BEFORE gates** (see §23-J.1): default key `rv:{orgId}:{caseId}:{nextSeq}` (architecture format; `nextSeq` = count of the case's attempts + 1) or the client key; `identityHash = sha256("manual_retry|paymentId|amountCents|currency")` computed from the **local payment record only**.
   - Existing execution, same hash + same paymentId → **return the SAME execution** (audit `payment.execute_attempted` with `replayed: true`; never a second provider payment).
   - Existing execution, different hash/paymentId → **409 conflict** — financial parameters are immutable (§11), never reinterpreted.
6. Validation gates, each a **safe refusal** (nothing executed): no active connection → 409; no `stripe_invoice_id` → 400; `payment.status !== 'failed'` → 400; amount not an integer > 0 → 400 (**no amount is ever invented, never `?? 0`**); currency not `/^[A-Z]{3}$/` → 400 (**never defaulted**); customer without `stripe_customer_id` → 400.
7. Audit `payment.execute_attempted` (actor, org, caseId, amount, currency, paymentId — safe facts only).
8. **DB-enforced execution identity**: `INSERT INTO recovery_attempts … ON CONFLICT (org_id, idempotency_key) DO NOTHING` — the unique index `recovery_attempts_org_key_uq` makes the identity a database constraint, not an app boolean. The loser re-reads: same hash+payment → same execution; different → 409.
9. **Single-flight per payment**: advisory lock `revessent:payment-exec` scoped by `payment.id`. Another execution of the same payment in (`executing`, `unknown`) → **409 "Reconcile first — no second charge will be created"** (§18).
10. Mark `executing` in its **own committed transaction BEFORE provider I/O** (4B lesson: no transaction spans Stripe I/O). A crash here leaves a recoverable `executing` row, never a stuck charge.
11. Provider call `payInvoice` with provider idempotency key **`rv:{orgId}:{executionId}`** — deterministically derived from the durable execution id, **never exposed to the frontend**.
12. Success tx: execution `succeeded` (or `failed` + `unsupported_provider_state` if the provider did not report the invoice paid); payments row set `paid` when the provider says paid (webhook re-applies full truth later); `payment_attempts` row `source='revessent_retry'`; audits `payment.executed` / `payment.failed`.
13. Failure tx: `classifyOutcome` maps the ProviderErrorCode → status/category/declineCode/`retry_classification`; audits `payment.declined` / `payment.failed` / `payment.outcome_unknown`. An **unknown** outcome additionally surfaces an honest internal error ("outcome could not be confirmed — reconcile") — never a fabricated success, never an assumed failure.

**`classifyOutcome` map (stable taxonomy, extends the existing ProviderErrorCode — no second taxonomy):**
| Provider code | Status | Category | Record attempt | Classification |
|---|---|---|---|---|
| card_declined / insufficient_funds / expired_card / authentication_required | failed | = code | yes (decline evidence) | 'never' |
| payment_method_failure | failed | payment_method_failure | yes | 'never' |
| invalid_payment_context / unsupported_provider_state / idempotency_conflict / invalid_credentials / revoked / auth_failure / permission_failure | failed | = code | no | 'never' |
| rate_limited | failed | rate_limited | no | **'later'** (classification only — no worker) |
| transient_network / provider_outage / malformed_response / anything else | **unknown** | **unknown** | no | 'never' — may have executed |

**`reconcileExecutions`** (runs inside `reconcileFromProvider` after the read-only sync): pending = status in (`executing`, `unknown`) → read-only `getInvoicePaymentStatus` → provider paid: execution `succeeded` + `reconciled_at` (+ payments `paid` if not already) + audit `payment.reconciled`; provider still processing/requires_action/requires_confirmation: **stays unknown** (`execution_still_unknown:provider_processing`); otherwise `failed` / `no_provider_operation` + classification 'later' + `reconciled_at` — a NEW execution is now *provably* safe. Connection/lookup failures → `execution_still_unknown:<code>` — never resolved by assumption.

## §23-C. Migrations (forward-only, deterministic from empty DB)

**0017_payment_execution.sql** (the only new migration; **0000–0016 untouched**):

- `recovery_attempts` += `org_id` (NOT NULL, FK → organizations ON DELETE CASCADE, backfilled from `recovery_cases`), `payment_id` (FK → payments ON DELETE SET NULL), `amount_cents` (bigint), `currency` (char(3)), `stripe_connection_id` (uuid), `provider_payment_intent_id` (text), `request_hash` (text), `error_code` (text), `outcome_category` (text: succeeded | declined | … | no_provider_operation), `retry_classification` (text: 'never' | 'later'), `provider_meta` (jsonb — safe subset only), `reconciled_at` (timestamptz).
- Dropped the global uniqueness `recovery_attempts_idempotency_key_unique`; created **`recovery_attempts_org_key_uq (org_id, idempotency_key)`** — idempotency identity is per-organization (§11), enforced by the database.
- RLS policy replaced with a direct `org_id = current_setting('app.org_id')::uuid` match (single `org_isolation` ALL policy).
- Table comment documents the status semantics: **`unknown` = recoverable — never blindly re-executed**.
- Fresh bootstrap verified from empty DB: **18 migrations (0000–0017) applied, 30 tables**, seed writes `recovery_attempts` rows with `org_id` (seed.ts corrected for the new NOT NULL column).

## §23-D. Test numbers (exact)

Final gate, this session, from actual source (never trusting prior claims):

- **Vitest: 225/225 passed over 31 files, exit code 0, zero unhandled errors.**
  - server project: **181 tests / 20 files** — migrations 1, api 8, approval 7, auth 6, cross-org-mutation 3, demo-safety 7, **payment-execution 27 (NEW)**, ratelimit 2, rbac 5, rls-hardening 6, stripe-boundary 4, stripe-concurrency 6, stripe-connection 8, stripe-financial 20, stripe-sync 11, stripe-tenancy 5, tenancy 9, webhook-lifecycle 15, webhook-receive 24, webhook-verify 7.
  - web project: **44 tests / 11 files** (web app 33 + contracts 9 + domain 2 files) — unchanged from baseline.
  - Baseline before 4C: 198/198 over 30 files. Delta: **+27 tests, +1 file. No existing test weakened, deleted, or skipped.** One harness-only fix in `packages/db/test/migrations.test.ts` (§23-J.3) — assertions unchanged.
- **tsc: 9/9 packages clean** (db, integrations, domain, ui, config, contracts, server, observability, web).
- **eslint: 7/7 projects clean** (domain, ui, config, contracts, server, observability, web).
- **`next build --webpack`: exit 0**, `.next/BUILD_ID = n8JtND1BH3v2kdRDUBt2O`, 25/25 static pages (run with PG stopped and `NEXT_PUBLIC_DEMO_MODE=off` — §23-J.4).
- **Fresh bootstrap**: empty `revessent` DB → `drizzle-kit migrate` (18 migrations) → seed OK → verified 30 tables, `recovery_attempts` carries all 12 new columns, `recovery_attempts_org_key_uq` present, single `org_isolation` RLS policy, seeded attempt rows have `org_id`.
- **Live spot-checks on the rebuilt server**: unknown webhook endpoint + fake signature → 400 problem+json; settings without session → 401.

The 27 new tests (`packages/server/test/payment-execution.test.ts`) run against **real Postgres** (embedded PG 16, real RLS, real unique indexes, real advisory locks) with the deterministic fixture provider.

## §23-E. Authority chain + provider security details

- Session → org membership + role (`requireOrgRole`) → **ctx is the ONLY source of org identity**. The request body carries `{idempotencyKey?}` and nothing else.
- Every provider-facing identifier (invoice id, customer id, connection key) is resolved from **local records anchored to the authenticated org**; a revoked/absent connection stops execution **before any provider call**.
- The Stripe secret key exists only inside the server: loaded via `decryptConnectionKey` at call time, never cached in the execution record, never logged, never in a DTO.
- The provider idempotency key `rv:{orgId}:{executionId}` is derived server-side from the durable execution id and is **never returned by the API** (asserted by test: the DTO must not contain it).
- Narrow DTO (`RecoveryExecutionSchema`): executionId, caseId, paymentId, status, outcomeCategory, errorCode, declineCode, retryClassification, amountCents, currency, idempotencyKey (the client-supplied one only), createdAt, executedAt, reconciledAt. **No raw Stripe response, no provider object ids beyond the local mirror's own ids, no keys.**

## §23-F. Idempotency, races, org-crossing (all test-proven)

1. **DB identity first**: `(org_id, idempotency_key)` unique index; insert with `ON CONFLICT DO NOTHING`; loser re-reads and returns the SAME execution — idempotency is a database constraint, not an application boolean.
2. **Provider idempotency**: `invoices.pay` called with the deterministic key `rv:{orgId}:{executionId}`; the fixture contract test proves a repeated provider key replays the recorded result (exactly one provider operation).
3. **Concurrency**: two simultaneous executions with the same key → **one** logical execution and **one** provider operation (DB unique index + per-payment advisory lock `revessent:payment-exec`; test asserts `operations.length === 1`).
4. **Same key, changed parameters** (amount or currency mutated on the local record after execution) → **409**, the recorded execution is never reinterpreted (two separate tests).
5. **Cross-org**: an operator of org B, fully legitimate in org B, executing org A's case id → **404**, zero rows written anywhere (tested explicitly).
6. **Double-charge guard while unknown**: a second execution under a DIFFERENT key while one outcome is unknown → 409 **before** any provider call; the fresh provider world records zero operations.
7. **Default-key double click after success** → refused (400, payment no longer failed) rather than silently replayed — the safe side of the ambiguity (§23-J.5).

## §23-G. Failure semantics

- **Declines are not system failures**: `card_declined`, `insufficient_funds`, `expired_card`, `authentication_required` are distinct outcome categories, recorded as decline evidence on the execution and the audit log, classified **'never'** — nothing retries them automatically.
- **`rate_limited`** → classification **'later'** persisted (policy input only; no worker exists to consume it).
- **Provider/system failures** (invalid context, bad credentials, revoked) → `failed`, classification 'never', no attempt recorded.
- **Unknown outcomes** (network loss after an operation may have executed, provider outage, malformed response) → execution stays **`unknown`**, local payment unchanged, **no `payment_attempts` row is fabricated**, an honest error surfaces to the operator, and ONLY reconciliation or a webhook can resolve it. If the provider shows no operation, the execution resolves `no_provider_operation` and a NEW execution is provably safe (tested end-to-end).
- **Crash between "mark executing" and the provider response** → the stale `executing` row is resolved via read-only provider lookup (tested: simulated crash row → `execution_resolved:no_provider_operation`, provider queried read-only, never re-charged).
- **Webhook truth wins**: if the payment is no longer `failed` (truth arrived via webhook first), execution is **refused** — nothing is charged against a paid invoice (tested).

## §23-H. Live verification status (§16 — the honest boundary)

- **Live Stripe execution was NOT performed and cannot be**: this environment has no real Stripe account, no live keys, and no outbound provider access. **No successful payment is claimed or fabricated.**
- What WAS verified instead, deterministically: the exact wire call (`invoices.pay` with `idempotency_key`), the exact read-only lookup (`invoices.retrieve`), card-error classification (decline_code → taxonomy), provider idempotent replay, network-loss-after-success, ambiguous outcomes, rate limiting, and invalid requests — all through the fixture gateway against **real Postgres**.
- The demo/mock API contract is honest: `api.recovery.executeRetry` on the mock returns **501 `/errors/not-in-this-phase`** with a detail that says a real, connected Stripe account is required and **nothing was attempted**. It never fabricates an outcome.
- First real-environment activation requires only: a live `rk_test_…`/`rk_live_…` key, the existing connect flow, and an operator clicking retry — no code changes.

## §23-I. Files created / changed (Phase 4C only)

Scope-creep audit method: full workspace mtime sweep after the 4B delivery, cross-checked against the session log; **every** changed file maps to a 4C requirement. Complete list (17 files + this report):

| File | Change |
|---|---|
| `PHASE4C-IMPLEMENTATION-MAP.md` | NEW — pre-edit audit map |
| `packages/db/drizzle/0017_payment_execution.sql` (+ `meta/0017_snapshot.json`, `meta/_journal.json`) | NEW — the only migration |
| `packages/db/src/schema.ts` | recoveryAttempts 0017 parity |
| `packages/db/src/seed.ts` | seeded attempt row gets `org_id` (0017 NOT NULL) |
| `packages/db/test/migrations.test.ts` | harness-only: pool closed before dropping the throwaway DB (§23-J.3) |
| `packages/integrations/src/errors.ts` | +8 payment codes, safe messages, 402/400/409 problem mapping, `CARD_OUTCOME_CODES` |
| `packages/integrations/src/gateway.ts` | `payInvoice`, `getInvoicePaymentStatus` interface |
| `packages/integrations/src/stripe-client.ts` | both implementations + `classifyPaymentError` |
| `packages/integrations/src/fixtures.ts` | deterministic `world.pay` behaviors + provider-idempotent replay + read-only status |
| `packages/server/src/services/execute.ts` | NEW — the execution primitive |
| `packages/server/src/services/recovery.ts` | `requestRetry` 501-stub → async delegation |
| `packages/server/src/services/webhooks.ts` | `reconcileFromProvider` also runs `reconcileExecutions` |
| `packages/server/src/index.ts` | export `executionService` |
| `apps/web/src/app/api/v1/orgs/[slug]/recovery/cases/[caseId]/retry/route.ts` | rewritten: real POST, RBAC `operate`, zod body, `mutation()` |
| `packages/contracts/src/schemas.ts` / `api.ts` / `real/realClient.ts` / `mock/mockApi.ts` | `RecoveryExecutionSchema`, `recovery.executeRetry`, real client, honest-501 mock |
| `apps/web/src/views/recovery-detail-view.tsx` | minimal execute affordance (amount/currency/customer explicit, single-submit guard, unknown ≠ failed) |
| `packages/server/test/payment-execution.test.ts` | NEW — 27 tests |

**Not touched**: `uploads/revessent (2).html` (mtime unchanged), migrations 0000–0016, all other web views, webhook receiver, sync service internals, auth, Phase 1–3 UI.

## §23-J. Deviations / documented decisions

1. **Idempotency identity check hoisted BEFORE the validation gates** (`executeManualRetry`). The first test pass exposed a real ordering gap: with the pre-lookup after the `payment.status === 'failed'` gate, a re-delivery of an already-SUCCEEDED execution could never return the same result (the first execution had advanced the payment to paid, so the gate refused with 400 instead of replaying). The identity check (same key + same hash + same payment → same execution; different → 409) now precedes the gates. §11 semantics fully preserved: parameters are compared against the stored hash, mutations conflict, new executions still pass every gate. This also makes replays work with a revoked connection — correct, because a replay never performs a new provider operation.
2. **Service-level RBAC re-assertion** (`can(ctx.role, "operate")` → 403) inside the primitive, in addition to the route's Layer-3 check. A payment primitive must guarantee that every charge originates from an operator+ command whatever the entry point (mission §2). Test: viewer role → 403 with zero rows written.
3. **Harness hygiene in `migrations.test.ts`** (baseline test file): the throwaway DB was dropped while the drizzle migration pool still held an open socket, surfacing an unhandled pg `error` event (57P01) after the test. The pool is now closed before `pg_terminate_backend`/`drop database`. **No assertion added, changed, weakened, or removed** — this removes teardown noise, not coverage. (The final gate now exits 0 with zero unhandled errors.)
4. **The build gate runs with `NEXT_PUBLIC_DEMO_MODE=off`**: the §23 guard ("DEMO_MODE requested while NODE_ENV=production — refused") correctly fails `next build` when `.env.local` opts the preview into demo mode. This is the guard working as designed; the production build must (and now does) build demo-off.
5. **Default-key double click after success is refused (400), not silently replayed**: without a client-supplied key each click derives a fresh sequence, so a second click after the payment became `paid` hits the honest "only a failed payment can be retried" refusal. With a client key, the same logical execution replays identically. Both behaviors are safe-side; documented here for the reviewer.
6. **`/errors/conflict` (409) is the API-level problem type** for idempotency conflicts raised by the primitive; `/errors/idempotency-conflict` remains the provider-taxonomy mapping (ProviderError path). Both are stable, documented problem types — no second taxonomy was introduced.

## §23-K. Security audit (17 checks — each backed by an executed assertion)

1. Cross-org case execution → 404, zero rows in either org (explicit test).
2. Viewer role → 403 at route AND service; zero executions (explicit test).
3. Revoked connection → 409 before any provider call; zero provider operations.
4. Amount mutated to 0 → 400 "no amount will be invented" (never `?? 0`).
5. Currency unknown → 400 "no currency will be defaulted".
6. Non-failed payment state → 400 (unsupported provider state — no guessing).
7. Key reuse with changed amount → 409; recorded amount immutable.
8. Key reuse with changed currency → 409; recorded currency immutable.
9. Concurrent same-key requests → exactly one provider operation (DB + advisory lock, not app booleans).
10. Second execution while unknown → 409 before any provider call; fresh provider world records zero operations.
11. Replay of the same execution identity → same result, one provider operation ever.
12. Crash-after-mark (`executing` with no result) → resolved read-only, provider never re-charged.
13. Webhook-truth-wins: paid payment → execution refused, zero provider operations.
14. DTO leakage: no secret key, no `whsec_`, no provider idempotency key, no provider object ids (tested on the success DTO).
15. Audit-log leakage: no secrets; safe facts (amount 1900, currency USD, taxonomy codes) ARE audited; every attempt audited (attempted + executed/declined).
16. No card data / CVC / auth headers anywhere in the execution record (`provider_meta` is a safe subset; schema comment enforces).
17. Unknown outcome produces NO fabricated local attempt (`payment_attempts` row absent — tested) and no fabricated success message anywhere in UI or API.

## §23-L. Explicitly NOT in Phase 4C (boundary)

- No scheduled or automatic retry execution of any kind (the 'later' classification has no consumer).
- No workers, no BullMQ, no Redis, no background jobs, no cron.
- No AI- or email-triggered charges; no "charge all overdue"; no recurring automation.
- No automatic decline retries; declines, `authentication_required`, and invalid requests are terminal for the automatic path.
- No checkout sessions, no refunds, no captures, no dispute handling, no payout logic.
- No retry-policy engine changes; no email sending; no customer-facing payment links.
- No raw Stripe responses to the client; no stored card data.
- No live-Stripe execution claims (§23-H).

## §23-M. Gate decision

| Gate | Result |
|---|---|
| Vitest | **225/225 (31 files), exit 0, zero unhandled** (198 baseline + 27 new; nothing weakened) |
| tsc | **9/9** clean |
| eslint | **7/7** clean |
| Production build | **BUILD_ID `n8JtND1BH3v2kdRDUBt2O`**, 25/25 pages, exit 0 |
| Fresh bootstrap | **18 migrations / 30 tables** from empty; 0017 structures verified; seeded |
| Scope-creep audit | **17 files, all mapped** to Phase 4C; reference HTML untouched; 0000–0016 untouched |
| Honest live-Stripe statement | **Not performed — impossible here; nothing fabricated** |

**Phase 4C is COMPLETE and stops here for external review.**

«Phase 4D / automated retries / workers / AI / email / checkout / refunds / captures / automated recovery / other later functionality has NOT started.»

---

# PHASE 4C CORRECTION ADDENDUM — Provider-Invoice Truth Before Payment Execution (2026-09-06)

Status on entry: 🟡 CONDITIONAL PASS (external review). Issue: `executeManualRetry` validated the LOCAL payment amount/currency/customer and then called Stripe `invoices.pay(invoiceId)` without first verifying that the CURRENT Stripe invoice matches the local financial authority being executed. Because Stripe collects according to the provider invoice, the local amount alone does not constrain what Stripe attempts to collect. Status after this correction: **🟢 — the preflight and all regression gates pass** (numbers in C8). Only this gap was fixed; Phase 4C was not rebuilt.

## C1. Provider preflight design (correction §2)

New, smallest gateway method on the EXISTING integration boundary (`StripeGateway`): **`getInvoiceForExecution(key, invoiceId)`** — read-only, server-side only, never a payment operation, never exposed to the frontend. An existing lookup (`getInvoicePaymentStatus`) was considered and NOT reused because it deliberately exposes only status/attempt/payment-intent fields for UNKNOWN-outcome reconciliation — it lacks customer/currency/amount, which is exactly what execution preflight must verify. Each method now exposes only the fields its purpose needs. Implementation (`stripe-client.ts`): one `invoices.retrieve`, mapped field-by-field with explicit `null` semantics — **null always means "not established by the provider"; nothing is defaulted, converted, or normalized away** (the only transformation is the locale CASE of the currency code, compared against the uppercase local execution currency). Fixture gateway gains the same method reading verbatim world truth, plus a failure-plan hook (`on: "invoice_lookup"`) for the transient-failure test. The raw Stripe object is never returned by the gateway, and no new route/DTO carries any preflight field.

## C2. Amount / customer / currency validation (correction §3–§5)

Immediately BEFORE the durable execution insert and the provider payment operation, and only on the NEW-execution path (exact replays return earlier — C4):

- **Customer**: `provider.customerId` missing → refuse (400, "the target will not be guessed"); `provider.customerId !== local customer.stripeCustomerId` → refuse (409). No guessing which customer is correct; zero Stripe payment/mutation calls.
- **Currency**: `provider.currency` missing → refuse (400, "no currency will be defaulted"); different from the immutable local execution currency → refuse (409). No conversion, no silent normalization, zero calls.
- **Amount**: which Stripe number is authoritative for `invoices.pay()` — **`amount_remaining`**: that is the amount a NEW payment on the invoice collects (the payment operation is created for the remainder, not the historical total). Therefore: `amount_remaining` missing/not a positive integer → refuse (400, "no amount will be invented" — never read as zero); `amount_due` missing/invalid → refuse (400); `amount_due !== amount_remaining` → refuse (409, "payments or credits the local record does not reflect — reconcile first"), because a difference proves the invoice carries movements the local mirror has not seen (stale truth); `amount_remaining !== local amountCents` → refuse (409 financial-integrity conflict). Zero payment/mutation calls in every branch.

Every refusal writes a safe audit anomaly **`payment.preflight_failed`** (actor, org, case, amount, currency, paymentId, taxonomy `reason` — e.g. `provider_amount_mismatch`, `provider_customer_missing`, `provider_partially_paid`; never secrets, never provider internals).

## C3. Provider-state whitelist (correction §6)

`EXECUTABLE_PROVIDER_STATES = { open, uncollectible }` — the exact provider states a locally-FAILED payment can legitimately be in (4A sync maps `open`+attempted and `uncollectible` → local `failed`). Everything else refuses BEFORE any payment call, with distinct safe reasons: `paid` → `provider_invoice_already_paid` (never charge twice; the test then shows sync converging local truth to paid); `void` → `provider_invoice_void`; `draft`/other known-but-not-payable and **unrecognized future states** → `unsupported_provider_state:<verbatim status>` (recorded verbatim, never mapped into a payable state — **no `else => payable` exists; the whitelist has only an "in ⇒ proceed" branch**); missing status → `unsupported_provider_state`.

## C4. Idempotency replay ordering preserved (correction §7)

The idempotency-identity lookup remains BEFORE all validation gates (the prior correction is NOT regressed). Flow is exactly: authenticate → RBAC (route + service) → org/payment resolution → idempotency identity lookup → **exact replay returns the existing execution** (before preflight — proven by test: an already-succeeded execution replays as the same executionId even though the provider invoice is now `paid`, with zero new provider operations) → local eligibility gates → **CURRENT Stripe invoice preflight** → durable execution (unique index) → per-payment advisory lock → `invoices.pay` → webhook/reconciliation final truth. Key reuse with different parameters still returns the same conflict behavior — and the execution identity hash now ALSO covers the customer mapping (`manual_retry|paymentId|amount|currency|customerStripeId`), so a remapped customer under the same key is a conflict, not a replay. Preflight-transient refusals are honest and recoverable: NOTHING was executed (no unknown outcome exists), no durable execution row is created, and the command can be re-issued unchanged — the same key replays only a real execution. The advisory lock covers the payment operation itself; the read-only preflight needs no lock, and residual TOCTOU is guarded by Stripe's own `invoices.pay` state enforcement plus our classifier (a provider "not payable" error classifies as failed, never unknown) plus webhook/reconciliation convergence.

## C5. Tests added (correction §9) — 16 new, 0 existing weakened

`packages/server/test/payment-execution.test.ts` 27 → **43 tests**; all run against real Postgres + the fixture provider. Financial mismatch: provider amount differs → 409 + zero calls + anomaly; provider currency differs → 409; provider customer differs → 409; provider amount missing → 400; provider currency missing → 400; provider customer missing → 400; amount_due ≠ amount_remaining (partial payment/credit) → 409. Provider state: provider paid while local failed → no payment call + sync converges local truth to paid; void → refused; unsupported/future status → anomaly, refused; missing status → anomaly, refused. Idempotency regression: replay-after-provider-paid returns the same execution; same key + changed customer → conflict; same key + changed amount and changed currency → conflicts (regression pair). Preflight failure: transient lookup failure → honest 500 refusal, zero payment calls, zero execution rows, anomaly recorded, and the SAME command succeeds once the provider is reachable (recoverable). Concurrency regression: concurrent executions still produce at most ONE provider operation. (Correction items §9.12/§9.13/§9.16 are the pre-existing immutability and concurrency tests, re-run green in the final gate rather than duplicated — no test-count inflation.)

## C6. Financial safety audit (correction §11)

Searched the ENTIRE payment-execution path (`execute.ts`, `recovery.ts`, stripe-client `payInvoice`, retry route, fixtures pay path) — not just one function: **no `amount ?? 0`, no `?? "usd"`, no `?? "open"`, no `else => payable`, no local-amount/customer trust without provider comparison, no blind `invoices.pay`**. The only `?? 0` matches are non-financial row-count defaults (idempotency sequence counter, approvals counter); the single `payInvoice` call site executes strictly after preflight → durable insert → advisory lock. No equivalent silent financial default exists.

## C7. Files changed by this correction (scope audit)

`packages/integrations/src/gateway.ts` (+1 interface method), `stripe-client.ts` (+1 read-only implementation), `fixtures.ts` (+1 fake, failure-plan hook, calls counter), `packages/server/src/services/execute.ts` (preflight block, whitelist constant, customer in the identity hash), `packages/server/test/payment-execution.test.ts` (+16 tests). Nothing else: gateway architecture, 4A normalization, 4B webhooks/reconciliation, the execution state machine, DB idempotency, Stripe idempotency, RBAC, and org isolation are all untouched. No workers, Redis, scheduled jobs, AI, email, checkout, refunds, captures, or automatic retries were introduced.

## C8. Final gate counts (correction §10 — all run this session, from source)

| Gate | Result |
|---|---|
| Vitest (complete suite) | **241/241 passed, 31 files, exit 0, zero unhandled errors** (198 pre-4C baseline + 27 Phase-4C + 16 correction) |
| Phase 4A/4B regression suite | green (migrations 1, stripe-connection 8, stripe-sync 11, stripe-financial 20, stripe-boundary 4, stripe-concurrency 6, stripe-tenancy 5, webhook-lifecycle 15, webhook-receive 24, webhook-verify 7, tenancy/RLS/auth/api/etc. — all unchanged assertions) |
| Phase 4C payment-execution suite | **43/43** |
| tsc | **9/9 packages clean** |
| eslint | **7/7 projects clean** |
| Production build | exit 0, **BUILD_ID `rgnpeXZCcqi7GGVUJPS6m`**, 25/25 pages (PG stopped, `NEXT_PUBLIC_DEMO_MODE=off`) |
| Fresh bootstrap | empty DB → **18 migrations (0000–0017) → 30 tables → seeded**; `dbverify` green |
| Live spot-checks | unknown webhook + fake signature → 400 problem+json; settings without session → 401; / → 200 |

**Live Stripe execution remains NOT performed and cannot be in this environment (no real Stripe account, no live keys, no outbound provider access). No payment success is claimed or fabricated.** The preflight itself was verified end-to-end against the deterministic fixture provider (mismatch/missing/state/transient matrices above); first real-environment activation needs only a live key via the existing connect flow.

## C9. Boundary confirmation

No Phase 4D functionality was started: **no automatic retries, no workers, no Redis, no scheduled execution, no AI, no email, no checkout, no refunds, no captures, no subscription upgrades, no automated recovery.** The one added provider call is read-only.

«Phase 4D / automated retries / workers / AI / email / checkout / refunds / captures / automated recovery / other later functionality has NOT started.»

---

# PHASE 4C CORRECTION ADDENDUM 2 — Payment-Level TOCTOU / Double-Charge Guard (2026-09-06)

Status on entry: 🟡 CONDITIONAL PASS — external review confirmed the provider-invoice preflight is correct but found one remaining financial-safety race: the preflight ran BEFORE the payment-level advisory lock, so two executions with DIFFERENT idempotency keys could both observe the invoice as payable; the first could succeed and mark the payment paid while the second, acquiring the lock afterwards, saw no in-flight execution and could call `invoices.pay()` on stale pre-lock state. Status after this correction: **🟢 — the lock is now the final serialization boundary, and all regression gates pass** (numbers in D7). Narrowly scoped: nothing was rebuilt.

## D1. Revalidation after acquiring the payment lock (correction §2)

Inside `withPgAdvisoryLock("revessent:payment-exec", payment.id)`, after the existing in-flight (`executing`/`unknown`) guard and BEFORE the execution is marked `executing` or any provider mutation:

- **(a) Local re-read**: the payment row is re-selected fresh. If it is no longer `failed` (a different execution identity — or a webhook — changed it while this request waited): **no Stripe call, no payment operation**. The reserved execution row is finalized `skipped` (`payment_already_paid`, or `payment_no_longer_retryable` for other states, classification 'never'), a post-lock anomaly is audited, and the request is refused with 409. Provider truth that has already established success converges via reconciliation — never a second charge.
- **(b) Provider re-read**: `getInvoiceForExecution` is called AGAIN and the result is checked against the **same shared rules** as the preliminary read (`providerInvoiceFault`, below). Any fault → execution finalized (`skipped` for `provider_invoice_already_paid`, `failed` otherwise, with the fault as `error_code`/`outcome_category`), post-lock anomaly audited, 409/400 thrown — **zero payment/mutation calls**. A post-lock lookup failure finalizes the execution `failed` with classification **'later'** and throws the honest internal problem — never a blind payment, never an assumed outcome.

Refusals that occur after the execution row exists now always leave a terminal row (`skipped`/`failed`) — no execution can be left dangling in `scheduled` after a refusal. No database transaction is open across Stripe I/O (the pre-lock read, the post-lock read, the finalize, and `payInvoice` all run with explicit short transactions; 4B lesson preserved).

## D2. One set of rules, two moments in time (correction §8)

The preflight validation chain was consolidated into a single pure function **`providerInvoiceFault(providerTruth, localAuthority)`** enforcing, identically in both phases: provider customer missing → refuse / ≠ local `stripe_customer_id` → refuse; currency missing → refuse / ≠ local → refuse; `amount_remaining` missing/non-positive → refuse ("never read as zero"); `amount_due` missing/non-positive → refuse; `amount_due ≠ amount_remaining` → refuse (partial payment/credit — stale truth); `amount_remaining ≠ local amount` → refuse; status missing/`paid`/`void`/unrecognized → refuse via the explicit `EXECUTABLE_PROVIDER_STATES = { open, uncollectible }` whitelist (**no `else => payable`**). The pre-lock read remains as the fast-fail layer; the post-lock read is authoritative. Neither replaces the other. Refusal reasons, problem types, and messages are byte-identical between the two phases — proven by the pre-existing preflight tests (all still green, unchanged) plus the new post-lock tests asserting the same reason codes.

## D3. Idempotency ordering preserved (correction §4)

The identity lookup and exact-replay return remain BEFORE every eligibility gate and before both provider reads. New test proof: an exact same-key replay performs **zero provider lookups at all** (lookup counter unchanged across the replay) — so a replay cannot be affected by, and cannot be rejected because of, current local/provider state. Same-key + changed parameters still returns the existing 409 conflicts (existing tests, unchanged). The post-lock revalidation applies only to a genuinely NEW execution.

## D4. Different-key tests (correction §5–§7, §9)

9 new tests (43 → 52 in `payment-execution.test.ts`); all deterministic — no timing sleeps; interleavings are fixed by the advisory lock and a two-phase fixture gateway whose FIRST lookup (preliminary preflight) is healthy and whose SECOND lookup (the authoritative post-lock re-read) returns the mutated truth:

1. **Sequential different-key** after success → second execution refused at the local gate, second provider world records **zero** operations.
2. **Concurrent different-key** (`Promise.allSettled`, keys A/B, same case/payment) → exactly one `succeeded`, exactly one rejected **409** (whichever serialization path wins the lock — try-lock contention or post-lock refusal — both are safe refusals), **provider operations = 1**, exactly one `payment_attempts` row. This is the previously-missing critical test.
3. **Local payment becomes paid between the pre-lock gate and the post-lock re-read** (first lookup flips the local row, simulating a webhook landing mid-flight) → refused 409, zero provider calls, execution `skipped`/`payment_already_paid`, post-lock anomaly audited.
4. **Provider invoice becomes paid** between the reads → zero calls, execution `skipped`/`provider_invoice_already_paid`.
5. **void** between the reads → zero calls, `provider_invoice_void`.
6. **amount changes** between the reads → zero calls, `provider_amount_mismatch`.
7. **currency changes** between the reads → zero calls, `provider_currency_mismatch`.
8. **customer changes** between the reads → zero calls, `provider_customer_mismatch`.
9. **Exact same-key replay returns the original execution with ZERO provider lookups** (ordering proof, D3). §9.10 (same-key changed amount/currency/customer → 409) is covered by the three existing immutability tests, re-run green, unchanged — not duplicated (no test-count inflation).

## D5. Financial invariant (correction §10)

Established and test-proven: **for one REVESSENT payment, no two execution paths can reach `invoices.pay()`** — same-key replays return the original execution before any gate or read; different-key executions serialize on the payment advisory lock, and the winner's committed outcome (local `paid`, or provider `paid`) is re-observed by the loser UNDER the lock before any mutation; a stale pre-lock provider read can never authorize the payment operation. Database idempotency protects repeated identities; the payment lock + post-lock local/provider revalidation protects the underlying financial object across different execution identities.

## D6. Final audit (correction §11)

Source-order proof in `execute.ts` (single non-test `payInvoice` call site in the entire server): preliminary provider read (line ~289) → pre-lock fault check (~319) → **advisory lock acquired (~352)** → in-flight guard → post-lock local re-read (~390) → post-lock provider re-read + fault check (~405–415) → mark executing (~417) → `invoices.pay` (~425). No execution can reach `invoices.pay()` using only a stale pre-lock provider read — proven by the different-key concurrency test (§D4.2), not by comments. No financial defaults were reintroduced (no `?? 0` on financial values, no `else => payable`).

## D7. Full regression (correction §12 — all run this session, from source)

| Gate | Result |
|---|---|
| Full Vitest suite | **250/250 passed, 31 files, exit 0, zero unhandled errors** (241 pre-correction + 9 new; no existing test weakened or deleted) |
| Phase 4A/4B regression | green (all stripe-*/webhook-*/migrations/tenancy/RLS/auth suites unchanged) |
| Phase 4C payment-execution suite | **52/52** |
| TypeScript | **9/9 packages clean** |
| ESLint | **7/7 projects clean** |
| Production build | exit 0, **BUILD_ID `mJOkf2sdSRqdKHa_tZLba`**, 25/25 pages |
| Fresh DB bootstrap | empty → **18 migrations (0000–0017) / 30 tables / seeded**; `dbverify` green |
| Live safe route checks (new build) | unknown webhook + fake signature → **400** problem+json; settings without session → **401**; retry without session → **401**; / → **200** |

**Live Stripe execution remains NOT performed and cannot be in this environment** (no real Stripe account, no live keys, no outbound provider access); nothing is fabricated. The double-charge guard itself is proven deterministically against the fixture provider with real Postgres locks, unique indexes, and RLS.

## D8. Boundary confirmation

No Phase 4D functionality started: no automatic retries, workers, Redis, scheduled execution, AI, email, checkout, refunds, captures, subscription upgrades, or automated recovery. Files changed by this correction: `packages/server/src/services/execute.ts` (post-lock revalidation + shared `providerInvoiceFault`) and `packages/server/test/payment-execution.test.ts` (+9 tests). Nothing else.

«Phase 4D / automated retries / workers / AI / email / checkout / refunds / captures / automated recovery / other later functionality has NOT started.»
