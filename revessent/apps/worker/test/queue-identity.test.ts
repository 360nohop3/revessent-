/**
 * PHASE 5 — queue identity & durable-first enqueue (§6, §8, §9):
 * deterministic job identity, duplicate-enqueue convergence, payload
 * validation, and Redis-unavailable behavior (the durable row survives; the
 * delivery is reconstructed later).
 */
import { describe, expect, it, beforeEach, afterEach, afterAll } from "vitest";
import type { Queue } from "bullmq";
import { eq } from "drizzle-orm";
import { appDb, withOrgTx, schema } from "./helpers.js";
import { seedRig, acquireTestRedis, releaseTestRedis, flushTestRedis, TEST_REDIS_URL, afterEachCleanup, type Rig } from "./helpers.js";
import {
  createRetriesQueue, enqueueRetryExecution, reenqueueExistingJob,
  RetryExecutePayload, retryExecuteDedupeKey, RETRIES_QUEUE, RETRY_EXECUTE_JOB
} from "@revessent/worker";

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

describe("deterministic job identity", () => {
  it("the dedupe key is a pure function of (org, case)", () => {
    const a = retryExecuteDedupeKey("org-1", "case-1");
    expect(a).toBe("retry-exec:org-1:case-1");
    expect(retryExecuteDedupeKey("org-1", "case-1")).toBe(a);
    expect(retryExecuteDedupeKey("org-1", "case-2")).not.toBe(a);
  });

  it("enqueue creates the durable row FIRST and a BullMQ job under the deterministic id", async () => {
    const res = await enqueueRetryExecution(queue as never, appDb(), { orgId: rig.orgId, caseId: rig.caseId });
    expect(res.enqueued).toBe(true);

    const row = await withOrgTx(appDb(), rig.orgId, (tx) =>
      tx.select().from(schema.jobRuns).where(eq(schema.jobRuns.id, res.jobRunId)));
    expect(row).toHaveLength(1);
    expect(row[0]!.queue).toBe(RETRIES_QUEUE);
    expect(row[0]!.jobType).toBe(RETRY_EXECUTE_JOB);
    expect(row[0]!.status).toBe("queued");
    expect(row[0]!.dedupeKey).toBe(retryExecuteDedupeKey(rig.orgId, rig.caseId));

    const job = await queue.getJob(retryExecuteDedupeKey(rig.orgId, rig.caseId));
    expect(job).toBeDefined();
    // payload validated by the same schema the worker enforces
    expect(RetryExecutePayload.parse(job!.data)).toEqual({ jobRunId: res.jobRunId, orgId: rig.orgId, caseId: rig.caseId });
  });

  it("duplicate enqueue (same case) converges: one durable row, one BullMQ job", async () => {
    const first = await enqueueRetryExecution(queue as never, appDb(), { orgId: rig.orgId, caseId: rig.caseId });
    const second = await enqueueRetryExecution(queue as never, appDb(), { orgId: rig.orgId, caseId: rig.caseId });
    expect(first.enqueued).toBe(true);
    expect(second.enqueued).toBe(false);
    expect(second.reason).toBe("live_job_exists");

    const rows = await withOrgTx(appDb(), rig.orgId, (tx) => tx.select().from(schema.jobRuns));
    expect(rows).toHaveLength(1);
    const waiting = await queue.getWaiting();
    expect(waiting).toHaveLength(1);
  });

  it("even bypassing the helper, a raw duplicate BullMQ add with the same jobId does not duplicate", async () => {
    const key = retryExecuteDedupeKey(rig.orgId, rig.caseId);
    const res = await enqueueRetryExecution(queue as never, appDb(), { orgId: rig.orgId, caseId: rig.caseId });
    await queue.add(RETRY_EXECUTE_JOB, { jobRunId: res.jobRunId, orgId: rig.orgId, caseId: rig.caseId } as never, { jobId: key });
    const waiting = await queue.getWaiting();
    expect(waiting).toHaveLength(1);
  });

  it("unsafe payloads are rejected by the queue contract (identifiers only)", () => {
    expect(RetryExecutePayload.safeParse({ jobRunId: "not-a-uuid", orgId: "x", caseId: "y" }).success).toBe(false);
    expect(RetryExecutePayload.safeParse({}).success).toBe(false);
    // an oversized/forged payload with extra fields fails the strict parse
    expect(RetryExecutePayload.safeParse({
      jobRunId: "00000000-0000-0000-0000-000000000000",
      orgId: "00000000-0000-0000-0000-000000000000",
      caseId: "00000000-0000-0000-0000-000000000000",
      amountCents: 999999 // financial parameters are NEVER carried on jobs
    }).success).toBe(false);
  });
});

describe("Redis-unavailable: durable-first behavior (§9)", () => {
  it("enqueue with Redis down keeps the durable row queued and reports redis_unavailable", async () => {
    await queue.close().catch(() => undefined); // stop the queue connection
    const broken = createRetriesQueue("redis://127.0.0.1:6390", { retryStrategy: () => null }); // nothing listens here — fail fast
    try {
      const res = await enqueueRetryExecution(broken as never, appDb(), { orgId: rig.orgId, caseId: rig.caseId });
      expect(res.enqueued).toBe(false);
      expect(res.reason).toBe("redis_unavailable");
      const rows = await withOrgTx(appDb(), rig.orgId, (tx) => tx.select().from(schema.jobRuns));
      expect(rows).toHaveLength(1); // durable authority survives
      expect(rows[0]!.status).toBe("queued");
      // re-discovery does NOT amplify: still one row
      await enqueueRetryExecution(broken as never, appDb(), { orgId: rig.orgId, caseId: rig.caseId });
      const rows2 = await withOrgTx(appDb(), rig.orgId, (tx) => tx.select().from(schema.jobRuns));
      expect(rows2).toHaveLength(1);
    } finally {
      await broken.close().catch(() => undefined);
    }
  });

  it("recovery re-enqueues the surviving durable row once Redis returns", async () => {
    // 1) Redis down at enqueue time → durable row only
    const broken = createRetriesQueue("redis://127.0.0.1:6390", { retryStrategy: () => null }); // nothing listens — fail fast
    broken.on("error", () => { /* expected — this queue is the outage */ });
    const res = await enqueueRetryExecution(broken as never, appDb(), { orgId: rig.orgId, caseId: rig.caseId });
    expect(res.enqueued).toBe(false);
    await broken.close().catch(() => undefined);

    // 2) Redis back: a FRESH queue sees nothing in Redis for the dedupe key
    const revived = createRetriesQueue(TEST_REDIS_URL);
    await revived.waitUntilReady(); // fail-fast connection: wait before commands
    const key = retryExecuteDedupeKey(rig.orgId, rig.caseId);
    expect(await revived.getJob(key)).toBeUndefined(); // absent from Redis

    // 3) the recovery scan re-enqueues from the durable row (same identity)
    const [row] = await withOrgTx(appDb(), rig.orgId, (tx) => tx.select().from(schema.jobRuns));
    expect(await reenqueueExistingJob(revived as never, row!)).toBe(true);
    const job = await revived.getJob(key);
    expect(job).toBeDefined();
    expect(job!.id).toBe(key); // SAME deterministic identity
    await revived.close().catch(() => undefined);
  });
});

