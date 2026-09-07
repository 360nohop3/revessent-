/**
 * Typed BullMQ queue for the `retries` money queue (architecture §10.1/§10.2)
 * plus the durable-first enqueue helper. The job_runs row is created BEFORE
 * the Redis job: if Redis is unavailable the work stays queued in Postgres and
 * the Redis-loss recovery re-enqueues it — Redis is never the only copy.
 */
import { Queue } from "bullmq";
import Redis from "ioredis";
import { z } from "zod";
import type { Db } from "@revessent/db";
import * as schema from "@revessent/db";
import { log, withoutConnectionDetails } from "../logger.js";
import { createLiveJob } from "../durable/jobs.js";

export const RETRIES_QUEUE = "retries" as const;
export const RETRY_EXECUTE_JOB = "retry.execute" as const;

/** Queue payload — identifiers only (§13/§14): no financial parameters, no
 *  secrets, no organization name. Every field is verified against the durable
 *  job_runs row before any work happens. */
export const RetryExecutePayload = z.object({
  jobRunId: z.string().uuid(),
  orgId: z.string().uuid(),
  caseId: z.string().uuid()
}).strict(); // identifiers ONLY — foreign/financial fields make the payload invalid
export type RetryExecutePayload = z.infer<typeof RetryExecutePayload>;

/** Deterministic business identity (§10.2 keyed dedupe): one live delivery per
 *  org+case regardless of how often discovery or duplicate enqueues run. */
export function retryExecuteDedupeKey(orgId: string, caseId: string): string {
  return `retry-exec:${orgId}:${caseId}`;
}

/** Queue-side Redis connection: offline queue DISABLED so enqueue fails fast
 *  (durable-first) instead of silently buffering while Redis is down. */
export function createQueueConnection(
  redisUrl: string,
  opts: Partial<import("ioredis").RedisOptions> = {}
): Redis {
  const conn = new Redis(redisUrl, { maxRetriesPerRequest: null, enableOfflineQueue: false, ...opts });
  // ioredis emits 'error' on outages; unhandled it would crash the process.
  // BullMQ owns reconnection — we only observe (never log the URL: creds).
  conn.on("error", () => { /* observed; recovery is durable-first */ });
  return conn;
}

export function createRetriesQueue(
  redisUrl: string,
  opts: Partial<import("ioredis").RedisOptions> = {}
): Queue<RetryExecutePayload> {
  return new Queue<RetryExecutePayload>(RETRIES_QUEUE, { connection: createQueueConnection(redisUrl, opts) });
}

export interface EnqueueResult {
  enqueued: boolean;
  jobRunId: string;
  reason?: "live_job_exists" | "redis_unavailable";
}

/**
 * Durable-first enqueue: creates (or finds) the live job_runs row, then adds
 * the BullMQ job under the DETERMINISTIC jobId. BullMQ ignores re-adds of a
 * live identical jobId, and the DB partial unique index admits only one live
 * row per key — duplicate delivery cannot create duplicate logical work.
 * If Redis is down the row remains `queued` and recovery re-enqueues later.
 */
export async function enqueueRetryExecution(
  queue: Queue<RetryExecutePayload>,
  db: Db,
  input: { orgId: string; caseId: string; runAfter?: Date; maxAttempts?: number }
): Promise<EnqueueResult> {
  const dedupeKey = retryExecuteDedupeKey(input.orgId, input.caseId);
  const runAfter = input.runAfter ?? new Date();
  const maxAttempts = input.maxAttempts ?? 5;

  // Durable-first insert-or-find lives in ONE place (durable/jobs.ts §10):
  // the partial unique index admits only one live row per key, so duplicate
  // discovery converges on the same logical job.
  const outcome = await createLiveJob(db, {
    orgId: input.orgId, caseId: input.caseId, jobType: RETRY_EXECUTE_JOB,
    queue: RETRIES_QUEUE, dedupeKey, runAfter, maxAttempts
  });

  if (!outcome?.row) return { enqueued: false, jobRunId: "unknown", reason: "live_job_exists" };
  // An identical live job already exists: do NOT re-add (§8 amplification
  // guard). The durable row is the authority; Redis recovery re-adds by id.
  if (!outcome.created) return { enqueued: false, jobRunId: outcome.row.id, reason: "live_job_exists" };

  try {
    await queue.add(RETRY_EXECUTE_JOB, { jobRunId: outcome.row.id, orgId: input.orgId, caseId: input.caseId }, {
      jobId: dedupeKey,
      delay: Math.max(0, runAfter.getTime() - Date.now()),
      attempts: maxAttempts,
      backoff: { type: "exponential", delay: 5_000 }, // §10.2: exponential backoff, 5 attempts
      removeOnComplete: true, // free the deterministic identity once delivered
      removeOnFail: false     // failed set = dead-letter (admin replay, §10.2)
    });
    return { enqueued: true, jobRunId: outcome.row.id };
  } catch (err) {
    log.warn(`redis enqueue failed — durable job row stays queued for recovery: ${withoutConnectionDetails((err as Error).message)}`, {
      jobRunId: outcome.row.id
    });
    return { enqueued: false, jobRunId: outcome.row.id, reason: "redis_unavailable" };
  }
}

/** Re-enqueue path used by Redis-loss recovery: same deterministic jobId, same
 *  durable row — never a second logical job. */
export async function reenqueueExistingJob(
  queue: Queue<RetryExecutePayload>,
  row: typeof schema.jobRuns.$inferSelect
): Promise<boolean> {
  if (!row.caseId) return false; // target deleted — nothing to deliver
  try {
    await queue.add(RETRY_EXECUTE_JOB, { jobRunId: row.id, orgId: row.orgId, caseId: row.caseId }, {
      jobId: row.dedupeKey,
      delay: Math.max(0, row.runAfter.getTime() - Date.now()),
      attempts: row.maxAttempts,
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: true,
      removeOnFail: false
    });
    return true;
  } catch (err) {
    log.warn(`redis re-enqueue failed — durable row stays queued: ${withoutConnectionDetails((err as Error).message)}`, {
      jobRunId: row.id
    });
    return false;
  }
}
