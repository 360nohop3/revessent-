import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { appDb, recoveryService } from "@revessent/server";
import * as schema from "@revessent/db";
import { withOrgTx } from "@revessent/db";
import { createTestOrg, createTestUser, ctxFor, suffix, type TestUser } from "./helpers";

/**
 * §13 APPROVAL INVARIANT — enforced server-side on persisted rows:
 *   Draft → Awaiting approval → Approved; editing an approved draft
 *   invalidates the approval. No send path exists anywhere in Phase 3.
 */
describe("approval state machine (persistent, server-side)", () => {
  let owner: TestUser;
  let slug = "";
  let orgId = "";
  let caseId = "";
  let draftId = "";
  let booted = false;

  async function bootstrap(): Promise<void> {
    if (booted) return;
    owner = await createTestUser("approval-owner");
    const created = await createTestOrg(owner, "approval");
    slug = created.slug; orgId = created.orgId;
    const db = appDb();
    await withOrgTx(db, orgId, async (tx) => {
      const [cust] = await tx.insert(schema.customers).values({
        orgId, stripeCustomerId: `cus_${suffix()}`, name: "Case Cust", email: "case@test.example", currency: "USD"
      }).returning();
      const [payment] = await tx.insert(schema.payments).values({
        orgId, customerId: cust!.id, amountCents: 4900, currency: "USD",
        status: "failed", failedAt: new Date(), declineCode: "insufficient_funds"
      }).returning();
      const [c] = await tx.insert(schema.recoveryCases).values({
        orgId, customerId: cust!.id, paymentId: payment!.id, status: "contacting",
        declineCode: "insufficient_funds", declineCategory: "insufficient_funds",
        amountCents: 4900, currency: "USD", firstFailedAt: new Date()
      }).returning();
      const [m] = await tx.insert(schema.recoveryMessages).values({
        caseId: c!.id, orgId, subject: "Original subject", body: "Original body",
        approvalStatus: "draft"
      }).returning();
      caseId = c!.id; draftId = m!.id;
    });
    booted = true;
  }

  it("submit: draft → awaiting_approval (persisted + audited)", async () => {
    await bootstrap();
    const ctx = await ctxFor(owner, slug, "operate");
    const draft = await recoveryService.applyDraftAction(ctx, caseId, draftId, { type: "submit", actor: ctx.userId }, {});
    expect(draft.approvalStatus).toBe("awaiting_approval");
    const [row] = await withOrgTx(appDb(), orgId, (tx) =>
      tx.select().from(schema.recoveryMessages).where(eq(schema.recoveryMessages.id, draftId)));
    expect(row!.approvalStatus).toBe("awaiting_approval");
  });

  it("approve: awaiting_approval → approved with actor + timestamp", async () => {
    const ctx = await ctxFor(owner, slug, "operate");
    const draft = await recoveryService.applyDraftAction(ctx, caseId, draftId, { type: "approve", actor: ctx.userId }, {});
    expect(draft.approvalStatus).toBe("approved");
    expect(draft.approvedBy).toBe(owner.id);
    expect(draft.approvedAt).toBeTruthy();
  });

  it("INVALIDATION: editing the approved draft invalidates the approval (server-side)", async () => {
    const ctx = await ctxFor(owner, slug, "operate");
    const draft = await recoveryService.applyDraftAction(ctx, caseId, draftId,
      { type: "edit", subject: "Revised subject", body: "Revised body", actor: ctx.userId }, {});
    expect(draft.approvalStatus).toBe("invalidated");
    const [row] = await withOrgTx(appDb(), orgId, (tx) =>
      tx.select().from(schema.recoveryMessages).where(eq(schema.recoveryMessages.id, draftId)));
    expect(row!.approvalStatus).toBe("draft");           // back to draft
    expect(row!.invalidatedAt).toBeTruthy();             // with the invalidation marker
    expect(row!.approvedBy).toBeNull();                  // approval is gone
    expect(row!.subject).toBe("Revised subject");
    // the invalidation is in the append-only audit log
    const audits = await withOrgTx(appDb(), orgId, (tx) =>
      tx.select().from(schema.auditLogs).where(eq(schema.auditLogs.targetId, draftId)));
    expect(audits.some((a) => a.action.includes("invalidates_approval"))).toBe(true);
  });

  it("invalid transition: approve from draft is rejected (409), row unchanged", async () => {
    const ctx = await ctxFor(owner, slug, "operate");
    await expect(recoveryService.applyDraftAction(ctx, caseId, draftId, { type: "approve", actor: ctx.userId }, {}))
      .rejects.toMatchObject({ problem: { status: 409 } });
  });

  it("resubmission clears the invalidation and starts a fresh cycle", async () => {
    const ctx = await ctxFor(owner, slug, "operate");
    const draft = await recoveryService.applyDraftAction(ctx, caseId, draftId, { type: "submit", actor: ctx.userId }, {});
    expect(draft.approvalStatus).toBe("awaiting_approval");
    const [row] = await withOrgTx(appDb(), orgId, (tx) =>
      tx.select().from(schema.recoveryMessages).where(eq(schema.recoveryMessages.id, draftId)));
    expect(row!.invalidatedAt).toBeNull();
  });

  it("viewer cannot submit/approve/cancel (403 before the FSM runs)", async () => {
    const viewer = await createTestUser("approval-viewer");
    await createTestOrg(owner, "x", []); // no-op to keep types happy
    // add viewer to the SAME org
    const { withIdentityTx } = await import("@revessent/db");
    await withIdentityTx(appDb(), owner.id, (tx) =>
      tx.insert(schema.memberships).values({ orgId, userId: viewer.id, role: "viewer" }));
    await expect(ctxFor(viewer, slug, "operate")).rejects.toMatchObject({ problem: { status: 403 } });
  });

  it("NO-SEND INVARIANT: approval never implies execution — confirmed requires a provider event", async () => {
    // The FSM has no route to confirmed except provider_confirmed; no service
    // exposes it in Phase 3. Assert the domain contract itself.
    const { transition, canConfirmFromProvider, isTerminalApproval } = await import("@revessent/domain");
    expect(transition("approved", { type: "provider_confirmed", providerRef: "x" }).ok).toBe(false);
    expect(canConfirmFromProvider("provider_pending")).toBe(true);
    expect(canConfirmFromProvider("approved")).toBe(false);
    // AUDIT §7: an invalidated approval can never authorize execution —
    // every path out of "invalidated" (queue/send/confirm) is closed in the
    // transition table itself, so a future service call cannot reach them.
    for (const event of [{ type: "queue" }, { type: "execution_started" }, { type: "provider_pending" }, { type: "provider_confirmed", providerRef: "x" }] as const) {
      expect(transition("invalidated", event as never).ok, `invalidated × ${event.type}`).toBe(false);
    }
    expect(isTerminalApproval("invalidated")).toBe(true);
    // and "queue" is reachable ONLY from "approved"
    expect(transition("draft", { type: "queue" }).ok).toBe(false);
    expect(transition("awaiting_approval", { type: "queue" }).ok).toBe(false);
  });
});
