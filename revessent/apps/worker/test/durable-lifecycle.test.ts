/**
 * PHASE 5 — durable job lifecycle (§5): RLS isolation on job_runs, the
 * one-live-job dedupe guarantee, atomic claims, stale-lease reclaim, and the
 * infrastructure-failure requeue→dead-letter transition. The database — not
 * Redis — is the authority for what work exists and what already ran.
 */
import { describe, expect, it, beforeEach, afterEach, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { appDb, withOrgTx, withoutOrg, schema, suffix, createTestOrg, createTestUser } from "./helpers.js";
import {
  createLiveJob, claimJob, completeJob, cancelJob, recordInfraFailure
} from "@revessent/worker";
import { RETRIES_QUEUE, RETRY_EXECUTE_JOB, retryExecuteDedupeKey } from "@revessent/worker";
import { acquireTestRedis, releaseTestRedis } from "./helpers.js";

const LEASE_MS = 60_000;

async function makeOrg(): Promise<{ orgId: string; caseId: string; otherOrgId: string }> {
  const owner = await createTestUser("joblife-owner");
  const { orgId } = await createTestOrg(owner, `jl${suffix()}`);
  const owner2 = await createTestUser("joblife-other");
  const { orgId: otherOrgId } = await createTestOrg(owner2, `jo${suffix()}`);
  const [cust] = await withOrgTx(appDb(), orgId, (tx) =>
    tx.insert(schema.customers).values({ orgId, stripeCustomerId: `cus_jl_${suffix()}` }).returning());
  const [pay] = await withOrgTx(appDb(), orgId, (tx) =>
    tx.insert(schema.payments).values({
      orgId, customerId: cust!.id, stripeInvoiceId: `in_jl_${suffix()}`,
      amountCents: 1000, currency: "USD", status: "failed"
    }).returning());
  const [c] = await withOrgTx(appDb(), orgId, (tx) =>
    tx.insert(schema.recoveryCases).values({
      orgId, customerId: cust!.id, paymentId: pay!.id,
      status: "retrying", declineCode: "insufficient_funds", declineCategory: "insufficient_funds",
      amountCents: 1000, currency: "USD",
      firstFailedAt: new Date(), nextActionAt: new Date(), attemptNo: 0
    }).returning());
  return { orgId, caseId: c!.id, otherOrgId };
}

let ids: { orgId: string; caseId: string; otherOrgId: string };

beforeEach(async () => {
  await acquireTestRedis();
  ids = await makeOrg();
});
afterEach(() => void releaseTestRedis());
afterAll(() => void releaseTestRedis());

describe("job_runs durable lifecycle", () => {
  it("RLS: the app role sees zero rows unscoped, its own org's rows scoped, never another org's", async () => {
    const dedupeKey = retryExecuteDedupeKey(ids.orgId, ids.caseId);
    await createLiveJob(appDb(), { orgId: ids.orgId, caseId: ids.caseId, jobType: RETRY_EXECUTE_JOB, queue: RETRIES_QUEUE, dedupeKey, runAfter: new Date(), maxAttempts: 5 });

    const unscoped = await withoutOrg(appDb(), (tx) => tx.select().from(schema.jobRuns));
    expect(unscoped).toHaveLength(0);

    const scoped = await withOrgTx(appDb(), ids.orgId, (tx) => tx.select().from(schema.jobRuns));
    expect(scoped).toHaveLength(1);

    const foreign = await withOrgTx(appDb(), ids.otherOrgId, (tx) => tx.select().from(schema.jobRuns));
    expect(foreign).toHaveLength(0);
  });

  it("the partial unique index admits only ONE live job per dedupe key — but a new round after completion", async () => {
    const key = retryExecuteDedupeKey(ids.orgId, ids.caseId);
    const first = await createLiveJob(appDb(), { orgId: ids.orgId, caseId: ids.caseId, jobType: RETRY_EXECUTE_JOB, queue: RETRIES_QUEUE, dedupeKey: key, runAfter: new Date(), maxAttempts: 5 });
    expect(first.created).toBe(true);
    const dup = await createLiveJob(appDb(), { orgId: ids.orgId, caseId: ids.caseId, jobType: RETRY_EXECUTE_JOB, queue: RETRIES_QUEUE, dedupeKey: key, runAfter: new Date(), maxAttempts: 5 });
    expect(dup.created).toBe(false);
    expect(dup.row.id).toBe(first.row.id); // same durable row — no amplification

    await completeJob(appDb(), ids.orgId, first.row.id, "executed");
    const next = await createLiveJob(appDb(), { orgId: ids.orgId, caseId: ids.caseId, jobType: RETRY_EXECUTE_JOB, queue: RETRIES_QUEUE, dedupeKey: key, runAfter: new Date(), maxAttempts: 5 });
    expect(next.created).toBe(true); // completed ⇒ identity freed for a NEW delivery round
  });

  it("claims are atomic: two concurrent claims of one queued job ⇒ exactly one winner", async () => {
    const key = retryExecuteDedupeKey(ids.orgId, ids.caseId);
    const { row } = await createLiveJob(appDb(), { orgId: ids.orgId, caseId: ids.caseId, jobType: RETRY_EXECUTE_JOB, queue: RETRIES_QUEUE, dedupeKey: key, runAfter: new Date(), maxAttempts: 5 });
    const results = await Promise.all([
      claimJob(appDb(), ids.orgId, row.id, LEASE_MS, new Date()),
      claimJob(appDb(), ids.orgId, row.id, LEASE_MS, new Date())
    ]);
    const winners = results.filter((r) => r !== null);
    expect(winners).toHaveLength(1);
    expect(winners[0]!.status).toBe("leased");
    expect(winners[0]!.attempts).toBe(1);
  });

  it("a LIVE lease is never reclaimed; an EXPIRED lease is", async () => {
    const key = retryExecuteDedupeKey(ids.orgId, ids.caseId);
    const { row } = await createLiveJob(appDb(), { orgId: ids.orgId, caseId: ids.caseId, jobType: RETRY_EXECUTE_JOB, queue: RETRIES_QUEUE, dedupeKey: key, runAfter: new Date(), maxAttempts: 5 });
    const claim = await claimJob(appDb(), ids.orgId, row.id, LEASE_MS, new Date());
    expect(claim).not.toBeNull();

    // live lease: claim refused
    const blocked = await claimJob(appDb(), ids.orgId, row.id, LEASE_MS, new Date());
    expect(blocked).toBeNull();

    // lease expired: claim reclaims (stale-job recovery)
    const later = new Date(Date.now() + LEASE_MS + 5_000);
    const reclaimed = await claimJob(appDb(), ids.orgId, row.id, LEASE_MS, later);
    expect(reclaimed).not.toBeNull();
    expect(reclaimed!.attempts).toBe(2); // bookkeeping advanced across the reclaim
  });

  it("terminal transitions: succeeded/canceled clear the lease and are final", async () => {
    const key = retryExecuteDedupeKey(ids.orgId, ids.caseId);
    const { row } = await createLiveJob(appDb(), { orgId: ids.orgId, caseId: ids.caseId, jobType: RETRY_EXECUTE_JOB, queue: RETRIES_QUEUE, dedupeKey: key, runAfter: new Date(), maxAttempts: 5 });
    await claimJob(appDb(), ids.orgId, row.id, LEASE_MS, new Date());
    expect(await completeJob(appDb(), ids.orgId, row.id, "executed")).toBe(true);
    const done = await withOrgTx(appDb(), ids.orgId, (tx) =>
      tx.select().from(schema.jobRuns).where(and(eq(schema.jobRuns.id, row.id), eq(schema.jobRuns.status, "succeeded"))));
    expect(done).toHaveLength(1);
    expect(done[0]!.outcome).toBe("executed");
    expect(done[0]!.finishedAt).not.toBeNull();
    // terminal rows are inert: no further claim, no further complete
    expect(await claimJob(appDb(), ids.orgId, row.id, LEASE_MS, new Date())).toBeNull();
    expect(await completeJob(appDb(), ids.orgId, row.id, "not_due")).toBe(false);
  });

  it("cancel is terminal and records the reason as the outcome", async () => {
    const key = retryExecuteDedupeKey(ids.orgId, ids.caseId);
    const { row } = await createLiveJob(appDb(), { orgId: ids.orgId, caseId: ids.caseId, jobType: RETRY_EXECUTE_JOB, queue: RETRIES_QUEUE, dedupeKey: key, runAfter: new Date(), maxAttempts: 5 });
    expect(await cancelJob(appDb(), ids.orgId, row.id, "no_such_case")).toBe(true);
    const [rowAfter] = await withOrgTx(appDb(), ids.orgId, (tx) =>
      tx.select().from(schema.jobRuns).where(eq(schema.jobRuns.id, row.id)));
    expect(rowAfter!.status).toBe("canceled");
    expect(rowAfter!.outcome).toBe("no_such_case");
  });

  it("infrastructure failures requeue, then dead-letter at the attempt budget", async () => {
    const key = retryExecuteDedupeKey(ids.orgId, ids.caseId);
    const { row } = await createLiveJob(appDb(), { orgId: ids.orgId, caseId: ids.caseId, jobType: RETRY_EXECUTE_JOB, queue: RETRIES_QUEUE, dedupeKey: key, runAfter: new Date(), maxAttempts: 5 });

    // attempts 1..4 → back to queued (BullMQ redelivers)
    for (let attempt = 1; attempt <= 4; attempt++) {
      expect(await claimJob(appDb(), ids.orgId, row.id, LEASE_MS, new Date())).not.toBeNull();
      const state = await recordInfraFailure(appDb(), ids.orgId, row.id, { category: "infrastructure", code: "delivery_error" });
      expect(state).toBe("queued");
    }
    // attempt 5 (budget) → terminal failed (dead-letter)
    expect(await claimJob(appDb(), ids.orgId, row.id, LEASE_MS, new Date())).not.toBeNull();
    const state = await recordInfraFailure(appDb(), ids.orgId, row.id, { category: "infrastructure", code: "delivery_error" });
    expect(state).toBe("failed");
    const [dead] = await withOrgTx(appDb(), ids.orgId, (tx) =>
      tx.select().from(schema.jobRuns).where(eq(schema.jobRuns.id, row.id)));
    expect(dead!.status).toBe("failed");
    expect(dead!.lastErrorCategory).toBe("infrastructure");
    expect(dead!.lastErrorCode).toBe("delivery_error"); // safe code — never a provider body
    expect(dead!.finishedAt).not.toBeNull();
    // terminal failed is inert
    expect(await claimJob(appDb(), ids.orgId, row.id, LEASE_MS, new Date())).toBeNull();
  });
});
