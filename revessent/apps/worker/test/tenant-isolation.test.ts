/**
 * PHASE 5 — tenant isolation (§13). The queue payload is untrusted; every
 * delivery verifies the durable org↔case↔job relationship under RLS before
 * anything runs. A job for org A can never execute against org B.
 */
import { describe, expect, it, beforeEach, afterEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { appDb, withOrgTx, schema, createTestUser, createTestOrg, suffix, withoutOrg } from "./helpers.js";
import {
  seedRig, acquireTestRedis, releaseTestRedis, flushTestRedis, afterEachCleanup,
  attemptsRows, processorDeps, fakeJob, baseWorld, type Rig
} from "./helpers.js";
import { enqueueRetryExecution } from "@revessent/worker";
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

async function enqueueOnly(orgId: string, caseId: string): Promise<string> {
  const { createRetriesQueue } = await import("@revessent/worker");
  const q = createRetriesQueue(process.env.REDIS_URL!);
  try {
    return (await enqueueRetryExecution(q as never, appDb(), { orgId, caseId })).jobRunId;
  } finally {
    await q.close().catch(() => undefined);
  }
}

describe("tenant isolation", () => {
  it("a forged payload (org A's ids, org B's durable job id) executes NOTHING", async () => {
    const outsider = await createTestUser("iso-outsider");
    const { orgId: orgB, slug: slugB } = await createTestOrg(outsider, `iso${suffix()}`);
    void slugB;
    const jobRunB = await enqueueOnly(rig.orgId, rig.caseId); // durable job belongs to org A (rig)

    // attacker-controlled queue payload claims org B context but references
    // org A's durable job — the RLS-scoped verification finds no such row
    // for (orgB, caseB, jobRunB) and acks without action.
    const world = baseWorld();
    world.pay = { behavior: "ok", idempotentReplay: true };
    setStripeGatewayForTests(fixtureGateway(world));
    const { processor } = await processorDeps();
    const out = await processor(fakeJob({ jobRunId: jobRunB, orgId: orgB, caseId: rig.caseId }));
    expect(["no_durable_job", "target_gone", "org_gone"]).toContain((out as { result: string }).result);
    expect(world.pay!.operations ?? []).toHaveLength(0); // nothing executed anywhere
    // org B gained no durable job either
    const orgBRows = await withOrgTx(appDb(), orgB, (tx) => tx.select().from(schema.jobRuns));
    expect(orgBRows).toHaveLength(0);
    resetFixtureWorlds();
  });

  it("RLS on job_runs: one org's worker context cannot load another org's job rows", async () => {
    const jobRunA = await enqueueOnly(rig.orgId, rig.caseId);
    const outsider = await createTestUser("iso-outsider2");
    const { orgId: orgB } = await createTestOrg(outsider, `iso2${suffix()}`);
    const seen = await withOrgTx(appDb(), orgB, (tx) =>
      tx.select().from(schema.jobRuns).where(eq(schema.jobRuns.id, jobRunA)));
    expect(seen).toHaveLength(0); // invisible — RLS, not convention
    const unscoped = await withoutOrg(appDb(), (tx) => tx.select().from(schema.jobRuns));
    expect(unscoped).toHaveLength(0);
  });

  it("two organizations process independently: each delivery touches only its own case", async () => {
    // org B with its own due case
    const outsider = await createTestUser("iso-b");
    const orgB = await createTestOrg(outsider, `isob${suffix()}`);
    const worldB = baseWorld();
    setStripeGatewayForTests(fixtureGateway(worldB));
    const ctxB = await (await import("@revessent/server")).requireOrgRole != null
      ? await (async () => {
          const { ctxFor } = await import("./helpers.js");
          return ctxFor(outsider, orgB.slug, "administer");
        })()
      : null;
    void ctxB;
    const { settingsService, syncService } = await import("@revessent/server");
    const { ctxFor } = await import("./helpers.js");
    const adminB = await ctxFor(outsider, orgB.slug, "administer");
    await settingsService.stripeConnect(adminB, "rk_test_0123456789abcdefABCD", {});
    await syncService.triggerSync(adminB, {});
    const [payB] = await withOrgTx(appDb(), orgB.orgId, (tx) =>
      tx.select().from(schema.payments).where(eq(schema.payments.status, "failed")).limit(1));
    const [caseB] = await withOrgTx(appDb(), orgB.orgId, (tx) =>
      tx.insert(schema.recoveryCases).values({
        orgId: orgB.orgId, customerId: payB!.customerId, paymentId: payB!.id,
        status: "retrying", declineCode: "insufficient_funds", declineCategory: "insufficient_funds",
        amountCents: payB!.amountCents, currency: payB!.currency,
        firstFailedAt: new Date(Date.now() - 3 * 86_400_000),
        nextActionAt: new Date(Date.now() - 3_600_000), attemptNo: 0, retryPolicyVersion: 1
      }).returning());

    const jobRunA = await enqueueOnly(rig.orgId, rig.caseId);
    const jobRunB = await enqueueOnly(orgB.orgId, caseB!.id);

    const world = baseWorld();
    world.pay = { behavior: "ok", idempotentReplay: true };
    setStripeGatewayForTests(fixtureGateway(world));
    const { processor } = await processorDeps();

    expect(await processor(fakeJob({ jobRunId: jobRunA, orgId: rig.orgId, caseId: rig.caseId }))).toEqual({ result: "executed" });
    // org B delivers through ORG B's provider world (with real Stripe each org
    // has its own account; the fixture gateway is a process-wide stand-in)
    setStripeGatewayForTests(fixtureGateway(worldB));
    expect(await processor(fakeJob({ jobRunId: jobRunB, orgId: orgB.orgId, caseId: caseB!.id }))).toEqual({ result: "executed" });

    // each org sees exactly its own automated attempt and its own recovered case
    const attemptsA = await attemptsRows("auto_retry");
    expect(attemptsA).toHaveLength(1);
    expect(attemptsA[0]!.orgId).toBe(rig.orgId);
    const attemptsB = await withOrgTx(appDb(), orgB.orgId, (tx) =>
      tx.select().from(schema.recoveryAttempts).where(eq(schema.recoveryAttempts.orgId, orgB.orgId)));
    expect(attemptsB).toHaveLength(1);
    expect(attemptsB[0]!.orgId).toBe(orgB.orgId);
    // org A's case is recovered; org B's case is recovered; no cross-contamination
    const [caseAAfter] = await withOrgTx(appDb(), rig.orgId, (tx) =>
      tx.select().from(schema.recoveryCases).where(eq(schema.recoveryCases.id, rig.caseId)));
    const [caseBAfter] = await withOrgTx(appDb(), orgB.orgId, (tx) =>
      tx.select().from(schema.recoveryCases).where(eq(schema.recoveryCases.id, caseB!.id)));
    expect(caseAAfter!.status).toBe("recovered");
    expect(caseBAfter!.status).toBe("recovered");
    // each org's job ledger holds exactly one job
    expect((await withOrgTx(appDb(), rig.orgId, (tx) => tx.select().from(schema.jobRuns)))).toHaveLength(1);
    expect((await withOrgTx(appDb(), orgB.orgId, (tx) => tx.select().from(schema.jobRuns)))).toHaveLength(1);
    resetFixtureWorlds();
  });

  it("the scheduler's per-org discovery is RLS-scoped: an org's cycle only enqueues its own cases", async () => {
    const { cycleOrg, createRetriesQueue } = await import("@revessent/worker");
    const outsider = await createTestUser("iso-c");
    const orgB = await createTestOrg(outsider, `isoc${suffix()}`);
    const queue = createRetriesQueue(process.env.REDIS_URL!);
    await queue.waitUntilReady();
    const deps = {
      db: appDb(),
      systemDb: (await import("@revessent/db")).createDb(process.env.SCHEDULER_DATABASE_URL!),
      queue: queue as never,
      scanLimit: 100,
      orgLimit: 200
    };
    // each org's cycle runs under its own RLS scope and sees only its own work
    const statsA = await cycleOrg(deps, rig.orgId);
    expect(statsA.enqueued).toBe(1);   // org A's due case discovered
    const statsB = await cycleOrg(deps, orgB.orgId);
    expect(statsB.enqueued).toBe(0);   // org B has no due work — nothing leaks in
    const rowsB = await withOrgTx(appDb(), orgB.orgId, (tx) => tx.select().from(schema.jobRuns));
    expect(rowsB).toHaveLength(0);     // org B gained no job ledger rows
    await queue.close();
    resetFixtureWorlds();
  });
});
