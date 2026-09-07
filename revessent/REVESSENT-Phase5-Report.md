# REVESSENT — Phase 5 Report: Background Execution & Job Infrastructure

**Status: COMPLETE — all gates executed and passing. Phase 6 NOT started.**
Date: 2026-09-06. All numbers in this report are from the **final** executed runs (post final code state); nothing is carried over from intermediate logs without re-verification.

---

## A. Phase objective

Phase 5 builds the reliable background runtime that **delivers already-approved recovery work**: a worker application (`apps/worker`), a Redis/BullMQ delivery layer, a deterministic scheduler/dispatcher, and a durable (`job_runs`) job lifecycle in Postgres. Phase 5 owns **delivery only**. Financial authority is unchanged: **Phase 4D owns eligibility** (re-checked at delivery time by `runDueRetries`), **Phase 4C owns execution** (preflight, payment lock, idempotent provider call, unknown-outcome handling), **the database remains authoritative over Redis**. The worker is a delivery mechanism, never a second retry engine and never a financial authority.

The governing invariant, re-verified by the gates below: *the worker can deliver work repeatedly, concurrently, after crashes and after Redis loss — without bypassing Phase 4D eligibility or Phase 4C execution safety, and without causing a second financial execution.*

## B. Architecture

- **`apps/worker`** (`@revessent/worker`): `bootstrap()` composes app-role DB (RLS-scoped) + optional owner DB (narrowly-scoped system reads) + BullMQ queue + worker + `RetryScheduler` + optional health endpoint; `src/main.ts` is the process entrypoint invoked by `npm start` / `npm run dev` (verified by a real-process boot smoke). 13 source files: config, logger (reuses repo redaction), context, `durable/jobs`, `queues/retries`, `scheduler`, `recovery`, `workers/retryWorker`, health, shutdown, bootstrap, main, index.
- **Queue**: one Redis; queue `retries`; job name `retry.execute`. Connection disables the offline queue (enqueue fails fast instead of silently buffering); BullMQ backoff exponential (5 000 ms base, `attempts = maxAttempts`); `removeOnComplete: true` frees the deterministic identity for a future round; `removeOnFail: false` keeps dead-letters (failed set) for admin replay. ioredis is pinned ^5.11.1 (v6 is type-incompatible with bullmq@5.81.4).
- **Payload contract**: strict zod schema `{jobRunId, orgId, caseId}` — identifiers only, unknown keys rejected. No amounts, currencies, or policy data ever travel through Redis; every financial fact is re-read from the DB at delivery.
- **Delivery path**: durable `job_runs` row → BullMQ (deterministic jobId) → worker → durable claim (`UPDATE … WHERE queued-or-expired-lease`) → `retryService.runDueRetries(ctx, {caseId})` (Phase 4D re-check under its own concurrency controls) → Phase 4C `executePaymentAttempt` if and only if safe → outcome mapped back onto the durable row.
- **Flow of authority**: DB state → scheduler discovers due durable work → enqueue (durable-first) → Redis → worker → 4D/4C decide and execute.

## C. Durable job lifecycle

Migration `0020_job_runs` (the only Phase 5 migration):

- **States**: `queued → leased → succeeded | failed | canceled` (`failed` = infrastructure dead-letter after `max_attempts` (5); `canceled` = target/org gone).
- **Outcomes** (delivery results, engine-owned): `executed | blocked | waiting | exhausted | disabled | not_due | no_such_case`.
- **Recorded per run**: intended job (queue, job_type, dedupe_key), org, target case, attempts/max_attempts, run_after, leased_at/lease_expires_at (stale-lease detection), last_attempted_at, finished_at, last_error_category/last_error_code (safe codes only — never provider bodies or secrets).
- **Transitions are single-statement guarded updates**: claim = `UPDATE … SET status='leased', attempts=attempts+1 … WHERE id=? AND org_id=? AND (status='queued' OR (status='leased' AND lease_expires_at < now)) RETURNING *` — the winner-take-all boundary; complete/cancel only from `leased`; infra failure requeues (`queued`) until the attempt budget, then terminal `failed`.
- **Uniqueness**: partial unique index `job_runs_dedupe_live_uq (dedupe_key) WHERE status IN ('queued','leased')` — at most one live logical job per identity, enforced by the database.

## D. Idempotency

- **Deterministic identity**: `retry-exec:{orgId}:{caseId}` is both the durable `dedupe_key` and the BullMQ `jobId` (pure function — tested). Re-enqueues reuse the same id; BullMQ cannot hold two jobs with one id; the DB cannot hold two live rows with one key.
- **Duplicate enqueue** (same case, concurrent callers, or scheduler re-discovery): converges — exactly one durable row, one queue record (`live_job_exists` for the losers).
- **New rounds**: after a delivery completes (any outcome), the identity is freed (`removeOnComplete` + terminal row); the next eligible round is a **new** logical job.
- **Financial exactly-once** is not claimed from queue semantics: it is enforced by Phase 4C's durable attempt identity + payment advisory lock + provider idempotency key (`rv:{org}:{executionId}`), which the worker merely triggers. Queue redelivery of a terminal job is acknowledged without action (tested).

## E. Crash recovery

Lease/heartbeat terminology: a claim holds `lease_expires_at = now + WORKER_LEASE_SECONDS (300)`. Recovery paths:

- **A — crash before business execution**: lease expires; redelivery (BullMQ) or the recovery scan re-enqueues; new claim reclaims the expired lease. Tested: reclaimed and delivered exactly once.
- **B — crash during execution (attempt reserved)**: the reserved 4D attempt row survives; redelivery **resumes the SAME identity** (`rv:{org}:{case}:{n}`) via 4D's resume path — never a second identity. Tested: one attempt row, one provider operation.
- **C — provider succeeded, crash before ack**: redelivery converges through payment/4C truth (preflight sees paid provider state; `payment_already_paid` refusal; no second charge). Tested: one charge ever, across redelivery.
- **D — durable success recorded, crash before queue ack**: redelivery finds the terminal durable row and the executed attempt; acknowledged harmlessly; no case regression. Tested.
- **E — worker restart**: the recovery scan surfaces stale leases and durable rows missing from Redis; work becomes processable again. Tested (with a real worker instance and `worker.close()` semantics).
- **Unknown outcomes are never auto-retried**: a delivery whose attempt row ends `scheduled`/`executing` is recorded as infra failure (`execution_unresolved`) and re-delivered by backoff, but the 4D case state (`nextActionAt = NULL`) keeps it out of discovery — it stays reconciliation-blocked at the Phase 4C boundary. Tested.
- **Honest scope**: crash scenarios are exercised as **simulated failures at the durable boundaries** (lease expiry + redelivery + concurrent processors in-suite), plus one real-process claim race (below). No test SIGKILLs a real worker mid-provider-call; that residual risk is covered by 4C idempotency, not by this test claim.

## F. Redis recovery

- **Enqueue-time outage**: durable-first means the `job_runs` row commits even when Redis is down; the helper reports `redis_unavailable`; repeated cycles do not amplify (partial unique index). Tested against a real dead port (connection refused, no offline-queue buffering).
- **Total Redis loss** (`FLUSHALL` on a **real Redis process**): durable rows remain the authority; the scheduler's per-org reconciliation (`reconcileOrgJobsWithRedis`) finds live rows missing from Redis and re-enqueues them **under the same deterministic id** (`redisReenqueued=1, enqueued=0` — discovery does not create a second logical job). The reconstructed delivery executes exactly once; completed deliveries are never resurrected; blocked/failed deliveries are never resurrected (dead-letter discipline). Tested.
- **Recovery probes are per-row fault-isolated**: one Redis hiccup during a scan cannot abort the org's cycle; the row stays queued for the next cycle.

## G. Concurrency

- **Scheduler**: fixed-interval, never self-overlapping; bounded per cycle (`WORKER_SCAN_LIMIT` 100 cases/org, `WORKER_ORG_LIMIT` 200 orgs, recovery `scanLimit × 2` rows/org); per-org RLS-scoped cycles (`cycleOrg`); idempotent via the durable live-row marker. Three concurrent scheduler instances produced **exactly one** live job (tested).
- **Queue amplification controls**: partial unique index + durable-first insert-or-find; a case with a live job row is not re-discovered; cases whose latest delivery ended `blocked`/`disabled`/`exhausted` are suppressed for `WORKER_BLOCKED_COOLDOWN_HOURS` (24 h default). This is **delivery-rate hygiene, not eligibility**: the 4D engine re-decides on every delivery that actually happens, and discovery ≠ eligibility (a due non-retryable case is still delivered and refused *there* — tested).
- **Worker claim**: guarded single-statement lease with winner-take-all semantics; concurrent duplicate deliveries produce ≤ 1 provider operation and 1 attempt row (tested); live leases are never stolen, expired ones are (tested).
- **Dispatcher/scheduler separation**: the scheduler discovers due durable work and enqueues; it creates **no retry decisions** — no attempt numbering, no policy evaluation, no backoff-of-record (4D owns all of those).

## H. Tenant isolation

- **RLS**: `job_runs` has `org_isolation` (ALL) policy keyed on `app.org_id`; the app role has standard DML only. Database-level probe (final migration state): A sees its own job (1), cannot see B's (0), **cannot UPDATE, DELETE, or claim B's job by primary key (0 rows affected each)**; unscoped sessions see nothing.
- **Worker delivery cannot cross orgs**: a forged payload (org B ids pointing at org A's durable job) executes nothing — the job row is loaded under the *payload's* org scope, and the durable row does not exist there. Tested; org B gains no rows.
- **Per-org independence**: two orgs process concurrently with separate attempts, cases, and job ledgers; per-org scheduler cycles enqueue only their own cases. Tested.
- **Privileged context (documented and constrained)**: the scheduler enumerates organization ids and `systemOrgContext` reads the org row via the **owner connection** (`SCHEDULER_DATABASE_URL`, else `DATABASE_URL`). This context is used **only** for org-id enumeration + org-row reads (scope documented in `context.ts`); it runs as role `operator` with `SYSTEM_ACTOR_ID = "system"` (never anonymous); **all tenant operations — discovery, claims, delivery — run on the app-role RLS connection**. RLS was never weakened for the worker.

## I. Security

- **No credentials in code or logs**: connection strings live only in env/config; Redis/DB URLs are never logged (boot log prints `"redis": "configured (url redacted)"`); all error paths pass through the repo's `withoutConnectionDetails()` redaction; provider errors are reduced to safe categories/codes (`last_error_category/code`); raw provider bodies never reach job rows or logs.
- **Payload safety**: strict identifier-only schema; malformed or foreign payloads are rejected without execution and without retry; unbounded payloads cannot smuggle financial fields.
- **No deserialization risk**: BullMQ JSON payloads; no dynamic code/SQL construction (all queries via drizzle parameterization).
- **Privileged surfaces**: owner connection restricted as in §H; health endpoint is optional (`WORKER_HEALTH_PORT`), binds a dedicated Redis connection, exposes only runtime counters — never secrets.
- **Boundary audit (grep-verified final)**: worker source contains **no** `getStripeGateway`/`payInvoice`/stripe-client imports, **no** eligibility/policy/classification logic (`maxAutoRetries`, `perCategory`, `classifyOutcome`, `requestHashOf`, `attempts.length + 1` — zero hits), **no** direct `recoveryAttempts` writes, **no** new advisory/payment lock. The only execution path is `retryService.runDueRetries`.

## J. Phase 4C/4D integration

The worker **delivers into the existing primitives and duplicates none of them**. Eligibility re-check, attempt reservation/numbering, limits, backoff-of-record, quiet hours, category rules, amount/currency authority, provider preflight, payment locking, idempotent execution, unknown-outcome classification, and reconciliation all remain in Phase 4D/4C code, unchanged (full 4D suite re-run green — no collateral damage). The worker maps only the *delivery result* onto `job_runs` (`executed/blocked/waiting/exhausted/disabled/not_due`), and treats `scheduled/executing` attempt rows as *unresolved infrastructure*, never as business results.

## K. Migrations

Phase 5 adds exactly one migration: **`0020_job_runs`** (table, indexes, partial live-uniqueness, RLS policy, app-role DML grant). Note: 0020 was amended **before any release** to add the app-role GRANT (0002's audit-WORM revoke stops default privileges from covering `update/delete` on later tables — 0010 set the precedent); no previously-applied migration was edited.

Executed verification (drizzle-kit itself performed every step; exact counts from `drizzle.__drizzle_migrations`):

| Path | Start state | Applied | End state | Result |
|---|---|---|---|---|
| A. Fresh bootstrap | empty database | 0000 → 0020 | **21 / 21** | PASS — schema usable; RLS `org_isolation` present; partial dedupe index present; `revessent_app` has SELECT/INSERT/UPDATE/DELETE on `job_runs`; app-role insert under RLS OK (scoped=1, unscoped=0); seed script runs idempotently behind `RVS_SEED_ALLOWED=1` |
| B. Upgrade from Phase 4C-final | **18 / 21** (through 0017) | 0018, 0019, 0020 only | **21 / 21** | PASS — `job_runs` absent before, present after; 4D attempt-no unique index + policy-version column created correctly; 4C-era behavior intact (full suite green) |
| C. Upgrade from Phase 4D-final | **20 / 21** (through 0019) | 0020 only | **21 / 21** | PASS — `attempt_no` semantics intact (`recovery_attempts_case_auto_no_uq` on (case_id, attempt_no)); 4D idempotency-key index intact; `job_runs` usable immediately |

(One harness bug during verification — a stash script wrote a bare JSON array over `_journal.json` — was caught and fixed; the journal file was restored and verified entry-for-entry against the dev database's migration ledger: 21 entries, exact `when` match.)

## L. Test results (final executed run)

- **Full suite: 381 / 381 tests, 42 files — all green** (vitest, real Postgres; worker suites use a real Redis process on port 6399).
- Worker suites: **48 / 48** across 8 files — durable lifecycle (7), queue identity & durable-first (7), scheduler (7), worker processing (10), crash boundaries A–E (7), Redis loss (3), tenant isolation (4), real BullMQ runtime (3).
- `tsc --noEmit`: **exit 0** for all packages. `eslint .`: **exit 0** for all packages.
- Production build (`NEXT_PUBLIC_DEMO_MODE=off next build --webpack`): **exit 0**, 25/25 pages.
- **Real-process probes** (tsx OS processes, not in-process tests): two workers raced `claimJob` on one durable job — **1 claim won, 1 completion, ~79 safe rejections across 80 attempts**; loser observed leased/terminal state every time (durable DB claim boundary, independent of BullMQ). Boot smoke: real `npm start` path (`tsx --conditions react-server src/main.ts`) against dev Postgres+Redis — delivered jobs, refused to acknowledge unresolved deliveries, then **graceful shutdown completed on SIGTERM**.
- **Test taxonomy (honest)**: unit/integration with real Postgres + real Redis process (the 381); simulated crash/lease failures at durable boundaries (in-suite); one real two-process claim race; one real-process boot/shutdown smoke; database migration tests on throwaway databases (dropped after). **No live provider tests were performed.**

## M. Known limitations

1. **Live Stripe execution is impossible in this environment** — all provider behavior is deterministic fixtures (§N). The worker's financial safety rests on 4C/4D, which fixtures exercise faithfully.
2. Crash tests are boundary-simulated (lease expiry + redelivery), not SIGKILL-of-a-real-process; the un-tested slice (death during the provider HTTP call) is protected by 4C idempotency and the payment lock, not by a Phase 5 test.
3. `job_runs` has **no retention/cleanup** — terminal rows accumulate (bounded by delivery volume); a housekeeping job is future work.
4. Dead-lettered BullMQ jobs stay in the `failed` set indefinitely; replay is a manual admin operation (by design, but unbounded storage).
5. The blocked/disabled/exhausted delivery cool-off (24 h default) delays *re-delivery* of permanently-refused cases; operators cannot yet tune it per-org.
6. Health endpoint wiring is implemented and compiles but was not exercised over HTTP in the smoke run.
7. Single queue (`retries`) only; multi-queue fan-out is architecture-reserved but unused.

## N. Live Stripe verification

**Not performed.** No live Stripe credentials exist in this environment; per Phase 5 §20, fixtures are the accepted evidence. Nothing in this report should be read as live-provider verification. (Consistent with Phases 4A–4D.)

## O. Scope audit

**Clean.** Grep audit of the final worker source and Phase 5 files found **zero** AI/LLM, email, Slack, messaging, campaign, Stripe OAuth/App Marketplace, entitlement, Terraform/deployment, analytics, or unrelated frontend work. Worker source = 13 job-infrastructure files; DB change = `0020` only; config additions are worker knobs only. One pre-existing lint finding in `packages/integrations` (unused imports/vars) was fixed without behavior change. Phase 6 was **not** started.

## P. Final verdict

**Phase 5 PASSES.** The durable-first architecture demonstrably survives duplicate enqueues, concurrent schedulers, crashed workers, total Redis loss, and forged cross-tenant payloads — with every financial decision remaining inside the unchanged Phase 4C/4D primitives and the database remaining authoritative over Redis. The invariant in §A holds under every gate executed above.
