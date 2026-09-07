/**
 * Optional worker health/readiness endpoint (§16/§15). Reports liveness of the
 * Redis and Postgres connections plus scheduler/processing counters. Contains
 * NO secrets, NO organization data, NO queue payloads.
 */
import { createServer, type Server } from "node:http";
import type Redis from "ioredis";
import type { Db } from "@revessent/db";
import { sql } from "drizzle-orm";
import type { RetryScheduler } from "./scheduler/scheduler.js";

export interface HealthDeps {
  redis: Redis;
  db: Db;
  scheduler?: RetryScheduler;
  processed: { completed: number; failed: number };
  startedAt: Date;
}

export function createHealthServer(deps: HealthDeps): Server {
  return createServer((req, res) => {
    if (req.method !== "GET" || (req.url !== "/health" && req.url !== "/healthz")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not found" }));
      return;
    }
    void Promise.all([
      deps.redis.ping().then(() => true).catch(() => false),
      deps.db.execute(sql`select 1`).then(() => true).catch(() => false)
    ]).then(([redisOk, dbOk]) => {
      const body = {
        ok: redisOk && dbOk,
        redis: redisOk ? "up" : "down",
        db: dbOk ? "up" : "down",
        scheduler: deps.scheduler
          ? { lastCycleAt: deps.scheduler.lastCycleAt?.toISOString() ?? null, lastStats: deps.scheduler.lastStats, cycleErrors: deps.scheduler.cycleErrors }
          : null,
        processed: deps.processed,
        uptimeSeconds: Math.floor((Date.now() - deps.startedAt.getTime()) / 1000)
      };
      res.writeHead(redisOk && dbOk ? 200 : 503, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
}
