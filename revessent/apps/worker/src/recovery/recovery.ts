/**
 * Redis-loss recovery (Phase 5 §9). The durable job_runs rows are the source
 * of truth for WHAT work exists; Redis only carries deliveries. After Redis
 * loses state (restart, flush, eviction, outage) this scan reconstructs
 * deliveries from Postgres:
 *
 *   live `queued` row whose Redis job is gone          ⇒ re-enqueue (same jobId)
 *   live `leased` row whose lease EXPIRED              ⇒ re-enqueue; the claim
 *                                                          step reclaims atomically
 *   live `leased` row, lease still valid               ⇒ actively running — untouched
 *   terminal rows (succeeded|failed|canceled)          ⇒ never re-enqueued
 *
 * No stale job is executed blindly: every redelivery lands in the same
 * processor, which verifies the durable row, re-claims atomically, and lets
 * Phase 4D re-check eligibility under its own locks before Phase 4C executes.
 */
import type { Queue } from "bullmq";
import { and, eq, inArray, lt } from "drizzle-orm";
import { withOrgTx, type Db } from "@revessent/db";
import * as schema from "@revessent/db";
import type { RetryExecutePayload } from "../queues/retries.js";
import { reenqueueExistingJob, RETRY_EXECUTE_JOB, RETRIES_QUEUE } from "../queues/retries.js";
import { NOTES_QUEUE, notesRedisJobId, reenqueueNotesJob, type NotesPayload } from "../queues/notes.js";
import { log, withoutConnectionDetails } from "../logger.js";

export interface RecoveryStats {
  scanned: number;
  reenqueued: number;
  skippedActiveLease: number;
  skippedNoTarget: number;
}

/** Scans ONE org's live job rows and re-enqueues whatever Redis lost. */
export async function reconcileOrgJobsWithRedis(
  db: Db,
  queue: Queue<RetryExecutePayload>,
  orgId: string,
  limit: number
): Promise<RecoveryStats> {
  const stats: RecoveryStats = { scanned: 0, reenqueued: 0, skippedActiveLease: 0, skippedNoTarget: 0 };
  const now = new Date();

  const rows = await withOrgTx(db, orgId, (tx) =>
    tx.select().from(schema.jobRuns)
      .where(and(
        eq(schema.jobRuns.orgId, orgId),
        eq(schema.jobRuns.queue, RETRIES_QUEUE),
        eq(schema.jobRuns.jobType, RETRY_EXECUTE_JOB),
        inArray(schema.jobRuns.status, ["queued", "leased"])
      ))
      .limit(limit));
  stats.scanned = rows.length;

  for (const row of rows) {
    if (row.status === "leased" && row.leaseExpiresAt && row.leaseExpiresAt.getTime() > now.getTime()) {
      stats.skippedActiveLease += 1; // actively running on a live worker
      continue;
    }
    // Per-row isolation: one Redis hiccup must not abort the org's recovery
    // cycle — the durable row stays queued and the next cycle retries it.
    try {
      const existing = await queue.getJob(row.dedupeKey);
      if (existing) {
        // Redis still holds the delivery (waiting/delayed/active). A queued row
        // is covered; a stale lease is reclaimed at claim time on redelivery.
        continue;
      }
      if (!row.caseId) {
        stats.skippedNoTarget += 1;
        continue;
      }
      const ok = await reenqueueExistingJob(queue, row);
      if (ok) {
        stats.reenqueued += 1;
        log.info("redis-loss recovery re-enqueued durable job", {
          jobRunId: row.id, orgId: row.orgId, dedupeKey: row.dedupeKey, jobType: row.jobType
        });
      }
    } catch (err) {
      log.warn(`redis-loss recovery probe failed — durable row stays queued: ${withoutConnectionDetails((err as Error).message)}`, {
        jobRunId: row.id
      });
    }
  }
  return stats;
}

/**
 * Phase 6: the same reconstruction for the `notes` queue (communication
 * prepare/send jobs). Terminal rows are never resurrected; a live lease is
 * untouched; the payload is rebuilt from the durable identity only.
 */
export async function reconcileOrgNotesWithRedis(
  db: Db, queue: Queue<NotesPayload>, orgId: string, limit: number
): Promise<RecoveryStats> {
  const stats: RecoveryStats = { scanned: 0, reenqueued: 0, skippedActiveLease: 0, skippedNoTarget: 0 };
  const now = new Date();
  const rows = await withOrgTx(db, orgId, (tx) =>
    tx.select().from(schema.jobRuns)
      .where(and(
        eq(schema.jobRuns.orgId, orgId),
        eq(schema.jobRuns.queue, NOTES_QUEUE),
        inArray(schema.jobRuns.status, ["queued", "leased"])
      ))
      .limit(limit));
  stats.scanned = rows.length;
  for (const row of rows) {
    if (row.status === "leased" && row.leaseExpiresAt && row.leaseExpiresAt.getTime() > now.getTime()) {
      stats.skippedActiveLease += 1;
      continue;
    }
    try {
      const existing = await queue.getJob(notesRedisJobId(row.dedupeKey));
      if (existing) continue;
      if (!row.caseId) { stats.skippedNoTarget += 1; continue; }
      if (await reenqueueNotesJob(queue, row)) {
        stats.reenqueued += 1;
        log.info("redis-loss recovery re-enqueued durable notes job", { jobRunId: row.id, orgId: row.orgId, dedupeKey: row.dedupeKey, jobType: row.jobType });
      }
    } catch (err) {
      log.warn(`redis-loss notes recovery probe failed — durable row stays queued: ${withoutConnectionDetails((err as Error).message)}`, { jobRunId: row.id });
    }
  }
  return stats;
}

/** Stale-lease visibility for one org (§11): rows that LOOK running but whose
 *  lease expired. The claim step reclaims them; this read exists for logs and
 *  tests. Unknown financial outcomes are NOT touched here — they stay blocked
 *  at the Phase 4C reconciliation boundary. */
export async function findStaleLeases(db: Db, orgId: string, now: Date): Promise<Array<typeof schema.jobRuns.$inferSelect>> {
  return withOrgTx(db, orgId, (tx) =>
    tx.select().from(schema.jobRuns)
      .where(and(
        eq(schema.jobRuns.orgId, orgId),
        eq(schema.jobRuns.status, "leased"),
        lt(schema.jobRuns.leaseExpiresAt, now)
      )));
}
