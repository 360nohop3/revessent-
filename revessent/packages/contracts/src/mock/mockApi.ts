import { createLogger } from "@revessent/observability";
import { resolveEntitlements, type ApprovalStatus } from "@revessent/domain";
import type {
  ApiClient, ApiError, CaseFilters, CustomerFilters, DemoProviderActionInput, DraftAction, Paged
} from "../api";
import type {
  BillingInfo, Customer, Entitlements, Opportunity, Org, Overview,
  Problem, RecoveryCase, RecoveryTokenInfo, RetryPolicy, Role,
  StripeConnection, TeamMember, TimelineEntry, UpgradeTokenInfo, VoiceProfile
} from "../schemas";
import type { RecoveryExecution } from "../schemas";
import { DemoStore, applyProviderAction, recoveryTokenInfo, upgradeTokenInfo } from "./store";

export type { DemoStore };
export type { recoveryTokenInfo, upgradeTokenInfo };

const log = createLogger("mock-api");

/**
 * ════════════════════════════════════════════════════════════════════════
 *  DEMO API CLIENT — mock implementation of ApiClient.
 *
 *  · Returns labeled fixtures from DemoStore. No network, no Stripe, no
 *    email, no AI, no persistence beyond page memory.
 *  · Simulated latency ~200–420 ms so loading/skeleton states are real.
 *  · Supports reviewer fault injection (failNext / offline) to exercise
 *    error, offline and stale states honestly.
 *  · It NEVER reports a real provider action. "confirmed" states exist only
 *    through the explicitly-labeled demo provider simulation controls.
 * ════════════════════════════════════════════════════════════════════════
 */

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const latency = () => delay(200 + Math.random() * 220);

export class MockApiError extends Error implements ApiError {
  readonly problem: Problem;
  constructor(problem: Problem) {
    super(problem.detail ?? problem.title);
    this.name = "ApiError";
    this.problem = problem;
  }
}

function problem(status: number, title: string, type: string, detail?: string): Problem {
  return { type, title, status, detail };
}

export interface MockApi extends ApiClient {
  /** Demo-only surface, used by the Demo Controls bar. Never called by real UI flows. */
  demo: {
    store(): DemoStore;
    setFailNext(on: boolean): void;
    setOffline(on: boolean): void;
    providerAction(slug: string, kind: "case" | "opportunity", id: string, action: DemoProviderActionInput): Promise<ApprovalStatus>;
    createOrg(name: string, slug: string): Promise<Org>;
    session(orgs?: { slug: string; role: Role }[]): { email: string; name: string; demo: true; memberships: { slug: string; name: string; role: Role; plan: "ember" | "revessent" | "studio" }[] };
  };
}

class MockApiClient implements MockApi {
  private store = new DemoStore();

  private async guard<T>(fn: () => T, path: string): Promise<T> {
    await latency();
    if (this.store.demo.offline) {
      throw new MockApiError(problem(0, "Network unavailable", "/errors/network", "The demo is simulating an offline state. Requests are not leaving the browser."));
    }
    if (this.store.demo.failNext) {
      this.store.demo.failNext = false;
      log.warn(`injected failure for ${path}`);
      throw new MockApiError(problem(500, "Request failed", "/errors/demo-injected", "Injected by demo controls to exercise error states. No real request existed."));
    }
    return fn();
  }

  private requireOrg(slug: string) {
    return this.store.get(slug);
  }

  orgs = {
    get: (slug: string): Promise<Org> =>
      this.guard(() => this.requireOrg(slug).org, `orgs.get(${slug})`)
  };

  overview = (slug: string): Promise<Overview> =>
    this.guard(() => this.store.overviewFor(slug), `overview(${slug})`);

  recovery = {
    list: (slug: string, filters: CaseFilters): Promise<Paged<RecoveryCase>> =>
      this.guard(() => {
        const rec = this.requireOrg(slug);
        let items = [...rec.cases].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        if (filters.status && filters.status !== "all") {
          items = items.filter((c) => c.status === filters.status);
        }
        if (filters.q) {
          const q = filters.q.toLowerCase();
          items = items.filter(
            (c) => c.customerName.toLowerCase().includes(q) || c.customerEmail.toLowerCase().includes(q)
          );
        }
        // Single-page fixtures: cursor pagination shape is real, data fits one page.
        return { items, nextCursor: null };
      }, `recovery.list(${slug})`),

    get: (slug: string, caseId: string): Promise<{ case: RecoveryCase; timeline: TimelineEntry[] }> =>
      this.guard(() => {
        const rec = this.requireOrg(slug);
        const found = rec.cases.find((c) => c.id === caseId);
        if (!found) throw new MockApiError(problem(404, "Case not found", "/errors/not-found", `No recovery case "${caseId}" in the demo fixtures.`));
        return { case: found, timeline: rec.caseTimeline[caseId] ?? [] };
      }, `recovery.get(${slug}, ${caseId})`),

    draft: (slug: string, _caseId: string, draftId: string, action: DraftAction) =>
      this.guard(() => {
        const rec = this.requireOrg(slug);
        if (action.type === "edit") {
          return this.store.applyDraftEvent(rec, draftId, { type: "edit", subject: action.subject, body: action.body });
        }
        return this.store.applyDraftEvent(rec, draftId, action);
      }, `recovery.draft(${slug}, ${draftId}, ${action.type})`),

    executeRetry: (_slug: string, _caseId: string, _input?: { idempotencyKey?: string }): Promise<RecoveryExecution> =>
      this.guard(() => {
        // HONEST demo boundary: no real Stripe connection exists in demo
        // mode, so NO payment outcome is fabricated here — the demo shows
        // the execution affordance but the provider operation is refused.
        throw new MockApiError(problem(501, "Not available in the demo",
          "/errors/not-in-this-phase",
          "Payment execution needs a real, connected Stripe account. The demo never charges anyone — nothing was attempted."));
      }, `recovery.executeRetry(${_slug})`)
  };

  expansion = {
    list: (slug: string): Promise<Paged<Opportunity>> =>
      this.guard(() => {
        const rec = this.requireOrg(slug);
        return { items: [...rec.opportunities].sort((a, b) => a.customerName.localeCompare(b.customerName)), nextCursor: null };
      }, `expansion.list(${slug})`),

    get: (slug: string, id: string): Promise<Opportunity> =>
      this.guard(() => {
        const rec = this.requireOrg(slug);
        const found = rec.opportunities.find((o) => o.id === id);
        if (!found) throw new MockApiError(problem(404, "Opportunity not found", "/errors/not-found"));
        return found;
      }, `expansion.get(${slug}, ${id})`),

    draft: (slug: string, _id: string, draftId: string, action: DraftAction) =>
      this.guard(() => {
        const rec = this.requireOrg(slug);
        if (action.type === "edit") {
          return this.store.applyDraftEvent(rec, draftId, { type: "edit", subject: action.subject, body: action.body });
        }
        return this.store.applyDraftEvent(rec, draftId, action);
      }, `expansion.draft(${slug}, ${draftId})`),

    dismiss: (slug: string, id: string): Promise<{ dismissed: true }> =>
      this.guard(() => {
        const rec = this.requireOrg(slug);
        const found = rec.opportunities.find((o) => o.id === id);
        if (found) found.status = "dismissed";
        return { dismissed: true };
      }, `expansion.dismiss(${slug}, ${id})`)
  };

  customers = {
    list: (slug: string, filters: CustomerFilters): Promise<Paged<Customer>> =>
      this.guard(() => {
        const rec = this.requireOrg(slug);
        let items = [...rec.customers].sort((a, b) => a.name.localeCompare(b.name));
        if (filters.status && filters.status !== "all") items = items.filter((c) => c.status === filters.status);
        if (filters.q) {
          const q = filters.q.toLowerCase();
          items = items.filter((c) => c.name.toLowerCase().includes(q) || c.email.toLowerCase().includes(q));
        }
        return { items, nextCursor: null };
      }, `customers.list(${slug})`),

    get: (slug: string, id: string): Promise<Customer> =>
      this.guard(() => {
        const rec = this.requireOrg(slug);
        const found = rec.customers.find((c) => c.id === id);
        if (!found) throw new MockApiError(problem(404, "Customer not found", "/errors/not-found"));
        return found;
      }, `customers.get(${slug}, ${id})`)
  };

  settings = {
    stripe: (slug: string): Promise<StripeConnection> =>
      this.guard(() => this.requireOrg(slug).connection, `settings.stripe(${slug})`),

    stripeConnect: (slug: string, key: string): Promise<StripeConnection> =>
      this.guard(() => {
        // FORMAT-ONLY validation. The key is not stored, hashed, or transmitted.
        const looksLikeRestrictedKey = /^(sk|rk)_(test|live)_[A-Za-z0-9]{16,}$/.test(key.trim());
        if (!looksLikeRestrictedKey) {
          throw new MockApiError(
            problem(422, "That doesn't look like a Stripe restricted key", "/errors/invalid-key",
              "Expected format: sk_test_… / rk_test_… (restricted keys begin with sk_ or rk_). The demo validates the format only — nothing is stored or sent.")
          );
        }
        const rec = this.requireOrg(slug);
        rec.connection = {
          status: "read_only",
          mode: key.includes("_test_") ? "test" : "live",
          accountRef: `acct_demo_${slug.replace(/-/g, "_")} (${key.includes("_test_") ? "test" : "live"} mode)`,
          lastSyncAt: new Date().toISOString(),
          backfill: "done",
          webhooks: {
            configured: true,
            endpointId: `we_demo_${slug.replace(/-/g, "_")}`,
            lastWebhookAt: new Date().toISOString(),
            failed: 0, unprocessed: 0, lastFailureCode: null, lastFailureAt: null,
            lifecycle: "healthy"
          }
        };
        return rec.connection;
      }, `settings.stripeConnect(${slug})`),

    sync: (slug: string): Promise<{ started: true; connection: StripeConnection; summary: Record<string, { status: "ok" | "failed" | "skipped"; pages: number; upserted: number; anomalies: number; errorCode: string | null }> }> =>
      this.guard(() => {
        const rec = this.requireOrg(slug);
        return {
          started: true as const,
          connection: rec.connection,
          summary: {
            customers: { status: "ok" as const, pages: 1, upserted: rec.customers.length, anomalies: 0, errorCode: null },
            subscriptions: { status: "ok" as const, pages: 1, upserted: 0, anomalies: 0, errorCode: null },
            invoices: { status: "ok" as const, pages: 1, upserted: 0, anomalies: 0, errorCode: null }
          }
        };
      }, `settings.sync(${slug})`),

    reconcile: (slug: string): Promise<{ started: true; connection: StripeConnection; summary: Record<string, { status: "ok" | "failed" | "skipped"; pages: number; upserted: number; anomalies: number; errorCode: string | null }> }> =>
      this.guard(() => {
        // Demo: reconciliation reuses the same labeled mock sync — the demo
        // boundary stays honest (no fabricated provider traffic).
        return {
          started: true as const,
          connection: this.requireOrg(slug).connection,
          summary: {
            customers: { status: "ok" as const, pages: 1, upserted: 0, anomalies: 0, errorCode: null },
            subscriptions: { status: "ok" as const, pages: 1, upserted: 0, anomalies: 0, errorCode: null },
            invoices: { status: "ok" as const, pages: 1, upserted: 0, anomalies: 0, errorCode: null }
          }
        };
      }, `settings.reconcile(${slug})`),

    stripeDisconnect: (slug: string): Promise<StripeConnection> =>
      this.guard(() => {
        const rec = this.requireOrg(slug);
        rec.connection = {
          status: "not_connected", mode: null, accountRef: null, lastSyncAt: null, backfill: null,
          webhooks: {
            configured: false, endpointId: null, lastWebhookAt: null,
            failed: 0, unprocessed: 0, lastFailureCode: null, lastFailureAt: null,
            lifecycle: "healthy"
          }
        };
        return rec.connection;
      }, `settings.stripeDisconnect(${slug})`),

    policy: (slug: string): Promise<RetryPolicy> =>
      this.guard(() => this.requireOrg(slug).policy, `settings.policy(${slug})`),

    savePolicy: (slug: string, policy: RetryPolicy): Promise<RetryPolicy> =>
      this.guard(() => {
        const rec = this.requireOrg(slug);
        rec.policy = policy;
        return rec.policy;
      }, `settings.savePolicy(${slug})`),

    voice: (slug: string): Promise<VoiceProfile> =>
      this.guard(() => this.requireOrg(slug).voice, `settings.voice(${slug})`),

    saveVoice: (slug: string, voice: VoiceProfile): Promise<VoiceProfile> =>
      this.guard(() => {
        const rec = this.requireOrg(slug);
        rec.voice = voice;
        return rec.voice;
      }, `settings.saveVoice(${slug})`),

    team: (slug: string): Promise<TeamMember[]> =>
      this.guard(() => this.requireOrg(slug).team, `settings.team(${slug})`),

    invite: (slug: string, input: { email: string; role: Role }): Promise<{ invited: true; emailSent: boolean; team: TeamMember[] }> =>
      this.guard(() => {
        const rec = this.requireOrg(slug);
        const member: TeamMember = {
          id: `tm_${Math.random().toString(36).slice(2, 8)}`,
          name: input.email.split("@")[0] ?? input.email,
          email: input.email,
          role: input.role
        };
        rec.team = [...rec.team, member];
        // Honest: no email was sent. The UI says invitations require the Phase 4 backend.
        return { invited: true as const, emailSent: false, team: rec.team };
      }, `settings.invite(${slug})`),

    billing: (slug: string): Promise<BillingInfo> =>
      this.guard(() => this.requireOrg(slug).billing, `settings.billing(${slug})`),

    entitlements: (slug: string): Promise<Entitlements> =>
      this.guard(() => {
        const rec = this.requireOrg(slug);
        const resolved = resolveEntitlements({ plan: rec.billing.plan, status: rec.billing.status });
        return {
          plan: resolved.plan, effectivePlan: resolved.effectivePlan, state: resolved.state, restricted: resolved.restricted,
          capabilities: resolved.capabilities, limits: resolved.limits,
          usage: { seatsUsed: rec.team.length, members: rec.customers.length }, overMemberCap: false,
          billing: { status: resolved.status, reasons: resolved.reasons }
        };
      }, `settings.entitlements(${slug})`)
  };

  subscriber = {
    recoveryToken: (token: string): Promise<RecoveryTokenInfo> =>
      this.guard(() => recoveryTokenInfo(token), `subscriber.recoveryToken(${token})`),

    upgradeToken: (token: string): Promise<UpgradeTokenInfo> =>
      this.guard(() => upgradeTokenInfo(token), `subscriber.upgradeToken(${token})`),

    unsubscribe: (_token: string): Promise<{ state: "done" | "unknown" }> =>
      this.guard(() => {
        // Honest pending: real unsubscribe persistence arrives with the backend.
        return { state: "done" };
      }, "subscriber.unsubscribe")
  };

  demo = {
    store: () => this.store,
    setFailNext: (on: boolean) => { this.store.demo.failNext = on; },
    setOffline: (on: boolean) => { this.store.demo.offline = on; },
    providerAction: (slug: string, kind: "case" | "opportunity", id: string, action: DemoProviderActionInput): Promise<ApprovalStatus> =>
      this.guard(() => {
        log.info(`demo provider action ${action.type} on ${kind}/${id} (fixture only)`);
        return applyProviderAction(this.store, slug, kind, id, action);
      }, `demo.providerAction(${slug}, ${id}, ${action.type})`),
    createOrg: (name: string, slug: string): Promise<Org> => this.guard(() => this.store.createOrg(name, slug).org, `demo.createOrg(${slug})`),
    session: (orgs?: { slug: string; name: string; role: Role; plan: "ember" | "revessent" | "studio" }[]) => ({
      email: "priya@acornbooks.example",
      name: "Priya Anand",
      demo: true as const,
      memberships:
        orgs ??
        this.store.orgSummaries().map((o) => ({ slug: o.slug, name: o.name, role: o.role, plan: o.plan }))
    })
  };
}

let singleton: MockApiClient | null = null;

export function getMockApi(): MockApi {
  if (!singleton) singleton = new MockApiClient();
  return singleton;
}
