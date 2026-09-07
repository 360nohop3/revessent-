# REVESSENT — Phase 6 Report
## AI-Assisted Recovery Communication & Email

**Date:** 2026-09-06 (rev. 2 — suppression safety fix) · **Branch:** `arena/01a077b8-revessent` · **Commit:** `dac0650`
(The sandbox was reset between rev. 1 and rev. 2; the earlier local commits `a5c9a56/c7ec225/6f9e9ee` were lost and all Phase 6 work — original + fix — was re-committed as `dac0650` on top of `5abb18d`. Files were preserved throughout.)
**Verdict:** 🟢 Phase 6 implemented and verified against executed gates (details in §17), including the communication-suppression invariant added in rev. 2 (§9a). Not production-ready (§21).

> **Correction to rev. 1.** Rev. 1 did not implement customer opt-out/suppression; the public unsubscribe route was a no-op returning `state: "unknown"` and the send path did not consult any suppression state. Any wording in rev. 1 implying otherwise was wrong. Rev. 2 adds the durable model and enforces it (§9a).

Every gate reported below was **actually executed** in this session. Nothing was taken from prior reports.

---

## 0. Pre-Phase-6 independent verification of Phases 1–5 (code, not reports)

| Area | Method | Verdict |
|---|---|---|
| Full suite baseline | `pnpm exec vitest run` on `a5c9a56` | 🟢 380/381 (42 files). 1 pre-existing flaky test (`retry-identity` "concurrent final-attempt race") under full-suite load; passes in isolation. Not touched by Phase 6. |
| Migrations 0000–0020 on fresh PG16 | Applied via drizzle-kit to local 5433 | 🟢 |
| Phase 4D invariants (auto `attempt_no` counted among automated only; manual = NULL; fail-closed routing; absent rule not retryable; `no_provider_operation` → decline category) | Read `packages/domain/src/retry.ts`, `packages/server/src/retry.ts`, `execute.ts` | 🟢 unchanged; Phase 6 reads them only (`executedAutoRetries` uses kind=`auto_retry` + executed statuses). |
| Phase 5 worker (single queue `retries`, `retry.execute`, durable `job_runs`, lease 300 s, Redis-loss reconciliation) | Read `apps/worker/src/*`; `job_runs` schema 0020 | 🟢 reused as-is; **no changes** to `queues/retries.ts`, `workers/retryWorker.ts`, `durable/jobs.ts`. |
| RLS + grants on `recovery_messages`, `ai_generations`, `voice_profiles` | `pg_class.relrowsecurity`, `role_table_grants` | 🟢 already present from 0001/0003/0005 — 0021 needed no new policies. |

Fixes to prior-phase code in this phase: **none functional**. Two small additive touches (see §16/§20): `recovery.ts` edit-path now validates edited copy; `config` treats empty-string secrets as unset.

---

## 1. Objective

Turn a Phase 4D decision ("retries exhausted / case lost") into **one** safe, auditable, org-scoped customer email, where:
- rules decide *whether / when / to whom*; AI decides only *how it's worded*, and can be replaced by a deterministic template at any moment;
- the Postgres row is the single source of truth for the communication lifecycle (no duplicate logical sends, ever);
- delivery rides the Phase 5 worker (new queue, same durable primitives, no new framework).

## 2. Architecture (flow as built)

```
Phase 4D outcome (attempt failed / case lost)  ──(no coupling; discovery only)──▶
scheduler.cycleOrg (Phase 5)  → communicationService.findCommunicationCandidates(org)
   → enqueueCommunicationPrepare  (job_runs row FIRST, dedupe comm-prepare:{org}:{case}:{trigger}, then Redis)
notesWorker: communication.prepare
   → prepareCommunication(ctx, caseId, trigger)
       loadAuthoritative (case+payment+customer+attempts+messages, RLS-scoped)
       resolveCommunicationPolicy (retry_policies.rules + trust_level)
       evaluateCommunication (pure, @revessent/domain)  ── not allowed ⇒ audit + stop
       generateCopy (@revessent/ai)  ── AI if permitted → schema → red lines → else fallback template
       INSERT recovery_messages (dedupe_key = comm:{org}:{case}:{purpose}; ON CONFLICT DO NOTHING)
scheduler.cycleOrg → findDueSends(org)  (approved + pending + send_after ≤ now)
   → enqueueCommunicationSend (dedupe comm-send:{org}:{message})
notesWorker: communication.send
   → deliverCommunication(ctx, messageId)
       atomic claim pending→sending · re-verify facts · validate copy · app renders (facts + CTA url)
       emailProvider.send(...)  ⇒ sent | failed_transient (backoff) | failed_permanent | unknown (never resent)
```

New code lives in: `packages/domain/src/communication.ts`, `packages/ai/*` (new package), `packages/integrations/src/email*.ts`, `packages/server/src/services/communication.ts`, `apps/worker/src/queues/notes.ts`, `apps/worker/src/workers/notesWorker.ts`, migration `0021_communications.sql`.

## 3. Communication policy (deterministic, fail-closed)

`evaluateCommunication(trigger, facts, policy)` in `@revessent/domain` — pure function, fully unit-tested (18 tests). Order of checks (first refusal wins):

1. `sends_paused` kill switch (read from the **latest** policy version — immediate)
2. `execution_unresolved` (any attempt `executing|unknown`) — never talk while money is in flight
3. payment status ≠ `failed` ⇒ `payment_{status}` (never dun a paid/void payment)
4. case status ∉ {retrying, contacting, lost} ⇒ `case_{status}`
5. decline category `hard` (lost/stolen/fraud) ⇒ `decline_not_outreach_safe`
6. no customer / deleted / implausible email ⇒ `customer_deleted` / `no_recipient`
7. trigger→purpose: `retry_failed` → `dunning_note` (requires `executedAutoRetries ≥ noteAfterFailedRetries`, `0` = notes disabled; case must not be `lost`), `case_lost` → `final_notice` (case must be `lost`)
8. dedupe: purpose already exists for the case ⇒ `already_communicated`
9. timing: `sendAfter = max(now, lastSentAt + cooldownHours)` then shifted out of quiet hours (org timezone)
10. channel = `email` (only channel); `aiPermitted = policy.aiEnabled`; `requiresHumanApproval = trustLevel < 1`

Policy source: `retry_policies.rules` (`noteAfterFailedRetries`, `quietHoursStart/End`, `communication.{sendsPaused,cooldownHours,aiEnabled}`) with defaults `{1, 21, 8, false, 72h, true}`; `organizations.trust_level` (default 0 ⇒ human approval). No new settings UI was added (scope).

## 4. AI boundary

- Package `@revessent/ai` is `server-only`. Interface `AiProvider.complete({system,user,maxTokens,timeoutMs,requestId}) → {text, model, tokensIn/Out, latencyMs}`. Adapters: `anthropicProvider` (fetch, key held in closure), `fakeAiProvider` (tests).
- The model receives **no** amount, currency, email, id, URL or name. Inputs: purpose brief, amount *band* (small/medium/large), decline category, relationship months, voice profile (style/greeting/signoff, sanitized), `customer_first_name_available: boolean`.
- The model can only emit `{subject, paragraphs[], cta_label, tone_check}`; it **cannot** express recipient, sender, reply-to, org, amount, link, payment action or decision — there is no field for any of them and `.strict()` rejects extras.
- Financial values are interpolated by the app at send time from the authoritative row (`{{amount}}`, `{{org_name}}`, `{{first_name}}`, `{{cta_link}}`); unknown placeholders are a validation failure.
- Usage/attribution: `ai_generations` row per provider call (provider, model, prompt version `dunning-v1`, sanitized-input hash, tokens, latency, `valid`, validated output or `{rejected, reason, violations}` — never raw text).

## 5. AI output schema

`AiCopySchema` (`zod`, `.strict()`): `subject` 4–90 chars single-line no control chars; `paragraphs` 1–4 × ≤ 420 chars; `cta_label` 2–40 single-line; `tone_check.formality ∈ {casual,neutral,formal}`, `empathy ∈ {low,medium,high}`. Parsing tolerates ```json fences; one repair round-trip on invalid JSON, then fallback.

Content red lines (`validateCopy`): `contains_url`, `contains_email`, `contains_phone`, `contains_money_figure`, `contains_card_like_number`, `mentions_revessent`, `legal_threat`, `promises_outcome`, `requests_card_details`, `html_markup`, `instruction_leak`, `unknown_placeholder`, `header_injection`, `missing_cta`. The shipped fallback templates are tested against the same rules.

## 6. Prompt-injection defense

- Untrusted strings (voice profile, customer name) are placed under a `data` key of a JSON user message; the system prompt states data is never an instruction. Names never reach the model at all.
- `sanitizeUntrusted`: strips control chars, PAN-shaped digit runs, `sk_|rk_|pk_|whsec_` secrets, caps length (600).
- Defense does not rely on the model obeying: whatever it emits is schema-bound, red-line-validated and cannot reference a recipient/link/amount. Tests simulate a model that "obeyed" an injection (asks for card details, adds an attacker email) → fallback template, violations recorded, nothing sent.
- Operator edits (existing draft UI) are held to the **same** red lines at edit time (400 problem) and again at send time (suppressed `content_violation:*`), including when the DB row is edited out-of-band.

## 7. Deterministic fallback

`generateCopy` always returns usable copy. Fallback reasons recorded on the row (`fallback_reason`) and audit: `ai_disabled`, `ai_no_provider`, `ai_timeout`, `ai_unavailable`, `ai_rate_limited`, `ai_rejected`, `ai_malformed_response`, `ai_invalid_output`, `ai_prohibited_content`. Templates: `dunning_note`, `final_notice` (plain, one CTA). Timeout `AI_TIMEOUT_MS` (12 s default; test 50 ms verified).

## 8. Email provider abstraction

`EmailProvider.send(OutboundEmail) → {providerMessageId, provider, replayed}`; failures are `EmailProviderError{kind: transient|permanent|ambiguous, code}`. `assertSafeOutboundEmail` runs before **any** adapter: to/from/reply-to must be bare single-line addresses; subject single-line ≤ 200; no CR/LF/control chars.
- `postmarkProvider` (fetch): 2xx+MessageID ⇒ sent; 429 ⇒ transient; **401/403 ⇒ `configuration`** (rev. 2: our credentials are wrong — nothing sent, no retry budget consumed, message stays `pending` with a 1 h cooldown and an operator must fix config; previously misclassified as transient); 5xx/timeout/2xx-without-id ⇒ **ambiguous** (unchanged); 422 ⇒ permanent (300 invalid_recipient, 406 suppressed, else content_rejected). Body never copied into errors; `TrackOpens=false`, `TrackLinks=None`; `Metadata.reference = messageId`.
- `fakeEmailProvider` (`@revessent/integrations/email-fixtures`): behaviors `ok | transient | permanent | ambiguous_accepted | ambiguous_lost | hang`, idempotent replay by reference, `findByReference` for reconciliation.
- Sender is `EMAIL_FROM_ADDRESS` (env); `replyTo` always `null` in Phase 6; recipient is always `customers.email` re-read at send time.

## 9. Durable communication state (Postgres)

Migration `0021_communications.sql` extends `recovery_messages` (no new tables): `purpose, lifecycle_trigger, trigger_ref, dedupe_key, recipient_email, send_status(pending|sending|sent|failed|suppressed|unknown), send_after, send_attempts, send_claimed_at, last_send_error_code, suppressed_reason, generation_source(ai|fallback), fallback_reason, fact_snapshot jsonb, auto_approved, updated_at`; **partial unique index** `recovery_messages_dedupe_uq (dedupe_key) where dedupe_key is not null`; index `(org_id, send_status, send_after)`.
Body is stored **unrendered** (placeholders intact) so the existing Phase 3 draft UI/approval flow keeps working; `fact_snapshot` pins amount/currency/org/first-name at prepare time and is re-verified at send.

## 9a. Communication suppression (customer opt-out) — rev. 2

**Invariant:** a customer with an authoritative suppression state never receives a recovery email. The decision comes only from Postgres — never from AI, provider behaviour, frontend state, BullMQ state, a transient request or a cache.

**Model** — migration `0022_communication_suppressions.sql`: table `communication_suppressions (id, org_id, customer_id, channel='email', reason, source, source_ref, created_at)`, unique `(org_id, customer_id, channel)`, RLS `org_isolation`, app-role grants **SELECT, INSERT only** (append-only: application code cannot reverse an opt-out; verified — `DELETE` ⇒ `42501`). No PII beyond the customer id; `reason ∈ {customer_unsubscribed, operator}`, `source ∈ {unsubscribe_token, operator, system}`, `source_ref` = the recovery case the link belonged to. Existing tables were inspected first (`customers.status/deleted_at` are Stripe-owned facts, `recovery_messages` is per-message) — no existing field represented a per-customer opt-out, so the smallest new table was added.

**Unsubscribe persistence** — `POST /api/v1/unsubscribe/{token}` → `suppressionService.unsubscribeByToken`. The token is the existing unguessable 128-bit `/c/{token}` recovery token (SHA-256 stored, 14-day expiry). Resolution reuses the 0003/0005 token-flow RLS path (hash GUC → matched checkout → its case → its customer); the write then happens under the resolved org scope. Disabled (rotated) or expired tokens ⇒ `unknown`, nothing written. The browser never supplies a customer or org id. Idempotent (`ON CONFLICT DO NOTHING`; one audit `communication.customer_suppressed` per customer, not per click). The unsubscribe page no longer fires the request on page load — only on explicit confirmation (link scanners must not unsubscribe people) — and its copy no longer claims "demo only".

**Enforcement**
- *Prepare (precheck):* `prepareCommunication` refuses with `not_allowed / customer_unsubscribed` before policy/AI; no `recovery_messages` row, no AI call (tested: fake provider `calls.length === 0`). Discovery queries also exclude suppressed customers. This is an optimisation, not the enforcement point.
- *Send (mandatory):* `deliverCommunication` re-reads `communication_suppressions` **after** the atomic `pending → sending` claim and **before** any provider call. If suppressed: `sending → suppressed`, `approval_status=suppressed`, `suppressed_reason=customer_unsubscribed`, audit `communication.suppressed {reason}` (no PII), result `suppressed`; the worker completes the job with outcome `suppressed` — **no throw, so no BullMQ retry**; further deliveries return `claimed_elsewhere`; the row is never rediscovered as due and never resurrected. Holds when the unsubscribe happens after preparation, after approval, or after the send job is enqueued.

**Concurrency** — 6 rounds × 4 concurrent deliveries racing an unsubscribe with staggered timing: at most one claimant decides; provider calls == real sends; whenever the suppression row predates the claim the message is `suppressed`; `sentAfterSuppression == 0` in every run. (A send that already left before the opt-out landed is, by definition, not a violation; the next communication for that customer is blocked.)

**Not in scope (unchanged):** Postmark bounce/complaint webhooks feeding suppression, marketing-style preference centres, operator UI for suppressions.

## 10. Idempotency

| Layer | Identity | Arbiter |
|---|---|---|
| Prepare job | `comm-prepare:{org}:{case}:{trigger}` | `job_runs` partial unique (live rows) — Phase 5 primitive |
| Communication | `comm:{org}:{case}:{purpose}` | `recovery_messages_dedupe_uq` + `ON CONFLICT DO NOTHING` |
| Send job | `comm-send:{org}:{message}` | `job_runs` partial unique |
| Provider call | conditional `UPDATE … WHERE send_status='pending' AND approval_status='approved'` | exactly one claimant; provider `idempotencyReference = messageId` |

Verified: 3 concurrent prepares ⇒ 1 row; 6 concurrent deliveries ⇒ 1 provider call; redelivered/duplicate jobs ⇒ `exists` / `already_sent` / `claimed_elsewhere`.

BullMQ detail: custom job ids may not contain `:` (except a legacy 3-segment shape that Phase 5's key happens to satisfy) — the notes queue maps the durable key to a Redis id via `notesRedisJobId` (`:` → `__`); the DB key remains the identity.

## 11. Worker integration (Phase 5 reuse)

- New BullMQ queue `notes` (architecture §10.1), job types `communication.prepare` / `communication.send`, concurrency `WORKER_NOTES_CONCURRENCY` (default 5). Same `createLiveJob / claimJob / completeJob / cancelJob / recordInfraFailure` primitives, same lease/backoff/dead-letter policy.
- `cycleOrg` gained an **optional** `notesQueue`; when present it (a) reconciles notes rows with Redis, (b) enqueues prepare for candidates, (c) enqueues send for due messages. Phase 5 tests unchanged and green.
- Bootstrap wires queue+worker, error handlers, graceful shutdown order (scheduler → retry worker → notes worker → queues → Redis → health). Startup log reports AI/email as "configured (redacted)"/"off".
- The worker decides nothing: business refusals complete the job with the verdict as `outcome`; only transient email failures throw (BullMQ backoff).

## 12. Retry / reconciliation semantics

| Email outcome | Message row | Job | Next |
|---|---|---|---|
| sent | `sent`, `provider_message_id`, case → `contacting` (dunning) | succeeded `sent` | — |
| transient (`rate_limited`, `transient_network`) | back to `pending`, `send_after = now + min(6h, 5min·2^(n−1))`, `send_attempts++` | infra failure recorded, BullMQ retries | ≥ `EMAIL_MAX_SEND_ATTEMPTS` (4) ⇒ `failed` |
| configuration (`not_configured`, `auth_failure` 401/403) — rev. 2 | stays `pending`, claim released, `send_after = now + 1h`, **`send_attempts` untouched** | succeeded `deferred_configuration` (no BullMQ retry) | discovery re-enqueues after the cooldown; operator fixes credentials |
| customer suppressed (rev. 2) | `suppressed` / `customer_unsubscribed` | succeeded `suppressed` | never resent |
| permanent | `failed` | succeeded `failed_permanent` | never retried |
| ambiguous / unexpected error | `unknown` | succeeded `unknown` | **never auto-resent**; `reconcileUnknownSends(ctx, lookup)` resolves to `sent` only by provider reference; otherwise stays `unknown` for an operator |
| send-time facts changed (paid, amount, recipient, kill switch, case terminal, content violation) | `suppressed` + reason | succeeded `suppressed` | a new communication would need a new prepare |

## 13. Tenant isolation

All tenant reads/writes go through `withOrgTx` on the app role (RLS `org_isolation`); the worker uses `systemOrgContext` only to load the org row. Verified by tests: other org gets `no_such_case` / `no_such_message`, cannot discover or read the messages, forged-org insert rejected by RLS, forged job payload ⇒ `no_durable_job`, other org's scheduler cycle enqueues nothing.

## 14. Security

- AI never controls recipient/sender/reply-to/org/amount/CTA destination/payment action (§4, tested).
- Header injection blocked at the provider boundary and at the schema; HTML escaped in rendering; only the app-owned CTA is a link.
- CTA = `APP_PUBLIC_URL + /c/{token}` from `createCheckoutLink` (existing Phase 3/4 checkout, 128-bit token, rotates previous link); https enforced in production.
- Secrets: keys live in adapter closures; startup logs say "redacted"; error messages/tests assert token and recipient never appear; `ai_generations.output` is validated JSON or a rejection stub — never raw provider text.
- Audit: `communication.not_allowed | prepared | suppressed | sent | send_deferred | send_failed | send_unknown | reconciled | customer_suppressed` with safe codes only (no e-mail addresses; verified in tests).

## 15. Retention

`redactOldMessageBodies(db, orgId, days)`: for terminal messages older than `days` (by `sent_at`/`updated_at`), replaces body with `[redacted: retention]`, nulls `fact_snapshot` (contains first name) and `recipient_email`, keeps status/provider id/audit. Tested. Scheduling of this job is **not** wired (see §18).

## 16. Migrations

- New: `0021_communications.sql` (journal idx 21) and, rev. 2, `0022_communication_suppressions.sql` (journal idx 22). Historical migrations untouched.
- Executed (rev. 2): fresh bootstrap incl. 0022 assertions (table, RLS, `SELECT,INSERT`-only grants, unique index) 🟢; upgrades **0020 → 0022** and **0021 → 0022** with a legacy `recovery_messages` row preserved 🟢; as the app role: duplicate suppression ⇒ `23505`, `DELETE` ⇒ `42501`, cross-org insert ⇒ `42501` 🟢.
- Executed: fresh bootstrap (`migrations.test.ts`, now also asserts 0021 columns, unique index, grants, RLS-scoped read) 🟢; **upgrade paths** 4C-final (0017) → 0021, 4D-final (0019) → 0021, Phase 5 (0020) → 0021 with a pre-existing `recovery_messages` row: data preserved, defaults applied (`send_status='pending'`, `send_attempts=0`), unique index present, RLS on, app-role grants `SELECT,INSERT,UPDATE,DELETE` 🟢.

## 17. Test & gate results (all executed this session)

| Gate | Command | Result |
|---|---|---|
| Full suite (rev. 2) | `pnpm exec vitest run` | 🟢 **48 files, 467/467 passed** (rev. 1: 47 / 459; baseline 42 / 381) |
| Phase 6 — suppression: unsubscribe persistence/idempotency/invalid+expired+rotated tokens, tenant isolation (cross-org token, forged insert, no delete), prepare (no row, no AI), send after prepare/approve (zero provider calls, audit, not resent), bypassed-precheck, concurrency race | `packages/server/test/suppression.test.ts` | 🟢 7 |
| Phase 6 — worker cannot send to a suppressed customer (job `suppressed`, no throw/retry, redelivery + new job + scheduler all no-op) | `apps/worker/test/notes-queue.test.ts` | 🟢 11 (was 10) |
| Phase 6 — policy | `packages/domain/test/communication.test.ts` | 🟢 18 |
| Phase 6 — AI schema / red lines / injection / fallback / render | `packages/ai/test/ai-boundary.test.ts` | 🟢 25 |
| Phase 6 — email guards / fixtures / Postmark classification (incl. 401/403 ⇒ configuration) | `packages/integrations/test/email.test.ts` | 🟢 9 |
| Phase 6 — durable state, dedupe, concurrency, failure classes (incl. `deferred_configuration`), reconciliation, retention, tenant isolation | `packages/server/test/communication.test.ts` | 🟢 17 |
| Phase 6 — worker: identity, duplicate jobs, forged payloads, crash/stale lease, transient backoff, ambiguous, Redis loss/outage, scheduler discovery, tenant isolation | `apps/worker/test/notes-queue.test.ts` | 🟢 10 |
| Migrations (fresh + 0021 assertions) | `packages/db/test/migrations.test.ts` | 🟢 |
| TypeScript | `pnpm typecheck` (turbo, 9 packages) | 🟢 |
| ESLint | `pnpm lint` (turbo, 9 packages) | 🟢 0 errors, 0 warnings |
| Production build | `NEXT_PUBLIC_DEMO_MODE=off pnpm build` | 🟢 (with the sandbox's git-ignored `.env.local` `NEXT_PUBLIC_DEMO_MODE=on`, the build **correctly refuses** demo mode in production — pre-existing brief §23 guard, not a Phase 6 regression) |
| Upgrade migrations 0017/0019/0020 → 0021 | node/pg script (§16) | 🟢 |

## 18. Known limitations

1. No settings UI/API for `communication.*` rules or `trust_level`; both are set via existing policy JSON / privileged DB (tests do the latter).
2. `reconcileUnknownSends` and `redactOldMessageBodies` are library functions; no scheduled job invokes them yet (needs a lookup adapter for Postmark message search).
3. Only two purposes (`dunning_note`, `final_notice`); no multi-step cadences; `checkoutAfterNote` from Phase 4 policy is not consulted (the note always includes the checkout CTA).
4. Quiet-hours use the org timezone at prepare time; the row's `send_after` is not recomputed if the org timezone changes later.
5. `ai_usage_budgets` table exists but is not enforced (no per-org token budget yet).
6. Bounce/complaint webhooks (Postmark → suppression) are not implemented; permanent 422 codes cover the synchronous case only. Customer-initiated opt-out **is** implemented (§9a); provider-initiated suppression is not.
8. The unsubscribe link is the recovery link's token: it stops working when the operator rotates the checkout link or after 14 days. A suppressed customer whose link has expired can still be suppressed by an operator/system call to `suppressCustomer` (no UI yet).
7. `prepareCommunication` runs the AI call inside the worker job but outside the DB transaction; a crash between AI success and insert costs one extra AI call on redelivery (no duplicate email).

## 19. Live-provider status

- **Anthropic:** adapter written; **no live call performed** (no key in sandbox). All AI tests use `fakeAiProvider`.
- **Postmark:** adapter written; **no live call performed**; classification verified with a stubbed `fetch`. **No real customer email was sent.**
- **Stripe:** untouched; fixtures only, as in Phase 5.

## 20. Scope audit (Phase 7/8 creep)

- No entitlements, prod hardening, Terraform, Stripe OAuth, frontend redesign, analytics. No new frontend routes.
- Not touched: `execute.ts`, `server/retry.ts`, `domain/retry.ts`, `queues/retries.ts`, `retryWorker.ts`, `durable/jobs.ts`, any migration ≤ 0020.
- Rev. 2 touches: `services/suppression.ts` (new), `services/communication.ts` (prepare precheck, mandatory post-claim check, discovery exclusion, `deferred_configuration`), `apps/web/.../unsubscribe/[token]/route.ts` (real), `unsubscribe-token-view.tsx` (confirm-only, honest copy), `integrations/email*.ts` (`configuration` failure kind), `notesWorker.ts` (outcome type/doc), schema + 0022 + tests. Nothing in Phase 4C/4D/5 execution code changed.
- Additive touches to earlier files (all small, auditable): `scheduler.ts` (+optional notes discovery), `recovery.ts` (+Redis-loss for notes), `bootstrap.ts`/`shutdown.ts`/`config.ts` (+notes worker), `services/recovery.ts` (edit-path copy validation), `config` (`WORKER_NOTES_CONCURRENCY`, `communicationEnv()`, empty-string secrets = unset), `integrations/index.ts` (email provider injection), `next.config.ts` (transpile `@revessent/ai`), `vitest.config.ts` (aliases/includes), `migrations.test.ts` (+0021 assertions).
- Future-phase dependencies identified: settings UI for communication policy/trust level; Postmark bounce webhooks; AI budget enforcement; scheduled reconciliation/retention jobs.

## 21. Final verdict

🟢 **Phase 6 complete against executed gates (rev. 2, incl. the durable suppression invariant).** The system can now produce, approve, and deliver one policy-gated, schema-bound, app-rendered recovery email per case/purpose with durable state, deterministic identity, safe failure semantics and tenant isolation — without any live AI/email traffic having occurred.

**Not production-ready**: live provider adapters are unexercised, bounce handling/budgets/UI are missing (§18), and Phase 7/8 hardening has not begun. **STOP — no Phase 7/8 work was started.**
