# REVESSENT — Phase 8 Report: Production Hardening & Launch Readiness

Date: 2026-09-07. Base: Phase 7 closed at `67e8bf3`. Phase 8 commits: `56b94bc` (corrections), plus test alignment + env template (this report's commit).
Method: read every phase report and the architecture, then audited the **repository as it is** — reports were treated as claims. Live Stripe / Postmark / Anthropic were **not** called; every provider interaction below ran against the existing deterministic fixtures. Nothing was deployed.

**FINAL VERDICT: `PRODUCTION READY WITH ACCEPTED NON-BLOCKING RISKS`** — conditional on the deployment-specific verifications in §24 (none of which can be performed from a sandbox).

---

## 1. Executive summary

The financial core (Phase 4C/4D execution, 4B tenant webhooks, 5 durable jobs, 6 communications, 7 entitlements/billing) held up under a hostile re-read: no duplicate-execution path, no tenant leak, no client-controlled financial or plan input, no SECURITY DEFINER abuse. The serious problems were at the **edges of the account lifecycle and operations**, all pre-dating Phase 8 and all fixed here:

| # | Severity | Finding | Fixed |
|---|---|---|---|
| A1 | **BLOCKER** | Email verification & password-reset hooks were Phase-3 `console.info` stubs. Org creation requires a verified email ⇒ **no production tenant could ever onboard**; no password could be reset; the stub also logged the user's email in clear. | ✔ |
| A2 | **BLOCKER** | Sign-up / forgot / reset / verify pages were Phase-2 "honest stop" placeholders that never called the working API. | ✔ |
| A3 | HIGH | Auth rate limiter was per-process memory — no protection on a multi-instance web tier. | ✔ (durable, shared, 0024) |
| A4 | HIGH | Password reset did not revoke existing sessions (`revokeSessionsOnPasswordReset` unset). | ✔ |
| A5 | HIGH | Unhandled API errors were `console.error`-ed raw; Drizzle query errors embed SQL + parameters (emails, tokens). | ✔ redacting logger |
| A6 | HIGH | Production could boot with `BETTER_AUTH_URL` unset/`http://` — that value is the origin Stripe is told to deliver tenant webhooks to (`webhookEndpointUrl`) and Better Auth's base URL. | ✔ fail closed |
| A7 | MEDIUM | Sign-in page told real users "Any value of 8+ characters works in the demo" / "resets aren't wired up". | ✔ |
| A8 | MEDIUM | Reset/verify token guessing and verification resends were unlimited. | ✔ |
| A9 | MEDIUM | No web readiness probe; token pages / API had no `Cache-Control: no-store`. | ✔ |
| A10 | LOW | `uuid@13.0.0` moderate advisory (v3/v5/v6 `buf` path; we use v7 without `buf` — not exploitable). | ✔ 13.0.1 |

Test suite after corrections: **52 files / 507 tests green** (+13 new: auth lifecycle 5, production config 5, durable rate limit 2, migration assertions 1).

## 2. Production architecture inventory

| Component | Implementation | Local | Staging | Production |
|---|---|---|---|---|
| Web app | Next 16 (`apps/web`), Route Handlers `/api/v1/*`, BFF only | `next dev` | Vercel (arch §4.4) | Vercel |
| Worker | `apps/worker` (BullMQ 5, ioredis), queues `retries` + `notes`, scheduler loop, `/healthz` on `WORKER_HEALTH_PORT` | `tsx` | Fly/Railway | Fly/Railway |
| Database | Postgres 16, 25 migrations (0000–0024), RLS on every tenant table, roles `revessent_app` (RLS-bound DML) / owner (migrate + scheduler enumeration) | embedded pg 5433 | Neon | Neon pooled |
| Redis | BullMQ delivery only; durable truth is `job_runs`; scheduler re-enqueues from DB | redis-server | managed | managed (TLS) |
| Tenant Stripe | restricted key per org (AES-256-GCM envelope, `KEY_ENCRYPTION_KEY`), per-connection webhook endpoint `/api/v1/webhooks/stripe/{connectionId}` | fixtures | test mode | live |
| Platform billing | `/api/v1/webhooks/billing`, `BILLING_WEBHOOK_SECRET`, `BILLING_LIVEMODE` | fixtures | test | live |
| Email | Postmark adapter (`POSTMARK_SERVER_TOKEN`), fixture provider in tests; **now also carries verify/reset mail** | fixture / none | Postmark test stream | Postmark |
| AI | Anthropic adapter (`ANTHROPIC_API_KEY`), optional; deterministic templates without it | fixture / none | optional | optional |
| Auth | Better Auth 1.7.2, argon2id (noble), Postgres sessions, cookie `rv.session_token` HttpOnly/SameSite=Lax/Secure(prod), 30d sliding | — | — | — |
| Public routes | `/`, marketing, `/c/{token}`, `/unsubscribe/{token}`, `/upgrade/{token}`, `/status`, auth pages, `/api/health` | | | |
| Internal routes | `/app/{slug}/…` (session + membership), `/api/v1/orgs/{slug}/…` (session + role) | | | |
| Migrations | `drizzle-kit migrate` with `MIGRATE_DATABASE_URL` (owner) — CI step | | | |

`apps/api` is an empty placeholder (`.gitkeep`) — not deployed, not referenced.

## 3. Configuration / secrets audit

- **Committed secrets:** none. `git grep` for `sk_live_|rk_live_|whsec_…|sk-ant-|AKIA` hits only fixture strings in tests. `.env.example` / `packages/db/.env.development` hold placeholders / local-only postgres URL without password.
- **Browser exposure:** the only `NEXT_PUBLIC_*` variable in the codebase is `NEXT_PUBLIC_DEMO_MODE`. No `process.env.*` read exists in client components other than `NODE_ENV`.
- **Server-only:** Stripe keys never leave `packages/integrations` (decrypted in-memory per call); Postmark token/Anthropic key read only inside their adapters' factories; DB URLs only in `packages/config`; `KEY_ENCRYPTION_KEY` only in `crypto/`; `BILLING_WEBHOOK_SECRET` only in `billing.ts`.
- **Demo/dev bypasses:** `demoMode()` throws `ConfigError` when requested under `NODE_ENV=production`; `/api/demo/session` answers 404 in production regardless; `setStripeGatewayForTests` / `setEmailProviderForTests` / `setAiProviderForTests` are exported but no application module imports them (grep verified). **Phase 8 added:** `serverEnv()` refuses production unless `BETTER_AUTH_URL` is `https://` and `NEXT_PUBLIC_DEMO_MODE` is unset; `communicationEnv()` already refused non-https `APP_PUBLIC_URL`.
- **Fail-closed matrix (production):** missing `DATABASE_URL`/`BETTER_AUTH_SECRET`/`KEY_ENCRYPTION_KEY` → boot error naming fields only (tested). Missing `POSTMARK_SERVER_TOKEN` → sign-up/reset **throw `AuthEmailNotConfiguredError`** (tested) instead of silently stranding users; customer sends already deferred as `not_configured`. Missing `BILLING_WEBHOOK_SECRET` → billing webhook 400 (Phase 7). Missing `REDIS_URL` → worker refuses to boot.
- Template: `revessent/.env.production.example` (new) lists every variable, which process needs it, and which are mandatory.

## 4. Authentication audit

| Check | Result |
|---|---|
| Passwords | argon2id m=64 MiB t=3 p=4 (env-tunable, min bounds), min length 10 |
| Session | Postgres-backed, 30d sliding (`updateAge` 24h), cookie HttpOnly, SameSite=Lax, `Secure` when `NODE_ENV=production`, prefix `rv` |
| Invalidation | sign-out route; **reset now revokes all sessions** (A4, tested: stale cookie → `null` session) |
| CSRF | `assertSameOrigin` on every `mutation()` route (Origin host must equal Host); auth routes rely on SameSite=Lax + JSON body + Better Auth's own origin check; webhooks are signature-authenticated by design |
| Email verification | **now delivered** (A1): `sendOnSignUp`, 1h token, link built against `APP_PUBLIC_URL` (never Better Auth's unmounted `/api/auth` path); `/api/v1/auth/resend-verification` is **session-bound** (no email in body ⇒ no enumeration / mail-bombing), rate-limited |
| Password reset | request route answers identically for unknown accounts (tested: zero emails for unknown address); token single-use (tested); reset route rate-limited per IP (A8) |
| Org membership / role | `requireOrgRole` resolves slug under `withIdentityTx`, returns **404 for non-members** (no existence oracle), then RBAC `can(role, action)` |
| IDOR | every org-scoped service call passes `ctx.org.id` and runs under `withOrgTx` + RLS |
| Redirects | sign-in `next` param only honoured when it starts with `/`; no other redirect sinks |
| Token leakage | verification/reset tokens are never logged (auth-email logs safe codes only, tested with a failing provider) |

Not changed: Better Auth remains the provider; no TOTP/passkeys (architecture lists them as "available" — deferred product work).

## 5. Tenant isolation audit

Hostile A→B walk over every table class: `organizations` (policy `org_member_read` + `app.org_id` scope), `memberships` (0007/0008 guards), `customers/payments/subscriptions/recovery_cases/recovery_messages/recovery_checkouts/expansion_*/webhook_events/org_subscriptions/audit_logs/job_runs/communication_suppressions` (`org_isolation` on `org_id`), join tables `recovery_attempts`/`payment_attempts` (EXISTS on parent), `ai_generations/ai_usage_budgets` (`org_id`). Verified in the live DB: **zero tenant tables without RLS**; only `auth_rate_limits` (new, pre-auth hashed counters), `idempotency_keys`, Better Auth tables and `sync_state` are non-RLS by design.

SECURITY DEFINER functions (`case_org_id`, `member_write_allowed`, `caller_is_member`, `resolve_webhook_connection`, `resolve_billing_org`, `resolve_billing_org_unlinked`): all `set search_path = public`, `revoke … from public`, `grant execute to revessent_app`, and each returns a single row keyed by an id the caller must already hold (UUID connection id / stored Stripe ids) — no enumeration surface.

Worker: tenant work runs on the RLS-bound app pool; the owner pool (`SCHEDULER_DATABASE_URL`) is used for exactly two reads — org-id enumeration and the org row — as documented in `apps/worker/src/context.ts`. Existing tests cover cross-org communications, entitlements, recovery, sync, webhooks.

## 6. Public endpoint audit

| Endpoint | AuthN | AuthZ | Signature/token | Rate limit | Validated | Tenant-bound | Safe errors | Idempotent |
|---|---|---|---|---|---|---|---|---|
| POST `/api/v1/auth/sign-in` | — | — | — | **durable 5/15m IP+email** | Zod | — | generic | n/a |
| POST `/api/v1/auth/sign-up` | — | — | — | durable | Zod | — | generic | Better Auth unique email |
| POST `/api/v1/auth/request-password-reset` | — | — | — | durable | Zod | — | constant response | yes |
| POST `/api/v1/auth/reset-password` | — | — | token | **durable per IP (new)** | Zod (token ≤500) | — | generic | single-use token |
| POST `/api/v1/auth/verify-email` | — | — | token | **durable per IP (new)** | Zod | — | generic | yes |
| POST `/api/v1/auth/resend-verification` (new) | session | self only | — | durable | — | — | generic | yes |
| POST `/api/v1/auth/sign-out` | session | — | — | — | — | — | — | yes |
| GET `/api/v1/c/{token}` | — | — | 128-bit token, SHA-256 lookup | — (see §12) | regex | token→case→org via RLS token_flow | `unknown` for anything invalid | read |
| POST `/api/v1/c/{token}` | — | — | — | — | — | — | honest 501 (`confirmCheckout` never simulates) | n/a |
| POST `/api/v1/unsubscribe/{token}` | — | — | recovery token | — | regex | token_flow RLS | `unknown` | append-only suppression |
| GET `/api/v1/upgrade/{token}` | — | — | — | — | — | — | static `unknown` | read |
| POST `/api/v1/webhooks/stripe/{orgRef}` | Stripe signature (raw body, 5-min tolerance) | connection→org | ✔ | Stripe retries | UUID + SDK | `resolve_webhook_connection` | 400 safe codes | DB-unique per (source, account, event) |
| POST `/api/v1/webhooks/billing` | Stripe signature + livemode | stored ids only | ✔ | — | SDK | `resolve_billing_org*` | 400 safe codes | DB-unique + per-event lock |
| GET `/api/health` (new) | — | — | — | — | — | — | booleans only | read |
| POST `/api/demo/session` | — | — | — | — | — | — | 404 in production | — |

Hostile inputs exercised by existing tests: malformed/forged/stale-timestamp signatures, forged org ids in metadata, forged subscription ids, token regex rejects, cross-mode events, Zod field-path-only 400s.

## 7. Financial safety audit (re-verified, unchanged)

**Before payment** (`execute.ts` preflight, both reads): connection active + identity verified; provider invoice customer must equal local customer's Stripe id; currency must be present and equal (never converted/defaulted); `amount_due`/`amount_remaining` must be positive integers, equal to each other and equal to the local record (partial payments refuse); amount/currency come **only** from the local payment row, never the request.
**During:** deterministic `manual_retry|payment|amount|currency|customer` request hash; client idempotency keys regex-validated and replay-checked; per-payment advisory lock; stripe-node `maxNetworkRetries: 0`, 15 s timeout; network/5xx/timeouts ⇒ `unknown`, never `failed`.
**After:** `reconcileExecutions` resolves `unknown/executing` from provider truth only; `recovered` requires a provider-confirmed paid invoice; the browser cannot confirm checkout (501).
**Retry (4D):** policy routing fail-closed, `attempt_no` durable and counted only among automated attempts, manual attempts don't consume budgets, `unknown` blocks further automated execution, automated retries call the same 4C primitive. Existing suites: `payment-execution`, `retry-identity` (incl. concurrent final attempt), worker crash matrix A–E.

No payment/retry code was modified in Phase 8.

## 8. Stripe / webhook audit

Both receivers: raw-body official SDK verification, replay window, livemode check, tenant binding through stored identifiers only, durable row **before** processing, per-event advisory lock, provider-timestamp ordering guard (billing) / lifecycle state machine (tenant), `failed` state retained with safe code, reconciliation path read-only toward Stripe.
**Source isolation (Phase 7 audit fix)** re-checked across every reader of `webhook_events`: receiver duplicate lookup, `webhookStatus`, reconcile sweep, billing apply/lookup — all filter `source`; the 0015 unique index is `(org_id, source, coalesce(account,''), external_id)`. Regression test present. Duplicate / concurrent / out-of-order delivery tests passed in this run.

## 9. Worker / job audit

Durable `job_runs` ledger (queued → leased → succeeded/failed/canceled; stale lease `< now()` reclaimable atomically); BullMQ jobs carry deterministic ids and `removeOnFail:false` (dead-letter); scheduler cycle reconciles **Redis loss first** (re-enqueues durable rows missing from Redis) then discovers due work bounded by `WORKER_SCAN_LIMIT`/`WORKER_ORG_LIMIT`; loop never overlaps itself; graceful shutdown stops discovery, drains workers, closes queues/Redis; in-flight leases that cannot finish expire and are reclaimed. Crash matrix tests A–E (before execution / mid-execution / after provider success / after DB transition / restart) + stale-lease race + concurrent duplicate delivery all passed. A crashed worker therefore cannot cause a duplicate charge (4C idempotency + lock), a duplicate email (atomic `pending→sending` claim + provider reference), lost work (durable rows) or a permanently stuck job (lease expiry + Redis re-enqueue).

Single-scheduler assumption: multiple worker replicas are safe (claims are atomic) but each runs the discovery sweep — redundant, not incorrect. Documented as LOW.

## 10. AI / communication audit

AI never touches financial decisions: `packages/ai` outputs only copy; `render.ts` HTML-escapes everything; the CTA URL is application-built from `APP_PUBLIC_URL` + hashed token; `sanitizeUntrusted` strips secret-shaped content from prompts; structured output validated; timeout ⇒ deterministic fallback; provider failures never counted as sends. Delivery: atomic claim, suppression re-checked **at execution time** (Phase 6 fix), unsubscribe via token is append-only, header-injection guards on every header field, Postmark ambiguity (`timeout_after_send`, 5xx) is never auto-resent, `configuration` failures defer without consuming attempts. Entitlement re-check at send time (Phase 7). No change in Phase 8 except reusing the provider boundary for account mail (with the same header guards).

## 11. Error / logging audit

- problem+json everywhere; Zod failures echo field **paths** only; unknown errors → generic 500 "Nothing was changed".
- **Fixed (A5):** `toProblem` now logs `{name, first line of message (≤300 chars, redacted), pg code}` through the redacting logger; previously the raw error object (with Drizzle's `params:` dump) went to stdout.
- **Fixed (A1):** auth hooks no longer log user emails.
- Redaction covers Stripe secret/restricted keys, `whsec_`, session cookies, bearer tokens, emails; worker additionally strips `redis://` URLs. `LOG_LEVEL` env now selects the threshold (default `warn`).
- Remaining `console.*` in production paths: none in `packages/server`/`apps/web` app code (grep). Better Auth's own logger emits e.g. "Invalid password" warnings without identifiers.

## 12. Abuse / rate-limit audit

Wired **durably** now: sign-in, sign-up, reset request (IP+email), reset-token, verify-token, resend-verification (per IP / per account). Implementation: one atomic UPSERT on `auth_rate_limits` (hashed key; tested: 20 concurrent attempts ⇒ exactly 5 admitted; different IP independent; no clear-text at rest). In-memory window remains only as the fallback if the DB statement fails.
Not added (documented): `/c/{token}` and `/unsubscribe/{token}` GET/POST — 128-bit tokens make enumeration infeasible and the lookup is a single indexed hash read; architecture's "10/h/IP" is an edge/WAF-level control (deployment-specific, §24). Payment execution is session+role-gated and serialised by the payment lock; webhooks are signature-gated and DB-unique.

## 13. Database audit

- 25 forward migrations; fresh bootstrap test + upgrade replays from **4C/4D/5/6/7** with seeded rows preserved, RLS complete, grants correct (this run).
- Indexes: `org_id`-leading secondary indexes per convention; lookups added in 0015/0023/0024 for webhook uniqueness, billing ids, rate-limit windows.
- FKs: `on delete cascade` from `organizations` downwards (an org delete removes its tenant data — there is **no** org-delete endpoint, so this is a latent operator footgun only; documented MEDIUM). `payments → subscriptions` is `set null`; `recovery_attributions → payments` is `no action` (financial attribution cannot be silently cascaded).
- Application `DELETE` statements: only `stripe_connections` during connect-failure compensation / replacement (Phase 4B); no financial row is ever deleted; `audit_logs` is append-only at the grant level (`INSERT,SELECT` only, verified after every upgrade path).
- Uniqueness under races: webhook events (partial unique index), job runs (live-row uniqueness), seats (advisory lock), executions (idempotency key), billing events (per-event lock + `FOR UPDATE`).
- Unbounded queries: `listCases`, `listOpportunities`, team lists load a full org's rows then filter in memory; customers capped at 100. Bounded by tenant size (Ember cap 1,000 members) — MEDIUM, not a launch blocker.
- Nullable financial fields: `payment_executions.amount_cents/currency` nullable by design (unknown ≠ 0) and refused at preflight.

## 14. Redis audit

BullMQ only. No business state exists solely in Redis: `job_runs` is authoritative, the scheduler re-enqueues missing jobs every cycle, deterministic job ids make double-enqueue converge, worker start does not require Redis history. Loss of Redis ⇒ delays, never corruption (tests: Redis-loss reconciliation, restart E). `REDIS_URL` is treated as a credential (never logged; error messages scrubbed). Transient failures surface as queue/worker `error` events that are logged, not fatal.

## 15. Observability / health audit

Minimum visibility exists as **durable rows + audit actions**, which is the right primary signal for this system: payment outcomes (`payment_executions.status` incl. `unknown`), retry decisions (`recovery_attempts`), webhook failures (`webhook_events.status/last_error` + `webhookStatus()` in the Stripe settings UI), job failures (`job_runs`), email failures (`recovery_messages.last_send_error_code` + audit `communication.*`), AI fallbacks (`fallbackReason`), billing transitions (audit `billing.*`, `entitlement.*`), auth events (Better Auth logger + 429s). Worker `/healthz` reports Redis/DB liveness, scheduler last cycle/stats/errors. **Added:** web `/api/health` (config valid? DB reachable? email/billing secret present? — booleans only, `no-store`, 503 when not ready). Log transport is stdout (JSON-ish structured fields) — shipping to Axiom/Sentry is a deployment concern (§24).

## 16. Frontend audit

- Routes: all `(app)` pages resolve through `resolveSession` + membership; unknown slug → 404 via API. Marketing/pricing are static.
- **Fixed:** sign-up / forgot / reset / verify views now perform the real flows (real mode) while demo mode keeps its labelled behaviour; sign-in demo copy no longer shows to real users; onboarding surfaces the "verify first" path with a resend link.
- No fake success states in real mode: checkout confirm → honest 501 UI; upgrade token → `unknown`; recovery token page shows a "(demo) validation" button only under the demo fixture (it calls no API — LOW: copy still says "Phase 5 backend").
- Entitlement gating is display-only from the server DTO; server enforces (Phase 7).
- Loading/error states use existing `Skeleton`/`ErrorState`; new views reuse `Surface`/`FormField`/`Button` — visual language preserved. Web test project: 14 files / 109 tests green.
- Not audited to WCAG depth: existing a11y patterns (`role=status/alert`, `aria-live`) reused in the new views; mobile nav test present.

## 17. Browser / security-header audit

Middleware sets `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` minimal, `X-Frame-Options: DENY`, `CSP: frame-ancestors 'none'`, HSTS (2y, preload) in production. **Added:** `Cache-Control: no-store` on `/api/*`, `/c/*`, `/unsubscribe*`, `/reset-password`, `/verify-email`. Cookies: HttpOnly/SameSite=Lax/Secure(prod). CORS: none opened (same-origin BFF). CSRF: origin/host equality on mutations.
**Not added:** a full nonce-based script CSP — the layout uses an inline theme script and Stripe-hosted surfaces are planned for the checkout shell; a strict CSP must be introduced with real Stripe URLs in staging (§24). Documented MEDIUM.

## 18. Dependency audit

Pinned: next 16.3.4, react 19.2.8, better-auth 1.7.2, stripe 22.6.1, bullmq 5.81.4, ioredis 5.11.1, drizzle-orm 0.45.2, pg 8.23.0, zod 4.5.4, uuid **13.0.1** (bumped). `pnpm install --frozen-lockfile --offline` succeeds (lockfile consistent). `pnpm audit --prod` after the bump: **1 moderate** — `esbuild` dev-server advisory reachable only through vitest/tsx tooling (dev-only, not in production paths). No mass upgrade performed. Engine field `>=24` vs. sandbox Node 22 — the app runs on 22 here; production images should honour `>=24` (§24).

## 19. Build / reproducibility audit

Verified in this sandbox: `pnpm install --frozen-lockfile` → `turbo run typecheck lint` (18/18) → `NEXT_PUBLIC_DEMO_MODE=off turbo run build` (web + worker) → `drizzle-kit migrate` on a fresh DB and on 5 upgrade paths → web `next start -H 0.0.0.0` and worker `tsx src/main.ts` both boot from env alone (worker refuses without `REDIS_URL`; web refuses production without https origin). Required variables documented in `.env.production.example`.

## 20. Backup / recovery assessment

**Must be durable (Postgres):** organizations, memberships, stripe_connections (ciphertext — useless without `KEY_ENCRYPTION_KEY`, which must be backed up separately in the secret manager), customers/subscriptions/payments, recovery_cases/attempts/messages/checkouts/attributions, payment_executions, job_runs, communication_suppressions (legal), org_subscriptions, webhook_events (idempotency history), audit_logs.
**Reconstructible:** Redis entirely (scheduler re-enqueues), `sync_state` (a fresh backfill), `auth_rate_limits`, AI generations (regenerable copy).
**Policy required:** Neon PITR (architecture: RPO ≤ 5 min) + daily logical dumps; restore drill before launch; `KEY_ENCRYPTION_KEY` rotation runbook (re-encrypt job not yet built — LOW, keys are rotatable by re-connecting Stripe).
No data-loss vulnerability was found in application code (no destructive endpoints; append-only audit; cascade only through a non-existent org delete).

## 21. Issues found (complete register)

| ID | Sev | Area | Evidence | Risk | Recommendation | Fixed |
|---|---|---|---|---|---|---|
| A1 | BLOCKER | auth | `auth.ts` hooks `console.info` only; `orgs.ts:35` requires verified email | no tenant can onboard; PII in logs | wire to existing provider, fail closed in prod | ✔ |
| A2 | BLOCKER | frontend | sign-up/forgot/reset/verify views stop locally | flows unusable | wire to existing endpoints | ✔ |
| A3 | HIGH | abuse | `ratelimit.ts` `Map` per process | brute force on multi-instance | durable shared counter (0024) | ✔ |
| A4 | HIGH | auth | `revokeSessionsOnPasswordReset` unset | attacker keeps session after victim resets | enable | ✔ |
| A5 | HIGH | logging | `api-route.ts` `console.error(e)` | SQL params (emails/tokens) in logs | redacting logger, name+message only | ✔ |
| A6 | HIGH | config | `webhookEndpointUrl` falls back to `http://localhost:3000` | tenant webhooks registered to localhost in a misconfigured prod | prod requires https `BETTER_AUTH_URL` | ✔ |
| A7 | MEDIUM | frontend | sign-in demo hints for real users | confusion / demo leakage | conditional copy | ✔ |
| A8 | MEDIUM | abuse | reset/verify token endpoints unlimited | token guessing | per-IP durable limit | ✔ |
| A9 | MEDIUM | ops | no web readiness; cacheable token pages | cannot distinguish DB down vs config; shared-cache leakage | `/api/health`, `no-store` | ✔ |
| A10 | LOW | deps | uuid 13.0.0 advisory | none (unused code path) | bump | ✔ |
| R1 | MEDIUM | headers | no script CSP | XSS blast radius | nonce CSP once Stripe surfaces are known | deferred (§24) |
| R2 | MEDIUM | db | in-memory filtering of org-wide lists | latency at 1k+ cases | paginate when growth demands | deferred |
| R3 | MEDIUM | db | `on delete cascade` from organizations | operator footgun on manual delete | never delete orgs manually; erasure job later | documented |
| R4 | LOW | worker | multi-replica discovery duplicates work (safe) | wasted cycles | leader lock if scaling workers | deferred |
| R5 | LOW | frontend | recovery-token page copy references "Phase 5 backend" | cosmetic | update with checkout session work | deferred product |
| R6 | LOW | auth | no TOTP/passkeys; no HIBP check | account takeover resilience | product roadmap | deferred product |
| R7 | LOW | crypto | no `KEY_ENCRYPTION_KEY` re-encrypt job | rotation requires re-connect | build when first rotation is scheduled | deferred |
| P1 | DEFERRED PRODUCT | billing | Ember member cap reported not enforced (Phase 7 D1) | cost | owner decision | — |
| P2 | DEFERRED PRODUCT | checkout | Stripe Checkout Session / hosted card update not built | recovery checkout ends at 501 | next product phase | — |
| P3 | DEFERRED PRODUCT | digest | `weekly_digest` no consumer | — | — | — |

## 22. Corrections made (files)

`packages/server/src/auth/auth-email.ts` (new), `auth.ts`, `http/ratelimit.ts` (rewritten, API-compatible), `context.ts` (+`pingDatabase`), `index.ts`, `services/orgs.ts` (message), `packages/config/src/index.ts` (prod gates, `resetServerEnvForTests`), `packages/observability/src/index.ts` (`LOG_LEVEL`), `packages/db/drizzle/0024_auth_rate_limits.sql` + journal + `schema.ts`, `packages/db/package.json` (uuid), `apps/web/src/lib/{api-route,auth-actions}.ts`, `middleware.ts`, `app/api/health/route.ts` (new), `app/api/v1/auth/{sign-in,sign-up,request-password-reset,reset-password,verify-email}/route.ts`, `app/api/v1/auth/resend-verification/route.ts` (new), `views/{sign-in,sign-up,forgot-password}-view.tsx`, `views/{reset-password,verify-email}-view.tsx` (new), `views/onboarding-view.tsx`, `(auth)/{reset-password,verify-email}/page.tsx`, `.env.production.example` (new). Tests: `auth-lifecycle.test.ts` (new), `production-config.test.ts` (new), `ratelimit.test.ts` (+2), `migrations.test.ts` (+0024), `communication.test.ts` / `demo-safety.test.ts` (aligned to new behaviour).

## 23. Remaining risks (accepted, non-blocking)

R1–R7 above. None affects financial integrity, tenant isolation or authentication correctness.

## 24. Deployment-specific verification requirements

1. **Live Stripe (test mode first):** connect a restricted key, confirm endpoint registration at `https://<BETTER_AUTH_URL>/api/v1/webhooks/stripe/{id}`, deliver `invoice.payment_failed`, run one manual retry against a test invoice, confirm `unknown` reconciliation path with a forced timeout.
2. **Platform billing:** point the Stripe Billing endpoint at `/api/v1/webhooks/billing` with `BILLING_LIVEMODE` matching; confirm plan transition in `org_subscriptions`.
3. **Postmark:** verified sender domain; deliver one verification + one reset email to a controlled inbox; confirm bounce/suppression handling (422/406 paths).
4. **Anthropic:** optional; verify timeout → fallback in staging.
5. **Edge controls:** rate limit `/c/*` (10/h/IP per architecture) and general WAF at Vercel/Cloudflare; strict CSP rollout with real Stripe-hosted URLs.
6. **Infra:** Neon PITR + dump schedule + restore drill; Redis TLS; worker `/healthz` wired to the platform health check; `/api/health` wired to Vercel checks; log shipping; secret manager holding `KEY_ENCRYPTION_KEY` with an offline backup; Node ≥ 24 runtime.
7. **Process:** run `drizzle-kit migrate` with the owner URL before first boot; confirm `auth_rate_limits` exists.

## 25. Production launch checklist

**BLOCKER** — none remaining (A1, A2 fixed and tested).
**HIGH** — A3–A6 fixed; remaining HIGH: none in code. Deployment: items 1–3 and 6 of §24 must be completed before real customers.
**MEDIUM** — R1 CSP, R2 pagination, R3 cascade discipline; A7–A9 fixed.
**LOW** — R4–R7, A10 fixed.
**DEFERRED PRODUCT WORK** — P1–P3, TOTP/passkeys, HIBP, key re-encrypt job, weekly digest, Stripe Checkout Session.

## 26. Scope confirmation

No new product features. No changes to payment execution, retry engine, tenant/billing webhook processing, AI/communication logic, entitlement resolver or job architecture (verified via `git diff 67e8bf3..HEAD --stat`: changes confined to auth lifecycle, rate limiting, config gates, logging, health, headers, views for existing flows, one migration, tests, env template). No Phase 9 created. Nothing deployed; no live provider called.

## 27. Final verdict

**PRODUCTION READY WITH ACCEPTED NON-BLOCKING RISKS**

Gates (all re-run after corrections): full Vitest **52 files / 507 tests passed, 0 skipped**; TypeScript + ESLint 18/18; production build 2/2; fresh migrations 0000–0024; upgrade replays from 4C, 4D, 5, 6, 7 (rows preserved, RLS complete, grants verified); concurrency (seats, billing events, retry final attempt, rate-limit 20-way); webhook duplicate/out-of-order; worker crash/restart A–E; payment unknown-outcome; entitlement downgrade; suppression; production config gates; secret scan clean; dependency audit 1 dev-only moderate; scope audit clean.

Verified in sandbox = everything above. Not live-tested = Stripe, Postmark, Anthropic network paths. Requires deployment-specific verification = §24.
