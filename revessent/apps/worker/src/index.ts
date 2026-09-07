/**
 * @revessent/worker — background execution subsystem (Phase 5).
 * Library surface for tests and future callers. The runnable process entry is
 * `bootstrap.ts` (tsx src/bootstrap.ts); importing THIS module never starts a
 * process, opens connections, or schedules work.
 */
export { loadWorkerConfig, type WorkerConfig } from "./config.js";
export { log, withoutConnectionDetails, type JobLogFields } from "./logger.js";
export { SYSTEM_ACTOR_ID, systemOrgContext } from "./context.js";
export {
  RETRIES_QUEUE, RETRY_EXECUTE_JOB,
  RetryExecutePayload, retryExecuteDedupeKey,
  createQueueConnection, createRetriesQueue,
  enqueueRetryExecution, reenqueueExistingJob,
  type RetryExecutePayload as RetryExecutePayloadType, type EnqueueResult
} from "./queues/retries.js";
export {
  createLiveJob, findLiveJobs, claimJob, completeJob, cancelJob,
  recordInfraFailure, findRecentTerminalJobs, findDueWork,
  type JobStatus, type JobOutcome, type JobRow
} from "./durable/jobs.js";
export { reconcileOrgJobsWithRedis, reconcileOrgNotesWithRedis, findStaleLeases, type RecoveryStats } from "./recovery/recovery.js";
// ---- Phase 6: communication (notes) queue ----
export {
  NOTES_QUEUE, COMM_PREPARE_JOB, COMM_SEND_JOB,
  CommunicationPreparePayload, CommunicationSendPayload, commPrepareDedupeKey, commSendDedupeKey,
  createNotesQueue, notesRedisJobId, enqueueCommunicationPrepare, enqueueCommunicationSend, reenqueueNotesJob,
  type NotesPayload, type NotesEnqueueResult
} from "./queues/notes.js";
export { notesProcessor, createNotesWorker, type NotesWorkerDeps, type NotesProcessorResult, type NotesOutcome } from "./workers/notesWorker.js";
export { RetryScheduler, schedulerCycle, cycleOrg, type SchedulerDeps, type CycleStats } from "./scheduler/scheduler.js";
export { retryExecuteProcessor, createRetryWorker, type RetryWorkerDeps, type ProcessorResult } from "./workers/retryWorker.js";
export { createHealthServer, type HealthDeps } from "./health.js";
export { gracefulShutdown, registerShutdownHandlers, type ShutdownTarget } from "./shutdown.js";

