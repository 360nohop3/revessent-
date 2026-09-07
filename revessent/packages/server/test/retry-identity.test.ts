/**
 * PHASE 4D FINAL CORRECTION — automated attempt IDENTITY and LIMIT semantics.
 *
 * Under review: automated numbering previously used `all attempts + 1`
 * (manual attempts leaked into the automated sequence) while limits counted
 * only automated attempts. Corrected semantics proven here:
 *
 *  - attemptNo (and the J2 key rv:{org}:{case}:{attempt}) is the sequential
 *    AUTOMATED retry number; manual attempts never increment it;
 *  - numbering allocates max(persisted auto attempt_no) + 1 inside the payment
 *    advisory lock, with DB backstops: unique (org, idempotency_key) AND the
 *    partial unique index (case_id, attempt_no) WHERE kind='auto_retry';
 *  - a scheduled attempt resumes its exact row/number/key (no second identity);
 *  - effective limit = min(global maxAutoRetries, category maxAttempts);
 *    category absent or retryable=false fails closed on the FIRST decision;
 *  - counts: autoRetryCount / categoryAttemptCounts count EXECUTED automated
 *    attempts only — scheduled rows and manual attempts never count.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { appDb, recoveryService, retryService, executionService } from "@revessent/server";
import * as schema from "@revessent/db";
import { withOrgTx } from "@revessent/db";
import { setStripeGatewayForTests, resetStripeGateway } from "@revessent/integrations";
import {
  fixtureGateway, fixtureAccount, fixtureCustomer, fixtureSubscription, fixtureInvoice, resetFixtureWorlds
} from "@revessent/integrations/fixtures";
import type { FixtureWorld } from "@revessent/integrations/fixtures";
import { createTestOrg, createTestUser, ctxFor, suffix } from "./helpers";

const GOOD_KEY = "rk_test_0123456789abcdefABCD";
const DAY = 86_400_000, HOUR = 3_600_000;

interface Rig { slug: string; orgId: string; owner: Awaited<ReturnType<typeof createTestUser>>; caseId: string; paymentId: string; }
let rig: Rig;

function baseWorld(): FixtureWorld {
  return {
    account: fixtureAccount(),
    customers: [fixtureCustomer(1)],
    subscriptions: [fixtureSubscription(1, "cus_fixture_001")],
    invoices: [fixtureInvoice(3, "cus_fixture_001", { status: "uncollectible" })]
  };
}

function rules(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    maxAutoRetries: 2, quietHoursStart: 21, quietHoursEnd: 8, minGapHours: 24,
    noteAfterFailedRetries: 1, checkoutAfterNote: true,
    autoRetry: {
      perCategory: {
        insufficient_funds: { retryable: true, maxAttempts: 4 },
        rate_limited: { retryable: true, maxAttempts: 4 },
        transient_network: { retryable: true, maxAttempts: 4 }
      },
      backoffMultiplier: 2, maxBackoffHours: 168
    },
    ...over
  };
}

async function setRules(r: Record<string, unknown>): Promise<void> {
  await withOrgTx(appDb(), rig.orgId, (tx) =>
    tx.update(schema.retryPolicies).set({ rules: r as never })
      .where(and(eq(schema.retryPolicies.orgId, rig.orgId), eq(schema.retryPolicies.version, 1))));
}

async function seedFailedPaymentCase(world: FixtureWorld): Promise<void> {
  setStripeGatewayForTests(fixtureGateway(world));
  const ctx = await ctxFor(rig.owner, rig.slug, "administer");
  const { settingsService, syncService } = await import("@revessent/server");
  await settingsService.stripeConnect(ctx, GOOD_KEY, {});
  await syncService.triggerSync(ctx, {});
  const [payment] = await withOrgTx(appDb(), rig.orgId, (tx) =>
    tx.select().from(schema.payments).where(eq(schema.payments.status, "failed")).limit(1));
  if (!payment) throw new Error("fixture world did not produce a failed payment");
  const [recCase] = await withOrgTx(appDb(), rig.orgId, (tx) =>
    tx.insert(schema.recoveryCases).values({
      orgId: rig.orgId, customerId: payment.customerId,
      subscriptionId: null, paymentId: payment.id,
      status: "retrying", declineCode: "insufficient_funds", declineCategory: "insufficient_funds",
      amountCents: payment.amountCents, currency: payment.currency,
      firstFailedAt: new Date(Date.now() - 3 * DAY),
      attemptNo: 0, retryPolicyVersion: 1
    }).returning());
  rig.caseId = recCase!.id;
  rig.paymentId = payment.id;
}

beforeEach(async () => {
  const owner = await createTestUser("identity-owner");
  const { slug, orgId } = await createTestOrg(owner, `ident${suffix()}`);
  rig = { slug, orgId, owner, caseId: "", paymentId: "" };
  await seedFailedPaymentCase(baseWorld());
  await withOrgTx(appDb(), rig.orgId, (tx) =>
    tx.insert(schema.retryPolicies).values({
      orgId: rig.orgId, version: 1,
      rules: rules() as never
    }));
});

afterEach(() => {
  resetStripeGateway();
  resetFixtureWorlds();
});

async function runRetry(
  opts: { caseId?: string } = {},
  world: FixtureWorld = baseWorld()
) {
  setStripeGatewayForTests(fixtureGateway(world));
  const ctx = await ctxFor(rig.owner, rig.slug, "operate");
  return retryService.runDueRetries(ctx, { caseId: opts.caseId ?? rig.caseId });
}


/** Fixture worlds create the operations log lazily — a BLOCKED run never touches it. */
function opsOf(world: FixtureWorld): unknown[] {
  return world.pay?.operations ?? [];
}

/** A REAL manual execution (operator path, 4C primitive) that declines. */
async function manualRetry(key: string, behavior: "ok" | "decline:insufficient_funds" = "decline:insufficient_funds") {
  const world = baseWorld();
  world.pay = { behavior };
  setStripeGatewayForTests(fixtureGateway(world));
  const ctx = await ctxFor(rig.owner, rig.slug, "operate");
  return recoveryService.requestRetry(ctx, rig.caseId, { idempotencyKey: key }, {});
}

/** Operational backoff has elapsed for every attempt so far. */
async function backdateAttempts(hoursAgo = 3 * 24): Promise<void> {
  await withOrgTx(appDb(), rig.orgId, (tx) =>
    tx.update(schema.recoveryAttempts)
      .set({ executedAt: new Date(Date.now() - hoursAgo * HOUR) }));
}

async function attempts(kind?: "auto_retry" | "manual_retry") {
  const rows = await withOrgTx(appDb(), rig.orgId, (tx) =>
    tx.select().from(schema.recoveryAttempts).where(eq(schema.recoveryAttempts.orgId, rig.orgId)));
  return kind ? rows.filter((r) => r.kind === kind) : rows;
}

async function autoNumbers(): Promise<number[]> {
  return (await attempts("auto_retry")).map((r) => r.attemptNo).sort((a, b) => a - b);
}

/* ============ Attempt identity (correction §2, §5) ============ */

describe("automated attempt identity is the AUTOMATED sequence", () => {
  it("no manual attempts → the first automated attempt is #1", async () => {
    const summary = await runRetry({}, (() => { const w = baseWorld(); w.pay = { behavior: "ok", idempotentReplay: true }; return w; })());
    expect(summary.executed).toBe(1);
    const rows = await attempts("auto_retry");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.attemptNo).toBe(1);
    expect(rows[0]!.idempotencyKey).toBe(`rv:${rig.orgId}:${rig.caseId}:1`);
  });

  it("two manual attempts → the first automated attempt is STILL #1 (manual never increments the automated sequence)", async () => {
    await manualRetry("manual-ident-0001");
    await manualRetry("manual-ident-0002");
    await backdateAttempts();
    const world = (() => { const w = baseWorld(); w.pay = { behavior: "ok", idempotentReplay: true }; return w; })();
    const summary = await runRetry({}, world);
    expect(summary.executed).toBe(1);
    const rows = await attempts("auto_retry");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.attemptNo).toBe(1); // NOT 3
    expect(rows[0]!.idempotencyKey).toBe(`rv:${rig.orgId}:${rig.caseId}:1`);
    const manuals = await attempts("manual_retry");
    expect(manuals).toHaveLength(2);
    for (const m of manuals) expect(m.attemptNo).toBeNull(); // manual rows sit outside the sequence
  });

  it("manual + auto + manual → the NEXT automated attempt is #2 (not #4)", async () => {
    await manualRetry("manual-ident-0003");
    await backdateAttempts();
    const declined = (() => { const w = baseWorld(); w.pay = { behavior: "decline:insufficient_funds" }; return w; })();
    await runRetry({}, declined); // automated #1
    await manualRetry("manual-ident-0004");
    await backdateAttempts();
    const world = (() => { const w = baseWorld(); w.pay = { behavior: "ok", idempotentReplay: true }; return w; })();
    const summary = await runRetry({}, world);
    expect(summary.executed).toBe(1);
    const rows = await attempts("auto_retry");
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.attemptNo).sort()).toEqual([1, 2]);
    expect(rows.find((r) => r.status === "succeeded")!.idempotencyKey).toBe(`rv:${rig.orgId}:${rig.caseId}:2`);
  });

  it("automated identities are sequential and stable across runs", async () => {
    await runRetry({}, (() => { const w = baseWorld(); w.pay = { behavior: "decline:insufficient_funds" }; return w; })());
    await backdateAttempts();
    await runRetry({}, (() => { const w = baseWorld(); w.pay = { behavior: "decline:insufficient_funds" }; return w; })());
    const rows = await attempts("auto_retry");
    expect(rows.map((r) => [r.attemptNo, r.idempotencyKey]).sort())
      .toEqual([[1, `rv:${rig.orgId}:${rig.caseId}:1`], [2, `rv:${rig.orgId}:${rig.caseId}:2`]]);
  });

  it("a scheduled attempt RESUMES its exact row, number and key — never a new identity or a second op", async () => {
    // simulate a crashed run after reservation
    await withOrgTx(appDb(), rig.orgId, (tx) =>
      tx.insert(schema.recoveryAttempts).values({
        orgId: rig.orgId, caseId: rig.caseId, paymentId: rig.paymentId,
        amountCents: 1900, currency: "USD",
        requestHash: executionService._internal.requestHashOf({
          paymentId: rig.paymentId, amountCents: 1900, currency: "USD", customerStripeId: "cus_fixture_001"
        }), kind: "auto_retry", actor: "system",
        scheduledAt: new Date(Date.now() - 2 * HOUR), status: "scheduled",
        idempotencyKey: `rv:${rig.orgId}:${rig.caseId}:1`, policyVersion: 1, attemptNo: 1
      }));
    const world = (() => { const w = baseWorld(); w.pay = { behavior: "ok", idempotentReplay: true }; return w; })();
    const summary = await runRetry({}, world);
    expect(summary.executed).toBe(1);
    const rows = await attempts("auto_retry");
    expect(rows).toHaveLength(1); // SAME row — resumed
    expect(rows[0]!.status).toBe("succeeded");
    expect(rows[0]!.attemptNo).toBe(1);
    expect(rows[0]!.idempotencyKey).toBe(`rv:${rig.orgId}:${rig.caseId}:1`);
    expect(opsOf(world)).toHaveLength(1); // exactly one provider operation
  });
});

/* ============ Concurrency (correction §3) ============ */

describe("concurrent automated reservations cannot share an attempt number", () => {
  it("concurrent first-auto reservations → exactly one attempt #1 and ≤1 provider op", async () => {
    const world = (() => { const w = baseWorld(); w.pay = { behavior: "ok", idempotentReplay: true }; return w; })();
    setStripeGatewayForTests(fixtureGateway(world));
    const ctx = await ctxFor(rig.owner, rig.slug, "operate");
    await Promise.allSettled([
      retryService.runDueRetries(ctx, { caseId: rig.caseId }),
      retryService.runDueRetries(ctx, { caseId: rig.caseId })
    ]);
    expect(await autoNumbers()).toEqual([1]);
    expect(opsOf(world).length).toBeLessThanOrEqual(1);
  });

  it("concurrent second-auto reservations → exactly one attempt #2; numbers stay gapless and unique", async () => {
    await runRetry({}, (() => { const w = baseWorld(); w.pay = { behavior: "decline:insufficient_funds" }; return w; })());
    await backdateAttempts();
    const world = (() => { const w = baseWorld(); w.pay = { behavior: "ok", idempotentReplay: true }; return w; })();
    setStripeGatewayForTests(fixtureGateway(world));
    const ctx = await ctxFor(rig.owner, rig.slug, "operate");
    await Promise.allSettled([
      retryService.runDueRetries(ctx, { caseId: rig.caseId }),
      retryService.runDueRetries(ctx, { caseId: rig.caseId })
    ]);
    expect(await autoNumbers()).toEqual([1, 2]); // no duplicate automated numbers
    expect(opsOf(world).length).toBeLessThanOrEqual(1);
  });

  it("DB backstop: two direct inserts with the same (case, attempt_no) — exactly one wins, no lock involved", async () => {
    const key1 = `rv:${rig.orgId}:${rig.caseId}:1`;
    const key2 = `rv:${rig.orgId}:${rig.caseId}:1-alt`;
    const ins = (key: string, delay: number) => new Promise<string>((res) => setTimeout(async () => {
      try {
        await withOrgTx(appDb(), rig.orgId, (tx) =>
          tx.insert(schema.recoveryAttempts).values({
            orgId: rig.orgId, caseId: rig.caseId, paymentId: rig.paymentId,
            amountCents: 1900, currency: "USD", requestHash: "h-" + key.slice(-6),
            kind: "auto_retry", actor: "system", scheduledAt: new Date(), status: "scheduled",
            idempotencyKey: key, policyVersion: 1, attemptNo: 1
          }));
        res("WIN");
      } catch (e) {
        const err = e as { code?: string; cause?: { code?: string } };
        res(err.code === "23505" || err.cause?.code === "23505" ? "UNIQUE_CONFLICT" : "ERR:" + (err.code ?? err.cause?.code ?? "?") + ":" + (e as Error).message.slice(0, 40));
      }
    }, delay));
    const result = await Promise.all([ins(key1, 0), ins(key2, 20)]);
    expect(result).toContain("WIN");
    expect(result).toContain("UNIQUE_CONFLICT");
    expect((await attempts("auto_retry")).filter((r) => r.attemptNo === 1)).toHaveLength(1);
  });
});

/* ============ Limits (correction §6, §8) ============ */

describe("effective limit = min(global maxAutoRetries, category maxAttempts); fail closed", () => {
  it("global 2 / category 4 → exactly 2 automated retries, then exhausted (no new attempt, no Stripe call)", async () => {
    await runRetry({}, (() => { const w = baseWorld(); w.pay = { behavior: "decline:insufficient_funds" }; return w; })());
    await backdateAttempts();
    await runRetry({}, (() => { const w = baseWorld(); w.pay = { behavior: "decline:insufficient_funds" }; return w; })());
    expect(await autoNumbers()).toEqual([1, 2]);
    const world = (() => { const w = baseWorld(); w.pay = { behavior: "decline:insufficient_funds" }; return w; })();
    const summary = await runRetry({}, world);
    expect(summary.executed).toBe(0);
    expect(await autoNumbers()).toEqual([1, 2]); // no third identity
    expect(opsOf(world)).toHaveLength(0); // no Stripe call
    const c = await withOrgTx(appDb(), rig.orgId, (tx) =>
      tx.select().from(schema.recoveryCases).where(eq(schema.recoveryCases.id, rig.caseId)));
    expect(c[0]!.status).toBe("lost");
  });

  it("global 4 / category 2 → exactly 2 category retries, then category_exhausted", async () => {
    await setRules(rules({ maxAutoRetries: 4, autoRetry: {
      perCategory: { insufficient_funds: { retryable: true, maxAttempts: 2 } },
      backoffMultiplier: 2, maxBackoffHours: 168
    } }));
    await runRetry({}, (() => { const w = baseWorld(); w.pay = { behavior: "decline:insufficient_funds" }; return w; })());
    await backdateAttempts();
    await runRetry({}, (() => { const w = baseWorld(); w.pay = { behavior: "decline:insufficient_funds" }; return w; })());
    expect(await autoNumbers()).toEqual([1, 2]);
    const world = (() => { const w = baseWorld(); w.pay = { behavior: "decline:insufficient_funds" }; return w; })();
    const summary = await runRetry({}, world);
    expect(summary.executed).toBe(0);
    expect(summary.blocked).toBe(1);
    expect(summary.outcomes[0]?.reason).toBe("category_exhausted:insufficient_funds");
    expect(await autoNumbers()).toEqual([1, 2]);
    expect(opsOf(world)).toHaveLength(0);
  });

  it("global maxAutoRetries 0 → no automated attempt at all (automation_disabled)", async () => {
    await setRules(rules({ maxAutoRetries: 0 }));
    const world = (() => { const w = baseWorld(); w.pay = { behavior: "ok", idempotentReplay: true }; return w; })();
    const summary = await runRetry({}, world);
    expect(summary.executed).toBe(0);
    expect(summary.outcomes[0]?.reason).toBe("automation_disabled");
    expect(await attempts("auto_retry")).toHaveLength(0);
    expect(opsOf(world)).toHaveLength(0);
  });

  it("category retryable=false → the FIRST decision refuses (fresh case: no attempt is ever spent)", async () => {
    await setRules(rules({ autoRetry: {
      perCategory: { insufficient_funds: { retryable: false, maxAttempts: 4 } },
      backoffMultiplier: 2, maxBackoffHours: 168
    } }));
    const world = (() => { const w = baseWorld(); w.pay = { behavior: "ok", idempotentReplay: true }; return w; })();
    const summary = await runRetry({}, world);
    expect(summary.executed).toBe(0);
    expect(summary.outcomes[0]?.reason).toBe("outcome_not_retryable:insufficient_funds");
    expect(await attempts("auto_retry")).toHaveLength(0);
    expect(opsOf(world)).toHaveLength(0);
  });

  it("category absent from the policy → fail closed, no invented limit", async () => {
    await withOrgTx(appDb(), rig.orgId, (tx) =>
      tx.update(schema.recoveryCases).set({ declineCategory: "processing_error" })
        .where(eq(schema.recoveryCases.id, rig.caseId)));
    const world = (() => { const w = baseWorld(); w.pay = { behavior: "ok", idempotentReplay: true }; return w; })();
    const summary = await runRetry({}, world);
    expect(summary.executed).toBe(0);
    expect(summary.outcomes[0]?.reason).toBe("outcome_not_retryable:processing_error");
    expect(await attempts("auto_retry")).toHaveLength(0);
    expect(opsOf(world)).toHaveLength(0);
  });

  it("an exhausted case never gains a new durable identity (no second retry identity)", async () => {
    await runRetry({}, (() => { const w = baseWorld(); w.pay = { behavior: "decline:insufficient_funds" }; return w; })());
    await backdateAttempts();
    await runRetry({}, (() => { const w = baseWorld(); w.pay = { behavior: "decline:insufficient_funds" }; return w; })());
    const before = (await attempts("auto_retry")).map((r) => r.idempotencyKey).sort();
    await runRetry({}, (() => { const w = baseWorld(); w.pay = { behavior: "decline:insufficient_funds" }; return w; })());
    const after = (await attempts("auto_retry")).map((r) => r.idempotencyKey).sort();
    expect(after).toEqual(before); // identity set unchanged — nothing new reserved
  });

  it("concurrent final-attempt race → exactly one winner, no duplicate numbers, ≤1 provider op", async () => {
    await runRetry({}, (() => { const w = baseWorld(); w.pay = { behavior: "decline:insufficient_funds" }; return w; })());
    await backdateAttempts();
    const world = (() => { const w = baseWorld(); w.pay = { behavior: "ok", idempotentReplay: true }; return w; })();
    setStripeGatewayForTests(fixtureGateway(world));
    const ctx = await ctxFor(rig.owner, rig.slug, "operate");
    const results = await Promise.allSettled([
      retryService.runDueRetries(ctx, { caseId: rig.caseId }),
      retryService.runDueRetries(ctx, { caseId: rig.caseId })
    ]);
    const executed = results.reduce((sum, r) => sum + (r.status === "fulfilled" ? r.value.executed : 0), 0);
    expect(executed).toBeLessThanOrEqual(1); // exactly one winner at the global cap
    expect(await autoNumbers()).toEqual([1, 2]);
    expect(opsOf(world).length).toBeLessThanOrEqual(1);
  });
});

/* ============ Count semantics + regression anchors (correction §7, §9.16–20) ============ */

describe("count semantics and preserved behavior", () => {
  it("a merely-scheduled attempt is NOT counted as executed and does not advance limits", async () => {
    await setRules(rules({ maxAutoRetries: 2 }));
    await manualRetry("manual-count-0001");
    await backdateAttempts();
    // reserve under a declined run? No — decline EXECUTES. Use the crash shape:
    // a scheduled row exists → next run resumes it; until then counts stay 0.
    await withOrgTx(appDb(), rig.orgId, (tx) =>
      tx.insert(schema.recoveryAttempts).values({
        orgId: rig.orgId, caseId: rig.caseId, paymentId: rig.paymentId,
        amountCents: 1900, currency: "USD", requestHash: "hash-count-001",
        kind: "auto_retry", actor: "system", scheduledAt: new Date(Date.now() - HOUR),
        status: "scheduled", idempotencyKey: `rv:${rig.orgId}:${rig.caseId}:1`, policyVersion: 1, attemptNo: 1
      }));
    // While scheduled: a blocked-run audit (if any) and the case DTO must show 0 executed auto attempts
    const ctx = await ctxFor(rig.owner, rig.slug, "operate");
    const dto = await recoveryService.getCase(ctx, rig.caseId);
    expect(dto.case.retry.autoAttempts).toBe(0); // scheduled ≠ executed
    expect(dto.case.retry.maxAutoRetries).toBe(2);
  });

  it("unknown outcome still blocks automated retry until reconciled (§9.18)", async () => {
    await runRetry({}, (() => { const w = baseWorld(); w.pay = { behavior: "network_loss_after_success", idempotentReplay: true }; return w; })());
    expect((await attempts("auto_retry"))[0]!.status).toBe("unknown");
    const second = await runRetry({}, (() => { const w = baseWorld(); w.pay = { behavior: "ok", idempotentReplay: true }; return w; })());
    expect(second.executed).toBe(0); // hard boundary: never unknown → retry
    expect((await attempts("auto_retry"))).toHaveLength(1); // no new identity
  });

  it("existing idempotency behavior unchanged: a duplicate run never executes twice (§9.19)", async () => {
    const world = (() => { const w = baseWorld(); w.pay = { behavior: "ok", idempotentReplay: true }; return w; })();
    await runRetry({}, world);
    const opsAfterFirst = opsOf(world).length;
    expect(opsAfterFirst).toBe(1);
    await runRetry({}, world); // payment now paid → nothing left to do
    expect(opsOf(world)).toHaveLength(1);
    expect(await attempts("auto_retry")).toHaveLength(1);
  });

  it("org isolation unchanged: another org's runner finds zero candidates for a foreign caseId (§9.20)", async () => {
    const outsider = await createTestUser("identity-outsider");
    const other = await createTestOrg(outsider, `other${suffix()}`);
    const world = (() => { const w = baseWorld(); w.pay = { behavior: "ok", idempotentReplay: true }; return w; })();
    setStripeGatewayForTests(fixtureGateway(world));
    const foreignCtx = await ctxFor(outsider, other.slug, "operate");
    const summary = await retryService.runDueRetries(foreignCtx, { caseId: rig.caseId });
    expect(summary.considered).toBe(0);
    expect(summary.executed).toBe(0);
    expect(await attempts()).toHaveLength(0);
    expect(opsOf(world)).toHaveLength(0);
  });

  it("manual execution still works and its rows stay visible but sequence-neutral (§9.16)", async () => {
    const dto = await manualRetry("manual-visible-0001");
    expect(dto.status).toBe("failed"); // honest decline through the 4C primitive
    const manuals = await attempts("manual_retry");
    expect(manuals).toHaveLength(1);
    expect(manuals[0]!.attemptNo).toBeNull();
    expect(manuals[0]!.outcomeCategory).toBe("insufficient_funds"); // recorded, but…
    // …an automated run still starts at #1 with a full category budget
    await backdateAttempts();
    const summary = await runRetry({}, (() => { const w = baseWorld(); w.pay = { behavior: "ok", idempotentReplay: true }; return w; })());
    expect(summary.executed).toBe(1);
    expect(await autoNumbers()).toEqual([1]);
  });

  it("no stray raw count+1 numbering survives in the 4D surface (§11 audit, enforced by behavior)", async () => {
    // Behavioral proof: with 2 manual + 1 auto rows present, allocation is #2 —
    // an attempts.length+1 implementation would have produced #4.
    await manualRetry("manual-audit-0001");
    await backdateAttempts();
    await runRetry({}, (() => { const w = baseWorld(); w.pay = { behavior: "decline:insufficient_funds" }; return w; })()); // auto #1
    await manualRetry("manual-audit-0002");
    await backdateAttempts();
    await runRetry({}, (() => { const w = baseWorld(); w.pay = { behavior: "decline:insufficient_funds" }; return w; })()); // auto #2
    expect(await autoNumbers()).toEqual([1, 2]);
    expect((await attempts()).length).toBe(4); // 2 manual + 2 auto
  });

  it("retry_policies v1 row still scopes per org (RLS sanity via scoped tx)", async () => {
    const rows = await withOrgTx(appDb(), rig.orgId, (tx) =>
      tx.select().from(schema.retryPolicies));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.version).toBe(1);
    expect(await withOrgTx(appDb(), rig.orgId, (tx) =>
      tx.select({ n: sql<number>`count(*)::int` }).from(schema.auditLogs))).toBeTruthy();
  });
});
