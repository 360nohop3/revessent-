# REVESSENT — Phase 7 Independent Audit (Entitlements & Plan Enforcement)

Audit date: 2026-09-07. Audited commits: code `79891ef`, report `d4d27df`. Correction commit produced by this audit: `fbb6519`.
Stance: hostile, code-first. The Phase 7 report was treated as a claim to be falsified, not as evidence. Every gate below was re-executed in this sandbox after the correction; nothing is carried over from the Phase 7 report.

**VERDICT: `PASSED — CORRECTIONS APPLIED`**

---

## 1. Audit scope and method

Inspected end-to-end (not sampled): `packages/domain/src/entitlements.ts` (resolver), `packages/server/src/services/{entitlements,billing,communication,expansion,settings,webhooks,recovery,orgs,checkout,suppression}.ts`, `packages/db/src/client.ts` (`withOrgTx` / `withoutOrg`), `packages/db/drizzle/0023_entitlements_billing_state.sql` + journal, `apps/worker/src/workers/notesWorker.ts`, `apps/web/src/app/api/v1/orgs/[slug]/entitlements/route.ts`, `apps/web/src/app/api/v1/webhooks/billing/route.ts`, `apps/web/src/views/{billing-view,pricing-view}.tsx`, contracts DTOs, and the tests `packages/server/test/entitlements.test.ts`, `packages/domain/test/entitlements.test.ts`, `apps/worker/test/notes-queue.test.ts`, `packages/db/test/migrations.test.ts`. Architecture cross-checks: `REVESSENT-Architecture-v1.md` §0, §1.4 (plan table), §7.3/§7.4, §9.6, B-5 risk register, job table (`digest.weekly`).

Repository-wide greps performed: plan-name comparisons (`plan ===`, `"ember"|"studio"|"revessent"` literals) outside the resolver; every `memberships` insert site; every `organizations` update site; every `set_config(` call; every `webhookEvents` reader; every caller of `can(`/`requireCapability`/`reserveSeat`; any cache/memo primitive around entitlements.

Nothing outside Phase 7 was redesigned. No Phase 8 work was started.

## 2. Findings register

| # | Severity | Area | Finding | Disposition |
|---|----------|------|---------|-------------|
| F1 | **Medium (integrity)** | webhooks.ts | Three tenant-Stripe-feed queries on `webhook_events` did not filter by `source`. Phase 7 writes billing-feed rows into the same table with `source='stripe_billing'`. Effects: (a) `webhookStatus()` counted billing failures in the tenant connection's `failed`/`unprocessed`/`lastFailureCode`; (b) `reconcileFromProvider()` swept **all** `failed` rows of the org to `reconciled` — including billing rows that the tenant reconcile path never re-applies, so a real failed billing event (e.g. `subscription_mismatch`) could be relabelled as reconciled without any state repair; (c) the receiver's duplicate lookup at L143 selected by `(org_id, external_id)` without `source` — harmless today because Stripe event ids are globally unique, but incorrect against the 0015 uniqueness contract. | **FIXED** in `fbb6519` (four `source = 'stripe'` predicates + regression test). |
| F2 | Low (documented) | billing.ts | Ordering guard is strict: `eventAt < providerUpdatedAt → superseded`. Two events with the *same* `created` second both apply; the one arriving last wins. Stripe emits distinct `created` values for successive lifecycle transitions in practice, and the per-event lock plus `FOR UPDATE` make the outcome serialised and deterministic per arrival order. Not a regression path (both events are equally "newest"). | Documented; no change. |
| F3 | Low (documented) | billing.ts | Unmapped `lookup_key` keeps the previous plan (never guesses). A price renamed in Stripe would freeze the plan until the next mapped event. Already listed as a limitation in Phase 7 report §17. | Documented; no change. |
| F4 | Product decision (documented, non-blocking) | entitlements.ts | Ember member cap (1,000 Stripe customers) is **reported, not enforced**. See §11 for the full analysis. Enforcing would require blocking the Stripe customer sync, which is the financial truth for recovery — a safety regression. Architecture (B-5) itself lists the mitigation as "cap Stripe sync frequency", not "block". | Not blocking; see §11. |
| F5 | Informational | communication.ts | Held-for-approval path calls `entitlementFlags` before the atomic claim and performs a conditional update guarded by `send_status='pending' AND approval_status='approved'`. Verified: no email provider call, no AI call, no outcome counted as an AI/provider failure, no throw → no BullMQ retry loop. Idempotent under duplicate delivery (second delivery hits `not_approved`). | OK. |
| F6 | Informational | 0023 SQL | Both SECURITY DEFINER functions: `set search_path = public`, `revoke all … from public`, `grant execute … to revessent_app`; verified `has_function_privilege('public', …)=false` on all upgrade paths. `resolve_billing_org` matches only on ids *we stored*; `resolve_billing_org_unlinked` only returns an org whose row has **no** stored customer/subscription — metadata can never re-point a linked org. | OK. |

No `if premium skip safety` pattern exists. No plan-name branch exists outside `packages/domain/src/entitlements.ts` (the only hits are `after.plan !== before.plan` change-detection in billing.ts and a `featured` badge in the static pricing page).

## 3. Correction applied (F1)

`packages/server/src/services/webhooks.ts` (+6/−4):
- receiver duplicate lookup: `+ eq(webhookEvents.source, "stripe")`
- `webhookStatus()` grouped counts and last-failure lookup: `+ source = 'stripe'`
- `reconcileFromProvider()` failed→reconciled sweep: `+ source = 'stripe'` with an explanatory comment.

`packages/server/test/entitlements.test.ts` (+18): new test *"audit fix: a FAILED billing-feed row never leaks into the tenant webhook health counts and is never flipped to reconciled by the tenant reconcile path"* — inserts a `stripe_billing` row with `status='failed'`, asserts `webhookStatus().failed === 0` / `lastFailureCode === null`, runs the source-scoped sweep and asserts the billing row is still `failed`.

Billing-feed writer (`billing.ts` L160–190) already filtered by `source = BILLING_EVENT_SOURCE`; it was the tenant side that was unscoped. This is a correctness/integrity fix, not a product decision.

## 4. Resolver audit (pure, deterministic, fail-safe)

`resolveEntitlements({plan,status,missing})`: no I/O, no clock, no randomness, no AI import. Entitled statuses are exactly `trialing | active`; every other value (`past_due`, `canceled`, `incomplete`, `incomplete_expired`, `unpaid`, `paused`, `unknown`, arbitrary strings, `null`, missing row) yields `restricted=true`, `effectivePlan='ember'`, and a reason code. Unknown plan name → `ember` baseline. No grace period exists in the architecture and none is encoded (`past_due` is restricted immediately). Deterministic-output test present (same input twice → deep-equal).

## 5. Billing authority audit

- Single truth: `org_subscriptions` (0000 table + 0023 columns). `organizations.plan` is a display mirror updated only in `billing.ts:247` under the column-restricted `org_self_update` policy (`plan, updated_at` only; verified via `information_schema.column_privileges` on every upgrade path).
- Webhook path: signature verified (400 on missing/wrong secret; secret unset ⇒ 400), `BILLING_LIVEMODE !== event.livemode ⇒ 400` **before** any DB write (L119 precedes L160 insert).
- Idempotency: insert `onConflictDoNothing` against the 0015 unique index; `duplicate:true` short-circuits; advisory lock `revessent:billing-event:{org}:{eventId}`; `SELECT … FOR UPDATE` on the subscription row; strict provider-timestamp guard (F2).
- Tenant resolution: stored ids first; metadata org id only if UUID-shaped **and** org is unlinked; already-linked org receiving a different subscription/customer → `subscription_mismatch`/`customer_mismatch` → `failed` (audited, no mutation).
- No second billing truth: browser never posts a plan; there is no API that accepts a plan value (grep confirmed: zero routes write `orgSubscriptions` or `organizations.plan`).

## 6. Capability enforcement points (server)

| Capability | Enforced at | Type |
|---|---|---|
| `upgrade_signals` | `expansion.ts:85` (act on opportunity), `expansion.ts:170` (create signal) via `requireCapability` → 402 + audit | request-time |
| `ai_notes` | `communication.ts:192–196` — `aiEnabled && entitled.aiNotes`; fallback reason rewritten to `ai_not_entitled` (not a provider failure) | prepare-time |
| `trust_autonomy` | `communication.ts:196` (`trustLevel` forced 0 ⇒ human approval) and `communication.ts:386–401` execution-time re-check for `autoApproved` rows | prepare-time **and** execution-time |
| `smart_retries`, `recovery_checkout` | always true on every plan (architecture §1.4); no gating code exists — verified no retry/execute path consults entitlements, so 4C/4D safety is untouched | n/a |
| `weekly_digest` | no consumer (feature belongs to a later phase: `digest.weekly` job) | deferred |

Frontend: `apps/web/src/views/billing-view.tsx` renders server DTO only; `pricing-view.tsx` contains a `<Link href="/sign-up">` and no API call. `useEntitlements` is display-only.

## 7. Limits & concurrency

Only limit specified by architecture and enforced: **seats** (1/5/15). `reserveSeat()` runs inside one `withOrgTx`, takes `pg_advisory_xact_lock(hash('revessent:seats:'+orgId))`, re-reads the plan row, counts memberships + pending unexpired invitations, then either runs the insert **in the same transaction** or refuses with `seat_limit_reached`. Membership insert sites: `orgs.ts:45` (owner at org creation — before any other seat can exist) and the invitation path in `settings.ts:553` via `reserveSeat`. No other writer exists (grep). Concurrency test (N parallel invites for the last seat → exactly one success) passed in this run.

## 8. Worker audit

Queue unchanged (Phase 5 `retries` queue + Phase 6 notes queue; no new queue). `notesWorker` delegates to `communicationService.deliverMessage`, which performs the execution-time entitlement re-read (§6) **before** the atomic claim. Post-downgrade matrix as implemented and tested:

| Queued work | Behaviour after downgrade/past_due |
|---|---|
| Auto-approved pending note | **held** (`awaiting_approval`, `auto_approved=false`), audited, not sent, not discarded; duplicate delivery → `not_approved` |
| Human-approved pending note | **sent** (a person approved it) |
| Suppressed recipient | **suppressed** — suppression wins over everything (Phase 6 invariant retained) |
| `retry.execute` financial job | **executed** — entitlements never touch 4C/4D retry/execution (no code path) |

Worker tests: real Redis (spawned `redis-server`), 12 tests green, incl. duplicate delivery.

## 9. Tenant isolation & RLS

All reads/writes go through `withOrgTx` (sets `app.org_id` per transaction). Platform billing webhook resolves tenant via SECURITY DEFINER functions and then re-enters `withOrgTx(orgId)`; the `webhook_events`, `org_subscriptions`, `audit_logs` writes are therefore RLS-bound to the resolved org. Cross-org test (member of A reading B's entitlements / inviting into B) → 403/404, passed. `org_member_read` recreation admits `app.org_id` scope — same GUC trust boundary as every other `org_isolation` policy; clients cannot set GUCs.

## 10. Security audit checklist

| Vector | Result |
|---|---|
| Client-supplied plan / usage | No endpoint accepts either; DTO is server-derived |
| Cross-org read/mutation | RLS + `ctxFor(slug)` membership check; tested |
| RBAC bypass | `entitlements` route = `view`; billing detail block only for `administer`; invitations require `manage_team` + seat reservation |
| Forged webhook | Signature, livemode, stored-id resolution, unlinked-only metadata; tested (wrong secret, forged subscription, forged org id) |
| Races | seat advisory lock; per-event lock + `FOR UPDATE`; tested (concurrent seats, concurrent distinct billing events) |
| Stale cache | No cache exists (grep: no memo/LRU/Redis key for entitlements) |
| Worker/API bypass | Execution-time re-read; API 402 path; no frontend-only gating |
| Secret leakage | Problem responses carry plan/status labels only; audits carry capability/reason/plan; no payload/PII |
| SECURITY DEFINER | `search_path=public`, not executable by `public` |

## 11. Product/architecture decisions found (documented, none blocking)

**D1 — Ember member cap (1,000) reported, not enforced.**
Architecture §1.4/§0: "Member cap 1,000 … 14-day pilot ≤1,000 members"; B-5 lists the risk as sync/AI cost with mitigation "cap Stripe sync frequency". Implementation: `overMemberCap` flag + `entitlement.limit_reached` audit; sync continues. Why ambiguous: "members" are the tenant's Stripe customers mirrored by the 4A sync, and that mirror is the financial truth feeding recovery cases; blocking or truncating it would silently drop recoverable failed payments — a financial-safety regression the brief forbids. Smallest decision for the product owner: (a) keep reported-only (current), (b) block *new automated recovery work* for customers beyond the cap while continuing sync, or (c) block sync. The audit judges (a) as the only option that does not violate the brief's non-negotiables, so this is **not** raised to BLOCKED.

**D2 — `weekly_digest` capability has no consumer** (digest job is a later phase). Harmless; resolver correctly reports it.

**D3 — Downgraded auto-approved messages require fresh human approval** (not auto-resend after re-upgrade). Conservative and reversible; documented in Phase 7 report §17.

## 12. Migration verification (fresh + upgrades)

Fresh bootstrap: `packages/db/test/migrations.test.ts` (empty DB → 0000…0023 → primitives, RLS, grants, 0023 assertions) — passed in the full run.

Upgrade replays performed by this audit (throwaway DBs, raw SQL in journal order, seeded rows *before* upgrading, DBs dropped afterwards; script not committed):

| From | Boundary | Migrations applied | Seeded rows preserved | RLS on 5 audited tables | `organizations` UPDATE grant | SECURITY DEFINER fns (search_path / app exec / public exec) | `org_self_update` policy | 0023 indexes |
|---|---|---|---|---|---|---|---|---|
| Phase 4C | 0017 | 6 | org 1, customers 1, sub `studio/active/cus_keep` kept, `plan_source='default'`, `created_at` set | ✔ | `plan, updated_at` only | public / ✔ / ✘ | 1 | both present |
| Phase 4D | 0019 | 4 | same | ✔ | same | same | 1 | both |
| Phase 5 | 0020 | 3 | same | ✔ | same | same | 1 | both |
| Phase 6 | 0022 | 1 | same | ✔ | same | same | 1 | both |

No historical migration was modified (`git diff 5abb18d..HEAD -- packages/db/drizzle/00[0-2][0-2]*` is empty).

## 13. Test & gate results (all re-run after the correction)

| Gate | Command | Result |
|---|---|---|
| Full Vitest (server + web projects) | `pnpm vitest run` | **50 files, 495 tests passed, 0 skipped, 0 failed** (494 prior + 1 audit test) |
| Focused: entitlements + webhook receive + webhook lifecycle | `vitest run --project server …` | 3 files, **59 passed** (entitlements 20) |
| Domain resolver | within full run | 7 passed |
| Worker (real Redis) | within full run | 12 passed (notes-queue) |
| TypeScript + ESLint | `turbo run typecheck lint` | 18/18 tasks successful, 0 errors |
| Production build | `NEXT_PUBLIC_DEMO_MODE=off turbo run build` | 2/2 successful |
| Fresh migrations | migrations.test.ts | passed |
| Upgrades 4C/4D/5/6 | audit script (§12) | 4/4 passed |
| Concurrency: seats final unit | entitlements.test.ts | passed |
| Concurrency: distinct billing events same subscription | entitlements.test.ts | passed (newest wins, none lost) |
| Duplicate billing event | entitlements.test.ts | `duplicate:true`, one audit row |
| Out-of-order billing event | entitlements.test.ts | older past_due after newer active → skipped |
| Worker duplicate delivery / held path | notes-queue + entitlements | passed |

Known flake (pre-existing, unrelated): `retry-identity` "concurrent final-attempt race" under full-suite load — it passed in this run.

## 14. Live-provider status

No live Stripe, AI, or email calls were made. Billing webhooks are fixture events signed with the test secret through the real signature verifier; email/AI use the fake providers. Nothing here claims live verification.

## 15. Scope audit

Files changed since `main` (`5abb18d`) by Phase 7 + this audit are confined to: domain resolver, entitlements/billing services, communication/expansion/settings/webhooks touch-points, 0023 migration + schema + journal, contracts DTO/mock/schema, one API route pair, billing/pricing views + `useEntitlements`, `packages/ai` `FallbackReason` union (+`ai_not_entitled`), config env parsing, tests and helpers. No Phase 8 items (no monitoring, Terraform, DR, OAuth/Marketplace, retry-engine changes, new queues, new AI/email functionality). `git diff 79891ef~1..HEAD` was reviewed file-by-file.

## 16. Verdict

**`PASSED — CORRECTIONS APPLIED`**

One real integrity defect (F1: billing-feed rows contaminating tenant webhook health and being relabelled `reconciled` without repair) was found, fixed minimally, regression-tested, and all gates were re-run green. No financial-safety regression, no tenant-isolation gap, no client-controllable plan or usage path, no unbypassable-limit failure was found. Product decisions D1–D3 are documented above for owner review and do not block Phase 7 closure. Phase 8 was not started; the product is not declared production-ready.
