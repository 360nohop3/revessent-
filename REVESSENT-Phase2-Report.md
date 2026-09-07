# REVESSENT — Phase 2 Report: Production Frontend Foundation

**Date:** 2026-09-05 · **Workspace:** `/home/user/revessent` (pnpm + Turborepo monorepo)
**Basis:** `REVESSENT-Architecture-v1.md` (§6 routes, §5 schema, §3 stack, §11 repo) + visual grammar extracted from `uploads/revessent (2).html`.
**Status: Phase 2 requirements are met, with the non-critical caveats disclosed in items 14–15.**

---

## §24.1 Pre-existence — what existed before Phase 2

- `uploads/revessent (2).html` — the approved visual/UX reference (single-file demo).
- `uploads/idea-brief.md` — historical brief.
- `REVESSENT-Architecture-v1.md` — Phase 1 governing spec (produced in Phase 1; not modified in Phase 2).
- **No frontend code existed**: no repository, no packages, no tooling, no build.

## §24.2 Changes — to pre-existing things

- Nothing in `uploads/` was modified (both files byte-identical; the demo remains the canonical visual reference).
- `REVESSENT-Architecture-v1.md` unchanged in this phase (Appendix B decisions B-1…B-6 still await sign-off; Phase 2 followed the spec as written).
- No new architecture document was produced (explicitly forbidden output type).

## §24.3 Created — new artifacts

- **Monorepo** `/home/user/revessent`: `package.json` (pinned devDeps), `pnpm-workspace.yaml`, `turbo.json`, `tsconfig.base.json` (TS 5.9 strict), `eslint.config.mjs`, `vitest.config.ts` (jsdom; `@revessent/*` → source aliases, `@` → `apps/web/src`), `vitest.setup.ts` (jest-dom, ResizeObserver/matchMedia stubs, cleanup), `.gitignore`.
- **`packages/ui`** — 23 source files + `styles/tokens.css`; barrel export.
- **`packages/domain`** — `approval.ts` (FSM + editability), `money.ts`, `status.ts`, `entitlements.ts` (PLANS), `freshness.ts` + **12 tests**.
- **`packages/contracts`** — `schemas.ts` (Zod DTOs; nullable metrics = never-synced ≠ zero), `api.ts` (ApiClient, ApiError RFC-9457, DraftAction, DemoProviderAction*), `client.ts`, `queryKeys.ts`, `mock/store.ts` (DemoStore + fixtures + `createOrg`), `mock/mockApi.ts` (latency + fault injection) + **10 tests**.
- **`packages/config`** — Zod-validated public env (DEMO_MODE default ON). **`packages/observability`** — logger + redaction.
- **`apps/web`** — **83 `.ts/.tsx` files**: all routes (§24.8), 27 views (20 general + 7 settings), shell components, `lib/` (session, permissions, api, format, queries, demo-helpers), `styles/fonts.css` (6 self-hosted woff2 in `public/fonts/`), `api/demo/session` route.
- **Reserved stubs, no logic** (Phase 3/5+): `apps/api`, `apps/worker`, `packages/db`, `packages/integrations`.
- **`apps/web/test/`** — `utils.tsx` (providers + hoisted next/navigation mocks) + 6 suites + `matchers.d.ts`.

## §24.4 Modified — during Phase 2 (self-caught fixes, for the record)

1. `packages/ui`: added `"use client"` to the six interactive components (Toast, ApprovalDialog, ErrorState, FreshnessBanner, Button, Input); Skeleton accepts div props; `InputProps` empty interface → type alias.
2. `packages/contracts`: workspace deps on config/observability; `PaymentRow` type export; `DemoProviderActionType` import corrected; `createOrg`/`session` signatures fixed; unused imports removed.
3. `packages/domain`: `edit` ApprovalEvent carries optional `subject`/`body`.
4. **Real bug found by lint:** `DraftMessageCard` always called `api.recovery.draft` — now routes by `kind` to `api.expansion.draft` for opportunities.
5. **Real honesty fix found during build:** pricing CTA helper text initially said "typical first recovery in week one" — an unsourced stat; replaced with "no card required · cancel anytime".
6. Six settings page files had unterminated import strings; `unsubscribe-token-view` unassigned `useQuery`; `format.ts` missing in-scope import; settings `ai` page passed an unaccepted prop.

## §24.5 Untouched

- `uploads/revessent (2).html`, `uploads/idea-brief.md`, `REVESSENT-Architecture-v1.md`.
- Phase 3+ boundaries: no Postgres, no real auth, no live Stripe sync, no Stripe payment writes, no production webhooks, no BullMQ, no real email, no production AI, no billing entitlement enforcement. Stub packages contain no behavior.

## §24.6 Preserved visuals (from the reference, materialized as tokens — not simulated logic)

- Radii **12/17/22/26px**; three themes (light, dark `#1c1a17/#161512`, AMOLED `#000`); glass/btn/pill/input/skeleton recipes; `.serif-em` editorial accent; brand gradient.
- Self-hosted fonts: Manrope (variable), IBM Plex Mono 400/500/600 (data face), Instrument Serif 400 + italic; tabular figures (`.num`) for all financial numerals.
- Extracted the **visual grammar only** — the demo's simulated business behaviors were **not** carried (item 24.7).
- Caveat: light-theme token values were transcribed but **not yet pixel-diffed** against the reference `:root` (see §24.14).

## §24.7 Removed demo behaviors (reference behaviors deliberately NOT in production UI)

Timer-based success; "Approved · retry set" implying payment; 94% confidence scores; "optimal retry hour"; "kept by REVESSENT" counterfactuals; fake first-week results; unsourced stats (including the one caught in §24.4.5); "every payment method", SSO, ten-brand and SLA claims. Provider outcomes are reachable **only** through controls explicitly labeled demo (§24.11).

## §24.8 Routes (all implemented, Next.js 16 App Router)

| Group | Routes | Notes |
|---|---|---|
| Public | `/`, `/product`, `/pricing`, `/privacy`, `/terms` | static |
| Auth | `/sign-in`, `/sign-up`, `/verify-email`, `/forgot-password`, `/reset-password` | demo-session start; local validation first |
| Onboarding | `/onboarding` | 2-step org wizard → `createOrg` |
| App | `/app` → first membership redirect; `/app/[orgSlug]/{overview,recovery,recovery/[caseId],expansion,expansion/[opportunityId],customers,customers/[customerId]}` | cookie guard = **navigation only, never authorization**; `orgSlug` navigation-only |
| Settings | `/app/[orgSlug]/settings/{account,team,stripe,recovery,messaging,ai,billing}` (+ index → account redirect) | 7 pill tabs |
| Subscriber | `/recover/[token]`, `/upgrade/[token]`, `/unsubscribe/[token]`, `/status?s=…` | `noindex, nofollow` |

Build verifies: 16 prerendered/dynamic route entries; `/app` 307-redirects to the first membership (smoke-tested).

## §24.9 Components (22 required — all present; plus extras)

Button, Input, FormField, Surface, Badge, **StatusBadge**, MetricCard, Skeleton (+SkeletonCard/SkeletonTable), EmptyState, ErrorState, DataTable (+Column), Timeline, EvidenceList, ApprovalDialog, Toast (ToastProvider/useToast), AccessibleChart, FreshnessBanner, ModeBadge, AppShell, Sidebar, MobileNav, OrganizationSwitcher.
Extras: DemoBar (demo controls, hidden when `NEXT_PUBLIC_DEMO_MODE==="false"`), NavIcon, brand, ThemeMenu, marketing header nav.
**Disclosure:** the required "Header" is composed **inside AppShell** (hamburger, OrgSwitcher, ModeBadge, timezone, ThemeMenu, sign-out) rather than exported as a standalone `Header` component.

## §24.10 UI states (10 per important screen; overview/recovery/expansion/customers + details all implement them)

1. **Loading** — skeletons everywhere data is fetched (`role="status"`, aria-labeled).
2. **Complete** — data + demo-fixture labeling.
3. **Empty** — distinct empty states (e.g., no cases at all).
4. **Partial** — backfill "running" renders metrics with an explicit "syncing with Stripe — incomplete, not empty" banner (**syncing ≠ empty**).
5. **Stale** — FreshnessBanner: ≤15m fresh / ≤24h aging / else stale / null → "never".
6. **Permission-denied** — viewer role: role explanation, no action buttons (tested).
7. **Offline** — demo offline toggle → alert + "Try again" (tested).
8. **Provider-disconnected** — Stripe-less org → EmptyState → settings/stripe; no cash metrics shown (tested).
9. **Success-confirm** — toasts, every one honest ("(demo) … no email was sent", "nothing was sent").
10. **Error-confirm** — ErrorState with problem detail + retry (tested); filtered-empty is distinct ("no cases match this filter" + "Clear filters", tested).
Also: **provider-pending ≠ failed ≠ success** everywhere; "Pending is not success" on `/status`.

**Approval UX:** all nine statuses distinct (draft → awaiting_approval → approved → queued → executing → provider_pending → confirmed / failed / cancelled, plus invalidated); editing an approved draft **invalidates the approval** and the UI says so verbatim ("previous approval was invalidated") — covered by the approval-flow test.

**Financial truth:** cash recovered (30d) vs exposure (open failed payments) vs potential MRR ("not collected cash") are labeled separately; recovery rate renders "unknown" when null; no animate-from-zero anywhere.

## §24.11 Mocked (allowed, clearly marked, dev/test-only)

- **All data**: DemoStore fixtures — 2 orgs (connected owner "Acorn Books", disconnected viewer "Fernbrook Studio"), cases, opportunities, customers, subscriptions, payments, timeline, activity, subscriber tokens (`tok_demo_valid|expired|used`, `tok_demo_upgrade`).
- **Behavior**: 200–420ms latency; fault injection (`setFailNext`); offline mode; demo provider simulation (approved → executing → provider_pending → confirmed|failed) reachable only via controls visibly labeled demo; `createOrg`; demo session cookie (`rv_demo_session`, httpOnly/lax/8h) + `POST/DELETE /api/demo/session`. Stripe key input validates **format only** (never stored/sent); save actions toast "(demo)".
- Guardrails kept: no business records or auth state in localStorage; no secrets or `NEXT_PUBLIC_*` secrets; no floating versions; mocks restricted to the mock client selected by DEMO_MODE in `packages/config`.

## §24.12 Deferred to Phase 3+ (by design)

Postgres/db layer; real auth (password verification, email delivery); live Stripe read sync + payment writes; production webhooks; BullMQ/worker execution; real email sending; production AI drafting; billing entitlement enforcement; Stripe-hosted SAQ-A checkout (rendered as an explicit placeholder panel today); real pilot signup; SSO.

## §24.13 Test & gate results (all green, run 2026-09-05)

| Gate | Result |
|---|---|
| vitest | **36/36 passing** (10 files) — domain 12, contracts 10, web 14 |
| turbo lint | **16/16 tasks** (0 errors, 0 warnings) |
| turbo typecheck | **16/16 tasks** (TS 5.9 strict) |
| turbo build | **✓** — Next 16.3.4 production build, all routes |

Web suites map to the brief: route render + auth validation (sign-in: local-first validation, fetch only when valid, redirect), org switching (navigation **and** cache-slice removal), loading/empty/error/offline/permission/disconnected/syncing/filtered-empty states, approval invalidation, responsive nav (accessible mobile dialog), a11y (roles/labels: `role="status"`, `role="alert"`, `aria-current`, dialog navigation), pricing honesty (no fake submit, no email).

## §24.14 Limitations

1. **Bundler:** dev/build use **webpack** (`next dev --webpack` / `next build --webpack`). Turbopack (Next 16 default) exceeds this sandbox's 2GB memory both building and in dev; on conventional hardware the default works. Stack baseline (Node 24 LTS, TS 5.9 strict, pnpm, Turborepo, Next 16 App Router, React 19, Tailwind 4, Radix, TanStack Query, Zod — exact pins) is otherwise intact.
2. **Visual fidelity:** tokens were extracted from the reference and radii/themes/recipes/fonts preserved, but no automated pixel-diff audit was run; light-theme values are the main unverified surface.
3. **Test depth:** jsdom/RTL only — no Playwright browser e2e, no axe automated a11y scan (a11y is covered via semantic roles/labels/keyboard support in components and asserted roles in tests).
4. **Dev-server memory:** Next dev allocates heavily per route in this sandbox; the production server (`next start`) is what serves the live preview.
5. **Demo session:** the cookie is a plain demo construct (base64 JSON, no auth) — intentionally navigation-only.
6. `apps/web` currently ships only the mock client; the `api` handle is typed `MockApi` until Phase 3 supplies the real client.

## §24.15 Unmet criteria

**None critical.** Every acceptance item in the Phase 2 brief is implemented and verified: exact route set, ≥22 components, 10 UI states, 9-state approval UX with invalidation, financial-truth labeling, pinned stack, passing gates, honest demo boundaries. Disclosed shortfalls, all non-critical: (a) no pixel-level visual audit against the reference (item 24.14.2); (b) no automated a11y/e2e scan — a11y coverage is structural + test-asserted (item 24.14.3); (c) "approval expired" has no UI pattern because the Phase 2 contract carries no approval-expiry field — expiry is backend-enforced and arrives with the Phase 3 contracts (the *invalidated* pattern, which is the client-side half, is fully rendered); (d) Playwright coverage omitted as infeasible in this sandbox (item 24.14.3).

## §24.16 Post-brief audit addendum (2026-09-05, same day)

The full brief was re-audited section-by-section against the finished implementation. Two real gaps were found and fixed, then all gates re-run:

1. **§8 logout cache hygiene (fixed):** `signOut` deleted the demo cookie but did not clear TanStack Query memory. It now calls `queryClient.clear()` before redirect (`app-shell.tsx`). Org-change invalidation (OrgSwitcher) and theme-only localStorage were already correct.
2. **§16 safe-area handling (fixed):** `viewportFit: "cover"` was set but no layout consumed the insets. The fixed DemoBar now pads `env(safe-area-inset-bottom)`, and the MobileNav drawer pads `safe-area-inset-left/top` (`demo-bar.tsx`, `mobile-nav.tsx`).

Verified already-compliant during the audit: `prefers-reduced-motion` and `forced-colors` blocks present in `tokens.css`; localStorage carries the theme key only; `NEXT_PUBLIC_` exposes only the `DEMO_MODE` flag (no secrets); `viewportFit: cover` present.

Post-fix gates: lint 16/16 · typecheck 16/16 · tests 36/36 · build ✓ — production preview restarted on the fresh build.

---

**Live preview:** production server (`next start`) on port 3000 — marketing site, sign-in (demo session), Acorn Books (connected, owner) and Fernbrook (disconnected, viewer) workspaces, all 7 settings tabs, and subscriber token screens (`/recover/tok_demo_valid`, `tok_demo_expired`, `/upgrade/tok_demo_upgrade`, `/unsubscribe/tok_demo_valid`, `/status?s=pending`).
