/**
 * PHASE 4D — AUTOMATED RETRY SERVICE.
 *
 * Eligibility is decided by the PURE domain function (packages/domain
 * retry.ts); execution goes through THE Phase 4C payment primitive
 * (executeAutomatedRetry → the same preflight, financial checks, payment
 * lock and post-lock revalidation as a manual retry — there is exactly one
 * financial execution implementation). No workers, no scheduler, no queue:
 * `runDueRetries` is a deterministic server-side primitive that a later
 * phase's delivery mechanism may call (architecture §5.3 guard #4, brief §18).
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import * as schema from "@revessent/db";
import { withOrgTx, withPgAdvisoryLock, type Db } from "@revessent/db";
import { can } from "../authz/rbac.js";
import { ProblemError } from "../http/problems.js";
import type { OrgContext } from "../context.js";
import { appDb } from "../context.js";
import { audit } from "./audit.js";
import { executeAutomatedRetry, markCaseRecovered, markCaseLost, _internal, type PaymentExecutionDTO } from "./execute.js";

export { markCaseRecovered, markCaseLost };
import {
  DEFAULT_AUTO_RETRY_POLICY, evaluateRetryEligibility,
  backoffDelayHours, type AutoRetryPolicy, type RetryFacts, type RetryDecision
} from "@revessent/domain";

/** Policy bundle resolved from retry_policies (§8.4 versioned rules). */
export interface RetryPolicyBundle {
  version: number;
  maxAutoRetries: number;
  minGapHours: number;
  autoRetry: AutoRetryPolicy;
}

type CaseRow = typeof schema.recoveryCases.$inferSelect;
type PaymentRow = typeof schema.payments.$inferSelect;
type AttemptRow = typeof schema.recoveryAttempts.$inferSelect;

/** Resolve the policy snapshot a case was created under (fallback: latest,
 *  then architecture defaults). Missing autoRetry section → defaults. */
export async function resolvePolicy(db: Db, orgId: string, version?: number | null): Promise<RetryPolicyBundle> {
  const rows = await withOrgTx(db, orgId, (tx) =>
    tx.select().from(schema.retryPolicies)
      .where(version
        ? and(eq(schema.retryPolicies.orgId, orgId), eq(schema.retryPolicies.version, version))
        : eq(schema.retryPolicies.orgId, orgId))
      .orderBy(desc(schema.retryPolicies.version)).limit(1));
  const rules = (rows[0]?.rules ?? {}) as {
    maxAutoRetries?: number; minGapHours?: number;
    autoRetry?: Partial<AutoRetryPolicy>;
  };
  return {
    version: rows[0]?.version ?? version ?? 1,
    maxAutoRetries: rules.maxAutoRetries ?? 3,
    minGapHours: rules.minGapHours ?? 24,
    autoRetry: {
      perCategory: { ...DEFAULT_AUTO_RETRY_POLICY.perCategory, ...(rules.autoRetry?.perCategory ?? {}) },
      backoffMultiplier: rules.autoRetry?.backoffMultiplier ?? DEFAULT_AUTO_RETRY_POLICY.backoffMultiplier,
      maxBackoffHours: rules.autoRetry?.maxBackoffHours ?? DEFAULT_AUTO_RETRY_POLICY.maxBackoffHours
    }
  };
}

/** Pure-domain facts for one case, resolved from local records only. */
export async function gatherFacts(db: Db, orgId: string, c: CaseRow, p: PaymentRow): Promise<{
  facts: RetryFacts; policy: RetryPolicyBundle; attempts: AttemptRow[];
}> {
  const attempts = await withOrgTx(db, orgId, (tx) =>
    tx.select().from(schema.recoveryAttempts).where(eq(schema.recoveryAttempts.caseId, c.id)));
  const [conn] = await withOrgTx(db, orgId, (tx) =>
    tx.select().from(schema.stripeConnections)
      .where(and(eq(schema.stripeConnections.orgId, orgId), eq(schema.stripeConnections.status, "active")))
      .orderBy(desc(schema.stripeConnections.createdAt)).limit(1));
  const [customer] = await withOrgTx(db, orgId, (tx) =>
    tx.select().from(schema.customers).where(eq(schema.customers.id, p.customerId)));
  const policy = await resolvePolicy(db, orgId, c.retryPolicyVersion);
  // ---- Automated-sequence facts (final correction §5/§7) ----
  // Manual attempts are durable history but NEVER part of the automated
  // sequence: counts (global + per-category) consider kind = auto_retry only.
  const executed = attempts.filter((a) => a.status !== "scheduled");
  const executedAuto = executed.filter((a) => a.kind === "auto_retry");
  const categoryAttemptCounts: Record<string, number> = {};
  for (const a of executedAuto) {
    // no_provider_operation is an execution-RESOLUTION code ("provably nothing
    // was sent"), not a payment outcome — it never occupies a policy bucket.
    if (a.outcomeCategory && a.outcomeCategory !== "no_provider_operation") {
      categoryAttemptCounts[a.outcomeCategory] = (categoryAttemptCounts[a.outcomeCategory] ?? 0) + 1;
    }
  }
  const lastExecuted = executed
    .filter((a) => ["succeeded", "failed", "unknown", "skipped"].includes(a.status))
    .sort((a, b) => (b.executedAt ?? b.createdAt).getTime() - (a.executedAt ?? a.createdAt).getTime())[0];
  const facts: RetryFacts = {
    caseStatus: c.status,
    paymentStatus: p.status,
    connectionActive: Boolean(conn),
    hasStripeInvoice: Boolean(p.stripeInvoiceId),
    amountValid: typeof p.amountCents === "number" && Number.isInteger(p.amountCents) && p.amountCents > 0,
    currencyValid: /^[A-Z]{3}$/.test(p.currency ?? ""),
    customerMapped: Boolean(customer?.stripeCustomerId),
    autoRetryCount: executedAuto.length,
    categoryAttemptCounts,
    // Routing category: the latest executed attempt's payment-outcome category;
    // before any automated attempt exists — or when the last attempt resolved
    // as no_provider_operation (an execution-resolution code, NOT a payment
    // outcome; 4C: "a NEW execution is now provably safe") — the case's own
    // decline category routes, so policy-unlisted / non-retryable categories
    // fail closed on the first decision (final correction §6).
    lastOutcome: (() => {
      const executedCategory = lastExecuted?.outcomeCategory ?? null;
      const routingCategory = executedCategory && executedCategory !== "no_provider_operation"
        ? executedCategory
        : c.declineCategory ?? null;
      return routingCategory ? { category: routingCategory } : null;
    })(),
    hasUnresolvedExecution: attempts.some((a) => a.status === "executing" || a.status === "unknown"),
    hasScheduledAutoAttempt: attempts.some((a) => a.kind === "auto_retry" && a.status === "scheduled"),
    lastExecutedAt: lastExecuted ? (lastExecuted.executedAt ?? lastExecuted.createdAt) : null,
    firstFailedAt: c.firstFailedAt,
    now: new Date()
  };
  return { facts, policy, attempts };
}

export interface RetryRunSummary {
  considered: number;
  executed: number;
  blocked: number;
  outcomes: Array<{
    caseId: string; verdict: string; reason: string;
    executionId?: string; status?: string; nextEligibleAt?: string | null;
  }>;
}

/**
 * The deterministic automated-retry primitive (brief §18). NO scheduler, NO
 * worker: a later phase's delivery mechanism calls this with an
 * authenticated operator context. Viewer/anonymous invocation is refused.
 */
export async function runDueRetries(
  ctx: OrgContext,
  opts: { now?: Date; caseId?: string; ip?: string | null; userAgent?: string | null } = {}
): Promise<RetryRunSummary> {
  // System runs are still operator-initiated (brief §19): never anonymous,
  // never viewer-reachable.
  if (!can(ctx.role, "operate")) {
    throw new ProblemError("forbidden", `Your role (${ctx.role}) cannot run automated retries.`);
  }
  const db = appDb();
  const now = opts.now ?? new Date();
  // Guard §5.3 #4: only cases in retrying|contacting whose payment is still
  // failed are candidates. Org-anchored; a caseId probe from another org
  // simply finds nothing (RLS + where).
  const candidates = await withOrgTx(db, ctx.org.id, (tx) =>
    tx.select({ case: schema.recoveryCases, payment: schema.payments })
      .from(schema.recoveryCases)
      .innerJoin(schema.payments, eq(schema.recoveryCases.paymentId, schema.payments.id))
      .where(and(
        eq(schema.recoveryCases.orgId, ctx.org.id),
        inArray(schema.recoveryCases.status, ["retrying", "contacting"]),
        eq(schema.payments.status, "failed"),
        ...(opts.caseId ? [eq(schema.recoveryCases.id, opts.caseId)] : [])
      )));

  const summary: RetryRunSummary = { considered: candidates.length, executed: 0, blocked: 0, outcomes: [] };

  for (const { case: c, payment: p } of candidates) {
    const pre = await gatherFacts(db, ctx.org.id, c, p);
    const decision = evaluateRetryEligibility(pre.facts, pre.policy);
    if (decision.verdict !== "eligible") {
      summary.blocked += 1;
      summary.outcomes.push({ caseId: c.id, verdict: decision.verdict, reason: decision.reason, nextEligibleAt: decision.nextEligibleAt?.toISOString() ?? null });
      await withOrgTx(db, ctx.org.id, (tx) => audit(tx as unknown as Db, {
        orgId: ctx.org.id, actorId: ctx.userId, action: "retry.blocked",
        targetType: "recovery_case", targetId: c.id,
        diff: { verdict: decision.verdict, reason: decision.reason, attemptNo: c.attemptNo, policyVersion: pre.policy.version },
        ip: opts.ip, userAgent: opts.userAgent
      }));
      continue;
    }

    // ---- Per-payment serialization: attempt numbering, limits and the
    // unresolved-execution re-check happen UNDER the Phase 4C payment lock.
    const reservation = await withPgAdvisoryLock(db, "revessent:payment-exec", p.id, async () => {
      const fresh = await gatherFacts(db, ctx.org.id, c, p);
      fresh.facts.now = now;
      const freshDecision = evaluateRetryEligibility(fresh.facts, fresh.policy);
      if (freshDecision.verdict !== "eligible") return { kind: "blocked" as const, decision: freshDecision };
      if (fresh.facts.hasScheduledAutoAttempt) {
        // Resume path: execute the EXISTING scheduled attempt — same identity,
        // same persisted automated number (final correction §4: never a new
        // attempt number, never a new idempotency key, never a second op).
        const scheduled = fresh.attempts.find((a) => a.kind === "auto_retry" && a.status === "scheduled")!;
        return { kind: "reserved" as const, key: scheduled.idempotencyKey!, attemptNo: scheduled.attemptNo ?? 0, policyVersion: scheduled.policyVersion ?? fresh.policy.version, resumed: true as const };
      }
      // Concurrency-safe AUTOMATED numbering (final correction §3/§10): the
      // next number is max(persisted auto attempt_no) + 1 — derived from the
      // durable rows (the row is the source of truth), never a drifting
      // application counter — and computed INSIDE the payment advisory lock,
      // which serializes all automated reservations for this payment. Manual
      // attempts are outside the automated sequence entirely. Database
      // backstops: unique (org, idempotency_key) AND the partial unique index
      // on (case_id, attempt_no) for auto rows — two concurrent automated
      // reservations of one case cannot receive the same number.
      const attemptNo = fresh.attempts
        .filter((a) => a.kind === "auto_retry")
        .reduce((max, a) => Math.max(max, a.attemptNo ?? 0), 0) + 1;
      const key = `rv:${ctx.org.id}:${c.id}:${attemptNo}`;
      const requestHash = _internal.requestHashOf({
        paymentId: p.id, amountCents: p.amountCents, currency: p.currency,
        customerStripeId: (await withOrgTx(db, ctx.org.id, (tx) =>
          tx.select().from(schema.customers).where(eq(schema.customers.id, p.customerId))))[0]?.stripeCustomerId ?? ""
      });
      const [reserved] = await withOrgTx(db, ctx.org.id, (tx) =>
        tx.insert(schema.recoveryAttempts).values({
          orgId: ctx.org.id, caseId: c.id, paymentId: p.id,
          amountCents: p.amountCents, currency: p.currency,
          requestHash,
          kind: "auto_retry", actor: "system",
          scheduledAt: now, status: "scheduled",
          idempotencyKey: key, policyVersion: fresh.policy.version,
          attemptNo
          // No explicit arbiter: a conflict on EITHER unique constraint —
          // (org, idempotency_key) or (case_id, attempt_no) — inserts nothing.
        }).onConflictDoNothing()
          .returning());
      if (!reserved) {
        // Lost an insert race (impossible under the lock, safe regardless):
        // adopt the existing scheduled attempt — never a second identity.
        const [existing] = await withOrgTx(db, ctx.org.id, (tx) =>
          tx.select().from(schema.recoveryAttempts)
            .where(and(eq(schema.recoveryAttempts.orgId, ctx.org.id), eq(schema.recoveryAttempts.idempotencyKey, key))));
        if (existing?.status !== "scheduled") return { kind: "blocked" as const, decision: { verdict: "blocked", reason: "attempt_already_resolved", nextEligibleAt: null } as RetryDecision };
        return { kind: "reserved" as const, key, attemptNo: existing.attemptNo ?? attemptNo, policyVersion: existing.policyVersion ?? fresh.policy.version, resumed: true as const };
      }
      return { kind: "reserved" as const, key, attemptNo, policyVersion: fresh.policy.version, resumed: false as const };
    });

    if (!reservation.acquired) {
      // Extreme contention: another execution holds the payment lock. This
      // run created no second attempt and no second provider operation.
      summary.blocked += 1;
      summary.outcomes.push({ caseId: c.id, verdict: "blocked", reason: "payment_execution_in_progress", nextEligibleAt: null });
      continue;
    }
    const reservation2 = reservation.value;
    if (reservation2.kind === "blocked") {
      summary.blocked += 1;
      summary.outcomes.push({ caseId: c.id, verdict: reservation2.decision.verdict, reason: reservation2.decision.reason, nextEligibleAt: reservation2.decision.nextEligibleAt?.toISOString() ?? null });
      await withOrgTx(db, ctx.org.id, (tx) => audit(tx as unknown as Db, {
        orgId: ctx.org.id, actorId: ctx.userId, action: "retry.blocked",
        targetType: "recovery_case", targetId: c.id,
        diff: { verdict: reservation2.decision.verdict, reason: reservation2.decision.reason, phase: "post_lock", policyVersion: pre.policy.version },
        ip: opts.ip, userAgent: opts.userAgent
      }));
      continue;
    }

    await withOrgTx(db, ctx.org.id, (tx) => audit(tx as unknown as Db, {
      orgId: ctx.org.id, actorId: ctx.userId,
      action: reservation2.resumed ? "retry.resumed" : "retry.scheduled",
      targetType: "recovery_case", targetId: c.id,
      diff: { attemptNo: reservation2.attemptNo, policyVersion: reservation2.policyVersion, actor: "system" },
      ip: opts.ip, userAgent: opts.userAgent
    }));

    // ---- Execute through THE shared Phase 4C primitive (preflight, lock,
    // post-lock revalidation, provider idempotency all inside).
    let execution: PaymentExecutionDTO | null = null;
    try {
      execution = await executeAutomatedRetry(ctx, c.id, {
        idempotencyKey: reservation2.key, policyVersion: reservation2.policyVersion
      }, { ip: opts.ip, userAgent: opts.userAgent });
    } catch {
      // The primitive persists an honest terminal/unknown state before
      // throwing — read the durable row instead of trusting the error.
    }
    const [row] = await withOrgTx(db, ctx.org.id, (tx) =>
      tx.select().from(schema.recoveryAttempts)
        .where(and(eq(schema.recoveryAttempts.orgId, ctx.org.id), eq(schema.recoveryAttempts.idempotencyKey, reservation2.key))));
    const status = execution?.status ?? row?.status ?? "failed";
    summary.executed += 1;
    summary.outcomes.push({
      caseId: c.id, verdict: "eligible", reason: "executed",
      executionId: execution?.executionId ?? row?.id, status,
      nextEligibleAt: null
    });

    // ---- Case state transitions (guarded, §5.3) + scheduling bookkeeping.
    await withOrgTx(db, ctx.org.id, async (tx) => {
      const autoCount = (await tx.select().from(schema.recoveryAttempts)
        .where(and(eq(schema.recoveryAttempts.caseId, c.id), eq(schema.recoveryAttempts.kind, "auto_retry"))));
      const executedAuto = autoCount.filter((a) => ["executing", "succeeded", "failed", "unknown"].includes(a.status)).length;
      // The case-level counter mirrors the AUTOMATED sequence only (manual
      // executions never write it) — final correction §2.
      await tx.update(schema.recoveryCases).set({ attemptNo: Math.max(c.attemptNo, reservation2.attemptNo), updatedAt: new Date() })
        .where(eq(schema.recoveryCases.id, c.id));
      if (status === "succeeded") {
        await audit(tx as unknown as Db, {
          orgId: ctx.org.id, actorId: ctx.userId, action: "retry.executed",
          targetType: "recovery_case", targetId: c.id,
          diff: { attemptNo: reservation2.attemptNo, status, outcomeCategory: "succeeded", actor: "system", policyVersion: reservation2.policyVersion },
          ip: opts.ip, userAgent: opts.userAgent
        });
      } else if (status === "failed") {
        const outcome = execution?.outcomeCategory ?? row?.outcomeCategory ?? "failed";
        const nextDelayHours = backoffDelayHours(executedAuto, pre.policy.autoRetry, pre.policy.minGapHours);
        await tx.update(schema.recoveryCases).set({ nextActionAt: new Date(now.getTime() + nextDelayHours * 3_600_000), updatedAt: new Date() })
          .where(eq(schema.recoveryCases.id, c.id));
        await audit(tx as unknown as Db, {
          orgId: ctx.org.id, actorId: ctx.userId,
          action: executedAuto >= pre.policy.maxAutoRetries ? "retry.exhausted" : "retry.failed",
          targetType: "recovery_case", targetId: c.id,
          diff: { attemptNo: reservation2.attemptNo, status, outcomeCategory: outcome, actor: "system", autoRetriesUsed: executedAuto, maxAutoRetries: pre.policy.maxAutoRetries },
          ip: opts.ip, userAgent: opts.userAgent
        });
      } else if (status === "unknown") {
        // Blocked until reconciliation — no next-action time is promised.
        await tx.update(schema.recoveryCases).set({ nextActionAt: null, updatedAt: new Date() })
          .where(eq(schema.recoveryCases.id, c.id));
        await audit(tx as unknown as Db, {
          orgId: ctx.org.id, actorId: ctx.userId, action: "retry.outcome_unknown",
          targetType: "recovery_case", targetId: c.id,
          diff: { attemptNo: reservation2.attemptNo, actor: "system", policyVersion: reservation2.policyVersion },
          ip: opts.ip, userAgent: opts.userAgent
        });
      } else if (status === "skipped") {
        await audit(tx as unknown as Db, {
          orgId: ctx.org.id, actorId: ctx.userId, action: "retry.skipped",
          targetType: "recovery_case", targetId: c.id,
          diff: { attemptNo: reservation2.attemptNo, reason: execution?.errorCode ?? row?.errorCode ?? "refused", actor: "system" },
          ip: opts.ip, userAgent: opts.userAgent
        });
      }
    });
    if (status === "succeeded") {
      await markCaseRecovered(ctx, c.id);
    } else if (status === "failed") {
      const post = await gatherFacts(db, ctx.org.id, c, (await withOrgTx(db, ctx.org.id, (tx) =>
        tx.select().from(schema.payments).where(eq(schema.payments.id, p.id))))[0]!);
      const freshDecision = evaluateRetryEligibility(post.facts, post.policy);
      if (freshDecision.reason === "max_auto_retries" || freshDecision.reason === "give_up_after_days") {
        await markCaseLost(ctx, c.id, freshDecision.reason);
      }
    }
  }
  return summary;
}
