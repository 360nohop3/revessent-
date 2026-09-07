/**
 * Worker bootstrap (Phase 5). Wires configuration, connections, the `retries`
 * queue, the `retry.execute` consumer, the scheduler loop, optional health and
 * graceful shutdown. Boundaries:
 *   - app connection (revessent_app, RLS) — every tenant read/write;
 *   - scheduler/system connection (owner) — organization-id enumeration and
 *     organization-row context reads ONLY (documented in context.ts);
 *   - Redis connections — the BullMQ queue + worker; the URL is a credential
 *     and is never logged.
 * The worker owns NO business logic: retry decisions stay in Phase 4D,
 * payment execution stays in Phase 4C.
 */
import Redis from "ioredis";
import { createDb } from "@revessent/db";
import { createRetriesQueue } from "./queues/retries.js";
import { createRetryWorker } from "./workers/retryWorker.js";
import { createNotesQueue } from "./queues/notes.js";
import { createNotesWorker } from "./workers/notesWorker.js";
import { RetryScheduler } from "./scheduler/scheduler.js";
import { createHealthServer } from "./health.js";
import { gracefulShutdown, registerShutdownHandlers } from "./shutdown.js";
import { loadWorkerConfig } from "./config.js";
import { log, withoutConnectionDetails } from "./logger.js";

export async function bootstrap(): Promise<{ shutdown: (signal: string) => Promise<void> }> {
  const cfg = loadWorkerConfig();
  const startedAt = new Date();

  const db = createDb(cfg.env.APP_DATABASE_URL ?? cfg.env.DATABASE_URL); // RLS-scoped tenant ops
  const systemDb = createDb(cfg.env.SCHEDULER_DATABASE_URL ?? cfg.env.DATABASE_URL); // org enumeration + org-row reads ONLY

  const queue = createRetriesQueue(cfg.env.REDIS_URL);
  const processed = { completed: 0, failed: 0 };

  const worker = createRetryWorker({
    db,
    systemDb,
    leaseMs: cfg.leaseMs,
    concurrency: cfg.concurrency,
    redisUrl: cfg.env.REDIS_URL
  });
  // Phase 6: the `notes` queue (communication prepare/send). Same delivery
  // discipline; no financial authority. Payment execution is untouched.
  const notesQueue = createNotesQueue(cfg.env.REDIS_URL);
  const notesWorker = createNotesWorker({
    db, systemDb, leaseMs: cfg.leaseMs, concurrency: cfg.notesConcurrency, redisUrl: cfg.env.REDIS_URL
  });
  notesQueue.on("error", (err) => {
    log.warn(`notes queue error (durable state is authoritative): ${withoutConnectionDetails((err as Error).message)}`);
  });
  notesWorker.on("error", (err) => {
    log.warn(`notes worker error (job will be retried/backoff): ${withoutConnectionDetails((err as Error).message)}`);
  });
  notesWorker.on("completed", (job) => {
    processed.completed += 1;
    log.info("notes job completed", {
      jobRunId: String((job.data as { jobRunId?: string } | null)?.jobRunId ?? ""),
      result: String((job.returnvalue as { result?: string } | null)?.result ?? "")
    });
  });
  notesWorker.on("failed", (job, err) => {
    processed.failed += 1;
    log.warn(`notes job failed after ${job?.attemptsMade ?? 0} attempts: ${withoutConnectionDetails(err.message)}`);
  });

  // BullMQ re-emits connection errors on the Queue/Worker emitters; an
  // unhandled 'error' event would crash the process. Recovery is durable-first.
  queue.on("error", (err) => {
    log.warn(`retries queue error (durable state is authoritative): ${withoutConnectionDetails((err as Error).message)}`);
  });
  worker.on("error", (err) => {
    log.warn(`retries worker error (job will be retried/backoff): ${withoutConnectionDetails((err as Error).message)}`);
  });
  worker.on("completed", (job) => {
    processed.completed += 1;
    log.info("job completed", {
      jobRunId: String((job.data as { jobRunId?: string } | null)?.jobRunId ?? ""),
      result: String((job.returnvalue as { result?: string } | null)?.result ?? "")
    });
  });
  worker.on("failed", (job, err) => {
    processed.failed += 1;
    // The processor already recorded durable failure bookkeeping; this is the
    // operational signal only (dead-letter after the final attempt, §10.2).
    log.warn(`job failed after ${job?.attemptsMade ?? 0} attempts: ${err.message}`);
  });

  const scheduler = new RetryScheduler({ db, systemDb, queue, notesQueue, scanLimit: cfg.scanLimit, orgLimit: cfg.orgLimit, blockedCooldownMs: cfg.blockedCooldownMs });
  scheduler.start(cfg.pollMs);

  let healthServer: ReturnType<typeof createHealthServer> | undefined;
  let healthRedis: Redis | undefined;
  if (cfg.env.WORKER_HEALTH_PORT) {
    healthRedis = new Redis(cfg.env.REDIS_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: false });
    healthServer = createHealthServer({ redis: healthRedis, db, scheduler, processed, startedAt });
    healthServer.listen(cfg.env.WORKER_HEALTH_PORT, () => {
      log.info(`health endpoint listening on port ${cfg.env.WORKER_HEALTH_PORT}`);
    });
  }

  log.info("worker boot complete", {
    concurrency: cfg.concurrency,
    pollMs: cfg.pollMs,
    leaseSeconds: cfg.env.WORKER_LEASE_SECONDS,
    scanLimit: cfg.scanLimit,
    orgLimit: cfg.orgLimit,
    health: cfg.env.WORKER_HEALTH_PORT ?? "off",
    redis: "configured (url redacted)",
    notesConcurrency: cfg.notesConcurrency,
    ai: process.env.ANTHROPIC_API_KEY ? "configured (key redacted)" : "off (deterministic templates)",
    email: process.env.POSTMARK_SERVER_TOKEN ? "configured (token redacted)" : "off (sends deferred as not_configured)"
  });

  const target = () => ({ scheduler, worker, queue, notesWorker, notesQueue, redisConnections: healthRedis ? [healthRedis] : [], health: healthServer });
  const shutdown = (signal: string) => gracefulShutdown(target(), signal);
  registerShutdownHandlers(target);

  return { shutdown };
}
