/**
 * Expansion service (§9.5 shape, honest about inputs). Draft approval mirrors
 * the recovery invariant. Provider execution/acceptance = later phases.
 */
import { and, desc, eq } from "drizzle-orm";
import * as schema from "@revessent/db";
import { withOrgTx, type Db } from "@revessent/db";
import { transition, type ApprovalStatus, type TransitionResult } from "@revessent/domain";
import type { Opportunity, DraftAction, Paged, MessageDraft } from "@revessent/contracts";
import { ProblemError } from "../http/problems.js";
import { audit } from "./audit.js";
import type { OrgContext } from "../context.js";

const DB_TO_UI: Record<string, Opportunity["status"]> = {
  new: "new", awaiting_approval: "awaiting_approval", approved: "approved",
  sent: "provider_pending", accepted: "confirmed", declined: "declined",
  expired: "expired", dismissed: "dismissed"
};

function draftFrom(opp: (typeof schema.expansionOpportunities)["$inferSelect"]): MessageDraft | null {
  if (opp.draftStatus === "none" || !opp.draftSubject) return null;
  const invalidated = opp.draftStatus === "invalidated";
  return {
    id: `${opp.id}:draft`,
    approvalStatus: invalidated ? "invalidated" : (opp.draftStatus as ApprovalStatus),
    subject: opp.draftSubject,
    body: opp.draftBody ?? "",
    providerRef: null, // upgrades are provider-confirmed in a later phase
    updatedAt: opp.updatedAt.toISOString(),
    approvedAt: opp.approvedAt?.toISOString() ?? null,
    approvedBy: opp.approvedBy ?? null
  };
}

export async function listOpportunities(ctx: OrgContext): Promise<Paged<Opportunity>> {
  const rows = await withOrgTx(ctx.db, ctx.org.id, (tx) =>
    tx.select({ opp: schema.expansionOpportunities, customer: schema.customers })
      .from(schema.expansionOpportunities)
      .innerJoin(schema.customers, eq(schema.expansionOpportunities.customerId, schema.customers.id))
      .where(eq(schema.expansionOpportunities.orgId, ctx.org.id))
      .orderBy(desc(schema.expansionOpportunities.createdAt)));
  return { items: rows.map((r) => toDto(r.opp, r.customer, ctx.org.slug)), nextCursor: null };
}

function toDto(
  opp: (typeof schema.expansionOpportunities)["$inferSelect"],
  customer: (typeof schema.customers)["$inferSelect"],
  orgSlug: string
): Opportunity {
  return {
    id: opp.id,
    orgSlug,
    customerName: customer.name ?? "Unknown",
    currentPlan: opp.currentPriceId ?? "Current plan",
    recommendedPlan: opp.recommendedPriceId,
    potentialMrr: { minor: opp.potentialMrrCents, currency: customer.currency ?? "USD" },
    signal: opp.signalId ? "usage_signal" : "manual",
    signalEvidence: opp.rationale,
    rationale: opp.rationale,
    status: DB_TO_UI[opp.status] ?? "new",
    draft: draftFrom(opp)
  };
}

export async function getOpportunity(ctx: OrgContext, id: string): Promise<Opportunity> {
  const rows = await withOrgTx(ctx.db, ctx.org.id, (tx) =>
    tx.select({ opp: schema.expansionOpportunities, customer: schema.customers })
      .from(schema.expansionOpportunities)
      .innerJoin(schema.customers, eq(schema.expansionOpportunities.customerId, schema.customers.id))
      .where(and(eq(schema.expansionOpportunities.orgId, ctx.org.id), eq(schema.expansionOpportunities.id, id))));
  const row = rows[0];
  if (!row) throw new ProblemError("not-found", "No such opportunity in this workspace.");
  return toDto(row.opp, row.customer, ctx.org.slug);
}

export async function applyOpportunityDraftAction(
  ctx: OrgContext, id: string, action: DraftAction,
  meta: { ip?: string | null; userAgent?: string | null }
): Promise<MessageDraft> {
  return withOrgTx(ctx.db, ctx.org.id, async (tx) => {
    const [opp] = await tx.select().from(schema.expansionOpportunities)
      .where(and(eq(schema.expansionOpportunities.id, id), eq(schema.expansionOpportunities.orgId, ctx.org.id)));
    if (!opp) throw new ProblemError("not-found", "No such opportunity in this workspace.");
    if (opp.draftStatus === "none" && action.type !== "edit") {
      throw new ProblemError("conflict", "No draft exists yet for this opportunity.");
    }
    const current: ApprovalStatus = opp.draftStatus === "none" ? "draft"
      : opp.draftStatus === "awaiting_approval" ? "awaiting_approval"
      : opp.draftStatus === "approved" ? "approved"
      : "invalidated";
    let result: TransitionResult;
    let invalidates = false;
    switch (action.type) {
      case "submit": result = transition(current, { type: "submit" }); break;
      case "approve": result = transition(current, { type: "approve", actor: ctx.userId }); break;
      case "cancel": result = transition(current, { type: "cancel", actor: ctx.userId }); break;
      case "edit":
        result = transition(current, { type: "edit", subject: action.subject, body: action.body });
        invalidates = current === "approved";
        break;
    }
    if (!result.ok) throw new ProblemError("conflict", result.reason);

    const next = result.status === "invalidated" ? "draft" : result.status;
    const dbStatus = next === "awaiting_approval" ? "awaiting_approval"
      : next === "approved" ? "approved"
      : next === "cancelled" ? "none"
      : next === "draft" && (invalidates || opp.draftStatus === "invalidated") ? "invalidated"
      : "draft";
    const patch: Partial<typeof schema.expansionOpportunities.$inferInsert> = { draftStatus: dbStatus, updatedAt: new Date() };
    if (action.type === "edit") { patch.draftSubject = action.subject; patch.draftBody = action.body; }
    if (invalidates) { patch.approvedBy = null; patch.approvedAt = null; }
    if (next === "approved") {
      patch.approvedBy = ctx.userId;
      patch.approvedAt = new Date();
      patch.status = "approved";
    }
    if (next === "awaiting_approval") patch.status = "awaiting_approval";
    if (next === "cancelled") patch.status = "new";

    const [updated] = await tx.update(schema.expansionOpportunities)
      .set(patch).where(eq(schema.expansionOpportunities.id, id)).returning();
    await tx.select().from(schema.customers).where(eq(schema.customers.id, updated!.customerId));

    await audit(tx as unknown as Db, {
      orgId: ctx.org.id, actorId: ctx.userId,
      action: `opportunity.draft.${action.type}${invalidates ? ".invalidates_approval" : ""}`,
      targetType: "expansion_opportunity", targetId: id,
      diff: { draftStatus: [opp.draftStatus, dbStatus] },
      ip: meta.ip, userAgent: meta.userAgent
    });

    return draftFrom(updated!) ?? {
      id: `${id}:draft`, approvalStatus: "draft", subject: patch.draftSubject ?? "",
      body: patch.draftBody ?? "", providerRef: null, updatedAt: updated!.updatedAt.toISOString(),
      approvedAt: null, approvedBy: null
    };
  });
}

export async function dismiss(ctx: OrgContext, id: string,
  meta: { ip?: string | null; userAgent?: string | null }): Promise<{ dismissed: true }> {
  return withOrgTx(ctx.db, ctx.org.id, async (tx) => {
    const [opp] = await tx.select().from(schema.expansionOpportunities)
      .where(and(eq(schema.expansionOpportunities.id, id), eq(schema.expansionOpportunities.orgId, ctx.org.id)));
    if (!opp) throw new ProblemError("not-found", "No such opportunity in this workspace.");
    await tx.update(schema.expansionOpportunities)
      .set({ status: "dismissed", updatedAt: new Date() }).where(eq(schema.expansionOpportunities.id, id));
    await audit(tx as unknown as Db, {
      orgId: ctx.org.id, actorId: ctx.userId, action: "opportunity.dismissed",
      targetType: "expansion_opportunity", targetId: id,
      diff: { status: [opp.status, "dismissed"] }, ip: meta.ip, userAgent: meta.userAgent
    });
    return { dismissed: true as const };
  });
}

/** Push a manual usage signal — admin only (§6.2), manual v1. */
export async function pushSignal(
  ctx: OrgContext, input: { customerId: string; kind: string; payload: Record<string, unknown> },
  meta: { ip?: string | null; userAgent?: string | null }
): Promise<{ id: string }> {
  return withOrgTx(ctx.db, ctx.org.id, async (tx) => {
    const [row] = await tx.insert(schema.expansionSignals).values({
      orgId: ctx.org.id, customerId: input.customerId, kind: input.kind, payload: input.payload
    }).returning();
    await audit(tx as unknown as Db, {
      orgId: ctx.org.id, actorId: ctx.userId, action: "signal.pushed",
      targetType: "expansion_signal", targetId: row!.id,
      diff: { kind: input.kind }, ip: meta.ip, userAgent: meta.userAgent
    });
    return { id: row!.id };
  });
}

export function unusedDb(_db: Db): void { /* keep import shape stable */ }
