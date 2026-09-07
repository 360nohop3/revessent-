import type {
  BillingInfo, Customer, MessageDraft, Opportunity, Org, Overview,
  RecoveryCase, RecoveryTokenInfo, RetryPolicy, Role, StripeConnection,
  TeamMember, TimelineEntry, UpgradeTokenInfo, VoiceProfile
} from "../schemas";
import { transition, type ApprovalEvent, type ApprovalStatus } from "@revessent/domain";

/**
 * ════════════════════════════════════════════════════════════════════════
 *  DEMO DATA STORE — fixtures only. NOTHING here talks to Stripe, email,
 *  AI or a database. Every number is illustrative. This store exists so the
 *  Phase 2 UI can be developed against the real Phase 3 contract shapes.
 * ════════════════════════════════════════════════════════════════════════
 */

const NOW = () => Date.now();
const iso = (msAgo: number) => new Date(NOW() - msAgo).toISOString();
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;

export interface OrgRecord {
  org: Org;
  role: Role;
  connection: StripeConnection;
  cases: RecoveryCase[];
  caseTimeline: Record<string, TimelineEntry[]>;
  opportunities: Opportunity[];
  customers: Customer[];
  policy: RetryPolicy;
  voice: VoiceProfile;
  team: TeamMember[];
  billing: BillingInfo;
}

function draft(
  id: string,
  approvalStatus: ApprovalStatus,
  subject: string,
  body: string,
  extra?: Partial<MessageDraft>
): MessageDraft {
  return {
    id,
    approvalStatus,
    subject,
    body,
    providerRef: null,
    updatedAt: iso(30 * MIN),
    approvedAt: null,
    approvedBy: null,
    ...extra
  };
}

function buildAcornBooks(): OrgRecord {
  const lastSync = iso(6 * MIN);
  const connection: StripeConnection = {
    status: "read_only",
    mode: "test",
    accountRef: "acct_demo_acorn (test mode)",
    lastSyncAt: lastSync,
    backfill: "done",
    keyLast4: "b3x1",
    displayName: "Acorn Books (demo)",
    country: "US",
    defaultCurrency: "USD",
    lastValidatedAt: lastSync,
    sync: {
      customers: { status: "fresh", lastSuccessAt: lastSync, lastAttemptAt: lastSync, errorCode: null },
      subscriptions: { status: "fresh", lastSuccessAt: lastSync, lastAttemptAt: lastSync, errorCode: null },
      invoices: { status: "fresh", lastSuccessAt: lastSync, lastAttemptAt: lastSync, errorCode: null }
    },
    webhooks: {
      configured: true,
      endpointId: "we_demo_acorn",
      lastWebhookAt: iso(2 * MIN),
      failed: 0,
      unprocessed: 0,
      lastFailureCode: null,
      lastFailureAt: null,
      lifecycle: "healthy"
    }
  };

  const cases: RecoveryCase[] = [
    {
      id: "case_acorn_1",
      orgSlug: "acorn-books",
      customerName: "Luna Marsh",
      customerEmail: "luna@example.com",
      amount: { minor: 18400, currency: "USD" },
      interval: "month",
      status: "retrying",
      retry: { autoAttempts: 1, maxAutoRetries: 3, state: "waiting", reason: "backoff", nextEligibleAt: new Date(NOW() + 30 * HOUR).toISOString(), reconciliationRequired: false },
      declineCode: "insufficient_funds",
      category: "insufficient_funds",
      outreachSafe: true,
      nextActionAt: new Date(NOW() + 14 * HOUR).toISOString(),
      createdAt: iso(2 * DAY),
      evidence: {
        declineCode: "insufficient_funds",
        category: "insufficient_funds",
        attempts: [
          { at: iso(2 * DAY), source: "stripe_default", outcome: "failed", declineCode: "insufficient_funds" },
          { at: iso(1 * DAY), source: "stripe_default", outcome: "failed", declineCode: "insufficient_funds" }
        ]
      },
      draft: null
    },
    {
      id: "case_acorn_2",
      orgSlug: "acorn-books",
      customerName: "Maya Chen",
      customerEmail: "maya@example.com",
      amount: { minor: 15000, currency: "USD" },
      interval: "month",
      status: "contacting",
      retry: { autoAttempts: 2, maxAutoRetries: 3, state: "blocked", reason: "outcome_not_retryable:card_declined", nextEligibleAt: null, reconciliationRequired: false },
      declineCode: "do_not_honor",
      category: "issuer_decline",
      outreachSafe: true,
      nextActionAt: null,
      createdAt: iso(1 * DAY),
      evidence: {
        declineCode: "do_not_honor",
        category: "issuer_decline",
        attempts: [
          { at: iso(1 * DAY), source: "stripe_default", outcome: "failed", declineCode: "do_not_honor" }
        ]
      },
      draft: draft(
        "draft_acorn_2",
        "awaiting_approval",
        "A quick card check",
        "Hi Maya — no stress, this happens all the time. Your bank declined the renewal this month, which is usually easy to fix on your side. Update your card here and everything continues as normal.",
        { approvedBy: null }
      )
    },
    {
      id: "case_acorn_3",
      orgSlug: "acorn-books",
      customerName: "Zoe Park",
      customerEmail: "zoe@example.com",
      amount: { minor: 18400, currency: "USD" },
      interval: "month",
      status: "checkout",
      retry: { autoAttempts: 1, maxAutoRetries: 3, state: "blocked", reason: "outcome_not_retryable:authentication_required", nextEligibleAt: null, reconciliationRequired: false },
      declineCode: "expired_card",
      category: "expired_card",
      outreachSafe: true,
      nextActionAt: null,
      createdAt: iso(3 * DAY),
      evidence: {
        declineCode: "expired_card",
        category: "expired_card",
        attempts: [
          { at: iso(3 * DAY), source: "stripe_default", outcome: "failed", declineCode: "expired_card" }
        ]
      },
      draft: draft(
        "draft_acorn_3",
        "provider_pending",
        "Your membership renewal",
        "Hi Zoe — the card on file (··4242) expired, so your membership couldn't renew. Update it here and you're all set. Nothing else changes.",
        { approvedAt: iso(2 * DAY), approvedBy: "Priya (owner)", providerRef: null }
      )
    },
    {
      id: "case_acorn_4",
      orgSlug: "acorn-books",
      customerName: "Amara Obi",
      customerEmail: "amara@example.com",
      amount: { minor: 24000, currency: "USD" },
      interval: "month",
      status: "recovered",
      retry: { autoAttempts: 1, maxAutoRetries: 3, state: "blocked", reason: "payment_already_paid", nextEligibleAt: null, reconciliationRequired: false },
      declineCode: "insufficient_funds",
      category: "insufficient_funds",
      outreachSafe: true,
      nextActionAt: null,
      createdAt: iso(9 * DAY),
      evidence: {
        declineCode: "insufficient_funds",
        category: "insufficient_funds",
        attempts: [
          { at: iso(9 * DAY), source: "stripe_default", outcome: "failed", declineCode: "insufficient_funds" },
          { at: iso(8 * DAY), source: "revessent_retry", outcome: "succeeded", declineCode: null }
        ]
      },
      draft: null
    },
    {
      id: "case_acorn_5",
      orgSlug: "acorn-books",
      customerName: "Hana Ito",
      customerEmail: "hana@example.com",
      amount: { minor: 9900, currency: "USD" },
      interval: "month",
      status: "lost",
      retry: { autoAttempts: 3, maxAutoRetries: 3, state: "exhausted", reason: "max_auto_retries", nextEligibleAt: null, reconciliationRequired: false },
      declineCode: "incorrect_number",
      category: "credential",
      outreachSafe: true,
      nextActionAt: null,
      createdAt: iso(26 * DAY),
      evidence: {
        declineCode: "incorrect_number",
        category: "credential",
        attempts: [
          { at: iso(26 * DAY), source: "stripe_default", outcome: "failed", declineCode: "incorrect_number" },
          { at: iso(25 * DAY), source: "revessent_retry", outcome: "failed", declineCode: "incorrect_number" }
        ]
      },
      draft: null
    },
    {
      id: "case_acorn_6",
      orgSlug: "acorn-books",
      customerName: "Omari Diallo",
      customerEmail: "omari@example.com",
      amount: { minor: 12000, currency: "USD" },
      interval: "year",
      status: "analyzing",
      retry: { autoAttempts: 0, maxAutoRetries: 3, state: "blocked", reason: "case_not_retryable", nextEligibleAt: null, reconciliationRequired: false },
      declineCode: "stolen_card",
      category: "hard",
      outreachSafe: false,
      nextActionAt: null,
      createdAt: iso(5 * HOUR),
      evidence: {
        declineCode: "stolen_card",
        category: "hard",
        attempts: [
          { at: iso(5 * HOUR), source: "stripe_default", outcome: "failed", declineCode: "stolen_card" }
        ]
      },
      draft: null
    }
  ];

  const timeline: Record<string, TimelineEntry[]> = {
    case_acorn_2: [
      { id: "t2a", at: iso(1 * DAY), kind: "system", title: "Payment failed", detail: "Stripe reported do_not_honor on the default retry.", tone: "warn" },
      { id: "t2b", at: iso(22 * HOUR), kind: "note", title: "Recovery note drafted", detail: "Drafted for review — nothing is sent without approval.", tone: "info" },
      { id: "t2c", at: iso(20 * HOUR), kind: "approval", title: "Awaiting approval", detail: "Waiting for an operator to review the draft.", tone: "neutral" }
    ],
    case_acorn_3: [
      { id: "t3a", at: iso(3 * DAY), kind: "system", title: "Payment failed", detail: "Stripe reported expired_card.", tone: "warn" },
      { id: "t3b", at: iso(2 * DAY), kind: "approval", title: "Note approved", detail: "Approved by Priya (owner).", tone: "info" },
      { id: "t3c", at: iso(2 * DAY + HOUR), kind: "provider", title: "Recovery link sent (fixture)", detail: "Demo fixture — in production this reflects a real provider-confirmed send.", tone: "info" },
      { id: "t3d", at: iso(3 * HOUR), kind: "provider", title: "Awaiting provider confirmation", detail: "The member has not completed checkout yet. Pending is not success.", tone: "neutral" }
    ]
  };

  const opportunities: Opportunity[] = [
    {
      id: "opp_acorn_1",
      orgSlug: "acorn-books",
      customerName: "Maya Chen",
      currentPlan: "Starter · $15/mo",
      recommendedPlan: "Standard · $20/mo",
      potentialMrr: { minor: 5000, currency: "USD" },
      signal: "Approaching plan limit",
      signalEvidence: "Operator-reported usage signal (manual entry) — usage feeds arrive in Phase 6.",
      rationale:
        "Maya has repeatedly bumped the Starter document limit this quarter. A Standard plan removes the friction. This is a recommendation only — nothing has been proposed to the member yet.",
      status: "awaiting_approval",
      draft: draft(
        "draft_opp_1",
        "awaiting_approval",
        "Room to grow, if you want it",
        "Hi Maya — you've been close to your Starter plan limits for a few weeks. If it would help, the Standard plan doubles them. Happy to switch you over whenever it suits you."
      )
    },
    {
      id: "opp_acorn_2",
      orgSlug: "acorn-books",
      customerName: "Rahul Nair",
      currentPlan: "Pro · $25/mo",
      recommendedPlan: "Scale · $40/mo",
      potentialMrr: { minor: 15000, currency: "USD" },
      signal: "Seat count above plan",
      signalEvidence: "Stripe subscription metadata shows 9 active seats; Pro is metered for 5.",
      rationale:
        "Rahul's team outgrew the Pro seat count two months ago. Scale covers the current usage with headroom.",
      status: "new",
      draft: draft(
        "draft_opp_2",
        "draft",
        "A plan that fits your team",
        "Hi Rahul — your team has outgrown the Pro plan's seats. The Scale plan covers everyone with room to spare. Want me to switch you over?"
      )
    }
  ];

  const customers: Customer[] = [
    {
      id: "cust_1", orgSlug: "acorn-books", name: "Luna Marsh", email: "luna@example.com",
      mrr: { minor: 18400, currency: "USD" }, status: "past_due", riskStatus: "recovering", expansionStatus: "none",
      subscriptions: [{ id: "sub_1", plan: "Standard", amount: { minor: 18400, currency: "USD" }, interval: "month", status: "past_due" }],
      payments: [
        { id: "pm_1", at: iso(2 * DAY), amount: { minor: 18400, currency: "USD" }, outcome: "failed", source: "stripe_default" },
        { id: "pm_2", at: iso(32 * DAY), amount: { minor: 18400, currency: "USD" }, outcome: "paid", source: "stripe_default" }
      ]
    },
    {
      id: "cust_2", orgSlug: "acorn-books", name: "Maya Chen", email: "maya@example.com",
      mrr: { minor: 15000, currency: "USD" }, status: "past_due", riskStatus: "recovering", expansionStatus: "opportunity",
      subscriptions: [{ id: "sub_2", plan: "Starter", amount: { minor: 15000, currency: "USD" }, interval: "month", status: "past_due" }],
      payments: [
        { id: "pm_3", at: iso(1 * DAY), amount: { minor: 15000, currency: "USD" }, outcome: "failed", source: "stripe_default" },
        { id: "pm_4", at: iso(31 * DAY), amount: { minor: 15000, currency: "USD" }, outcome: "paid", source: "stripe_default" }
      ]
    },
    {
      id: "cust_3", orgSlug: "acorn-books", name: "Zoe Park", email: "zoe@example.com",
      mrr: { minor: 18400, currency: "USD" }, status: "past_due", riskStatus: "recovering", expansionStatus: "none",
      subscriptions: [{ id: "sub_3", plan: "Standard", amount: { minor: 18400, currency: "USD" }, interval: "month", status: "past_due" }],
      payments: [
        { id: "pm_5", at: iso(3 * DAY), amount: { minor: 18400, currency: "USD" }, outcome: "failed", source: "stripe_default" }
      ]
    },
    {
      id: "cust_4", orgSlug: "acorn-books", name: "Amara Obi", email: "amara@example.com",
      mrr: { minor: 24000, currency: "USD" }, status: "active", riskStatus: "none", expansionStatus: "signal",
      subscriptions: [{ id: "sub_4", plan: "Scale", amount: { minor: 24000, currency: "USD" }, interval: "month", status: "active" }],
      payments: [
        { id: "pm_6", at: iso(8 * DAY), amount: { minor: 24000, currency: "USD" }, outcome: "paid", source: "revessent_retry" },
        { id: "pm_7", at: iso(38 * DAY), amount: { minor: 24000, currency: "USD" }, outcome: "paid", source: "stripe_default" }
      ]
    },
    {
      id: "cust_5", orgSlug: "acorn-books", name: "Hana Ito", email: "hana@example.com",
      mrr: { minor: 0, currency: "USD" }, status: "canceled", riskStatus: "lost", expansionStatus: "none",
      subscriptions: [{ id: "sub_5", plan: "Starter", amount: { minor: 9900, currency: "USD" }, interval: "month", status: "canceled" }],
      payments: [
        { id: "pm_8", at: iso(26 * DAY), amount: { minor: 9900, currency: "USD" }, outcome: "failed", source: "stripe_default" }
      ]
    },
    {
      id: "cust_6", orgSlug: "acorn-books", name: "Noah Reyes", email: "noah@example.com",
      mrr: { minor: 40000, currency: "USD" }, status: "active", riskStatus: "none", expansionStatus: "none",
      subscriptions: [{ id: "sub_6", plan: "Scale", amount: { minor: 40000, currency: "USD" }, interval: "month", status: "active" }],
      payments: [
        { id: "pm_9", at: iso(10 * DAY), amount: { minor: 40000, currency: "USD" }, outcome: "paid", source: "stripe_default" }
      ]
    }
  ];

  return {
    org: {
      id: "org_acorn", slug: "acorn-books", name: "Acorn Books", plan: "revessent",
      timezone: "America/New_York", pilotEndsAt: new Date(NOW() + 9 * DAY).toISOString()
    },
    role: "owner",
    connection,
    cases,
    caseTimeline: timeline,
    opportunities,
    customers,
    policy: {
      maxAutoRetries: 4, quietHoursStart: 22, quietHoursEnd: 8,
      minGapHours: 24, noteAfterFailedRetries: 2, checkoutAfterNote: true
    },
    voice: {
      sampleText: "Hi — quick note. No stress if you've been busy; here's the link and you're set.",
      styleSummary: "Short, warm, unhurried. Plain words, no urgency tactics, one clear action.",
      greeting: "Hi {firstName} —",
      signoff: "— the Acorn Books team"
    },
    team: [
      { id: "tm_1", name: "Priya Anand", email: "priya@acornbooks.example", role: "owner" },
      { id: "tm_2", name: "Sam Whitfield", email: "sam@acornbooks.example", role: "operator" },
      { id: "tm_3", name: "Jules Ferreira", email: "jules@acornbooks.example", role: "viewer" }
    ],
    billing: {
      plan: "revessent", status: "trialing",
      pilotEndsAt: new Date(NOW() + 9 * DAY).toISOString(),
      guaranteeWindowEndsAt: new Date(NOW() + 81 * DAY).toISOString(),
      billingProviderLive: false, currentPeriodEnd: null, cancelAtPeriodEnd: false,
      effectivePlan: "revessent", restricted: false, reasons: ["subscription_trialing"]
    }
  };
}

function buildFernbrook(): OrgRecord {
  return {
    org: {
      id: "org_fern", slug: "fernbrook", name: "Fernbrook Studio", plan: "ember",
      timezone: "Europe/Berlin", pilotEndsAt: null
    },
    role: "viewer",
    connection: {
      status: "not_connected", mode: null, accountRef: null,
      lastSyncAt: null, backfill: null, keyLast4: null, displayName: null,
      country: null, defaultCurrency: null, lastValidatedAt: null,
      sync: {
        customers: { status: "never", lastSuccessAt: null, lastAttemptAt: null, errorCode: null },
        subscriptions: { status: "never", lastSuccessAt: null, lastAttemptAt: null, errorCode: null },
        invoices: { status: "never", lastSuccessAt: null, lastAttemptAt: null, errorCode: null }
      }
    },
    cases: [],
    caseTimeline: {},
    opportunities: [],
    customers: [],
    policy: {
      maxAutoRetries: 4, quietHoursStart: 22, quietHoursEnd: 8,
      minGapHours: 24, noteAfterFailedRetries: 2, checkoutAfterNote: true
    },
    voice: { sampleText: "", styleSummary: "", greeting: "Hi {firstName} —", signoff: "" },
    team: [{ id: "tm_f1", name: "Ines Kovač", email: "ines@fernbrook.example", role: "owner" }],
    billing: {
      plan: "ember", status: "active", pilotEndsAt: null,
      guaranteeWindowEndsAt: null, billingProviderLive: false, currentPeriodEnd: null, cancelAtPeriodEnd: false,
      effectivePlan: "ember", restricted: false, reasons: ["free_plan"]
    }
  };
}

export class DemoStore {
  private orgs = new Map<string, OrgRecord>();
  /** Demo fault injection (Phase 2 §9/§18): lets reviewers exercise error states. */
  demo = { failNext: false, offline: false };

  constructor() {
    this.orgs.set("acorn-books", buildAcornBooks());
    this.orgs.set("fernbrook", buildFernbrook());
  }

  reset(): void {
    this.orgs.clear();
    this.orgs.set("acorn-books", buildAcornBooks());
    this.orgs.set("fernbrook", buildFernbrook());
    this.demo.failNext = false;
    this.demo.offline = false;
  }

  get(slug: string): OrgRecord {
    const rec = this.orgs.get(slug);
    if (!rec) throw new Error(`Unknown demo org "${slug}"`);
    return rec;
  }

  has(slug: string): boolean {
    return this.orgs.has(slug);
  }

  /** Demo onboarding: creates a fresh org (owner role, nothing connected). */
  createOrg(name: string, slug: string): OrgRecord {
    if (this.orgs.has(slug)) throw new Error(`Org slug "${slug}" already exists`);
    const rec: OrgRecord = {
      org: { id: `org_${slug}`, slug, name, plan: "ember", timezone: "UTC", pilotEndsAt: null },
      role: "owner",
      connection: {
        status: "not_connected", mode: null, accountRef: null, lastSyncAt: null, backfill: null,
        keyLast4: null, displayName: null, country: null, defaultCurrency: null, lastValidatedAt: null,
        sync: {
          customers: { status: "never", lastSuccessAt: null, lastAttemptAt: null, errorCode: null },
          subscriptions: { status: "never", lastSuccessAt: null, lastAttemptAt: null, errorCode: null },
          invoices: { status: "never", lastSuccessAt: null, lastAttemptAt: null, errorCode: null }
        }
      },
      cases: [], caseTimeline: {}, opportunities: [], customers: [],
      policy: {
        maxAutoRetries: 4, quietHoursStart: 22, quietHoursEnd: 8,
        minGapHours: 24, noteAfterFailedRetries: 2, checkoutAfterNote: true
      },
      voice: { sampleText: "", styleSummary: "", greeting: "Hi {firstName} —", signoff: "" },
      team: [{ id: "tm_owner", name: "You (demo)", email: "priya@acornbooks.example", role: "owner" }],
      billing: { plan: "ember", status: "trialing", pilotEndsAt: null, guaranteeWindowEndsAt: null, billingProviderLive: false, currentPeriodEnd: null, cancelAtPeriodEnd: false, effectivePlan: "ember", restricted: false, reasons: ["free_plan"] }
    };
    this.orgs.set(slug, rec);
    return rec;
  }

  orgSummaries() {
    return [...this.orgs.values()].map((r) => ({
      slug: r.org.slug, name: r.org.name, role: r.role, plan: r.org.plan
    }));
  }

  overviewFor(slug: string): Overview {
    const rec = this.get(slug);
    if (rec.connection.status === "not_connected" || rec.connection.status === "revoked") {
      // Disconnected ≠ zeros. The UI must render the disconnected state, not empty metrics.
      return {
        orgSlug: slug,
        cashRecovered30d: null, mrrAtRisk: null, potentialMrr: null, recoveryRatePct: null,
        cases: { open: 0, recovered30d: 0, lost30d: 0 },
        approvalsPending: 0, series: [], activity: []
      };
    }
    const open = rec.cases.filter((c) => !["recovered", "lost", "canceled", "dismissed"].includes(c.status));
    const recovered = rec.cases.filter((c) => c.status === "recovered");
    const lost = rec.cases.filter((c) => c.status === "lost");
    const decided = recovered.length + lost.length;
    const pendingApprovals = rec.cases.filter(
      (c) => c.draft?.approvalStatus === "awaiting_approval"
    ).length + rec.opportunities.filter((o) => o.status === "awaiting_approval").length;

    return {
      orgSlug: slug,
      // Fixture values, clearly labeled as demo data in the UI.
      cashRecovered30d: { minor: recovered.reduce((a, c) => a + c.amount.minor, 0), currency: "USD" },
      mrrAtRisk: { minor: open.reduce((a, c) => a + c.amount.minor, 0), currency: "USD" },
      potentialMrr: { minor: rec.opportunities.filter((o) => !["confirmed", "dismissed", "declined", "expired"].includes(o.status)).reduce((a, o) => a + o.potentialMrr.minor, 0), currency: "USD" },
      recoveryRatePct: decided === 0 ? null : recovered.length / decided,
      cases: { open: open.length, recovered30d: recovered.length, lost30d: lost.length },
      approvalsPending: pendingApprovals,
      series: [
        { weekStart: "2026-08-03", recoveredMinor: 0, lostMinor: 9900 },
        { weekStart: "2026-08-10", recoveredMinor: 0, lostMinor: 0 },
        { weekStart: "2026-08-17", recoveredMinor: 9900, lostMinor: 0 },
        { weekStart: "2026-08-24", recoveredMinor: 18400, lostMinor: 0 },
        { weekStart: "2026-08-31", recoveredMinor: 24000, lostMinor: 0 },
        { weekStart: "2026-09-01", recoveredMinor: 24000, lostMinor: 0 }
      ],
      activity: [
        { id: "act1", at: iso(3 * HOUR), kind: "provider", text: "Zoe Park — recovery link opened. Awaiting provider confirmation.", tone: "neutral" },
        { id: "act2", at: iso(8 * DAY), kind: "recovery", text: "Amara Obi — payment recovered on a scheduled retry (fixture).", tone: "ok" },
        { id: "act3", at: iso(20 * HOUR), kind: "approval", text: "Maya Chen — recovery note awaiting approval.", tone: "warn" },
        { id: "act4", at: iso(26 * DAY), kind: "recovery", text: "Hana Ito — case closed: retries exhausted.", tone: "err" },
        { id: "act5", at: iso(2 * HOUR), kind: "expansion", text: "Maya Chen — upgrade opportunity drafted, awaiting approval.", tone: "info" }
      ]
    };
  }

  findDraftHolder(rec: OrgRecord, draftId: string): { kind: "case" | "opportunity"; id: string } {
    const c = rec.cases.find((x) => x.draft?.id === draftId);
    if (c) return { kind: "case", id: c.id };
    const o = rec.opportunities.find((x) => x.draft?.id === draftId);
    if (o) return { kind: "opportunity", id: o.id };
    throw new Error(`Draft ${draftId} not found in demo store`);
  }

  /** Applies a domain-validated approval event to the fixture draft. */
  applyDraftEvent(rec: OrgRecord, draftId: string, event: ApprovalEvent): MessageDraft {
    const holder = this.findDraftHolder(rec, draftId);
    const pool = holder.kind === "case" ? rec.cases : rec.opportunities;
    const item = pool.find((x) => x.id === holder.id)!;
    const current = item.draft!.approvalStatus as ApprovalStatus;
    const result = transition(current, event);
    if (!result.ok) throw new Error(result.reason);
    if (event.type === "edit") {
      item.draft = {
        ...item.draft!,
        subject: event.subject ?? item.draft!.subject,
        body: event.body ?? item.draft!.body,
        approvalStatus: result.status,
        updatedAt: new Date().toISOString()
      };
    } else if (event.type === "approve") {
      item.draft = {
        ...item.draft!,
        approvalStatus: result.status,
        approvedAt: new Date().toISOString(),
        approvedBy: event.actor
      };
    } else {
      item.draft = { ...item.draft!, approvalStatus: result.status };
    }
    return item.draft;
  }
}

/* Provider simulation lives on the store so UI demo controls and the mock API
   share one code path. These actions are visually labeled "demo" everywhere. */
export function applyProviderAction(
  store: DemoStore,
  slug: string,
  kind: "case" | "opportunity",
  id: string,
  action: { type: string; providerRef?: string; reason?: string }
): ApprovalStatus {
  const rec = store.get(slug);
  const pool = kind === "case" ? rec.cases : rec.opportunities;
  const holder = pool.find((x) => x.id === id);
  if (!holder?.draft) throw new Error("No draft to act on");
  const current = holder.draft.approvalStatus as ApprovalStatus;
  let event: ApprovalEvent;
  switch (action.type) {
    case "demo.execution_started": event = { type: "execution_started" }; break;
    case "demo.provider_pending": event = { type: "provider_pending" }; break;
    case "demo.provider_confirmed": event = { type: "provider_confirmed", providerRef: action.providerRef }; break;
    case "demo.provider_failed": event = { type: "provider_failed", reason: action.reason }; break;
    default: throw new Error(`Unknown demo action ${action.type}`);
  }
  const result = transition(current, event);
  if (!result.ok) throw new Error(result.reason);
  holder.draft = {
    ...holder.draft,
    approvalStatus: result.status,
    providerRef: action.providerRef ?? holder.draft.providerRef
  };
  // Keep case status coherent with confirmed provider outcomes (fixture behavior).
  if (result.status === "confirmed" && kind === "case") {
    holder.status = "recovered";
  }
  if (result.status === "failed" && kind === "case") {
    holder.status = "retrying";
  }
  return result.status;
}

/* ── subscriber token fixtures (Phase 2 §14) ── */
export function recoveryTokenInfo(token: string): RecoveryTokenInfo {
  if (token === "tok_demo_valid") {
    return {
      state: "valid", orgName: "Acorn Books", productName: "Standard membership",
      amount: { minor: 18400, currency: "USD" }, cardLast4: "4242",
      expiresAt: new Date(NOW() + 10 * DAY).toISOString()
    };
  }
  if (token === "tok_demo_expired") {
    return { state: "expired", orgName: "Acorn Books", productName: null, amount: null, cardLast4: null, expiresAt: iso(2 * DAY) };
  }
  if (token === "tok_demo_used") {
    return { state: "used", orgName: "Acorn Books", productName: null, amount: null, cardLast4: null, expiresAt: null };
  }
  return { state: "unknown", orgName: null, productName: null, amount: null, cardLast4: null, expiresAt: null };
}

export function upgradeTokenInfo(token: string): UpgradeTokenInfo {
  if (token === "tok_demo_upgrade") {
    return {
      state: "valid", orgName: "Acorn Books", currentPlan: "Starter",
      recommendedPlan: "Standard", delta: { minor: 500, currency: "USD" }
    };
  }
  return { state: "unknown", orgName: null, currentPlan: null, recommendedPlan: null, delta: null };
}
