# REVESSENT — $0 Staging Deployment Report

**Date:** 2026-09-07 · **Branch:** `arena/01a077b8-revessent` · **Code under test:** `0c69e34` (Phase 8 final verification) plus this report and `render.yaml`
**Target:** Render Free (web + worker) · Supabase Free Postgres · Upstash Free Redis · no custom domain · GitHub is the source.

## Status legend

| Tag | Meaning |
|---|---|
| **VERIFIED** | Actually executed in this session; evidence recorded below. |
| **NOT VERIFIED** | Technically possible but not executed (usually because it depends on a step that is BLOCKED). |
| **BLOCKED** | Could not be done from this environment. Reason stated. |

## Headline (read this first)

**Nothing has been deployed to Render, Supabase or Upstash. There is no public URL.**
The sandbox in which this work runs has **no outbound network access** to `api.render.com`, `api.supabase.com`, `api.upstash.com`, GitHub-connected Render dashboards, or any provider API, and holds **no provider credentials** (only a GitHub token). Provisioning, deploying and probing a public URL are therefore **BLOCKED**, not skipped. Inventing a URL or a "deployed" state would violate the task's own rules, so this report does not.

What **was** done:

1. Every deployment-relevant fact was taken from the repository itself (scripts, env schemas, health endpoints, webhook routes, migrations, worker bootstrap). No commands were guessed.
2. A **committed, secret-free `render.yaml`** (repo root) encodes the exact Render topology, build/start commands and env-var *names* for the two services — ready for the operator to click "New → Blueprint".
3. A full **local staging rehearsal** was executed with the exact production commands and env shape: empty database → 26 migrations → RLS/grants/SECURITY DEFINER checked with the non-superuser app role → `next start` in `NODE_ENV=production` with demo mode off → worker started against a real Redis → health, auth, webhook, checkout and security routes exercised → worker queue/dup-safety suites run against a real Redis.
4. Free-tier limits were checked against the providers' current documentation, including one that changes the plan: **Render has no free Background Worker plan.**

Overall status: **CONFIGURATION-READY; DEPLOYMENT BLOCKED FROM THIS ENVIRONMENT.** An operator with dashboard access can complete the deployment by following §20 without touching application code.

---

## 1. Deployment architecture

```
                GitHub (main) ──auto-deploy──►  Render (Singapore region, Free plan)
                                                ┌──────────────────────────────────────┐
  browser / Stripe (test) ─── HTTPS ──────────► │ revessent-web-staging   (Web, Free)   │──┐
                                                │   next start -H 0.0.0.0 -p 3000       │  │
                                                │   /api/health  /api/v1/**  /c/{token} │  │
                                                └──────────────────────────────────────┘  │
                                                ┌──────────────────────────────────────┐  │  TLS
  (health probe only) ─── HTTPS ──────────────► │ revessent-worker-staging (Web*, Free) │  │
                                                │   tsx src/main.ts  (BullMQ + sched.)  │──┤
                                                │   /healthz on $PORT                   │  │
                                                └──────────────────────────────────────┘  │
                                                                                          ▼
                              Upstash Redis Free (rediss://)  ◄───────── BullMQ queues: retries, notes
                              Supabase Postgres Free (session pooler :5432, TLS) ◄─ role revessent_app (RLS) / owner (migrate, scheduler)
```

\* **Why the worker is a "Web" service:** Render's Free plan exists only for Web Services, Postgres, Key Value and Static Sites; *"Other service types don't support Free instances"* ([render.com/docs/free](https://render.com/docs/free)). A `type: worker` service cannot be $0. The repository's worker already exposes an HTTP health server (`apps/worker/src/health.ts`, bound via `WORKER_HEALTH_PORT` in `bootstrap.ts:93-97`), so it can run **unchanged** as a second free web service with `WORKER_HEALTH_PORT=$PORT`. The worker is **not** collapsed into the Next.js process — the architecture does not support that and it was not done.

**Consequence to accept (see §18):** free web services spin down after 15 minutes without inbound traffic; a spun-down worker does not poll. The worker service is therefore usable for supervised smoke tests, not for continuous background processing. Continuous worker operation requires the smallest paid Background Worker — explicitly out of scope for this task.

## 2. Providers used

| Layer | Provider / plan | Status |
|---|---|---|
| Web | Render Web Service, `plan: free`, Node 24.14.1 (pinned via `NODE_VERSION`; repo `engines` is `>=24`) | BLOCKED (not provisioned) |
| Worker | Render Web Service, `plan: free` (see §1) | BLOCKED (not provisioned) |
| PostgreSQL | Supabase Free (500 MB, shared Supavisor pooler) | BLOCKED (not provisioned) |
| Redis | Upstash Redis Free (500K commands/month, 256 MB, TLS) | BLOCKED (not provisioned) |
| DNS / domain | none — `*.onrender.com` only | n/a |
| Cloudflare | not used (per task) | n/a |
| Source | GitHub `360nohop3/revessent-`, branch `main` for auto-deploy (`render.yaml` sets `branch: main`; deploy the merged commit, not this working branch) | VERIFIED (repo readable) |

## 3. Public URL

**No public URL exists.** Render assigns `https://<service-name>-<hash>.onrender.com` only after the first deploy. The value must be pasted into `BETTER_AUTH_URL` and `APP_PUBLIC_URL` on **both** services after creation (Better Auth derives its base URL from `BETTER_AUTH_URL`, `packages/server/src/auth/auth.ts:45`; tenant webhook URLs are built from the app origin, `packages/server/src/services/webhooks.ts:60`). — **BLOCKED**

Rehearsal note: the sandbox preview origin `https://3000-i4yaopav9ogc1eke53moa.e2b.app` was used as the `BETTER_AUTH_URL` for the local rehearsal so that origin/CSRF logic ran with a realistic HTTPS origin. It is a temporary sandbox address, **not** the staging URL, and will not be reachable after this session.

## 4. Web service

| Item | Value (from repo) | Status |
|---|---|---|
| Install | `corepack pnpm install --frozen-lockfile` (`packageManager: pnpm@10.34.5`) | VERIFIED locally |
| Build | `pnpm turbo run build --filter=@revessent/web` → `next build --webpack` | VERIFIED (build from 0c69e34 reused; `NEXT_PUBLIC_DEMO_MODE=off`) |
| Start | `pnpm --filter @revessent/web start` → `next start -H 0.0.0.0 -p 3000` (binds all interfaces) | VERIFIED locally |
| Port | Script hardcodes 3000 → `render.yaml` sets `PORT=3000` so Render's port detection agrees. No script change made. | config only |
| Health check path | `/api/health` | VERIFIED locally (§10) |
| Runtime memory | 512 MB free instance; `next start` idle RSS in rehearsal ≈ 150–250 MB — expected to fit; first cold request after spin-down ≈ 1 min | NOT VERIFIED on Render |

## 5. Worker service

| Item | Value (from repo) | Status |
|---|---|---|
| Start | `pnpm --filter @revessent/worker start` → `tsx --conditions react-server src/main.ts` | VERIFIED locally |
| Build | none needed at runtime (tsx); `pnpm install` only | VERIFIED |
| Health | `GET /health` and `/healthz` on `WORKER_HEALTH_PORT`; returns 200 `{ok:true}` or **503** when Redis/DB is down | VERIFIED locally: 200 with Redis up; **503 `redis:"down"`** observed when the rehearsal Redis was stopped (fail-honest, no crash) |
| Redis URL handling | 4 `new Redis(url)` sites (bootstrap, retries, notesWorker, retryWorker); ioredis accepts `rediss://` → Upstash TLS URL works without code change | VERIFIED by inspection; NOT VERIFIED against Upstash |
| Poll interval | `WORKER_POLL_MS` (min 1000, default 15000) — set to 30000 in `render.yaml` to conserve Upstash commands | config only |
| DB connections | `DATABASE_URL` (app role, RLS) + optional `SCHEDULER_DATABASE_URL` (owner; org enumeration only, `bootstrap.ts:30`) | VERIFIED locally with both |
| Free-plan caveat | Spins down without inbound traffic; not continuous (§18) | — |

## 6. PostgreSQL (Supabase)

**Connection mode decision (important):** on Supabase Free the direct host `db.<ref>.supabase.co:5432` is **IPv6-only**; Render egress is IPv4. Use the **Supavisor session pooler** `aws-<region>.pooler.supabase.com:5432` for **all** REVESSENT connections, including the worker: `packages/db/src/client.ts` takes **session-level advisory locks** for the worker, which are incompatible with the transaction-mode pooler on port 6543. Source: [Supabase connection docs](https://supabase.com/docs/guides/database/connecting-to-postgres). Append `?sslmode=require` to every URL (`pg-connection-string` honours it; TLS is mandatory on Supabase).

**Role provisioning:** migration `0001` grants to a role named `revessent_app` that **no migration creates**. Before running migrations the operator runs once, as the Supabase `postgres` user (SQL editor):

```sql
CREATE ROLE revessent_app LOGIN PASSWORD '<generate; store only in Render env>';
GRANT CONNECT ON DATABASE postgres TO revessent_app;
```

The role must be **non-superuser, without BYPASSRLS** — this is what makes RLS binding. — **BLOCKED** on Supabase (project not created); the identical procedure was **VERIFIED** locally.

Migrations contain no `CREATE EXTENSION`, `ALTER SYSTEM` or other superuser-only statements (grep over `packages/db/drizzle/0000–0025`), so the Supabase `postgres` owner role is sufficient. — **VERIFIED by inspection**

## 7. Redis (Upstash)

| Item | Status |
|---|---|
| Client compatibility: BullMQ over ioredis with a `rediss://` URL, no code change | VERIFIED by inspection; NOT VERIFIED against Upstash |
| Enqueue / claim / dedupe semantics against a real Redis server | **VERIFIED locally** (§12) |
| Command-budget estimate (Upstash Free = 500 000 commands/month): BullMQ workers use blocking `BZPOPMIN`/`BRPOPLPUSH`-style waits plus stalled-job checks (default every 30 s per worker) and the scheduler cycle every `WORKER_POLL_MS`. With 2 queues and 30 s polling, idle consumption is on the order of **~10–15k commands/day ≈ 300–450k/month if the worker ran 24×7** — close to the cap. Because the free worker spins down when idle this is not expected to be hit during supervised smoke tests, but it **would** be hit by a continuously running worker. | estimate, NOT VERIFIED |
| Credentials server-only: `REDIS_URL` is in `WorkerEnvSchema` only; no web/browser code references it (`grep` of `apps/web/src`, `packages/server/src`: zero hits) | VERIFIED |

## 8. Environment configuration (names only — no values anywhere in git)

Source of truth: `packages/config/src/index.ts` (`ServerEnvSchema`, `WorkerEnvSchema`) and `.env.production.example`. `render.yaml` mirrors this list with `sync: false` for every secret.

| Group | Variable | Web | Worker | Notes |
|---|---|---|---|---|
| Core | `NODE_ENV=production` | ✔ | ✔ | |
| Core | `NEXT_PUBLIC_DEMO_MODE=off` | ✔ | ✔ | **Must not be enabled** (§6 of task). Rehearsal ran with it off. |
| Core | `PORT` | `3000` | `8081` | Render port detection. |
| Core | `NODE_VERSION=24.14.1` | ✔ | ✔ | `engines >=24` is unbounded; pin explicitly. |
| Core | `LOG_LEVEL` | ✔ | ✔ | optional |
| Auth | `BETTER_AUTH_SECRET` | ✔ | ✔ same value | `generateValue` on web; copy to worker. |
| Auth | `KEY_ENCRYPTION_KEY` (base64 32 B) | ✔ | ✔ same value | encrypts tenant Stripe keys |
| Auth | `BETTER_AUTH_URL`, `APP_PUBLIC_URL` | ✔ | ✔ | real `https://…onrender.com` URL, set after first deploy |
| DB | `DATABASE_URL`, `APP_DATABASE_URL` | ✔ | ✔ | role `revessent_app`, session pooler :5432, `?sslmode=require` |
| DB | `SCHEDULER_DATABASE_URL` | – | ✔ | owner role, session pooler |
| DB (operator machine only) | `MIGRATE_DATABASE_URL` | – | – | never on Render |
| Redis | `REDIS_URL` (`rediss://`) | – | ✔ | |
| Worker tuning | `WORKER_HEALTH_PORT=8081`, `WORKER_POLL_MS=30000` | – | ✔ | |
| Optional email | `POSTMARK_SERVER_TOKEN`, `POSTMARK_MESSAGE_STREAM`, `EMAIL_FROM_ADDRESS` | ✔ | ✔ | unset ⇒ health `email:"missing"`, sends fail closed |
| Optional AI | `ANTHROPIC_API_KEY`, `AI_MODEL`, `AI_TIMEOUT_MS` | ✔ | ✔ | unset ⇒ AI features report unavailable |
| Optional billing | `BILLING_WEBHOOK_SECRET` (TEST mode), `BILLING_LIVEMODE=false` | ✔ | – | unset ⇒ `/api/v1/webhooks/billing` returns 400 "not configured" |

Secret hygiene: `render.yaml` contains no values; `.gitignore` excludes `.env*`; `git grep` for `sk_live`, `postgres://…@` with passwords and `rediss://` in tracked files: none. — **VERIFIED**

## 9. Migration status

Rehearsal database `revessent_staging_rehearsal` (local Postgres 127.0.0.1:5433, fresh):

| Step | Result | Status |
|---|---|---|
| Starting state | `drizzle.__drizzle_migrations` does not exist — **0 applied** | VERIFIED |
| Command | `MIGRATE_DATABASE_URL=… pnpm --filter @revessent/db migrate` (= `drizzle-kit migrate`) | VERIFIED |
| Final state | **26 applied (0000–0025)**, "migrations applied successfully" | VERIFIED |
| RLS | every `public` table has RLS enabled except `auth_rate_limits` (by design, Phase 8); **38 policies** | VERIFIED |
| Grants | e.g. `audit_logs` → `revessent_app`: `INSERT, SELECT` only (no UPDATE/DELETE) | VERIFIED |
| SECURITY DEFINER | exactly the 6 expected: `case_org_id, member_write_allowed, caller_is_member, resolve_webhook_connection, resolve_billing_org, resolve_billing_org_unlinked` | VERIFIED |
| App role | `revessent_app`: `rolsuper=false`, `rolbypassrls=false` | VERIFIED |
| Manual schema edits | none | VERIFIED |
| Same run against Supabase | — | BLOCKED |

## 10. Health

`GET /api/health` (apps/web/src/app/api/health/route.ts) in `NODE_ENV=production`, no optional providers configured:

```
200 {"ok":true,"config":"ok","db":"up","email":"missing","billingWebhook":"missing","latencyMs":21}
```
— **VERIFIED locally**, requested with the HTTPS preview `Host` header. The endpoint reports missing integrations honestly instead of hiding them. Worker `/healthz`: 200 when healthy, 503 when Redis down (§5). From a public Render URL: **BLOCKED**.

## 11. Authentication (Better Auth, `/api/v1/auth/*`)

Rehearsal against the production build with a fresh user (`stage-<ts>@example.test`, HTTPS origin headers):

| Flow | Result | Status |
|---|---|---|
| Sign-up `POST /api/v1/auth/sign-up` | 200, user created, `emailVerified:false`, no secret echoed | VERIFIED |
| Session cookie | `__Secure-rv.session_token; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000` | VERIFIED (correct for HTTPS-only Render) |
| Sign-in | 200 with session | VERIFIED |
| `GET /api/v1/auth/session` with cookie / without | 200 `{user, memberships:[]}` / 401 | VERIFIED |
| Sign-out then session | `{"success":true}` → 401 | VERIFIED |
| Password-reset request | 200 `{"accepted":true,"emailSent":false}` — no enumeration, honest about no provider | VERIFIED |
| Email verification link | **cannot be exercised**: no email provider ⇒ `auth-email.ts:58` fails closed in production, no link is issued | NOT VERIFIED (by design without Postmark) |
| Reset-password completion | depends on emailed token | NOT VERIFIED |
| Create workspace while unverified `POST /api/v1/orgs` | **403** "Verify your email before creating a workspace" | VERIFIED (fail-closed gate `orgs.ts:35`) |
| Cross-origin mutation (`Origin: https://evil.example`) | **403** `/errors/csrf` | VERIFIED |
| On the real Render URL | — | BLOCKED |

**Implication:** without Postmark test credentials on staging, a new user can sign up and sign in but **cannot** verify, create a workspace, or reach any tenant feature. This is the intended fail-closed behaviour, and it means the staging environment is *not* end-to-end usable until `POSTMARK_*` are set (§14).

## 12. Worker status & smoke test

Real `redis-server` (port 6391 for the runtime rehearsal; the repo's test Redis on 6399 for suites) and the app role DB.

| Check | Result | Status |
|---|---|---|
| Boot with production env shape (`REDIS_URL`, `SCHEDULER_DATABASE_URL`, `WORKER_HEALTH_PORT`) | scheduler cycling, `cycleErrors:0`, health 200 | VERIFIED |
| Safe non-financial job — `notes-queue.test.ts` (12 tests): duplicate `communication.prepare` enqueues converge on **one durable row + one Redis job**; prepare→send delivers exactly one message/email via **fake** providers; payload forgery does nothing; stale-lease reclaim doesn't double-send; Redis loss reconstruction; suppression | 12/12 | VERIFIED |
| Enqueue / claim / dedupe — `queue-identity.test.ts` (7) + `durable-lifecycle.test.ts` (7): deterministic job id, durable-row-first, raw duplicate `add` doesn't duplicate, atomic claim (one winner of two), live lease never reclaimed, dead-letter budget | 14/14 | VERIFIED |
| Real BullMQ runtime — `worker-runtime.test.ts` (3): enqueue → deliver → execute exactly once; worker never calls the payment provider directly; graceful close | 3/3 | VERIFIED |
| Real payment / real email / real AI call | none performed (fakes only) | by design |
| Same against Upstash + Supabase | — | BLOCKED |

Note for the reviewer: an initial run showed 2 failures in `queue-identity.test.ts` because the rehearsal Redis had been started on port **6390**, which that test uses as its guaranteed-dead port. Moving the rehearsal Redis to 6391 gave 7/7. No code or test was changed.

## 13. Stripe (TEST mode only)

| Item | Status |
|---|---|
| Canonical platform billing webhook `POST /api/v1/webhooks/billing`; tenant webhook `POST /api/v1/webhooks/stripe/{orgRef}`; **no other webhook routes** exist under `apps/web/src/app/api` | VERIFIED |
| Unsigned/unconfigured requests: billing → **400** "Billing webhook endpoint is not configured."; tenant with unknown ref → **400** "Unknown webhook endpoint."; `GET` → 405 | VERIFIED |
| Stripe TEST keys present in this environment | none → **stopped at configuration readiness** | BLOCKED |
| Endpoint to register in Stripe (test) after deploy | `https://<web-url>/api/v1/webhooks/billing` (signing secret → `BILLING_WEBHOOK_SECRET`); tenant endpoints are created by the app per connection | NOT VERIFIED |
| Live keys | never entered (task rule) | — |

## 14. Postmark (email)

Not configured (no safe test credentials available). Health reports `email:"missing"`; production sends fail closed; reset requests return `emailSent:false`. No real customer email can be sent. — **BLOCKED (credentials)**. Render Free additionally blocks outbound SMTP ports 25/465/587, which is irrelevant here because Postmark is used over HTTPS.

## 15. AI (Anthropic)

Not configured; AI-backed features report unavailability rather than fabricating output (Phase 8 verified behaviour; provider fakes used in the worker suites). — **BLOCKED (credentials)**

## 16. Hosted Recovery Checkout (`/c/{token}`)

| Check | Result | Status |
|---|---|---|
| `GET /c/<junk>` page renders (200) with `Cache-Control: no-store`, `X-Frame-Options: DENY`, CSP `frame-ancestors 'none'`, HSTS | VERIFIED |
| `GET /api/v1/c/<junk>` → 200 `{state:"unknown", …nulls}` (no enumeration, no crash) | VERIFIED |
| `POST /api/v1/c/<junk>` cross-origin → 403 CSRF; same-origin → `{state:"unknown"}` (no session created) | VERIFIED |
| End-to-end with Stripe test Checkout Session (link → hosted page → webhook → `applyCheckoutCompletion`) | **pending deployment verification** (needs Stripe test creds + public URL) | NOT VERIFIED |

## 17. Security checks (post-deploy set, run locally on the production build)

| Check | Result |
|---|---|
| Unauthenticated `/api/v1/auth/session` → 401; `/api/v1/orgs` → 401 | VERIFIED |
| Cross-origin mutations blocked (403) on auth and checkout routes | VERIFIED |
| Cookies `Secure; HttpOnly; SameSite=Lax`, `__Secure-` prefix | VERIFIED |
| Security headers present (HSTS, XFO DENY, CSP frame-ancestors none, no-store on token pages) | VERIFIED |
| Error bodies are RFC-7807 problems; no stack traces, no secrets | VERIFIED |
| App DB role non-super, no BYPASSRLS; RLS on all tenant tables | VERIFIED |
| `NEXT_PUBLIC_DEMO_MODE` off in production build and in `render.yaml` | VERIFIED |
| No secrets in git (`render.yaml` names only; `.env*` ignored) | VERIFIED |
| Same checks from the public URL, TLS certificate, Render header pass-through (`X-Forwarded-Proto`) | BLOCKED |

## 18. Free-tier limitations (honest list)

**Render Free** ([docs](https://render.com/docs/free)): no free Background Worker; web services spin down after 15 min idle (≈1 min cold start — Stripe webhook retries tolerate this, interactive users notice it); **750 instance-hours per workspace per month shared by all free web services** — two services running continuously (2×~720 h) exceed it and *all* free services are suspended for the rest of the month; 512 MB RAM / 0.1 CPU; instance may restart at any time; ephemeral filesystem; no shell, pre-deploy command, one-off jobs or SSH; outbound bandwidth overage is billed; heavy service-initiated outbound traffic can trigger suspension.
**Supabase Free**: 500 MB database; project **pauses after 7 days of inactivity** (must be manually restored); no backups/PITR; 2 free projects; direct connection IPv6-only ⇒ pooler required; shared pooler connection limits.
**Upstash Free**: 500 000 commands/month, 256 MB, single region, rate-limited beyond the cap; a 24×7 BullMQ worker can approach the cap (§7).
**Operational meaning:** suitable for supervised smoke tests and reviewer walkthroughs; **not** a production SLA, not suitable for continuous retry processing, and data may be lost (no backups). None of this is represented as production.

## 19. Not yet verified / blocked (consolidated)

| # | Item | Tag | Unblocked by |
|---|---|---|---|
| 1 | Render service creation, first deploy, build on Render's image | BLOCKED | operator with Render dashboard |
| 2 | Actual public URL; all §10/§11/§13/§16/§17 checks over the internet | BLOCKED | (1) |
| 3 | Supabase project, `revessent_app` role, migrations 0→26 on Supabase | BLOCKED | operator with Supabase dashboard |
| 4 | Upstash database; BullMQ over `rediss://` in anger; command-budget measurement | BLOCKED | operator with Upstash dashboard |
| 5 | Email verification, password-reset completion, workspace creation | NOT VERIFIED | Postmark test token (safe sandbox stream) |
| 6 | Stripe TEST webhook delivery to `/api/v1/webhooks/billing` and per-tenant endpoints | NOT VERIFIED | Stripe test keys + (2) |
| 7 | Hosted Recovery Checkout end-to-end | NOT VERIFIED | (6) |
| 8 | AI provider behaviour with a real key | NOT VERIFIED | Anthropic test key |
| 9 | Worker behaviour under Render spin-down (job continuity after wake) | NOT VERIFIED | (1) + (4) |
| 10 | Memory fit of `next start` + worker in 512 MB on Render | NOT VERIFIED | (1) |

## 20. Next steps (operator runbook — no code changes required)

1. **Supabase**: create Free project (region near Singapore); in SQL editor run the `CREATE ROLE revessent_app …` statement from §6; copy the **session pooler** URIs (port 5432) for `postgres` (owner) and `revessent_app`.
2. **Migrate from your machine** (Render Free cannot): `cd revessent && MIGRATE_DATABASE_URL='<owner session-pooler URL>?sslmode=require' corepack pnpm --filter @revessent/db migrate` → expect 26 applied; re-run the §9 checks (RLS count, 6 SECURITY DEFINER functions, role flags).
3. **Upstash**: create Free Redis (TLS), copy the `rediss://` URL.
4. **Render**: New → Blueprint → select this repo → `render.yaml` at repo root creates `revessent-web-staging` and `revessent-worker-staging`; fill every `sync: false` variable in the dashboard (never in git). Set `BETTER_AUTH_URL`/`APP_PUBLIC_URL` to the URL Render shows **after** the first deploy, then redeploy.
5. **Verify** in this order and record real output: `GET /api/health` (expect `db:"up"`), worker `GET /healthz` (expect `redis:"up"`), sign-up → `emailSent` behaviour, `GET /c/junk` headers, `POST /api/v1/webhooks/billing` unsigned → 400.
6. Only if safe test credentials exist: add `POSTMARK_*` (sandbox stream), Stripe **test** `BILLING_WEBHOOK_SECRET`, then walk sign-up → verify → workspace → connect test Stripe → checkout link → hosted checkout → webhook → case recovered. Never enter live keys.
7. After smoke testing, **suspend the worker service** to protect the 750-hour budget; resume for the next test session.
8. Return the recorded outputs for independent review; update §3, §10–§17 of this report from BLOCKED/NOT VERIFIED to VERIFIED only with real evidence.

---
*Stopped here per task instruction: report delivered for independent review; no further changes made.*
