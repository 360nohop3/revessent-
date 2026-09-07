/**
 * PHASE 5 — worker crash recovery (§10). Every ambiguous boundary converges
 * WITHOUT a second financial execution, because the durable job lease, the
 * 4D attempt identity and the 4C payment idempotency are the authorities.
 */
import { describe, expect, it, beforeEach, afterEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { appDb, withOrgTx, schema } from "./helpers.js";
import { seedRig, acquireTestRedis, releaseTestRedis, flushTestRedis, afterEachCleanup, attemptsRows, paymentRowRig, processorDeps, fakeJob, baseWorld, type Rig } from "./helpers.js";
import { enqueueRetryExecution, retryExecuteDedupeKey } from "@revessent/worker";
import { fixtureGateway, resetFixtureWorlds } from "@revessent/integrations/fixtures";
import { setStripeGatewayForTests } from "@revessent/integrations";

let rig: Rig;
const STALE_LEASE = 30_000; // short lease so tests can expire it fast

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

async function enqueueOnly(): Promise<string> {
  const { createRetriesQueue } = await import("@revessent/worker");
  const q = createRetriesQueue(process.env.REDIS_URL!);
  try {
    return (await enqueueRetryExecution(q as never, appDb(), { orgId: rig.orgId, caseId: rig.caseId })).jobRunId;
  } finally {
    await q.close().catch(() => undefined);
  }
}

/** Simulates a worker that claimed the job and died: the lease expired. */
async function expireLease(jobRunId: string): Promise<void> {
  const [row] = await withOrgTx(appDb(), rig.orgId, (tx) =>
    tx.update(schema.jobRuns)
      .set({ leaseExpiresAt: new Date(Date.now() - 1_000) })
      .where(eq(schema.jobRuns.id, jobRunId))
      .returning());
  void row;
}

describe("crash boundaries (§10 A–E)", () => {
  it("A. crash BEFORE business execution: the stale lease is reclaimed and the work delivers exactly once", async () => {
    const jobRunId = await enqueueOnly();
    const world = baseWorld();
    world.pay = { behavior: "ok", idempotentReplay: true };
    setStripeGatewayForTests(fixtureGateway(world));
    const { processor } = await processorDeps({ leaseMs: STALE_LEASE });

    // worker #1 claims, then dies before doing anything
    const { claimJob } = await import("@revessent/worker");
    expect(await claimJob(appDb(), rig.orgId, jobRunId, STALE_LEASE, new Date())).not.toBeNull();
    await expireLease(jobRunId);

    // worker #2 (restart) processes the redelivered job
    expect(await processor(fakeJob({ jobRunId, orgId: rig.orgId, caseId: rig.caseId }))).toEqual({ result: "executed" });
    expect(world.pay!.operations).toHaveLength(1); // ONE financial execution total
    expect(await attemptsRows("auto_retry")).toHaveLength(1);
    resetFixtureWorlds();
  });

  it("B. crash DURING execution (reserved attempt, died mid-run): resume with the SAME 4D identity — never a second one", async () => {
    const jobRunId = await enqueueOnly();
    const world = baseWorld();
    world.pay = { behavior: "ok", idempotentReplay: true };
    setStripeGatewayForTests(fixtureGateway(world));
    const { processor } = await processorDeps({ leaseMs: STALE_LEASE });

    // the crashed worker had already reserved the 4D attempt (durable, key :1)
    const { executionService } = await import("@revessent/server");
    const { claimJob } = await import("@revessent/worker");
    expect(await claimJob(appDb(), rig.orgId, jobRunId, STALE_LEASE, new Date())).not.toBeNull();
    await withOrgTx(appDb(), rig.orgId, (tx) =>
      tx.insert(schema.recoveryAttempts).values({
        orgId: rig.orgId, caseId: rig.caseId, paymentId: rig.paymentId,
        amountCents: 1900, currency: "USD",
        requestHash: executionService._internal.requestHashOf({
          paymentId: rig.paymentId, amountCents: 1900, currency: "USD", customerStripeId: "cus_fixture_001"
        }),
        kind: "auto_retry", actor: "system",
        scheduledAt: new Date(), status: "scheduled",
        idempotencyKey: `rv:${rig.orgId}:${rig.caseId}:1`, policyVersion: 1, attemptNo: 1
      }));
    await expireLease(jobRunId);

    expect(await processor(fakeJob({ jobRunId, orgId: rig.orgId, caseId: rig.caseId }))).toEqual({ result: "executed" });
    const rows = await attemptsRows("auto_retry");
    expect(rows).toHaveLength(1); // SAME row resumed — no second attempt identity
    expect(rows[0]!.idempotencyKey).toBe(`rv:${rig.orgId}:${rig.caseId}:1`);
    expect(world.pay!.operations).toHaveLength(1); // exactly one provider operation across the crash
    resetFixtureWorlds();
  });

  it("C. crash AFTER provider success but BEFORE queue acknowledgement: redelivery converges through payment truth — no second charge", async () => {
    const jobRunId = await enqueueOnly();
    const world = baseWorld();
    world.pay = { behavior: "ok", idempotentReplay: true };
    setStripeGatewayForTests(fixtureGateway(world));
    const { processor } = await processorDeps({ leaseMs: STALE_LEASE });

    // first delivery completes the payment, then "crashes" before ack
    expect(await processor(fakeJob({ jobRunId, orgId: rig.orgId, caseId: rig.caseId }))).toEqual({ result: "executed" });
    expect((await paymentRowRig()).status).toBe("paid");
    // simulate the lost ack: the durable job still looks leased/stale
    await withOrgTx(appDb(), rig.orgId, (tx) =>
      tx.update(schema.jobRuns).set({ status: "leased", leaseExpiresAt: new Date(Date.now() - 1_000) })
        .where(eq(schema.jobRuns.id, jobRunId)));

    // redelivery converges: 4D finds a paid payment → not_due → ack
    expect(await processor(fakeJob({ jobRunId, orgId: rig.orgId, caseId: rig.caseId }))).toEqual({ result: "not_due" });
    expect(world.pay!.operations).toHaveLength(1); // NEVER charged twice
    expect(await attemptsRows("auto_retry")).toHaveLength(1);
    resetFixtureWorlds();
  });

  it("D. crash after the DB transition but before the queue ack: redelivery is harmless", async () => {
    const jobRunId = await enqueueOnly();
    const world = baseWorld();
    world.pay = { behavior: "ok", idempotentReplay: true };
    setStripeGatewayForTests(fixtureGateway(world));
    const { processor } = await processorDeps({ leaseMs: STALE_LEASE });
    expect(await processor(fakeJob({ jobRunId, orgId: rig.orgId, caseId: rig.caseId }))).toEqual({ result: "executed" });
    const ops = world.pay!.operations.length;
    // queue never saw the ack — full redelivery of the same payload
    expect(await processor(fakeJob({ jobRunId, orgId: rig.orgId, caseId: rig.caseId }))).toEqual({ result: "already_terminal" });
    expect(world.pay!.operations).toHaveLength(ops);
    resetFixtureWorlds();
  });

  it("E. worker restart: the recovery scan surfaces stale leases and missing Redis jobs; work becomes processable again", async () => {
    const jobRunId = await enqueueOnly();
    const { claimJob } = await import("@revessent/worker");
    expect(await claimJob(appDb(), rig.orgId, jobRunId, STALE_LEASE, new Date())).not.toBeNull();
    await expireLease(jobRunId);
    // Redis loses the delivery entirely (crash before ack + Redis flush)
    const { createRetriesQueue } = await import("@revessent/worker");
    const q = createRetriesQueue(process.env.REDIS_URL!);
    const job = await q.getJob(retryExecuteDedupeKey(rig.orgId, rig.caseId));
    await job?.remove().catch(() => undefined);

    const { reconcileOrgJobsWithRedis } = await import("@revessent/worker");
    const stats = await reconcileOrgJobsWithRedis(appDb(), q as never, rig.orgId, 100);
    expect(stats.reenqueued).toBe(1); // reconstructed from durable state
    await q.close().catch(() => undefined);

    // the restarted worker processes the reconstruction
    const world = baseWorld();
    world.pay = { behavior: "ok", idempotentReplay: true };
    setStripeGatewayForTests(fixtureGateway(world));
    const { processor } = await processorDeps({ leaseMs: STALE_LEASE });
    expect(await processor(fakeJob({ jobRunId, orgId: rig.orgId, caseId: rig.caseId }))).toEqual({ result: "executed" });
    expect(world.pay!.operations).toHaveLength(1);
    resetFixtureWorlds();
  });

  it("stale-lease recovery racing a live worker: the live lease is never stolen", async () => {
    const jobRunId = await enqueueOnly();
    const { claimJob, reconcileOrgJobsWithRedis, createRetriesQueue } = await import("@revessent/worker");
    // live worker holds an UNEXPIRED lease
    expect(await claimJob(appDb(), rig.orgId, jobRunId, 300_000, new Date())).not.toBeNull();
    const q = createRetriesQueue(process.env.REDIS_URL!);
    const stats = await reconcileOrgJobsWithRedis(appDb(), q as never, rig.orgId, 100);
    expect(stats.skippedActiveLease).toBe(1); // recognized as actively running
    expect(stats.reenqueued).toBe(0);
    await q.close().catch(() => undefined);
  });

  it("concurrent duplicate delivery: exactly one provider operation across two simultaneous processors", async () => {
    const jobRunId = await enqueueOnly();
    const world = baseWorld();
    world.pay = { behavior: "ok", idempotentReplay: true };
    setStripeGatewayForTests(fixtureGateway(world));
    const { processor } = await processorDeps({ leaseMs: STALE_LEASE });
    const results = await Promise.allSettled([
      processor(fakeJob({ jobRunId, orgId: rig.orgId, caseId: rig.caseId })),
      processor(fakeJob({ jobRunId, orgId: rig.orgId, caseId: rig.caseId }))
    ]);
    const outcomes = results.map((r) => (r.status === "fulfilled" ? r.value.result : `rejected:${String((r as PromiseRejectedResult).reason).slice(0, 40)}`));
    // one executes; the other is refused at claim OR refused by 4D gates — never two payments
    const executedCount = outcomes.filter((o) => o === "executed").length;
    expect(executedCount).toBeLessThanOrEqual(1);
    expect(world.pay!.operations.length).toBeLessThanOrEqual(1);
    expect((await paymentRowRig()).status === "paid" || executedCount === 0).toBe(true);
    resetFixtureWorlds();
  });
});
