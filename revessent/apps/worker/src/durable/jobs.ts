/**
 * Durable job lifecycle (Phase 5 §5). State machine on job_runs.status:
 *
 *   queued ──claim──▶ leased ──complete──▶ succeeded
 *     ▲                  │  └─infra failure─▶ queued (requeue, backoff)
 *     │                  └────lease expired──▶ (stale: claim reclaims it)
 *     └─ canceled (target/org gone — terminal, harmless)
 *   attempts ≥ maxAttempts after infra failures ──▶ failed (dead-lettered;
 *   replay is an admin operation, never automatic)
 *
 * All transitions are conditional single UPDATEs under RLS org scope — two
 * workers racing to claim the same row cannot both win (the loser's UPDATE
 * matches zero rows).
 */
import { and, asc, eq, inArray, lte, notExists, sql } from "drizzle-orm";
import { withOrgTx, type Db } from "@revessent/db";
import * as schema from "@revessent/db";

export type JobStatus = "queued" | "leased" | "succeeded" | "failed" | "canceled";
export type JobOutcome =
  | "executed" | "blocked" | "waiting" | "exhausted" | "disabled"
  | "not_due" | "no_such_case";

export type JobRow = typeof schema.jobRuns.$inferSelect;

/** Creates the live job row, or returns the existing live one (never two). */
export async function createLiveJob(
  db: Db,
  input: { orgId: string; caseId: string; jobType: string; queue: string; dedupeKey: string; runAfter: Date; maxAttempts: number }
): Promise<{ row: JobRow; created: boolean }> {
  return withOrgTx(db, input.orgId, async (tx) => {
    const [row] = await tx.insert(schema.jobRuns).values({
      orgId: input.orgId,
      queue: input.queue,
      jobType: input.jobType,
      dedupeKey: input.dedupeKey,
      caseId: input.caseId,
      status: "queued",
      maxAttempts: input.maxAttempts,
      runAfter: input.runAfter
    }).onConflictDoNothing().returning();
    if (row) return { row, created: true };
    const [existing] = await tx.select().from(schema.jobRuns)
      .where(and(
        eq(schema.jobRuns.orgId, input.orgId),
        eq(schema.jobRuns.dedupeKey, input.dedupeKey),
        inArray(schema.jobRuns.status, ["queued", "leased"])));
    return { row: existing!, created: false };
  });
}

/** The live rows for one org (bounded) — the Redis-loss recovery scan set. */
export async function findLiveJobs(db: Db, orgId: string, limit: number): Promise<JobRow[]> {
  return withOrgTx(db, orgId, (tx) =>
    tx.select().from(schema.jobRuns)
      .where(and(eq(schema.jobRuns.orgId, orgId), inArray(schema.jobRuns.status, ["queued", "leased"])))
      .orderBy(asc(schema.jobRuns.createdAt))
      .limit(limit));
}

/**
 * Atomic claim: `queued`, or a STALE lease (`lease_expires_at < now`). A live
 * lease held by another worker never matches — concurrent claims converge to
 * exactly one winner.
 */
export async function claimJob(
  db: Db, orgId: string, jobRunId: string, leaseMs: number, now: Date
): Promise<JobRow | null> {
  const [row] = await withOrgTx(db, orgId, (tx) =>
    tx.update(schema.jobRuns).set({
      status: "leased",
      leasedAt: now,
      leaseExpiresAt: new Date(now.getTime() + leaseMs),
      attempts: sql`${schema.jobRuns.attempts} + 1`,
      lastAttemptedAt: now,
      updatedAt: now
    }).where(and(
      eq(schema.jobRuns.id, jobRunId),
      eq(schema.jobRuns.orgId, orgId),
      sql`(${schema.jobRuns.status} = 'queued' or (${schema.jobRuns.status} = 'leased' and ${schema.jobRuns.leaseExpiresAt} < ${now}))`
    )).returning());
  return row ?? null;
}

/** Terminal success with the Phase 4D delivery verdict. */
export async function completeJob(db: Db, orgId: string, jobRunId: string, outcome: JobOutcome): Promise<boolean> {
  const now = new Date();
  const [row] = await withOrgTx(db, orgId, (tx) =>
    tx.update(schema.jobRuns).set({
      status: "succeeded", outcome, finishedAt: now, updatedAt: now,
      leasedAt: null, leaseExpiresAt: null
    }).where(and(
      eq(schema.jobRuns.id, jobRunId),
      eq(schema.jobRuns.orgId, orgId),
      inArray(schema.jobRuns.status, ["queued", "leased"])
    )).returning());
  return Boolean(row);
}

/** Terminal cancel (target/org gone) — visible history, no delivery. */
export async function cancelJob(db: Db, orgId: string, jobRunId: string, reason: string): Promise<boolean> {
  const now = new Date();
  const [row] = await withOrgTx(db, orgId, (tx) =>
    tx.update(schema.jobRuns).set({
      status: "canceled", outcome: reason, finishedAt: now, updatedAt: now,
      leasedAt: null, leaseExpiresAt: null
    }).where(and(
      eq(schema.jobRuns.id, jobRunId),
      eq(schema.jobRuns.orgId, orgId),
      inArray(schema.jobRuns.status, ["queued", "leased"])
    )).returning());
  return Boolean(row);
}

/**
 * Infrastructure-failure bookkeeping (§10.2 backoff). The row goes back to
 * `queued` so redelivery can claim it — until the attempt budget is spent,
 * then it dead-letters as terminal `failed`. Never records provider bodies:
 * only a safe category + code.
 */
export async function recordInfraFailure(
  db: Db, orgId: string, jobRunId: string,
  error: { category: string; code: string }
): Promise<"queued" | "failed"> {
  const now = new Date();
  const [row] = await withOrgTx(db, orgId, (tx) =>
    tx.update(schema.jobRuns).set({
      status: sql`case when ${schema.jobRuns.attempts} >= ${schema.jobRuns.maxAttempts} then 'failed' else 'queued' end`,
      lastErrorCategory: error.category,
      lastErrorCode: error.code,
      lastAttemptedAt: now,
      finishedAt: sql`case when ${schema.jobRuns.attempts} >= ${schema.jobRuns.maxAttempts} then ${now}::timestamptz else null end`,
      updatedAt: now,
      leasedAt: null,
      leaseExpiresAt: null
    }).where(and(
      eq(schema.jobRuns.id, jobRunId),
      eq(schema.jobRuns.orgId, orgId),
      inArray(schema.jobRuns.status, ["queued", "leased"])
    )).returning());
  return (row?.status as "queued" | "failed") ?? "failed";
}

/** Terminal rows for one org (bounded) — observability / housekeeping reads. */
export async function findRecentTerminalJobs(db: Db, orgId: string, limit: number): Promise<JobRow[]> {
  return withOrgTx(db, orgId, (tx) =>
    tx.select().from(schema.jobRuns)
      .where(and(eq(schema.jobRuns.orgId, orgId), inArray(schema.jobRuns.status, ["succeeded", "failed", "canceled"])))
      .orderBy(sql`${schema.jobRuns.createdAt} desc`)
      .limit(limit));
}

/**
 * Scheduler DISCOVERY (not decisions): the due-case candidate query mirrors
 * Phase 4D's own candidate selection (status retrying|contacting, payment
 * failed, next_action_at due). Cases with `next_action_at NULL` — including
 * every unknown-outcome case — are never discovered: an unknown financial
 * outcome is never automatically retried (4C/4D boundary).
 */
export async function findDueWork(
  db: Db, orgId: string, limit: number, now: Date, blockedCooldownMs = 24 * 3_600_000
): Promise<Array<{ caseId: string; nextActionAt: Date | null }>> {
  // Delivery-rate control (§8 amplification guard), NOT an eligibility
  // decision: a case whose latest delivery already ended blocked/disabled/
  // exhausted is not re-discovered until the cool-off elapses. The engine
  // re-decides on every delivery that actually happens.
  const cutoff = new Date(now.getTime() - blockedCooldownMs);
  // (drizzle's notExists supplies the `not exists` prefix)
  const recentlyRefused = sql`(
    select 1 from job_runs jr
      where jr.org_id = ${schema.recoveryCases.orgId}
        and jr.case_id = ${schema.recoveryCases.id}
        and jr.outcome in ('blocked', 'disabled', 'exhausted')
        and jr.finished_at > ${cutoff}
  )`;
  // a case with an already-live (queued/leased) job is not re-discovered —
  // the durable dedupe row IS the in-flight marker
  const hasLiveJob = sql`(
    select 1 from job_runs jr2
      where jr2.org_id = ${schema.recoveryCases.orgId}
        and jr2.case_id = ${schema.recoveryCases.id}
        and jr2.status in ('queued', 'leased')
  )`;
  return withOrgTx(db, orgId, (tx) =>
    tx.select({ caseId: schema.recoveryCases.id, nextActionAt: schema.recoveryCases.nextActionAt })
      .from(schema.recoveryCases)
      .innerJoin(schema.payments, eq(schema.recoveryCases.paymentId, schema.payments.id))
      .where(and(
        eq(schema.recoveryCases.orgId, orgId),
        inArray(schema.recoveryCases.status, ["retrying", "contacting"]),
        eq(schema.payments.status, "failed"),
        lte(schema.recoveryCases.nextActionAt, now),
        notExists(recentlyRefused),
        notExists(hasLiveJob)
      ))
      .orderBy(asc(schema.recoveryCases.nextActionAt))
      .limit(limit));
}
