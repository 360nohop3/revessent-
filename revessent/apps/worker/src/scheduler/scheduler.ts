/**
 * Scheduler / dispatcher (Phase 5 §8). Turns durable due work into queue
 * deliveries. It discovers CANDIDATES only — the exact candidate shape Phase
 * 4D itself uses (status retrying|contacting, payment failed,
 * next_action_at due). It NEVER decides eligibility: enqueued jobs are
 * delivered to `runDueRetries`, which re-checks everything under its own
 * locks. Properties:
 *   - repeatable + idempotent: deterministic dedupe key + one-live-job DB index
 *   - safe with multiple instances: duplicate discovery converges on the same
 *     job_runs row and the same BullMQ jobId
 *   - bounded: at most scanLimit cases per org and orgLimit orgs per cycle
 *   - tenant-aware: every per-org scan/insert is RLS-scoped (withOrgTx)
 *   - crash-safe: the durable row exists before the Redis job; reconciliation
 *     heals any gap
 */
import type { Queue } from "bullmq";
import { withoutOrg, type Db } from "@revessent/db";
import * as schema from "@revessent/db";
import type { RetryExecutePayload } from "../queues/retries.js";
import { enqueueRetryExecution } from "../queues/retries.js";
import { findDueWork } from "../durable/jobs.js";
import { reconcileOrgJobsWithRedis, reconcileOrgNotesWithRedis } from "../recovery/recovery.js";
import { communicationService } from "@revessent/server";
import { enqueueCommunicationPrepare, enqueueCommunicationSend, type NotesPayload } from "../queues/notes.js";
import { log } from "../logger.js";

export interface SchedulerDeps {
  /** Application-role connection (RLS) — all tenant scans/inserts. */
  db: Db;
  /** Privileged connection — organization ID enumeration ONLY (see context.ts). */
  systemDb: Db;
  queue: Queue<RetryExecutePayload>;
  /** Phase 6: the `notes` queue (communication prepare/send). Optional so
   *  Phase 5 callers/tests are unchanged; absent ⇒ no communication discovery. */
  notesQueue?: Queue<NotesPayload>;
  scanLimit: number;
  orgLimit: number;
  redisRecoveryLimit?: number;
  blockedCooldownMs?: number;
}

export interface CycleStats {
  orgs: number;
  discovered: number;
  enqueued: number;
  skippedLive: number;
  redisReenqueued: number;
  /** Phase 6 communication discovery (0 when notesQueue is absent). */
  commPrepareEnqueued: number;
  commSendEnqueued: number;
}

async function enumerateOrgIds(systemDb: Db, limit: number): Promise<string[]> {
  const rows = await withoutOrg(systemDb, (tx) =>
    tx.select({ id: schema.organizations.id }).from(schema.organizations).limit(limit));
  return rows.map((r) => r.id);
}

export async function cycleOrg(deps: SchedulerDeps, orgId: string, now = new Date()): Promise<CycleStats> {
  const stats: CycleStats = { orgs: 1, discovered: 0, enqueued: 0, skippedLive: 0, redisReenqueued: 0, commPrepareEnqueued: 0, commSendEnqueued: 0 };

  // (a) Redis-loss reconciliation FIRST: durable rows missing from Redis are
  // re-enqueued before discovery adds anything new.
  const rec = await reconcileOrgJobsWithRedis(deps.db, deps.queue, orgId, deps.redisRecoveryLimit ?? deps.scanLimit * 2);
  stats.redisReenqueued += rec.reenqueued;

  // (b) discovery of due durable work (candidates only — 4D decides).
  const due = await findDueWork(deps.db, orgId, deps.scanLimit, now, deps.blockedCooldownMs);
  stats.discovered += due.length;
  for (const d of due) {
    const res = await enqueueRetryExecution(deps.queue, deps.db, { orgId, caseId: d.caseId, runAfter: now });
    if (res.enqueued) stats.enqueued += 1;
    else stats.skippedLive += 1;
  }

  // (c) Phase 6 communication discovery — CANDIDATES only; the
  // communication service re-runs the deterministic policy on delivery.
  // Nothing here touches payments, attempts or retry scheduling.
  if (deps.notesQueue) {
    const notesRec = await reconcileOrgNotesWithRedis(deps.db, deps.notesQueue, orgId, deps.redisRecoveryLimit ?? deps.scanLimit * 2);
    stats.redisReenqueued += notesRec.reenqueued;
    const candidates = await communicationService.findCommunicationCandidates(deps.db, orgId, deps.scanLimit);
    for (const c of candidates) {
      const res = await enqueueCommunicationPrepare(deps.notesQueue, deps.db, { orgId, caseId: c.caseId, trigger: c.trigger, runAfter: now });
      if (res.enqueued) stats.commPrepareEnqueued += 1;
    }
    const due = await communicationService.findDueSends(deps.db, orgId, deps.scanLimit, now);
    for (const d of due) {
      const res = await enqueueCommunicationSend(deps.notesQueue, deps.db, { orgId, caseId: d.caseId, messageId: d.messageId, runAfter: now });
      if (res.enqueued) stats.commSendEnqueued += 1;
    }
  }
  return stats;
}

/** One full multi-tenant cycle: enumerate orgs (privileged, bounded) and run
 *  a scoped cycle per org. Idempotent — duplicate discovery converges on the
 *  durable live-row uniqueness. */
export async function schedulerCycle(deps: SchedulerDeps): Promise<CycleStats> {
  const stats: CycleStats = { orgs: 0, discovered: 0, enqueued: 0, skippedLive: 0, redisReenqueued: 0, commPrepareEnqueued: 0, commSendEnqueued: 0 };
  const orgIds = await enumerateOrgIds(deps.systemDb, deps.orgLimit);
  stats.orgs = orgIds.length;
  const now = new Date();

  for (const orgId of orgIds) {
    const orgStats = await cycleOrg(deps, orgId, now);
    stats.redisReenqueued += orgStats.redisReenqueued;
    stats.discovered += orgStats.discovered;
    stats.enqueued += orgStats.enqueued;
    stats.skippedLive += orgStats.skippedLive;
    stats.commPrepareEnqueued += orgStats.commPrepareEnqueued;
    stats.commSendEnqueued += orgStats.commSendEnqueued;
  }
  if (stats.enqueued > 0 || stats.redisReenqueued > 0 || stats.commPrepareEnqueued > 0 || stats.commSendEnqueued > 0) {
    log.info("scheduler cycle", {
      orgs: stats.orgs, discovered: stats.discovered, enqueued: stats.enqueued, redisReenqueued: stats.redisReenqueued,
      commPrepareEnqueued: stats.commPrepareEnqueued, commSendEnqueued: stats.commSendEnqueued
    });
  }
  return stats;
}

/** Repeating scheduler loop (§8): fixed interval, never overlapping itself. */
export class RetryScheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  lastCycleAt: Date | null = null;
  lastStats: CycleStats | null = null;
  cycleErrors = 0;

  constructor(private readonly deps: SchedulerDeps) {}

  start(intervalMs: number): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.running) return; // never overlap cycles
      this.running = true;
      schedulerCycle(this.deps)
        .then((stats) => {
          this.lastCycleAt = new Date();
          this.lastStats = stats;
        })
        .catch((err) => {
          this.cycleErrors += 1;
          this.lastCycleAt = new Date();
          log.warn(`scheduler cycle failed: ${(err as Error).message}`);
        })
        .finally(() => {
          this.running = false;
        });
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}
