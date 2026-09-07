/**
 * Graceful shutdown (Phase 5 §16). Order matters:
 *   1. scheduler stops (no new deliveries are discovered),
 *   2. BullMQ worker closes (stops accepting; in-flight jobs finish — a job
 *      that cannot finish keeps its durable lease and is reclaimed as stale
 *      after expiry; it is NEVER marked failed merely because we are stopping),
 *   3. queue + Redis connections close,
 *   4. health server closes.
 * In-flight work that finishes updates its durable row normally, so a shutdown
 * interrupted mid-job converges through the same recovery paths as a crash.
 * The runtime cannot guarantee that a killed process finishes its last job —
 * the design therefore optimizes for safe recovery, not perfection (§16).
 */
import type Redis from "ioredis";
import type { Server } from "node:http";
import { log, withoutConnectionDetails } from "./logger.js";

export interface ShutdownTarget {
  scheduler?: { stop(): void };
  worker?: { close(): Promise<void> };
  queue?: { close(): Promise<void> };
  /** Phase 6: notes queue + worker (closed in the same order as the money queue). */
  notesWorker?: { close(): Promise<void> };
  notesQueue?: { close(): Promise<void> };
  redisConnections?: Redis[];
  health?: Server;
}

export async function gracefulShutdown(target: ShutdownTarget, signal: string): Promise<void> {
  log.warn(`graceful shutdown initiated (${signal})`);
  target.scheduler?.stop();
  try {
    if (target.worker) await target.worker.close(); // waits for in-flight jobs
  } catch (err) {
    log.warn(`worker close interrupted: ${withoutConnectionDetails((err as Error).message)}`);
  }
  try {
    if (target.notesWorker) await target.notesWorker.close(); // waits for in-flight sends
  } catch (err) {
    log.warn(`notes worker close interrupted: ${withoutConnectionDetails((err as Error).message)}`);
  }
  try {
    if (target.queue) await target.queue.close();
  } catch (err) {
    log.warn(`queue close interrupted: ${withoutConnectionDetails((err as Error).message)}`);
  }
  try {
    if (target.notesQueue) await target.notesQueue.close();
  } catch (err) {
    log.warn(`notes queue close interrupted: ${withoutConnectionDetails((err as Error).message)}`);
  }
  for (const conn of target.redisConnections ?? []) {
    try {
      await conn.quit();
    } catch {
      conn.disconnect(); // already down — force-close sockets
    }
  }
  target.health?.close();
  log.warn("graceful shutdown complete");
}

/** Installs SIGTERM/SIGINT handlers that shut down once, then exit 0. */
export function registerShutdownHandlers(build: () => ShutdownTarget): void {
  let shuttingDown = false;
  const handler = (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    void gracefulShutdown(build(), signal).finally(() => process.exit(0));
  };
  process.on("SIGTERM", () => handler("SIGTERM"));
  process.on("SIGINT", () => handler("SIGINT"));
}
