/**
 * Worker configuration (Phase 5). All env flows through `workerEnv()`
 * (packages/config — Zod-validated, boot fails loudly and safely). The Redis
 * URL is treated as a credential: it is never logged, never embedded in error
 * messages, and never persisted to audit records.
 */
import { workerEnv, type WorkerEnv } from "@revessent/config";

export interface WorkerConfig {
  env: WorkerEnv;
  /** Queue name (architecture §10.1): the money queue. */
  readonly RETRIES_QUEUE: "retries";
  /** Job name (architecture §10.2). */
  readonly RETRY_EXECUTE_JOB: "retry.execute";
  /** Stable system actor for audit `actor_id` (§19: system runs are
   *  operator-class, never anonymous). */
  readonly SYSTEM_ACTOR_ID: "system";
  leaseMs: number;
  pollMs: number;
  scanLimit: number;
  orgLimit: number;
  concurrency: number;
  blockedCooldownMs: number;
  /** §10.1: notes queue concurrency 5. */
  notesConcurrency: number;
}

export function loadWorkerConfig(): WorkerConfig {
  const env = workerEnv();
  return {
    env,
    RETRIES_QUEUE: "retries",
    RETRY_EXECUTE_JOB: "retry.execute",
    SYSTEM_ACTOR_ID: "system",
    leaseMs: env.WORKER_LEASE_SECONDS * 1_000,
    pollMs: env.WORKER_POLL_MS,
    scanLimit: env.WORKER_SCAN_LIMIT,
    orgLimit: env.WORKER_ORG_LIMIT,
    concurrency: env.WORKER_RETRIES_CONCURRENCY,
    blockedCooldownMs: env.WORKER_BLOCKED_COOLDOWN_HOURS * 3_600_000,
    notesConcurrency: env.WORKER_NOTES_CONCURRENCY
  };
}
