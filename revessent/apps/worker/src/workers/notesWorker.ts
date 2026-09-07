/**
 * The `notes` queue consumer (Phase 6): a DELIVERY mechanism into the
 * communication service. It decides nothing about whether/how to
 * communicate — it verifies the durable job (RLS-scoped as the payload's
 * org), claims it atomically, and hands the case/message to
 * `communicationService.prepareCommunication` / `deliverCommunication`,
 * which re-read authoritative facts and re-run the deterministic policy.
 *
 * Duplicate/at-least-once delivery converges exactly as in Phase 5:
 *   terminal durable row / live lease elsewhere / claim race ⇒ ack, no work
 *   business refusal (not_allowed, suppressed, not_due …) ⇒ job succeeds
 *   transient email failure ⇒ durable bookkeeping + BullMQ backoff
 *   configuration failure (no/rejected credentials) ⇒ job succeeds with
 *                            `deferred_configuration`; no retry budget is
 *                            consumed — discovery re-enqueues once fixed
 *   ambiguous email result ⇒ job succeeds with outcome `unknown` — the
 *                            message is NEVER auto-resent (reconciliation)
 */
import { Worker, type Job } from "bullmq";
import Redis from "ioredis";
import { and, eq } from "drizzle-orm";
import { withOrgTx, type Db } from "@revessent/db";
import * as schema from "@revessent/db";
import { communicationService, type OrgContext } from "@revessent/server";
import {
  CommunicationPreparePayload, CommunicationSendPayload, NOTES_QUEUE, COMM_PREPARE_JOB, COMM_SEND_JOB,
  type NotesPayload
} from "../queues/notes.js";
import { cancelJob, claimJob, completeJob, recordInfraFailure, type JobOutcome } from "../durable/jobs.js";
import { systemOrgContext } from "../context.js";
import { log, withoutConnectionDetails, type JobLogFields } from "../logger.js";

export interface NotesWorkerDeps {
  db: Db;
  systemDb: Db;
  leaseMs: number;
  concurrency: number;
  redisUrl: string;
}

export type NotesProcessorResult = { result: string };

/** Delivery outcomes recorded on job_runs.outcome for notes jobs. */
export type NotesOutcome = JobOutcome | "prepared" | "exists" | "not_allowed" | "sent" | "already_sent" | "suppressed" | "not_approved" | "failed_permanent" | "unknown" | "claimed_elsewhere" | "no_such_message" | "deferred_configuration";

export function notesProcessor(deps: NotesWorkerDeps) {
  return async (job: Job<NotesPayload>): Promise<NotesProcessorResult> => {
    const startedAt = Date.now();
    const isPrepare = job.name === COMM_PREPARE_JOB;
    const parsed = isPrepare ? CommunicationPreparePayload.safeParse(job.data) : CommunicationSendPayload.safeParse(job.data);
    if (!parsed.success || (job.name !== COMM_PREPARE_JOB && job.name !== COMM_SEND_JOB)) {
      log.warn("rejecting malformed notes payload (no durable work referenced)");
      return { result: "invalid_payload" };
    }
    const { jobRunId, orgId, caseId } = parsed.data;
    const fields: JobLogFields = { jobRunId, orgId, caseId, jobType: job.name, attempt: job.attemptsMade + 1 };
    const now = new Date();

    try {
      // (1) untrusted payload → durable row loaded under the payload's org scope
      const [row] = await withOrgTx(deps.db, orgId, (tx) =>
        tx.select().from(schema.jobRuns).where(and(
          eq(schema.jobRuns.id, jobRunId), eq(schema.jobRuns.orgId, orgId), eq(schema.jobRuns.caseId, caseId),
          eq(schema.jobRuns.jobType, job.name))));
      if (!row) {
        log.warn("notes queue delivered a job with no durable counterpart — acknowledging without action", fields);
        return { result: "no_durable_job" };
      }
      if (row.status === "succeeded" || row.status === "failed" || row.status === "canceled") return { result: "already_terminal" };

      // (2) atomic claim
      const claimed = await claimJob(deps.db, orgId, jobRunId, deps.leaseMs, now);
      if (!claimed) return { result: "lease_held_elsewhere" };

      // (3) system context (privileged org-row read only; tenant ops stay RLS-scoped)
      const ctx: OrgContext | null = await systemOrgContext(deps.systemDb, orgId);
      if (!ctx) {
        await cancelJob(deps.db, orgId, jobRunId, "no_such_case");
        return { result: "org_gone" };
      }

      // (4) deliver
      let outcome: NotesOutcome;
      if (isPrepare) {
        const p = parsed.data as CommunicationPreparePayload;
        const res = await communicationService.prepareCommunication(ctx, caseId, p.trigger);
        if (res.result === "no_such_case") {
          await cancelJob(deps.db, orgId, jobRunId, "no_such_case");
          return { result: "target_gone" };
        }
        outcome = res.result === "created" ? "prepared" : res.result;
      } else {
        const p = parsed.data as CommunicationSendPayload;
        const res = await communicationService.deliverCommunication(ctx, p.messageId, { now });
        if (res.result === "failed_transient") {
          // Infrastructure-class: durable bookkeeping, then BullMQ backoff redelivers.
          const err = new Error(`email send transient failure (${res.code}) — BullMQ backoff will redeliver`);
          (err as Error & { recorded?: boolean }).recorded = true;
          await recordInfraFailure(deps.db, orgId, jobRunId, { category: "email_transient", code: res.code });
          throw err;
        }
        if (res.result === "not_due") {
          // Deferred by policy (quiet hours/cooldown moved it): complete this delivery;
          // discovery re-enqueues when due.
          outcome = "not_due";
        } else {
          outcome = res.result;
        }
      }
      await completeJob(deps.db, orgId, jobRunId, outcome as JobOutcome);
      log.info("notes delivery complete", { ...fields, result: outcome, durationMs: Date.now() - startedAt });
      return { result: outcome };
    } catch (err) {
      const recorded = (err as { recorded?: boolean }).recorded === true;
      if (!recorded) {
        try {
          await recordInfraFailure(deps.db, orgId, jobRunId, { category: "infrastructure", code: String((err as { code?: string }).code ?? "delivery_error").slice(0, 120) });
        } catch (bookErr) {
          log.error(`could not record infra failure durably: ${withoutConnectionDetails((bookErr as Error).message)}`, fields);
        }
      }
      log.warn(`notes delivery failed — BullMQ will retry: ${withoutConnectionDetails((err as Error).message)}`, fields);
      throw err;
    }
  };
}

export function createNotesWorker(deps: NotesWorkerDeps): Worker<NotesPayload> {
  const connection = new Redis(deps.redisUrl, { maxRetriesPerRequest: null });
  return new Worker<NotesPayload>(NOTES_QUEUE, notesProcessor(deps), {
    connection, concurrency: deps.concurrency, lockDuration: deps.leaseMs
  });
}
