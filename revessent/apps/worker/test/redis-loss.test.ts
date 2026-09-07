/**
 * PHASE 5 — Redis-loss recovery (§9), end to end: Redis can disappear and
 * return; the system reconstructs required deliveries from durable DB state
 * without duplicate financial execution. Uses a REAL Redis process so the
 * outage is real, not simulated.
 */
import { describe, expect, it, beforeEach, afterEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { appDb, withOrgTx, schema, createDb } from "./helpers.js";
import { seedRig, acquireTestRedis, releaseTestRedis, flushTestRedis, TEST_REDIS_URL, afterEachCleanup, paymentRowRig, processorDeps, fakeJob, baseWorld, type Rig } from "./helpers.js";
import { createRetriesQueue, cycleOrg, retryExecuteDedupeKey } from "@revessent/worker";
import { setStripeGatewayForTests } from "@revessent/integrations";
import { fixtureGateway, resetFixtureWorlds } from "@revessent/integrations/fixtures";

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

function schedDeps(queue: never) {
  return { db: createDb(process.env.APP_DATABASE_URL!), systemDb: createDb(process.env.SCHEDULER_DATABASE_URL!), queue, scanLimit: 100, orgLimit: 200 };
}

describe("Redis loss and recovery", () => {
  it("total Redis flush: the scheduler cycle reconstructs the delivery from durable state and it executes exactly once", async () => {
    const { createRetriesQueue } = await import("@revessent/worker");
    const queue = createRetriesQueue(TEST_REDIS_URL);

    // discovery + enqueue while Redis is healthy
    const stats = await cycleOrg(schedDeps(queue as never), rig.orgId);
    expect(stats.enqueued).toBe(1);
    expect(await queue.getJob(retryExecuteDedupeKey(rig.orgId, rig.caseId))).toBeDefined();

    // REDIS DISAPPEARS (flush = total loss of queued/delayed state)
    const { default: Redis } = await import("ioredis");
    const flush = new Redis(TEST_REDIS_URL, { maxRetriesPerRequest: 1 });
    await flush.flushall();
    await flush.quit();
    expect(await queue.getJob(retryExecuteDedupeKey(rig.orgId, rig.caseId))).toBeUndefined(); // the queue record is gone

    // REDIS IS BACK: the durable row still says queued — the next scheduler
    // cycle must reconstruct the delivery (same deterministic identity)
    const recovered = await cycleOrg(schedDeps(queue as never), rig.orgId);
    expect(recovered.redisReenqueued).toBe(1);
    expect(recovered.enqueued).toBe(0); // discovery does NOT create a second logical job
    const job = await queue.getJob(retryExecuteDedupeKey(rig.orgId, rig.caseId));
    expect(job).toBeDefined();
    expect(job!.id).toBe(retryExecuteDedupeKey(rig.orgId, rig.caseId));

    // the reconstructed delivery executes once through the 4D/4C path
    const world = baseWorld();
    world.pay = { behavior: "ok", idempotentReplay: true };
    setStripeGatewayForTests(fixtureGateway(world));
    const [row] = await withOrgTx(appDb(), rig.orgId, (tx) => tx.select().from(schema.jobRuns));
    const { processor } = await processorDeps();
    expect(await processor(fakeJob({ jobRunId: row!.id, orgId: rig.orgId, caseId: rig.caseId }))).toEqual({ result: "executed" });
    expect(world.pay!.operations).toHaveLength(1);
    expect((await paymentRowRig()).status).toBe("paid");

    // after success, further cycles do NOT resurrect the completed delivery
    const after = await cycleOrg(schedDeps(queue as never), rig.orgId);
    expect(after.redisReenqueued).toBe(0);
    expect(after.enqueued).toBe(0);
    await queue.close();
    resetFixtureWorlds();
  });

  it("Redis outage at enqueue time: durable rows accumulate exactly once; nothing is lost; recovery delivers", async () => {
    const { createRetriesQueue } = await import("@revessent/worker");
    // "outage": nothing listens on 6390 — the offline queue is disabled so the
    // enqueue fails fast instead of buffering silently
    const broken = createRetriesQueue("redis://127.0.0.1:6390", { retryStrategy: () => null });
    broken.on("error", () => { /* expected — this queue is the outage */ });
    const stats1 = await cycleOrg(schedDeps(broken as never), rig.orgId);
    expect(stats1.enqueued).toBe(0);
    const stats2 = await cycleOrg(schedDeps(broken as never), rig.orgId);
    expect(stats2.enqueued).toBe(0);
    await broken.close().catch(() => undefined);

    // the durable ledger holds EXACTLY one queued job — repeated cycles did not amplify
    const rows = await withOrgTx(appDb(), rig.orgId, (tx) => tx.select().from(schema.jobRuns));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("queued");

    // Redis returns: the delivery is reconstructed and processed safely
    const queue = createRetriesQueue(TEST_REDIS_URL);
    const recovered = await cycleOrg(schedDeps(queue as never), rig.orgId);
    expect(recovered.redisReenqueued).toBe(1);
    const world = baseWorld();
    world.pay = { behavior: "ok", idempotentReplay: true };
    setStripeGatewayForTests(fixtureGateway(world));
    const { processor } = await processorDeps();
    expect(await processor(fakeJob({ jobRunId: rows[0]!.id, orgId: rig.orgId, caseId: rig.caseId }))).toEqual({ result: "executed" });
    expect(world.pay!.operations).toHaveLength(1);
    await queue.close();
    resetFixtureWorlds();
  });

  it("failed deliveries are NOT automatically resurrected after Redis recovery (dead-letter discipline)", async () => {
    const queue = createRetriesQueue(TEST_REDIS_URL);
    await cycleOrg(schedDeps(queue as never), rig.orgId);
    // drain: deliver and let the engine block it forever (non-retryable category)
    await withOrgTx(appDb(), rig.orgId, (tx) =>
      tx.update(schema.retryPolicies).set({ rules: {
        maxAutoRetries: 2, quietHoursStart: 21, quietHoursEnd: 8, minGapHours: 24,
        noteAfterFailedRetries: 1, checkoutAfterNote: true,
        autoRetry: { perCategory: { insufficient_funds: { retryable: false, maxAttempts: 4 } }, backoffMultiplier: 2, maxBackoffHours: 168 }
      } as never }).where(eq(schema.retryPolicies.orgId, rig.orgId)));
    const [row] = await withOrgTx(appDb(), rig.orgId, (tx) => tx.select().from(schema.jobRuns));
    const { processor } = await processorDeps();
    expect(await processor(fakeJob({ jobRunId: row!.id, orgId: rig.orgId, caseId: rig.caseId }))).toEqual({ result: "blocked" });
    await queue.close();

    // "redis loss + return": completed jobs are removed (removeOnComplete) and
    // recovery must NOT resurrect a delivered business refusal
    const queue2 = createRetriesQueue(TEST_REDIS_URL);
    const stats = await cycleOrg(schedDeps(queue2 as never), rig.orgId);
    expect(stats.redisReenqueued).toBe(0);
    expect(stats.enqueued).toBe(0);
    await queue2.close();
    resetFixtureWorlds();
  });
});
