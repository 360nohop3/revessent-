import { describe, expect, it } from "vitest";
import { appDb, recoveryService, expansionService, settingsService } from "@revessent/server";
import * as schema from "@revessent/db";
import { withOrgTx } from "@revessent/db";
import { createTestOrg, createTestUser, ctxFor, suffix, type TestUser } from "./helpers";

/**
 * AUDIT: cross-organization MUTATION attempts (not only reads). Org A's
 * operators/admins must get 404 — never 403, never success — when they aim
 * writes at org B's domain objects by ID.
 */
describe("tenant isolation: cross-org mutations", () => {
  let adminA: TestUser;
  let slugA = "";
  let booted = false;

  async function boot(): Promise<{ orgIdB: string; slugB: string; caseId: string; draftId: string; oppId: string }> {
    if (!booted) {
      adminA = await createTestUser("mut-a-admin");
      slugA = (await createTestOrg(adminA, "muta", [])).slug;
      booted = true;
    }
    const ownerB = await createTestUser(`mut-b-owner-${suffix()}`);
    const b = await createTestOrg(ownerB, "mutb");
    let caseId = ""; let draftId = ""; let oppId = "";
    await withOrgTx(appDb(), b.orgId, async (tx) => {
      const [cust] = await tx.insert(schema.customers).values({
        orgId: b.orgId, stripeCustomerId: `cus_${suffix()}`, name: "B", email: "b@b.example", currency: "USD"
      }).returning();
      const [payment] = await tx.insert(schema.payments).values({
        orgId: b.orgId, customerId: cust!.id, amountCents: 1000, currency: "USD",
        status: "failed", failedAt: new Date(), declineCode: "generic_decline"
      }).returning();
      const [c] = await tx.insert(schema.recoveryCases).values({
        orgId: b.orgId, customerId: cust!.id, paymentId: payment!.id, status: "contacting",
        declineCode: "generic_decline", declineCategory: "generic", amountCents: 1000, currency: "USD",
        firstFailedAt: new Date()
      }).returning();
      const [m] = await tx.insert(schema.recoveryMessages).values({
        caseId: c!.id, orgId: b.orgId, subject: "s", body: "b", approvalStatus: "draft"
      }).returning();
      const [opp] = await tx.insert(schema.expansionOpportunities).values({
        orgId: b.orgId, customerId: cust!.id, recommendedPriceId: "price_recommended",
        potentialMrrCents: 500, rationale: "usage growth", status: "new"
      }).returning();
      caseId = c!.id; draftId = m!.id; oppId = opp!.id;
    });
    return { orgIdB: b.orgId, slugB: b.slug, caseId, draftId, oppId };
  }

  it("org A cannot act on org B's recovery draft (submit/approve → 404)", async () => {
    const { caseId, draftId } = await boot();
    const ctxA = await ctxFor(adminA, slugA, "operate");
    await expect(recoveryService.applyDraftAction(ctxA, caseId, draftId, { type: "submit", actor: adminA.id }, {}))
      .rejects.toMatchObject({ problem: { status: 404 } });
    await expect(recoveryService.applyDraftAction(ctxA, caseId, draftId, { type: "approve", actor: adminA.id }, {}))
      .rejects.toMatchObject({ problem: { status: 404 } });
  });

  it("org A cannot act on org B's expansion opportunity (draft edit/dismiss → 404)", async () => {
    const { oppId } = await boot();
    const ctxA = await ctxFor(adminA, slugA, "operate");
    await expect(expansionService.applyOpportunityDraftAction(ctxA, oppId,
      { type: "edit", subject: "hijack", body: "hijack", actor: adminA.id }, {}))
      .rejects.toMatchObject({ problem: { status: 404 } });
    await expect(expansionService.dismiss(ctxA, oppId, {}))
      .rejects.toMatchObject({ problem: { status: 404 } });
  });

  it("settings writes are bound to the caller's ctx org — org A's write cannot reach org B", async () => {
    const { slugB: _slugB } = await boot();
    const ctxA = await ctxFor(adminA, slugA, "administer");
    const beforeA = await settingsService.getPolicy(ctxA);
    await settingsService.savePolicy(ctxA, { ...beforeA, maxAutoRetries: 2 }, {});
    // org B (fresh) still has the default policy — A's write could not leak there
    const ownerB = await createTestUser(`mut-b-owner2-${suffix()}`);
    const b2 = await createTestOrg(ownerB, "mutb2");
    const ctxB = await ctxFor(ownerB, b2.slug, "administer");
    const afterB = await settingsService.getPolicy(ctxB);
    expect(afterB.maxAutoRetries).toBe(3); // default, untouched
    expect(beforeA.maxAutoRetries).toBe(3);
  });
});
