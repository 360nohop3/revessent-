/**
 * PHASE 7 — entitlements & plan enforcement (real Postgres, fixture billing).
 *
 *   - authoritative source: org_subscriptions only (client values never matter)
 *   - capability gates: 402 problem + audit, no state change
 *   - seat limit: atomic under concurrency (final unit consumed exactly once)
 *   - billing events: simulated Stripe Billing webhooks (official SDK
 *     signature on the raw body) — duplicates, out-of-order, forged org ids,
 *     concurrent deliveries, upgrade/downgrade/cancel/past_due/trial expiry
 *   - AI/email: Ember ⇒ templates only + approval-only; suppression still wins
 *   - tenant isolation + RBAC (billing read owner/admin only detail)
 *
 * No live Stripe call is made anywhere in this file.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  appDb, billingService, entitlementsService, expansionService, settingsService, communicationService, recoveryService, suppressionService
} from "@revessent/server";
import * as schema from "@revessent/db";
import { withOrgTx } from "@revessent/db";
import { generateTestSignatureHeader, setEmailProviderForTests, resetEmailProvider } from "@revessent/integrations";
import { fakeEmailProvider } from "@revessent/integrations/email-fixtures";
import { setAiProviderForTests, resetAiProvider } from "@revessent/ai";
import { fakeAiProvider } from "@revessent/ai/fakes";
import { resetBillingEnvForTests } from "@revessent/config";
import { createTestOrg, createTestUser, ctxFor, setPlanForTests, suffix, type TestUser } from "./helpers";

const BILLING_SECRET = "whsec_test_billing_0123456789abcdef";

/* ---------- Stripe Billing event builder (wire shape) ---------- */
let seq = 0;
function subEvent(input: {
  type?: string; subId: string; customerId: string; status: string; lookupKey?: string | null;
  metadataOrgId?: string | null; createdOffsetSec?: number; id?: string; cancelAtPeriodEnd?: boolean; periodEndEpoch?: number | null;
}) {
  seq++;
  const id = input.id ?? `evt_bill_${suffix()}_${seq}`;
  const created = Math.floor(Date.now() / 1000) + (input.createdOffsetSec ?? 0);
  const event = {
    id, object: "event", api_version: "2024-06-20", created, livemode: false, pending_webhooks: 1,
    request: { id: null, idempotency_key: null }, type: input.type ?? "customer.subscription.updated",
    data: { object: {
      id: input.subId, object: "subscription", customer: input.customerId, status: input.status,
      cancel_at_period_end: input.cancelAtPeriodEnd ?? false,
      current_period_end: input.periodEndEpoch ?? created + 30 * 86400,
      metadata: input.metadataOrgId ? { org_id: input.metadataOrgId } : {},
      items: { data: [{ id: "si_1", price: { id: "price_x", lookup_key: input.lookupKey === undefined ? "revessent_monthly" : input.lookupKey, metadata: {} } }] }
    } }
  };
  return { id, payload: JSON.stringify(event), raw: event };
}

async function deliver(payload: string, secret = BILLING_SECRET) {
  const sigHeader = await generateTestSignatureHeader({ payload, secret });
  return billingService.receiveBillingWebhook({ rawBody: payload, sigHeader });
}

async function billingRow(orgId: string) {
  const [r] = await withOrgTx(appDb(), orgId, (tx) => tx.select().from(schema.orgSubscriptions).where(eq(schema.orgSubscriptions.orgId, orgId)));
  return r!;
}
async function audits(orgId: string, action: string) {
  return withOrgTx(appDb(), orgId, (tx) => tx.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.orgId, orgId), eq(schema.auditLogs.action, action))));
}

describe("Phase 7 — entitlements", () => {
  let owner: TestUser; let admin: TestUser; let operator: TestUser; let viewer: TestUser;
  let slug = ""; let orgId = "";

  beforeAll(async () => {
    process.env.BILLING_WEBHOOK_SECRET = BILLING_SECRET;
    process.env.BILLING_LIVEMODE = "false";
    resetBillingEnvForTests();
    owner = await createTestUser("ent-owner");
    admin = await createTestUser("ent-admin");
    operator = await createTestUser("ent-op");
    viewer = await createTestUser("ent-viewer");
    const o = await createTestOrg(owner, "ent", [{ user: admin, role: "admin" }, { user: operator, role: "operator" }, { user: viewer, role: "viewer" }]);
    slug = o.slug; orgId = o.orgId;
  });
  afterEach(() => { resetEmailProvider(); resetAiProvider(); });

  /* ------------------------------------------------------------ resolution */

  it("a new org resolves to Ember/trialing from its billing row: baseline capabilities, 1 seat, cap 1000", async () => {
    const ctx = await ctxFor(owner, slug, "own");
    const e = await entitlementsService.describe(ctx);
    expect(e.plan).toBe("ember"); expect(e.effectivePlan).toBe("ember"); expect(e.state).toBe("baseline");
    expect(e.capabilities).toMatchObject({ smart_retries: true, recovery_checkout: true, ai_notes: false, upgrade_signals: false, trust_autonomy: false });
    expect(e.limits).toEqual({ memberCap: 1000, seats: 1 });
    expect(e.usage.seatsUsed).toBe(4); // owner + 3 extras seeded directly (over the Ember cap: reported, existing members untouched)
    expect(e.billing).toEqual({ status: "trialing", reasons: ["free_plan"] });
  });

  it("organizations.plan is DISPLAY only — the billing row decides (forged/stale org.plan never grants)", async () => {
    // Simulate a drifted display column claiming studio while billing says ember.
    await withOrgTx(appDb(), orgId, (tx) => tx.update(schema.organizations).set({ plan: "studio" }).where(eq(schema.organizations.id, orgId)));
    try {
      const ctx = await ctxFor(owner, slug, "own");
      expect(ctx.org.plan).toBe("studio");
      const d = await entitlementsService.can(ctx.db, orgId, "ai_notes");
      expect(d.allowed).toBe(false);
      expect(d.reason).toBe("capability_not_in_plan:ember");
    } finally {
      await withOrgTx(appDb(), orgId, (tx) => tx.update(schema.organizations).set({ plan: "ember" }).where(eq(schema.organizations.id, orgId)));
    }
  });

  it("billing detail is hidden from operators/viewers; the gating outcome is visible to every member", async () => {
    const v = await entitlementsService.describe(await ctxFor(viewer, slug, "view"));
    expect(v.billing).toBeNull(); expect(v.capabilities.ai_notes).toBe(false);
    const a = await entitlementsService.describe(await ctxFor(admin, slug, "administer"));
    expect(a.billing).not.toBeNull();
  });

  /* ------------------------------------------------------------ capabilities */

  it("upgrade signals: Ember ⇒ 402 entitlement-required + audit, no row written; Revessent ⇒ allowed", async () => {
    const ctx = await ctxFor(admin, slug, "administer");
    const [cust] = await withOrgTx(appDb(), orgId, (tx) => tx.insert(schema.customers).values({ orgId, stripeCustomerId: `cus_${suffix()}`, email: "x@example.test", currency: "USD" }).returning());
    await expect(expansionService.pushSignal(ctx, { customerId: cust!.id, kind: "seats", payload: {} }, {}))
      .rejects.toMatchObject({ problem: { status: 402, type: "/errors/entitlement-required" } });
    const signals = await withOrgTx(appDb(), orgId, (tx) => tx.select().from(schema.expansionSignals).where(eq(schema.expansionSignals.customerId, cust!.id)));
    expect(signals).toHaveLength(0);
    const denied = await audits(orgId, "entitlement.capability_denied");
    expect(denied.some((a) => (a.diff as { capability: string }).capability === "upgrade_signals")).toBe(true);
    expect(JSON.stringify(denied)).not.toMatch(/whsec|sk_|rk_/);

    await setPlanForTests(orgId, "revessent", "active");
    try {
      const r = await expansionService.pushSignal(ctx, { customerId: cust!.id, kind: "seats", payload: {} }, {});
      expect(r.id).toBeTruthy();
    } finally { await setPlanForTests(orgId, "ember", "trialing"); }
  });

  it("existing opportunities stay READABLE and dismissible after a downgrade; only new forward work is gated", async () => {
    const ctx = await ctxFor(operator, slug, "operate");
    const [cust] = await withOrgTx(appDb(), orgId, (tx) => tx.insert(schema.customers).values({ orgId, stripeCustomerId: `cus_${suffix()}`, email: "y@example.test", currency: "USD" }).returning());
    const [opp] = await withOrgTx(appDb(), orgId, (tx) => tx.insert(schema.expansionOpportunities).values({
      orgId, customerId: cust!.id, recommendedPriceId: "price_up", potentialMrrCents: 500, rationale: "usage", status: "new",
      draftStatus: "draft", draftSubject: "s", draftBody: "b"
    }).returning());
    expect((await expansionService.listOpportunities(ctx)).items.some((o) => o.id === opp!.id)).toBe(true);
    await expect(expansionService.applyOpportunityDraftAction(ctx, opp!.id, { type: "submit" }, {})).rejects.toMatchObject({ problem: { status: 402 } });
    await expect(expansionService.dismiss(ctx, opp!.id, {})).resolves.toEqual({ dismissed: true });
  });

  /* ------------------------------------------------------------ limits: seats */

  it("seat limit is atomic: 8 concurrent invites on a 1-seat plan with 0 remaining ⇒ all refused; on Revessent (5) exactly the remaining units succeed", async () => {
    const ctx = await ctxFor(admin, slug, "administer");
    const before = (await entitlementsService.getEntitlements(appDb(), orgId)).usage.seatsUsed; // 4 members
    const attempt = () => settingsService.invite(ctx, { email: `p7-${suffix()}@example.test`, role: "viewer" }, {})
      .then(() => "ok" as const, (e: { problem?: { status?: number } }) => e.problem?.status ?? "err");
    // Ember: 4 used ≥ 1 ⇒ every attempt is refused
    const ember = await Promise.all(Array.from({ length: 8 }, attempt));
    expect(ember.every((r) => r === 402)).toBe(true);
    expect((await entitlementsService.getEntitlements(appDb(), orgId)).usage.seatsUsed).toBe(before);
    expect((await audits(orgId, "entitlement.limit_reached")).length).toBeGreaterThanOrEqual(8);

    await setPlanForTests(orgId, "revessent", "active"); // 5 seats, 4 used ⇒ exactly ONE unit left
    try {
      const results = await Promise.all(Array.from({ length: 8 }, attempt));
      expect(results.filter((r) => r === "ok")).toHaveLength(1);
      expect(results.filter((r) => r === 402)).toHaveLength(7);
      const after = await entitlementsService.getEntitlements(appDb(), orgId);
      expect(after.usage.seatsUsed).toBe(5);
      expect(after.seatsRemaining).toBe(0);
      // and once more: the final unit cannot be consumed twice
      expect(await attempt()).toBe(402);
    } finally { await setPlanForTests(orgId, "ember", "trialing"); }
  });

  /* ------------------------------------------------------------ billing webhooks */

  describe("Stripe Billing webhook → billing state → entitlements (simulated, signed)", () => {
    let bOwner: TestUser; let bSlug = ""; let bOrg = ""; const subId = `sub_${suffix()}`; const cusId = `cus_${suffix()}`;
    beforeAll(async () => {
      bOwner = await createTestUser("bill-owner");
      const o = await createTestOrg(bOwner, "bill"); bSlug = o.slug; bOrg = o.orgId;
    });

    it("rejects unsigned / wrong-secret payloads (safe 400) and applies nothing", async () => {
      const e = subEvent({ subId, customerId: cusId, status: "active", metadataOrgId: bOrg });
      await expect(billingService.receiveBillingWebhook({ rawBody: e.payload, sigHeader: null })).rejects.toMatchObject({ problem: { status: 400 } });
      await expect(deliver(e.payload, "whsec_wrong_secret_0123456789")).rejects.toMatchObject({ problem: { status: 400 } });
      expect((await billingRow(bOrg)).stripeSubscriptionId).toBeNull();
    });

    it("first linkage via provider metadata (unlinked org only) ⇒ active Revessent; duplicate delivery converges without a second audit", async () => {
      const e = subEvent({ subId, customerId: cusId, status: "active", metadataOrgId: bOrg, type: "customer.subscription.created" });
      const r1 = await deliver(e.payload);
      expect(r1).toMatchObject({ received: true, duplicate: false, status: "processed" });
      const row = await billingRow(bOrg);
      expect(row).toMatchObject({ plan: "revessent", status: "active", stripeSubscriptionId: subId, stripeCustomerId: cusId, planSource: "stripe_billing", lastEventId: e.id });
      const ctx = await ctxFor(bOwner, bSlug, "own");
      expect(ctx.org.plan).toBe("revessent"); // display mirror updated under the 0023 policy
      expect((await entitlementsService.describe(ctx)).capabilities.ai_notes).toBe(true);
      expect((await settingsService.billing(ctx))).toMatchObject({ plan: "revessent", status: "active", billingProviderLive: true, restricted: false });

      const transitions = (await audits(bOrg, "billing.state_transitioned")).length;
      const r2 = await deliver(e.payload); // Stripe retry of the SAME event
      expect(r2).toMatchObject({ duplicate: true, status: "processed" });
      expect((await audits(bOrg, "billing.state_transitioned")).length).toBe(transitions);
      expect((await audits(bOrg, "entitlement.plan_changed")).length).toBe(1);
    });

    it("a forged event naming this org in metadata but a DIFFERENT subscription is skipped (already linked)", async () => {
      const e = subEvent({ subId: `sub_forged_${suffix()}`, customerId: `cus_forged_${suffix()}`, status: "active", lookupKey: "studio_monthly", metadataOrgId: bOrg });
      const r = await deliver(e.payload);
      expect(r.status).toBe("skipped"); expect(r.note).toBe("org_unresolved");
      expect((await billingRow(bOrg)).plan).toBe("revessent");
    });

    it("a forged event naming ANOTHER org id (unlinked) cannot move it to a paid plan through a subscription we later bind to someone else — and never touches the linked org", async () => {
      const other = await createTestOrg(await createTestUser("bill-other"), "billo");
      // attacker claims other org for the SAME subscription id as bOrg: stored ids win ⇒ routed to bOrg, then subscription matches ⇒ applied to bOrg only
      const e = subEvent({ subId, customerId: cusId, status: "active", metadataOrgId: other.orgId, createdOffsetSec: 1 });
      const r = await deliver(e.payload);
      expect(r.status).toBe("processed");
      expect((await billingRow(other.orgId))).toMatchObject({ plan: "ember", stripeSubscriptionId: null, planSource: "default" });
    });

    it("out-of-order delivery: an OLDER past_due event after a NEWER active one is skipped (state never regresses)", async () => {
      const stale = subEvent({ subId, customerId: cusId, status: "past_due", createdOffsetSec: -600 });
      const r = await deliver(stale.payload);
      expect(r).toMatchObject({ status: "skipped", note: "superseded_by_newer_event" });
      expect((await billingRow(bOrg)).status).toBe("active");
    });

    it("past_due ⇒ restricted to the Ember baseline immediately (no grace period); AI/autonomy/upgrade signals denied with reason subscription_past_due", async () => {
      const r = await deliver(subEvent({ subId, customerId: cusId, status: "past_due", createdOffsetSec: 2 }).payload);
      expect(r.status).toBe("processed");
      const ctx = await ctxFor(bOwner, bSlug, "own");
      const e = await entitlementsService.describe(ctx);
      expect(e).toMatchObject({ plan: "revessent", effectivePlan: "ember", restricted: true, state: "baseline" });
      expect(e.capabilities.ai_notes).toBe(false); expect(e.capabilities.smart_retries).toBe(true);
      const d = await entitlementsService.can(ctx.db, bOrg, "upgrade_signals");
      expect(d).toMatchObject({ allowed: false, reason: "subscription_past_due" });
      const changed = await audits(bOrg, "entitlement.changed");
      expect((changed.at(-1)!.diff as { lost: string[] }).lost).toEqual(expect.arrayContaining(["ai_notes", "trust_autonomy", "upgrade_signals"]));
    });

    it("concurrent deliveries of DIFFERENT events for the same subscription serialize; the newest wins and no event is lost", async () => {
      const a = subEvent({ subId, customerId: cusId, status: "active", createdOffsetSec: 3 });
      const b = subEvent({ subId, customerId: cusId, status: "active", lookupKey: "studio_monthly", createdOffsetSec: 4 });
      const c = subEvent({ subId, customerId: cusId, status: "trialing", createdOffsetSec: 3, id: a.id }); // exact duplicate id of `a` with different body
      const results = await Promise.all([deliver(a.payload), deliver(b.payload), deliver(a.payload), deliver(b.payload)]);
      expect(results.every((r) => r.status === "processed" || r.status === "skipped")).toBe(true);
      const row = await billingRow(bOrg);
      expect(row.plan).toBe("studio"); expect(row.status).toBe("active"); expect(row.lastEventId).toBe(b.id);
      const rows = await withOrgTx(appDb(), bOrg, (tx) => tx.select().from(schema.webhookEvents).where(and(eq(schema.webhookEvents.orgId, bOrg), eq(schema.webhookEvents.source, "stripe_billing"))));
      expect(rows.filter((r) => r.externalId === a.id)).toHaveLength(1);
      expect(rows.filter((r) => r.externalId === b.id)).toHaveLength(1);
      void c;
    });

    it("trial → active upgrade, cancel_at_period_end keeps entitlement until deleted, deletion ⇒ Ember/canceled", async () => {
      await deliver(subEvent({ subId, customerId: cusId, status: "trialing", lookupKey: "studio_monthly", createdOffsetSec: 5 }).payload);
      expect(await entitlementsService.can(appDb(), bOrg, "ai_notes")).toMatchObject({ allowed: true });
      await deliver(subEvent({ subId, customerId: cusId, status: "active", lookupKey: "studio_monthly", cancelAtPeriodEnd: true, createdOffsetSec: 6 }).payload);
      expect((await billingRow(bOrg)).cancelAtPeriodEnd).toBe(true);
      expect(await entitlementsService.can(appDb(), bOrg, "ai_notes")).toMatchObject({ allowed: true }); // still paid until the period ends
      const del = await deliver(subEvent({ type: "customer.subscription.deleted", subId, customerId: cusId, status: "canceled", createdOffsetSec: 7 }).payload);
      expect(del.status).toBe("processed");
      const row = await billingRow(bOrg);
      expect(row).toMatchObject({ plan: "ember", status: "canceled" });
      expect((await ctxFor(bOwner, bSlug, "own")).org.plan).toBe("ember");
      expect(await entitlementsService.can(appDb(), bOrg, "trust_autonomy")).toMatchObject({ allowed: false, reason: "capability_not_in_plan:ember" });
    });

    it("an unmapped price keeps the previous plan (never guesses), unknown Stripe status is stored verbatim as unknown ⇒ restricted", async () => {
      await deliver(subEvent({ subId, customerId: cusId, status: "active", lookupKey: "revessent_monthly", createdOffsetSec: 8 }).payload);
      await deliver(subEvent({ subId, customerId: cusId, status: "active", lookupKey: "mystery_price", createdOffsetSec: 9 }).payload);
      expect((await billingRow(bOrg)).plan).toBe("revessent");
      await deliver(subEvent({ subId, customerId: cusId, status: "brand_new_status", createdOffsetSec: 10 }).payload);
      const e = await entitlementsService.getEntitlements(appDb(), bOrg);
      expect(e.status).toBe("unknown"); expect(e.restricted).toBe(true); expect(e.reasons).toContain("unknown_billing_status");
    });

    it("unhandled event types and mode mismatches are acknowledged/rejected without touching state", async () => {
      const snapshot = await billingRow(bOrg);
      const other = { ...subEvent({ subId, customerId: cusId, status: "active", createdOffsetSec: 11 }).raw, type: "invoice.paid" };
      other.data.object.object = "invoice";
      expect((await deliver(JSON.stringify(other))).status).toBe("skipped");
      const live = { ...subEvent({ subId, customerId: cusId, status: "active", createdOffsetSec: 12 }).raw, livemode: true };
      await expect(deliver(JSON.stringify(live))).rejects.toMatchObject({ problem: { status: 400 } });
      expect((await billingRow(bOrg)).lastEventId).toBe(snapshot.lastEventId);
    });
  });

  /* ------------------------------------------------------------ AI / email */

  describe("communication under entitlements", () => {
    async function seedCase(org: string) {
      return withOrgTx(appDb(), org, async (tx) => {
        const [cust] = await tx.insert(schema.customers).values({ orgId: org, stripeCustomerId: `cus_${suffix()}`, name: "Zoe", email: `zoe-${suffix()}@example.test`, currency: "USD" }).returning();
        const [payment] = await tx.insert(schema.payments).values({ orgId: org, customerId: cust!.id, amountCents: 4900, currency: "USD", status: "failed", failedAt: new Date(), declineCode: "insufficient_funds" }).returning();
        const [c] = await tx.insert(schema.recoveryCases).values({ orgId: org, customerId: cust!.id, paymentId: payment!.id, status: "retrying", declineCode: "insufficient_funds", declineCategory: "insufficient_funds", amountCents: 4900, currency: "USD", firstFailedAt: new Date() }).returning();
        await tx.insert(schema.recoveryAttempts).values({ orgId: org, caseId: c!.id, kind: "auto_retry", status: "failed", attemptNo: 1, scheduledFor: new Date(), decisionReason: "t", policyVersion: 1 });
        return { caseId: c!.id, customerId: cust!.id };
      });
    }
    let cOwner: TestUser; let cSlug = ""; let cOrg = "";
    beforeAll(async () => {
      cOwner = await createTestUser("comm-ent");
      const o = await createTestOrg(cOwner, "cent"); cSlug = o.slug; cOrg = o.orgId;
      await withOrgTx(appDb(), cOrg, (tx) => tx.insert(schema.retryPolicies).values({ orgId: cOrg, version: 1, rules: { quietHoursStart: 0, quietHoursEnd: 0 }, createdBy: cOwner.id }));
      // trust_level 1 = the operator configured autonomy; Ember must still be approval-only
      const { createDb } = await import("@revessent/db");
      await createDb(process.env.SCHEDULER_DATABASE_URL!).update(schema.organizations).set({ trustLevel: 1 }).where(eq(schema.organizations.id, cOrg));
    });

    it("Ember: AI provider is NEVER called (templates only, fallback ai_not_entitled) and trust_level autonomy is ignored (awaiting_approval)", async () => {
      const ai = fakeAiProvider({ kind: "ok" });
      setAiProviderForTests(ai);
      const ctx = await ctxFor(cOwner, cSlug, "operate");
      const f = await seedCase(cOrg);
      const r = await communicationService.prepareCommunication(ctx, f.caseId, "retry_failed");
      expect(r.result).toBe("created");
      const [row] = await withOrgTx(appDb(), cOrg, (tx) => tx.select().from(schema.recoveryMessages).where(eq(schema.recoveryMessages.id, (r as { messageId: string }).messageId)));
      expect(row!.generationSource).toBe("fallback");
      expect(row!.fallbackReason).toBe("ai_not_entitled");
      expect(row!.aiGenerationId).toBeNull(); // not an AI failure: no ai_generations row, no budget consumed
      expect(row!.approvalStatus).toBe("awaiting_approval");
      expect(row!.autoApproved).toBe(false);
      expect(ai.calls).toHaveLength(0);
    });

    it("Revessent: AI + autonomy in force; after a downgrade an AUTO-approved pending message is HELD (not sent, not discarded); a human-approved one still sends; suppression still wins over everything", async () => {
      setAiProviderForTests(fakeAiProvider({ kind: "ok" }));
      const email = fakeEmailProvider({ kind: "ok" }); setEmailProviderForTests(email);
      await setPlanForTests(cOrg, "revessent", "active");
      const ctx = await ctxFor(cOwner, cSlug, "operate");
      const f1 = await seedCase(cOrg); const f2 = await seedCase(cOrg); const f3 = await seedCase(cOrg);
      const m1 = (await communicationService.prepareCommunication(ctx, f1.caseId, "retry_failed") as { messageId: string }).messageId;
      const m2 = (await communicationService.prepareCommunication(ctx, f2.caseId, "retry_failed") as { messageId: string }).messageId;
      const m3 = (await communicationService.prepareCommunication(ctx, f3.caseId, "retry_failed") as { messageId: string }).messageId;
      const rows = await withOrgTx(appDb(), cOrg, (tx) => tx.select().from(schema.recoveryMessages).where(eq(schema.recoveryMessages.caseId, f1.caseId)));
      expect(rows[0]!.generationSource).toBe("ai"); expect(rows[0]!.autoApproved).toBe(true); expect(rows[0]!.approvalStatus).toBe("approved");

      // downgrade (as a billing event would): auto-approval no longer entitled
      await setPlanForTests(cOrg, "ember", "trialing");
      const held = await communicationService.deliverCommunication(ctx, m1);
      expect(held.result).toBe("held_for_approval");
      const [r1] = await withOrgTx(appDb(), cOrg, (tx) => tx.select().from(schema.recoveryMessages).where(eq(schema.recoveryMessages.id, m1)));
      expect(r1!.approvalStatus).toBe("awaiting_approval"); expect(r1!.sendStatus).toBe("pending"); expect(r1!.autoApproved).toBe(false);
      expect(email.attempts).toHaveLength(0);
      expect((await communicationService.deliverCommunication(ctx, m1)).result).toBe("not_approved"); // stable: held once, then simply awaits a human

      // a human approves m2 (was auto-approved; re-approval by a person is a durable decision) ⇒ sends on Ember
      await withOrgTx(appDb(), cOrg, (tx) => tx.update(schema.recoveryMessages).set({ approvalStatus: "awaiting_approval", autoApproved: false }).where(eq(schema.recoveryMessages.id, m2)));
      await recoveryService.applyDraftAction(ctx, f2.caseId, m2, { type: "approve", actor: ctx.userId }, {});
      expect((await communicationService.deliverCommunication(ctx, m2)).result).toBe("sent");
      expect(email.attempts).toHaveLength(1);

      // m3: the customer unsubscribed after approval, then the org upgraded again — suppression wins regardless of plan
      await setPlanForTests(cOrg, "studio", "active");
      await suppressionService.suppressCustomer(appDb(), { orgId: cOrg, customerId: f3.customerId, reason: "customer_unsubscribed", source: "operator", actorId: cOwner.id });
      const r3 = await communicationService.deliverCommunication(ctx, m3);
      expect(r3).toMatchObject({ result: "suppressed", reason: "customer_unsubscribed" });
      expect(email.attempts).toHaveLength(1);
      await setPlanForTests(cOrg, "ember", "trialing");
    });
  });

  /* ------------------------------------------------------------ security */

  it("cross-org: a member of org A cannot read org B's entitlements or invite into it; no plan mutation surface exists for members", async () => {
    const other = await createTestOrg(await createTestUser("ent-b"), "entb");
    const { requireOrgRole } = await import("@revessent/server");
    const { signInCookie, headersWith } = await import("./helpers");
    const cookie = await signInCookie(owner.email, owner.password);
    await expect(requireOrgRole(headersWith(cookie), other.slug, "view")).rejects.toMatchObject({ problem: { status: 404 } });
    // the app role cannot write another org's billing row (RLS): zero rows affected
    const ctx = await ctxFor(owner, slug, "own");
    const updated = await withOrgTx(ctx.db, orgId, (tx) =>
      tx.update(schema.orgSubscriptions).set({ plan: "studio" }).where(eq(schema.orgSubscriptions.orgId, other.orgId)).returning());
    expect(updated).toHaveLength(0);
    expect((await billingRow(other.orgId)).plan).toBe("ember");
  });
});
