/**
 * Typed BullMQ queue for the `notes` queue (architecture §10.1: "drafts +
 * sends") — Phase 6. Same durable-first discipline as `retries`: the
 * job_runs row is created BEFORE the Redis job under a deterministic
 * identity, so duplicate discovery, duplicate delivery and Redis loss all
 * converge on ONE logical communication job. Payloads carry identifiers
 * only — never copy, recipients, amounts or provider data.
 */
import { Queue } from "bullmq";
import { z } from "zod";
import type { Db } from "@revessent/db";
import * as schema from "@revessent/db";
import { log, withoutConnectionDetails } from "../logger.js";
import { createLiveJob } from "../durable/jobs.js";
import { createQueueConnection } from "./retries.js";

export const NOTES_QUEUE = "notes" as const;
export const COMM_PREPARE_JOB = "communication.prepare" as const;
export const COMM_SEND_JOB = "communication.send" as const;

export const CommunicationPreparePayload = z.object({
  jobRunId: z.string().uuid(),
  orgId: z.string().uuid(),
  caseId: z.string().uuid(),
  trigger: z.enum(["retry_failed", "case_lost"])
}).strict();
export type CommunicationPreparePayload = z.infer<typeof CommunicationPreparePayload>;

export const CommunicationSendPayload = z.object({
  jobRunId: z.string().uuid(),
  orgId: z.string().uuid(),
  caseId: z.string().uuid(),
  messageId: z.string().uuid()
}).strict();
export type CommunicationSendPayload = z.infer<typeof CommunicationSendPayload>;

export type NotesPayload = CommunicationPreparePayload | CommunicationSendPayload;

/** One live prepare per org+case+trigger. */
export function commPrepareDedupeKey(orgId: string, caseId: string, trigger: "retry_failed" | "case_lost"): string {
  return `comm-prepare:${orgId}:${caseId}:${trigger}`;
}
/** One live send per message (the message id IS the logical communication). */
export function commSendDedupeKey(orgId: string, messageId: string): string {
  return `comm-send:${orgId}:${messageId}`;
}

/**
 * BullMQ custom job ids may not contain ':' (except the legacy 3-segment
 * shape). The DURABLE identity stays the dedupe key; the Redis id is a
 * deterministic, reversible encoding of it (same key ⇒ same id).
 */
export function notesRedisJobId(dedupeKey: string): string {
  return dedupeKey.replace(/:/g, "__");
}

export function createNotesQueue(redisUrl: string, opts: Partial<import("ioredis").RedisOptions> = {}): Queue<NotesPayload> {
  return new Queue<NotesPayload>(NOTES_QUEUE, { connection: createQueueConnection(redisUrl, opts) });
}

export interface NotesEnqueueResult {
  enqueued: boolean;
  jobRunId: string;
  reason?: "live_job_exists" | "redis_unavailable";
}

const JOB_OPTS = (runAfter: Date, maxAttempts: number) => ({
  delay: Math.max(0, runAfter.getTime() - Date.now()),
  attempts: maxAttempts,
  backoff: { type: "exponential" as const, delay: 5_000 },
  removeOnComplete: true,
  removeOnFail: false
});

export async function enqueueCommunicationPrepare(
  queue: Queue<NotesPayload>, db: Db,
  input: { orgId: string; caseId: string; trigger: "retry_failed" | "case_lost"; runAfter?: Date; maxAttempts?: number }
): Promise<NotesEnqueueResult> {
  const dedupeKey = commPrepareDedupeKey(input.orgId, input.caseId, input.trigger);
  const runAfter = input.runAfter ?? new Date();
  const maxAttempts = input.maxAttempts ?? 5;
  const outcome = await createLiveJob(db, {
    orgId: input.orgId, caseId: input.caseId, jobType: COMM_PREPARE_JOB, queue: NOTES_QUEUE, dedupeKey, runAfter, maxAttempts
  });
  if (!outcome?.row) return { enqueued: false, jobRunId: "unknown", reason: "live_job_exists" };
  if (!outcome.created) return { enqueued: false, jobRunId: outcome.row.id, reason: "live_job_exists" };
  try {
    await queue.add(COMM_PREPARE_JOB, { jobRunId: outcome.row.id, orgId: input.orgId, caseId: input.caseId, trigger: input.trigger },
      { jobId: notesRedisJobId(dedupeKey), ...JOB_OPTS(runAfter, maxAttempts) });
    return { enqueued: true, jobRunId: outcome.row.id };
  } catch (err) {
    log.warn(`redis enqueue failed — durable prepare job stays queued: ${withoutConnectionDetails((err as Error).message)}`, { jobRunId: outcome.row.id });
    return { enqueued: false, jobRunId: outcome.row.id, reason: "redis_unavailable" };
  }
}

export async function enqueueCommunicationSend(
  queue: Queue<NotesPayload>, db: Db,
  input: { orgId: string; caseId: string; messageId: string; runAfter?: Date; maxAttempts?: number }
): Promise<NotesEnqueueResult> {
  const dedupeKey = commSendDedupeKey(input.orgId, input.messageId);
  const runAfter = input.runAfter ?? new Date();
  const maxAttempts = input.maxAttempts ?? 5;
  const outcome = await createLiveJob(db, {
    orgId: input.orgId, caseId: input.caseId, jobType: COMM_SEND_JOB, queue: NOTES_QUEUE, dedupeKey, runAfter, maxAttempts
  });
  if (!outcome?.row) return { enqueued: false, jobRunId: "unknown", reason: "live_job_exists" };
  if (!outcome.created) return { enqueued: false, jobRunId: outcome.row.id, reason: "live_job_exists" };
  try {
    await queue.add(COMM_SEND_JOB, { jobRunId: outcome.row.id, orgId: input.orgId, caseId: input.caseId, messageId: input.messageId },
      { jobId: notesRedisJobId(dedupeKey), ...JOB_OPTS(runAfter, maxAttempts) });
    return { enqueued: true, jobRunId: outcome.row.id };
  } catch (err) {
    log.warn(`redis enqueue failed — durable send job stays queued: ${withoutConnectionDetails((err as Error).message)}`, { jobRunId: outcome.row.id });
    return { enqueued: false, jobRunId: outcome.row.id, reason: "redis_unavailable" };
  }
}

/** Redis-loss re-enqueue for a durable notes row: same id, same row. The
 *  payload is reconstructed from the dedupe key (identifiers only). */
export async function reenqueueNotesJob(queue: Queue<NotesPayload>, row: typeof schema.jobRuns.$inferSelect): Promise<boolean> {
  if (!row.caseId) return false;
  try {
    if (row.jobType === COMM_PREPARE_JOB) {
      const trigger = row.dedupeKey.split(":").pop();
      if (trigger !== "retry_failed" && trigger !== "case_lost") return false;
      await queue.add(COMM_PREPARE_JOB, { jobRunId: row.id, orgId: row.orgId, caseId: row.caseId, trigger },
        { jobId: notesRedisJobId(row.dedupeKey), ...JOB_OPTS(row.runAfter, row.maxAttempts) });
      return true;
    }
    if (row.jobType === COMM_SEND_JOB) {
      const messageId = row.dedupeKey.split(":").pop();
      if (!messageId) return false;
      await queue.add(COMM_SEND_JOB, { jobRunId: row.id, orgId: row.orgId, caseId: row.caseId, messageId },
        { jobId: notesRedisJobId(row.dedupeKey), ...JOB_OPTS(row.runAfter, row.maxAttempts) });
      return true;
    }
    return false;
  } catch (err) {
    log.warn(`redis re-enqueue failed — durable notes row stays queued: ${withoutConnectionDetails((err as Error).message)}`, { jobRunId: row.id });
    return false;
  }
}
