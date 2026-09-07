/**
 * Recovery domain service — the server-side approval authority (brief §12/§13).
 * All state transitions go through packages/domain's FSM; the database row is
 * the truth; every transition writes an audit row. NO send path exists in
 * Phase 3 — approval never implies execution (§5.3 #3 invariant is structural:
 * there is no code that sends).
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import {
  evaluateRetryEligibility, type RetryFacts,
  type AutoRetryPolicy, type RetryDecision
} from "@revessent/domain";
import * as schema from "@revessent/db";
import { withOrgTx, type Db } from "@revessent/db";
import { transition, outreachSafe, type ApprovalStatus, type TransitionResult } from "@revessent/domain";
import type { RecoveryCase, MessageDraft, TimelineEntry, CaseFilters, DraftAction, Paged } from "@revessent/contracts";
import { ProblemError } from "../http/problems.js";
import { audit } from "./audit.js";
import { AiCopySchema, validateCopy } from "@revessent/ai";
import type { OrgContext } from "../context.js";

const CATEGORY_BY_CODE: Record<string, string> = {
  insufficient_funds: "insufficient_funds", expired_card: "expired_card",
  processing_error: "transient", do_not_honor: "issuer_decline",
  incorrect_cvc: "credential", invalid_account: "hard", lost_card: "hard",
  stolen_card: "hard", generic_decline: "issuer_decline", authentication_required: "credential",
  insufficient_funds_retry: "insufficient_funds"
};

function categoryOf(declineCode: string): string {
  return CATEGORY_BY_CODE[declineCode] ?? "issuer_decline";
}

/** FSM status for a persisted message row. */
function fsmStatus(m: typeof schema.recoveryMessages.$inferSelect): ApprovalStatus {
  if (m.approvalStatus === "draft" && m.invalidatedAt) return "invalidated";
  return m.approvalStatus as ApprovalStatus;
}

function draftDto(m: typeof schema.recoveryMessages.$inferSelect): MessageDraft {
  return {
    id: m.id,
    approvalStatus: fsmStatus(m),
    subject: m.subject,
    body: m.body,
    providerRef: m.providerMessageId, // null until a provider confirms — never fabricated
    updatedAt: m.createdAt.toISOString(),
    approvedAt: m.approvedAt?.toISOString() ?? null,
    approvedBy: m.approvedBy ?? null
  };
}

interface CaseRow {
  case: typeof schema.recoveryCases.$inferSelect;
  customer: typeof schema.customers.$inferSelect;
  payment: typeof schema.payments.$inferSelect;
  message: (typeof schema.recoveryMessages)["$inferSelect"] | null;
  interval: "month" | "year" | "unsupported";
}

async function loadCases(db: Db, orgId: string): Promise<CaseRow[]> {
  // Org scope MUST be set for these reads (RLS org_isolation on every table
  // here) — raw pool selects return zero rows under the revessent_app role.
  return withOrgTx(db, orgId, async (tx) => {
    const rows = await tx
      .select({ case: schema.recoveryCases, customer: schema.customers, payment: schema.payments })
      .from(schema.recoveryCases)
      .innerJoin(schema.customers, eq(schema.recoveryCases.customerId, schema.customers.id))
      .innerJoin(schema.payments, eq(schema.recoveryCases.paymentId, schema.payments.id))
      .where(eq(schema.recoveryCases.orgId, orgId))
      .orderBy(desc(schema.recoveryCases.firstFailedAt));
    const ids = rows.map((r) => r.case.id);
    const messages = ids.length
      ? await tx.select().from(schema.recoveryMessages).where(and(
          eq(schema.recoveryMessages.orgId, orgId),
          inArray(schema.recoveryMessages.caseId, ids)))
      : [];
    const byCase = new Map(messages.map((m) => [m.caseId, m]));
    const subs = await tx.select().from(schema.subscriptions).where(eq(schema.subscriptions.orgId, orgId));
    const intervalBySub = new Map(subs.map((s) => [s.id, s.interval as "month" | "year" | "unsupported"]));
    return rows.map((r) => ({
      case: r.case,
      customer: r.customer,
      payment: r.payment,
      message: byCase.get(r.case.id) ?? null,
      // Cadence is provider-derived, NEVER invented (final audit): the linked
      // subscription's verbatim interval; "unsupported" when no subscription
      // backs the case or its cadence is outside the supported model.
      interval: (r.payment.subscriptionId ? intervalBySub.get(r.payment.subscriptionId) : undefined) ?? "unsupported"
    }));
  });
}

type ExecAttemptRow = (typeof schema.recoveryAttempts)["$inferSelect"];

/** Phase 4D §23: the minimal automated-retry information for a case DTO,
 *  computed by the PURE eligibility function over local records — no
 *  provider I/O, no UI text. */
function retryStateOf(
  row: CaseRow, execAttempts: ExecAttemptRow[],
  policy: { maxAutoRetries: number; minGapHours: number; autoRetry: AutoRetryPolicy },
  connectionActive: boolean, customerMapped: boolean
): RetryDecision & { autoAttempts: number; maxAutoRetries: number; reconciliationRequired: boolean } {
  // Automated-sequence facts only (final correction §5/§7): manual attempts
  // never consume the automated category budget or the global auto count.
  const executed = execAttempts.filter((a) => a.status !== "scheduled");
  const executedAuto = executed.filter((a) => a.kind === "auto_retry");
  const categoryAttemptCounts: Record<string, number> = {};
  for (const a of executedAuto) {
    // Resolution codes (no_provider_operation) never occupy a policy bucket.
    if (a.outcomeCategory && a.outcomeCategory !== "no_provider_operation") {
      categoryAttemptCounts[a.outcomeCategory] = (categoryAttemptCounts[a.outcomeCategory] ?? 0) + 1;
    }
  }
  const lastExecuted = executed
    .filter((a) => ["succeeded", "failed", "unknown", "skipped"].includes(a.status))
    .sort((a, b) => (b.executedAt ?? b.createdAt).getTime() - (a.executedAt ?? a.createdAt).getTime())[0];
  const facts: RetryFacts = {
    caseStatus: row.case.status,
    paymentStatus: row.payment.status,
    connectionActive,
    hasStripeInvoice: Boolean(row.payment.stripeInvoiceId),
    amountValid: typeof row.payment.amountCents === "number" && Number.isInteger(row.payment.amountCents) && row.payment.amountCents > 0,
    currencyValid: /^[A-Z]{3}$/.test(row.payment.currency ?? ""),
    customerMapped,
    autoRetryCount: executedAuto.length,
    categoryAttemptCounts,
    // Routing category: latest executed attempt's payment-outcome category;
    // before any automated attempt — or when the last resolved as
    // no_provider_operation (execution-resolution code, NOT a payment
    // outcome; 4C: "a NEW execution is now provably safe") — the case's own
    // decline category routes (fail-closed, final correction §6).
    lastOutcome: (() => {
      const executedCategory = lastExecuted?.outcomeCategory ?? null;
      const routingCategory = executedCategory && executedCategory !== "no_provider_operation"
        ? executedCategory
        : row.case.declineCategory ?? null;
      return routingCategory ? { category: routingCategory } : null;
    })(),
    hasUnresolvedExecution: execAttempts.some((a) => a.status === "executing" || a.status === "unknown"),
    hasScheduledAutoAttempt: execAttempts.some((a) => a.kind === "auto_retry" && a.status === "scheduled"),
    lastExecutedAt: lastExecuted ? (lastExecuted.executedAt ?? lastExecuted.createdAt) : null,
    firstFailedAt: row.case.firstFailedAt,
    now: new Date()
  };
  const d = evaluateRetryEligibility(facts, policy);
  return {
    verdict: d.verdict, reason: d.reason, nextEligibleAt: d.nextEligibleAt,
    autoAttempts: facts.autoRetryCount, maxAutoRetries: policy.maxAutoRetries,
    reconciliationRequired: facts.hasUnresolvedExecution
  };
}

function caseDto(
  row: CaseRow, orgSlug: string, attempts: (typeof schema.paymentAttempts)["$inferSelect"][],
  retryState?: { autoAttempts: number; maxAutoRetries: number; verdict: string; reason: string; nextEligibleAt: Date | null; reconciliationRequired: boolean }
): RecoveryCase {
  const c = row.case;
  const category = categoryOf(c.declineCode) as RecoveryCase["category"];
  return {
    id: c.id,
    orgSlug,
    customerName: row.customer.name ?? "Unknown",
    customerEmail: row.customer.email ?? "",
    amount: { minor: c.amountCents, currency: c.currency },
    interval: row.interval,
    status: c.status,
    declineCode: c.declineCode,
    category,
    outreachSafe: outreachSafe(category as never),
    nextActionAt: c.nextActionAt?.toISOString() ?? null,
    createdAt: c.createdAt.toISOString(),
    evidence: {
      declineCode: c.declineCode,
      category,
      attempts: attempts.map((a) => ({
        at: a.attemptedAt.toISOString(),
        source: a.source as "stripe_default" | "revessent_retry" | "checkout" | "member",
        outcome: a.outcome as "succeeded" | "failed",
        declineCode: a.declineCode ?? null
      }))
    },
    draft: row.message ? draftDto(row.message) : null,
    retry: retryState
      ? {
          autoAttempts: retryState.autoAttempts,
          maxAutoRetries: retryState.maxAutoRetries,
          state: retryState.verdict as RecoveryCase["retry"]["state"],
          reason: retryState.reason,
          nextEligibleAt: retryState.nextEligibleAt?.toISOString() ?? null,
          reconciliationRequired: retryState.reconciliationRequired
        }
      : // list view: default to the conservative blocked view when the
        // caller has not supplied the attempt facts (never a fake "eligible")
        { autoAttempts: 0, maxAutoRetries: 0, state: "blocked", reason: "state_not_computed", nextEligibleAt: null, reconciliationRequired: false }
  };
}

/** Resolve the automated-retry state for a case row from local records. */
async function retryStateForList(ctx: OrgContext, row: CaseRow) {
  const { resolvePolicy } = await import("./retry.js");
  const [execAttempts, [conn], [customer], policy] = await Promise.all([
    withOrgTx(ctx.db, ctx.org.id, (tx) =>
      tx.select().from(schema.recoveryAttempts).where(eq(schema.recoveryAttempts.caseId, row.case.id))),
    withOrgTx(ctx.db, ctx.org.id, (tx) =>
      tx.select().from(schema.stripeConnections)
        .where(and(eq(schema.stripeConnections.orgId, ctx.org.id), eq(schema.stripeConnections.status, "active")))
        .orderBy(desc(schema.stripeConnections.createdAt)).limit(1)),
    withOrgTx(ctx.db, ctx.org.id, (tx) =>
      tx.select().from(schema.customers).where(eq(schema.customers.id, row.payment.customerId))),
    resolvePolicy(ctx.db, ctx.org.id, row.case.retryPolicyVersion)
  ]);
  return retryStateOf(row, execAttempts, policy, Boolean(conn), Boolean(customer?.stripeCustomerId));
}

export async function listCases(ctx: OrgContext, filters: CaseFilters): Promise<Paged<RecoveryCase>> {
  const rows = await loadCases(ctx.db, ctx.org.id);
  let dtos = [] as RecoveryCase[];
  for (const r of rows) dtos.push(caseDto(r, ctx.org.slug, [], await retryStateForList(ctx, r)));
  if (filters.status && filters.status !== "all") dtos = dtos.filter((c) => c.status === filters.status);
  if (filters.q) {
    const q = filters.q.toLowerCase();
    dtos = dtos.filter((c) =>
      c.customerName.toLowerCase().includes(q) || c.customerEmail.toLowerCase().includes(q) || c.declineCode.includes(q));
  }
  return { items: dtos, nextCursor: null };
}

export async function getCase(ctx: OrgContext, caseId: string): Promise<{ case: RecoveryCase; timeline: TimelineEntry[] }> {
  const rows = await loadCases(ctx.db, ctx.org.id);
  const row = rows.find((r) => r.case.id === caseId);
  if (!row) throw new ProblemError("not-found", "No such recovery case in this workspace.");

  const attempts = await withOrgTx(ctx.db, ctx.org.id, (tx) =>
    tx.select().from(schema.paymentAttempts).where(eq(schema.paymentAttempts.paymentId, row.payment.id)));

  const dto = caseDto(row, ctx.org.slug, attempts, await retryStateForList(ctx, row));
  const timeline: TimelineEntry[] = [];
  timeline.push({
    id: `fail-${row.payment.id}`, at: (row.payment.failedAt ?? row.case.firstFailedAt).toISOString(),
    kind: "system", title: `Payment failed — ${row.case.declineCode}`,
    detail: row.payment.declineMessage ?? null, tone: "err"
  });
  for (const a of attempts) {
    timeline.push({
      id: a.id, at: a.attemptedAt.toISOString(), kind: "attempt",
      title: a.outcome === "succeeded" ? "Retry succeeded" : `Retry failed — ${a.declineCode ?? "unknown decline"}`,
      detail: null, tone: a.outcome === "succeeded" ? "ok" : "warn"
    });
  }
  if (row.message) {
    timeline.push({
      id: row.message.id, at: row.message.createdAt.toISOString(), kind: "message",
      title: "Recovery note drafted", detail: row.message.subject,
      tone: "info"
    });
  }
  // approval history from the append-only audit log (no org leak: scoped tx)
  const auditRows = await withOrgTx(ctx.db, ctx.org.id, (tx) =>
    tx.select().from(schema.auditLogs)
      .where(and(eq(schema.auditLogs.orgId, ctx.org.id), eq(schema.auditLogs.targetType, "recovery_message"), eq(schema.auditLogs.targetId, row.message?.id ?? "—")))
      .orderBy(desc(schema.auditLogs.createdAt)));
  for (const a of auditRows) {
    timeline.push({
      id: a.id, at: a.createdAt.toISOString(), kind: "approval",
      title: a.action.replace("message.", "Message ").replace(/^\w/, (c) => c.toUpperCase()),
      detail: null, tone: a.action.includes("approved") ? "ok" : "warn"
    });
  }
  timeline.sort((x, y) => y.at.localeCompare(x.at));
  return { case: dto, timeline };
}

/**
 * Draft actions with the §13 invariant enforced server-side:
 *   submit: draft → awaiting_approval · approve: awaiting_approval → approved
 *   cancel: → cancelled · edit: content change; from approved ⇒ approval
 *   becomes invalidated (persisted invalidated_at + audit row).
 * Nothing here ever sends anything or touches a provider.
 */
export async function applyDraftAction(
  ctx: OrgContext, caseId: string, draftId: string, action: DraftAction, meta: { ip?: string | null; userAgent?: string | null }
): Promise<MessageDraft> {
  return withOrgTx(ctx.db, ctx.org.id, async (tx) => {
    const [msg] = await tx.select().from(schema.recoveryMessages)
      .where(and(eq(schema.recoveryMessages.id, draftId), eq(schema.recoveryMessages.caseId, caseId), eq(schema.recoveryMessages.orgId, ctx.org.id)));
    if (!msg) throw new ProblemError("not-found", "No such draft in this workspace.");

    const current = fsmStatus(msg);
    // "invalidated" is the derived display status of a draft whose approval
    // was invalidated; for FSM purposes it is a draft again (fresh cycle).
    const fsmState = current === "invalidated" ? "draft" : current;
    let result: TransitionResult;
    let invalidates = false;
    switch (action.type) {
      case "submit": result = transition(fsmState, { type: "submit" }); break;
      case "approve": result = transition(fsmState, { type: "approve", actor: ctx.userId }); break;
      case "cancel": result = transition(fsmState, { type: "cancel", actor: ctx.userId }); break;
      case "edit": {
        // Phase 6: edited copy must satisfy the same schema + content red
        // lines as generated copy (the send path re-checks; this is early feedback).
        const candidate = AiCopySchema.safeParse({
          subject: action.subject,
          paragraphs: action.body.split(/\n{2,}/).map((p) => p.replace(/\s*\n\s*/g, " ").trim()).filter(Boolean),
          cta_label: "Update payment method", tone_check: { formality: "neutral", empathy: "medium" }
        });
        if (!candidate.success) throw new ProblemError("validation", "Subject must be one line (4–90 chars); body 1–4 short paragraphs.");
        const violations = validateCopy(candidate.data);
        if (violations.length) throw new ProblemError("validation", `Message content not allowed: ${violations.join(", ")}.`);
        result = transition(fsmState, { type: "edit", subject: action.subject, body: action.body });
        invalidates = current === "approved" || current === "queued";
        break;
      }
    }
    if (!result.ok) throw new ProblemError("conflict", result.reason);

    const nextStatus = result.status;
    const patch: Partial<typeof schema.recoveryMessages.$inferInsert> = { approvalStatus: nextStatus === "invalidated" ? "draft" : nextStatus };
    if (action.type === "edit") {
      // Content edits always apply; the FSM decides whether the approval survives.
      patch.subject = action.subject;
      patch.body = action.body;
    }
    if (nextStatus === "invalidated" || invalidates) {
      patch.invalidatedAt = new Date();
      patch.approvedBy = null;
      patch.approvedAt = null;
    }
    if (nextStatus === "awaiting_approval") patch.invalidatedAt = null; // fresh cycle
    if (nextStatus === "approved") {
      patch.approvedBy = ctx.userId;
      patch.approvedAt = new Date();
    }

    const [updated] = await tx.update(schema.recoveryMessages).set(patch)
      .where(eq(schema.recoveryMessages.id, draftId)).returning();

    await audit(tx as unknown as Db, {
      orgId: ctx.org.id,
      actorId: ctx.userId,
      action: `message.${action.type}${invalidates ? ".invalidates_approval" : ""}`,
      targetType: "recovery_message",
      targetId: draftId,
      diff: {
        approvalStatus: [current, nextStatus],
        ...(action.type === "edit" ? { subject: ["(previous)", action.subject.length > 80 ? action.subject.slice(0, 77) + "…" : action.subject] } : {})
      },
      ip: meta.ip, userAgent: meta.userAgent
    });

    return draftDto(updated!);
  });
}

/**
 * Manual retry (Phase 4C): the explicit payment-execution primitive. An
 * operator+ command that executes ONE idempotent provider payment operation
 * for the case's failed payment — see services/execute.ts for the authority
 * chain, idempotency, and outcome handling.
 */
export async function requestRetry(
  ctx: import("../context.js").OrgContext,
  caseId: string,
  input: { idempotencyKey?: string },
  meta: { ip?: string | null; userAgent?: string | null }
): Promise<import("./execute.js").PaymentExecutionDTO> {
  const { executeManualRetry } = await import("./execute.js");
  return executeManualRetry(ctx, caseId, input, meta);
}

/** Overview counts helper (also used by overview service). */
export async function approvalsPending(db: Db, orgId: string): Promise<number> {
  const [msgRow] = await withOrgTx(db, orgId, (tx) =>
    tx.select({ n: sql<number>`count(*)::int` }).from(schema.recoveryMessages)
      .where(and(eq(schema.recoveryMessages.orgId, orgId), eq(schema.recoveryMessages.approvalStatus, "awaiting_approval"))));
  const [oppRow] = await withOrgTx(db, orgId, (tx) =>
    tx.select({ n: sql<number>`count(*)::int` }).from(schema.expansionOpportunities)
      .where(and(eq(schema.expansionOpportunities.orgId, orgId), eq(schema.expansionOpportunities.draftStatus, "awaiting_approval"))));
  return (msgRow?.n ?? 0) + (oppRow?.n ?? 0);
}

export { categoryOf };
