/**
 * PHASE 5 — worker delivery into the existing Phase 4D engine (§7): the
 * processor NEVER decides eligibility. Every delivery re-enters
 * runDueRetries, which re-checks everything under its own locks and executes
 * through the ONE Phase 4C primitive.
 */
import { describe, expect, it, beforeEach, afterEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { appDb, withOrgTx, schema } from "./helpers.js";
import {
  seedRig, acquireTestRedis, releaseTestRedis, flushTestRedis, afterEachCleanup,
  attemptsRows, caseRowRig, paymentRowRig, jobRow, processorDeps, fakeJob, baseWorld, type Rig
} from "./helpers.js";
import { enqueueRetryExecution, createRetriesQueue } from "@revessent/worker";
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

async function enqueuedJobId(): Promise<string> {
  const { createRetriesQueue } = await import("@revessent/worker");
  const q = createRetriesQueue(process.env.REDIS_URL!);
  try {
    const res = await enqueueRetryExecution(q as never, appDb(), { orgId: rig.orgId, caseId: rig.caseId });
    return res.jobRunId;
  } finally {
    await q.close().catch(() => undefined);
  }
}

describe("worker delivers to the existing Phase 4D engine", () => {
  it("successful delivery: one automated attempt through the 4C primitive, case recovered, job succeeded", async () => {
    const jobRunId = await enqueuedJobId();
    const world = baseWorld();
    world.pay = { behavior: "ok", idempotentReplay: true };
    setStripeGatewayForTests(fixtureGateway(world));
    const { processor } = await processorDeps();

    const out = await processor(fakeJob({ jobRunId, orgId: rig.orgId, caseId: rig.caseId }));
    expect(out).toEqual({ result: "executed" });

    expect(world.pay!.operations).toHaveLength(1); // exactly one provider operation
    expect((await paymentRowRig()).status).toBe("paid");
    expect((await caseRowRig()).status).toBe("recovered"); // 4D convergence, not worker logic
    const rows = await attemptsRows("auto_retry");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.attemptNo).toBe(1); // 4D numbering owns identity
    expect(rows[0]!.idempotencyKey).toBe(`rv:${rig.orgId}:${rig.caseId}:1`);

    const jr = await jobRow(jobRunId);
    expect(jr!.status).toBe("succeeded");
    expect(jr!.outcome).toBe("executed");
    expect(jr!.finishedAt).not.toBeNull();
  });

  it("business refusal (non-retryable category): delivery succeeds, the 4D decision is recorded, zero provider ops", async () => {
    await withOrgTx(appDb(), rig.orgId, (tx) =>
      tx.update(schema.retryPolicies).set({ rules: {
        maxAutoRetries: 2, quietHoursStart: 21, quietHoursEnd: 8, minGapHours: 24,
        noteAfterFailedRetries: 1, checkoutAfterNote: true,
        autoRetry: { perCategory: { insufficient_funds: { retryable: false, maxAttempts: 4 } }, backoffMultiplier: 2, maxBackoffHours: 168 }
      } as never }).where(eq(schema.retryPolicies.orgId, rig.orgId)));
    const jobRunId = await enqueuedJobId();
    const world = baseWorld();
    world.pay = { behavior: "ok", idempotentReplay: true };
    setStripeGatewayForTests(fixtureGateway(world));
    const { processor } = await processorDeps();

    expect(await processor(fakeJob({ jobRunId, orgId: rig.orgId, caseId: rig.caseId }))).toEqual({ result: "blocked" });
    expect(world.pay!.operations ?? []).toHaveLength(0); // the worker never paid — the ENGINE refused
    const audits = await withOrgTx(appDb(), rig.orgId, (tx) =>
      tx.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "retry.blocked")));
    expect(audits.length).toBeGreaterThanOrEqual(1); // the refusal is the 4D engine's audit
    expect((await jobRow(jobRunId))!.outcome).toBe("blocked");
  });

  it("backoff/waiting: delivery succeeds with outcome waiting, zero provider ops, work stays durable", async () => {
    const jobRunId = await enqueuedJobId();
    // case back inside the backoff window → 4D says waiting
    await withOrgTx(appDb(), rig.orgId, (tx) =>
      tx.update(schema.recoveryCases).set({ firstFailedAt: new Date() })
        .where(eq(schema.recoveryCases.id, rig.caseId)));
    const world = baseWorld();
    world.pay = { behavior: "ok", idempotentReplay: true };
    setStripeGatewayForTests(fixtureGateway(world));
    const { processor } = await processorDeps();

    expect(await processor(fakeJob({ jobRunId, orgId: rig.orgId, caseId: rig.caseId }))).toEqual({ result: "waiting" });
    expect(world.pay!.operations ?? []).toHaveLength(0);
    const jr = await jobRow(jobRunId);
    expect(jr!.status).toBe("succeeded");
    expect(jr!.outcome).toBe("waiting");
  });

  it("not due anymore (payment already paid): outcome not_due, zero provider ops", async () => {
    const jobRunId = await enqueuedJobId();
    await withOrgTx(appDb(), rig.orgId, (tx) =>
      tx.update(schema.payments).set({ status: "paid" }).where(eq(schema.payments.id, rig.paymentId)));
    const { processor } = await processorDeps();
    expect(await processor(fakeJob({ jobRunId, orgId: rig.orgId, caseId: rig.caseId }))).toEqual({ result: "not_due" });
  });

  it("Phase 4D eligibility is RE-CHECKED at delivery: a case eligible at enqueue but paid before delivery is not executed", async () => {
    const { createRetriesQueue } = await import("@revessent/worker");
    const q = createRetriesQueue(process.env.REDIS_URL!);
    const res = await enqueueRetryExecution(q as never, appDb(), { orgId: rig.orgId, caseId: rig.caseId });
    await q.close().catch(() => undefined);
    // after enqueue, BEFORE delivery: another path recovers the payment
    await withOrgTx(appDb(), rig.orgId, (tx) =>
      tx.update(schema.payments).set({ status: "paid" }).where(eq(schema.payments.id, rig.paymentId)));
    const world = baseWorld();
    world.pay = { behavior: "ok", idempotentReplay: true };
    setStripeGatewayForTests(fixtureGateway(world));
    const { processor } = await processorDeps();
    expect(await processor(fakeJob({ jobRunId: res.jobRunId, orgId: rig.orgId, caseId: rig.caseId }))).toEqual({ result: "not_due" });
    expect(world.pay!.operations ?? []).toHaveLength(0);
    resetFixtureWorlds();
  });

  it("unknown outcome still blocks: the delivery completes but retries stay blocked until reconciliation", async () => {
    const jobRunId = await enqueuedJobId();
    const world = baseWorld();
    world.pay = { behavior: "network_loss_after_success", idempotentReplay: true };
    setStripeGatewayForTests(fixtureGateway(world));
    const { processor } = await processorDeps();
    expect(await processor(fakeJob({ jobRunId, orgId: rig.orgId, caseId: rig.caseId }))).toEqual({ result: "executed" });
    expect((await attemptsRows("auto_retry"))[0]!.status).toBe("unknown");

    // redelivery of the same work while unknown: the ENGINE refuses, not the worker
    const world2 = baseWorld();
    world2.pay = { behavior: "ok", idempotentReplay: true };
    setStripeGatewayForTests(fixtureGateway(world2));
    // the job row is terminal; simulate a redelivery of the SAME logical work
    // via a fresh scheduler round — but the case has nextActionAt NULL now, so
    // discovery finds nothing (no automatic retry of unknown outcomes).
    const oneOff = createRetriesQueue(process.env.REDIS_URL!);
    await oneOff.waitUntilReady();
    const { cycleOrg } = await import("@revessent/worker");
    const { createDb } = await import("@revessent/db");
    const stats = await cycleOrg({
      db: createDb(process.env.APP_DATABASE_URL!),
      systemDb: createDb(process.env.SCHEDULER_DATABASE_URL!),
      queue: oneOff as never,
      scanLimit: 100, orgLimit: 200
    }, rig.orgId);
    await oneOff.close().catch(() => undefined);
    expect(stats.enqueued).toBe(0);
    expect(world2.pay!.operations ?? []).toHaveLength(0);
    resetFixtureWorlds();
  });

  it("an unresolved delivery (attempt row still scheduled) is an INFRASTRUCTURE retry, not success", async () => {
    const jobRunId = await enqueuedJobId();
    // preflight cannot verify the provider state (raw error, not a mapped
    // ProviderError) ⇒ 4C refuses to execute and the attempt row stays
    // 'scheduled' — an UNRESOLVED outcome: the worker must not ack success
    const world = baseWorld();
    world.pay = { behavior: "ok" };
    const unreachable = fixtureGateway(world) as never as Record<string, unknown>;
    unreachable.getInvoiceForExecution = async () => { throw new Error("provider unreachable (simulated)"); };
    setStripeGatewayForTests(unreachable as never);
    const { processor } = await processorDeps();
    await expect(processor(fakeJob({ jobRunId, orgId: rig.orgId, caseId: rig.caseId }))).rejects.toThrow(/unresolved/);
    const jr = await jobRow(jobRunId);
    expect(jr!.status).toBe("queued"); // requeued for BullMQ backoff — not failed, not succeeded
    expect(jr!.lastErrorCategory).toBe("execution_unresolved");
    resetFixtureWorlds();
  });
});

describe("worker safety around payloads and durable state", () => {
  it("malformed payloads are rejected without execution", async () => {
    const world = baseWorld();
    world.pay = { behavior: "ok", idempotentReplay: true };
    setStripeGatewayForTests(fixtureGateway(world));
    const { processor } = await processorDeps();
    expect(await processor(fakeJob({ garbage: true }))).toEqual({ result: "invalid_payload" });
    expect(await processor(fakeJob(null))).toEqual({ result: "invalid_payload" });
    expect(world.pay!.operations ?? []).toHaveLength(0);
    expect(await attemptsRows("auto_retry")).toHaveLength(0);
    resetFixtureWorlds();
  });

  it("a queue payload with no durable job_runs counterpart is acknowledged without action", async () => {
    const world = baseWorld();
    world.pay = { behavior: "ok", idempotentReplay: true };
    setStripeGatewayForTests(fixtureGateway(world));
    const { processor } = await processorDeps();
    expect(await processor(fakeJob({
      jobRunId: "9b2f1c3d-0000-4000-8000-000000000001",
      orgId: rig.orgId, caseId: rig.caseId
    }))).toEqual({ result: "no_durable_job" });
    expect(world.pay!.operations ?? []).toHaveLength(0);
    resetFixtureWorlds();
  });

  it("terminal durable rows make duplicate deliveries harmless", async () => {
    const jobRunId = await enqueuedJobId();
    const world = baseWorld();
    world.pay = { behavior: "ok", idempotentReplay: true };
    setStripeGatewayForTests(fixtureGateway(world));
    const { processor } = await processorDeps();
    expect(await processor(fakeJob({ jobRunId, orgId: rig.orgId, caseId: rig.caseId }))).toEqual({ result: "executed" });
    const opsAfterFirst = world.pay!.operations.length;
    // duplicate delivery (at-least-once queue semantics)
    expect(await processor(fakeJob({ jobRunId, orgId: rig.orgId, caseId: rig.caseId }))).toEqual({ result: "already_terminal" });
    expect(world.pay!.operations).toHaveLength(opsAfterFirst); // no second financial execution
    resetFixtureWorlds();
  });
});
