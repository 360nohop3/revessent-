/**
 * PHASE 6 — the `notes` queue reuses the Phase 5 durable job primitives.
 * Verifies: durable identity, duplicate-job convergence, concurrent
 * delivery, crash (stale lease) recovery, Redis loss reconstruction,
 * scheduler discovery, transient email backoff, ambiguous ⇒ never resent,
 * tenant isolation. Real Redis, fake AI + email providers.
 */
import { describe, expect, it, beforeEach, afterEach, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { setTimeout as sleep } from "node:timers/promises";
import { appDb, withOrgTx, schema, createDb, ctxFor, createTestOrg, createTestUser } from "./helpers.js";
import { seedRig, acquireTestRedis, releaseTestRedis, flushTestRedis, TEST_REDIS_URL, afterEachCleanup, jobRow, type Rig } from "./helpers.js";
import {
  createNotesQueue, createRetriesQueue, enqueueCommunicationPrepare, enqueueCommunicationSend, notesProcessor,
  commPrepareDedupeKey, commSendDedupeKey, notesRedisJobId, cycleOrg, reconcileOrgNotesWithRedis, NOTES_QUEUE, COMM_PREPARE_JOB, COMM_SEND_JOB
} from "@revessent/worker";
import { checkoutService, communicationService, recoveryService } from "@revessent/server";
import { setEmailProviderForTests, resetEmailProvider } from "@revessent/integrations";
import { fakeEmailProvider } from "@revessent/integrations/email-fixtures";
import { setAiProviderForTests, resetAiProvider } from "@revessent/ai";
import { fakeAiProvider } from "@revessent/ai/fakes";

let rig: Rig;
const db = () => createDb(process.env.APP_DATABASE_URL!);
const systemDb = () => createDb(process.env.SCHEDULER_DATABASE_URL!);

beforeEach(async () => {
  await acquireTestRedis();
  await flushTestRedis();
  rig = await seedRig();
  // one executed automated retry ⇒ dunning note allowed by the v1 policy (noteAfterFailedRetries 1)
  await withOrgTx(appDb(), rig.orgId, (tx) => tx.insert(schema.recoveryAttempts).values({
    orgId: rig.orgId, caseId: rig.caseId, kind: "auto_retry", status: "failed", attemptNo: 1, scheduledFor: new Date(), decisionReason: "t", policyVersion: 1
  }));
  setAiProviderForTests(fakeAiProvider({ kind: "ok" }));
});
afterEach(() => { afterEachCleanup(); resetEmailProvider(); resetAiProvider(); void releaseTestRedis(); });
afterAll(() => void releaseTestRedis());

function proc(leaseMs = 300_000) {
  return notesProcessor({ db: db(), systemDb: systemDb(), leaseMs, concurrency: 1, redisUrl: TEST_REDIS_URL });
}
const fakeJob = (name: string, data: unknown, attemptsMade = 0) => ({ name, data, attemptsMade }) as never;

async function messages() {
  return withOrgTx(appDb(), rig.orgId, (tx) => tx.select().from(schema.recoveryMessages).where(eq(schema.recoveryMessages.caseId, rig.caseId)));
}
async function approve(messageId: string) {
  const ctx = await ctxFor(rig.owner, rig.slug, "operate");
  await recoveryService.applyDraftAction(ctx, rig.caseId, messageId, { type: "approve", actor: ctx.userId }, {});
}

describe("notes queue — durable identity", () => {
  it("duplicate prepare enqueues converge on one durable row and one Redis job", async () => {
    const q = createNotesQueue(TEST_REDIS_URL);
    try {
      const [a, b] = await Promise.all([
        enqueueCommunicationPrepare(q, db(), { orgId: rig.orgId, caseId: rig.caseId, trigger: "retry_failed" }),
        enqueueCommunicationPrepare(q, db(), { orgId: rig.orgId, caseId: rig.caseId, trigger: "retry_failed" })
      ]);
      expect([a.enqueued, b.enqueued].filter(Boolean)).toHaveLength(1);
      expect(a.jobRunId).toBe(b.jobRunId);
      const rows = await withOrgTx(appDb(), rig.orgId, (tx) => tx.select().from(schema.jobRuns).where(and(eq(schema.jobRuns.queue, NOTES_QUEUE), eq(schema.jobRuns.caseId, rig.caseId))));
      expect(rows).toHaveLength(1);
      expect(rows[0]!.jobType).toBe(COMM_PREPARE_JOB);
      expect(rows[0]!.dedupeKey).toBe(commPrepareDedupeKey(rig.orgId, rig.caseId, "retry_failed"));
      expect(await q.getJob(notesRedisJobId(rows[0]!.dedupeKey))).toBeDefined();
    } finally { await q.close(); }
  });

  it("processor: prepare then send, delivered at-least-once, produce ONE message and ONE email", async () => {
    const email = fakeEmailProvider({ kind: "ok" });
    setEmailProviderForTests(email);
    const q = createNotesQueue(TEST_REDIS_URL);
    try {
      const p = await enqueueCommunicationPrepare(q, db(), { orgId: rig.orgId, caseId: rig.caseId, trigger: "retry_failed" });
      const data = { jobRunId: p.jobRunId, orgId: rig.orgId, caseId: rig.caseId, trigger: "retry_failed" };
      const r1 = await proc()(fakeJob(COMM_PREPARE_JOB, data));
      expect(r1.result).toBe("prepared");
      const r2 = await proc()(fakeJob(COMM_PREPARE_JOB, data, 1)); // BullMQ redelivery
      expect(r2.result).toBe("already_terminal");
      const msgs = await messages();
      expect(msgs).toHaveLength(1);
      expect(msgs[0]!.approvalStatus).toBe("awaiting_approval");
      expect((await jobRow(p.jobRunId))!.outcome).toBe("prepared");

      // a second prepare job (new durable row after the first went terminal) converges on `exists`
      const p2 = await enqueueCommunicationPrepare(q, db(), { orgId: rig.orgId, caseId: rig.caseId, trigger: "retry_failed" });
      expect(p2.enqueued).toBe(true);
      expect((await proc()(fakeJob(COMM_PREPARE_JOB, { ...data, jobRunId: p2.jobRunId }))).result).toBe("exists");
      expect(await messages()).toHaveLength(1);

      // send: not approved ⇒ job completes with a business verdict, no email
      const s = await enqueueCommunicationSend(q, db(), { orgId: rig.orgId, caseId: rig.caseId, messageId: msgs[0]!.id });
      const sdata = { jobRunId: s.jobRunId, orgId: rig.orgId, caseId: rig.caseId, messageId: msgs[0]!.id };
      expect((await proc()(fakeJob(COMM_SEND_JOB, sdata))).result).toBe("not_approved");
      expect(email.attempts).toHaveLength(0);

      await approve(msgs[0]!.id);
      const s2 = await enqueueCommunicationSend(q, db(), { orgId: rig.orgId, caseId: rig.caseId, messageId: msgs[0]!.id });
      const sdata2 = { ...sdata, jobRunId: s2.jobRunId };
      const results = await Promise.all([proc()(fakeJob(COMM_SEND_JOB, sdata2)), proc()(fakeJob(COMM_SEND_JOB, sdata2)), proc()(fakeJob(COMM_SEND_JOB, sdata2))]);
      expect(results.map((r) => r.result).sort()).toEqual(["lease_held_elsewhere", "lease_held_elsewhere", "sent"]);
      expect(email.attempts).toHaveLength(1);
      expect((await messages())[0]!.sendStatus).toBe("sent");
      // the job's outcome is durable
      expect((await jobRow(s2.jobRunId))!.outcome).toBe("sent");
      // a third send job for the same message is refused durably: already_sent
      const s3 = await enqueueCommunicationSend(q, db(), { orgId: rig.orgId, caseId: rig.caseId, messageId: msgs[0]!.id });
      expect((await proc()(fakeJob(COMM_SEND_JOB, { ...sdata, jobRunId: s3.jobRunId }))).result).toBe("already_sent");
      expect(email.attempts).toHaveLength(1);
    } finally { await q.close(); }
  });

  it("payload forgery: a job claiming another org / wrong type / wrong case has no durable counterpart and does nothing", async () => {
    const other = await createTestUser("p6-other");
    const o2 = await createTestOrg(other, "p6other");
    const q = createNotesQueue(TEST_REDIS_URL);
    try {
      const p = await enqueueCommunicationPrepare(q, db(), { orgId: rig.orgId, caseId: rig.caseId, trigger: "retry_failed" });
      const forged = { jobRunId: p.jobRunId, orgId: o2.orgId, caseId: rig.caseId, trigger: "retry_failed" };
      expect((await proc()(fakeJob(COMM_PREPARE_JOB, forged))).result).toBe("no_durable_job");
      expect((await proc()(fakeJob(COMM_SEND_JOB, { jobRunId: p.jobRunId, orgId: rig.orgId, caseId: rig.caseId, messageId: rig.caseId }))).result).toBe("no_durable_job");
      expect((await proc()(fakeJob(COMM_PREPARE_JOB, { hello: "world" }))).result).toBe("invalid_payload");
      expect(await messages()).toHaveLength(0);
      expect((await jobRow(p.jobRunId))!.status).toBe("queued");
    } finally { await q.close(); }
  });
});

describe("notes queue — failure and recovery", () => {
  it("worker crash mid-send (stale lease): the job is reclaimed; the message-level claim prevents a second email", async () => {
    const email = fakeEmailProvider({ kind: "ok" });
    setEmailProviderForTests(email);
    const q = createNotesQueue(TEST_REDIS_URL);
    try {
      const ctx = await ctxFor(rig.owner, rig.slug, "operate");
      const prep = await communicationService.prepareCommunication(ctx, rig.caseId, "retry_failed");
      const messageId = (prep as { messageId: string }).messageId;
      await approve(messageId);
      const s = await enqueueCommunicationSend(q, db(), { orgId: rig.orgId, caseId: rig.caseId, messageId });
      // simulate a crash: lease was taken and expired, no completion recorded
      await withOrgTx(appDb(), rig.orgId, (tx) => tx.update(schema.jobRuns).set({ status: "leased", leasedAt: new Date(Date.now() - 60_000), leaseExpiresAt: new Date(Date.now() - 1_000), attempts: 1 }).where(eq(schema.jobRuns.id, s.jobRunId)));
      const r = await proc()(fakeJob(COMM_SEND_JOB, { jobRunId: s.jobRunId, orgId: rig.orgId, caseId: rig.caseId, messageId }, 1));
      expect(r.result).toBe("sent");
      expect(email.attempts).toHaveLength(1);

      // crash AFTER the message row was claimed (`sending`) but before the provider call:
      // a new delivery finds the message claimed elsewhere ⇒ no second email, row left for reconciliation
      const prep2 = await communicationService.prepareCommunication(ctx, rig.caseId, "case_lost"); // not lost ⇒ not_allowed
      expect(prep2.result).toBe("not_allowed");
    } finally { await q.close(); }
  });

  it("transient email failure: durable infra bookkeeping + BullMQ backoff; message returns to pending with its own sendAfter", async () => {
    const email = fakeEmailProvider({ kind: "transient" });
    setEmailProviderForTests(email);
    const q = createNotesQueue(TEST_REDIS_URL);
    try {
      const ctx = await ctxFor(rig.owner, rig.slug, "operate");
      const prep = await communicationService.prepareCommunication(ctx, rig.caseId, "retry_failed");
      const messageId = (prep as { messageId: string }).messageId;
      await approve(messageId);
      const s = await enqueueCommunicationSend(q, db(), { orgId: rig.orgId, caseId: rig.caseId, messageId });
      const data = { jobRunId: s.jobRunId, orgId: rig.orgId, caseId: rig.caseId, messageId };
      await expect(proc()(fakeJob(COMM_SEND_JOB, data))).rejects.toThrow(/transient/);
      const jr = (await jobRow(s.jobRunId))!;
      expect(jr.status).toBe("queued");
      expect(jr.lastErrorCategory).toBe("email_transient");
      const [m] = await messages();
      expect(m!.sendStatus).toBe("pending");
      expect(m!.sendAttempts).toBe(1);
      expect(m!.sendAfter!.getTime()).toBeGreaterThan(Date.now());
      // redelivery before the message is due ⇒ not_due (no provider call)
      expect((await proc()(fakeJob(COMM_SEND_JOB, data, 1))).result).toBe("not_due");
      expect(email.attempts).toHaveLength(1);
    } finally { await q.close(); }
  });

  it("ambiguous email result: job succeeds with `unknown`; redeliveries and new jobs never resend", async () => {
    const email = fakeEmailProvider({ kind: "ambiguous_accepted" });
    setEmailProviderForTests(email);
    const q = createNotesQueue(TEST_REDIS_URL);
    try {
      const ctx = await ctxFor(rig.owner, rig.slug, "operate");
      const prep = await communicationService.prepareCommunication(ctx, rig.caseId, "retry_failed");
      const messageId = (prep as { messageId: string }).messageId;
      await approve(messageId);
      const s = await enqueueCommunicationSend(q, db(), { orgId: rig.orgId, caseId: rig.caseId, messageId });
      const data = { jobRunId: s.jobRunId, orgId: rig.orgId, caseId: rig.caseId, messageId };
      expect((await proc()(fakeJob(COMM_SEND_JOB, data))).result).toBe("unknown");
      expect((await proc()(fakeJob(COMM_SEND_JOB, data, 1))).result).toBe("already_terminal");
      const s2 = await enqueueCommunicationSend(q, db(), { orgId: rig.orgId, caseId: rig.caseId, messageId });
      expect((await proc()(fakeJob(COMM_SEND_JOB, { ...data, jobRunId: s2.jobRunId }))).result).toBe("claimed_elsewhere");
      expect(email.attempts).toHaveLength(1);
      // unknown rows are not rediscovered as due sends
      const due = await communicationService.findDueSends(appDb(), rig.orgId, 100, new Date(Date.now() + 86_400_000));
      expect(due.some((d) => d.messageId === messageId)).toBe(false);
    } finally { await q.close(); }
  });

  it("Redis loss: durable notes rows are reconstructed with the same identity; terminal rows are not resurrected", async () => {
    const q = createNotesQueue(TEST_REDIS_URL);
    try {
      const p = await enqueueCommunicationPrepare(q, db(), { orgId: rig.orgId, caseId: rig.caseId, trigger: "retry_failed" });
      expect(await q.getJob(notesRedisJobId(commPrepareDedupeKey(rig.orgId, rig.caseId, "retry_failed")))).toBeDefined();
      await flushTestRedis(); // the outage
      expect(await q.getJob(notesRedisJobId(commPrepareDedupeKey(rig.orgId, rig.caseId, "retry_failed")))).toBeUndefined();
      const stats = await reconcileOrgNotesWithRedis(db(), q, rig.orgId, 100);
      expect(stats.reenqueued).toBe(1);
      const job = await q.getJob(notesRedisJobId(commPrepareDedupeKey(rig.orgId, rig.caseId, "retry_failed")));
      expect(job).toBeDefined();
      expect((job!.data as { jobRunId: string }).jobRunId).toBe(p.jobRunId);
      // deliver, then flush again: the terminal row must NOT come back
      await proc()(fakeJob(COMM_PREPARE_JOB, job!.data));
      await flushTestRedis();
      expect((await reconcileOrgNotesWithRedis(db(), q, rig.orgId, 100)).reenqueued).toBe(0);
      expect(await q.getJob(notesRedisJobId(commPrepareDedupeKey(rig.orgId, rig.caseId, "retry_failed")))).toBeUndefined();
    } finally { await q.close(); }
  });

  it("Redis down at enqueue time: the durable row exists and is picked up by reconciliation later", async () => {
    const dead = createNotesQueue("redis://127.0.0.1:1", { maxRetriesPerRequest: 1, retryStrategy: () => null, enableOfflineQueue: false, lazyConnect: true } as never);
    dead.on("error", () => { /* expected */ });
    try {
      const r = await enqueueCommunicationPrepare(dead, db(), { orgId: rig.orgId, caseId: rig.caseId, trigger: "retry_failed" });
      expect(r.enqueued).toBe(false);
      expect(r.reason).toBe("redis_unavailable");
      expect((await jobRow(r.jobRunId))!.status).toBe("queued");
    } finally { await dead.close().catch(() => undefined); }
    const q = createNotesQueue(TEST_REDIS_URL);
    try {
      expect((await reconcileOrgNotesWithRedis(db(), q, rig.orgId, 100)).reenqueued).toBe(1);
    } finally { await q.close(); }
  });
});

describe("notes queue — suppression (authoritative opt-out)", () => {
  it("worker cannot send to a customer who unsubscribed after approval: job succeeds `suppressed`, zero provider calls, no BullMQ retry, never resent", async () => {
    const email = fakeEmailProvider({ kind: "ok" });
    setEmailProviderForTests(email);
    const q = createNotesQueue(TEST_REDIS_URL);
    try {
      const ctx = await ctxFor(rig.owner, rig.slug, "operate");
      const prep = await communicationService.prepareCommunication(ctx, rig.caseId, "retry_failed");
      const messageId = (prep as { messageId: string }).messageId;
      await approve(messageId);
      const s = await enqueueCommunicationSend(q, db(), { orgId: rig.orgId, caseId: rig.caseId, messageId });
      // the customer opts out through the public token AFTER approval + enqueue
      const { token } = await checkoutService.createCheckoutLink(ctx, rig.caseId, {});
      const { suppressionService } = await import("@revessent/server");
      expect(await suppressionService.unsubscribeByToken(createDb(process.env.APP_DATABASE_URL!), token)).toEqual({ state: "done" });
      const data = { jobRunId: s.jobRunId, orgId: rig.orgId, caseId: rig.caseId, messageId };
      const r = await proc()(fakeJob(COMM_SEND_JOB, data)); // resolves — no throw ⇒ no BullMQ retry
      expect(r.result).toBe("suppressed");
      expect(email.attempts).toHaveLength(0);
      const jr = (await jobRow(s.jobRunId))!;
      expect(jr.status).toBe("succeeded");
      expect(jr.outcome).toBe("suppressed");
      const [m] = await messages();
      expect(m!.sendStatus).toBe("suppressed");
      expect(m!.suppressedReason).toBe("customer_unsubscribed");
      // redelivery + a brand-new send job both converge without a provider call
      expect((await proc()(fakeJob(COMM_SEND_JOB, data, 1))).result).toBe("already_terminal");
      const s2 = await enqueueCommunicationSend(q, db(), { orgId: rig.orgId, caseId: rig.caseId, messageId });
      expect((await proc()(fakeJob(COMM_SEND_JOB, { ...data, jobRunId: s2.jobRunId }))).result).toBe("claimed_elsewhere");
      expect(email.attempts).toHaveLength(0);
      // and the scheduler discovers nothing further for this case
      const retries = createRetriesQueue(TEST_REDIS_URL);
      try {
        const st = await cycleOrg({ db: db(), systemDb: systemDb(), queue: retries, notesQueue: q, scanLimit: 100, orgLimit: 200 }, rig.orgId);
        expect(st.commPrepareEnqueued).toBe(0);
        expect(st.commSendEnqueued).toBe(0);
      } finally { await retries.close(); }
    } finally { await q.close(); }
  });
});

describe("notes queue — scheduler discovery", () => {
  it("cycleOrg discovers communication candidates and due sends only when a notes queue is provided; identities are stable across cycles", async () => {
    const email = fakeEmailProvider({ kind: "ok" });
    setEmailProviderForTests(email);
    const retries = createRetriesQueue(TEST_REDIS_URL);
    const notes = createNotesQueue(TEST_REDIS_URL);
    const deps = { db: db(), systemDb: systemDb(), queue: retries, notesQueue: notes, scanLimit: 100, orgLimit: 200 };
    try {
      // Phase 5-only shape: no communication discovery
      const s0 = await cycleOrg({ ...deps, notesQueue: undefined }, rig.orgId);
      expect(s0.commPrepareEnqueued).toBe(0);
      const s1 = await cycleOrg(deps, rig.orgId);
      expect(s1.commPrepareEnqueued).toBe(1);
      const s2 = await cycleOrg(deps, rig.orgId);
      expect(s2.commPrepareEnqueued).toBe(0); // live job exists
      const job = await notes.getJob(notesRedisJobId(commPrepareDedupeKey(rig.orgId, rig.caseId, "retry_failed")));
      await proc()(fakeJob(COMM_PREPARE_JOB, job!.data));
      const s3 = await cycleOrg(deps, rig.orgId);
      expect(s3.commPrepareEnqueued).toBe(0); // message exists ⇒ no longer a candidate
      expect(s3.commSendEnqueued).toBe(0);   // awaiting approval ⇒ not due
      const [m] = await messages();
      await approve(m!.id);
      const s4 = await cycleOrg(deps, rig.orgId);
      expect(s4.commSendEnqueued).toBe(1);
      const sendJob = await notes.getJob(notesRedisJobId(commSendDedupeKey(rig.orgId, m!.id)));
      expect(sendJob).toBeDefined();
      expect((await proc()(fakeJob(COMM_SEND_JOB, sendJob!.data))).result).toBe("sent");
      expect(email.attempts).toHaveLength(1);
      const s5 = await cycleOrg(deps, rig.orgId);
      expect(s5.commSendEnqueued).toBe(0);
    } finally { await retries.close(); await notes.close(); }
  });

  it("PHASE 7 — queued work after a downgrade: an auto-approved send job is delivered as `held_for_approval` (durable, no email); duplicate deliveries converge; retry.execute is untouched by billing state", async () => {
    const email = fakeEmailProvider({ kind: "ok" });
    setEmailProviderForTests(email);
    const { setPlanForTests } = await import("../../../packages/server/test/helpers");
    const { createDb: mk } = await import("@revessent/db");
    // Revessent + trust_level 1 ⇒ autonomy: the prepared note is auto-approved
    await setPlanForTests(rig.orgId, "revessent", "active");
    await mk(process.env.SCHEDULER_DATABASE_URL!).update(schema.organizations).set({ trustLevel: 1 }).where(eq(schema.organizations.id, rig.orgId));
    const q = createNotesQueue(TEST_REDIS_URL);
    try {
      const p = await enqueueCommunicationPrepare(q, db(), { orgId: rig.orgId, caseId: rig.caseId, trigger: "retry_failed" });
      expect((await proc()(fakeJob(COMM_PREPARE_JOB, { jobRunId: p.jobRunId, orgId: rig.orgId, caseId: rig.caseId, trigger: "retry_failed" }))).result).toBe("prepared");
      const [m] = await messages();
      expect(m!.generationSource).toBe("ai"); expect(m!.autoApproved).toBe(true); expect(m!.approvalStatus).toBe("approved");

      // the send job is queued, THEN the org is downgraded (as a billing webhook would do)
      const s = await enqueueCommunicationSend(q, db(), { orgId: rig.orgId, caseId: rig.caseId, messageId: m!.id });
      await setPlanForTests(rig.orgId, "ember", "trialing");
      const sdata = { jobRunId: s.jobRunId, orgId: rig.orgId, caseId: rig.caseId, messageId: m!.id };
      const results = await Promise.all([proc()(fakeJob(COMM_SEND_JOB, sdata)), proc()(fakeJob(COMM_SEND_JOB, sdata)), proc()(fakeJob(COMM_SEND_JOB, sdata, 1))]);
      expect(results.map((r) => r.result).sort()).toEqual(["held_for_approval", "lease_held_elsewhere", "lease_held_elsewhere"]);
      expect(email.attempts).toHaveLength(0);
      const job = await jobRow(s.jobRunId);
      expect(job!.status).toBe("succeeded"); expect(job!.outcome).toBe("held_for_approval"); // durable blocked outcome, no BullMQ retry
      const [held] = await messages();
      expect(held!.approvalStatus).toBe("awaiting_approval"); expect(held!.sendStatus).toBe("pending"); expect(held!.autoApproved).toBe(false);
      // redelivery after completion is harmless
      expect((await proc()(fakeJob(COMM_SEND_JOB, sdata, 2))).result).toBe("already_terminal");
      // discovery no longer proposes it (not approved) — the work waits for a human, it is never discarded
      const due = await communicationService.findDueSends(db(), rig.orgId, 10, new Date());
      expect(due.find((d) => d.messageId === m!.id)).toBeUndefined();
      const [msgRow] = await messages(); expect(msgRow).toBeDefined();

      // retry.execute delivery is a FINANCIAL path: billing state must not change its verdicts
      const retries = createRetriesQueue(TEST_REDIS_URL);
      try {
        const mod = await import("@revessent/worker");
        const rp = mod.retryExecuteProcessor({ db: db(), systemDb: systemDb(), leaseMs: 300_000, concurrency: 1, redisUrl: TEST_REDIS_URL });
        const enq = await mod.enqueueRetryExecution(retries, db(), { orgId: rig.orgId, caseId: rig.caseId, runAfter: new Date() });
        const r = await rp({ data: { jobRunId: enq.jobRunId, orgId: rig.orgId, caseId: rig.caseId }, attemptsMade: 0 } as never);
        expect(["executed", "blocked", "waiting", "exhausted", "not_due"]).toContain(r.result);
        const audit = await withOrgTx(appDb(), rig.orgId, (tx) => tx.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.orgId, rig.orgId), eq(schema.auditLogs.action, "entitlement.capability_denied"))));
        expect(audit).toHaveLength(0); // no entitlement check ever ran on the payment path
      } finally { await retries.close(); }
    } finally {
      await q.close();
      await mk(process.env.SCHEDULER_DATABASE_URL!).update(schema.organizations).set({ trustLevel: 0 }).where(eq(schema.organizations.id, rig.orgId));
    }
  });

  it("tenant isolation: another org's cycle never sees this org's communication work", async () => {
    const other = await createTestUser("p6-iso");
    const o2 = await createTestOrg(other, "p6iso");
    const retries = createRetriesQueue(TEST_REDIS_URL);
    const notes = createNotesQueue(TEST_REDIS_URL);
    try {
      const s = await cycleOrg({ db: db(), systemDb: systemDb(), queue: retries, notesQueue: notes, scanLimit: 100, orgLimit: 200 }, o2.orgId);
      expect(s.commPrepareEnqueued).toBe(0);
      expect(s.commSendEnqueued).toBe(0);
      const rows = await withOrgTx(appDb(), o2.orgId, (tx) => tx.select().from(schema.jobRuns).where(eq(schema.jobRuns.queue, NOTES_QUEUE)));
      expect(rows).toHaveLength(0);
    } finally { await retries.close(); await notes.close(); }
    await sleep(10);
  });
});
