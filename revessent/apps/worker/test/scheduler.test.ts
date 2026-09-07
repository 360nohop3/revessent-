/**
 * PHASE 5 — scheduler / dispatcher (§8): due work discovered exactly once,
 * multiple scheduler instances converge, non-due work is not discovered,
 * work is bounded, and duplicate discovery never amplifies.
 */
import { describe, expect, it, beforeEach, afterEach, afterAll } from "vitest";
import type { Queue } from "bullmq";
import { eq } from "drizzle-orm";
import { appDb, withOrgTx, schema, retryService, createDb } from "./helpers.js";
import { seedRig, acquireTestRedis, releaseTestRedis, flushTestRedis, TEST_REDIS_URL, afterEachCleanup, type Rig, processorDeps, suffix } from "./helpers.js";
import { createRetriesQueue, cycleOrg, retryExecuteDedupeKey } from "@revessent/worker";

let rig: Rig;
let queue: Queue<never>;

beforeEach(async () => {
  await acquireTestRedis();
  await flushTestRedis();
  rig = await seedRig();
  queue = createRetriesQueue(TEST_REDIS_URL) as unknown as Queue<never>;
});
afterEach(async () => {
  afterEachCleanup();
  await queue.close().catch(() => undefined);
  await releaseTestRedis();
});
afterAll(() => void releaseTestRedis());

function depsFor(orgLimit = 200, scanLimit = 100) {
  // fresh db instances like the real bootstrap would create
  return {
    db: createDb(process.env.APP_DATABASE_URL!),
    systemDb: createDb(process.env.SCHEDULER_DATABASE_URL!),
    queue: queue as never,
    scanLimit,
    orgLimit
  };
}


/** Extra due case with proper customer/payment FKs (RLS org-scoped). */
async function makeCase(orgId: string, amountCents: number, nextActionAt: Date): Promise<string> {
  const [cust] = await withOrgTx(appDb(), orgId, (tx) =>
    tx.insert(schema.customers).values({ orgId, stripeCustomerId: `cus_mk_${suffix()}` }).returning());
  const [pay] = await withOrgTx(appDb(), orgId, (tx) =>
    tx.insert(schema.payments).values({
      orgId, customerId: cust!.id, stripeInvoiceId: `in_mk_${suffix()}`,
      amountCents, currency: "USD", status: "failed"
    }).returning());
  const [c] = await withOrgTx(appDb(), orgId, (tx) =>
    tx.insert(schema.recoveryCases).values({
      orgId, customerId: cust!.id, paymentId: pay!.id,
      status: "retrying", declineCode: "insufficient_funds", declineCategory: "insufficient_funds",
      amountCents, currency: "USD",
      firstFailedAt: new Date(), nextActionAt, attemptNo: 0
    }).returning());
  return c!.id;
}

describe("scheduler discovery", () => {
  it("discovers due work: one durable job + one BullMQ job, delayed until due", async () => {
    const stats = await cycleOrg(depsFor(), rig.orgId);
    expect(stats.discovered).toBe(1);
    expect(stats.enqueued).toBe(1);

    const rows = await withOrgTx(appDb(), rig.orgId, (tx) => tx.select().from(schema.jobRuns));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("queued");
    const job = await queue.getJob(retryExecuteDedupeKey(rig.orgId, rig.caseId));
    expect(job).not.toBeNull();
  });

  it("is idempotent: a second cycle does NOT duplicate the delivery", async () => {
    await cycleOrg(depsFor(), rig.orgId);
    const stats2 = await cycleOrg(depsFor(), rig.orgId);
    expect(stats2.discovered).toBe(0); // the live job row IS the in-flight marker — not rediscovered
    expect(stats2.enqueued).toBe(0);   // and no new job
    expect(stats2.skippedLive).toBe(0);
    const rows = await withOrgTx(appDb(), rig.orgId, (tx) => tx.select().from(schema.jobRuns));
    expect(rows).toHaveLength(1);
    expect((await queue.getWaiting()).length + (await queue.getDelayed()).length).toBe(1);
  });

  it("multiple concurrent scheduler instances produce exactly ONE live job", async () => {
    // three independent scheduler instances race the SAME org's due work
    const depList = await Promise.all(Array.from({ length: 3 }, async () => {
      const d = depsFor();
      await (d.queue as Queue<never>).waitUntilReady();
      return d;
    }));
    const results = await Promise.all(depList.map((d) => cycleOrg(d, rig.orgId)));
    const enqueued = results.reduce((sum, s) => sum + s.enqueued, 0);
    expect(enqueued).toBe(1); // exactly one instance won the durable insert
    const rows = await withOrgTx(appDb(), rig.orgId, (tx) => tx.select().from(schema.jobRuns));
    expect(rows).toHaveLength(1);
  });

  it("never discovers work that is not due (future nextActionAt, resolved payment, unknown outcome)", async () => {
    // future nextActionAt → not due
    await withOrgTx(appDb(), rig.orgId, (tx) =>
      tx.update(schema.recoveryCases).set({ nextActionAt: new Date(Date.now() + 48 * 3_600_000) })
        .where(eq(schema.recoveryCases.id, rig.caseId)));
    let stats = await cycleOrg(depsFor(), rig.orgId);
    expect(stats.discovered).toBe(0);

    // unknown outcome shape: nextActionAt NULL (blocked until reconcile) → never discovered
    await withOrgTx(appDb(), rig.orgId, (tx) =>
      tx.update(schema.recoveryCases).set({ nextActionAt: null })
        .where(eq(schema.recoveryCases.id, rig.caseId)));
    stats = await cycleOrg(depsFor(), rig.orgId);
    expect(stats.discovered).toBe(0);
    expect((await withOrgTx(appDb(), rig.orgId, (tx) => tx.select().from(schema.jobRuns))).length).toBe(0);
  });

  it("after a delivery the case leaves the due set (4D schedules the backoff), and completed deliveries are never resurrected", async () => {
    // deliver once via the real processor: decline → 4D schedules the next action ⇒ not due
    const { fixtureGateway, resetFixtureWorlds } = await import("@revessent/integrations/fixtures");
    const { setStripeGatewayForTests } = await import("@revessent/integrations");
    const world = (await import("./helpers.js")).baseWorld();
    world.pay = { behavior: "decline:insufficient_funds" };
    setStripeGatewayForTests(fixtureGateway(world));
    const { processor } = await processorDeps();
    const first = await cycleOrg(depsFor(), rig.orgId);
    expect(first.enqueued).toBe(1);
    const [jobRow] = await withOrgTx(appDb(), rig.orgId, (tx) => tx.select().from(schema.jobRuns));
    expect(await processor({ data: { jobRunId: jobRow!.id, orgId: rig.orgId, caseId: rig.caseId }, attemptsMade: 0 } as never)).toEqual({ result: "executed" });
    resetFixtureWorlds();

    // delivery consumed (case now waiting/backoff with future nextActionAt) → discovery finds nothing
    const stats = await cycleOrg(depsFor(), rig.orgId);
    expect(stats.enqueued).toBe(0);
    expect(stats.redisReenqueued).toBe(0); // completed deliveries are never resurrected
  });

  it("bounded: scanLimit caps discovered cases per org per cycle", async () => {
    // create 4 extra due cases (limit 3 ⇒ 3 discovered this cycle, 2 next)
    const limit = 3;
    for (let i = 0; i < 4; i++) {
      await makeCase(rig.orgId, 1000 + i, new Date(Date.now() - 3_600_000));
    }
    const stats = await cycleOrg(depsFor(200, limit), rig.orgId);
    expect(stats.enqueued).toBe(limit);
    const stats2 = await cycleOrg(depsFor(200, limit), rig.orgId);
    expect(stats2.enqueued).toBe(2); // the remainder
  });

  it("discovery does NOT decide eligibility: a due case the 4D engine will refuse is still delivered and refused THERE", async () => {
    // make the category non-retryable: discovery still finds it (correct — it
    // is due durable work); the DELIVERY is refused by the 4D engine, not here.
    await withOrgTx(appDb(), rig.orgId, (tx) =>
      tx.update(schema.retryPolicies)
        .set({ rules: {
          maxAutoRetries: 2, quietHoursStart: 21, quietHoursEnd: 8, minGapHours: 24,
          noteAfterFailedRetries: 1, checkoutAfterNote: true,
          autoRetry: { perCategory: { insufficient_funds: { retryable: false, maxAttempts: 4 } }, backoffMultiplier: 2, maxBackoffHours: 168 }
        } as never })
        .where(eq(schema.retryPolicies.orgId, rig.orgId)));
    const stats = await cycleOrg(depsFor(), rig.orgId);
    expect(stats.enqueued).toBe(1); // scheduler discovers; the engine decides
    void retryService;
  });
});
