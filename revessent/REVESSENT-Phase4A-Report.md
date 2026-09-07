# REVESSENT — Phase 4A Report
## Stripe Connection, Secure Credentials & Read-Only Synchronization

**Date:** 2026-09-06 · **Status: review-ready** · **Gate: 🟢 (green, with one explicitly BLOCKED item — live success-path verification — per the DoD rule "if no live credentials, do NOT fabricate; mark BLOCKED")**

Phase 4A connects the Phase 2/3 product to Stripe for **read-only** purposes only: restricted-key connection, AES-256-GCM-encrypted credentials, provider-verified account identity, per-entity incremental-safe synchronization of customers / subscriptions / invoices→payments, honest freshness, resumable cursors, a ≥9-code safe error taxonomy, and full audit coverage. **No payment execution of any kind was started** — no retries, charges, confirmations, upgrades, refunds, captures, payment-method mutation, recovery execution, webhook execution, BullMQ, AI, or email. Phase 4B has **not** been started.

---

## 1. Phase 3 baseline (what this phase built on)

| Baseline fact | Value at handoff |
|---|---|
| Server tests | 54/54 (auth, tenancy ×2 layers, RLS hardening 0005–0009, Zod→400 problem+json, rate limiter, approval invariant, migrations deterministic) |
| Web tests | 36/36 (Phase 2 regression, mock-labeled demo client) |
| tsc | 8 packages + web: clean |
| lint / build | clean (turbo 7 tasks; webpack build; demo-flag prerender exception documented in Phase 3) |
| Migrations | 0000–0009 applied on :5433 |
| Stripe settings UI | Phase 2 visuals with a demo/format-only connect flow |
| Credentials | Phase 3 AES-256-GCM envelope (`sealSecret`/`openSecret`, `KEY_ENCRYPTION_KEY`, iv.tag.ciphertext) — reused, **not** reinvented |

## 2. Files created / changed (Phase 4A only)

**Created**
- `packages/integrations/` — new workspace package (server-only integration boundary):
  - `src/index.ts` (35 lines) — `import "server-only"` first line; type re-exports; `ProviderError`/`classifyProviderError`/`isProviderError`; `getStripeGateway()`; `setStripeGatewayForTests()`/`resetStripeGateway()` (test-only injection).
  - `src/gateway.ts` — provider-agnostic interface: `verifyAccount(key)`; `listCustomers/listSubscriptions/listInvoices(key, {startingAfter, limit, createdAfterEpoch})` → `Page{data, hasMore, nextCursor}`. Restricted key is the first argument everywhere. Domain read operations, not raw SDK sprawl.
  - `src/stripe-client.ts` — real gateway over stripe 22.6.1 (Stripe-22-correct field access: `parent.subscription_details.subscription`, `invoice.payments[]` for PI/charge ids, `accounts.retrieve(null)` = the key's own account, `maxNetworkRetries: 0` with explicit bounded transient retry `withTransientRetry` at our layer, 15 s timeout, telemetry off).
  - `src/errors.ts` — 9-code taxonomy + `classifyProviderError` + `isProviderError`.
  - `src/fixtures.ts` — deterministic fixture gateway (`fixtureGateway(FixtureWorld)`, sorted-by-`created` pagination default pageSize 2, `createdGt` filter, `FailurePlan{on, pageIndex, kind, retryAfterSec}`, call counters) + `fixtureAccount/Customer/Subscription/Invoice` builders.
- `packages/server/src/services/sync.ts` — triggerSync/syncEntity/fetchPage/persistPage/recomputeCustomerMrr.
- `packages/db/drizzle/0010_stripe_sync_4a.sql` (+ `schema.ts` updated to match).
- `apps/web/src/app/api/v1/orgs/[slug]/settings/stripe/sync/route.ts` — POST manual sync (operator+).
- Tests: `packages/server/test/stripe-connection.test.ts` (8), `stripe-sync.test.ts` (11), `stripe-tenancy.test.ts` (5), `stripe-boundary.test.ts` (4), `apps/web/test/stripe-view.test.tsx` (6).

**Changed**
- `packages/server/src/services/settings.ts` — real connection flow replaces the Phase 3 format-only demo path; per-entity freshness; `decryptConnectionKey` (worker-only helper) unchanged in spirit, now real.
- `packages/server/src/index.ts` — exports `syncService`.
- `packages/server/src/services/customers.ts` — list excludes provider-deleted (soft-deleted) customers.
- `packages/contracts/src/schemas.ts` — `StripeConnectionSchema` extended: status `+invalid`, optional `keyLast4/displayName/country/defaultCurrency/lastValidatedAt`, `sync{customers|subscriptions|invoices}` per-entity state; `SyncEntityResult/SyncResponse`; `ApiClient.settings.sync()`; real client, mock client, mock store fixtures extended (additive/optional — old clients unaffected).
- `apps/web/src/views/settings/stripe-view.tsx` — real-state UI (§12 below), "Sync now", per-entity freshness, invalid/revoked explanatory states.
- `apps/web/src/lib/permissions.ts` — added `run_sync` action (operator+).
- `vitest.config.ts` — integrations aliases for the server project; `server-only` mapped to its empty entry in the node test environment (vitest runs server code; Next enforces the boundary in the real build).
- `packages/integrations/package.json` — subpath export `./fixtures` (test scaffolding).
- Pre-existing lint errors in Phase 3 files fixed forward (behavior-neutral): `auth.ts` unused proxy arg, `checkout.ts`/`expansion.ts` unused queries (the payments/customers selects remain as existence checks), unused imports in `recovery.ts`/`customers.ts` and four Phase 3 test files. **Fixed as found; nothing suppressed.**
- Latent bug fixed: the test-env `KEY_ENCRYPTION_KEY` decoded to 33 bytes (44 base64 chars); any real crypto use in tests would have thrown. Now a true 32-byte key in `vitest.server-setup.ts` and `demo-safety.test.ts`.

## 3. Migrations

`0010_stripe_sync_4a.sql` (generated `--custom`, applied on :5433; deterministic from empty DB):
- `stripe_connections` += `display_name`, `account_country char(2)`, `default_currency char(3)`, `last_validated_at`, `validation_error` (safe code only); `status` domain now `active|revoked|invalid|error`.
- `customers` += `deleted_at` (provider deletions soft-delete — history preserved).
- **New table `sync_state`**: id uuid pk, org_id FK cascade, `entity ∈ {customers, subscriptions, invoices}`, `status ∈ {idle, running, ok, failed}`, `cursor`, `provider_account`, `pages_synced`, `records_upserted`, `last_success_at`, `started_at`, `finished_at`, `last_error` (code only), created/updated; `UNIQUE(org_id, entity)`; RLS `org_isolation`; grants to `revessent_app`.
- `CREATE UNIQUE INDEX payments_org_invoice_uq ON payments(org_id, stripe_invoice_id) WHERE stripe_invoice_id IS NOT NULL` — DB-layer idempotency for invoice→payment upserts.
- `webhook_events` (existing from Phase 3 schema) commented: **"Phase 4B PREPARATION ONLY: events are persisted [but not processed]"** — preparation marked, no fake processing.

No historical migration was edited.

## 4. Connection architecture (§6 flow, real)

`POST /settings/stripe/keys` (admin+) →
1. Format gate (`/^(sk|rk)_(test|live)_[A-Za-z0-9]{16,}$/`) — malformed keys are refused locally, **the provider is never called** (test: provider-call counter stays 0). Mode derived from prefix.
2. `connection.attempted` audit (`{mode}` only).
3. Harmless read-only provider call `accounts.retrieve(null)` → **provider-verified identity** (id, display name, country, default currency). Never from user input.
4. On failure: **nothing is persisted** (row count asserted 0 in tests), `connection.failed {code, mode}` audited, safe problem+json mapped from the taxonomy. Never "connected" before validation succeeds.
5. On success: key sealed with the **Phase 3 AES-256-GCM envelope**; same-mode row deleted + inserted (rotation replaces, never duplicates); `keyLast4` retained for display; scopes recorded `{read: [account, customers, subscriptions, invoices, charges]}`; status `active`; `last_validated_at` set; `connection.succeeded {mode, last4, account}` audited.
6. DTO exposes only safe metadata; `status = read_only` (write scopes arrive in a later phase with explicit re-authorization).

`GET /settings/stripe` (view+) → not_connected DTO or sealed metadata + per-entity sync state. `DELETE /settings/stripe` (admin+) → status `revoked`, audited `connection.disconnected`; DTO honestly reports removal.

## 5. Credential security (§5)

- Key lives only in the request body in memory; sealed server-side; **plaintext never stored, logged, audited, or returned**. Tests assert: DTO + audit JSON + DB row contain no key fragment; ciphertext is exactly 3 dot-separated parts (iv.tag.ciphertext); row keeps only `keyLast4`.
- Decryption is server-side only (`decryptConnectionKey`, documented worker-only; sync decrypts in memory per run). No browser path can reach it: `server-only` in the integrations entry; source-grep tests assert no web module imports `@revessent/integrations`, `integrations/fixtures`, `stripe-client`, or `sealSecret/openSecret/KEY_ENCRYPTION_KEY`.
- Revocation: disconnect sets `revoked` (distinct from `invalid`); revoked/invalid UI states explain reconnection.
- Rotation: same-mode reconnect replaces the ciphertext (exactly one row per org+mode — asserted).
- Display: last-4 only; UI shows `…b3x1 (stored encrypted)`.

## 6. Synced entities (§8 — read-only)

- **Customers**: provider id/email/name/currency/created; `deleted` → local soft delete (`deleted_at`), never erasure; `mrr_cents` derived (below).
- **Subscriptions**: require a locally-synced customer `(org, stripe_customer_id)` — **never fabricated**; status verbatim (`active|trialing|past_due|canceled|unpaid|incomplete…`), amount minor units, interval (month|year), cancel-at-period-end, canceled/current-period timestamps.
- **Invoices → `payments`** (Phase 1 model: payments are the invoice-bearing records): `stripe_invoice_id`, PI/charge ids extracted **only** when the provider surfaces them as strings (never guessed — Stripe 22 moved these into `invoice.payments[]`); integer minor-unit amounts; status map `paid→paid, void→void, uncollectible→failed("uncollectible"), open+attempted→failed("open_invoice"), open→open`; attempted-count, hosted-invoice-url, period/failed/paid timestamps.

## 7. Sync behavior (§9)

- `POST /settings/stripe/sync` (operator+): single-flight per org (running state guards), entities in dependency order customers → subscriptions → invoices; audits `sync.started` / `sync.succeeded {entities, counts}` / `sync.failed {entity, code}`.
- **Pagination handled — never truncated**: cursor `starting_after` loops; hard bound `MAX_PAGES_PER_ENTITY = 200` retains the cursor checkpoint → a >200-page entity **pauses resumable** rather than silently truncating ("do not assume one request is enough" is enforced structurally; fixtures force multi-page with pageSize 2).
- **Idempotent at the DB layer**: DB unique constraints, not app checks — `customers(org, stripe_customer_id)` / `subscriptions(org, stripe_subscription_id)` / `payments_org_invoice_uq(org, stripe_invoice_id) WHERE stripe_invoice_id IS NOT NULL`; `onConflictDoUpdate` repeats the partial-index predicate (`targetWhere`) to avoid 42P10 (caught by tests, as predicted).
- **Stripe is the authority**: repeat sync = no duplicates; provider updates overwrite provider-owned local state (status `active→canceled` asserted, MRR → 0); provider deletions soft-delete; unknown provider refs are counted as anomalies and skipped (no fabricated rows).
- **Degraded states preserve known-good data**: a mid-sync failure (rate limit, network, outage) keeps every page persisted before the failure; the entity is marked `failed` with a safe code; the connection is NOT invalidated; the next sync resumes from the checkpoint (union-of-runs asserted — nothing lost).
- **No network calls inside DB transactions**: validate → normalize → persist per page; each page commits its own checkpoint (no giant transaction around provider I/O, no partial corruption).

## 8. Freshness model (§10)

`sync_state` per (org, entity): `status ∈ never|running|fresh|stale|failed`, `last_success_at`, `last_attempt_at`, `last_error` (code only), cursor checkpoint, provider account stamp, pages/records counters. Connection-level `last_sync_at`/`backfill_done_at` on `stripe_connections`. Freshness window **6 h** (`fresh` ≤ 6 h, else `stale`). The DTO exposes all three entities; the UI renders each honestly — `never synced`, `syncing…`, `fresh · 5m ago`, `stale · 9h ago`, `failed — previous data preserved` + safe reason + retry. **Pre-sync there are no fabricated zeros and no empty-workspace pretense**: overview returns nulls + a "connect Stripe" activity item; customers list is simply empty.

## 9. Error taxonomy (≥9 codes, §11)

`invalid_credentials, revoked, auth_failure, permission_failure, rate_limited, transient_network, provider_outage, invalid_provider_object, malformed_response` → `ProviderError{code, safeMessage, status, problemType, retryAfterSec}` → problem+json `/errors/{validation, connection-revoked, rate-limited, provider-unavailable, internal}`. Raw Stripe details never reach the browser: only `safeMessage` is client-visible; audit stores the **code only**. `classifyProviderError` inspects SDK error `type/name/statusCode` plus minimal server-side markers (`Invalid API Key`, bare undici `fetch failed`); already-classified errors pass through unchanged (`isProviderError` — structural identity, see §15 deviations). Transient codes get bounded in-gateway retry (3 attempts, 500 ms base backoff) — explicit and counted, no uncontrolled loops.

## 10. Tenancy (§11 — tested at BOTH layers)

- Query layer: every read/write goes through `withOrgTx` (org-scoped, RLS-guarded transactions). Tests: connections are per-org (distinct provider accounts visible per org; exactly one row each); synced records never cross orgs (disjoint `stripe_customer_id` sets per org, every row stamped with exactly one org); shared-provider-fixture syncs stamp rows with the triggering org only.
- RLS layer: inside org B's transaction, org A's `stripe_connections`/`sync_state` rows are invisible; **org B cannot UPDATE org A's connection row by id** (silently excluded; row verified untouched).
- Triggers: sync is per-org (`POST …/sync` resolves the org from the slug); unauthenticated sync POST → 401 (live-verified); operator+ required.

## 11. Security tests (§20/§21 selections)

- Credential security: invalid key rejected before any provider call; success stores ciphertext-only; DTO/audit/DB never contain the key; rotation replaces; last-4 display.
- Connection: success (identity verified + encrypted + audited), invalid-credentials (nothing stored, code-only audit), revoked-at-validation (409, nothing stored), disconnect (revoked + audited), no fake success.
- Sync: multi-page pagination (3 pages, 5 records, none truncated), repeat-idempotent, provider-update propagation, provider deletion soft-delete, deletion-history preserved, failure preserves earlier pages + honest `failed` freshness + intact connection, checkpoint resume (union of runs, nothing lost), integer money, MRR derivation (month ×1 / year ÷12 / canceled ×0), no fabricated payments for unknown customers, no-connection sync refused (409).
- Boundary: `server-only` present; real client not exported directly; zero web imports of the integration package/crypto envelope (source grep).
- Frontend: 6 states (connected / not_connected / viewer-restricted / revoked / failed-preserves / credential-never-rendered-after-submit).
- **Live HTTP (production build, real mode)**: unauthenticated GET → 401 problem+json; malformed key → 400 (provider never called); **well-formed fake key → real Stripe 401 → 400 `/errors/validation` with only the safe message** (see §13); sync without connection → 409; after failure the connection remains `not_connected` (nothing persisted — DB-verified); audit rows are `{mode}` / `{code, mode}` only.

## 12. Frontend integration (§13/§17)

The Phase 2 Stripe settings view keeps its visual design; the demo/format-only fiction is gone. States now rendered: `not connected` (explains the need), `connected · read-only` (safe identity: display name + account id, locale, `…last4 (stored encrypted)`, validated/synced ages, write-scopes-coming note), `revoked — reconnect required`, `validation failed` (invalid), per-entity sync lines with honest freshness, `Sync now` (operator+) with real busy state and completion/failure toasts that never overclaim ("finished with failures — previously synced data is preserved"). The credential input clears and the form unmounts on success — the key is never rendered again (test-asserted against the DOM). Demo mode keeps its labeled mock behavior (format-only validation, clearly marked "demo validates the FORMAT only"). Overview / customers / recovery read real synced tables with honest empties; recovery execution remains clearly unavailable (Phase 3 boundary unchanged).

## 13. Live verification status (§14) — the one BLOCKED item

- **Live SUCCESS-path connection: BLOCKED.** No real Stripe test-mode restricted key is available in this environment. Per the DoD rule this was **not fabricated**; the integration boundary is covered by deterministic provider fixtures (§11).
- **Live failure-path: VERIFIED against the real Stripe API.** The sandbox reaches `api.stripe.com`; submitting a well-formed fake restricted key through the production build produced a genuine Stripe 401 → `invalid_credentials` → `400 /errors/validation` carrying only the safe message, audited `{code, mode}`, nothing stored. This exercised the full real path: route auth (401/403 gates), format gate, real SDK call, real classification, safe problem mapping, audit, persistence-abstention.
- All other live checks (unauth 401, malformed 400, sync-without-connection 409, not_connected-after-failure) ran against the production build with a real signed-up user, real workspace, real DB.

## 14. Deferred (explicitly NOT in 4A)

Retries/payment execution, checkout creation, upgrades, refunds, captures, payment-method mutation, recovery execution, webhook **execution/processing** (persistence-only table prepared, commented "Phase 4B PREPARATION ONLY"), BullMQ/Redis workers, automatic scheduled syncs, AI, email. `webhook_events` is one source of truth awaiting 4B; no second source of truth was introduced.

## 15. Deviations from the Phase 1 plan (documented, none silent)

1. **Durable sync state = `sync_state` table per (org, entity)** instead of planned jsonb columns on `stripe_connections` — gives cursor checkpoints, per-entity freshness and failure codes a first-class, RLS-covered home.
2. **No `stripe_sync_runs` table** — run outcomes live in the audit log (`sync.started/succeeded/failed`), consistent with Phase 3's audit-as-observability stance; avoids a second ledger to keep honest.
3. **`import "server-only"` inside the integrations entry** instead of a separate server-only entry file — same guarantee (build error on client import), one less file.
4. **Manual sync is a bounded FULL refresh, not a created-filter incremental pass.** With webhook execution deferred to 4B, a `created > last_success` pass could never observe provider updates/deletions and would let local data drift from Stripe — the authority. The gateway contract keeps `createdAfterEpoch` for the 4B automatic scheduler (where webhooks make incremental passes safe). Cursor-awareness in 4A serves resumability (checkpoints), which tests cover.
5. **`isProviderError` structural identity** (duck-typed passthrough in `classifyProviderError`) — discovered during live verification: webpack can duplicate a class across chunks so `instanceof` fails and a `ProviderError` from one chunk is re-classified by another (observed live: `invalid_credentials` was double-classified into `malformed_response` → wrong 500). Structural checks fix this class of bundling bug; a regression test covers passthrough via the live-verified 400 path.
6. Phase 2 mock `stripe()` DTO extended with the new optional fields so demo fixtures display the same safe metadata as reality.
7. Pre-existing Phase 3 lint debt and the 33-byte test `KEY_ENCRYPTION_KEY` were fixed forward (§2) — behavioral no-ops, no history rewritten.

## 16. Gate decision — 🟢 (with BLOCKED item, per DoD)

| Gate | Result | Evidence |
|---|---|---|
| tsc ×8 packages + web | 🟢 clean | all 9 `tsc --noEmit` pass |
| lint | 🟢 7/7 | `turbo run lint --force` |
| unit/integration tests | 🟢 124/124 | server 82 (54 baseline + 28 new), web 42 (36 baseline + 6 new); 25 files |
| build | 🟢 exit 0 | webpack production build (demo-flag stash procedure per Phase 3) |
| migrations | 🟢 | 0000–0010 from empty DB; 0010 applied on :5433; deterministic |
| tenancy ×2 layers | 🟢 | query-layer + RLS tests (§10); RLS not weakened (forward migration only) |
| live HTTP | 🟢 | §13 — 401/400/409 gates, safe mapping, nothing-persisted, audit codes-only |
| live Stripe success path | 🟡 **BLOCKED** | no credentials available; not fabricated; boundary covered by fixtures; real 401 failure path verified against api.stripe.com (§13) |
| Phase 2/3 regression | 🟢 | 54 server + 36 web baseline tests all still pass; visuals preserved |

**Known limitations (honest):** subscription MRR assumes `items.data[0]` first-price and `interval ∈ {month, year}` (others contribute 0 and are counted, never guessed); invoice PI/charge ids extracted only when unexpanded strings are present; scope map is recorded, per-scope enforcement arrives with write scopes; >200-page entities pause resumable rather than completing in one run.

**DoD status:** all tests + lint + typecheck + build + migration + tenancy + live HTTP done; live-provider success test BLOCKED and marked, not fabricated. **Phase 4B not started — awaiting external audit.**

---

# FINAL AUDIT ADDENDUM B — Financial Data Truth (2026-09-06)

**Gate: 🟢 PASS.** Provider data is never silently reinterpreted; every unknown stays unknown; all gates green. The only standing external limitation remains the unavailable live Stripe success-path credentials (documented BLOCKED, not fabricated). Phase 4B not started.

## B1. Financial mapping issue (confirmed and fixed)

The Stripe adapter mapped subscription cadence with `recurring?.interval === "year" ? "year" : "month"`, silently converting `week`, `day` and any missing recurring object into `"month"` — a provider value reinterpreted into a false financial fact (weekly $10 would display and sum as $10 **monthly** MRR). The same audit pass found three sibling defaults in the adapter: `unit_amount ?? 0` (absent amount → $0 price), `currency ?? "usd"` (absent currency → invented USD, on subscriptions **and** invoices), and invoice `status ?? "open"` (unknown/draft state → "open").

## B2. Root cause

The normalized gateway contract was narrower than reality (`interval: "month" | "year"`, `amountMinor: number`), so the adapter was forced to squeeze every provider value into a total function — and chose falsifying defaults over honesty.

## B3. Correction (smallest justified contract change, documented)

- **New pure normalizer** `packages/integrations/src/normalize.ts` (`normalizeSubscription`, exported from the package root — the real stripe-client remains un-exported; boundary tests unchanged): interval is verbatim `month`/`year` or **`"unsupported"`** (day/week/missing recurring — never converted); `amountMinor` is the provider integer or **`null`** (explicit provider `0` stays meaningful `0` — e.g. a free price; absence ≠ zero); `currency` is the provider value or **`""`**; new `itemCount` carries the true number of provider items.
- **Gateway contract change (documented):** `ProviderSubscription.interval: "month" | "year" | "unsupported"`, `amountMinor: number | null`, `+ itemCount: number`. The domain model was NOT broadened to accept every Stripe interval — unsupported data gets an honest label and is excluded from derived metrics.
- **Sync persistence guards** (`sync.ts` subscriptions branch): missing `priceId` → skip + anomaly (no invented `"unknown"` sentinel — that pre-existing default was removed); absent/invalid `amountMinor` → skip + anomaly (never a $0 recurring row); currency not 3 letters → skip + anomaly (never `"usd"`); `interval === "unsupported"` → **persisted verbatim** with the anomaly count incremented (provider identity/state preserved; MRR excludes it); `itemCount > 1` → first-item row persisted + anomaly (limitation surfaced, not silent). Invoice branch: unknown `status` (draft) and invalid currency → skip + anomaly.
- **MRR SQL fixed:** `sum(case when 'year' then amount/12 when 'month' then amount else 0 end)` — the old `else amount` branch would have summed an honestly-stored `unsupported` interval at full monthly weight (weekly $10 → $10 MRR). Now impossible.
- **Contract:** `SubscriptionRowSchema.interval` widened with `"unsupported"` (additive enum value); customer-detail view renders it honestly ("cadence unsupported"), never as "/yr".
- DTO MRR currency: prefers the provider-validated subscription currency, then the provider customer currency; `"USD"` now labels only the zero case (no supported recurring revenue) — a presentation default, not a fact.

## B4. Missing/default-value audit (repository-wide, field-by-field)

| Occurrence | Classification | Action |
|---|---|---|
| adapter `interval === "year" ? "year" : "month"` | **Invalid** — cadence reinterpreted | fixed → verbatim `month`/`year`/`"unsupported"` |
| adapter `unit_amount ?? 0` | **Invalid** — absence → $0 price | fixed → `null` (unknown); explicit provider 0 stays 0 |
| adapter sub `currency ?? "usd"` | **Invalid** — invented currency | fixed → `""` + sync skip+anomaly |
| adapter inv `currency ?? "usd"` | **Invalid** — same class | fixed → `""` + sync skip+anomaly |
| adapter inv `status ?? "open"` | **Invalid** — unknown state mislabeled open | fixed → `""` + sync skip+anomaly |
| adapter `priceId ?? ""` → sync `\|\| "unknown"` | **Invalid** — invented identity sentinel | fixed → skip + anomaly, default removed |
| adapter `attempt_count ?? 0` | **Valid** — provider represents "no attempts" as 0 | kept |
| adapter `amount_paid`/`amount_due` (no default) | **Valid** — guaranteed invoice fields, used verbatim | kept |
| adapter customer `currency ?? null` | **Valid** — unknown stays null in schema | kept |
| `period_start/period_end/paid_at` → `null` when absent | **Valid** — unknown stays unknown | kept |
| MRR `coalesce(s.mrr, 0)`; zeroing customers with no active subs | **Valid (documented)** — MRR is *revenue from supported cadences*; zero = no supported recurring revenue; exclusions carry anomalies | kept + documented |
| overview `coalesce(sum(...), 0)`, `?? 0`, series zeros | **Valid** — SQL SUM over no rows = true zero of app-owned ledgers (Phase 3 data, not provider sync); pre-connection states return `null` not 0 | kept |
| overview `closed30 === 0 ? null : rate` | **Valid** — unknown rate stays null | kept |
| `Number(...)` casts (bigint mode columns), `recovery.ts` counts | **Valid** — DB integer typing, not provider defaults | kept |
| `errors.ts statusCode ?? 0`, `retry-after ?? "0"` | N/A — error-control metadata, not financial | kept |
| `normalize.ts itemCount ?? 0` | **Valid** — 0 items fails the price-identity gate downstream | kept |

No `parseFloat/parseInt` on financial paths exists in the repo.

## B5. MRR behavior (explicit supported-interval model)

**The Phase 4A domain model supports exactly two recurring cadences: `month` and `year`.** MRR = Σ over subscriptions with status `active|trialing|past_due` of: `month` → amount × 1; `year` → amount ÷ 12 (existing defined calculation, unchanged); **anything else → excluded (contributes 0) with an explicit anomaly recorded at sync time**. No conversion formula is invented for `day`/`week` (weekly $10 becomes neither "$10 MRR" nor "$40 MRR"). A customer whose only subscriptions are unsupported-cadence has `mrr_cents = 0`, which by this documented definition means "no supported recurring revenue" — the underlying subscriptions remain visible with their true amounts and `interval: "unsupported"` in the customer detail (rendered "cadence unsupported"), and the anomaly count appears in the sync summary response.

## B6. Tests added (15, all new — no existing assertion weakened)

`packages/server/test/stripe-financial.test.ts`:
- Adapter (9): week→`unsupported` (not month); day→`unsupported`; missing recurring→`unsupported`; month/year verbatim; missing `unit_amount`→`null` (not $0); explicit provider `0`→`0` (meaningful zero); missing currency→`""` (not usd); missing price→`""`; multi-item→`itemCount: 2` with first-item amount.
- Sync/DB (6): weekly stored as `"unsupported"` + `mrr_cents 0` + `anomalies 1`; mixed month+week → MRR counts only the monthly sub (1900, anomaly 1); missing amount → **no row**, no MRR, anomaly; missing recurring → never `"month"` in DB; multi-item → first item preserved + explicit anomaly; month→×1 / year→÷12 unchanged (regression guard).

## B7. Full regression results

| Gate | Result |
|---|---|
| Backend tests | 🟢 103/103 (88 + 15 new; **zero existing tests changed**) |
| Frontend tests | 🟢 42/42 |
| Typecheck | 🟢 9/9 (contracts, db, domain, ui, config, integrations, server, web) |
| Lint | 🟢 turbo 7/7 (`--force`) |
| Production build | 🟢 exit 0 (financial-truth changes included) |
| Fresh migration bootstrap | 🟢 0000–0011 from empty DB → 30 tables (re-verified after this pass) |
| Concurrency / connection / sync / tenancy / boundary suites | 🟢 all green |
| Live HTTP (new build) | 🟢 revoked connection → 409; re-seeded active connection sync → honest per-entity `invalid_credentials` (real Stripe 401), freshness `failed/invalid_credentials`, nothing fabricated |

Security recheck: no key material in web source; no client imports of integrations/crypto; no secret logging; revoked keys destroyed (material `NULL`, sync refuses); cross-org isolation tests green; `pg_try_advisory_lock` single-flight intact; **no later-phase functionality added** (no webhooks, workers, payment writes, retries, email, AI).

## B8. Remaining documented limitations

1. **Supported interval model is exactly `month` | `year`** — other Stripe cadences (`day`, `week`) are stored verbatim as `"unsupported"`, excluded from MRR, and counted as anomalies. They are NOT supported and NOT converted. Automatic scheduling/incremental passes wait for 4B webhooks.
2. **First-item pricing:** multi-item subscriptions contribute their FIRST item to the read model/MRR; `itemCount > 1` raises an explicit anomaly. This is Phase 4A's defined behavior — it does not claim to represent total multi-item subscription revenue.
3. **Live Stripe success-path verification remains BLOCKED** (no credentials available in this environment; deterministic fixtures cover the boundary; the real 401 failure path is live-verified).
4. Tiered/volume prices (`unit_amount: null`) are recorded as anomalies and excluded until a pricing model that can represent them exists — they never appear as $0.

## B9. Final gate for Phase 4A: 🟢 PASS

Provider data is never silently reinterpreted: unknown intervals/amounts/currencies/states remain unknown (or are skipped with anomalies), `unsupported` is preserved verbatim in the domain, MRR derives only from supported cadences under the documented model, and every existing and new gate is green. **Phase 4B not started — awaiting external review.**

---

# FINAL AUDIT ADDENDUM C — Invoice Status Must Never Be Invented (2026-09-06)

**Gate: 🟢 PASS.** Unsupported provider states can no longer silently become known REVESSENT financial states; all gates green; the only standing external limitation remains the unavailable live Stripe success-path credentials (documented BLOCKED, never fabricated). Phase 4B not started.

## C1. Issue (confirmed and fixed)

The invoice persistence mapping ended with a catch-all `else → "open"`. A provider status such as `draft` (and any future Stripe status) was silently persisted as `open` — a fabricated payment state. The prior audit had fixed only the *missing*-status case (`"" → skip`); unsupported *non-empty* statuses still flowed through the default.

## C2. Root cause

The mapping was written as a total function over an open string domain instead of an explicit whitelist over the supported set — every unmapped provider value fell into a convenient default.

## C3. Correction

`sync.ts` invoice branch now maps **explicitly and exclusively**:

| Stripe invoice status | REVESSENT payment status |
|---|---|
| `paid` | `paid` |
| `void` | `void` |
| `uncollectible` | `failed` (declineCode `uncollectible`) |
| `open`, attempted = true | `failed` (declineCode `open_invoice`) |
| `open`, attempted = false | `open` |
| **anything else** (`draft`, `future_provider_state`, …) | **not mapped** — anomaly + skip; sync continues; previously known-good records untouched; no payment row created |

`""` (missing/unknown from the adapter) remains skipped + anomalous. No mapping to `open`/`paid`/`failed`/`void`/`refunded` exists for unsupported values. **Not every Stripe invoice status is supported** — `draft` is intentionally NOT represented until the domain model gains an honest representation; the provider's own verbatim status is never stored under a REVESSENT label it does not have.

The same audit found and fixed the last same-pattern default in the read path: the customer-detail payment `outcome` collapsed everything that was not `paid`/`refunded` into `"failed"` — meaning synced `open` (never attempted) and `void` invoices displayed as *failed payments*. `PaymentRowSchema.outcome` is now the verbatim payment state (additive enum: `+ open`, `+ void`), the DTO maps it 1:1 (no default remains), and the timeline renders honest labels ("Invoice open — not yet attempted", "Invoice voided").

## C4. Repository-wide provider-state audit (§6 — field by field)

| Default found | Classification | Action |
|---|---|---|
| invoice `else → "open"` (sync persistence) | **Invalid invention** — draft/future → `open` | fixed: whitelist + anomaly + skip (C3) |
| payment DTO `else → "failed"` (open/void → failed) | **Invalid invention** — false failure display | fixed: verbatim outcome, additive enum |
| recovery case `interval ?? "month"` (missing subscription link or `unsupported` sub cadence → "month") | **Invalid invention** — invented cadence | fixed: `RecoveryCase.interval` + `"unsupported"` (additive); `amountLabel` renders no cadence suffix; detail view labels "cadence unsupported" |
| `CaseRow.interval` type `"month"\|"year"` | **Invalid (type lied)** | widened to include `"unsupported"` |
| adapter invoice `status ?? ""` / currency `?? ""` | **Valid** — verbatim passthrough; emptiness handled downstream by skip+anomaly | kept (from Addendum B) |
| subscription `status` persisted verbatim (no mapping, no default) | **Valid** — Stripe authority | kept |
| customer `status`: `past_due` iff provider sub `past_due`; `canceled` iff provider-deleted; otherwise domain default `active` | **Valid documented derivation** — customers have no Stripe-level status; the default means "no adverse provider signal", not a provider claim | kept + documented |
| connection DTO `readScopes ? "read_only" : "error"` | **Valid** — scopes are app-recorded at connect; missing read scopes genuinely cannot read | kept |
| `attempt_count ?? 0`, `amount_paid`/`amount_due` verbatim, `coalesce(s.mrr,0)` (Addendum B table) | **Valid** (see B4) | kept |

No other `?? "open" | "paid" | "active" | "month" | "usd" | "failed"` defaults exist in server/integration sources (grep-verified).

## C5. New regression tests (5 — no existing test weakened)

`stripe-financial.test.ts` → "invoice status truth (final provider-state audit)":
1. **Supported mapping matrix**: paid→paid, void→void, uncollectible→failed(+`uncollectible`), open+attempted→failed(+`open_invoice`), open→open — 0 anomalies, 5 stored.
2. **`draft`**: not stored as open/paid/failed; exactly 1 anomaly; the good invoice in the same page still synced (`upserted 1`); entity status `ok` (anomalies ≠ failure).
3. **Arbitrary future status** (`future_provider_state`, `scheduled`): 0 rows, 0 upserted, 2 anomalies — cannot become any known status.
4. **Missing status `""`**: skipped + anomalous (explicit; preserves Addendum B behavior).
5. **Provider-state resolution**: a `draft` invoice that Stripe later finalizes to `paid` syncs honestly on the next run (anomaly 1 → 0, row appears `paid`) — provider wins, never pre-created.

## C6. Full regression results

| Gate | Result |
|---|---|
| Backend tests | 🟢 108/108 (103 + 5 new; zero existing assertions changed) |
| Frontend tests | 🟢 42/42 |
| Typecheck | 🟢 9/9 |
| Lint | 🟢 turbo 7/7 (`--force`) |
| Production build | 🟢 exit 0 (changes included) |
| Fresh migration bootstrap | 🟢 empty DB → 0000–0011 → 30 tables |
| Concurrency / connection / sync / tenancy / boundary suites | 🟢 all green |
| Live HTTP (new build) | 🟢 2 concurrent syncs: one `200` honestly reporting `invalid_credentials` (real Stripe 401 — no fabricated success), one `409 "A sync is already in progress for this workspace."` (advisory lock intact) |
| Security recheck | 🟢 no key material client-side; no client imports of integrations/crypto; revoked keys destroyed + sync refuses; org isolation green; no later-phase functionality added |

## C7. Final gate for Phase 4A: 🟢 PASS

The exact supported invoice-status mapping is the five-row table in C3 — nothing else maps, everything else is an anomaly. Unsupported provider states (numeric or categorical) can no longer silently become REVESSENT financial states anywhere in the pipeline: adapter → whitelist mapping → verbatim-or-unknown domain → derived metrics. **Phase 4B not started — awaiting external review.**

---

# FINAL AUDIT ADDENDUM — Post-Review Correction Pass (2026-09-06)

**Gate for the correction pass: 🟢 PASS.** One confirmed correctness defect (non-atomic sync single-flight) was fixed with a database-enforced primitive, re-tested with real-concurrency regressions and live HTTP, and the credential lifecycle was audited and tightened. No later-phase functionality was added; Phase 4B remains not started.

## A1. Concurrency issue found

The original `triggerSync` enforced single-flight by querying `sync_state` for `status = "running"` rows and rejecting if any existed — **after** the connection check and **before** the run marked states running (that marking happened later, inside `syncEntity`). This was a classic check-then-act race: two concurrent requests could both observe "no running sync" and both proceed, violating "only one sync may run for an organization at a time."

## A2. Root cause

Mutual exclusion was attempted with an application-level read of mutable state that is written later and non-atomically. DB idempotency (unique upserts) prevents duplicate *rows* but not concurrent *executions*; an in-process mutex would not survive multiple Node processes/instances.

## A3. Fix (Option A/C — PostgreSQL session advisory lock)

- New primitive `withOrgSyncLock(db, orgId, fn)` in `packages/db/src/client.ts`: borrows a **dedicated pool client**, computes a deterministic per-org 64-bit key (`md5('revessent:sync-lock:' || org_id)` → `bit(64)` → `bigint`), and takes `pg_try_advisory_lock` **session**-scoped on that client.
- `triggerSync` now runs the entire sync inside this lock. A concurrent same-org request gets `{acquired: false}` **before any connection/provider access** and receives a safe `409 /errors/conflict` "A sync is already in progress for this workspace." — it never starts provider synchronization. Different orgs hash to different keys and never block each other.
- **Lifecycle**: explicit `pg_advisory_unlock` + client release in nested `finally` on every path (success, failure, provider throw, validation failure, unexpected exception); a crashed process cannot wedge an org because PostgreSQL releases session locks when the owning connection disappears. While the lock is held the dedicated client stays **idle outside any transaction** — page-by-page persistence still runs in short `withOrgTx` transactions and network calls remain outside DB transactions (no giant transaction was introduced).
- Honesty hardening: because the lock is exclusive, any pre-existing `running` `sync_state` row at acquisition is by definition an orphan from a crashed run; the next sync marks it `failed` with safe code `interrupted` (no stuck "running" display, no permanent lock).
- Scope note: the browser/mutex/boolean anti-patterns from the instruction are nowhere present; the guarantee lives entirely in PostgreSQL and survives multiple processes and server instances.

## A4. Concurrency test evidence (real, not mocked)

`packages/server/test/stripe-concurrency.test.ts` — 6 tests, all against the real Postgres primitive (real pool, real lock contention; fixture gateway with deliberate `listCustomers` delays to guarantee overlap):

1. **Same-org race**: two concurrent `triggerSync` calls (second fired 40 ms into a ≥450 ms run) → exactly 1 fulfilled, exactly 1 rejected `ProblemError` 409 "already in progress"; loser made **zero** provider calls (call counter: 3 pages total, not 6); exactly **one** `sync.started` audit; 5 customers with no duplicates; all three `sync_state` rows `ok`/finished; a subsequent sync succeeds (lock released).
2. **Failure releases the lock**: a rate-limited failing sync is immediately followed by a successful one — a failed run never wedges the org.
3. **Cross-org concurrency**: two orgs, shared delayed gateway, fired simultaneously → both fulfill; both orgs' rows isolated (per-org lock keys).
4. **Crash simulation**: orphaned `running` rows do not block the next sync; they are marked `failed/interrupted` and the run completes `ok`.
5. **Disconnect destroys the credential** (see A5).
6. **Provider-side revocation during sync** (see A5).

**Live HTTP evidence (real production build, real server, no fabricated provider success):** seeded an active connection whose sealed key material is valid for the live server, then fired **3 concurrent** `POST /api/v1/orgs/{slug}/settings/stripe/sync`:

```
req1 = 200  (the only one that ran — summary honestly reports all entities
             failed with errorCode "invalid_credentials" from the REAL Stripe 401;
             no success fabricated)
req2 = 409  {"type":"/errors/conflict",…,"detail":"A sync is already in progress for this workspace."}
req3 = 409  (same)
audit: exactly one sync.started + one sync.failed for the org
```

Follow-up live check: `DELETE` (disconnect) then sync → `409 "Connect Stripe before syncing."`; the connection row shows `status=revoked`, `key_ciphertext IS NULL` (material destroyed), `key_last4` retained.

## A5. Credential-lifecycle decision (secondary audit §8)

- **Found**: disconnect set `status="revoked"` while **retaining** the sealed key material — a revoked row still held a decryptable credential.
- **Phase 1/4A requirement check**: the task requires revocation to be real ("revoked ≠ connected", "revoked connection cannot be used"), audit events include `credential revoked`, and security posture forbids needless secret retention. Retention had no legitimate consumer (a revoked key must never authenticate again; reconnect re-enters a fresh key).
- **Decision: destroy on revocation** (superset of "prevent all future use"): `stripeDisconnect` and the new provider-revoked-during-sync path both set `key_ciphertext = NULL` alongside `status="revoked"`. Implemented safely with **forward migration `0011_revoke_destroys_credential`** (`alter column key_ciphertext drop not null`; verified deterministic from an empty DB — 30 tables, nullable column). `sync` additionally refuses any connection without key material (defense-in-depth).
- **Historical safe metadata preserved**: `key_last4`, `stripe_account_id`, `display_name`, `country`, `default_currency`, `last_validated_at` stay on the row, and the audit ledger records `connection.succeeded {mode, last4, account}`, `connection.disconnected {account, last4, keyMaterial: "destroyed"}` and `credential.revoked {account, source}` — codes/metadata only, never the key.
- **Proof (server-side tests)**: after disconnect — row `revoked`, `keyCiphertext NULL`, sync refuses 409, reconnection rotates in fresh material and syncs again. Provider revocation mid-sync (fixture `revoked` failure) — connection transitions to `revoked`, material destroyed, `credential.revoked` audited, subsequent sync refuses 409. Both also live-verified (A4).

## A6. Security verification (fresh pass, §10)

- **Secrets**: greps — no key literals in `apps/web/src`; no client imports of `@revessent/integrations`/`sealSecret`/`openSecret`/`KEY_ENCRYPTION_KEY`; no `console.*` in server/integrations sources (only pre-existing Phase 3 dev-mode auth notices that print email, never tokens); no `NEXT_PUBLIC_` secrets beyond the demo flag. Test assertions remain: DTO/audit/DB never contain key material; boundary tests (server-only entry, no web import) still green.
- **Tenancy**: all prior query-layer + RLS tests green; the lock is keyed per org so isolation is unchanged; cross-org sync contention impossible by construction.
- **Provider authority / failed syncs**: existing suites re-run green — provider updates overwrite provider-owned state, failures preserve known-good data, unknown refs skipped, honest freshness codes (incl. the new `interrupted`).
- **Sync safety**: concurrent same-org execution blocked (DB-enforced), different orgs independent, failed/crashed runs leave no permanent locks (A4.2/A4.4 + advisory-lock session semantics).

## A7. Full results

| Gate | Result |
|---|---|
| Backend tests | 🟢 88/88 (was 82; +6 concurrency/lifecycle; zero regressions) |
| Frontend tests | 🟢 42/42 (unchanged) |
| Total | 🟢 130/130 across 26 files |
| Typecheck | 🟢 9/9 (contracts, db, domain, ui, config, integrations, server, web ×1) |
| Lint | 🟢 turbo 7/7 (`--force`) |
| Production build | 🟢 exit 0 (webpack, demo-flag stash procedure) — includes the concurrency fix |
| Migrations | 🟢 0000–0011 applied on :5433 **and** on a fresh empty database (bootstrap deterministic; 30 tables; `key_ciphertext` nullable) |
| Live HTTP concurrency | 🟢 A4 — one accepted / two 409, exactly one run |
| Live Stripe success path | 🟡 BLOCKED (unchanged — no credentials available; boundary covered by fixtures; real 401 failure path verified) |

## A8. Final gate for Phase 4A: 🟢 PASS

Concurrency is now atomically enforced by PostgreSQL (per-org session advisory lock) with correct release-on-every-path semantics and crash safety; the credential lifecycle destroys sealed material on revocation with forward migration and preserved safe history; all prior Phase 4A behavior (Stripe authority, page-by-page persistence outside transactions, pagination/checkpoint/resume, bounded 200-page limit, idempotent upserts, deletion preservation, failure preservation, safe taxonomy, honest freshness, org isolation) re-verified green with zero regressions. The only documented external limitation remains the unavailable live Stripe success-path credentials (BLOCKED, not fabricated). **Phase 4B not started — awaiting external review.**
