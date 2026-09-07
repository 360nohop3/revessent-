# REVESSENT — Production Architecture v1

> **Phase 1 deliverable** · Roadmap: "PHASE 1 — PRODUCT & ARCHITECTURE → OUTPUT: REVESSENT Production Architecture v1"
> Derived from: `revessent (2).html` (the shipped single-file demo — **untouched**, it remains the canonical visual/UX spec) + `idea-brief.md`
> Date: 2026-09-05 · Status: Draft for approval · Next: Phase 2 (Production Frontend)

Every section below is numbered to mirror the Phase 1 checklist 1:1, and every product decision is traced back to something the demo already promises (Appendix A).

---

## 1. REVESSENT v1 — product definition

### 1.1 One-liner (locked, from the demo's own meta description)

> Revessent is revenue intelligence for subscription businesses — it detects failed payments, retries at the best moment, and acts on churn and upgrade signals before they become outcomes.

### 1.2 What v1 IS (scope)

| # | Capability | Commitments inherited from the demo | Notes |
|---|---|---|---|
| 1 | **Stripe-only recovery engine** | "Stripe-native · connect in about six minutes · read-only to start · revoke in one click" | Chargebee/Recurly explicitly "next on the roadmap" (demo FAQ) → v1.5+ |
| 2 | **Smart retries** | "retries at the best moment… timed to the member's history" (Zoe sim: *"retry set for 9:02 AM local — Zoe's most reliable payment hour"*) | Deterministic timing model (§9), not LLM-guessed |
| 3 | **Recovery notes (AI dunning email)** | "sent in your voice… Never [as Revessent]… written to sound like you" | §9.3; human-approval gated |
| 4 | **Hosted recovery checkout** | "A checkout that finishes… branded retry checkout your members actually trust" | Member-facing page at `/c/{token}` (§8.6) |
| 5 | **Decline forensics** | "Weekly decline forensics digest"; product tour: Detect → Understand → Decide → Recover → Learn | §9.4, §10.4 |
| 6 | **Expansion (upgrade moments)** | "Upgrade signals — drafted, approved, sent"; approve-and-send cards (Maya +$150/mo, Amara +$200/mo) | §9.5 |
| 7 | **Dashboard (overview)** | Recovered 30d, revenue at risk, recovered-vs-lost weekly chart, recovery queue, activity feed | Phase 2 Step 5 spec |
| 8 | **Per-dollar attribution + 90-day guarantee** | "Recoveries are attributed per member, per email, per retry… refund the full term" | Attribution ledger (§5, `recovery_attributions`) is a **v1-mandatory** table |
| 9 | **Pilot mode with approval gating** | "During your pilot every send requires a human thumbs-up; after that you set the trust level" | `trust_level` per org (§7.4, §9.6) |
| 10 | **Plans & self-billing** | Ember $0 (14-day pilot, ≤1,000 members) · Revessent $249/$199 · Studio $599/$479 | Entitlement flags (§1.4) |

### 1.3 What v1 is NOT (explicit non-goals)

- ❌ Chargebee / Recurly connectors (demo FAQ promises them as "next on the roadmap" → v1.5)
- ❌ Public API + outbound customer webhooks (Studio copy) → v1.5 — schema leaves room (`api_keys`, `outbound_*` tables stubbed but not built)
- ❌ SSO/SAML (Studio copy) → v1.5; **see Appendix B, Decision B-3 — the demo sells it today; we must either soft-launch Studio without it or gate Studio behind sales**
- ❌ Slack digests/alerts, tone A/B tests (Revessent-tier copy) → v1.x
- ❌ Multi-brand workspaces (Studio "up to 10 brands") → v1.5; `voice_profiles` table already keyed per brand-ready shape
- ❌ Mobile apps, white-label, ML-based retry-timing (heuristics first)
- ❌ Touching raw card data, ever — "No full card numbers · PCI-conscious architecture" is a load-bearing promise (§7.6)

### 1.4 Plan entitlements (single source of truth for gating)

| Entitlement | Ember ($0) | Revessent ($249/$199) | Studio ($599/$479) |
|---|---|---|---|
| Smart retries + recovery checkout | ✅ | ✅ | ✅ |
| Member cap | 1,000 | unlimited | unlimited |
| AI recovery notes | templates only | ✅ AI + voice | ✅ |
| Upgrade signals | ❌ | ✅ | ✅ |
| Weekly forensics digest | ❌ | ✅ | ✅ |
| Trust-level autonomy (post-pilot automation) | approval-only | configurable | configurable |
| Seats | 1 | 5 | 15 |
| SSO, API, multi-brand, dedicated concierge | — | — | **sold as "on request" in v1** (App. B) |

Implementation: `plan_entitlements` constant in `packages/core/src/entitlements.ts` + `organizations.plan` + cached Stripe subscription status. Every feature gate checks the constant, never hardcodes prices.

### 1.5 v1 success metrics

- Time-to-first-synced-data after Stripe connect: **p90 < 6 minutes** (demo FAQ promises "about six minutes")
- First recovery within pilot week 1 for ≥70% of pilot orgs with any failures (demo: "typical first recovery in week one")
- Recovery rate on retriable cases ≥ 55% (brief: smart stacks 50–80%; Stripe default ~57%)
- Zero sends without required approval (hard invariant, §9.6)
- Dashboard p95 TTFB < 300 ms; webhook → visible-in-queue p95 < 30 s

---

## 2. Core user journeys (v1)

Five journeys. The first two are literally storyboarded inside the demo (Zoe Park sim; approve-and-send cards) — the backend exists to make those exact pixels true.

### J1 — Owner connects Stripe and starts the pilot
```
Marketing site (existing demo pages) → Start free pilot (email form)
  → verify email → create org (Better Auth signup) → empty dashboard
  → Settings ▸ Stripe: paste RESTRICTED key (read-only scopes)  ← "read-only to start"
  → validate key against Stripe, auto-create webhook endpoint, store encrypted
  → backfill job imports last 90d customers/subscriptions/invoices   ← "connect in about six minutes"
  → dashboard fills with real data ("MRR at risk" > 0) → pilot clock starts (14 days, no card)
```
Empty states here are first-class (Phase 2 Step 10): pre-connect, during-backfill, and zero-failures states all designed.

### J2 — Failed payment → recovered (the "Zoe Park" journey, demo-simulated)
```
Stripe: invoice.payment_failed (charge.failed, decline_code=expired_card)
  → webhook in (verified, persisted raw) → recovery_case OPENED (status=detected)
  → classify decline (taxonomy §8.7) → "a fresh network token exists" signal (§8.5)
  → policy decides: silent retry at member's best local hour (timing model §9.2)
  → retry job executes via Stripe API (idempotency key rv:{org}:{case}:{attempt})
  → SUCCESS → invoice.paid webhook → case=recovered → attribution row (source=retry)
  → dashboard KPIs + activity feed update ("Zoe Park · recovered · +$184/mo · just now")
```
Branches: retry fails → policy escalates to **recovery note** (AI draft → approval if pilot → send) → still failing → **checkout link** (J4) → 90-day attribution window → `lost` (exhausted) or `canceled` (member churned via Stripe).

### J3 — Operator approves an upgrade ("Maya Chen / Amara Obi" cards)
```
Usage/limit signal lands (manual in v1; webhook/usage imports v1.5 — §9.5)
  → expansion_signal → AI analyzes context → expansion_opportunity (drafted message + price delta)
  → Overview ▸ "Upgrade signals — nothing sent without approval"
  → operator clicks Approve & send → message queued → sent in org voice
  → member upgrades (Stripe checkout link / self-serve) → webhook → opportunity=accepted
  → ARR delta logged (+$1,800 / +$2,400 style) → expansion revenue appears on dashboard
```

### J4 — Member completes the recovery checkout
```
Email/agent share → /c/{token} (unguessable, expiring, no login)
  → member sees org-branded page: amount, plan, card ··4242, "renews today"  (demo replica)
  → Stripe-hosted card update (SAQ-A; we never see the PAN, §7.6)
  → success → pay open invoice server-side → case=recovered (source=checkout) → thank-you state
```

### J5 — Operator reads the weekly forensics digest
```
Monday 07:00 org-local → digest job aggregates last 7d: recovered vs lost,
  top decline reasons, timing wins, one AI narrative paragraph ("Learn" step)
  → email + Overview panel; feeds "Recovered vs. lost, week by week" chart
```

---

## 3. Exact tech stack (decided)

Principle: **one language (TypeScript), boring managed infra, no bespoke machinery.** Versions pinned as "current stable" at Phase 2 kickoff; this doc pins majors only.

| Layer | Choice | Why (and what was rejected) |
|---|---|---|
| Language | **TypeScript 5.x (strict)** everywhere | One language across UI/API/worker; domain logic shared via packages |
| Frontend + BFF | **Next.js (App Router, React 19)** — route groups `(marketing)` + `(app)` | The demo becomes marketing routes pixel-for-pixel; app gets RSC + code-splitting (roadmap Phase 2 Step 12). Rejected: Remix/SvelteKit (smaller ecosystem for Stripe/AI libs) |
| API style | **REST (`/api/v1`)** via Next Route Handlers, OpenAPI-generated | Simple to contract-test against Phase 3; public API later reuses the same handlers. Rejected tRPC (public API would need a second surface) |
| Domain logic | **`packages/core`** (framework-free) | Recovery state machine, entitlements, attribution, timing live here → portable to a standalone service if load demands (roadmap Step 13) |
| Database | **PostgreSQL 16** (Neon managed; branch DBs for preview envs) | Relational + JSONB hybrid; RLS available as defense-in-depth |
| ORM / migrations | **Drizzle ORM + drizzle-kit** | Type-safe, SQL-transparent, fast migrations. Rejected Prisma (heavier runtime, weaker SQL control for attribution queries) |
| Cache / queues | **Redis 7 (managed) + BullMQ** | Delayed jobs are the heart of retry timing; BullMQ gives delayed/repeatable/backoff out of the box |
| AuthN/AuthZ | **Better Auth** (self-hosted on our Postgres) + orgs plugin | Sessions, passkeys/2FA, organizations, invitations, RBAC primitives in 2026's de-facto TS choice; data stays in our DB (no vendor lock). Rejected Clerk (vendor-held PII), hand-rolled (audit risk) |
| Stripe | **stripe-node**, restricted API keys + per-org webhook endpoints (v1) → **Stripe App** distribution (v1.5+) | Legacy key-sharing is deprecated by Stripe; manual restricted keys are the sanctioned fallback when Stripe Apps doesn't fit yet (§8.2) |
| Email | **Postmark** (transactional, tracked opens/clicks for notes) | Deliverability is the product for dunning; per-org sending domain = BYO Postmark/SES in v1.5 (App. B, B-4) |
| AI | **Provider gateway `packages/ai`**: Anthropic Claude (primary) + OpenAI (fallback), structured JSON outputs validated with Zod | No lock; structured outputs + validator + template fallback (§9.6) |
| Design system | **Tailwind CSS 4 + extracted `packages/ui`** | Tokens lifted from the demo's CSS custom properties (glass surfaces, ivory/pewter/AMOLED themes, radii, shadows) — Phase 2 Step 2's "one reusable component per pattern" |
| Hosting | **Vercel** (web + Route Handlers) · **Fly.io or Railway** (worker + Redis) | Split keeps long-running BullMQ workers off serverless; both trivial to move later |
| Monorepo | **pnpm workspaces + Turborepo** | Cached builds, task graph for web/worker shared packages |
| Observability | **Sentry** (errors) + **Axiom or Logtail** (logs/audit stream) + Vercel Analytics | Phase 7 hardening reuses these; wired from day one |
| Revessent's own billing | **Stripe Billing** (Checkout + Customer Portal, prices per §1.4) | Eat own dog food; no custom billing UI in v1 |

---

## 4. System architecture

### 4.1 Component diagram

```
                        ┌────────────────────────────────────────────────┐
                        │                    VERCEL                      │
  Member ──/c/{token}──▶│  Next.js                                       │
  Operator ◀─app────────│  ┌──────────────┐  ┌─────────────────────┐     │
                        │  │ (marketing)  │  │ (app) Route Handlers │    │
                        │  │ demo pages   │  │ REST /api/v1 (BFF)  │     │
                        │  └──────────────┘  └─────────┬───────────┘     │
                        └──────────────────────────────┼─────────────────┘
                                                       │ org-scoped calls
                     ┌─────────────────────────────────▼───────────────────────────┐
                     │                  packages/core (domain)                      │
                     │  recovery state machine · entitlements · attribution ledger  │
                     │  retry timing model · decline taxonomy · policy engine       │
                     └───────┬───────────────┬───────────────┬─────────────────────┘
                             │               │               │
              ┌──────────────▼───┐   ┌───────▼──────┐  ┌─────▼─────┐
              │ Postgres (Neon)  │   │ packages/    │  │ packages/ │
              │ tenant tables+RLS│   │ stripe       │  │ ai        │
              │ audit (append)   │   │ (API client  │  │ (gateway, │
              └──────────────▲───┘   │  per-org key)│  │  prompts) │
                             │       └───────▲──────┘  └─────▲─────┘
                             │               │               │
        ┌────────────────────┴─────┐   Stripe API    Anthropic / OpenAI
        │ FLY/RAILWAY              │        │
        │  worker (BullMQ)         │   webhooks (sig-verified, per-org endpoint)
        │  queues: webhooks,       │────────┘
        │  retries, notes, sync,   │
        │  digests, reconcile      │──▶ Postmark (member emails)
        │  Redis (BullMQ)          │
        └──────────────────────────┘
```

### 4.2 The one rule that shapes everything

**Stripe webhooks are the only entry point for billing truth.** The dashboard never calls Stripe read-write at request time; Route Handlers mutate domain state, workers execute against Stripe. This gives us: auditability (every state change is a DB row + job), survivability (Stripe outage degrades sync, not the app), and testability (Phase 8 replays webhook fixtures).

### 4.3 Request/data flows

1. **Inbound truth:** Stripe → webhook receiver (verify sig → 200 fast → persist raw `webhook_events` row) → enqueue → worker handler → `core` command → guarded state-machine transition → UI reads DB only.
2. **Outbound action:** UI → Route Handler (auth, org check, entitlement check, Zod validation) → `core` command → DB write + audit row (+ enqueue side-effect job where async).
3. **Scheduled action:** BullMQ delayed job (retry at best hour) → worker → `core` guard (`case.next_action_at` re-checked → no drift/double-fire) → Stripe call with idempotency key → outcome webhook closes the loop.
4. **AI assist:** command enqueues `note.draft` → worker builds redacted context → `packages/ai` → validated JSON → stored (`ai_generations`) → approval UI → send job.

### 4.4 Environments

| Env | Web | DB | Redis | Stripe | Purpose |
|---|---|---|---|---|---|
| local | `next dev` | docker compose (pg16+redis) | compose | test-mode keys + Stripe CLI | dev |
| preview | Vercel preview | Neon branch per PR | shared dev | test mode | PR review |
| staging | vercel (staging proj) | Neon staging | small managed | **test mode only** | Phase 8 E2E |
| production | Vercel | Neon prod (pooled) | managed | live mode | real customers |

Secrets via Vercel/Fly env refs; one `.env.example` per app generated from Zod env schema (`packages/config`). **No secrets in the repo, ever** (§7.5).

---

## 5. Database & schema

Conventions: `uuid` v7 PKs (app-generated), `bigint` money in **minor units** + `currency char(3)`, `timestamptz` everywhere, `jsonb` for raw payloads only (never queried hot), every tenant row carries `org_id` (indexed as leading column of every secondary index), soft-delete via `deleted_at` only where legally required (usually not — we hard-delete on erasure requests), `created_at/updated_at` on all tables.

### 5.1 ER overview

```
organizations ─┬─ memberships ─── users (Better Auth)
               ├─ stripe_connections ── (1:1 live mode + 1:1 test mode)
               ├─ retry_policies (versioned) ── voice_profiles
               ├─ customers ─┬─ subscriptions ── plan_catalog
               │             └─ payments ── payment_attempts
               ├─ recovery_cases ─┬─ recovery_attempts
               │                  ├─ recovery_messages ── ai_generations
               │                  ├─ recovery_checkouts
               │                  └─ recovery_attributions ◀─ guarantee ledger
               ├─ expansion_signals ── expansion_opportunities ── ai_generations
               ├─ webhook_events (inbound, raw, idempotent)
               ├─ audit_logs (append-only)
               └─ org_subscriptions (Revessent's own billing + guarantee window)
```

### 5.2 DDL (v1 core — migrations live in `packages/db`)

```sql
-- ============ TENANCY (auth tables are Better Auth's; referenced, not redefined) ============
create table organizations (
  id            uuid primary key,
  name          text not null,
  slug          text not null unique,
  plan          text not null default 'ember',        -- ember | revessent | studio
  timezone      text not null default 'UTC',          -- digest + "local morning" defaults
  pilot_started_at timestamptz,
  pilot_ends_at    timestamptz,
  trust_level   smallint not null default 0,          -- 0 = approve everything (pilot), 1..3 = autonomy (§9.6)
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table memberships (
  id            uuid primary key,
  org_id        uuid not null references organizations(id) on delete cascade,
  user_id       uuid not null references users(id) on delete cascade,
  role          text not null default 'viewer',       -- owner | admin | operator | viewer (§7.3)
  created_at    timestamptz not null default now(),
  unique (org_id, user_id)
);
create index on memberships (user_id);

create table invitations (
  id            uuid primary key,
  org_id        uuid not null references organizations(id) on delete cascade,
  email         text not null,
  role          text not null default 'operator',
  token_hash    text not null unique,
  invited_by    uuid not null references users(id),
  expires_at    timestamptz not null,
  accepted_at   timestamptz,
  created_at    timestamptz not null default now()
);

-- ============ STRIPE CONNECTION (restricted-key model, §8.2) ============
create table stripe_connections (
  id                uuid primary key,
  org_id            uuid not null references organizations(id) on delete cascade,
  mode              text not null,                    -- test | live  (data never mixes)
  stripe_account_id text not null,                    -- acct_...
  key_ciphertext    bytea not null,                   -- AES-256-GCM envelope (§7.5)
  key_last4         text not null,                    -- display "sk_test_…abcd"
  scopes            jsonb not null,                   -- granted restricted-key perms snapshot
  webhook_endpoint_id text,                           -- created automatically on connect
  webhook_secret_enc  bytea,
  status            text not null default 'active',   -- active | revoked | error
  last_sync_at      timestamptz,
  backfill_done_at  timestamptz,
  created_at        timestamptz not null default now(),
  unique (org_id, mode)
);

-- ============ BILLING MIRROR (read model of the org's Stripe) ============
create table plan_catalog (                            -- the org's prices, for recommendations
  id                    uuid primary key,
  org_id                uuid not null references organizations(id) on delete cascade,
  stripe_price_id       text not null,
  stripe_product_id     text not null,
  nickname              text,
  amount_cents          bigint not null check (amount_cents >= 0),
  currency              char(3) not null,
  interval              text not null,                -- month | year
  rank                  int not null,                 -- ordering for "next plan up"
  deleted_at            timestamptz,
  unique (org_id, stripe_price_id)
);

create table customers (
  id                  uuid primary key,
  org_id              uuid not null references organizations(id) on delete cascade,
  stripe_customer_id  text not null,
  email               text,
  name                text,
  country             char(2),
  currency            char(3),
  mrr_cents           bigint not null default 0,
  status              text not null default 'active', -- active | past_due | canceled
  default_payment      jsonb,                         -- {brand, last4, exp_month, exp_year, network_token: bool}
  stripe_created_at   timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (org_id, stripe_customer_id)
);
create index on customers (org_id, status);
create index on customers (org_id, email);

create table subscriptions (
  id                      uuid primary key,
  org_id                  uuid not null references organizations(id) on delete cascade,
  customer_id             uuid not null references customers(id) on delete cascade,
  stripe_subscription_id  text not null,
  stripe_price_id         text not null,
  status                  text not null,              -- stripe status verbatim
  amount_cents            bigint not null,
  currency                char(3) not null,
  interval                text not null,
  current_period_end      timestamptz,
  cancel_at_period_end    boolean not null default false,
  canceled_at             timestamptz,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  unique (org_id, stripe_subscription_id)
);

create table payments (                                -- invoices & their charges (mirror)
  id                   uuid primary key,
  org_id               uuid not null references organizations(id) on delete cascade,
  customer_id          uuid not null references customers(id) on delete cascade,
  subscription_id      uuid references subscriptions(id) on delete set null,
  stripe_invoice_id    text,
  stripe_payment_intent_id text,
  stripe_charge_id     text,
  amount_cents         bigint not null,
  currency             char(3) not null,
  status               text not null,                 -- open | paid | failed | refunded | void
  attempted_count      int not null default 0,
  decline_code         text,                          -- latest stripe decline_code
  decline_message      text,
  network_token_available boolean not null default false,   -- demo J2 signal
  hosted_invoice_url   text,
  period_start         timestamptz,
  period_end           timestamptz,
  failed_at            timestamptz,
  paid_at              timestamptz,
  raw                  jsonb,                         -- stripe object snapshot
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index on payments (org_id, status, failed_at desc);
create index on payments (org_id, customer_id, created_at desc);

create table payment_attempts (                        -- every Stripe attempt we observe/make
  id                uuid primary key,
  payment_id        uuid not null references payments(id) on delete cascade,
  source            text not null,                    -- stripe_default | revessent_retry | checkout | member
  stripe_charge_id  text,
  decline_code      text,
  outcome           text not null,                    -- succeeded | failed
  attempted_at      timestamptz not null,
  raw               jsonb
);
create index on payment_attempts (payment_id, attempted_at);

-- ============ RECOVERY DOMAIN ============
create type recovery_status as enum (
  'detected','analyzing','retrying','contacting','checkout','recovered',
  'lost','canceled','dismissed'
);

create table recovery_cases (
  id                uuid primary key,
  org_id            uuid not null references organizations(id) on delete cascade,
  customer_id       uuid not null references customers(id) on delete cascade,
  subscription_id   uuid references subscriptions(id) on delete set null,
  payment_id        uuid not null references payments(id) on delete cascade,
  status            recovery_status not null default 'detected',
  decline_code      text not null,
  decline_category  text not null,                    -- taxonomy §8.7
  amount_cents      bigint not null,
  currency          char(3) not null,
  first_failed_at   timestamptz not null,
  next_action_at    timestamptz,                      -- what the retry scheduler reads
  retry_policy_version int not null,                  -- snapshot ref (§8.4)
  attempt_no        int not null default 0,
  closed_at         timestamptz,
  closed_reason     text,                             -- exhausted | member_canceled | manual
  recovered_cents   bigint,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  unique (org_id, payment_id)                         -- one case per failed payment
);
create index on recovery_cases (org_id, status, next_action_at);
create index on recovery_cases (org_id, customer_id, created_at desc);

create table recovery_attempts (
  id              uuid primary key,
  case_id         uuid not null references recovery_cases(id) on delete cascade,
  kind            text not null,                      -- auto_retry | note | checkout | manual_retry
  scheduled_at    timestamptz,
  executed_at     timestamptz,
  status          text not null default 'scheduled',  -- scheduled|succeeded|failed|skipped|canceled
  idempotency_key text unique,                        -- rv:{org}:{case}:{seq} → Stripe-safe
  decline_code    text,                               -- outcome, if failed
  actor           text not null default 'system',     -- user id or 'system'
  created_at      timestamptz not null default now()
);
create index on recovery_attempts (case_id, scheduled_at);

create table recovery_messages (
  id               uuid primary key,
  case_id          uuid not null references recovery_cases(id) on delete cascade,
  org_id           uuid not null references organizations(id) on delete cascade,
  template         text,                              -- fallback template id, if used
  ai_generation_id uuid references ai_generations(id),
  subject          text not null,
  body             text not null,
  cta_kind         text not null default 'checkout',  -- checkout | portal
  approval_status  text not null default 'draft',     -- draft|awaiting_approval|approved|auto_approved|suppressed|sent|failed
  approved_by      uuid references users(id),
  approved_at      timestamptz,
  sent_at          timestamptz,
  provider_message_id text,
  opened_at        timestamptz,
  clicked_at       timestamptz,
  created_at       timestamptz not null default now()
);
create index on recovery_messages (case_id);
create index on recovery_messages (org_id, approval_status) where approval_status = 'awaiting_approval';

create table recovery_checkouts (
  id             uuid primary key,
  case_id        uuid not null references recovery_cases(id) on delete cascade,
  token_hash     text not null unique,                -- /c/{token}; store hash only
  stripe_session_id text,
  status         text not null default 'open',        -- open|completed|expired|disabled
  expires_at     timestamptz not null,
  completed_at   timestamptz,
  created_at     timestamptz not null default now()
);

-- THE GUARANTEE LEDGER — demo: "attributed per member, per email, per retry"
create table recovery_attributions (
  id             uuid primary key,
  org_id         uuid not null references organizations(id) on delete cascade,
  case_id        uuid not null references recovery_cases(id),
  customer_id    uuid not null references customers(id),
  payment_id     uuid not null references payments(id),
  source         text not null,                       -- retry | note | checkout | organic_after_nudge
  amount_cents   bigint not null,                     -- recovered MRR/charge value
  within_window  boolean not null,                    -- ≤90d of first failure (demo FAQ definition)
  policy_snapshot jsonb not null,                     -- guarantee terms at time of attribution
  attributed_at  timestamptz not null default now(),
  unique (payment_id)                                 -- a payment is recovered exactly once
);
create index on recovery_attributions (org_id, attributed_at desc);

create table retry_policies (                          -- versioned; cases snapshot the version
  id           uuid primary key,
  org_id       uuid not null references organizations(id) on delete cascade,
  version      int not null,
  rules        jsonb not null,                        -- §8.4 shape
  created_by   uuid references users(id),
  created_at   timestamptz not null default now(),
  unique (org_id, version)
);

create table voice_profiles (                          -- brand voice for AI notes (§9.3)
  id            uuid primary key,
  org_id        uuid not null references organizations(id) on delete cascade,
  brand_key     text not null default 'default',      -- future: multi-brand (Studio)
  sample_text   text not null,
  style_summary text not null,                        -- distilled by AI, human-editable
  greeting      text,
  signoff       text,
  updated_at    timestamptz not null default now(),
  unique (org_id, brand_key)
);

-- ============ EXPANSION DOMAIN ============
create table expansion_signals (
  id           uuid primary key,
  org_id       uuid not null references organizations(id) on delete cascade,
  customer_id  uuid not null references customers(id) on delete cascade,
  kind         text not null,                         -- usage_limit | near_limit | feature_gate | manual
  payload      jsonb not null,
  detected_at  timestamptz not null default now(),
  consumed_by  uuid references expansion_opportunities(id)
);

create table expansion_opportunities (
  id                 uuid primary key,
  org_id             uuid not null references organizations(id) on delete cascade,
  customer_id        uuid not null references customers(id) on delete cascade,
  signal_id          uuid references expansion_signals(id),
  current_price_id   text,
  recommended_price_id text not null references plan_catalog(stripe_price_id),
  potential_mrr_cents bigint not null,                -- demo: "ARR +$1,800"
  rationale          text not null,                   -- shown in approve card
  ai_generation_id   uuid references ai_generations(id),  -- drafted message
  status             text not null default 'new',     -- new|awaiting_approval|approved|sent|accepted|declined|expired|dismissed
  approved_by        uuid references users(id),
  approved_at        timestamptz,
  sent_at            timestamptz,
  accepted_at        timestamptz,
  upgraded_subscription_id uuid references subscriptions(id),
  expires_at         timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index on expansion_opportunities (org_id, status, created_at desc);

-- ============ AI ============
create table ai_generations (
  id             uuid primary key,
  org_id         uuid not null references organizations(id) on delete cascade,
  purpose        text not null,        -- dunning_draft|upgrade_draft|forensics_digest|voice_profile
  provider       text not null,        -- anthropic | openai
  model          text not null,
  prompt_version text not null,                       -- registry ref (§9.4)
  input_refs     jsonb not null,                      -- {case_id|opportunity_id, signals hashes}
  input_sanitized_hash text not null,                 -- proves no PANs; reproducible audits
  output         jsonb not null,                      -- validated structured output
  valid          boolean not null,
  tokens_in      int,
  tokens_out     int,
  cost_millicents int,
  latency_ms     int,
  created_at     timestamptz not null default now()
);
create index on ai_generations (org_id, purpose, created_at desc);

create table ai_usage_budgets (                        -- per-org monthly caps
  org_id        uuid primary key references organizations(id) on delete cascade,
  month         date not null,
  spent_millicents bigint not null default 0,
  cap_millicents   bigint not null
);

-- ============ OPS ============
create table webhook_events (                          -- inbound, raw, idempotent
  id              uuid primary key,
  source          text not null default 'stripe',
  org_id          uuid references organizations(id),  -- null until matched
  mode            text,                               -- test|live
  external_id     text not null unique,               -- stripe event id → at-least-once safety
  type            text not null,
  payload         jsonb not null,
  status          text not null default 'pending',    -- pending|processed|failed|skipped
  attempts        int not null default 0,
  last_error      text,
  received_at     timestamptz not null default now(),
  processed_at    timestamptz
);
create index on webhook_events (status, received_at) where status = 'pending';

create table audit_logs (                              -- append-only; no update/delete grants
  id          uuid primary key,
  org_id      uuid not null,
  actor_id    uuid,                                   -- user or null=system
  actor_kind  text not null default 'user',           -- user|system|ai
  action      text not null,                          -- 'case.approved','policy.updated','key.rotated',...
  target_type text not null,
  target_id   text not null,
  diff        jsonb,
  ip          inet,
  user_agent  text,
  created_at  timestamptz not null default now()
);
create index on audit_logs (org_id, created_at desc);

create table org_subscriptions (                       -- Revessent's OWN billing of the org
  org_id               uuid primary key references organizations(id) on delete cascade,
  stripe_customer_id   text,
  stripe_subscription_id text,
  plan                 text not null default 'ember',
  status               text not null default 'trialing',
  guarantee_started_at timestamptz,                   -- 90-day refund clock (demo guarantee)
  guarantee_ends_at    timestamptz,
  refunded_at          timestamptz,
  updated_at           timestamptz not null default now()
);

create table digests (                                 -- weekly forensics digest record
  id          uuid primary key,
  org_id      uuid not null references organizations(id) on delete cascade,
  period_start date not null,
  period_end   date not null,
  payload     jsonb not null,                         -- stats + AI narrative ref
  ai_generation_id uuid references ai_generations(id),
  sent_at     timestamptz,
  unique (org_id, period_start)
);
```

### 5.3 Recovery state machine (normative)

Mirrors the roadmap's FAILED → RETRYING → CUSTOMER_CONTACTED → CHECKOUT → RECOVERED / EXHAUSTED, with the demo's "quietly recovered" path first-class. Implemented **only** in `packages/core/src/recovery/machine.ts`; every transition = guarded function + audit row.

```
 detected ──▶ analyzing ──▶ retrying ──▶ recovered
     │            │            │  ▲└──▶ contacting ──▶ recovered
     │            │            │───┘          │
     │            │            └──────────▶ checkout ──▶ recovered
     │            │
     └──▶ dismissed          (any state) ──▶ canceled   (member churned at Stripe)
                             (any state, policy exhausted or 90d window over) ──▶ lost
```

Guard invariants (enforced in code + asserted by Phase 8 tests):
1. One active case per failed payment (`unique(org_id, payment_id)`).
2. `recovered` requires an existing `payments.status='paid'` + creates exactly one `recovery_attributions` row (`unique(payment_id)`).
3. A note can only be `sent` if `approval_status ∈ {approved, auto_approved}` — `auto_approved` only when `org.trust_level ≥ policy minimum` and org is **not** in pilot.
4. No retry executes when `now() < next_action_at` or `case.status ∉ {retrying, contacting}` (job-time re-check kills stale/duplicate jobs).
5. Terminal states (`recovered|lost|canceled|dismissed`) never transition again.

### 5.4 Retention

| Data | Retention |
|---|---|
| Raw webhook payloads | 90 days hot, then prune (domain rows keep the truth) |
| `ai_generations` | 24 months (audit) |
| `audit_logs` | 7 years, append-only (WORM-style grants) |
| Member PII (customers.*) | life of org + 30d; erasure request → anonymize, keep money amounts (legitimate interest) |
| Abandoned checkouts | tokens expire 14d (demo: 30-second action doesn't need more) |

---

## 6. API structure

### 6.1 Conventions

- Base: `/api/v1` · AuthN: Better Auth session cookie (`HttpOnly; Secure; SameSite=Lax`) · AuthZ: role matrix (§7.3) + entitlements (§1.4).
- **Every** handler: Zod-parsed input → `requireSession()` → `requireOrg(role)` → `core` command → problem+json on error.
- Errors: RFC 9457 `application/problem+json` with stable `type` URIs (`/errors/entitlement-required`, `/errors/rate-limited`, …).
- Mutating POSTs accept `Idempotency-Key` (stored 48h, keyed to actor+route).
- Lists: cursor pagination (`?limit=50&cursor=…`), max 100.
- Rate limits: 120 req/min/org on reads, 30/min on actions (Redis token bucket); 429 + `Retry-After`.
- Money: integer minor units + `currency` — never floats, never formatted strings.

### 6.2 Endpoint catalog (v1)

| Method & path | Role | Purpose |
|---|---|---|
| `POST /auth/*` | public | Better Auth: signup, login, logout, verify-email, 2FA |
| `GET /me` | any | profile + orgs + role + entitlements |
| `POST /orgs` · `PATCH /orgs/{id}` | owner | create / rename / timezone / trust level |
| `GET /overview` | viewer+ | dashboard aggregate: MRR at risk, MRR recovered (30d), recovery rate, counts, trend series, queue preview, pending approvals |
| `GET /recovery/cases?status=&q=` | viewer+ | queue list (demo "Recovery queue") |
| `GET /recovery/cases/{id}` | viewer+ | detail: timeline (attempts+messages+events merged), AI recommendation |
| `POST /recovery/cases/{id}/retry` | operator | manual retry now |
| `POST /recovery/cases/{id}/checkout-link` | operator | create/rotate `/c/{token}` link |
| `POST /recovery/messages/{id}/approve` · `/reject` · `/{id}/edit` | operator | the human thumbs-up (J3/J2) |
| `GET /expansion/opportunities` · `POST /expansion/opportunities/{id}/approve` · `/dismiss` | operator | upgrade cards (demo Overview panel) |
| `POST /expansion/signals` | admin (manual v1) | push a manual usage signal |
| `GET /customers?q=&status=&risk=` · `GET /customers/{id}` | viewer+ | directory + 360° detail (Phase 2 Step 8) |
| `GET/PUT /settings/retry-policy` | admin | versioned policy (§8.4) |
| `GET/PUT /settings/voice` | operator | voice profile (sample + edits) |
| `GET /settings/stripe` · `POST /settings/stripe/keys` · `DELETE /settings/stripe` | admin | connection status / connect (restricted key, read-only first) / revoke in one click |
| `GET/POST /settings/team` · `DELETE /settings/team/{memberId}` | admin | memberships + invitations |
| `GET /settings/billing` | owner | own plan, guarantee window, invoices (Stripe Customer Portal link) |
| `GET /audit?target=` | admin | audit trail viewer |
| `POST /webhooks/stripe/{orgRef}` | Stripe (sig) | per-org inbound webhook receiver — 200 in <100 ms, processing async |
| `GET /c/{token}` · `POST /c/{token}/confirm` | public (token) | member recovery checkout (J4) — no session, hashed token |

### 6.3 Versioning & evolution

Additive-only within v1; breaking changes → `/api/v2` with 6-month overlap (matters when the public API ships in v1.5). The OpenAPI document is **generated from the Zod schemas** so contract tests in Phase 8 can never drift from implementation.

---

## 7. Authentication & security model

### 7.1 AuthN

- **Better Auth**, sessions in Postgres: cookie `rv_session` (HttpOnly, Secure, SameSite=Lax), 30-day sliding expiry, rotation on privilege change, device list visible to user.
- Passwords: argon2id (library defaults: m=64 MB, t=3, p=4). Breached-password check (k-anonymity HIBP) on signup/change.
- Email verification required before org creation; TOTP 2FA available (encouraged for owner/admin); passkeys enabled (Better Auth plugin) — no SMS OTP.
- Rate limits on auth routes: 5 attempts / 15 min / IP+email, exponential lockout with audit rows.

### 7.2 Sessions & machines

- Dashboard: session cookie only (no API keys in localStorage — ever).
- Worker/API-to-Stripe: per-org restricted keys from `stripe_connections` (decrypted only inside worker, in memory, per job).
- Member checkout `/c/{token}`: 128-bit random token, **SHA-256 stored**, 14-day expiry, single customer scope, revocable per case.

### 7.3 RBAC matrix

| Action | viewer | operator | admin | owner |
|---|---|---|---|---|
| View dashboards, queues, customers | ✅ | ✅ | ✅ | ✅ |
| Approve/reject notes & upgrades, manual retry, checkout links | — | ✅ | ✅ | ✅ |
| Edit voice profile, retry policy | — | voice only | ✅ | ✅ |
| Manage team, connect/revoke Stripe, read audit | — | — | ✅ | ✅ |
| Billing, plan changes, delete org, trust level | — | — | — | ✅ |

### 7.4 Multi-tenant isolation (the "organization isolation" roadmap item)

Three layers, in order:
1. **Query layer (primary):** every core repository function takes `orgId` as its first parameter; Drizzle schema typing makes un-scoped queries a type error.
2. **Postgres RLS (defense-in-depth):** `alter table … enable row level security; create policy org_isolation using (org_id = current_setting('app.org_id')::uuid)` — web request and worker transactions both `set local app.org_id` per transaction.
3. **Authorization middleware:** route handlers assert the session's membership **and role** before touching core.

### 7.5 Secrets & key management

- Envelope encryption for Stripe keys & webhook secrets: AES-256-GCM, data key per connection, master key from KMS/`KEY_ENCRYPTION_KEY` env (never in DB, rotatable with re-encrypt job).
- `webhook_secret_enc` per connection; inbound handler verifies `Stripe-Signature` with constant-time compare; replay window 5 min.
- All env config through Zod-validated schema (`packages/config`) → boot fails loudly on missing/weak values.
- Secret rotation runbook: Stripe key rotate → re-encrypt job; master key rotate → online re-encrypt with double-read window.
- Logging redaction middleware (Stripe keys, emails, tokens) — enforced by a shared logger, not by discipline.

### 7.6 PCI & member-data posture (demo promise: "No full card numbers · PCI-conscious architecture")

- Revessent is **SAQ-A**: card data flows member-browser → Stripe only. Card updates happen on Stripe-hosted surfaces (Checkout update-mode / hosted invoice page) rendered inside our branded shell — we never receive, transmit, or store PANs/CVVs.
- We store only what Stripe returns in non-card objects: brand, last4, exp month/year, network-token availability flag.
- LLM inputs are sanitized (§9.6): payment metadata is whitelisted fields only; a regex + field-allowlist pass strips anything card-shaped and records `input_sanitized_hash`.

### 7.7 Platform hardening (wired now, deepened in Phase 4/8)

Security headers: HSTS(2y, preload), CSP (nonce-based, `frame-ancestors 'none'` except Stripe surfaces), `X-Content-Type-Options`, `Referrer-Policy: strict-origin-when-cross-origin`, Permissions-Policy minimal. CSRF: SameSite + origin checks on state-changing routes. Audit logging on every state change (§5.2) incl. actor, IP, UA, diff. Backups: Neon PITR + daily logical dumps, RPO ≤ 5 min / RTO ≤ 1 h (Phase 7 verifies by restore drill).

---

## 8. Stripe integration architecture

### 8.1 Connect flow (demo: "connect in about six minutes · read-only to start · revoke in one click")

1. Settings ▸ Stripe shows instructions for creating a **restricted key** with a documented minimal scope list.
2. Pilot stage scopes (read-only): `Customers R`, `Subscriptions R`, `Invoices R`, `Charges R`, `PaymentMethods R`, `Webhook` RW (needed so we can self-register the endpoint).
3. On paste: server calls `GET /v1/accounts` (and `GET /v1/customers?limit=1`) with the key → verifies account id, mode (test/live), and actual granted scopes → stores encrypted → creates a dedicated webhook endpoint via API pointing at `/api/v1/webhooks/stripe/{orgRef}` subscribed to the event list in §8.3.
4. Post-pilot upgrade: user re-issues the key with `Invoices RW` + `PaymentIntents RW` → re-validate → `connections.scopes` updated → retry execution unlocked. UI shows exactly which capabilities each scope level unlocks (demo trust line: "Read-only access at first").
5. Revoke: one click deletes the webhook endpoint via API, marks connection `revoked`, disables retry/checkout jobs, retains historical data (exportable, erasable).

> **v1.5 path:** publish a **Stripe App** (the sanctioned replacement for legacy key-sharing; restricted-key + OAuth 2.0 auth inside the app framework). The `stripe_connections` table and scope checker are designed to carry that migration with zero schema change (App auth token lands in the same ciphertext column).

### 8.2 Why restricted keys, not Connect, for v1

Connect (platform + connected accounts) is for money-movement platforms and adds onboarding/underwriting obligations; Stripe's own migration guidance positions manual restricted keys + webhooks as the sanctioned route when the integration is custom. We keep: no funds flow through us, the org stays the merchant of record, liability stays clean.

### 8.3 Webhook subscription list (inbound)

`invoice.payment_failed`, `invoice.payment_failed` (retry attempts), `invoice.paid`, `invoice.payment_action_required`, `charge.failed`, `charge.succeeded`, `charge.refunded`, `charge.dispute.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `customer.updated`, `payment_method.attached`/`detached`/`updated` (network-token signal), `account.application.deauthorized` (revocation). Unhandled types are persisted `skipped` — never dropped silently.

### 8.4 Retry policy engine (per-org, versioned; default = the demo's story)

```jsonc
// retry_policies.rules (shape)
{
  "max_auto_retries": 4,
  "per_decline": {                       // taxonomy §8.7 → routing
    "insufficient_funds": { "strategy": "payday_aware", "retries": 4, "note_after": 2 },
    "expired_card":       { "strategy": "token_first", "retries": 1, "note_immediately": true },
    "do_not_honor":       { "strategy": "spread", "retries": 3, "note_after": 1 },
    "hard_decline:*":     { "strategy": "no_retry", "note_immediately": true }
  },
  "timing": { "best_hour_local": true, "quiet_hours": [22, 8], "min_gap_hours": 24 },
  "note":  { "await_approval_pilot": true, "trust_level_min_auto": 2, "max_per_case": 2 },
  "checkout": { "offer_after": "note_failed_or_no_retry_path", "token_ttl_days": 14 },
  "give_up": { "after_days": 21, "window_days": 90 }
}
```
Policy edits create a **new version**; running cases keep their snapshot (`retry_policy_version`) — no retroactive behavior change, which the guarantee audit trail requires.

### 8.5 Network-token / saved-credential signals

`payment_method.updated` events and PaymentMethod card fields expose whether a network token / refreshed credential exists. Policy `token_first` means: if a fresher credential exists, prefer a silent retry before any email — exactly the demo's Day-1→Day-3 "recovered quietly, no note needed" beat.

### 8.6 Hosted recovery checkout (SAQ-A)

- Case reaches checkout state → `recovery_checkouts` row + `/c/{token}` page (org-branded shell mirroring the demo's "Recovery checkout" card: member name, plan, ··4242, amount, "renews today").
- Card entry is **Stripe-hosted**: v1 creates a Checkout Session bound to the open invoice (`mode: payment`, invoice param) or, for card-refresh cases, update-mode session; exact binding verified in Phase 5 spike (App. B, B-2). Success webhook (`invoice.paid` / `checkout.session.completed`) → core marks `recovered` (source `checkout`) + attribution.
- Token endpoint is rate-limited (10/h/IP), no enumeration (hash lookup), and renders zero billing data beyond what the demo shows.

### 8.7 Decline taxonomy (classification lives in `packages/core/stripe/declines.ts`)

| Category | Example Stripe codes | Default route |
|---|---|---|
| `insufficient_funds` | `insufficient_funds`, `card_velocity_exceeded` | payday-aware retries (§9.2) |
| `expired_card` | `expired_card` | token-first retry + immediate note |
| `transient` | `processing_error`, `issuer_not_available` | quick backoff retries |
| `issuer_decline` | `do_not_honor`, `generic_decline` | spread retries + note |
| `credential` | `invalid_cvc`, `incorrect_number`, `invalid_expiry` | no retry; note + checkout immediately |
| `hard` | `lost_card`, `stolen_card`, `fraudulent` | **no recovery outreach**; case dismissed, note suppressed (legal/safety) |
| `balance` | `account_frozen`, `currency_not_supported` | note + checkout, no retries |

### 8.8 Sync & reconciliation

- **Backfill** (on connect): 90 days of customers → subscriptions → invoices/charges via auto-pagination in a queued job; progress in UI ("importing… 60%"); idempotent upserts.
- **Continuous:** webhooks are primary truth; an hourly delta sync + nightly reconcile (compare counts/sums per day with Stripe) repairs missed events. `stripe_connections.last_sync_at` powers a visible freshness indicator (real-app state, Phase 2 Step 10: partial failure = stale banner, not a crash).

---

## 9. AI architecture

### 9.1 Division of labor — the core architectural decision

| Decision | Made by | Why |
|---|---|---|
| **When** to retry, which decline route, when to give up | **Deterministic rules + per-member payment-hour histogram** (`packages/core/recovery/timing.ts`) | Money moves require auditability & reproducibility; an LLM must never decide to charge someone's card |
| **What** the note says, in the org's voice | **LLM** (structured output) | This is where "written like a human" lives (demo principle #1) |
| Upgrade **detection** (v1) | Deterministic signal ingestion | v1 has no usage stream; manual + Stripe-observable signals |
| Upgrade **pitch draft** | LLM (structured) | Demo: "AI-drafted pitch for one-click approval" |
| Weekly forensics narrative | LLM summarizing computed stats | "Learn" step; stats themselves are SQL |

LLMs propose, humans (or policy) dispose; **no LLM output reaches a member or mutates money state without passing the approval gate.**

### 9.2 Retry-timing model (v1: interpretable heuristics)

Per (customer): histogram of successful charge local hours (from mirrored payments) → preferred hour; per decline category: fixed backoff curves (e.g., insufficient_funds → next plausible payday boundary + morning-of local); per org: quiet hours, max gap. Deterministic, unit-testable, explainable in the UI ("why this time?" tooltip — demo value: calm transparency). v2 roadmap item: learned model, shadow-scored against the heuristic before promotion.

### 9.3 Voice profile pipeline (demo: "notes written like a human note… in your voice")

1. Operator pastes 2–3 real emails/support replies → `voice_profiles.sample_text`.
2. One-time generation distills a **style summary** (sentence length, formality, greeting/signoff, do/don't) — human-editable; the summary, not the raw samples, is what ships in prompts (token cost + privacy).
3. Every dunning draft prompt carries: style summary + case facts (amount, plan, decline category tier, relationship length) + strict output schema:
   `{subject, body_markdown, cta_label, tone_check{formality, empathy}, forbidden_hits[]}`.
4. Drafts render into the email client UI beside the "Stripe default" comparison (the demo's two-voice comparison is the actual approval UI pattern).

### 9.4 Prompt registry & evaluation

- Prompts live in `packages/ai/prompts/*.ts` with `version` + golden-input fixtures; every generation stores `prompt_version` → reproducible.
- Eval set (built in Phase 6, required before enabling any automation beyond pilot): ~50 golden cases asserting schema validity, no forbidden content (PAN-shaped strings, "Revessent" self-branding in member emails — demo FAQ promise, legal threats, over-promising), tone-band checks, and idempotence (same input → same facts).
- CI runs the eval set on prompt PRs against the fallback model (cheap tier); full model evals weekly + before any model bump.

### 9.5 Expansion engine (v1 shape, honest about inputs)

v1 signals: manual entry by operator, plan-rank heuristics from `plan_catalog` (e.g., member on a high-usage signal the operator observed), Stripe-observable proxies (multiple active subscriptions, seat-count metadata if present). The demo's promise ("detect when a power user hits a limit") requires usage feeds → **v1.5: usage ingestion webhook + CSV/import**, schema-ready via `expansion_signals.payload`. Opportunity card mirrors the demo: customer, current → recommended plan, usage signal, potential MRR, AI rationale, **Approve & send**; acceptance tracked back through Stripe subscription webhooks to `accepted` + ARR delta.

### 9.6 Guardrails, safety, fallbacks (roadmap: "AI safety/validation/fallbacks")

1. **Input sanitizer:** allowlisted fields only; PAN/secret-shaped regex pass; `input_sanitized_hash` recorded.
2. **Structured output or nothing:** Zod validation; 1 automatic repair retry; on second failure → **template fallback** (pre-approved copy library) — recovery never blocks on AI.
3. **Approval gate:** pilot orgs (`trust_level=0`): everything awaits a human. Post-pilot: `trust_level` ladder (1 = notes auto-send only for `transient` declines & successful-quiet-retry thank-yous; 2 = standard notes auto; 3 = expansion drafts auto too). Every auto-approval writes an audit row with the policy version that allowed it. Hard override: org-wide "pause all sends" kill switch.
4. **Cost governance:** per-org monthly budget (`ai_usage_budgets`) with graceful degradation to templates when exhausted; per-generation cost logged; global dashboard alert at 80%.
5. **Provider resilience:** gateway with primary/fallback model + circuit breaker; model outages degrade to templates, never to silence.
6. **Content red lines** (enforced post-generation, pre-approval): member emails never name Revessent (demo FAQ), never mention other customers, never promise refunds/outcomes, never include card numbers — automated checks + eval set.

---

## 10. Background jobs & webhook system

### 10.1 Queues (BullMQ; one Redis, named queues, per-queue concurrency)

| Queue | Concurrency | Notes |
|---|---|---|
| `webhooks.in` | 20 | fast handlers only; heavy work re-enqueued |
| `retries` | 5 | the money queue; strict ordering per case via keyed dedupe |
| `notes` | 5 | drafts + sends (after approval) |
| `sync` | 2 | backfill, delta, reconcile |
| `ai` | 4 | drafts, digests narrative |
| `maintenance` | 2 | digests, guarantee eval, cleanup, budget meter |

### 10.2 Job catalog

| Job | Trigger | Idempotency | Semantics |
|---|---|---|---|
| `webhook.process` | receiver persist | `external_id` unique | parse → route by type → core command |
| `stripe.backfill` | connect | checkpointed cursors | resumable import, progress rows |
| `retry.schedule` | case enters retrying | dedupe key `{case}:{attempt}` | compute time → enqueue `retry.execute` (delayed) |
| `retry.execute` | delayed job | **guard: re-check `case.next_action_at` + status at run time** | Stripe call w/ idempotency key → outcome row |
| `note.draft` | policy fires | `{case}:{attempt}` | AI generation → `awaiting_approval` or policy auto |
| `note.send` | approval / auto-approve | message status guard | Postmark send → status+timestamps |
| `checkout.create` | policy fires | case guard | session + token row + email/agent link |
| `checkout.expire` | daily sweep | — | expire stale tokens |
| `sync.delta` | hourly | window keyed | repair drift from missed webhooks |
| `sync.reconcile` | nightly | day keyed | counts/sums vs Stripe; alert on mismatch |
| `digest.weekly` | cron (org-local 07:00 Mon) | `unique(org, period)` | stats + AI narrative → email + dashboard |
| `guarantee.eval` | daily per org | day keyed | recovered-vs-paid ledger → flag orgs inside guarantee window |
| `retention.cleanup` | daily | — | webhook payload pruning, expired invitations |

Delivery semantics: **at-least-once enqueue, exactly-once effects** (DB unique constraints + state-machine guards are the real lock). Failures: exponential backoff (5 attempts), then dead-letter queue with Sentry alert; DLQ replay is an admin script, not a UI (v1).

### 10.3 Inbound webhook receiver contract

`POST /api/v1/webhooks/stripe/{orgRef}` → constant-time signature verify → insert `webhook_events` (unique `external_id`) → 200 within 100 ms → enqueue `webhook.process`. Unverifiable/unknown org → 400 (Stripe retries; alert fires). This is the only public write surface besides `/c/{token}`.

### 10.4 Outbound (v1.5, stubbed)

`outbound_webhook_endpoints` + signed (HMAC-SHA256, timestamped) deliveries with the same at-least-once/exactly-once discipline — required before Studio's "API, webhooks" copy is enabled (App. B).

---

## 11. Production folder / repository structure

```
revessent/
├─ apps/
│  ├─ web/                        # Next.js (App Router) — marketing + dashboard + API
│  │  ├─ src/app/
│  │  │  ├─ (marketing)/          # home, product, pricing  ← the demo pages, ported
│  │  │  ├─ (app)/                # authenticated shell (Phase 2 Step 3)
│  │  │  │  ├─ overview/  recovery/  expansion/  customers/  settings/
│  │  │  ├─ api/v1/               # Route Handlers (thin) → packages/core
│  │  │  │  ├─ webhooks/stripe/[orgRef]/route.ts
│  │  │  │  └─ ...
│  │  │  └─ c/[token]/            # member recovery checkout (public, noindex)
│  │  └─ src/middleware.ts        # auth gate, org resolution, security headers
│  └─ worker/                     # BullMQ workers (Fly.io/Railway)
│     └─ src/queues/{webhooks,retries,notes,sync,ai,maintenance}.ts
├─ packages/
│  ├─ core/                       # FRAMEWORK-FREE DOMAIN — the crown jewels
│  │  └─ src/
│  │     ├─ recovery/             # machine.ts (state machine), timing.ts, policy.ts
│  │     ├─ expansion/            # signals → opportunities rules
│  │     ├─ attribution/          # guarantee ledger logic
│  │     ├─ entitlements.ts       # plan matrix (§1.4)
│  │     └─ money.ts  time.ts  ids.ts
│  ├─ db/                         # Drizzle schema, migrations, seeds, RLS policies
│  ├─ stripe/                     # per-org clients, webhook parsing, decline taxonomy, sync
│  ├─ ai/                         # gateway (anthropic/openai adapters), prompts/, validators, evals/
│  ├─ emails/                     # React Email templates (notes, digests, invites, receipts)
│  ├─ ui/                         # design system extracted from the demo (Phase 2 Step 2)
│  └─ config/                     # env schemas, tsconfig, eslint, tailwind preset, logger
├─ tooling/
│  ├─ scripts/                    # replay-webhook.ts, backfill.ts, rotate-keys.ts, dlq-replay.ts
│  └─ fixtures/stripe/            # recorded webhook payloads for Phase 8 scenario tests
├─ turbo.json · pnpm-workspace.yaml · docker-compose.yml (pg+redis) · .env.example
```

Rules: `apps/*` may import `packages/*`; `packages/*` never import `apps/*`; `core` imports nothing but `config` — this is what keeps Phase 2's "frontend must not contain business logic" enforceable by the compiler.

---

## Appendix A — Demo → architecture traceability

| The demo (`revessent (2).html`) promises… | …the architecture delivers it via |
|---|---|
| Hero KPIs "Recovered · 30 days", "Revenue at risk", recovered-vs-lost chart | `GET /overview` aggregate over `recovery_attributions` + `recovery_cases` (§6.2) |
| "Failed → Analyze → Retry → Retained" pipeline chip | `recovery_status` enum + state machine (§5.3) |
| Zoe sim: decline read → "fresh network token exists" → best-hour retry → "no note needed" | `network_token_available`, policy `token_first`, timing model §9.2 |
| Approve-and-send upgrade cards (Maya/Amara, ARR deltas) | `expansion_opportunities` + approval endpoints (J3, §9.5) |
| "Nothing sent without approval" | approval gate invariant (§5.3 #3, §9.6 #3) |
| Two-voice email comparison (Revessent vs Stripe default) | `recovery_messages` + `ai_generations` rendered as the approval UI (§9.3) |
| Recovery checkout card ("Zoe Park · ··4242 · renews today") | `/c/{token}` + Stripe-hosted card entry (§8.6) |
| "Read-only to start · revoke in one click" | scoped restricted keys + revoke flow (§8.1) |
| "Connect in about six minutes" | guided key paste + auto webhook + backfill job (J1) |
| "Attributed per member, per email, per retry" + 90-day guarantee | `recovery_attributions` ledger + `guarantee.eval` job (§5.2, §10.2) |
| "Weekly decline forensics digest" | `digest.weekly` job + `digests` table (J5) |
| "Recovery notes in your brand voice" | `voice_profiles` pipeline (§9.3) |
| Trust line "No full card numbers · PCI-conscious" | SAQ-A posture, Stripe-hosted surfaces (§7.6) |
| Plans Ember/Revessent/Studio + annual toggle | entitlement matrix + own Stripe Billing (§1.4, §3) |
| Studio line items SSO/API/multi-brand | flagged, deferred honestly (App. B, B-3) |

## Appendix B — Open decisions & risks (Phase 1 exits with these explicit)

| # | Decision | Recommendation |
|---|---|---|
| B-1 | **Stripe App vs manual restricted keys timing** | v1 manual restricted keys (sanctioned fallback); apply to Stripe Apps marketplace in v1.5 — table/schema already compatible |
| B-2 | **Checkout binding detail** (Checkout-Session-pays-invoice vs hosted-invoice-page vs Elements) | Phase 5 day-1 spike; all three keep us SAQ-A; demo fidelity prefers our branded shell + Stripe card element surface |
| B-3 | **Studio tier honesty** — demo sells SSO/API/multi-brand that v1 defers | Ship Studio as "concierge onboarding + priority support + multi-voice, SSO & API coming"; or sales-gated. Do not silently oversell |
| B-4 | **Member email sending domain** (our domain + Reply-To now vs BYO SES/Postmark later) | v1: Postmark on our domain, transparent from-labels; v1.5 BYO for deliverability-sensitive orgs |
| B-5 | **Ember free-tier abuse** (1,000 members free = real sync/AI-template cost) | Cap Stripe sync frequency on Ember; require test-mode-then-live verification; revisit after pilot data |
| B-6 | **Guarantee liability** — full-term refund is generous; brief wanted "next quarter free" | Keep demo wording (it's live copy), but `guarantee.eval` must flag at-risk orgs by day 60; finance sign-off required pre-launch |

---

*Phase 1 complete when this document is approved. Phase 2 (Production Frontend) consumes: §1.4 entitlements, §2 journeys, §5 states, §6 endpoints (as contract mocks), §11 repo layout, and `packages/ui` tokens lifted from the demo.*
