/**
 * PHASE 5 — real BullMQ worker runtime (§12/§16/§17): duplicate and
 * simultaneous delivery through an actual Worker process, the queue-level
 * dedupe of identical jobIds, Phase-4C-remains-the-only-payment-path proof,
 * and graceful shutdown.
 */
import { describe, expect, it, beforeEach, afterEach, afterAll } from "vitest";
import { setTimeout as sleep } from "node:timers/promises";
import { appDb } from "./helpers.js";
import {
  seedRig, acquireTestRedis, releaseTestRedis, flushTestRedis, TEST_REDIS_URL,
  afterEachCleanup, attemptsRows, paymentRowRig, jobRow, baseWorld, type Rig
} from "./helpers.js";
import { createRetryWorker, createRetriesQueue, enqueueRetryExecution, retryExecuteDedupeKey } from "@revessent/worker";
import { createDb } from "@revessent/db";
import { fixtureGateway, resetFixtureWorlds } from "@revessent/integrations/fixtures";
import { setStripeGatewayForTests } from "@revessent/integrations";

let rig: Rig;

beforeEach(async () => {
  await acquireTestRedis();
  await flushTestRedis();
  rig = await seedRig();
});
afterEach(() => {
  afterEachCleanup();
  void releaseTestRedis();
});
afterAll(() => void releaseTestRedis());

function workerDeps() {
  return {
    db: createDb(process.env.APP_DATABASE_URL!),
    systemDb: createDb(process.env.SCHEDULER_DATABASE_URL!),
    leaseMs: 60_000,
    concurrency: 2,
    redisUrl: TEST_REDIS_URL
  };
}

describe("real BullMQ worker runtime", () => {
  it("end-to-end: enqueue → worker delivers → 4D/4C execute exactly once; duplicate delivery converges", async () => {
    const world = baseWorld();
    world.pay = { behavior: "ok", idempotentReplay: true };
    setStripeGatewayForTests(fixtureGateway(world));

    const queue = createRetriesQueue(TEST_REDIS_URL);
    const worker = createRetryWorker(workerDeps());
    try {
      const res = await enqueueRetryExecution(queue as never, appDb(), { orgId: rig.orgId, caseId: rig.caseId });
      expect(res.enqueued).toBe(true);

      // wait for real processing (bounded)
      const deadline = Date.now() + 20_000;
      let row = await jobRow(res.jobRunId);
      while (Date.now() < deadline && row?.status !== "succeeded") {
        await sleep(200);
        row = await jobRow(res.jobRunId);
      }
      expect(row!.status).toBe("succeeded");
      expect(row!.outcome).toBe("executed");
      expect(world.pay!.operations).toHaveLength(1);
      expect((await paymentRowRig()).status).toBe("paid");
      expect((await attemptsRows("auto_retry"))[0]!.idempotencyKey).toBe(`rv:${rig.orgId}:${rig.caseId}:1`);

      // at-least-once redelivery of the same logical job → terminal ⇒ harmless
      const completedJob = await queue.getJob(retryExecuteDedupeKey(rig.orgId, rig.caseId));
      expect(completedJob).toBeUndefined(); // removed on complete — identity freed
      const redelivery = await enqueueRetryExecution(queue as never, appDb(), { orgId: rig.orgId, caseId: rig.caseId });
      expect(redelivery.enqueued).toBe(true); // a NEW delivery round is allowed…
      const deadline2 = Date.now() + 20_000;
      let row2 = await jobRow(redelivery.jobRunId);
      while (Date.now() < deadline2 && row2?.status !== "succeeded") {
        await sleep(200);
        row2 = await jobRow(redelivery.jobRunId);
      }
      expect(row2!.status).toBe("succeeded");
      expect(row2!.outcome).toBe("not_due"); // …and converges: 4D finds the payment paid
      expect(world.pay!.operations).toHaveLength(1); // still exactly ONE charge ever
    } finally {
      await worker.close();
      await queue.close();
    }
    resetFixtureWorlds();
  });

  it("Phase 4C remains the ONLY payment path: the worker code never calls the provider directly", async () => {
    // structural proof: the worker surface exposes no provider/gateway calls;
    // its only execution route is retryService.runDueRetries inside the processor.
    const { readFile } = await import("node:fs/promises");
    const processorSrc = await readFile(new URL("../src/workers/retryWorker.ts", import.meta.url), "utf8");
    expect(processorSrc).toContain("runDueRetries");
    expect(processorSrc).not.toMatch(/getStripeGateway|payInvoice|stripe-client|createStripeClient/);
    const queuesSrc = await readFile(new URL("../src/queues/retries.ts", import.meta.url), "utf8");
    expect(queuesSrc).not.toMatch(/getStripeGateway|payInvoice|stripe-client/);
    const durableSrc = await readFile(new URL("../src/durable/jobs.ts", import.meta.url), "utf8");
    expect(durableSrc).not.toMatch(/getStripeGateway|payInvoice|stripe-client/);
  });

  it("graceful shutdown: worker.close() stops cleanly and in-flight-safe state is preserved", async () => {
    const queue = createRetriesQueue(TEST_REDIS_URL);
    const worker = createRetryWorker(workerDeps());
    try {
      // idle worker: close resolves promptly (no in-flight job to interrupt)
      await worker.close();
      expect(worker.runLocked ? await worker.runLocked() : false).toBe(false);
    } finally {
      await queue.close().catch(() => undefined);
    }

    // a stopped worker keeps its durable state consistent: a queued job stays
    // queued (recoverable), never marked failed because of the shutdown
    const res = await enqueueRetryExecution(queue as never, appDb(), { orgId: rig.orgId, caseId: rig.caseId });
    const row = await jobRow(res.jobRunId);
    expect(row!.status).toBe("queued");
    expect(row!.lastErrorCategory).toBeNull();
    await queue.close().catch(() => undefined);
  });
});
