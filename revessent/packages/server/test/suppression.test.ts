/**
 * Phase 6 safety fix — authoritative communication suppression.
 *   • unsubscribe persists via the /c/{token} mechanism only (idempotent,
 *     unknown/expired/forged tokens do nothing, cross-org impossible)
 *   • preparation refuses suppressed customers without touching AI
 *   • delivery re-reads suppression AFTER the claim and BEFORE the provider:
 *     zero provider calls, pending→sending→suppressed, audited, never resent
 *   • unsubscribe racing a send can never produce a send after the
 *     authoritative state is observed
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { appDb, checkoutService, communicationService, recoveryService, suppressionService } from "@revessent/server";
import * as schema from "@revessent/db";
import { withOrgTx } from "@revessent/db";
import { setEmailProviderForTests, resetEmailProvider } from "@revessent/integrations";
import { fakeEmailProvider } from "@revessent/integrations/email-fixtures";
import { setAiProviderForTests, resetAiProvider } from "@revessent/ai";
import { fakeAiProvider } from "@revessent/ai/fakes";
import * as unsubscribeRoute from "@/app/api/v1/unsubscribe/[token]/route";
import { createTestOrg, createTestUser, ctxFor, suffix, type TestUser } from "./helpers";

const BASE = "http://localhost:3000";
type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
function postUnsubscribe(token: string): Promise<Response> {
  const req = new Request(new URL(`/api/v1/unsubscribe/${encodeURIComponent(token)}`, BASE), { method: "POST" });
  return (unsubscribeRoute.POST as Handler)(req, { params: Promise.resolve({ token }) });
}

interface Fixture { caseId: string; customerId: string; paymentId: string }
async function seedCase(orgId: string): Promise<Fixture> {
  return withOrgTx(appDb(), orgId, async (tx) => {
    const [cust] = await tx.insert(schema.customers).values({ orgId, stripeCustomerId: `cus_${suffix()}`, name: "Sup Pressed", email: `sup-${suffix()}@example.test`, currency: "USD" }).returning();
    const [payment] = await tx.insert(schema.payments).values({ orgId, customerId: cust!.id, amountCents: 2500, currency: "USD", status: "failed", failedAt: new Date(), declineCode: "insufficient_funds" }).returning();
    const [c] = await tx.insert(schema.recoveryCases).values({
      orgId, customerId: cust!.id, paymentId: payment!.id, status: "retrying", declineCode: "insufficient_funds", declineCategory: "insufficient_funds",
      amountCents: 2500, currency: "USD", firstFailedAt: new Date()
    }).returning();
    await tx.insert(schema.recoveryAttempts).values({ orgId, caseId: c!.id, kind: "auto_retry", status: "failed", attemptNo: 1, scheduledFor: new Date(), decisionReason: "t", policyVersion: 1 });
    return { caseId: c!.id, customerId: cust!.id, paymentId: payment!.id };
  });
}
async function suppressions(orgId: string, customerId: string) {
  return withOrgTx(appDb(), orgId, (tx) => tx.select().from(schema.communicationSuppressions).where(eq(schema.communicationSuppressions.customerId, customerId)));
}
async function messageRow(orgId: string, id: string) {
  const [m] = await withOrgTx(appDb(), orgId, (tx) => tx.select().from(schema.recoveryMessages).where(eq(schema.recoveryMessages.id, id)));
  return m!;
}
async function audits(orgId: string, targetId: string, action: string) {
  return withOrgTx(appDb(), orgId, (tx) => tx.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.targetId, targetId), eq(schema.auditLogs.action, action))));
}

describe("communication suppression (authoritative opt-out)", () => {
  let owner: TestUser; let slug = ""; let orgId = "";
  beforeAll(async () => {
    owner = await createTestUser("sup-owner");
    const o = await createTestOrg(owner, "sup"); slug = o.slug; orgId = o.orgId;
    // deterministic timing: quiet hours disabled so send-time verdicts never depend on the wall-clock hour
    await withOrgTx(appDb(), orgId, (tx) => tx.insert(schema.retryPolicies).values({ orgId, version: 1, rules: { quietHoursStart: 0, quietHoursEnd: 0 }, createdBy: owner.id }));
  });
  afterEach(() => { resetEmailProvider(); resetAiProvider(); });

  async function approved(ctx: Awaited<ReturnType<typeof ctxFor>>, f: Fixture): Promise<string> {
    const p = await communicationService.prepareCommunication(ctx, f.caseId, "retry_failed");
    expect(p.result).toBe("created");
    const id = (p as { messageId: string }).messageId;
    await recoveryService.applyDraftAction(ctx, f.caseId, id, { type: "approve", actor: ctx.userId }, {});
    return id;
  }

  describe("unsubscribe persistence", () => {
    it("valid token persists suppression for exactly that customer; repeat is idempotent; audited", async () => {
      const ctx = await ctxFor(owner, slug, "operate");
      const f = await seedCase(orgId);
      const { token } = await checkoutService.createCheckoutLink(ctx, f.caseId, {});
      const r1 = await postUnsubscribe(token);
      expect(r1.status).toBe(200);
      expect(await r1.json()).toEqual({ state: "done" });
      const rows1 = await suppressions(orgId, f.customerId);
      expect(rows1).toHaveLength(1);
      expect(rows1[0]).toMatchObject({ orgId, channel: "email", reason: "customer_unsubscribed", source: "unsubscribe_token", sourceRef: f.caseId });
      const r2 = await postUnsubscribe(token);
      expect(await r2.json()).toEqual({ state: "done" });
      expect(await suppressions(orgId, f.customerId)).toHaveLength(1);
      const a = await audits(orgId, f.customerId, "communication.customer_suppressed");
      expect(a).toHaveLength(1); // one durable event, not one per click
      expect(JSON.stringify(a[0]!.diff)).not.toMatch(/@/); // no PII
    });

    it("invalid, malformed, expired and disabled (rotated) tokens do nothing", async () => {
      const ctx = await ctxFor(owner, slug, "operate");
      const f = await seedCase(orgId);
      expect(await (await postUnsubscribe("no-such-token-xyz")).json()).toEqual({ state: "unknown" });
      expect(await (await postUnsubscribe("bad token!")).json()).toEqual({ state: "unknown" });
      const { token: old } = await checkoutService.createCheckoutLink(ctx, f.caseId, {});
      await checkoutService.createCheckoutLink(ctx, f.caseId, {}); // rotates ⇒ `old` disabled
      expect(await (await postUnsubscribe(old)).json()).toEqual({ state: "unknown" });
      const { token: fresh } = await checkoutService.createCheckoutLink(ctx, f.caseId, {});
      await withOrgTx(appDb(), orgId, (tx) => tx.update(schema.recoveryCheckouts).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.recoveryCheckouts.caseId, f.caseId)));
      expect(await (await postUnsubscribe(fresh)).json()).toEqual({ state: "unknown" });
      expect(await suppressions(orgId, f.customerId)).toHaveLength(0);
    });

    it("TENANT: a token from org A cannot suppress anyone in org B; customer A's token cannot suppress customer B", async () => {
      const ctx = await ctxFor(owner, slug, "operate");
      const a = await seedCase(orgId);
      const b = await seedCase(orgId);
      const other = await createTestUser("sup-other");
      const o2 = await createTestOrg(other, "sup2");
      const ctx2 = await ctxFor(other, o2.slug, "operate");
      const c2 = await seedCase(o2.orgId);
      const { token: tokenA } = await checkoutService.createCheckoutLink(ctx, a.caseId, {});
      const { token: token2 } = await checkoutService.createCheckoutLink(ctx2, c2.caseId, {});
      expect(await (await postUnsubscribe(tokenA)).json()).toEqual({ state: "done" });
      expect(await (await postUnsubscribe(token2)).json()).toEqual({ state: "done" });
      expect(await suppressions(orgId, a.customerId)).toHaveLength(1);
      expect(await suppressions(orgId, b.customerId)).toHaveLength(0);
      expect(await suppressions(o2.orgId, c2.customerId)).toHaveLength(1);
      // org A's scope cannot see org B's suppression row and vice versa (RLS)
      const leaked = await withOrgTx(appDb(), orgId, (tx) => tx.select().from(schema.communicationSuppressions).where(eq(schema.communicationSuppressions.customerId, c2.customerId)));
      expect(leaked).toHaveLength(0);
      // org B cannot forge a suppression for org A's customer
      await expect(withOrgTx(appDb(), o2.orgId, (tx) => tx.insert(schema.communicationSuppressions).values({
        orgId, customerId: b.customerId, reason: "operator", source: "operator"
      }))).rejects.toThrow();
      // and the app role cannot reverse an opt-out
      await expect(withOrgTx(appDb(), orgId, (tx) => tx.delete(schema.communicationSuppressions).where(eq(schema.communicationSuppressions.customerId, a.customerId)))).rejects.toThrow();
      expect(await suppressions(orgId, a.customerId)).toHaveLength(1);
    });
  });

  describe("preparation", () => {
    it("suppressed customer ⇒ no communication row and no AI call", async () => {
      const ai = fakeAiProvider({ kind: "ok" });
      setAiProviderForTests(ai);
      const ctx = await ctxFor(owner, slug, "operate");
      const f = await seedCase(orgId);
      const { token } = await checkoutService.createCheckoutLink(ctx, f.caseId, {});
      await postUnsubscribe(token);
      const r = await communicationService.prepareCommunication(ctx, f.caseId, "retry_failed");
      expect(r).toEqual({ result: "not_allowed", reason: "customer_unsubscribed" });
      expect(ai.calls).toHaveLength(0);
      const msgs = await withOrgTx(appDb(), orgId, (tx) => tx.select().from(schema.recoveryMessages).where(eq(schema.recoveryMessages.caseId, f.caseId)));
      expect(msgs).toHaveLength(0);
      expect(await audits(orgId, f.caseId, "communication.not_allowed")).toHaveLength(1);
      // discovery no longer surfaces the case
      const cands = await communicationService.findCommunicationCandidates(appDb(), orgId, 500);
      expect(cands.some((c) => c.caseId === f.caseId)).toBe(false);
    });
  });

  describe("send", () => {
    it("unsubscribe AFTER preparation and AFTER approval ⇒ suppressed at delivery; zero provider calls; audited; not resent", async () => {
      setAiProviderForTests(null);
      const email = fakeEmailProvider({ kind: "ok" });
      setEmailProviderForTests(email);
      const ctx = await ctxFor(owner, slug, "operate");

      // after preparation (before approval)
      const f1 = await seedCase(orgId);
      const p1 = await communicationService.prepareCommunication(ctx, f1.caseId, "retry_failed");
      const id1 = (p1 as { messageId: string }).messageId;
      const { token: t1 } = await checkoutService.createCheckoutLink(ctx, f1.caseId, {});
      await postUnsubscribe(t1);
      await recoveryService.applyDraftAction(ctx, f1.caseId, id1, { type: "approve", actor: ctx.userId }, {});
      expect(await communicationService.deliverCommunication(ctx, id1)).toEqual({ result: "suppressed", messageId: id1, reason: "customer_unsubscribed" });

      // after approval
      const f2 = await seedCase(orgId);
      const id2 = await approved(ctx, f2);
      const { token: t2 } = await checkoutService.createCheckoutLink(ctx, f2.caseId, {});
      await postUnsubscribe(t2);
      expect(await communicationService.deliverCommunication(ctx, id2)).toEqual({ result: "suppressed", messageId: id2, reason: "customer_unsubscribed" });

      expect(email.attempts).toHaveLength(0);
      for (const id of [id1, id2]) {
        const row = await messageRow(orgId, id);
        expect(row.sendStatus).toBe("suppressed");
        expect(row.approvalStatus).toBe("suppressed");
        expect(row.suppressedReason).toBe("customer_unsubscribed");
        expect(row.sentAt).toBeNull();
        expect(row.providerMessageId).toBeNull();
        const a = await audits(orgId, id, "communication.suppressed");
        expect(a).toHaveLength(1);
        expect(a[0]!.diff).toEqual({ reason: "customer_unsubscribed" });
        // duplicate delivery: still nothing
        expect((await communicationService.deliverCommunication(ctx, id)).result).toBe("claimed_elsewhere");
      }
      expect(email.attempts).toHaveLength(0);
      // not rediscovered as due
      const due = await communicationService.findDueSends(appDb(), orgId, 500, new Date(Date.now() + 864e5));
      expect(due.some((d) => d.messageId === id1 || d.messageId === id2)).toBe(false);
    });

    it("the send-time check wins even when the prepare precheck was bypassed (row created before suppression)", async () => {
      setAiProviderForTests(null);
      const email = fakeEmailProvider({ kind: "ok" });
      setEmailProviderForTests(email);
      const ctx = await ctxFor(owner, slug, "operate");
      const f = await seedCase(orgId);
      const id = await approved(ctx, f);
      // direct durable write (e.g. operator/system source) — no token involved
      await suppressionService.suppressCustomer(appDb(), { orgId, customerId: f.customerId, reason: "operator", source: "operator", actorId: owner.id, actorKind: "user" });
      expect((await communicationService.deliverCommunication(ctx, id)).result).toBe("suppressed");
      expect(email.attempts).toHaveLength(0);
    });
  });

  describe("concurrency", () => {
    it("RACE: many concurrent deliveries vs. an unsubscribe — never a send after suppression is observed; at most one provider call overall", async () => {
      setAiProviderForTests(null);
      const ctx = await ctxFor(owner, slug, "operate");
      let sentAfterSuppression = 0;
      for (let round = 0; round < 6; round++) {
        const email = fakeEmailProvider({ kind: "ok" });
        setEmailProviderForTests(email);
        const f = await seedCase(orgId);
        const id = await approved(ctx, f);
        const { token } = await checkoutService.createCheckoutLink(ctx, f.caseId, {});
        const unsub = new Promise<void>((resolve) => setTimeout(() => { void postUnsubscribe(token).then(() => resolve()); }, round * 3));
        const deliveries = Promise.all(Array.from({ length: 4 }, () => communicationService.deliverCommunication(ctx, id)));
        const [results] = await Promise.all([deliveries, unsub]);
        const sent = results.filter((r) => r.result === "sent").length;
        const suppressed = results.filter((r) => r.result === "suppressed").length;
        expect(sent + suppressed).toBeLessThanOrEqual(1);          // one claimant decides
        expect(email.attempts.length).toBe(sent);                   // provider called only for a real send
        const row = await messageRow(orgId, id);
        expect(["sent", "suppressed"]).toContain(row.sendStatus);
        // Invariant: if the suppression row existed before the claim decision, the message is suppressed.
        const [sup] = await suppressions(orgId, f.customerId);
        if (row.sendStatus === "sent" && sup && sup.createdAt.getTime() < row.sendClaimedAt!.getTime()) sentAfterSuppression += 1;
        // Post-race: any further delivery is a no-op either way.
        expect(["already_sent", "claimed_elsewhere"]).toContain((await communicationService.deliverCommunication(ctx, id)).result);
        expect(email.attempts.length).toBe(sent);
      }
      expect(sentAfterSuppression).toBe(0);
    });
  });
});
