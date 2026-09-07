# REVESSENT — Phase 4B Report
## Stripe Webhooks & Reconciliation (Architecture v1 §7.5 / §8.2 / §8.3 / §9 / §10.3)

Date: 2026-09-06 · Scope: Phase 4B ONLY, built incrementally on the Phase 1–4A app. Nothing was rebuilt, replaced or restructured; all Phase 1–4A behavior is preserved (108 pre-existing server tests pass unmodified, 42 pre-existing web tests pass unmodified).

---

## §22-A. What was implemented

1. **Webhook receiver route** — `POST /api/v1/webhooks/stripe/{orgRef}` (`apps/web/src/app/api/v1/webhooks/stripe/[orgRef]/route.ts`): public provider-callback surface (no browser session). Reads the **raw body** (`req.text()`), passes it with the `Stripe-Signature` header to the service; `ProblemError` → problem+json 400; unexpected errors → safe `safeInternalError()` (internals never leak). This is only the second public write surface in the product (besides `/c/{token}`), per §10.3.
2. **Receiver service** (`packages/server/src/services/webhooks.ts`):
   - Connection resolution via the `{orgRef}` (= connection id, an unguessable uuid) through a narrowly scoped `SECURITY DEFINER` function `resolve_webhook_connection(uuid)` (migration 0013, select-only, exact id, safe columns) — the Phase 3 pre-auth pattern (0005/0007). **Org identity is NEVER taken from the body.**
   - **Official signature verification against the raw body** — `Stripe.webhooks.constructEventAsync(raw, header, secret, tolerance)` from stripe 22.6.1 only. Zero custom crypto. Never parse→re-stringify. The signing secret is stored sealed (AES-256-GCM envelope, same as the API key) and opened only in memory for verification.
   - Replay tolerance **300 s** (§7.5) with safe rejection codes: `missing_signature`, `malformed_signature`, `invalid_signature`, `stale_timestamp`, `malformed_payload`.
   - Mode guard (`livemode` must match the connection's mode) and account guard (an event claiming a different connected account is persisted `skipped/account_mismatch`, never applied).
   - **Durable persist first**: `INSERT … ON CONFLICT DO NOTHING` against the delivery-unique index, then idempotent processing.
3. **Idempotent processing** — per-event PostgreSQL session advisory lock (`withPgAdvisoryLock`, the generalized 4A sync single-flight). States: `pending → processed | skipped | failed | reconciled`. All domain mutation + the terminal status commit **in one transaction** (no mark-then-update crash window). `dependency_missing:*` is a retryable `failed`; all other non-applies are final `skipped`. Concurrent duplicate deliveries: the loser waits (≤15 s) for the winner's terminal status and acks honestly (`duplicate: true`).
4. **Event coverage (§8.3 + domain)** — subscribed set: `customer.updated|deleted`, `customer.subscription.created|updated|deleted`, `invoice.paid|payment_failed|updated|voided|payment_action_required`, `charge.refunded|succeeded|failed`, `account.application.deauthorized`. Applies with the **shared 4A appliers** (`applyProviderCustomer/Subscription/Invoice` extracted verbatim from `persistPage`; 108 pre-existing tests are the no-regression proof). Unsupported provider state ⇒ `skipped/anomaly:unsupported_invoice_status` etc. — nothing coerced, nothing invented. `charge.*` (non-refund) ⇒ `skipped/covered_by_invoice_events`; `payment_method.*` ⇒ `skipped/payment_method_signals_phase_5`; disputes ⇒ `skipped/disputes_not_in_domain`; any other type ⇒ persisted `skipped/unhandled_event_type` — **never dropped**.
5. **Ordering guard (§16-D)** — before applying a customer/subscription/invoice event, `max(provider_created_at)` over `processed` events for the same `(org, object_type, object_id)` decides: an older event commits `skipped/superseded_by_newer_event` and touches nothing. Tested with newer-then-older delivery.
6. **Truth model (§9)** — webhooks are near-real-time; the 4A read-only sync remains the delta/recovery path; **reconciliation** (`POST /api/v1/orgs/{slug}/settings/stripe/reconcile`, operator+, session+RBAC) reuses the 4A read-only sync (no second client/credential system), read-only toward Stripe, then marks `failed` events `reconciled` (history retained). Freshness is honest: `webhookStatus` exposes `configured`, `endpointId`, `lastWebhookAt`, `failed`, `unprocessed`, `lastFailureCode/At` — **failed webhooks never fake freshness**; a failed event stays visible until reconciled.
7. **Deauthorization (§12)** — `account.application.deauthorized`: connection → `revoked`, `key_ciphertext` AND `webhook_secret_enc` destroyed (destroying the signing secret means post-revocation deliveries cannot verify ⇒ safe 400s ⇒ Stripe eventually disables the endpoint — "webhooks cannot resurrect" is enforced cryptographically, not by convention), audit `credential.revoked` (codes only), history retained.
8. **Endpoint lifecycle (§8.2)** — on a valid connect the server self-registers the per-connection endpoint via the provider API (`createWebhookEndpoint`, restricted key needs Webhook RW) subscribed to the §8.3 list, sealing the `whsec_` with the envelope pattern; never surfaced to the frontend. Registration failure is non-fatal and audited (`webhook: not_registered:<code>`) — the sync delta path still covers the org, nothing fabricated. On disconnect the endpoint is deleted via the API (best-effort, audited `webhook: removed|remove_failed:<code>`) before both secrets are destroyed.
9. **API & observability (§18/§19)** — internal surfaces stay `/api/v1` + problem+json with normal auth; the webhook route authenticates by signature+connection only. The settings DTO gained the `webhooks` block; the settings UI (`stripe-view.tsx`) shows configured endpoint, last delivery age, failed/unprocessed counts, last failure code, and a "Reconcile with Stripe" action only when failures exist. No keys, signing secrets, auth headers, decrypted credentials, or PII are logged anywhere (audit diffs are code-only; payloads are stored in `webhook_events.payload`, not logs).
10. **No scheduler/queue/worker** — Redis/BullMQ/distributed workers remain forbidden (Phase 4B constraint). Durable insert + inline idempotent processing + duplicate-delivery retry + manual/auto reconcile is the documented narrow adaptation of the §10 jobs model.

## §22-B. Receiver flow (exact)

raw body + `Stripe-Signature` → uuid-shape check → `resolve_webhook_connection` (definer fn) → missing endpoint/secret ⇒ safe 400 → **official verify (raw body, 300 s)** ⇒ fail ⇒ safe 400, **nothing persisted** → mode/account guard → `INSERT … ON CONFLICT DO NOTHING` (delivery-unique) → per-event advisory lock → re-read row → `processed|skipped|reconciled` ⇒ idempotent ack → `pending|failed` ⇒ process (ordering guard → route by type → shared 4A appliers → status commit, one tx) → safe 200 `{received:true, duplicate, status, note}`.

## §22-C. Migrations (forward-only, deterministic from empty DB)

| # | File | Content |
|---|------|---------|
| 0012 | `0012_webhooks_4b.sql` | `webhook_events` + `account`, `provider_created_at`, `object_type`, `object_id`; `webhook_events_object_idx (org_id, object_type, object_id)`; `stripe_connections` + `last_webhook_at`, `webhook_endpoint_id`, `webhook_secret_enc`; table comment (statuses) |
| 0013 | `0013_webhook_resolve_rls.sql` | `resolve_webhook_connection(uuid)` — select-only SECURITY DEFINER, `REVOKE ALL FROM public`, `GRANT EXECUTE to revessent_app` |
| 0014→0015 | `0014` superseded by `0015_webhook_org_scope_unique.sql` | delivery uniqueness scoped to `(org_id, source, coalesce(account,''), external_id)` — 0014's account-scope collides for account-less events across orgs and was corrected forward (never edited in place) |

**Fresh-DB bootstrap evidence:** `drop database; create database` → `drizzle-kit migrate` → **16 migrations (0000–0015), 30 tables**, RLS policies present on `webhook_events` + `stripe_connections` (2), unique index `webhook_events_delivery_uq`, resolver function present, all six new columns present. The full server suite (139) then ran against this fresh DB: **139/139**.

RLS is untouched by 4B (0013 adds only a function; 0014/0015 only indexes).

## §22-D. Test numbers (exact)

| Suite | Count | Notes |
|---|---|---|
| **Total vitest** | **183 passed / 183** (29 files) | stable across 3 consecutive full server runs + combined run |
| Backend (server project) | 139 | = 108 pre-existing (unmodified, incl. stripe-financial 20, concurrency, tenancy, RLS) + 31 new |
| Frontend (web project) | 44 | = 42 pre-existing + 2 new (stripe-view webhook honesty + failure-reconciliation) |
| **Webhook-security subset** | **16** | 9 receiver signature/replay tests (valid, missing, tampered, wrong-secret, stale, at/past-tolerance boundary, malformed JSON, unknown-orgRef, safe-code matrix) + 7 unit tests (`verifyStripeWebhook` codes incl. boundary override, `describeStripeEvent` object-kind guard, lossless payload provenance) |
| Webhook behavior/integration subset | 15 | persistence+provenance, first/duplicate/concurrent duplicate/duplicate-after-failure idempotency, ordering (older-after-newer, equal-timestamp), invoice whitelist + unknown-status anomaly, skipped-not-dropped, MRR recompute, account-mismatch, livemode, deauthorization+crypto-destruction+audit+post-revoke lockout, freshness honesty, org isolation, reconciliation |
| Typecheck | 9/9 OK | config, contracts, domain, observability, ui, db, integrations, server, apps/web — `tsc --noEmit` |
| Lint | 7/7 OK | the 7 lint-gated packages (config, contracts, domain, observability, ui, server, web), `eslint . --max-warnings 0` |
| Build | 0 errors | `next build --webpack`, 25 static pages, BUILD_ID produced |

No existing test was weakened or deleted; no test-count inflation (every new test targets a real §22 requirement).

## §22-E. Signature/replay security details

- Official `constructEventAsync` on the **raw** request body; tolerance 300 s; the stale case (`t` outside tolerance) is classified `stale_timestamp` via the SDK's own error message; header/payload tampering and wrong secrets are `invalid_signature`; malformed JSON is `malformed_payload` — all mapped to safe 400 problem+json with **zero persistence** (verified by DB assertion after each rejection).
- Boundary proven at the exact second: `now − 300` accepted, `now − 301` rejected; the tolerance parameter is overridable for deterministic tests but the production default is fixed at 300.
- Test signing uses the SDK's own `generateTestHeaderString` — the same crypto the verifier trusts; no homemade HMAC anywhere.
- Unverified events never touch the database; unknown/unverifiable endpoints return the same safe shape (no enumeration oracle: "Unknown webhook endpoint." for bad uuid, missing row, missing secret).

## §22-F. Uniqueness, races, org-crossing

- Event-id uniqueness is **DB-enforced** per delivery scope `(org_id, source, coalesce(account,''), external_id)` — same-org redelivery dedupes; two orgs connecting the same Stripe account (same event ids) never swallow each other's delivery. App-level `if (!existing) insert` is not relied on.
- App-level dedupe re-read is org-scoped; the advisory lock is keyed by event id and additionally every state check happens under the org RLS transaction.
- Cross-org: a signed event delivered to org A's endpoint only ever mutates org A rows (RLS org scope from the resolved connection). Tested with the same event id delivered to two orgs' endpoints.
- Webhooks never mutate Stripe: every 4B provider call is a read or an endpoint-lifecycle call on OUR own endpoint registration; no payment/refund/customer write exists.

## §22-G. Failure semantics

invalid/unverifiable ⇒ 400 (Stripe retries, then disables); valid ⇒ durably persisted, then ack; persisted-but-failed ⇒ `failed` + safe code + attempts++ (retryable on redelivery or reconcile); duplicate ⇒ idempotent no-op; processed events are never re-applied. No endless redelivery loop: terminal states answer `duplicate:true/processed|skipped|reconciled`.

## §22-H. Live verification status (§16 — the honest boundary)

- **What was verified live:** production `next build` + `next start` against the fresh 0000–0015 database; the public webhook route exercised over real HTTP: unknown endpoint ⇒ 400 problem+json; garbage `{orgRef}` ⇒ 400; missing signature ⇒ 400; `webhook_events` confirmed untouched (0 probe rows); internal surfaces (`/settings/stripe`, `/settings/stripe/reconcile`) still 401 without a session (auth intact); `/c/{token}` public surface unchanged (200).
- **What could NOT be verified and is explicitly NOT claimed:** a **real Stripe webhook delivery** (Stripe → this sandbox). This requires real Stripe API credentials and a publicly reachable HTTPS URL; neither exists in this environment. No live webhook delivery is claimed or fabricated. In its place: deterministic official-SDK signature/replay/boundary tests (§22-D webhook-security subset) plus full end-to-end service+RLS+DB tests over real Postgres, and the live-route checks above proving the HTTP surface (routing, raw body, header extraction, safe problem+json) is wired exactly as the service tests assume.
- Stripe's signature scheme guarantees that a delivery passing `constructEventAsync` against the per-connection secret is genuine Stripe traffic; the verification path exercised in tests is byte-identical to production.

## §22-I. Files created / changed (Phase 4B only)

- `packages/db/drizzle/0012_webhooks_4b.sql`, `0013_webhook_resolve_rls.sql`, `0014_webhook_scope_unique.sql`, `0015_webhook_org_scope_unique.sql` (+ journal), `packages/db/src/schema.ts` (parity), `packages/db/src/client.ts` (`withPgAdvisoryLock` generalization; `withOrgSyncLock` reimplemented on top — 4A behavior identical)
- `packages/integrations/src/webhook.ts` (NEW: `verifyStripeWebhook`, `describeStripeEvent`, `generateTestSignatureHeader` [test-side], `WEBHOOK_TOLERANCE_SECONDS`), `gateway.ts` (+`createWebhookEndpoint`/`deleteWebhookEndpoint`), `stripe-client.ts` (shared normalizers + endpoint lifecycle), `normalize.ts` (shared invoice/customer normalizers), `fixtures.ts` (endpoint fakes), `index.ts` (exports)
- `packages/server/src/services/webhooks.ts` (NEW), `sync.ts` (appliers extracted verbatim + exported; `recomputeCustomerMrr(db, orgId)`), `settings.ts` (endpoint lifecycle + webhooks DTO), `index.ts` (webhooksService export)
- `packages/contracts/src/schemas.ts` (`webhooks` block), `api.ts`/`real/realClient.ts`/`mock/mockApi.ts`+`store.ts` (reconcile + webhooks honesty)
- `apps/web/src/app/api/v1/webhooks/stripe/[orgRef]/route.ts` (NEW), `.../settings/stripe/reconcile/route.ts` (NEW), `views/settings/stripe-view.tsx` (webhook status block + reconcile)
- Tests: `packages/server/test/webhook-receive.test.ts` (24), `packages/server/test/webhook-verify.test.ts` (7), `apps/web/test/stripe-view.test.tsx` (+2)

## §22-J. Deviations / documented decisions

1. **§10 jobs adaptation:** architecture assumes BullMQ workers; 4B forbids Redis/BullMQ. Implemented as durable insert + inline idempotent processing + advisory-lock single-flight + duplicate-delivery retry + reconcile-on-demand. No scheduler exists; nothing is deferred silently — an hourly delta / nightly reconcile scheduler remains future-phase work (§22-L).
2. **Uniqueness scope:** task wording "DB-unique in provider/account scope" landed as (org, source, account, external_id): account-less events from two different Stripe accounts (two orgs) must not collide — the org IS the provider scope of a delivery (each org connects its own account). Migration chain 0014→0015 documents the correction forward.
3. **Missing-dependency events** (`dependency_missing:customer_not_synced`) are `failed` (retryable, surfaced in freshness, repairable by reconcile), not `skipped` — they represent a processing failure against a not-yet-synced org, which §16-F requires to be durable + visible.
4. **Revoked connections:** deliveries after secret destruction are safe-400 (cannot verify). Events arriving for a revoked-but-still-secreted connection before deauth are persisted and DB-only applied (never un-revoke; deauth event destroys material).
5. **Endpoint URL origin:** `webhookEndpointUrl` uses `BETTER_AUTH_URL` (the deployment's public origin, already required by auth) — no new env var introduced.

## §22-K. Security audit (17 checks)

1. Raw-body verification (never parse→restringify) — ✓ (route passes `req.text()` output; unit + e2e tamper tests)
2. Replay tolerance 300 s — ✓ (boundary tests at 300/301)
3. Custom crypto — none; official SDK only ✓
4. Secret exposure — `whsec` never logged, never in audit diff, never in API DTO; sealed at rest via AES-256-GCM envelope; destroyed on disconnect/deauth ✓ (asserted in tests)
5. Org-crossing — resolution only via connection id + signature; body org ids ignored; RLS scope from resolved org ✓ (isolation test)
6. Event-id uniqueness — DB-enforced scoped unique ✓ (migration + duplicate/concurrent tests)
7. Races — per-event advisory lock; single tx for mutation+status; onConflictDoNothing insert ✓ (concurrency test)
8. Ordering — provider-timestamp guard; older never overwrites newer ✓ (ordering tests)
9. Authz on internal endpoints — reconcile: session + `operate` RBAC (401/403 live-checked) ✓
10. Logging discipline — no keys/signing secrets/auth headers/decrypted creds/PII in logs or audit ✓
11. Unsafe JSON — malformed payload handled as safe code; no `eval`/dynamic exec anywhere ✓
12. SSRF — no URL fetching from webhook input; endpoint URL is server-derived, provider-side only ✓
13. Transaction gaps — mutation+status atomic; crash ⇒ `pending` ⇒ retryable ✓
14. Enumeration — uniform safe 400 for unknown/unverifiable endpoints ✓
15. Mode confusion — livemode/mode guard ⇒ 400 ✓
16. Account confusion — account-claim guard ⇒ persisted-skipped, never applied ✓
17. Provider-write surface — none; webhooks are read-only truth; lifecycle calls target only our own endpoint objects ✓

## §22-L. Explicitly NOT in Phase 4B (boundary)

Phase 4C / payment execution / workers (BullMQ/Redis/scheduled jobs) / AI / email / automated recovery execution / SSO / SLA / any Phase 5+ functionality has **NOT started**. Charge/dispute semantics beyond persistence-as-skipped, payment-method signals, checkout-provider confirmation, and scheduler-driven delta/nightly reconciliation remain future phases. The demo (demo mode) stays a labeled mock; no real provider behavior was added to it.

---

## Gate decision — 🟢

All 16 completion-gate items verified from actual source/test runs during THIS session (not from prior claims): (1) receiver per §10.3 with raw-body official verification ✓; (2) replay tests incl. boundary ✓; (3) durable persistence, DB-unique scoped event id, smallest forward migrations ✓; (4) idempotent processing incl. concurrent + after-failure, no mark→update window ✓; (5) §8.3 event set with 4A truth discipline + skipped-not-dropped ✓; (6) ordering guard + out-of-order test ✓; (7) honest freshness + failed-visibility + reconcile path, no scheduler introduced ✓; (8) reconciliation reusing 4A read-only infra ✓; (9) deauthorization with crypto-material destruction + no resurrection ✓; (10) endpoint lifecycle server-side with sealed secret ✓; (11) API conventions; signature-auth on the public route, session+RBAC internal ✓; (12) observability with logging discipline ✓; (13) failure semantics ✓; (14) 17 security checks ✓; (15) required test categories + full pre-existing suite unmodified ✓; (16) live verification honestly bounded (real Stripe delivery impossible here — stated, not fabricated) ✓. Final numbers: vitest 183/183 (server 139 = backend, web 44 = frontend; webhook-security 16; webhook behavior/integration 15+2), tsc 9/9, lint 7/7, build 0 errors, fresh-DB bootstrap 0000–0015 with RLS intact, live route checks all safe.

**Phase 4C / payment execution / workers / AI / email / other later functionality has NOT started.**

---

# FINAL CORRECTION ADDENDUM — Stripe Webhook Endpoint Lifecycle Consistency (2026-09-06)

External review finding: the connect/disconnect lifecycle crossed two systems that cannot share a transaction (Stripe endpoint lifecycle + PostgreSQL), so provider-created endpoints could become silently unknown and disconnects could be reported clean when provider cleanup had failed. Phase 4B was NOT restarted; this is a narrow correction on top of it.

## L1. Failure mode discovered (audit)

- **Connect:** `createWebhookEndpoint()` ran, then one big local transaction (delete-old-rows + insert + audit) could fail → an unknown provider-side endpoint with NO local record at all. On reconnect the same transaction hard-deleted the old row (including the old endpoint id + sealed key) — a failed replacement could leave the org with a destroyed local reference AND a new orphan.
- **Disconnect:** the provider `DELETE` ran INSIDE the local transaction. A provider failure destroyed the local secrets anyway (key + endpoint id gone → cleanup unretryable), while a local rollback after a successful provider delete left a "connected" row whose endpoint no longer existed — both split-brain, both invisible.
- **Bonus bug found and fixed during the audit:** the self-registered endpoint URL embedded the ORG id while the receiver resolves `{orgRef}` = CONNECTION id — a real delivery would have 400'd forever. The new provisioning-first flow derives the URL from the durable row id (regression-tested).

## L2. Exact correction (smallest architecture-consistent change)

Forward migration **0016_lifecycle_states.sql** (0012–0015 untouched):
- `stripe_connections.webhook_state` text — endpoint lifecycle nuance: `creating` (durable intent written BEFORE the provider call) | `registration_failed` | `cleanup_pending` | `provider_deleted_local_stale` | `orphan_cleanup`; NULL = registered/healthy. No secrets expressible here.
- `status` gains two NON-USABLE values: `provisioning` (pre-provider durable intent row) and `orphaned` (endpoint exists, finalization AND compensation both failed; sealed API key + endpoint id retained for cleanup authentication).
- The one-connection-per-(org,mode) table constraint became a partial unique index on `status = 'active'` — at most one ACTIVE (usable) connection; lifecycle history/transient rows coexist.

New flow shape: **provider operations never run inside a local transaction; local finalizations never run provider I/O.** Connect = (tx: provisioning intent) → create endpoint (no tx) → (tx: activate + atomically supersede the old ACTIVE row to recoverable `error`/`cleanup_pending`) → (no tx: delete superseded endpoint) → (tx: remove superseded row) — a failure at any point lands in a named recoverable state. Disconnect = read → (no tx: delete endpoint, idempotent) → (tx: revoke + destroy material); provider failure keeps the connection active + `cleanup_pending` (honest failed disconnect, retryable); local-finalize failure records `provider_deleted_local_stale` (retry completes idempotently — a 404/already-gone delete is a success).

## L3. Compensation behavior

`createWebhookEndpoint` succeeds + local finalization fails: REVESSENT deletes the just-created endpoint (no tx open). Compensation succeeds → the attempt row is removed and the ORIGINAL safe local failure is returned (nothing fabricated, nothing kept provider-side, audit `connection.failed {compensated: true, endpoint}`). Compensation fails → the row becomes `status='orphaned'` + `orphan_cleanup` with the sealed key + endpoint id (safe operational metadata) → surfaced as `lifecycle: orphan_cleanup` → reconciliation cleans it. If even that record fails, the `provisioning`/`creating` intent row still routes reconciliation to a URL-based discovery sweep (`listWebhookEndpoints`, read-only). The signing secret is never exposed, never logged; only sealed.

## L4. Reconnect behavior

The old connection stays fully usable until the new one is durably active: superseding the old ACTIVE row happens in the SAME transaction that activates the new one — a failure rolls back to the old connection untouched (proven by test 5). After the new connection is durably established, the superseded endpoint is deleted provider-side; success → old row removed (4A one-row rotation preserved); failure → old row kept as `error`/`cleanup_pending` with sealed key retained (observable + retryable + reconcilable), new connection never invalidated (test 7).

## L5. Disconnect behavior

Three representable outcomes: provider-del + local-ok (clean revoke, material destroyed); provider-del ok + local-fail (`provider_deleted_local_stale`, retry/reconcile completes locally); provider-del fail (connection stays ACTIVE + `cleanup_pending` + sealed key, disconnect throws an honest 500-class problem — never a fabricated clean disconnect). Retries are idempotent (already-gone = success).

## L6. Reconciliation integration

`repairLifecycle` (part of the existing `reconcileFromProvider` path, returned as `lifecycle: string[]` actions) identifies and repairs exactly the five observable states: healthy / registration_failed (surfaced, NOT auto-re-created — re-creation is not cleanup) / cleanup_pending (retry delete; finalize per rotation rules) / provider_removed_local_stale (local finalize) / orphan_cleanup (delete our endpoint, destroy material, convert to revoked history). Provisioning-intent rows are reaped via endpoint-id or URL discovery. Read-only toward Stripe EXCEPT deletion of REVESSENT-owned endpoint configuration; no scheduler/worker introduced (this remains Phase 4B).

## L7. New tests (15, focused; no existing test weakened or deleted)

`packages/server/test/webhook-lifecycle.test.ts` — local-finalization failures injected with a REAL superuser DB trigger (genuine DB errors, not mocks); provider failures via the deterministic fixture plans. Connect: (1) create+finalize success incl. URL-names-connection-id regression; (2) create failure → active + registration_failed observable; (3) finalize fail + compensation ok → no endpoint left, no fabricated success; (4) finalize fail + compensation fail → durable orphan, no secret exposure; (5) reconnect failure preserves the usable connection; (6) successful reconnect cleans the old endpoint, one row; (7) old-endpoint cleanup failure observable, new connection valid. Disconnect: (8) clean; (9) provider failure → active + recoverable + honest failure; (10) provider ok + local fail → explicit mismatch state; (11) retry after partial completes idempotently; (12) already-deleted endpoint idempotent. Recovery: (13) five states distinguishable; (14) reconciliation repairs real orphan + cleanup_pending rows; (15) reconciliation read-only except own-endpoint cleanup (call-counter proven).

## L8. Final counts + gates (all run this session, from source)

- **vitest 198/198** (30 files): server **154** (= 108 Phase 4A + 24 webhook-receive + 7 webhook-verify + 15 lifecycle, all pre-existing assertions intact) + web **44** (unchanged) · webhook-security subset 16 · webhook behavior/integration 17 · lifecycle 15
- tsc **9/9** OK · eslint **7/7** OK (`--max-warnings 0`) · `next build --webpack` **0 errors** (BUILD_ID produced)
- **Fresh bootstrap:** empty DB → 17 migrations (0000–0016) → 30 tables, RLS policies intact, partial unique index `stripe_connections_org_mode_usable_uq … WHERE status = 'active'`, `webhook_state` present; full 198-test suite green against that fresh DB (existing 4B data remains valid — no data migration needed; 0016 is additive)
- Live route checks (production build + fresh DB): unknown endpoint/missing signature → safe 400 problem+json with zero persistence; internal settings/reconcile routes 401 without session; `/c/{token}` 200; DB confirmed untouched by unverified probes

## L9. Invariants proof (correction §11)

- **Connect:** tests 3/4 + the `creating` intent row + URL discovery sweep — a created endpoint ends up associated, compensated, or durably recorded as orphan; never unknown.
- **Reconnect:** test 5 (failure preserves old row+endpoint; atomic supersede) + test 7 (cleanup failure keeps new connection).
- **Disconnect:** tests 9/10/11 — every mismatch is a named recoverable state; no false clean disconnect.
- **Secrets:** no lifecycle path returns or logs the API key or signing secret (assertions scan DTOs, errors, and audit diffs; audit redaction unchanged); destruction-on-revoke preserved.
- **Phase 4A guarantees:** all 108 pre-existing server tests pass unmodified (rotation one-row semantics, validation-nothing-stored, RLS/tenancy, concurrency lock, financial truth).

## L10. Live verification limitation (honest)

A REAL Stripe endpoint create/delete/retry cycle against Stripe's API cannot be exercised here (no live Stripe credentials, no public HTTPS ingress) and is NOT claimed. The deterministic coverage is: real-DB trigger-injected finalization failures + fixture provider failures at the same seams the production code crosses (the gateway boundary), over real Postgres with real RLS, plus the live HTTP checks above. The provider-side behaviors that remain unverifiable until a Stripe-connected environment exists: actual endpoint object semantics (404 shape, error envelopes) — the client maps `statusCode 404 / "No such webhook endpoint"` to idempotent success, but that branch is unit-reasoned, not live-proven.

Phase 4C / payment execution / workers / AI / email / other later functionality has NOT started. Stopping here for external review.
