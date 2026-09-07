# REVESSENT — Phase 3 Final Audit Report

**Date:** 2026-09-05 · **Scope:** Backend, Database & Real Authentication (Phase 3)
**Method:** fresh section-by-section audit of the actual workspace source — migrations, RLS policies, services, route handlers, tests, bundles, and a live HTTP session against the production build — followed by an audit-and-fix pass. This report was produced by re-inspecting the code, not by trusting prior claims.

**Repository:** `/home/user/revessent` (monorepo: `packages/{config,domain,observability,contracts,db,server,ui}` + `apps/web`)
**Audited against:** `REVESSENT-Architecture-v1.md` (esp. §5.2 schema, §6 API, §7.1/7.3 auth & roles, §13 approval invariant, §23 demo boundary), `docs/phase3-gap-analysis.md`, the Phase 3 implementation requirements, and the Phase 2 frontend baseline.

---

## 0. Final gate decision

## 🟢 PASS — with explicitly deferred later-phase capabilities enumerated (§9)

Every Phase 3 requirement in the brief — PostgreSQL 16 + Drizzle schema per §5.2, migrations proven from an empty DB, Better Auth identity with argon2id and Postgres-backed sessions, server-side RBAC for all four roles, three-layer tenancy with cross-org read/mutate/infer tests, `/api/v1` thin handlers with Zod in/out and RFC 9457 problem+json, the server-side approval invariant (edit ⇒ invalidated; no send path), integer minor-unit money, append-only audit logging, the demo/real configuration boundary with a production-refusal proof, and frontend integration that preserves the Phase 2 visual contract — is implemented and covered by passing tests.

The audit found and fixed **four real RLS defects, one privilege-escalation hole, one API-contract violation (validation → 500), one demo-chrome leak, and three dishonest demo-copy toasts** (§4–§6). None of the remaining gaps is a Phase 3 requirement; all are later-phase capabilities listed without exception in §9. **No Phase 4 work was started.**

---

## 1. Requirement-by-requirement audit

Status: ✅ pass · ✅*(fixed during audit) · 🟡 partial, bounded · ⛔ not built (deferred, later phase)

| Requirement | Evidence | Status | Gap | Action taken |
|---|---|---|---|---|
| **PostgreSQL 16** | embedded-postgres 16.14 binaries; DB live on :5433; suite runs against it | ✅ | — | — |
| **Drizzle + drizzle-kit** | `packages/db/src/schema.ts` (strict TS), `drizzle/` SQL migrations + journal; used by app, tests and migrator | ✅ | — | — |
| **Schema = Phase 1 §5.2, no speculative tables** | all §5.2 families persist: orgs, memberships, invitations, users (Better Auth), sessions, customers, subscriptions, payments (§5.2 explicitly folds invoices into `payments`), recovery cases/attempts/messages/checkouts/attributions, expansion signals/opportunities, voice profiles, retry policies, audit logs, stripe connections, org own-billing, retry/checkout/AI-budget tables | ✅ | — | — |
| **Fresh-DB bootstrap** | `packages/db/test/migrations.test.ts`: creates a throwaway DB → runs all migrations → asserts 14 core tables exist, RLS enabled, WORM holds, then drops it | ✅ | — | — |
| **Deterministic migrations** | forward-only numbered files + journal; `drizzle-kit migrate` idempotent; no historical file ever edited | ✅ | — | — |
| **Seed boundaries** | `packages/db/src/seed.ts` is a dev script mirroring Phase 2 fixtures; **not imported by any runtime module** (verified by grep); prod config cannot reach fixtures (tests §6) | ✅ | — | — |
| **Better Auth identity** | `packages/server/src/auth/auth.ts`; user/session/account/verification tables; credential provider | ✅ | — | — |
| **Argon2id password hashing** | `@noble/hashes` argon2id; PHC-format hash in `account.password`; never plaintext (test asserts prefix + absence of plaintext) | ✅ | — | — |
| **Sessions: 30-day expiry, sliding renewal** | `session.expiresIn = 60*60*24*30`, `updateAge = 1 day`; DB row inspected in test (≥29 days); forced-expiry test proves a stale row cannot authenticate | ✅ | — | — |
| **Secure cookie attributes** | `rv.session_token`: HttpOnly, `Secure` in production, `SameSite=Lax`, path `/` (config in auth.ts) | ✅ | — | — |
| **Sign-in / sign-out** | `/api/v1/auth/sign-in`, `/sign-out`; tests: valid in, wrong-password rejected, sign-out kills the row | ✅ | — | — |
| **Session expiry** | test force-expires the DB row → session no longer resolves | ✅ | — | — |
| **Email verification = contract only** | Better Auth persists the token; `sendVerificationEmail` logs a Phase-4 notice, sends nothing; sign-in allowed unverified **but org creation is refused (403)** — proven by unit test **and** live HTTP (§7) | ✅ | delivery is Phase 4 (documented, not claimed) | — |
| **Password reset = contract only** | `/auth/request-password-reset` persists a Better Auth reset token, always answers `{accepted:true, emailSent:false}` (no account-existence oracle); `/auth/reset-password` consumes it; sendResetPassword logs only | ✅ | delivery is Phase 4 | — |
| **RBAC owner/admin/operator/viewer, server-side** | `can()` matrix test mirrors §7.3 exactly (5 actions × 4 roles); `requireOrgRole` middleware rejects viewer `operate` 403, operator `administer` 403, admin `own` 403, owner passes all — all four proven against real sessions | ✅ | — | — |
| **No frontend-only authority** | every mutating handler resolves the actor from the session cookie; client-sent actor fields ignored; hidden-UI is UX only (middleware is the gate) | ✅ | — | — |
| **Tenancy layer 1 — query/service scoping** | all tenant reads/writes run in `withOrgTx(db, orgId, …)` (grep-verified: every mutation is `tx.*` inside a wrapper); cross-org **mutations** by ID → 404 (`cross-org-mutation.test.ts`: recovery draft submit/approve, expansion edit/dismiss, settings binding) | ✅*(audit added mutation tests) | — | new tests |
| **Tenancy layer 2 — PostgreSQL RLS** | `0001/0003/0005/0006/0007/0008/0009` policies; direct primary-key probe under org-A scope returns **0 rows**; unscoped app-role reads return **0 rows**; membership self-insert escalation **denied by RLS** (§5) | ✅*(4 fixes) | — | migrations 0005–0009 |
| **Tenancy layer 3 — authn/authz middleware** | foreign slug → **404, not 403** (no existence oracle), tested at middleware and HTTP layers | ✅ | — | — |
| **Cross-org “infer” protection** | overview for a disconnected org returns nulls + CTA (never zeros, never other-org data); billing is own-org only; 404s are generic (“No workspace …”, no existence info beyond the requested slug) | ✅ | — | — |
| **/api/v1, thin handlers** | 31 route handlers, all ≈10 lines: parse → requireSession/requireOrgRole → service → problem+json | ✅ | — | — |
| **Zod in / validated out** | bodies via Zod; live overview response parsed against `OverviewSchema` in test; money fields asserted integer | ✅*(ZodError routing fixed) | was 500 | `api-route.ts` fix |
| **problem+json, stable types, status codes** | `/errors/{unauthorized:401, validation:400, forbidden:403, not-found:404, conflict:409, rate-limited:429, csrf:403, internal:500, not-in-this-phase:501, entitlement-required:402}` — 401/400/403/404/429/500/501 all exercised by tests or live HTTP | ✅ | — | — |
| **Path/org binding** | org scope always from the URL slug through `requireOrgRole`; IDs never carry authority (cross-org ID use → 404) | ✅ | — | — |
| **Safe error messages** | 500s are generic (“Something went wrong. Nothing was changed.”); Zod 400s echo field **paths only**; no stacks/SQL to clients | ✅*(fixed) | — | `toProblem` fix |
| **Mutation origin checks (CSRF)** | `assertSameOrigin` on every mutation; live cross-origin PUT → 403 `/errors/csrf` | ✅ | — | — |
| **Idempotency boundary** | `idempotency_keys` table + grants persist (§5.2); `Idempotency-Key` enforcement is **not** wired — deferred with execution surfaces (Phase 4) | 🟡 | enforcement | documented deferral |
| **Approval FSM (server-side, persistent)** | draft→awaiting→approved (+cancel); **edit always persists content; from approved it invalidates** (invalidated_at set, approver cleared, audit row); invalid transitions → 409; resubmission clears invalidation; all asserted against DB rows, not return values | ✅ | — | — |
| **Edit ⇒ invalidated; no send without approval** | domain `TRANSITIONS[invalidated] = {}` (terminal); `queue` reachable **only** from `approved`; `provider_confirmed` only from `provider_pending` — new test enumerates every escape from `invalidated` (queue / execution_started / provider_pending / provider_confirmed) and each is refused | ✅*(strengthened) | — | new assertions |
| **Money = integer minor units** | no `parseFloat` anywhere; no float arithmetic on money; `Number()` only converts PostgreSQL `SUM()` strings (exact ≤ 2⁵³); `Money{currency,minor}` in contracts; live response asserted integer | ✅ | — | — |
| **Entitlements** | `packages/domain/src/entitlements.ts` §1.4 matrix (`hasEntitlement(plan, feature)`) shared UI/server; `entitlement-required` problem type exists | 🟡 | server-side plan-tier enforcement binds to billing execution (Phase 4/5) | documented |
| **Audit events on state changes** | draft transitions, approval/invalidation, key connected/revoked (last-4 only), policy version bumps, voice saves, invites (hash only), checkout issue/rotate, dismissals | ✅ | — | — |
| **Audit logs WORM + no secrets** | UPDATE/DELETE grant revoked (0002), RLS-insert-only; tamper test fails as expected; `redact()` (keys, webhook secrets, session tokens, bearers, emails) applied to every diff; password/reset tokens never in logs | ✅*(redactor hardened) | — | — |
| **Organization lifecycle** | create (RLS-ordering correct), slug validation/uniqueness (conflict 409), owner bootstrap, `ember`/`trialing` own-billing row | ✅*(fixed ordering) | — | `orgs.ts` fix |
| **Recovery state persistence** | cases, attempts, messages, checkouts (128-bit token, **SHA-256 stored**, rotation disables prior open checkout, 14-day expiry), attributions; retry = honest 501 | ✅ | — | — |
| **Expansion state persistence** | signals, opportunities, draft lifecycle mirroring recovery, dismiss w/ audit | ✅ | — | — |
| **Secrets absent from browser bundles** | production build scan: **0** chunks contain secret **values** (`owner_local_dev`, `app_local_dev`, live keys); env-var *names* appear via the config schema (no values) — documented §8 | ✅ | — | — |
| **Production / demo separation** | 5 gates: config refusal (unit-tested incl. `=1` variant), **production build refuses to compile with the flag on** (reproduced during audit), runtime refusal (live: `/api/demo/session` → refused in a prod process), `getApi()` real client, DemoBar hidden (fixed — §6.3) | ✅*(DemoBar fixed) | — | `demo-bar.tsx` fix |
| **Mock client unavailable to production path** | `getApi()` returns the real client when demo is off; demo session route 404s; fixtures are runtime-unreachable (inert chunk data — documented §8) | ✅ | inert bundle presence | documented |
| **Mock boundary survives for demo/test** | demo mode explicit-opt-in (`NEXT_PUBLIC_DEMO_MODE=on`), visibly labeled; `/api/demo/session` works in dev | ✅ | — | — |
| **Migrations tested from empty DB** | `migrations.test.ts` (runs in every suite execution) | ✅ | — | — |
| **Frontend integration, Phase 2 visuals preserved** | `resolveSession()` dual realm; auth adapters branch demo/real; `/c/[token]` canonical (Phase 2 pre-corrected); all screens consume the same `ApiClient` against real handlers; UI untouched beyond copy honesty fixes (§6.3) | ✅*(copy fixes) | — | — |

---

## 2. Fixes made during this audit

| # | Fix | Where | Why it mattered |
|---|---|---|---|
| 1 | **Membership write escalation closed** — `own_memberships` was FOR ALL gated only on `user_id = self`, so the app role could insert itself into **any** org with **any** role (privilege escalation; only the query layer blocked it) | migration `0007_memberships_rls_guard.sql` | RLS must be a real backstop, not a duplicate of the query layer |
| 2 | **Team roster silently empty** — read policy required `app.user_id`, but `team()` runs under `withOrgTx` (only `app.org_id`) → team lists returned only the caller (or nothing), with no error | migrations `0008_memberships_read_scope.sql`, `0009_membership_org_read.sql` | silent wrong data; caught by live E2E (`team: []`) and pinned by a regression test |
| 3 | **Zod validation surfaced as 500** — `toProblem` had no `ZodError` branch, so any invalid mutation body was `500 internal` instead of `400 /errors/validation` | `apps/web/src/lib/api-route.ts` | RFC 9457 contract violation; field **paths only** are echoed, never values |
| 4 | **Rate limiter was dead code** — §7.1 (5 / 15 min / IP+email) existed but was wired nowhere | `packages/server/src/http/ratelimit.ts` (`enforceAuthRateLimit`) wired into sign-in, sign-up, request-password-reset; 2 tests | the documented control now actually enforces, with `Retry-After` |
| 5 | **DemoBar rendered when the flag is unset** (production default) — guard was `=== "false"` | `apps/web/src/components/shell/demo-bar.tsx` (`!== "on"`) | demo chrome could appear in production builds |
| 6 | **Dishonest demo copy in real mode** — “Connected (demo) — no key was stored”, “Policy saved (demo)”, “Voice saved (demo)” toasts fired in real mode where data **does** persist server-side | `stripe-view.tsx`, `recovery-policy-view.tsx`, `voice-view.tsx` — copy now branches on `demoMode()` | never fabricate/contradict reality (standing constraint) |
| 7 | **Org creation RLS ordering** — `INSERT … RETURNING` needed the creator membership to exist first; membership insert needs the org (FK). Resolution: plain insert (no returning) → membership → scoped read; `app.org_id` set in-tx before the own-billing row | `packages/server/src/services/orgs.ts` | create-workspace failed under RLS (found by the new auth/RBAC tests) |
| 8 | **Auth lazy initialization** — module-scope `betterAuth(...)` required runtime env at build time → page-data collection crashed | `packages/server/src/auth/auth.ts` (proxy lazy singleton) | production build must not require runtime secrets |
| 9 | **Better Auth 1.7 schema alignment** — `issuer` column added (forward migration); `requestPasswordReset` is the correct 1.7 API name (not `forgetPassword`) | migration `0004_better_auth_issuer.sql`, auth routes | sign-up/reset crashed against the generated schema |
| 10 | **Redactor hardened** — added `rv.session_token=…` and `Bearer …` patterns alongside keys/webhook-secrets/emails | `packages/observability/src/index.ts` | defense-in-depth for logs and audit diffs |
| 11 | **Demo endpoint graceful refusal** — production process answers 404 (not a ConfigError 500) when the flag leaks into runtime | `apps/web/src/app/api/demo/session/route.ts` | clean failure for misconfiguration |

---

## 3. Migration changes (all forward; no historical file edited)

| Migration | Content |
|---|---|
| `0004_better_auth_issuer` | add `account.issuer` (Better Auth 1.7 requires it) |
| `0005_token_rls_cycle_fix` | `case_org_id()` SECURITY DEFINER helper; rewrites checkouts/cases/customers/payments/organizations token policies → resolves **42P17 infinite recursion** (found at first test run) |
| `0006_rls_column_shadowing_fix` | fixes two policies where unqualified `id`/`case_id` bound to the **inner** subquery relation (`m.org_id = m.id`, `ck.case_id = ck.id`) — the member-matching branches had never matched |
| `0007_memberships_rls_guard` | per-command membership policies + `member_write_allowed()` SECURITY DEFINER guard (bootstrap / owner-admin caller / owner-only grants) — closes the escalation hole |
| `0008_memberships_read_scope` | fixes read scope so team listings work for org members (identity OR membership), insert via guard only, update via guard on old+new rows, delete = leave-org or guard |
| `0009_membership_org_read` | adds `org_id = app.org_id` read branch (org-scoped transactions must see their own roster; the GUC is server-side only) |

Every policy in **all** migration files was re-read during the audit (not just the latest): unqualified references in single-table policies (`org_id = GUC`) are unambiguous and were left as-is; every subquery-based policy now uses fully qualified columns; INSERT policies carry WITH CHECK; tenant tables are FOR ALL (delete covered); `audit_logs` has no update/delete path (WORM proven by test); checkout token INSERT is org-only (token flow is read-only).

---

## 4. Security findings

1. **[Fixed] Membership privilege escalation via RLS** (see §3/0007). Exploitable only by a server-side SQL session (the app role is never exposed to clients), but RLS is required to hold independently of the query layer.
2. **[Fixed] Validation → 500** could mask client errors and generate noise pages (§2.3).
3. **[Fixed] DemoBar in production builds with unset flag** (§2.5).
4. **Verified clean:** no secret values in any client chunk (18 chunks scanned for 5 patterns); cookies HttpOnly/Secure/SameSite=Lax; every mutation origin-checked (live 403 from a foreign origin); actor always from the session; 404s disclose nothing; error bodies generic; console output limited to two Phase-4 notices containing only the email (redacted form applied to structured logs); rate limiter returns `Retry-After`; WORM audit verified by tamper test.
5. **Accepted, documented:** Better Auth tables (`user`, `session`, `account`, `verification`, `idempotency_keys`) use `auth_rows using (true)` — Better Auth performs **pre-authentication** lookups (sign-in by email, reset-token resolution) that identity-scoped RLS cannot express. Exposure is bounded: the app role is server-only, no API surfaces raw rows, and sessions carry hashed tokens. Reviewer note: replacing these with token-derived policies is a production-hardening candidate (Phase 8).

---

## 5. RLS findings (deep audit result)

Every policy from every migration was dumped via `pg_policies` and re-derived from the SQL files:

| Finding | Severity | Resolution |
|---|---|---|
| 42P17 recursive policy dependency (checkouts ↔ cases) | build-blocker | `case_org_id()` definer helper (0005) |
| Column shadowing: `m.org_id = m.id`, `ck.case_id = ck.id` | critical (policies never matched) | qualified references (0006) |
| Membership FOR-ALL policy allowed self-insert into any org | high (privilege escalation) | guard + per-command policies (0007) |
| Membership read policy starved `team()` (silent empty roster) | medium (data correctness) | 0008 + 0009 + regression test |
| `auth_rows using(true)` on Better Auth tables | accepted | documented (§4.5) |
| `organizations` is SELECT-only for the app role | correct hardening | services never update orgs; `PATCH /orgs/{id}` not built |
| Token-flow exceptions (checkouts/cases/customers/payments/organizations) | correct | `app.token_flow` + `app.checkout_token_hash` GUCs set server-side in one transaction; hash compare; insert stays org-only |

Transaction-local configuration (`set_config(..., true)`) is used exclusively inside transactions; the live-E2E incident where a GUC evaporated (autocommit) was a test-script artifact, not product code.

---

## 6. Authentication findings

- **Implemented now:** identity, Postgres session persistence (30-day, sliding daily), argon2id hashing (PHC strings, `timingSafeEqual` verification), sign-in/out, expiry enforcement, verification-token persistence, reset-token persistence, per-IP+email rate limiting on the three sensitive auth routes.
- **Intentionally deferred (and never claimed):** actual verification-email delivery; actual reset-email delivery. Both persist tokens and say `{emailSent:false}`.
- **Organization creation gating:** unverified user → 403 (unit test + live HTTP); verified user → org created, becomes `owner` (unit test). The gate lives in the server service, not the UI.
- Audit note: Better Auth 1.7 requires the `issuer` account column (added), and its reset endpoint is `requestPasswordReset` (fixed).

### 6.1 Rate limiting (audit §5)

| Property | Value |
|---|---|
| Protected routes | `POST /api/v1/auth/sign-in`, `/sign-up`, `/request-password-reset` |
| Key | `bucket:x-forwarded-for[first]‖x-real-ip:email(lowercased)` |
| Window / max | 15 minutes / 5 attempts (Better Auth’s own limiter additionally: 5 per 900 s, memory) |
| Response | 429 `/errors/rate-limited` + `Retry-After` (seconds) |
| Scope | **process-local (in-memory)** — single-instance correct; tests reset buckets via `resetRateLimits()` |
| Distributed limiter | **Redis/shared — Phase 4 / production-hardening requirement** (gap-analysis row 16). Not introduced in this audit. |

### 6.2 Live end-to-end transcript (production build, `next start`)

`homepage 200` · unknown token `{state:"unknown"}` honest · unauth overview `401 problem+json` · signup `200` (PHC hash in DB) · wrong-password rejected · **unverified org create `403`** · after verification (DB effect simulated via owner role — the Phase 4 email step) org create `200` · overview honest nulls + connect-Stripe CTA · team roster visible (after 0009) · policy PUT `200` persisted · invalid policy body **`400 /errors/validation`** (was 500) · foreign-origin PUT **`403 /errors/csrf`** · foreign-org overview **`404`** · `/api/demo/session` in prod process **refused** (by design; 404 in a correctly configured prod, 500→404 fixed for the misconfigured case).

### 6.3 Demo/real boundary (audit §6) — proofs

1. Unit: default (no flag) ⇒ demo off; prod+`on` **and** prod+`1` ⇒ `ConfigError`; dev/test+flag ⇒ on (`demo-safety.test.ts`, 7 tests).
2. Build: `next build` with the flag present **refuses to compile** (“production must never serve demo fixtures”) — reproduced during this audit; the shipped build was produced without the flag.
3. Runtime: a production server process with the flag present refuses demo endpoints (observed live); `/api/demo/session` 404s when off.
4. Client: `getApi()` returns the real fetch client; DemoBar renders nothing unless `NEXT_PUBLIC_DEMO_MODE === "on"` (fixed); demo cookie authenticates nothing and is ignored when demo is off.
5. Bundle grep: no `DemoStore`/`getMockApi` call is reachable in the real path; fixture **data** (“Acorn Books”) exists in inert static chunks — runtime-unreachable, documented in §8.

---

## 7. API contract consistency (Phase 1 §6.2 ↔ Phase 3 routes ↔ Phase 2 client)

The Phase 2 client (`ApiClient` in `packages/contracts`) maps **1:1** onto the 31 Phase 3 handlers — no missing or renamed endpoint from the frontend’s perspective; response DTOs are Zod-validated on both sides.

Documented deltas (Phase 2 baseline wins; nothing changed silently):

| Phase 1 §6.2 | Phase 3 | Note |
|---|---|---|
| flat paths (`GET /overview`, …) | org-nested `/api/v1/orgs/{slug}/…` | Phase 2 contract established nesting; Phase 3 kept it |
| `POST /recovery/messages/{id}/approve|reject|edit` | consolidated: `POST …/drafts/{draftId}` with `DraftAction` | single FSM endpoint; `reject` = `cancel` |
| `POST /expansion/opportunities/{id}/approve` | `POST …/{id}/draft` (DraftAction) + `/dismiss` | mirrors recovery semantics |
| `GET/PUT /settings/retry-policy` | `GET/PUT /settings/policy` | Phase 2 naming |
| invite response `TeamMember[]` | `{invited:true, emailSent:false, team}` | **enriched** in Phase 3 (honest `emailSent:false`) — documented then and now |
| `GET /me` incl. entitlements | `/me` returns user + memberships | role-derived UI; plan entitlements bind to billing (Phase 4/5) |
| `POST /c/{token}/confirm` | `POST /api/v1/c/{token}` → honest **501** | execution is Phase 4 |

Phase 1 catalog items **not built** (no frontend consumer; not in the Phase 3 brief; each bounded, none security/tenancy related): `PATCH /orgs/{id}` (rename/timezone), `DELETE /settings/team/{memberId}`, `GET /audit?target=` (rows persist + WORM; viewer screen is a later-phase UI), `POST /recovery/cases/{id}/checkout-link` HTTP surface (the service + persistence + RLS exist and are tested), `POST /expansion/signals` HTTP surface (`pushSignal` service exists), `Idempotency-Key` enforcement (table ready), `POST /webhooks/stripe/{orgRef}` (Phase 4 by design).

---

## 8. Known limitations (disclosed, none critical)

1. **Inert demo fixtures in static chunks** — the mock store’s data ships in lazily-loaded chunks but is unreachable when demo is off (4 runtime gates). Code-splitting the mock out of the production graph is a Phase 8 hygiene item.
2. **Env-var name strings** (`DATABASE_URL`, `BETTER_AUTH_SECRET`, `KEY_ENCRYPTION_KEY`) appear in client chunks from the config module’s schema — names only; verified **no values**.
3. **Better Auth tables under `auth_rows using(true)`** (§4.5).
4. **Process-local rate limiting** (§6.1) — Redis is Phase 4.
5. **No Playwright/browser E2E** — Playwright is not installed in this environment; browser-level flows were covered by direct route-handler invocation against real PostgreSQL plus the live HTTP transcript above. This is an honest gap in *browser* coverage, not in API/DB coverage.
6. **`middleware` file convention** — Next 16 logs a deprecation (`proxy` rename). Cosmetic; unchanged to avoid churn.
7. **Build memory** — the sandbox cannot run `tsc`/type-validation inside `next build` (OOM); typecheck and lint run as separate enforced gates, and `experimental.cpus: 1` + a PG stop/start dance make the build reproducible here.
8. **Demo preview runs via `next dev`** — a production process refuses demo mode even when misconfigured (intended).

---

## 9. Intentionally deferred features (Phase 4+, not started)

Stripe synchronization and payment execution, webhook receivers, production email delivery, AI drafting/usage, BullMQ workers and scheduled retry execution, Redis rate limiting/shared state, plan-tier entitlement enforcement in billing flows, checkout/confirm execution behind `/c/{token}`, the audit-log viewer UI, org rename/timezone, member removal, manual signal-push HTTP surface, idempotency enforcement, OpenAPI document generation (Phase 8), nonce-based CSP (Phase 8). **None was implemented in this audit.**

## 10. Deviations from architecture (complete list)

Path nesting per Phase 2 (`/orgs/{slug}/…`), consolidated draft-action endpoints, `/settings/policy` naming, invite response enrichment, `/me` without entitlements field, `POST /c/{token}` as the confirm route, Better Auth 1.7 API names + `issuer` column, in-process auth rate limiting until Redis (Phase 4). All listed here rather than silent; all additive or naming-level.

---

## 11. Test results (final run, this audit)

| Gate | Result |
|---|---|
| Backend suite (real PostgreSQL 16): auth(6) · rbac(5) · rls-hardening(6) · tenancy(9) · cross-org-mutation(3) · approval(7) · api(8) · ratelimit(2) · demo-safety(7) · migrations(1) | **54/54 ✅** |
| Frontend suite (jsdom, Phase 2 regression + demo labeling) | **36/36 ✅** |
| `tsc --noEmit` strict: config, domain, observability, contracts, db, server, ui, web | **8/8 packages ✅ (0 errors)** |
| `eslint .` (apps/web) | **clean ✅** |
| `next build --webpack` (production, no demo flag) | **success (25/25 pages) ✅** — and demonstrably **refuses** with the demo flag present |
| Migration bootstrap from empty DB | **✅** (runs inside the backend suite) |
| Bundle secret scan (18 client chunks) | **no secret values ✅** |
| Live HTTP transcript (§6.2) | **✅** |

**New tests added by the audit** (only where gaps were real): membership-escalation probes (3), org-creation gating (2), team-roster RLS regression (1), cross-org mutation set (3), rate limiter (2), ZodError→400 regression (1), invalidated-FSM containment enumeration.

**Phase 3 is ready for external review. Phase 4 has not been started.**
