# REVESSENT — Phase 7 Report: Entitlements & Plan Enforcement

Status: **implemented and verified in the sandbox; awaiting review. Phase 8 not started. Not a production-readiness claim.**

Commits (branch `arena/01a077b8-revessent`): `71d5c5e` Phase 6 baseline re-commit (sandbox reset had dropped history; files were intact), `79891ef` Phase 7.

Environment note: the sandbox was reset before Phase 7 began (git history, `node_modules`, Postgres, Redis lost). Everything was rebuilt from the repository; results below are from the rebuilt environment. No Phase 4A/4C/4D/5 report files exist in the repo (only Phase 2, 3, 6 and the architecture doc); phase facts were taken from code and migrations.

---

## 1. Objective

Turn the §1.4 entitlement matrix — already present as a *display* constant in `packages/domain/src/entitlements.ts` and used only by the sidebar/pricing page — into one authoritative, server-side decision layer fed by Revessent's own billing state, enforced at API, service and worker execution points, without touching any Phase 4C/4D/5/6 financial safety mechanism.

**What existed before Phase 7 (inspected, not assumed):**
- `PLANS` / `hasEntitlement(plan, feature)` in domain — pure constant; **zero callers on the server**. No `if (plan === …)` gating anywhere on the backend.
- `organizations.plan` (display, default `ember`) and `org_subscriptions` (`plan`, `status` default `trialing`, guarantee fields) created in 0000; the only writer was `createOrg` (inserts `ember/trialing`). `settingsService.billing()` read it and hard-coded `billingProviderLive: false`.
- Problem type `entitlement-required` (402) declared in `http/problems.ts` — never thrown.
- Stripe webhook receiver (4B) is per-**tenant-connection** (`/webhooks/stripe/{orgRef}`), for the tenant's customers — not for Revessent's own billing. No platform billing endpoint existed.

## 2. Plan model

Taken verbatim from Architecture v1 §1.4 (no pricing invented; prices remain display-only in `PLANS`):

| | Ember | Revessent | Studio |
|---|---|---|---|
| Capabilities (boolean) | `smart_retries`, `recovery_checkout` | + `ai_notes`, `upgrade_signals`, `weekly_digest`, `trust_autonomy` | same as Revessent |
| `limits.seats` | 1 | 5 | 15 |
| `limits.memberCap` | 1000 | unlimited | unlimited |

Normalisation is strict: plan ∈ {ember, revessent, studio}, otherwise `unknown_plan_treated_as_ember`. "SSO/API/multi-brand/concierge" (§1.4 last row, App. B-3) are **not** capabilities — nothing can grant them. `weekly_digest` exists as a capability but has no consumer yet (digests are not built; noted in §17).

Separated concepts: **capabilities** (booleans), **limits** (numbers), **usage** (live counts: `seatsUsed` = memberships + pending unexpired invitations; `members` = non-deleted customers), **subscription status** (verbatim Stripe).

## 3. Billing authority

Single truth: `org_subscriptions` (existing table, extended by 0023). `organizations.plan` is a **display mirror** only; a test proves a forged/stale `organizations.plan = studio` grants nothing.

Statuses recognised verbatim: `trialing, active, past_due, canceled, unpaid, incomplete, incomplete_expired, paused`; anything else → `unknown`. **Only `active` and `trialing` entitle a paid plan.** `unknown ≠ active`. Missing row → `billing_record_missing` → Ember baseline.

Synchronisation: new platform endpoint `POST /api/v1/webhooks/billing` (`services/billing.ts`), official Stripe SDK signature verification over the raw body against `BILLING_WEBHOOK_SECRET` (new optional env; unset ⇒ safe 400, nothing applied). Livemode must match `BILLING_LIVEMODE`. Tenant resolution never trusts a payload-claimed org id when stored ids exist: `resolve_billing_org(customer, subscription)` (SECURITY DEFINER, exact match on ids **we** stored) first; provider metadata `org_id` is honoured **only** for an org whose row is still unlinked (`resolve_billing_org_unlinked`). Once linked, an event with a different subscription/customer id is skipped (`subscription_mismatch` / `org_unresolved`).

## 4. Resolver

`resolveEntitlements({plan, status, missing})` in `packages/domain/src/entitlements.ts` — pure, no clock, no I/O, no AI. Output: `plan` (subscribed), `effectivePlan` (in force), `status`, `state` (`entitled | baseline`), `restricted`, `capabilities`, `limits`, `reasons[]` (stable codes such as `subscription_past_due`, `free_plan`, `unknown_billing_status`). Deterministic (tested: identical input ⇒ identical JSON). Financial-safety capabilities (`smart_retries`, `recovery_checkout`) are true in **every** state by construction — losing a plan never disables recovery machinery.

`planFromPriceHints` maps a Stripe price to a plan using provider-side fields only (price metadata `plan` > `lookup_key` > subscription metadata `plan`, cadence suffix stripped). Unknown ⇒ `null` ⇒ **previous plan kept** (`plan_unmapped_kept_previous`), never a guess.

Grace periods: Architecture v1 defines none → none encoded. `past_due` restricts immediately. `cancel_at_period_end=true` with status `active` stays entitled until Stripe sends `customer.subscription.deleted` (→ `ember/canceled`). Trial expiry arrives from Stripe as a status change (`active` or `past_due/unpaid`); no local clock decides it.

## 5. Capabilities — enforcement points

`packages/server/src/services/entitlements.ts`: `can(db, orgId, cap)` (non-throwing, for services/workers), `requireCapability(ctx, cap)` (throws 402 `/errors/entitlement-required`, audits `entitlement.capability_denied`), `getEntitlements`, `describe` (DTO).

| Capability | Enforced where | Denial behaviour |
|---|---|---|
| `upgrade_signals` | `expansion.pushSignal`; `applyOpportunityDraftAction` for `submit`/`approve` | 402 + audit; reads, edits, cancel, dismiss remain available (existing work is never hidden) |
| `ai_notes` | `communication.prepareCommunication` (policy `aiEnabled && entitled`) | deterministic template, `fallback_reason = ai_not_entitled` (new value; **no** `ai_generations` row, no provider call, not counted as an AI failure) |
| `trust_autonomy` | prepare: effective `trustLevel` forced to 0 → `awaiting_approval`; **deliver (execution time)**: an `auto_approved` pending message is moved back to `awaiting_approval` (`held_for_approval`) before any claim/provider call | held for a human; human-approved messages are unaffected |
| `smart_retries`, `recovery_checkout` | not gated (always true; §3 of brief) | — |
| `weekly_digest` | no consumer exists yet | — |

Reason codes on denial: `capability_not_in_plan:<effectivePlan>` or `subscription_<status>` when restricted.

## 6. Usage & limits

| Limit | Counted | Window | Failed/blocked/deleted | Reset | Concurrency | Enforcement point |
|---|---|---|---|---|---|---|
| `seats` | memberships + invitations with `accepted_at IS NULL AND expires_at > now()` | none (point-in-time) | expired/accepted invitations don't count; removed members free the seat | n/a | per-org `pg_advisory_xact_lock` inside one org-scoped tx | `settingsService.invite` → `reserveSeat` |
| `memberCap` | non-deleted `customers` | none | soft-deleted excluded | n/a | n/a | **reported only** (`overMemberCap`), not an admission gate — the customer mirror comes from the tenant's Stripe and is the financial truth for recovery; refusing to sync customers would corrupt recovery state (brief §3/§10). Flagged for review. |

No AI/email *quantitative* limits were introduced: the architecture defines an AI cost budget (`ai_usage_budgets`, §9.6 "cost governance") but no per-plan quota, and the existing table has no writer in any phase. Not invented (brief §8).

## 7. Concurrency

- **Seat race**: 8 concurrent invites with exactly one unit left ⇒ 1 success, 7 × 402, `seatsUsed` ends at the limit; a 9th is refused. With 0 units left all 8 refused. Mechanism: transaction-scoped advisory lock keyed on org + fresh count inside the same tx as the insert (no check-then-insert).
- **Billing event races**: DB-unique `(org, source='stripe_billing', account, external_id)` (existing 0015 index), per-event advisory lock with bounded wait, `SELECT … FOR UPDATE` on the billing row; concurrent different events serialise, newest `provider_created_at` wins, every event row persisted exactly once.
- **Worker race**: 3 concurrent send deliveries after a downgrade ⇒ `held_for_approval` once, `lease_held_elsewhere` twice, zero emails.
- **Retry-identity** "concurrent final-attempt" test (known flaky under load in Phase 6 runs) passed in both full runs here.

## 8. Billing transitions (all via simulated signed webhooks)

Tested: first linkage (metadata, unlinked org) → `revessent/active`; duplicate delivery (`duplicate: true`, no second audit); forged metadata for an already-linked org (skipped); forged metadata naming another unlinked org with a subscription already bound elsewhere (routed by stored ids, other org untouched); out-of-order older `past_due` after newer `active` (`superseded_by_newer_event`); `past_due` ⇒ restricted, `entitlement.changed` audit lists lost capabilities; `trialing` (studio) → `active` with `cancel_at_period_end` (still entitled) → `deleted` ⇒ `ember/canceled`, `organizations.plan` mirror updated; unmapped price keeps plan; unknown Stripe status stored as `unknown` ⇒ restricted; unhandled type skipped; livemode mismatch 400.

Audit actions added: `billing.state_transitioned`, `entitlement.plan_changed`, `entitlement.changed`, `entitlement.capability_denied`, `entitlement.limit_reached`, `communication.held_for_approval`. Diffs carry plan/status/capability names/event ids only — no secrets, no PII (asserted).

## 9. Worker

No new queue. Phase 6 `notes` queue and Phase 5 `retries` queue unchanged. Entitlement is re-checked **at execution time** inside the services the worker delivers to (`prepareCommunication`, `deliverCommunication`), always from the durable row.

Queued work after downgrade, per job type:

| Job | Behaviour |
|---|---|
| `retry.execute` (financial) | **Unaffected.** No entitlement check exists on this path (test asserts zero `capability_denied` audits after delivery). Smart retries are in every plan. |
| `communication.prepare` | Executes; AI → template (`ai_not_entitled`); autonomy → `awaiting_approval`. Durable row still created. |
| `communication.send` — human-approved | Executes (a person decided). Suppression, sends_paused, facts re-verification still apply first. |
| `communication.send` — auto-approved | `held_for_approval`: message → `awaiting_approval`, job → `succeeded/held_for_approval` (durable blocked outcome, no BullMQ retry, not rediscovered until a human approves). Never discarded. |

## 10. AI / email

- Denial never sends email and never calls the AI provider (fake provider `calls.length === 0`).
- Denial is not a provider failure: no `ai_generations` row, `fallback_reason=ai_not_entitled` distinct from `ai_disabled`/`ai_unavailable`.
- Phase 6 fallback preserved; **suppression wins over everything** (tested: unsubscribed customer + upgraded to Studio ⇒ `suppressed`, zero provider calls).

## 11. API

- `GET /api/v1/orgs/{slug}/entitlements` — `view` role; returns plan/effectivePlan/state/capabilities/limits/usage; `billing {status, reasons}` only for admin+ (`null` otherwise).
- `GET /api/v1/orgs/{slug}/settings/billing` — owner (unchanged authz); now server-resolved and honest: `billingProviderLive` is true **only** when `plan_source='stripe_billing'`.
- `POST /api/v1/webhooks/billing` — signature-authenticated; safe 400 on failure; JSON ack on success.
- No endpoint accepts a plan, status, usage or limit from a client. `PlanSchema` in contracts is still used by `/me` and org DTOs for **display**.

## 12. Frontend

`apps/web/src/views/settings/billing-view.tsx` rewritten minimally: plan badge, verbatim status, "restricted to Ember" badge + explanation, capability list, seats/members usage vs limit, over-cap notice, and an honest live/not-live footer. Contracts: `BillingInfoSchema` extended, new `EntitlementsSchema`, `api.settings.entitlements`, `useEntitlements`, query key; demo mock updated. No other UI touched; nothing on the client can change a plan.

## 13. Tenant isolation

All reads/writes via `withOrgTx` under RLS. Migration 0023 adds `org_self_update` on `organizations` (row = current `app.org_id`) and **column-level** `UPDATE (plan, updated_at)` for the app role (table-level UPDATE revoked; verified: `name` update → 42501). The `org_member_read` policy was re-created to also admit the current tenant scope (needed for the UPDATE's row read); it uses the same server-set GUC as every `org_isolation` policy. Cross-org: another org's row update returns 0 rows; cross-org slug → 404. SECURITY DEFINER resolvers are exact-id, select-only, granted to `revessent_app`, revoked from public.

## 14. Security audit

| Vector | Result |
|---|---|
| Client-controlled plan/usage | No input path; `organizations.plan` proven non-authoritative |
| Forged webhook org id | Ignored once linked; only unlinked orgs can be linked, and only by a verified event |
| Wrong/missing signature, wrong livemode | 400, nothing persisted |
| Cross-org plan mutation | RLS 0 rows; app role cannot update other columns |
| RBAC | billing detail owner/admin; invite (seat consumption) admin+; viewers/operators cannot mutate billing |
| Races | seat lock, event lock, row lock, message claim (§7) |
| Stale cache | no cache exists |
| Worker/API bypass | same service functions; worker re-checks at execution |
| Frontend-only gating | none — UI only displays |
| "premium skips safety" | grep across `src`: no plan branches outside the resolver (one `featured` highlight on the marketing pricing card); no entitlement code in `execute.ts`, `retry.ts`, `checkout.ts`, `sync.ts`, `webhooks.ts`, `retryWorker.ts`, `scheduler.ts` |

## 15. Migrations

`0023_entitlements_billing_state` (forward-only; 0000–0022 untouched): `org_subscriptions` + `current_period_end`, `cancel_at_period_end`, `provider_updated_at`, `last_event_id`, `plan_source` (default `'default'`), `created_at`; indexes on `stripe_customer_id`, `stripe_subscription_id`; functions `resolve_billing_org`, `resolve_billing_org_unlinked`; `organizations` policies/grants as in §13. No new tables (reuse per brief §21).

Verified: fresh bootstrap 0000→0023 (`migrations.test.ts` asserts columns, indexes, SECURITY DEFINER + execute grant, column-level grant `[plan, updated_at]`, no table-level UPDATE, `org_self_update` policy). Upgrades **4C (0017), 4D (0019), 5 (0020), 6 (0022) → 0023** with a pre-seeded `revessent/trialing` row: row preserved, `plan_source='default'`, RLS visible in scope, `name` update denied (42501), cross-org update 0 rows, resolver executable.

## 16. Tests

New: `packages/domain/test/entitlements.test.ts` (7: every plan × status, limits follow effective plan, unknown/missing fail-safe, determinism, no phantom capabilities, price mapping ×2), `packages/server/test/entitlements.test.ts` (19: resolution ×3, capabilities ×2, seat race, billing webhooks ×10, communication ×2, cross-org), worker test in `notes-queue.test.ts` (+1), migration assertions (+0023). Existing tests adjusted only where Phase 7 changed semantics: `communication.test.ts` now sets the org to Revessent (AI/autonomy are paid), and three suites pin `quietHoursStart = quietHoursEnd = 0` so send-time verdicts no longer depend on the wall-clock hour (a pre-existing latent flake that surfaced because this run happened at 04:30 UTC, inside the default 21–08 quiet window; the quiet-hours test itself pins version 10 with quiet hours on).

Results: **full Vitest 50 files / 494 tests passed** (was 48/467); `turbo typecheck` 9/9; `turbo lint` 9/9 clean; `NEXT_PUBLIC_DEMO_MODE=off turbo build` 2/2 clean.

Classification: fixture billing tests (DB + resolver) ✅ · DB tests (real Postgres 16, RLS as `revessent_app`) ✅ · worker tests (real Redis 7.2.7, BullMQ, fake providers) ✅ · **simulated** Stripe Billing webhooks (official SDK signing/verification, no network) ✅ · **live Stripe: not exercised** ❌.

## 17. Limitations & review items

1. `memberCap` is reported, not enforced (rationale §6) — decision needed.
2. `weekly_digest` capability has no consumer (digests not built in any phase).
3. Price→plan mapping relies on operator-set `lookup_key` / price metadata `plan` on the platform Stripe account; an unmapped price keeps the previous plan and logs `plan_unmapped_kept_previous`.
4. Held-for-approval messages after a downgrade require a human to re-approve; there is no automatic re-release on upgrade (deliberate: a person must decide).
5. Checkout Session creation / Customer Portal links for self-serve upgrades are **not** built (Phase 7 is enforcement; billing UX is outside the brief) — `checkout.session.completed` linkage is handled if such a session is created with `metadata.org_id`.
6. `BILLING_WEBHOOK_SECRET` unset ⇒ endpoint returns 400 for everything (safe, but a deployment must set it before billing sync works).
7. Seats freed by removing a member are not tested (no member-removal endpoint exists).

## 18. Live-provider status

No live Stripe call, no live AI call, no real email in Phase 7. All provider interaction is fixtures/fakes or SDK-signed simulated events.

## 19. Scope audit

No Phase 8 work; no production hardening, Terraform, monitoring, DR; no payment/retry engine changes (`execute.ts`, `retry.ts`, `retryWorker.ts`, `scheduler.ts` untouched); no new AI or email functionality (only a fallback reason value and a hold state); no Stripe OAuth/Marketplace; no unrelated frontend changes (billing view only). Historical migrations unmodified.

## 20. Verdict

🟢 Entitlements are derived from the authoritative billing row, resolved by one pure function, enforced server-side at API/service/worker execution time, tenant-safe under RLS, and unbypassable via forged client values, cross-org access, duplicate/out-of-order billing events, or concurrent consumption of the final seat. Financial safety paths carry no entitlement checks. 🟡 Two design points need a reviewer's decision (member-cap reporting vs enforcement; digest capability without a consumer). Not declared production-ready. **Stopping here for review.**
