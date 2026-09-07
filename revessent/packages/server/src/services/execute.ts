/**
 * PAYMENT EXECUTION PRIMITIVE (Phase 4C).
 *
 * The ONE controlled transition from observing provider state to executing a
 * narrowly defined payment operation: an EXPLICIT, authenticated manual retry
 * of a failed invoice payment via Stripe `invoices.pay` (Architecture v1 J2:
 * "retry job executes via Stripe API (idempotency key rv:{org}:{case}:{attempt})").
 *
 * NOT implemented here, by mandate: scheduled collection, automatic retry
 * workers, automatic recovery execution, background payment execution,
 * "charge all overdue" automation. Every execution originates from an
 * explicit authenticated server-side command (operator+ RBAC). No
 * BullMQ/Redis/workers exist in this phase.
 *
 * Execution identity: the architecture's own `recovery_attempts` row
 * (kind='manual_retry') extended by migration 0017 — a database-backed
 * execution identity with org-scoped idempotency uniqueness. The provider
 * idempotency key is deterministically derived from the durable execution
 * id (rv:{orgId}:{executionId}) and is NEVER exposed to the frontend.
 *
 * State machine (recovery_attempts.status):
 *   scheduled (=created) → executing → succeeded | failed | unknown
 *   unknown/executing + reconciliation → succeeded | failed(no_provider_operation)
 *   `unknown` means the provider outcome could not be established (network
 *   loss / provider outage after send): it is NEVER interpreted as failure,
 *   never blindly re-executed, and only resolved through provider truth
 *   (webhook → 4B appliers, or the read-only reconciliation lookup).
 *
 * NO database transaction is held across provider I/O (Phase 4B lesson):
 *   tx(create execution) → tx(mark executing) → PROVIDER CALL → tx(persist
 *   outcome). A crash leaves `scheduled` (nothing sent) or `executing`
 *   (recoverable — never assumed failed, never re-sent blindly).
 */
import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, ne, sql } from "drizzle-orm";
import * as schema from "@revessent/db";
import { withOrgTx, withPgAdvisoryLock, type Db } from "@revessent/db";
import { ProviderError, getStripeGateway, isProviderError } from "@revessent/integrations";
import { TERMINAL_CASE_STATUSES } from "@revessent/domain";
import type { OrgContext } from "../context.js";
import { appDb } from "../context.js";
import { ProblemError } from "../http/problems.js";
import { can } from "../authz/rbac.js";
import { audit } from "./audit.js";
import { decryptConnectionKey } from "./settings.js";

type AttemptRow = typeof schema.recoveryAttempts.$inferSelect;

/** The only executable local payment state: a FAILED payment (recovery domain). */
const EXECUTABLE_PAYMENT_STATUS = "failed";

/**
 * Provider-invoice states in which `invoices.pay` is a SAFE operation
 * (4C correction §6 — explicit whitelist; anything else refuses, and unknown
 * or future provider states are NEVER mapped into a payable state):
 *  - open          — finalized, payment outstanding (incl. a previously
 *                    failed attempt): the retry target;
 *  - uncollectible — the 4A local "failed" mapping; the debt is still
 *                    collectible explicitly (the recovery flow itself).
 * `paid` refuses (never a second charge — reconciliation converges local
 * truth); `void` and `draft` refuse; anything unrecognized refuses.
 */
const EXECUTABLE_PROVIDER_STATES = new Set(["open", "uncollectible"]);

/** Normalized provider-invoice truth used by the execution preflight. */
type ProviderInvoiceTruth = {
  invoiceId: string; customerId: string | null;
  amountDue: number | null; amountRemaining: number | null;
  currency: string | null; status: string | null; attempted: boolean;
};

/**
 * The preflight rules, shared by BOTH reads of the provider invoice:
 * the preliminary (pre-lock) read and the AUTHORITATIVE (post-lock) re-read.
 * Returns the FIRST fault against the local financial authority, or null
 * when the invoice is verified payable. Same rules in both phases — the
 * post-lock check is an additional race-safety layer, never a replacement.
 */
export function providerInvoiceFault(
  p: { customerId: string | null; currency: string | null; amountDue: number | null; amountRemaining: number | null; status: string | null },
  local: { customerStripeId: string; currency: string; amountCents: number }
): { reason: string; type: "validation" | "conflict"; detail: string } | null {
  if (!p.customerId) return { reason: "provider_customer_missing", type: "validation", detail: "The provider invoice does not identify a customer. Execution refused — the target will not be guessed." };
  if (p.customerId !== local.customerStripeId) return { reason: "provider_customer_mismatch", type: "conflict", detail: "The provider invoice belongs to a different customer. Execution refused — nothing was attempted." };
  if (!p.currency) return { reason: "provider_currency_missing", type: "validation", detail: "The provider invoice currency is not known. Execution refused — no currency will be defaulted." };
  if (p.currency !== local.currency) return { reason: "provider_currency_mismatch", type: "conflict", detail: "The provider invoice is in a different currency. Execution refused — currencies are never converted." };
  if (typeof p.amountRemaining !== "number" || !Number.isInteger(p.amountRemaining) || p.amountRemaining <= 0) {
    return { reason: "provider_amount_missing", type: "validation", detail: "The provider invoice amount is not known. Execution refused — no amount will be invented." };
  }
  if (typeof p.amountDue !== "number" || !Number.isInteger(p.amountDue) || p.amountDue <= 0) {
    return { reason: "provider_amount_missing", type: "validation", detail: "The provider invoice amount is not known. Execution refused — no amount will be invented." };
  }
  if (p.amountDue !== p.amountRemaining) return { reason: "provider_partially_paid", type: "conflict", detail: "The provider invoice carries payments or credits the local record does not reflect. Reconcile first — execution refused." };
  if (p.amountRemaining !== local.amountCents) return { reason: "provider_amount_mismatch", type: "conflict", detail: "The provider invoice amount differs from the local payment record. Execution refused — nothing was attempted." };
  const st = p.status ?? ""; // "" = missing → refused below (never in the whitelist)
  if (st === "") return { reason: "unsupported_provider_state", type: "conflict", detail: "The provider invoice state is not known. Execution refused — nothing was attempted." };
  if (!EXECUTABLE_PROVIDER_STATES.has(st)) {
    if (st === "paid") return { reason: "provider_invoice_already_paid", type: "conflict", detail: "The provider invoice is already paid. Nothing will be charged — reconcile to converge local truth." };
    if (st === "void") return { reason: "provider_invoice_void", type: "conflict", detail: "The provider invoice is void. Execution refused — nothing was attempted." };
    return { reason: `unsupported_provider_state:${st}`, type: "conflict", detail: "The provider invoice state does not support payment execution. Execution refused — nothing was attempted." };
  }
  return null;
}

// Architecture J2 key format rv:{org}:{case}:{attempt} uses colons — the
// explicit-key charset accommodates it while staying bounded and safe.
const CLIENT_KEY_RE = /^[A-Za-z0-9_:.-]{8,120}$/;

export type ExecutionStatus = "scheduled" | "executing" | "succeeded" | "failed" | "unknown" | "skipped" | "canceled";

export interface PaymentExecutionDTO {
  executionId: string;
  caseId: string;
  paymentId: string | null;
  status: ExecutionStatus;
  outcomeCategory: string | null;
  errorCode: string | null;
  declineCode: string | null;
  retryClassification: "never" | "later" | null;
  amountCents: number | null;
  currency: string | null;
  idempotencyKey: string;
  createdAt: string;
  executedAt: string | null;
  reconciledAt: string | null;
}

function dtoOf(r: AttemptRow): PaymentExecutionDTO {
  return {
    executionId: r.id,
    caseId: r.caseId,
    paymentId: r.paymentId ?? null,
    status: r.status as ExecutionStatus,
    outcomeCategory: r.outcomeCategory ?? null,
    errorCode: r.errorCode ?? null,
    declineCode: r.declineCode ?? null,
    retryClassification: (r.retryClassification as "never" | "later" | null) ?? null,
    amountCents: r.amountCents ?? null,
    currency: r.currency ?? null,
    idempotencyKey: r.idempotencyKey ?? "",
    createdAt: r.createdAt.toISOString(),
    executedAt: r.executedAt?.toISOString() ?? null,
    reconciledAt: r.reconciledAt?.toISOString() ?? null
  };
}

/** Hash over the immutable financial parameters (mission §11). The customer
 *  mapping is part of the identity: the same key with a different provider
 *  customer is a DIFFERENT execution target → conflict, never a replay. */
function requestHashOf(input: { paymentId: string; amountCents: number; currency: string; customerStripeId: string }): string {
  return createHash("sha256").update(`manual_retry|${input.paymentId}|${input.amountCents}|${input.currency.toUpperCase()}|${input.customerStripeId}`).digest("hex");
}

/**
 * THE one financial execution primitive (Phase 4D §11: manual and automated
 * paths share it — provider preflight, amount/currency/customer checks,
 * provider-state whitelist, idempotency, payment lock, post-lock
 * revalidation are implemented exactly once, here).
 *
 * `initiation="manual"` requires the operate RBAC permission (defense in
 * depth on top of the route's Layer-3 check). `initiation="automated"` is
 * SYSTEM-authorized: it is callable only from services/retry.ts (there is no
 * HTTP route that can request it); the retry service has already established
 * org ownership, an active connection, a valid case/payment and policy
 * eligibility, and this primitive re-walks the full authority chain and all
 * Phase 4C safety gates regardless.
 *
 * Idempotent end-to-end: same identity → same execution; different financial
 * parameters under the same idempotency identity → conflict (409).
 * Before any NEW payment operation the CURRENT provider invoice is retrieved
 * (preflight) and re-read under the payment lock; a mismatch refuses with
 * ZERO payment calls.
 */
async function executePaymentAttempt(
  ctx: OrgContext,
  caseId: string,
  input: { idempotencyKey?: string; policyVersion?: number },
  meta: { ip?: string | null; userAgent?: string | null },
  initiation: "manual" | "automated"
): Promise<PaymentExecutionDTO> {
  const db = appDb();
  if (initiation === "manual") {
    // Defense-in-depth: the route already asserts RBAC (Layer 3), but a
    // payment execution primitive re-asserts it — every MANUAL charge MUST
    // originate from an explicit operator+ command (mission §2).
    if (!can(ctx.role, "operate")) {
      throw new ProblemError("forbidden", `Your role (${ctx.role}) cannot execute payments.`);
    }
  }
  if (input.idempotencyKey !== undefined && !CLIENT_KEY_RE.test(input.idempotencyKey)) {
    throw new ProblemError("validation", "The idempotency key must be 8–120 letters, digits, dashes or underscores.");
  }

  // ---- Authority chain: session(org from ctx) → case → payment → customer
  // → connection. EVERY identity is resolved server-side from local records
  // keyed by the authenticated organization — the browser supplies only the
  // case id and an optional idempotency key. Nothing financial, no provider
  // identifiers, no org ids are accepted from the request body.
  const loaded = await withOrgTx(db, ctx.org.id, async (tx) => {
    const [row] = await tx.select({
      case: schema.recoveryCases,
      payment: schema.payments,
      customer: schema.customers
    }).from(schema.recoveryCases)
      .innerJoin(schema.payments, eq(schema.recoveryCases.paymentId, schema.payments.id))
      .innerJoin(schema.customers, eq(schema.payments.customerId, schema.customers.id))
      .where(and(eq(schema.recoveryCases.orgId, ctx.org.id), eq(schema.recoveryCases.id, caseId)));
    const [conn] = await tx.select().from(schema.stripeConnections)
      .where(and(eq(schema.stripeConnections.orgId, ctx.org.id), eq(schema.stripeConnections.status, "active")))
      .orderBy(sql`created_at desc`).limit(1);
    return { row, conn };
  });
  if (!loaded.row) throw new ProblemError("not-found", "No such recovery case.");
  const { payment, customer } = loaded.row;

  // ---- Durable idempotency identity, resolved BEFORE any gate: a re-delivery
  // of the SAME execution (same key, same immutable parameters) must return
  // the same result even though the first execution already advanced the
  // local payment state. Same key + different parameters → conflict, never
  // reinterpreted (mission §11). Default key for a MANUAL execution without a
  // client key: rv:{orgId}:{caseId}:m{seq} — its own sub-sequence over MANUAL
  // attempts only, so it NEVER occupies (or collides with) the automated
  // attempt-number space; the automated sequence is derived from durable auto
  // rows inside the payment lock (final correction §5/§11: manual actions
  // never enter the automated sequence).
  let key = input.idempotencyKey;
  if (!key) {
    const [countRow] = await withOrgTx(db, ctx.org.id, (tx) =>
      tx.select({ n: sql<number>`count(*)::int` }).from(schema.recoveryAttempts)
        .where(and(eq(schema.recoveryAttempts.caseId, caseId), eq(schema.recoveryAttempts.kind, "manual_retry"))));
    key = `rv:${ctx.org.id}:${caseId}:m${(countRow?.n ?? 0) + 1}`;
  }
  const identityHash = requestHashOf({
    paymentId: payment.id, amountCents: payment.amountCents, currency: payment.currency,
    customerStripeId: customer.stripeCustomerId ?? ""
  });
  const [preexisting] = await withOrgTx(db, ctx.org.id, (tx) =>
    tx.select().from(schema.recoveryAttempts)
      .where(and(eq(schema.recoveryAttempts.orgId, ctx.org.id), eq(schema.recoveryAttempts.idempotencyKey, key))));
  if (preexisting) {
    if (preexisting.requestHash === identityHash && preexisting.paymentId === payment.id) {
      if (preexisting.status !== "scheduled") {
        // Same logical execution — return it (never a second provider payment).
        await withOrgTx(db, ctx.org.id, (tx) => audit(tx as unknown as Db, {
          orgId: ctx.org.id, actorId: ctx.userId, action: "payment.execute_attempted",
          targetType: "payment_execution", targetId: caseId,
          diff: { amountCents: preexisting.amountCents, currency: preexisting.currency, paymentId: payment.id, replayed: true },
          ip: meta.ip, userAgent: meta.userAgent
        }));
        return dtoOf(preexisting);
      }
      // A RESERVED-but-unexecuted attempt with this identity (automated
      // reservation or a crashed pre-execution run) is RESUMED with the same
      // identity (§20) — never re-created. If the payment is no longer
      // retryable, finalize the reservation honestly; nothing is executed.
      if (payment.status !== EXECUTABLE_PAYMENT_STATUS) {
        const [finalized] = await withOrgTx(db, ctx.org.id, (tx) =>
          tx.update(schema.recoveryAttempts).set({
            status: "skipped", errorCode: "payment_no_longer_retryable",
            outcomeCategory: "payment_no_longer_retryable", retryClassification: "never",
            executedAt: new Date()
          }).where(eq(schema.recoveryAttempts.id, preexisting.id)).returning());
        return dtoOf(finalized!);
      }
      // fall through: gates re-run; the insert-conflict path adopts the row.
    } else {
      // Same idempotency identity, DIFFERENT financial parameters: reject —
      // never reinterpret an existing execution (mission §11).
      throw new ProblemError("conflict", "This idempotency key was already used with different payment parameters.");
    }
  }

  // ---- Local authority + financial truth validation (mission §4/§5/§7).
  // Amount and currency come ONLY from the local payment record — never from
  // the request. A missing/zero/negative amount or an unknown currency fails
  // safely (never amount ?? 0, never a default currency).
  if (!loaded.conn || !loaded.conn.keyCiphertext) {
    throw new ProblemError("conflict", "Payment execution requires an active Stripe connection. Nothing was attempted.");
  }
  const connection = loaded.conn;
  if (!payment.stripeInvoiceId) {
    throw new ProblemError("validation", "This payment has no provider invoice to execute against. Nothing was attempted.");
  }
  if (payment.status !== EXECUTABLE_PAYMENT_STATUS) {
    throw new ProblemError("validation", "Only a failed payment can be retried. The provider state does not support this operation.");
  }
  const amountCents = payment.amountCents;
  if (typeof amountCents !== "number" || !Number.isInteger(amountCents) || amountCents <= 0) {
    throw new ProblemError("validation", "The payment amount is not known. Execution refused — no amount will be invented.");
  }
  const currency = (payment.currency ?? "").toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new ProblemError("validation", "The payment currency is not known. Execution refused — no currency will be defaulted.");
  }
  if (!customer.stripeCustomerId) {
    throw new ProblemError("validation", "The customer's provider identity is not known. Execution refused.");
  }

  const stripeInvoiceId: string = payment.stripeInvoiceId;

  await withOrgTx(db, ctx.org.id, (tx) => audit(tx as unknown as Db, {
    orgId: ctx.org.id, actorId: ctx.userId, action: "payment.execute_attempted",
    targetType: "payment_execution", targetId: caseId,
    diff: { amountCents, currency, paymentId: payment.id },
    ip: meta.ip, userAgent: meta.userAgent
  }));

  // ---- PROVIDER-INVOICE PREFLIGHT (4C correction): before a NEW payment
  // operation, retrieve the CURRENT provider invoice through the existing
  // server-side Stripe boundary and verify it against the local financial
  // authority. Stripe collects according to the provider invoice — the local
  // amount alone does not constrain the charge. Read-only: any refusal here
  // makes ZERO payment/mutation calls. No transaction is open across the
  // provider I/O (4B lesson).
  const refusePreflight = async (reason: string, type: "validation" | "conflict" | "internal", detail: string): Promise<never> => {
    await withOrgTx(db, ctx.org.id, (tx) => audit(tx as unknown as Db, {
      orgId: ctx.org.id, actorId: ctx.userId, action: "payment.preflight_failed",
      targetType: "payment_execution", targetId: caseId,
      diff: { amountCents, currency, paymentId: payment.id, reason },
      ip: meta.ip, userAgent: meta.userAgent
    }));
    throw new ProblemError(type, detail);
  };

  // Read-only provider truth through the existing server-side Stripe boundary.
  const readProviderInvoice = async (): Promise<ProviderInvoiceTruth> =>
    getStripeGateway().getInvoiceForExecution(
      decryptConnectionKey(connection.keyCiphertext as string), stripeInvoiceId);
  const localAuthority = {
    customerStripeId: customer.stripeCustomerId!, // gated above
    currency, amountCents
  };

  let preflight: ProviderInvoiceTruth;
  try {
    preflight = await readProviderInvoice();
  } catch (err) {
    const code = isProviderError(err) || err instanceof ProviderError ? (err as ProviderError).code : "provider_error";
    await withOrgTx(db, ctx.org.id, (tx) => audit(tx as unknown as Db, {
      orgId: ctx.org.id, actorId: ctx.userId, action: "payment.preflight_failed",
      targetType: "payment_execution", targetId: caseId,
      diff: { amountCents, currency, paymentId: payment.id, reason: `provider_lookup_failed:${code}` },
      ip: meta.ip, userAgent: meta.userAgent
    }));
    // Honest recoverable refusal: NOTHING was executed, so there is no
    // unknown payment outcome — but unverified provider truth is never acted
    // on, and a blind payment is forbidden (correction §8). The command can
    // be re-issued: the idempotency identity is unchanged.
    throw new ProblemError("internal",
      "The provider invoice could not be verified before execution. Nothing was attempted — retry shortly or reconcile first.");
  }

  // Customer/currency/amount/state rules are shared with the post-lock
  // re-read (below) — one set of rules, two moments in time. This pre-lock
  // read is PRELIMINARY: it fails fast and audits, but the state that
  // authorizes the payment operation is established only under the lock.
  const fault = providerInvoiceFault(preflight, localAuthority);
  if (fault) await refusePreflight(fault.reason, fault.type, fault.detail);

  // ---- Durable idempotency: the DB enforces the execution identity.
  // Concurrent identical requests collide on the unique index; the loser
  // reads and returns the SAME execution.
  const inserted = await withOrgTx(db, ctx.org.id, (tx) =>
    tx.insert(schema.recoveryAttempts).values({
      orgId: ctx.org.id, caseId, paymentId: payment.id,
      amountCents, currency, stripeConnectionId: connection.id,
      requestHash: identityHash,
      kind: initiation === "manual" ? "manual_retry" : "auto_retry",
      actor: initiation === "manual" ? ctx.userId : "system",
      policyVersion: input.policyVersion ?? null,
      status: "scheduled", idempotencyKey: key
    }).onConflictDoNothing({ target: [schema.recoveryAttempts.orgId, schema.recoveryAttempts.idempotencyKey] })
      .returning());

  let execution = inserted[0];
  if (!execution) {
    const [existing] = await withOrgTx(db, ctx.org.id, (tx) =>
      tx.select().from(schema.recoveryAttempts)
        .where(and(eq(schema.recoveryAttempts.orgId, ctx.org.id), eq(schema.recoveryAttempts.idempotencyKey, key))));
    if (existing && existing.requestHash === identityHash && existing.paymentId === payment.id) {
      if (existing.status !== "scheduled") {
        // Same logical execution — return it (never a second provider payment).
        return dtoOf(existing);
      }
      // ADOPT the reserved-but-unexecuted row and continue (resume, §20).
      execution = existing;
    } else {
      // Same idempotency identity, DIFFERENT financial parameters: reject —
      // never reinterpret an existing execution (mission §11).
      throw new ProblemError("conflict", "This idempotency key was already used with different payment parameters.");
    }
  }

  // ---- Single-flight per PAYMENT: concurrent executions of the same payment
  // (even under different keys) serialize; the second observes the first's
  // outcome and refuses to double-charge.
  const outcome = await withPgAdvisoryLock(db, "revessent:payment-exec", payment.id, async () => {
    // Under the lock, re-read THIS execution: an identical concurrent request
    // may have executed it while this one waited — return THAT result
    // (never a second provider operation for the same identity).
    const [currentSelf] = await withOrgTx(db, ctx.org.id, (tx) =>
      tx.select().from(schema.recoveryAttempts).where(eq(schema.recoveryAttempts.id, execution!.id)));
    if (currentSelf && currentSelf.status !== "scheduled") {
      return { execution: currentSelf, deferred: false as const };
    }
    // Provider-side ambiguity guard: another execution of this payment is
    // executing/unknown ⇒ establishing its outcome precedes any new operation.
    const [inFlight] = await withOrgTx(db, ctx.org.id, (tx) =>
      tx.select().from(schema.recoveryAttempts)
        .where(and(
          eq(schema.recoveryAttempts.orgId, ctx.org.id),
          eq(schema.recoveryAttempts.paymentId, payment.id),
          inArray(schema.recoveryAttempts.status, ["executing", "unknown"]),
          ne(schema.recoveryAttempts.id, execution!.id)
        )).limit(1));
    if (inFlight) return { execution: inFlight, deferred: true as const };

    // ---- POST-LOCK REVALIDATION (4C correction 2 — TOCTOU guard).
    // The payment advisory lock is the FINAL serialization boundary: the
    // local and provider state that authorizes the payment operation is
    // established HERE, under the lock, immediately before the mutation.
    // The pre-lock reads were preliminary only — two executions with
    // DIFFERENT idempotency keys can both pass them before either charges.
    const finalizeRefused = async (reason: string, status: "failed" | "skipped", classification: "never" | "later") => {
      await withOrgTx(db, ctx.org.id, (tx) =>
        tx.update(schema.recoveryAttempts).set({
          status, errorCode: reason, outcomeCategory: reason,
          retryClassification: classification, executedAt: new Date()
        }).where(eq(schema.recoveryAttempts.id, execution!.id)));
      await withOrgTx(db, ctx.org.id, (tx) => audit(tx as unknown as Db, {
        orgId: ctx.org.id, actorId: ctx.userId, action: "payment.preflight_failed",
        targetType: "payment_execution", targetId: execution!.id,
        diff: { amountCents, currency, paymentId: payment.id, reason, phase: "post_lock" },
        ip: meta.ip, userAgent: meta.userAgent
      }));
    };

    // (a) LOCAL truth re-read: another execution identity may have completed
    // while this request waited for the lock. A payment that is no longer
    // failed is never charged again — reconciliation converges local truth.
    const [currentPayment] = await withOrgTx(db, ctx.org.id, (tx) =>
      tx.select().from(schema.payments).where(eq(schema.payments.id, payment.id)));
    if (!currentPayment || currentPayment.status !== EXECUTABLE_PAYMENT_STATUS) {
      const reason = currentPayment?.status === "paid" ? "payment_already_paid" : "payment_no_longer_retryable";
      await finalizeRefused(reason, "skipped", "never");
      throw new ProblemError("conflict", reason === "payment_already_paid"
        ? "The payment has already been paid. No second charge was created — reconcile to converge local truth."
        : "The payment is no longer retryable. No charge was created.");
    }

    // (b) PROVIDER truth re-read: the invoice may have changed between the
    // preliminary preflight and this moment (paid, void, re-mapped, or
    // re-valued). The SAME shared rules apply — under the lock this time.
    let current: ProviderInvoiceTruth;
    try {
      current = await readProviderInvoice();
    } catch (err) {
      const code = isProviderError(err) || err instanceof ProviderError ? (err as ProviderError).code : "provider_error";
      await finalizeRefused(`provider_lookup_failed:${code}`, "failed", "later");
      throw new ProblemError("internal",
        "The provider invoice could not be verified before execution. Nothing was attempted — retry shortly or reconcile first.");
    }
    const postLockFault = providerInvoiceFault(current, localAuthority);
    if (postLockFault) {
      await finalizeRefused(postLockFault.reason,
        postLockFault.reason === "provider_invoice_already_paid" ? "skipped" : "failed", "never");
      throw new ProblemError(postLockFault.type, postLockFault.detail);
    }

    // Mark executing (own tx, committed BEFORE provider I/O).
    await withOrgTx(db, ctx.org.id, (tx) =>
      tx.update(schema.recoveryAttempts).set({ status: "executing" })
        .where(eq(schema.recoveryAttempts.id, execution!.id)));

    // ---- PROVIDER CALL — no transaction open (Phase 4B lesson).
    const providerKey = `rv:${ctx.org.id}:${execution!.id}`; // derived, stable, never exposed
    try {
      const res = await getStripeGateway().payInvoice(decryptConnectionKey(connection.keyCiphertext as string), {
        invoiceId: stripeInvoiceId, idempotencyKey: providerKey
      });
      // tx: persist the immediate provider result. Webhooks remain the
      // authoritative asynchronous truth — this is the instant response.
      const final = await withOrgTx(db, ctx.org.id, async (tx) => {
        const status: ExecutionStatus = res.paid ? "succeeded" : "failed";
        const [updated] = await tx.update(schema.recoveryAttempts).set({
          status,
          outcomeCategory: res.paid ? "succeeded" : "unsupported_provider_state",
          retryClassification: "never",
          providerPaymentIntentId: res.paymentIntentId,
          providerMeta: { invoiceStatus: res.invoiceStatus, attemptedCount: res.attemptedCount, chargeId: res.chargeId },
          executedAt: new Date()
        }).where(eq(schema.recoveryAttempts.id, execution!.id)).returning();
        if (res.paid) {
          // Immediate local refresh (fields KNOWN from the response — the
          // webhook re-applies full provider truth via the 4A appliers).
          await tx.update(schema.payments).set({
            status: "paid", paidAt: new Date(), updatedAt: new Date()
          }).where(and(eq(schema.payments.orgId, ctx.org.id), eq(schema.payments.id, payment.id)));
        }
        await tx.insert(schema.paymentAttempts).values({
          paymentId: payment.id, source: "revessent_retry",
          outcome: res.paid ? "succeeded" : "failed",
          declineCode: null, attemptedAt: new Date(),
          raw: { invoiceStatus: res.invoiceStatus, attemptedCount: res.attemptedCount, executionId: execution!.id }
        });
        return updated!;
      });
      await withOrgTx(db, ctx.org.id, (tx) => audit(tx as unknown as Db, {
        orgId: ctx.org.id, actorId: ctx.userId,
        action: res.paid ? "payment.executed" : "payment.failed",
        targetType: "payment_execution", targetId: execution!.id,
        diff: { amountCents, currency, category: res.paid ? "succeeded" : "unsupported_provider_state", invoiceStatus: res.invoiceStatus },
        ip: meta.ip, userAgent: meta.userAgent
      }));
      if (res.paid) {
        // Guarded §5.3 transition (payment paid + single attribution) — the
        // same convergence for manual and automated executions.
        await markCaseRecovered(ctx, caseId);
      }
      return { execution: final, deferred: false as const };
    } catch (err) {
      const code = isProviderError(err) ? err.code : "transient_network";
      const mapped = classifyOutcome(code);
      // tx: persist the outcome. NEVER assume a network/5xx failure means the
      // payment failed — those become `unknown` (recoverable) — and NEVER
      // record a payment_attempts row for an outcome we could not observe.
      const final = await withOrgTx(db, ctx.org.id, async (tx) => {
        const [updated] = await tx.update(schema.recoveryAttempts).set({
          status: mapped.status,
          outcomeCategory: mapped.category,
          errorCode: code,
          declineCode: mapped.declineCode,
          retryClassification: mapped.classification,
          executedAt: new Date()
        }).where(eq(schema.recoveryAttempts.id, execution!.id)).returning();
        if (mapped.recordAttempt) {
          await tx.insert(schema.paymentAttempts).values({
            paymentId: payment.id, source: "revessent_retry", outcome: "failed",
            declineCode: mapped.declineCode, attemptedAt: new Date(),
            raw: { executionId: execution!.id, category: mapped.category }
          });
        }
        return updated!;
      });
      await withOrgTx(db, ctx.org.id, (tx) => audit(tx as unknown as Db, {
        orgId: ctx.org.id, actorId: ctx.userId,
        action: mapped.status === "unknown" ? "payment.outcome_unknown" : mapped.category.startsWith("declined") || mapped.category === "card_declined" || mapped.category === "insufficient_funds" || mapped.category === "expired_card" || mapped.category === "authentication_required" || mapped.category === "payment_method_failure" ? "payment.declined" : "payment.failed",
        targetType: "payment_execution", targetId: execution!.id,
        diff: { amountCents, currency, category: mapped.category, code },
        ip: meta.ip, userAgent: meta.userAgent
      }));
      if (mapped.status === "unknown") {
        throw new ProblemError("internal",
          "The payment outcome could not be confirmed (the provider response was lost). Nothing is assumed — reconcile to establish the outcome before another attempt.");
      }
      return { execution: final, deferred: false as const };
    }
  }, { waitMs: 15_000 });

  if (!outcome.acquired) {
    // Lock contention (extreme): another request is executing this payment
    // right now — this request created no second provider operation.
    throw new ProblemError("conflict",
      "This payment is being executed by another request. No duplicate charge was created.");
  }
  if (outcome.value.deferred) {
    // Another execution of this payment is in flight/unknown — this request
    // did NOT create a second provider operation.
    throw new ProblemError("conflict",
      "Another payment execution for this payment is still being established. Reconcile first — no second charge will be created.");
  }
  return dtoOf(outcome.value.execution);
}

/** Explicit operator-initiated execution (the Phase 4C route surface). */
export async function executeManualRetry(
  ctx: OrgContext,
  caseId: string,
  input: { idempotencyKey?: string },
  meta: { ip?: string | null; userAgent?: string | null }
): Promise<PaymentExecutionDTO> {
  return executePaymentAttempt(ctx, caseId, input, meta, "manual");
}

/**
 * System-authorized automated execution (Phase 4D) — SAME primitive, SAME
 * gates. Callers: services/retry.ts only (operate-gated, org-scoped); no
 * HTTP route can reach this path with arbitrary parameters.
 */
export async function executeAutomatedRetry(
  ctx: OrgContext,
  caseId: string,
  input: { idempotencyKey?: string; policyVersion?: number },
  meta: { ip?: string | null; userAgent?: string | null }
): Promise<PaymentExecutionDTO> {
  return executePaymentAttempt(ctx, caseId, input, meta, "automated");
}

/** Outcome classification per mission §12–§14 (extend, never generic "failed"). */
function classifyOutcome(code: string): {
  status: ExecutionStatus; category: string; classification: "never" | "later";
  declineCode: string | null; recordAttempt: boolean;
} {
  if (code === "card_declined" || code === "insufficient_funds" || code === "expired_card") {
    return { status: "failed", category: code, classification: "never", declineCode: code, recordAttempt: true };
  }
  if (code === "authentication_required") {
    return { status: "failed", category: "authentication_required", classification: "never", declineCode: "authentication_required", recordAttempt: true };
  }
  if (code === "payment_method_failure") {
    return { status: "failed", category: "payment_method_failure", classification: "never", declineCode: null, recordAttempt: true };
  }
  if (code === "invalid_payment_context" || code === "unsupported_provider_state" || code === "idempotency_conflict") {
    return { status: "failed", category: code, classification: "never", declineCode: null, recordAttempt: false };
  }
  if (code === "invalid_credentials" || code === "revoked" || code === "auth_failure" || code === "permission_failure") {
    return { status: "failed", category: code, classification: "never", declineCode: null, recordAttempt: false };
  }
  if (code === "rate_limited") {
    // 429 = the request was rejected BEFORE execution — no provider operation
    // exists; retryable LATER (classification only — no worker exists).
    return { status: "failed", category: "rate_limited", classification: "later", declineCode: null, recordAttempt: false };
  }
  // transient_network / provider_outage / malformed_response / anything else:
  // the operation MAY have executed — outcome UNKNOWN (§16 hard case).
  return { status: "unknown", category: "unknown", classification: "never", declineCode: null, recordAttempt: false };
}

/**
 * STALE/UNKNOWN EXECUTION RECOVERY (mission §16/§18). Runs inside the Phase
 * 4B reconciliation path AFTER the read-only sync has refreshed payments.
 * For every executing/unknown execution:
 *   invoice paid (provider truth)   → execution succeeded + reconciled
 *   provider shows no operation     → failed(no_provider_operation) + reconciled
 *                                     (a NEW execution is now provably safe)
 *   outcome still in flight         → stays unknown (never assumed, never re-run)
 */
export async function reconcileExecutions(ctx: OrgContext): Promise<string[]> {
  const db = appDb();
  const actions: string[] = [];
  const pending = await withOrgTx(db, ctx.org.id, (tx) =>
    tx.select().from(schema.recoveryAttempts)
      .where(and(eq(schema.recoveryAttempts.orgId, ctx.org.id), inArray(schema.recoveryAttempts.status, ["executing", "unknown"]))));

  for (const attempt of pending) {
    const attemptPaymentId = attempt.paymentId;
    if (!attemptPaymentId) { actions.push("execution_unresolvable:no_payment"); continue; }
    const [payment] = await withOrgTx(db, ctx.org.id, (tx) =>
      tx.select().from(schema.payments).where(eq(schema.payments.id, attemptPaymentId)));
    if (!payment?.stripeInvoiceId) { actions.push("execution_unresolvable:no_invoice"); continue; }

    // Fresh provider truth, read-only.
    const [conn] = await withOrgTx(db, ctx.org.id, (tx) =>
      tx.select().from(schema.stripeConnections)
        .where(and(eq(schema.stripeConnections.orgId, ctx.org.id), eq(schema.stripeConnections.status, "active")))
        .orderBy(sql`created_at desc`).limit(1));
    if (!conn?.keyCiphertext) { actions.push("execution_still_unknown:no_connection"); continue; }

    let provider: { status: string; paid: boolean; paymentIntentStatus: string | null };
    try {
      provider = await getStripeGateway().getInvoicePaymentStatus(
        decryptConnectionKey(conn.keyCiphertext), payment.stripeInvoiceId);
    } catch (err) {
      actions.push(isProviderError(err) || err instanceof ProviderError
        ? `execution_still_unknown:${(err as ProviderError).code ?? "provider_error"}`
        : "execution_still_unknown:provider_error");
      continue;
    }

    if (provider.paid) {
      await withOrgTx(db, ctx.org.id, async (tx) => {
        await tx.update(schema.recoveryAttempts).set({
          status: "succeeded", outcomeCategory: "succeeded", retryClassification: "never",
          providerMeta: { reconciled: true, invoiceStatus: provider.status },
          reconciledAt: new Date()
        }).where(eq(schema.recoveryAttempts.id, attempt.id));
        if (payment.status !== "paid") {
          await tx.update(schema.payments).set({ status: "paid", paidAt: new Date(), updatedAt: new Date() })
            .where(eq(schema.payments.id, payment.id));
        }
      });
      await withOrgTx(db, ctx.org.id, (tx) => audit(tx as unknown as Db, {
        orgId: ctx.org.id, actorId: null, action: "payment.reconciled",
        targetType: "payment_execution", targetId: attempt.id,
        diff: { outcome: "succeeded", source: "reconciliation" }, ip: null, userAgent: null
      }));
      actions.push("execution_resolved:succeeded");
      await markCaseRecovered(ctx, attempt.caseId);
      continue;
    }

    // Not paid. Is a provider operation still in flight?
    const inFlight = provider.paymentIntentStatus === "processing"
      || provider.paymentIntentStatus === "requires_action"
      || provider.paymentIntentStatus === "requires_confirmation";
    if (inFlight) { actions.push("execution_still_unknown:provider_processing"); continue; }

    // Provably NO completed/in-flight operation → the execution resolved as a
    // non-charge; a NEW execution is now safe (mission §18).
    await withOrgTx(db, ctx.org.id, (tx) =>
      tx.update(schema.recoveryAttempts).set({
        status: "failed", outcomeCategory: "no_provider_operation", errorCode: "no_provider_operation",
        retryClassification: "later", reconciledAt: new Date()
      }).where(eq(schema.recoveryAttempts.id, attempt.id)));
    await withOrgTx(db, ctx.org.id, (tx) => audit(tx as unknown as Db, {
      orgId: ctx.org.id, actorId: null, action: "payment.reconciled",
      targetType: "payment_execution", targetId: attempt.id,
      diff: { outcome: "no_provider_operation", source: "reconciliation" }, ip: null, userAgent: null
    }));
    actions.push("execution_resolved:no_provider_operation");
  }
  return actions;
}

/** Execution lookup for the org (UI detail — narrow DTO only). */
export async function listExecutionsForCase(ctx: OrgContext, caseId: string): Promise<PaymentExecutionDTO[]> {
  const rows = await withOrgTx(appDb(), ctx.org.id, (tx) =>
    tx.select().from(schema.recoveryAttempts)
      .where(and(eq(schema.recoveryAttempts.orgId, ctx.org.id), eq(schema.recoveryAttempts.caseId, caseId)))
      .orderBy(sql`created_at desc`));
  return rows.map(dtoOf);
}

/** Test seam: stable random for default keys is not needed — seq-based. */
export const _internal = { requestHashOf, randomUUID };

/** Guarded transition: case → recovered (§5.3 #2 — requires payments paid,
 *  creates the single attribution row). Idempotent; terminal cases never move. */
export async function markCaseRecovered(ctx: OrgContext, caseId: string): Promise<boolean> {
  const db = appDb();
  return withOrgTx(db, ctx.org.id, async (tx) => {
    const [c] = await tx.select().from(schema.recoveryCases)
      .where(and(eq(schema.recoveryCases.orgId, ctx.org.id), eq(schema.recoveryCases.id, caseId)));
    if (!c || TERMINAL_CASE_STATUSES.has(c.status)) return false;
    const [p] = await tx.select().from(schema.payments).where(eq(schema.payments.id, c.paymentId));
    if (!p || p.status !== "paid") return false; // recovered REQUIRES provider-confirmed paid
    await tx.update(schema.recoveryCases).set({
      status: "recovered", closedAt: new Date(), closedReason: "payment_recovered",
      recoveredCents: p.amountCents, updatedAt: new Date()
    }).where(eq(schema.recoveryCases.id, c.id));
    await tx.insert(schema.recoveryAttributions).values({
      orgId: ctx.org.id, caseId: c.id, customerId: c.customerId, paymentId: p.id,
      source: "retry", amountCents: p.amountCents,
      withinWindow: Date.now() - c.firstFailedAt.getTime() <= 90 * 86_400_000,
      policySnapshot: { recoveredVia: "automated_retry_v1" }
    }).onConflictDoNothing({ target: schema.recoveryAttributions.paymentId });
    await audit(tx as unknown as Db, {
      orgId: ctx.org.id, actorId: null, action: "case.recovered",
      targetType: "recovery_case", targetId: c.id,
      diff: { status: "recovered", recoveredCents: p.amountCents, source: "retry" }
    });
    return true;
  });
}

/** Guarded transition: case → lost (policy exhausted / give-up window). */
export async function markCaseLost(ctx: OrgContext, caseId: string, reason: string): Promise<boolean> {
  const db = appDb();
  return withOrgTx(db, ctx.org.id, async (tx) => {
    const [c] = await tx.select().from(schema.recoveryCases)
      .where(and(eq(schema.recoveryCases.orgId, ctx.org.id), eq(schema.recoveryCases.id, caseId)));
    if (!c || TERMINAL_CASE_STATUSES.has(c.status)) return false;
    await tx.update(schema.recoveryCases).set({
      status: "lost", closedAt: new Date(), closedReason: reason, updatedAt: new Date()
    }).where(eq(schema.recoveryCases.id, c.id));
    await audit(tx as unknown as Db, {
      orgId: ctx.org.id, actorId: null, action: "case.lost",
      targetType: "recovery_case", targetId: c.id,
      diff: { status: "lost", reason }
    });
    return true;
  });
}
