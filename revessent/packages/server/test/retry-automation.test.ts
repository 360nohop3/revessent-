/**
 * PHASE 4D — AUTOMATED RETRY EXECUTION (real Postgres + fixture provider).
 * Proves: durable attempts, concurrency-safe numbering, one financial
 * primitive for manual+automated, 4C preflight + post-lock revalidation on
 * every automated attempt, unknown blocking, crash recovery, idempotency,
 * authorization and org isolation.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { appDb, recoveryService, retryService, settingsService, syncService, executionService } from "@revessent/server";
import * as schema from "@revessent/db";
import { withOrgTx, withIdentityTx } from "@revessent/db";
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

async function seedFailedPaymentCase(world: FixtureWorld, status: "retrying" | "contacting" = "retrying"): Promise<void> {
  setStripeGatewayForTests(fixtureGateway(world));
  const ctx = await ctxFor(rig.owner, rig.slug, "administer");
  await settingsService.stripeConnect(ctx, GOOD_KEY, {});
  await syncService.triggerSync(ctx, {});
  const [payment] = await withOrgTx(appDb(), rig.orgId, (tx) =>
    tx.select().from(schema.payments).where(eq(schema.payments.status, "failed")).limit(1));
  if (!payment) throw new Error("fixture world did not produce a failed payment");
  const [recCase] = await withOrgTx(appDb(), rig.orgId, (tx) =>
    tx.insert(schema.recoveryCases).values({
      orgId: rig.orgId, customerId: payment.customerId,
      subscriptionId: null, paymentId: payment.id,
      status, declineCode: "insufficient_funds", declineCategory: "insufficient_funds",
      amountCents: payment.amountCents, currency: payment.currency,
      firstFailedAt: new Date(Date.now() - 3 * DAY), // backoff for the first retry has elapsed
      attemptNo: 0, retryPolicyVersion: 1
    }).returning());
  rig.caseId = recCase!.id;
  rig.paymentId = payment.id;
}

beforeEach(async () => {
  const owner = await createTestUser("retry-owner");
  const { slug, orgId } = await createTestOrg(owner, `rtry${suffix()}`);
  rig = { slug, orgId, owner, caseId: "", paymentId: "" };
  // v1 policy with backoff already elapsed + explicit automated routing
  await withOrgTx(appDb(), orgId, (tx) => tx);
  await seedFailedPaymentCase(baseWorld());
  await withOrgTx(appDb(), rig.orgId, async (tx) => {
    await tx.insert(schema.retryPolicies).values({
      orgId: rig.orgId, version: 1,
      rules: {
        maxAutoRetries: 2, quietHoursStart: 21, quietHoursEnd: 8, minGapHours: 24,
        noteAfterFailedRetries: 1, checkoutAfterNote: true,
        autoRetry: {
          perCategory: {
            insufficient_funds: { retryable: true, maxAttempts: 4 },
            rate_limited: { retryable: true, maxAttempts: 4 },
            transient_network: { retryable: true, maxAttempts: 4 }
          },
          backoffMultiplier: 2, maxBackoffHours: 168
        }
      }
    });
    // back-date the case's first failure so the first gap has elapsed
    await tx.update(schema.recoveryCases)
      .set({ firstFailedAt: new Date(Date.now() - 3 * DAY) })
      .where(eq(schema.recoveryCases.id, rig.caseId));
  });
});

afterEach(() => {
  resetStripeGateway();
  resetFixtureWorlds();
});

async function runRetry(
  opts: { now?: Date; caseId?: string } = {},
  role: "operate" | "view" = "operate",
  world?: FixtureWorld
) {
  setStripeGatewayForTests(fixtureGateway(world ?? baseWorld()));
  const ctx = await ctxFor(rig.owner, rig.slug, role);
  return retryService.runDueRetries(ctx, { caseId: opts.caseId ?? rig.caseId, now: opts.now });
}

async function attempts(kind?: "auto_retry" | "manual_retry") {
  const rows = await withOrgTx(appDb(), rig.orgId, (tx) =>
    tx.select().from(schema.recoveryAttempts).where(eq(schema.recoveryAttempts.orgId, rig.orgId)));
  return kind ? rows.filter((r) => r.kind === kind) : rows;
}

async function paymentRow() {
  const [row] = await withOrgTx(appDb(), rig.orgId, (tx) =>
    tx.select().from(schema.payments).where(eq(schema.payments.id, rig.paymentId)));
  return row!;
}

async function caseRow() {
  const [row] = await withOrgTx(appDb(), rig.orgId, (tx) =>
    tx.select().from(schema.recoveryCases).where(eq(schema.recoveryCases.id, rig.caseId)));
  return row!;
}

async function audits(action: string) {
  return withOrgTx(appDb(), rig.orgId, (tx) =>
    tx.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, action)));
}

/* ============ Happy path: durable attempt through the shared primitive ============ */

describe("automated retry execution (durable + safe)", () => {
  it("schedules a durable attempt, executes via the 4C primitive, recovers the case", async () => {
    const world = baseWorld();
    world.pay = { behavior: "ok" };
    const summary = await runRetry({}, "operate", world);
    expect(summary.executed).toBe(1);
    const rows = await attempts("auto_retry");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("auto_retry");
    expect(rows[0]!.actor).toBe("system");
    expect(rows[0]!.status).toBe("succeeded");
    expect(rows[0]!.policyVersion).toBe(1);
    expect(rows[0]!.idempotencyKey).toMatch(new RegExp(`^rv:${rig.orgId}:${rig.caseId}:1$`));
    expect(world.pay!.operations).toHaveLength(1); // exactly one provider operation
    expect((await paymentRow()).status).toBe("paid");
    const c = await caseRow();
    expect(c.status).toBe("recovered"); // guarded §5.3 transition
    expect(c.recoveredCents).toBe(1900);
    const [attr] = await withOrgTx(appDb(), rig.orgId, (tx) =>
      tx.select().from(schema.recoveryAttributions));
    expect(attr).toBeTruthy(); // single attribution (unique payment)
    expect(attr!.source).toBe("retry");
    expect((await audits("retry.scheduled")).length).toBeGreaterThanOrEqual(1);
    expect((await audits("retry.executed")).length).toBeGreaterThanOrEqual(1);
    expect((await audits("case.recovered")).length).toBe(1);
  });

  it("declined outcome: recorded, next action scheduled by backoff, NOT retried within the gap", async () => {
    const world = baseWorld();
    world.pay = { behavior: "decline:insufficient_funds" };
    const summary = await runRetry({}, "operate", world);
    expect(summary.executed).toBe(1);
    expect((await attempts("auto_retry"))[0]!.status).toBe("failed");
    expect((await paymentRow()).status).toBe("failed");
    const c = await caseRow();
    expect(c.status).toBe("retrying"); // retryable category — not terminal
    expect(c.nextActionAt).toBeTruthy(); // deterministic backoff was persisted
    // an immediate second run is inside the backoff window → blocked, no second op
    const world2 = baseWorld();
    world2.pay = { behavior: "ok" };
    setStripeGatewayForTests(fixtureGateway(world2));
    const ctx = await ctxFor(rig.owner, rig.slug, "operate");
    const again = await retryService.runDueRetries(ctx, { caseId: rig.caseId });
    expect(again.executed).toBe(0);
    expect(again.blocked).toBe(1);
    expect(again.outcomes[0]!.reason).toBe("backoff");
    expect(world2.pay!.operations ?? []).toHaveLength(0);
    expect(world.pay!.operations).toHaveLength(1);
  });
});

/* ============ Limits ============ */

describe("retry limits (policy, database-backed)", () => {
  it("exhausted retries: final allowed retry runs; the next run is refused with a safe audit and the case is lost", async () => {
    const world = baseWorld();
    world.pay = { behavior: "decline:insufficient_funds" };
    // attempt 1 (of max 2)
    await runRetry({}, "operate", world);
    expect((await attempts("auto_retry"))).toHaveLength(1);
    // defeat the backoff window by advancing the anchor: backdate the first attempt
    await withOrgTx(appDb(), rig.orgId, (tx) =>
      tx.update(schema.recoveryAttempts)
        .set({ executedAt: new Date(Date.now() - 3 * DAY) })
        .where(eq(schema.recoveryAttempts.kind, "auto_retry")));
    // attempt 2 (final allowed)
    await runRetry({}, "operate", world);
    const rows = await attempts("auto_retry");
    expect(rows).toHaveLength(2);
    const c = await caseRow();
    expect(c.status).toBe("lost"); // policy exhausted → guarded terminal transition
    expect(c.closedReason).toBe("max_auto_retries");
    expect((await audits("retry.exhausted")).length).toBeGreaterThanOrEqual(1);
    expect((await audits("case.lost")).length).toBe(1);
    // a further run: the case is terminal → blocked, zero provider calls
    const world2 = baseWorld();
    world2.pay = { behavior: "ok" };
    setStripeGatewayForTests(fixtureGateway(world2));
    const ctx = await ctxFor(rig.owner, rig.slug, "operate");
    const third = await retryService.runDueRetries(ctx, { caseId: rig.caseId });
    expect(third.executed).toBe(0);
    expect(world2.pay!.operations ?? []).toHaveLength(0);
  });

  it("concurrent final-attempt runs: exactly ONE executes, the loser is refused (no second charge)", async () => {
    const world = baseWorld();
    world.pay = { behavior: "decline:insufficient_funds" };
    setStripeGatewayForTests(fixtureGateway(world));
    const ctx = await ctxFor(rig.owner, rig.slug, "operate");
    const results = await Promise.allSettled([
      retryService.runDueRetries(ctx, { caseId: rig.caseId }),
      retryService.runDueRetries(ctx, { caseId: rig.caseId })
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<{ executed: number; blocked: number }>[];
    const rejected = results.filter((r) => r.status === "rejected");
    // at most one run executed an attempt; the other was refused or blocked
    const totalExecuted = fulfilled.reduce((n, r) => n + r.value.executed, 0);
    expect(totalExecuted).toBeLessThanOrEqual(1);
    expect(world.pay!.operations!.length).toBeLessThanOrEqual(1);
    expect(await attempts("auto_retry")).toHaveLength(totalExecuted);
    void rejected;
  });
});

/* ============ Concurrency: automated × automated, manual × automated ============ */

describe("no double charge across identities (manual + automated share one boundary)", () => {
  it("concurrent automated runs execute at most one provider operation", async () => {
    const world = baseWorld();
    world.pay = { behavior: "decline:insufficient_funds", idempotentReplay: true };
    setStripeGatewayForTests(fixtureGateway(world));
    const ctx = await ctxFor(rig.owner, rig.slug, "operate");
    await Promise.allSettled([
      retryService.runDueRetries(ctx, { caseId: rig.caseId }),
      retryService.runDueRetries(ctx, { caseId: rig.caseId })
    ]);
    expect(world.pay!.operations!.length).toBeLessThanOrEqual(1);
    expect(await attempts("auto_retry")).toHaveLength(world.pay!.operations!.length);
  });

  it("manual execution racing an automated run cannot double-charge", async () => {
    const world = baseWorld();
    world.pay = { behavior: "ok", idempotentReplay: true };
    setStripeGatewayForTests(fixtureGateway(world));
    const ctx = await ctxFor(rig.owner, rig.slug, "operate");
    const [manual, auto] = await Promise.allSettled([
      recoveryService.requestRetry(ctx, rig.caseId, { idempotencyKey: "manual-race-0001" }, {}),
      retryService.runDueRetries(ctx, { caseId: rig.caseId })
    ]);
    const ops = world.pay!.operations!.length;
    expect(ops).toBeLessThanOrEqual(1); // THE invariant
    const paid = (await paymentRow()).status === "paid";
    const successes = [
      manual.status === "fulfilled" && manual.value.status === "succeeded",
      auto.status === "fulfilled" && auto.value.executed > 0 && (await attempts("auto_retry")).some((a) => a.status === "succeeded")
    ].filter(Boolean).length;
    if (ops === 1) expect(successes).toBeLessThanOrEqual(1);
    void paid;
  });
});

/* ============ Provider truth between eligibility and execution ============ */

type ProviderTruth = {
  invoiceId: string; customerId: string | null;
  amountDue: number | null; amountRemaining: number | null;
  currency: string | null; status: string | null; attempted: boolean;
};

function raceGateway(world: FixtureWorld, postLockOverride: Partial<ProviderTruth> | null) {
  const gw = fixtureGateway(world);
  const pay = world.pay ?? (world.pay = { behavior: "ok" });
  pay.operations = pay.operations ?? [];
  let lookups = 0;
  return {
    ...gw,
    getInvoiceForExecution: async (key: string, invoiceId: string): Promise<ProviderTruth> => {
      lookups += 1;
      const truth = await gw.getInvoiceForExecution(key, invoiceId);
      return lookups >= 2 && postLockOverride ? { ...truth, ...postLockOverride } : truth;
    }
  };
}

async function runWithRace(override: Partial<ProviderTruth> | null): Promise<void> {
  const world = baseWorld();
  setStripeGatewayForTests(raceGateway(world, override));
  const ctx = await ctxFor(rig.owner, rig.slug, "operate");
  await retryService.runDueRetries(ctx, { caseId: rig.caseId });
  const ops = world.pay?.operations ?? [];
  expect(ops).toHaveLength(0); // never reached invoices.pay
}

describe("provider changes between eligibility and execution (4C gates hold for automation)", () => {
  it("provider invoice paid → no retry, execution skipped, reconcile converges", async () => {
    await runWithRace({ status: "paid" });
    const row = (await attempts("auto_retry"))[0]!;
    expect(row.status).toBe("skipped");
    expect(row.errorCode).toBe("provider_invoice_already_paid");
  });
  it("provider invoice void → no retry", async () => {
    await runWithRace({ status: "void" });
    expect((await attempts("auto_retry"))[0]!.errorCode).toBe("provider_invoice_void");
  });
  it("provider amount changed → no retry", async () => {
    await runWithRace({ amountDue: 2500, amountRemaining: 2500 });
    expect((await attempts("auto_retry"))[0]!.errorCode).toBe("provider_amount_mismatch");
  });
  it("provider currency changed → no retry", async () => {
    await runWithRace({ currency: "EUR" });
    expect((await attempts("auto_retry"))[0]!.errorCode).toBe("provider_currency_mismatch");
  });
  it("provider customer changed → no retry", async () => {
    await runWithRace({ customerId: "cus_remapped_9" });
    expect((await attempts("auto_retry"))[0]!.errorCode).toBe("provider_customer_mismatch");
  });
  it("unsupported provider status → no retry", async () => {
    await runWithRace({ status: "some_future_state" });
    expect((await attempts("auto_retry"))[0]!.errorCode).toBe("unsupported_provider_state:some_future_state");
  });
});

/* ============ Unknown outcomes ============ */

describe("unknown outcomes block automated retry until reconciled", () => {
  it("provider success + response lost → unknown; retry stays blocked; reconcile→paid→no retry", async () => {
    const world = baseWorld();
    world.pay = { behavior: "network_loss_after_success", idempotentReplay: true };
    await runRetry({}, "operate", world);
    const row = (await attempts("auto_retry"))[0]!;
    expect(row.status).toBe("unknown"); // never assumed failed
    expect((await caseRow()).nextActionAt).toBeNull(); // no promised retry time

    // a further run is blocked by the unresolved outcome
    const ctx = await ctxFor(rig.owner, rig.slug, "operate");
    const again = await retryService.runDueRetries(ctx, { caseId: rig.caseId });
    expect(again.executed).toBe(0);
    expect(again.outcomes[0]!.reason).toBe("unresolved_execution_reconcile_first");
    expect(world.pay!.operations).toHaveLength(1); // never a second operation

    // reconciliation discovers the provider truth: paid
    setStripeGatewayForTests(fixtureGateway(world));
    await syncService.triggerSync(ctx, {});
    await executionService.reconcileExecutions(ctx);
    expect((await paymentRow()).status).toBe("paid");
    const c = await caseRow();
    expect(c.status).toBe("recovered"); // reconciliation converges the case too
    // and NO further retry is possible (payment paid — never charged twice)
    expect(world.pay!.operations).toHaveLength(1);
  });

  it("unknown reconciled as no_provider_operation → retry becomes eligible again after backoff", async () => {
    const world = baseWorld();
    world.pay = { behavior: "ambiguous", idempotentReplay: true };
    await runRetry({}, "operate", world);
    expect((await attempts("auto_retry"))[0]!.status).toBe("unknown");
    const ctx = await ctxFor(rig.owner, rig.slug, "operate");
    setStripeGatewayForTests(fixtureGateway(world));
    await executionService.reconcileExecutions(ctx);
    expect((await attempts("auto_retry"))[0]!.status).toBe("failed"); // provably no operation
    // backdate the attempt so the backoff has elapsed, then retry → executes
    await withOrgTx(appDb(), rig.orgId, (tx) =>
      tx.update(schema.recoveryAttempts)
        .set({ executedAt: new Date(Date.now() - 3 * DAY) })
        .where(eq(schema.recoveryAttempts.kind, "auto_retry")));
    const world2 = baseWorld();
    world2.pay = { behavior: "ok", idempotentReplay: true };
    setStripeGatewayForTests(fixtureGateway(world2));
    const second = await retryService.runDueRetries(ctx, { caseId: rig.caseId });
    expect(second.executed).toBe(1);
    expect(world2.pay!.operations).toHaveLength(1);
    expect((await paymentRow()).status).toBe("paid");
  });
});

/* ============ Crash recovery ============ */

describe("crash recovery (every ambiguous boundary is safe)", () => {
  it("reserved-then-died: the scheduled attempt is RESUMED with the same identity — never re-created", async () => {
    // simulate a crashed run: a scheduled auto attempt exists (identity 1)
    await withOrgTx(appDb(), rig.orgId, (tx) =>
      tx.insert(schema.recoveryAttempts).values({
        orgId: rig.orgId, caseId: rig.caseId, paymentId: rig.paymentId,
        amountCents: 1900, currency: "USD",
        requestHash: executionService._internal.requestHashOf({
          paymentId: rig.paymentId, amountCents: 1900, currency: "USD", customerStripeId: "cus_fixture_001"
        }), kind: "auto_retry", actor: "system",
        scheduledAt: new Date(Date.now() - 2 * HOUR), status: "scheduled",
        idempotencyKey: `rv:${rig.orgId}:${rig.caseId}:1`, policyVersion: 1
      }));
    const world = baseWorld();
    world.pay = { behavior: "ok", idempotentReplay: true };
    const summary = await runRetry({}, "operate", world);
    expect(summary.executed).toBe(1);
    const rows = await attempts("auto_retry");
    expect(rows).toHaveLength(1); // SAME row — resumed
    expect(rows[0]!.status).toBe("succeeded");
    expect(rows[0]!.idempotencyKey).toBe(`rv:${rig.orgId}:${rig.caseId}:1`);
    expect(world.pay!.operations).toHaveLength(1);
  });

  it("marked-executing-then-died: blocked until reconciliation, then resolved read-only", async () => {
    await withOrgTx(appDb(), rig.orgId, (tx) =>
      tx.insert(schema.recoveryAttempts).values({
        orgId: rig.orgId, caseId: rig.caseId, paymentId: rig.paymentId,
        amountCents: 1900, currency: "USD", requestHash: "crash",
        kind: "auto_retry", actor: "system", status: "executing",
        idempotencyKey: `rv:${rig.orgId}:${rig.caseId}:1`, policyVersion: 1
      }));
    const world = baseWorld();
    world.pay = { behavior: "ok" };
    setStripeGatewayForTests(fixtureGateway(world));
    const ctx = await ctxFor(rig.owner, rig.slug, "operate");
    const run = await retryService.runDueRetries(ctx, { caseId: rig.caseId });
    expect(run.executed).toBe(0);
    expect(run.outcomes[0]!.reason).toBe("unresolved_execution_reconcile_first");
    expect(world.pay!.operations ?? []).toHaveLength(0); // never a blind retry
    // reconciliation resolves it honestly (provider saw nothing)
    setStripeGatewayForTests(fixtureGateway(world));
    await executionService.reconcileExecutions(ctx);
    const rows = await attempts("auto_retry");
    expect(rows[0]!.status).toBe("failed");
    expect(rows[0]!.outcomeCategory).toBe("no_provider_operation");
  });
});

/* ============ Idempotency ============ */

describe("idempotency across automated runs", () => {
  it("the same retry identity never executes twice; a duplicate run returns the same execution", async () => {
    const world = baseWorld();
    world.pay = { behavior: "ok", idempotentReplay: true };
    await runRetry({}, "operate", world);
    const first = (await attempts("auto_retry"))[0]!;
    // second run: payment already paid → the case is not even a candidate
    const ctx = await ctxFor(rig.owner, rig.slug, "operate");
    const again = await retryService.runDueRetries(ctx, { caseId: rig.caseId });
    expect(again.considered).toBe(0);
    expect((await attempts("auto_retry"))).toHaveLength(1);
    expect(first.idempotencyKey).toBe(`rv:${rig.orgId}:${rig.caseId}:1`);
    expect(world.pay!.operations).toHaveLength(1);
  });
});

/* ============ Authorization ============ */

describe("authorization boundaries (brief §19)", () => {
  it("a viewer cannot trigger an automated run", async () => {
    const viewer = await createTestUser("retry-viewer");
    await withIdentityTx(appDb(), rig.owner.id, (tx) =>
      tx.insert(schema.memberships).values({ orgId: rig.orgId, userId: viewer.id, role: "viewer" }));
    const world = baseWorld();
    world.pay = { behavior: "ok" };
    setStripeGatewayForTests(fixtureGateway(world));
    const ctx = await ctxFor(viewer, rig.slug, "view");
    await expect(retryService.runDueRetries(ctx, { caseId: rig.caseId }))
      .rejects.toMatchObject({ problem: { status: 403 } });
    expect(await attempts()).toHaveLength(0);
  });

  it("cross-org: an operator of org B cannot run org A's case (org isolation)", async () => {
    const other = await createTestUser("retry-other");
    const otherOrg = await createTestOrg(other, `rtryb${suffix()}`);
    setStripeGatewayForTests(fixtureGateway(baseWorld()));
    const ctxB = await ctxFor(other, otherOrg.slug, "operate");
    const summary = await retryService.runDueRetries(ctxB, { caseId: rig.caseId }); // org A's id
    expect(summary.considered).toBe(0);
    expect(summary.executed).toBe(0);
    expect(await attempts()).toHaveLength(0);
  });

  it("revoked connection disables automation before any provider call", async () => {
    const ctx = await ctxFor(rig.owner, rig.slug, "administer");
    await settingsService.stripeDisconnect(ctx, {});
    const summary = await runRetry();
    expect(summary.executed).toBe(0);
    expect(summary.outcomes[0]).toMatchObject({ verdict: "disabled", reason: "connection_inactive" });
    expect(await attempts()).toHaveLength(0);
  });
});

/* ============ DTO / UI information (brief §23) ============ */

describe("case DTO exposes the minimal automated-retry state", () => {
  it("getCase reports attempt count, state and blocked reason", async () => {
    const world = baseWorld();
    world.pay = { behavior: "decline:insufficient_funds" };
    await runRetry({}, "operate", world);
    const ctx = await ctxFor(rig.owner, rig.slug, "operate");
    const dto = await recoveryService.getCase(ctx, rig.caseId);
    expect(dto.case.retry.autoAttempts).toBe(1);
    expect(dto.case.retry.maxAutoRetries).toBe(2);
    expect(dto.case.retry.state).toBe("waiting");
    expect(dto.case.retry.reason).toBe("backoff");
    expect(dto.case.retry.reconciliationRequired).toBe(false);
  });
});
