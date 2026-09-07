/**
 * The `retry.execute` consumer (Phase 5 §7): a DELIVERY mechanism into the
 * existing Phase 4D engine. It asserts NOTHING about financial eligibility —
 * it verifies the durable job, claims it atomically, then hands the case to
 * `retryService.runDueRetries`, which re-evaluates eligibility under the
 * payment advisory lock and executes through the ONE Phase 4C primitive.
 *
 * Duplicate/at-least-once delivery (expected from BullMQ) converges:
 *   - terminal durable row            ⇒ ack, nothing runs
 *   - live lease held elsewhere       ⇒ ack, the owner delivers
 *   - claim race                      ⇒ one atomic UPDATE wins, loser acks
 *   - business refusal (blocked etc.) ⇒ job succeeds — delivery done, 4D decided
 *   - unresolved/infra failure        ⇒ durable bookkeeping + BullMQ backoff;
 *                                       budget exhausted ⇒ dead-letter (failed)
 */
import { Worker, type Job } from "bullmq";
import Redis from "ioredis";
import { and, eq } from "drizzle-orm";
import { withOrgTx, type Db } from "@revessent/db";
import * as schema from "@revessent/db";
import { retryService, type OrgContext } from "@revessent/server";
import { RetryExecutePayload, RETRIES_QUEUE, type RetryExecutePayload as Payload } from "../queues/retries.js";
import { cancelJob, claimJob, completeJob, recordInfraFailure } from "../durable/jobs.js";
import { systemOrgContext } from "../context.js";
import { log, withoutConnectionDetails, type JobLogFields } from "../logger.js";

export interface RetryWorkerDeps {
  /** Application-role connection (RLS) — all tenant reads/writes. */
  db: Db;
  /** Privileged connection — org-row context reads ONLY (see context.ts). */
  systemDb: Db;
  leaseMs: number;
  concurrency: number;
  redisUrl: string;
}

export type ProcessorResult =
  | { result: "executed" | "blocked" | "waiting" | "exhausted" | "disabled" | "not_due" }
  | { result: "no_durable_job" | "already_terminal" | "lease_held_elsewhere" | "target_gone" | "org_gone" | "invalid_payload" };

export function retryExecuteProcessor(deps: RetryWorkerDeps) {
  return async (job: Job<Payload>): Promise<ProcessorResult> => {
    const startedAt = Date.now();
    const parsed = RetryExecutePayload.safeParse(job.data);
    if (!parsed.success) {
      // Unsafe/foreign payload: never retried, never executed, safely ignored.
      log.warn("rejecting malformed queue payload (no durable work referenced)");
      return { result: "invalid_payload" };
    }
    const { jobRunId, orgId, caseId } = parsed.data;
    const fields: JobLogFields = { jobRunId, orgId, caseId, jobType: "retry.execute", attempt: job.attemptsMade + 1 };
    const now = new Date();

    try {
      // (1) The queue payload is UNTRUSTED (§13): the durable job_runs row,
      // loaded RLS-scoped as THIS organization, must confirm the
      // org ↔ case ↔ job relationship before anything runs.
      const [row] = await withOrgTx(deps.db, orgId, (tx) =>
        tx.select().from(schema.jobRuns).where(and(
          eq(schema.jobRuns.id, jobRunId),
          eq(schema.jobRuns.orgId, orgId),
          eq(schema.jobRuns.caseId, caseId))));
      if (!row) {
        log.warn("queue delivered a job with no durable counterpart — acknowledging without action", fields);
        return { result: "no_durable_job" };
      }
      if (row.status === "succeeded" || row.status === "failed" || row.status === "canceled") {
        return { result: "already_terminal" }; // duplicate delivery after completion — harmless
      }

      // (2) Atomic claim (queued or stale lease). A live lease elsewhere acks.
      const claimed = await claimJob(deps.db, orgId, jobRunId, deps.leaseMs, now);
      if (!claimed) {
        log.info("lease held elsewhere — duplicate delivery acknowledged", fields);
        return { result: "lease_held_elsewhere" };
      }

      // (3) The target case must still exist (RLS-scoped).
      const [target] = await withOrgTx(deps.db, orgId, (tx) =>
        tx.select().from(schema.recoveryCases).where(eq(schema.recoveryCases.id, caseId)));
      if (!target) {
        await cancelJob(deps.db, orgId, jobRunId, "no_such_case");
        log.info("target case no longer exists — job canceled", fields);
        return { result: "target_gone" };
      }

      // (4) System execution context (documented privileged surface; the
      // tenant operations themselves stay RLS-scoped on the app connection).
      const ctx: OrgContext | null = await systemOrgContext(deps.systemDb, orgId);
      if (!ctx) {
        await cancelJob(deps.db, orgId, jobRunId, "no_such_case");
        return { result: "org_gone" };
      }

      // (5) DELIVER to Phase 4D. Eligibility is re-checked there under its own
      // concurrency controls; Phase 4C executes if and only if safe.
      const summary = await retryService.runDueRetries(ctx, { caseId });
      const out = summary.outcomes[0];

      // (6) Map the delivery. A scheduled/executing attempt row after the run
      // means the engine could not establish an outcome — that is an
      // INFRASTRUCTURE retry, never a business refusal.
      if (out && (out.status === "scheduled" || out.status === "executing")) {
        const err = new Error(`retry delivery unresolved (status=${out.status}) — BullMQ backoff will redeliver`);
        (err as Error & { recorded?: boolean }).recorded = true; // durable bookkeeping already done below
        await recordInfraFailure(deps.db, orgId, jobRunId, { category: "execution_unresolved", code: out.status ?? "unknown" });
        throw err;
      }

      let result: ProcessorResult["result"];
      if (summary.executed > 0) {
        await completeJob(deps.db, orgId, jobRunId, "executed");
        result = "executed";
      } else if (summary.considered === 0) {
        await completeJob(deps.db, orgId, jobRunId, "not_due");
        result = "not_due";
      } else {
        const verdict = (out?.verdict ?? "blocked") as "blocked" | "waiting" | "exhausted" | "disabled";
        // Delivery succeeded; Phase 4D decided not now / no. The case remains
        // durable work — future eligibility is rediscovered by the scheduler.
        await completeJob(deps.db, orgId, jobRunId, verdict);
        result = verdict;
      }
      log.info("retry delivery complete", { ...fields, result, durationMs: Date.now() - startedAt });
      return { result } as ProcessorResult;
    } catch (err) {
      // Infrastructure failure path: durable bookkeeping, then rethrow so
      // BullMQ applies its exponential backoff. Budget exhaustion dead-letters
      // the job as terminal `failed` (replay is an admin operation).
      const recorded = (err as { recorded?: boolean }).recorded === true;
      const category = recorded ? "execution_unresolved" : "infrastructure";
      const code = (err as { code?: string }).code ?? (recorded ? "delivery_unresolved" : "delivery_error");
      if (!recorded) {
        try {
          await recordInfraFailure(deps.db, orgId, jobRunId, { category, code: String(code).slice(0, 120) });
        } catch (bookErr) {
          log.error(`could not record infra failure durably: ${withoutConnectionDetails((bookErr as Error).message)}`, fields);
        }
      }
      log.warn(`delivery failed — BullMQ will retry: ${withoutConnectionDetails((err as Error).message)}`, fields);
      throw err;
    }
  };
}

export function createRetryWorker(deps: RetryWorkerDeps): Worker<Payload> {
  const connection = new Redis(deps.redisUrl, { maxRetriesPerRequest: null });
  return new Worker<Payload>(RETRIES_QUEUE, retryExecuteProcessor(deps), {
    connection,
    concurrency: deps.concurrency,
    // BullMQ's own lock must cover the longest in-flight delivery; the durable
    // lease is the safety net for crashes between renewals.
    lockDuration: deps.leaseMs
  });
}
