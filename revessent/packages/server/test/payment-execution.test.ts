/**
 * PHASE 4C — PAYMENT EXECUTION PRIMITIVE.
 *
 * Real Postgres + deterministic fixture provider. Proves the mission's
 * invariants: explicit authorization only, organization isolation, explicit
 * immutable financial parameters, database-backed idempotency, provider
 * idempotency, no double-charge under concurrency, declines ≠ system
 * failures, unknown outcomes recoverable, webhooks stay authoritative,
 * no secrets anywhere.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { appDb, settingsService, syncService, recoveryService, executionService } from "@revessent/server";
import * as schema from "@revessent/db";
import { withOrgTx, withIdentityTx } from "@revessent/db";
import { setStripeGatewayForTests, resetStripeGateway, ProviderError } from "@revessent/integrations";
import {
  fixtureGateway, fixtureAccount, fixtureCustomer, fixtureSubscription, fixtureInvoice, resetFixtureWorlds
} from "@revessent/integrations/fixtures";
import type { FixtureWorld } from "@revessent/integrations/fixtures";
import { createTestOrg, createTestUser, ctxFor, suffix } from "./helpers";

const GOOD_KEY = "rk_test_0123456789abcdefABCD";

interface Rig { slug: string; orgId: string; owner: Awaited<ReturnType<typeof createTestUser>>; caseId: string; paymentId: string; stripeInvoiceId: string; }

let rig: Rig;

function baseWorld(): FixtureWorld {
  return {
    account: fixtureAccount(),
    customers: [fixtureCustomer(1)],
    subscriptions: [fixtureSubscription(1, "cus_fixture_001")],
    // fixtureInvoice(3) would default to "paid" (i % 3 === 0) — force the
    // uncollectible mapping that 4A sync turns into a local 'failed' payment.
    invoices: [fixtureInvoice(3, "cus_fixture_001", { status: "uncollectible" })]
  };
}

async function seedFailedPaymentCase(world: FixtureWorld): Promise<{ caseId: string; paymentId: string; stripeInvoiceId: string }> {
  setStripeGatewayForTests(fixtureGateway(world));
  const ctx = await ctxFor(rig.owner, rig.slug, "administer");
  await settingsService.stripeConnect(ctx, GOOD_KEY, {});
  await syncService.triggerSync(ctx, {});
  const [payment] = await withOrgTx(appDb(), rig.orgId, (tx) =>
    tx.select().from(schema.payments)
      .where(eq(schema.payments.status, "failed")).limit(1));
  if (!payment) throw new Error("fixture world did not produce a failed payment");
  const [recCase] = await withOrgTx(appDb(), rig.orgId, (tx) =>
    tx.insert(schema.recoveryCases).values({
      orgId: rig.orgId, customerId: payment.customerId,
      subscriptionId: null, paymentId: payment.id,
      status: "retrying", declineCode: "insufficient_funds", declineCategory: "insufficient_funds",
      amountCents: payment.amountCents, currency: payment.currency,
      firstFailedAt: new Date(), attemptNo: 1
    }).returning());
  return { caseId: recCase!.id, paymentId: payment.id, stripeInvoiceId: payment.stripeInvoiceId! };
}

beforeEach(async () => {
  const owner = await createTestUser("payowner");
  const { slug, orgId } = await createTestOrg(owner, `pay${suffix()}`);
  rig = { slug, orgId, owner, caseId: "", paymentId: "", stripeInvoiceId: "" };
  const seeded = await seedFailedPaymentCase(baseWorld());
  rig.caseId = seeded.caseId;
  rig.paymentId = seeded.paymentId;
  rig.stripeInvoiceId = seeded.stripeInvoiceId;
});

afterEach(() => {
  resetStripeGateway();
  resetFixtureWorlds();
});

async function execute(input: { idempotencyKey?: string } = {}, world: FixtureWorld = baseWorld()) {
  setStripeGatewayForTests(fixtureGateway(world));
  const ctx = await ctxFor(rig.owner, rig.slug, "operate");
  return recoveryService.requestRetry(ctx, rig.caseId, input, {});
}

async function attempts() {
  return withOrgTx(appDb(), rig.orgId, (tx) =>
    tx.select().from(schema.recoveryAttempts).where(eq(schema.recoveryAttempts.orgId, rig.orgId)));
}

async function paymentRow() {
  const [row] = await withOrgTx(appDb(), rig.orgId, (tx) =>
    tx.select().from(schema.payments).where(eq(schema.payments.id, rig.paymentId)));
  return row!;
}

/* ============ Authorization & isolation ============ */

describe("authorization + organization isolation", () => {
  it("viewer role is refused before anything executes (explicit operate gate)", async () => {
    const viewer = await createTestUser("payviewer");
    // the OWNER adds the viewer (0007 guard: writes need an owner/admin caller)
    await withIdentityTx(appDb(), rig.owner.id, (tx) =>
      tx.insert(schema.memberships).values({ orgId: rig.orgId, userId: viewer.id, role: "viewer" }));
    const ctx = await ctxFor(viewer, rig.slug, "view");
    await expect(recoveryService.requestRetry(ctx, rig.caseId, {}, {}))
      .rejects.toMatchObject({ problem: { status: 403 } });
    expect(await attempts()).toHaveLength(0);
  });

  it("cross-organization case id is invisible — org B cannot execute org A's payment", async () => {
    const other = await createTestUser("payother");
    const otherOrg = await createTestOrg(other, `payb${suffix()}`);
    // org B is a fully legitimate operator in its own org, with its own live connection
    setStripeGatewayForTests(fixtureGateway(baseWorld()));
    const ctxB = await ctxFor(other, otherOrg.slug, "operate");
    await settingsService.stripeConnect(ctxB, GOOD_KEY, {});

    // org B executing org A's case id → not-found (org-scoped), NOTHING executes
    await expect(recoveryService.requestRetry(ctxB, rig.caseId, {}, {}))
      .rejects.toMatchObject({ problem: { status: 404 } });

    const rowsB = await withOrgTx(appDb(), otherOrg.orgId, (tx) =>
      tx.select().from(schema.recoveryAttempts).where(eq(schema.recoveryAttempts.orgId, otherOrg.orgId)));
    expect(rowsB).toHaveLength(0);
    expect(await attempts()).toHaveLength(0); // org A untouched
  });

  it("revoked connection: execution refused before any provider call", async () => {
    const ctx = await ctxFor(rig.owner, rig.slug, "administer");
    await settingsService.stripeDisconnect(ctx, {});
    await expect(execute()).rejects.toMatchObject({ problem: { status: 409 } });
    expect(await attempts()).toHaveLength(0);
  });
});

/* ============ Financial validation ============ */

describe("financial truth validation", () => {
  it("zero amount on the local record refuses execution (never amount ?? 0)", async () => {
    await withOrgTx(appDb(), rig.orgId, (tx) =>
      tx.update(schema.payments).set({ amountCents: 0 }).where(eq(schema.payments.id, rig.paymentId)));
    await expect(execute()).rejects.toMatchObject({ problem: { status: 400 } });
    expect(await attempts()).toHaveLength(0);
  });

  it("unknown currency refuses execution (never defaulted)", async () => {
    await withOrgTx(appDb(), rig.orgId, (tx) =>
      tx.update(schema.payments).set({ currency: "" }).where(eq(schema.payments.id, rig.paymentId)));
    await expect(execute()).rejects.toMatchObject({ problem: { status: 400 } });
    expect(await attempts()).toHaveLength(0);
  });

  it("non-failed payment state refuses execution (unsupported provider state — no guessing)", async () => {
    await withOrgTx(appDb(), rig.orgId, (tx) =>
      tx.update(schema.payments).set({ status: "paid" }).where(eq(schema.payments.id, rig.paymentId)));
    await expect(execute()).rejects.toMatchObject({ problem: { status: 400 } });
    expect(await attempts()).toHaveLength(0);
  });
});

/* ============ Idempotency ============ */

describe("idempotency (database + provider)", () => {
  it("first execution succeeds: provider paid once, local payment updated, execution recorded", async () => {
    const res = await execute();
    expect(res.status).toBe("succeeded");
    expect(res.outcomeCategory).toBe("succeeded");
    expect(res.amountCents).toBe(1900); // from the LOCAL payment record
    expect(res.currency).toBe("USD");
    const rows = await attempts();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("manual_retry"); // durable execution record
    expect(rows[0]!.idempotencyKey).toMatch(new RegExp(`^rv:${rig.orgId}:`));
    expect((await paymentRow()).status).toBe("paid");
    const [attempt] = await withOrgTx(appDb(), rig.orgId, (tx) =>
      tx.select().from(schema.paymentAttempts));
    expect(attempt).toBeTruthy();
    expect(attempt!.source).toBe("revessent_retry"); // attempt history notes the operator origin
  });

  it("exact duplicate (same key): SAME execution returned, provider called once", async () => {
    const world = baseWorld();
    world.pay = { behavior: "ok", idempotentReplay: true };
    const a = await execute({ idempotencyKey: "idem-key-0001" }, world);
    const b = await execute({ idempotencyKey: "idem-key-0001" }, world);
    expect(b.executionId).toBe(a.executionId);
    expect(await attempts()).toHaveLength(1);
    expect(world.pay!.operations).toHaveLength(1);
  });

  it("concurrent duplicates: ONE provider operation (DB unique + payment advisory lock)", async () => {
    const world = baseWorld();
    world.pay = { behavior: "ok", idempotentReplay: true };
    setStripeGatewayForTests(fixtureGateway(world));
    const ctx = await ctxFor(rig.owner, rig.slug, "operate");
    const [x, y] = await Promise.all([
      recoveryService.requestRetry(ctx, rig.caseId, { idempotencyKey: "concurrent-key-1" }, {}),
      recoveryService.requestRetry(ctx, rig.caseId, { idempotencyKey: "concurrent-key-1" }, {})
    ]);
    expect(x.executionId).toBe(y.executionId); // one logical execution
    expect(world.pay!.operations).toHaveLength(1); // ONE provider operation — never two charges
    expect(await attempts()).toHaveLength(1);
  });

  it("same key + changed amount → conflict 409; financial parameters are immutable", async () => {
    const world = baseWorld();
    world.pay = { behavior: "ok" };
    await execute({ idempotencyKey: "immut-key-0001" }, world);
    await withOrgTx(appDb(), rig.orgId, (tx) =>
      tx.update(schema.payments).set({ amountCents: 9999 }).where(eq(schema.payments.id, rig.paymentId)));
    await expect(execute({ idempotencyKey: "immut-key-0001" }, world))
      .rejects.toMatchObject({ problem: { status: 409 } });
    const rows = await attempts();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.amountCents).toBe(1900); // the recorded amount was never reinterpreted
  });

  it("same key + changed currency → conflict 409; currency never re-derived", async () => {
    const world = baseWorld();
    world.pay = { behavior: "ok" };
    await execute({ idempotencyKey: "immut-key-0002" }, world);
    await withOrgTx(appDb(), rig.orgId, (tx) =>
      tx.update(schema.payments).set({ currency: "EUR" }).where(eq(schema.payments.id, rig.paymentId)));
    await expect(execute({ idempotencyKey: "immut-key-0002" }, world))
      .rejects.toMatchObject({ problem: { status: 409 } });
    const rows = await attempts();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.currency).toBe("USD"); // immutable
  });

  it("same-key re-delivery returns the SAME execution — the provider never sees a second operation", async () => {
    const world = baseWorld();
    world.pay = { behavior: "ok", idempotentReplay: true };
    const a = await execute({ idempotencyKey: "prov-replay-00001" }, world);
    expect(a.status).toBe("succeeded"); // first execution advanced the payment to paid
    const b = await execute({ idempotencyKey: "prov-replay-00001" }, world);
    expect(b.executionId).toBe(a.executionId); // same logical execution returned
    expect(await attempts()).toHaveLength(1);
    expect(world.pay!.operations).toHaveLength(1); // never a second provider operation
  });

  it("provider idempotency (fixture contract): the same provider key replays the recorded result", async () => {
    const world = baseWorld();
    world.pay = { behavior: "ok", idempotentReplay: true };
    const gw = fixtureGateway(world);
    const first = await gw.payInvoice("rk_test_0123456789abcdefABCD", {
      invoiceId: rig.stripeInvoiceId, idempotencyKey: "rv:provider:key-1"
    });
    const second = await gw.payInvoice("rk_test_0123456789abcdefABCD", {
      invoiceId: rig.stripeInvoiceId, idempotencyKey: "rv:provider:key-1"
    });
    expect(second.invoiceStatus).toBe(first.invoiceStatus);
    expect(second.paid).toBe(true);
    expect(world.pay!.operations).toHaveLength(1); // ONE operation — replay returned the record
  });
});

/* ============ Outcomes ============ */

describe("outcome taxonomy", () => {
  it("declined (generic): execution failed, decline category recorded, classification 'never'", async () => {
    const world = baseWorld();
    world.pay = { behavior: "decline:generic" };
    const res = await execute({}, world);
    expect(res.status).toBe("failed");
    expect(res.outcomeCategory).toBe("card_declined");
    expect(res.retryClassification).toBe("never"); // declines never auto-retry
    expect((await paymentRow()).status).toBe("failed"); // local truth unchanged by the operator action alone
  });

  it("insufficient_funds and expired_card are distinct decline categories, both 'never'", async () => {
    const w1 = baseWorld();
    w1.pay = { behavior: "decline:insufficient_funds" };
    const a = await execute({}, w1);
    expect(a.outcomeCategory).toBe("insufficient_funds");
    expect(a.retryClassification).toBe("never");

    // a second case/payment in the same org for expired_card
    const w2 = baseWorld();
    w2.invoices = [fixtureInvoice(6, "cus_fixture_001", { status: "uncollectible" })];
    setStripeGatewayForTests(fixtureGateway(w2));
    const ctxAdmin = await ctxFor(rig.owner, rig.slug, "administer");
    await syncService.triggerSync(ctxAdmin, {});
    const [p2] = await withOrgTx(appDb(), rig.orgId, (tx) =>
      tx.select().from(schema.payments).where(eq(schema.payments.stripeInvoiceId, "in_fixture_006")));
    expect(p2?.status).toBe("failed");
    const [c2] = await withOrgTx(appDb(), rig.orgId, (tx) =>
      tx.insert(schema.recoveryCases).values({
        orgId: rig.orgId, customerId: p2!.customerId, subscriptionId: null, paymentId: p2!.id,
        status: "retrying", declineCode: "expired_card", declineCategory: "hard",
        amountCents: p2!.amountCents, currency: p2!.currency, firstFailedAt: new Date(), attemptNo: 1
      }).returning());
    const w2pay = baseWorld();
    w2pay.invoices = w2.invoices;
    w2pay.pay = { behavior: "decline:expired_card" };
    setStripeGatewayForTests(fixtureGateway(w2pay));
    const ctxOp = await ctxFor(rig.owner, rig.slug, "operate");
    const b = await recoveryService.requestRetry(ctxOp, c2!.id, {}, {});
    expect(b.outcomeCategory).toBe("expired_card");
    expect(b.retryClassification).toBe("never");
  });

  it("authentication_required: recorded, never auto-retried", async () => {
    const world = baseWorld();
    world.pay = { behavior: "decline:authentication_required" };
    const res = await execute({}, world);
    expect(res.outcomeCategory).toBe("authentication_required");
    expect(res.retryClassification).toBe("never");
  });

  it("invalid request context: classified invalid_payment_context, 'never' — no blind resend", async () => {
    const world = baseWorld();
    world.pay = { behavior: "invalid_request" };
    const a = await execute({}, world);
    expect(a.outcomeCategory).toBe("invalid_payment_context");
    expect(a.retryClassification).toBe("never");
  });

  it("provider rejects credentials: classified invalid_credentials, 'never'", async () => {
    const gw = fixtureGateway(baseWorld());
    setStripeGatewayForTests({
      ...gw,
      payInvoice: async () => { throw new ProviderError("invalid_credentials"); }
    });
    const ctx = await ctxFor(rig.owner, rig.slug, "operate");
    const b = await recoveryService.requestRetry(ctx, rig.caseId, { idempotencyKey: "badcreds-000001" }, {});
    expect(b.outcomeCategory).toBe("invalid_credentials");
    expect(b.retryClassification).toBe("never");
  });

  it("rate limited: classified retryable-later — classification ONLY, no worker exists", async () => {
    const world = baseWorld();
    world.pay = { behavior: "rate_limited" };
    const res = await execute({}, world);
    expect(res.status).toBe("failed");
    expect(res.outcomeCategory).toBe("rate_limited");
    expect(res.retryClassification).toBe("later");
  });
});

/* ============ The hard case: unknown outcomes (§16) ============ */

describe("unknown outcomes (§16) — provider success with a lost response", () => {
  it("Stripe succeeds → response lost → execution stays UNKNOWN, never re-operated, reconciliation discovers the payment", async () => {
    const world = baseWorld();
    world.pay = { behavior: "network_loss_after_success", idempotentReplay: true };
    await expect(execute({}, world)).rejects.toMatchObject({ problem: { status: 500 } }); // honest unknown-outcome error
    const rows = await attempts();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("unknown"); // NOT failed — nothing assumed
    expect(rows[0]!.retryClassification).toBe("never"); // never blindly retried
    const [attempt] = await withOrgTx(appDb(), rig.orgId, (tx) =>
      tx.select().from(schema.paymentAttempts));
    expect(attempt).toBeUndefined(); // no fabricated local attempt

    // RECONCILIATION (read-only provider truth): invoice IS paid
    setStripeGatewayForTests(fixtureGateway(world));
    const ctx = await ctxFor(rig.owner, rig.slug, "operate");
    await syncService.triggerSync(ctx, {}); // 4A sync restores payment truth from the provider
    expect((await paymentRow()).status).toBe("paid");
    const execs = await executionService.reconcileExecutions(ctx);
    expect(execs).toContain("execution_resolved:succeeded");
    const [row] = await attempts();
    expect(row!.status).toBe("succeeded");
    expect(row!.reconciledAt).toBeTruthy();
    expect(world.pay!.operations).toHaveLength(1); // still exactly one provider operation
  });

  it("outcome cannot be established → provider shows no operation → resolves no_provider_operation (new execution provably safe)", async () => {
    const world = baseWorld();
    world.pay = { behavior: "ambiguous", idempotentReplay: true };
    await execute({}, world).catch(() => undefined);
    expect((await attempts())[0]!.status).toBe("unknown");

    setStripeGatewayForTests(fixtureGateway(world));
    const ctx = await ctxFor(rig.owner, rig.slug, "operate");
    const execs = await executionService.reconcileExecutions(ctx);
    expect(execs).toContain("execution_resolved:no_provider_operation");
    const rows = await attempts();
    expect(rows[0]!.status).toBe("failed");
    expect(rows[0]!.outcomeCategory).toBe("no_provider_operation");

    // §18: a NEW execution is now permitted — the old one provably never charged
    const world2 = baseWorld();
    world2.pay = { behavior: "ok", idempotentReplay: true };
    const retry = await execute({ idempotencyKey: "post-reconcile-key-1" }, world2);
    expect(retry.status).toBe("succeeded");
  });

  it("a second execution is REFUSED while an outcome is unknown (double-charge guard)", async () => {
    const world = baseWorld();
    world.pay = { behavior: "network_loss_after_success" };
    await execute({ idempotencyKey: "unknown-key-000001" }, world).catch(() => undefined);
    expect((await attempts())[0]!.status).toBe("unknown");

    // different key, same payment → refused BEFORE any provider call
    const world2 = baseWorld();
    world2.pay = { behavior: "ok" };
    await expect(execute({ idempotencyKey: "second-key-0000001" }, world2))
      .rejects.toMatchObject({ problem: { status: 409 } });
    expect(world2.pay!.operations ?? []).toHaveLength(0); // nothing was sent to the provider
  });

  it("stale EXECUTING execution (crash after mark): resolved via provider lookup, never blind re-execution", async () => {
    const world = baseWorld();
    world.pay = { behavior: "ok", idempotentReplay: true };
    setStripeGatewayForTests(fixtureGateway(world));
    const ctx = await ctxFor(rig.owner, rig.slug, "operate");
    // simulate crash-after-mark: an 'executing' row with no provider result
    await withOrgTx(appDb(), rig.orgId, (tx) =>
      tx.insert(schema.recoveryAttempts).values({
        orgId: rig.orgId, caseId: rig.caseId, paymentId: rig.paymentId,
        amountCents: 1900, currency: "USD",
        requestHash: "crash", kind: "manual_retry", actor: "someone",
        status: "executing", idempotencyKey: "crashed-key-0000001"
      }));
    const execs = await executionService.reconcileExecutions(ctx);
    expect(execs).toContain("execution_resolved:no_provider_operation"); // provider says nothing happened
    const rows = await attempts();
    expect(rows.find((r) => r.idempotencyKey === "crashed-key-0000001")!.status).toBe("failed");
    expect(world.pay!.operations ?? []).toHaveLength(0); // provider queried read-only, never charged
  });
});

/* ============ Webhook interaction (4B truth path) ============ */

describe("webhook interaction", () => {
  it("payment no longer failed (webhook truth arrived first) → execution refused safely", async () => {
    // The provider-side truth (payment paid via webhook) wins over the queued intent:
    await withOrgTx(appDb(), rig.orgId, (tx) =>
      tx.update(schema.payments).set({ status: "paid", paidAt: new Date() }).where(eq(schema.payments.id, rig.paymentId)));
    const world = baseWorld();
    world.pay = { behavior: "ok" };
    await expect(execute({}, world)).rejects.toMatchObject({ problem: { status: 400 } });
    expect(await attempts()).toHaveLength(0); // nothing executed against a paid invoice
    expect(world.pay!.operations ?? []).toHaveLength(0);
  });

  it("reconcileFromProvider repairs executions alongside the 4B lifecycle", async () => {
    const world = baseWorld();
    world.pay = { behavior: "network_loss_after_success", idempotentReplay: true };
    await execute({}, world).catch(() => undefined);
    setStripeGatewayForTests(fixtureGateway(world));
    const ctx = await ctxFor(rig.owner, rig.slug, "operate");
    await syncService.triggerSync(ctx, {}); // runs the 4A invoice sync (reconcileFromProvider path)
    const execs = await executionService.reconcileExecutions(ctx);
    expect(execs).toContain("execution_resolved:succeeded");
  });
});

/* ============ Secrets & audit ============ */

describe("secrets and audit", () => {
  it("no key, webhook secret, or provider idempotency key reaches the DTO or the audit log; amount IS recorded", async () => {
    const world = baseWorld();
    world.pay = { behavior: "ok" };
    const res = await execute({}, world);
    const dto = JSON.stringify(res);
    expect(dto).not.toContain(GOOD_KEY);
    expect(dto).not.toContain("whsec_");
    expect(dto).not.toContain(`rv:${rig.orgId}:${res.executionId}`); // provider key never exposed
    expect(dto).not.toMatch(/card_|pm_|cus_fixture_/); // no provider object ids beyond the narrow DTO

    const audits = await withOrgTx(appDb(), rig.orgId, (tx) =>
      tx.select().from(schema.auditLogs).where(eq(schema.auditLogs.targetType, "payment_execution")));
    const actions = audits.map((a) => a.action).sort();
    expect(actions).toContain("payment.executed");
    expect(actions).toContain("payment.execute_attempted");
    const blob = JSON.stringify(audits.map((a) => a.diff));
    expect(blob).not.toContain(GOOD_KEY);
    expect(blob).not.toContain("whsec_");
    expect(blob).toContain("1900"); // safe facts: amount + currency are audited
    expect(blob).toContain("USD");
  });

  it("declined execution audits a safe code only — no provider internals", async () => {
    const world = baseWorld();
    world.pay = { behavior: "decline:insufficient_funds" };
    const res = await execute({}, world);
    expect(res.errorCode).toBe("insufficient_funds"); // taxonomy-safe code
    const audits = await withOrgTx(appDb(), rig.orgId, (tx) =>
      tx.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "payment.declined")));
    expect(audits).toHaveLength(1);
    const blob = JSON.stringify(audits[0]!.diff);
    expect(blob).not.toContain(GOOD_KEY);
    expect(blob).toContain("insufficient_funds");
  });
})

/* ==== PHASE 4C CORRECTION: provider-invoice preflight before invoices.pay ====
 * Stripe collects according to the CURRENT provider invoice, so the local
 * amount alone does not constrain the charge. Every new execution verifies
 * provider customer/currency/amount/state FIRST; any mismatch or missing
 * field refuses with ZERO payment/mutation calls. */

/** A world whose CURRENT provider invoice differs from the local mirror. */
function mutatedWorld(mutate: (inv: FixtureWorld["invoices"][number]) => void, pay?: FixtureWorld["pay"]): FixtureWorld {
  const w = baseWorld();
  mutate(w.invoices[0]!);
  if (pay) w.pay = pay;
  return w;
}

async function preflightAuditReasons(): Promise<string[]> {
  const audits = await withOrgTx(appDb(), rig.orgId, (tx) =>
    tx.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "payment.preflight_failed")));
  return audits.map((a) => String((a.diff as { reason?: string })?.reason ?? ""));
}

describe("preflight: financial mismatch refuses with zero payment calls", () => {
  it("provider amount differs from the local record → refusal, nothing executed", async () => {
    const w = mutatedWorld((inv) => { inv.amountMinor = 4200; }, { behavior: "ok" });
    await expect(execute({}, w)).rejects.toMatchObject({ problem: { status: 409 } });
    expect(await attempts()).toHaveLength(0); // no durable execution
    expect(w.pay!.operations ?? []).toHaveLength(0); // ZERO payment calls
    expect((await paymentRow()).status).toBe("failed"); // local truth untouched
    expect((await preflightAuditReasons())).toContain("provider_amount_mismatch");
  });

  it("provider currency differs → refusal, nothing executed", async () => {
    const w = mutatedWorld((inv) => { inv.currency = "EUR"; }, { behavior: "ok" });
    await expect(execute({}, w)).rejects.toMatchObject({ problem: { status: 409 } });
    expect(await attempts()).toHaveLength(0);
    expect(w.pay!.operations ?? []).toHaveLength(0);
    expect((await preflightAuditReasons())).toContain("provider_currency_mismatch");
  });

  it("provider customer differs → refusal, nothing executed (no guessing)", async () => {
    const w = mutatedWorld((inv) => { inv.customerId = "cus_other_999"; }, { behavior: "ok" });
    await expect(execute({}, w)).rejects.toMatchObject({ problem: { status: 409 } });
    expect(await attempts()).toHaveLength(0);
    expect(w.pay!.operations ?? []).toHaveLength(0);
    expect((await preflightAuditReasons())).toContain("provider_customer_mismatch");
  });

  it("provider amount missing → refusal (never read as zero)", async () => {
    const w = mutatedWorld((inv) => { (inv as { amountMinor: unknown }).amountMinor = null; }, { behavior: "ok" });
    await expect(execute({}, w)).rejects.toMatchObject({ problem: { status: 400 } });
    expect(await attempts()).toHaveLength(0);
    expect(w.pay!.operations ?? []).toHaveLength(0);
    expect((await preflightAuditReasons())).toContain("provider_amount_missing");
  });

  it("provider currency missing → refusal (never defaulted)", async () => {
    const w = mutatedWorld((inv) => { inv.currency = ""; }, { behavior: "ok" });
    await expect(execute({}, w)).rejects.toMatchObject({ problem: { status: 400 } });
    expect(await attempts()).toHaveLength(0);
    expect(w.pay!.operations ?? []).toHaveLength(0);
    expect((await preflightAuditReasons())).toContain("provider_currency_missing");
  });

  it("provider customer missing → refusal (target never guessed)", async () => {
    const w = mutatedWorld((inv) => { inv.customerId = null; }, { behavior: "ok" });
    await expect(execute({}, w)).rejects.toMatchObject({ problem: { status: 400 } });
    expect(await attempts()).toHaveLength(0);
    expect(w.pay!.operations ?? []).toHaveLength(0);
    expect((await preflightAuditReasons())).toContain("provider_customer_missing");
  });

  it("provider invoice partially paid/credited (amount_due ≠ amount_remaining) → refusal, reconcile first", async () => {
    const gw = fixtureGateway(baseWorld());
    setStripeGatewayForTests({
      ...gw,
      getInvoiceForExecution: async (_key: string, invoiceId: string) => ({
        invoiceId, customerId: "cus_fixture_001", amountDue: 1900, amountRemaining: 900,
        currency: "USD", status: "open", attempted: true
      })
    });
    const ctx = await ctxFor(rig.owner, rig.slug, "operate");
    await expect(recoveryService.requestRetry(ctx, rig.caseId, { idempotencyKey: "partial-key-00001" }, {}))
      .rejects.toMatchObject({ problem: { status: 409 } });
    expect(await attempts()).toHaveLength(0);
    expect((await preflightAuditReasons())).toContain("provider_partially_paid");
  });
});

describe("preflight: provider-state whitelist", () => {
  it("local 'failed' but provider invoice already PAID → no payment call; sync converges local truth to paid", async () => {
    const w = mutatedWorld((inv) => { inv.status = "paid"; }, { behavior: "ok" });
    await expect(execute({}, w)).rejects.toMatchObject({ problem: { status: 409 } });
    expect(w.pay!.operations ?? []).toHaveLength(0); // never a second charge
    expect(await attempts()).toHaveLength(0);
    expect((await preflightAuditReasons())).toContain("provider_invoice_already_paid");
    // reconciliation converges: sync reads the provider's paid invoice
    setStripeGatewayForTests(fixtureGateway(w));
    const ctx = await ctxFor(rig.owner, rig.slug, "administer");
    await syncService.triggerSync(ctx, {});
    expect((await paymentRow()).status).toBe("paid");
  });

  it("provider invoice VOID → no payment call", async () => {
    const w = mutatedWorld((inv) => { inv.status = "void"; }, { behavior: "ok" });
    await expect(execute({}, w)).rejects.toMatchObject({ problem: { status: 409 } });
    expect(w.pay!.operations ?? []).toHaveLength(0);
    expect((await preflightAuditReasons())).toContain("provider_invoice_void");
  });

  it("provider invoice with unsupported/future status → anomaly, no payment call, never mapped to payable", async () => {
    const w = mutatedWorld((inv) => { inv.status = "scheduled_future_state"; }, { behavior: "ok" });
    await expect(execute({}, w)).rejects.toMatchObject({ problem: { status: 409 } });
    expect(w.pay!.operations ?? []).toHaveLength(0);
    expect((await preflightAuditReasons())).toContain("unsupported_provider_state:scheduled_future_state");
  });

  it("provider invoice status missing → anomaly, no payment call", async () => {
    const w = mutatedWorld((inv) => { inv.status = ""; }, { behavior: "ok" });
    await expect(execute({}, w)).rejects.toMatchObject({ problem: { status: 409 } });
    expect(w.pay!.operations ?? []).toHaveLength(0);
    expect((await preflightAuditReasons())).toContain("unsupported_provider_state");
  });
});

describe("preflight: idempotency ordering preserved (correction §7)", () => {
  it("an existing successful execution replays as the SAME execution even though the provider invoice is now paid", async () => {
    const w = mutatedWorld(() => undefined, { behavior: "ok", idempotentReplay: true });
    const a = await execute({ idempotencyKey: "replay-order-0001" }, w);
    expect(a.status).toBe("succeeded");
    // the provider invoice is NOW paid (the operation succeeded)
    w.invoices[0]!.status = "paid";
    const opsBefore = w.pay!.operations!.length;
    const b = await execute({ idempotencyKey: "replay-order-0001" }, w);
    expect(b.executionId).toBe(a.executionId); // replay returned, NOT rejected as paid
    expect(w.pay!.operations!.length).toBe(opsBefore); // no second operation, no preflight re-execution
  });

  it("same key + changed customer mapping → conflict (customer is part of the execution identity)", async () => {
    const w = mutatedWorld(() => undefined, { behavior: "ok" });
    await execute({ idempotencyKey: "cust-immut-0001" }, w);
    const payment = await paymentRow();
    await withOrgTx(appDb(), rig.orgId, (tx) =>
      tx.update(schema.customers).set({ stripeCustomerId: "cus_remapped_42" }).where(eq(schema.customers.id, payment.customerId)));
    await expect(execute({ idempotencyKey: "cust-immut-0001" }, w))
      .rejects.toMatchObject({ problem: { status: 409 } });
    expect(await attempts()).toHaveLength(1); // the original execution stands
    expect(w.pay!.operations ?? []).toHaveLength(1); // no second provider operation
  });

  it("same key + changed amount, and same key + changed currency, remain conflicts (regression)", async () => {
    const w = mutatedWorld(() => undefined, { behavior: "ok" });
    await execute({ idempotencyKey: "fin-immut-0001" }, w);
    await withOrgTx(appDb(), rig.orgId, (tx) =>
      tx.update(schema.payments).set({ amountCents: 7777 }).where(eq(schema.payments.id, rig.paymentId)));
    await expect(execute({ idempotencyKey: "fin-immut-0001" }, w)).rejects.toMatchObject({ problem: { status: 409 } });
    await withOrgTx(appDb(), rig.orgId, (tx) =>
      tx.update(schema.payments).set({ amountCents: 1900, currency: "CHF" }).where(eq(schema.payments.id, rig.paymentId)));
    await expect(execute({ idempotencyKey: "fin-immut-0001" }, w)).rejects.toMatchObject({ problem: { status: 409 } });
    expect(w.pay!.operations ?? []).toHaveLength(1);
  });
});

describe("preflight: provider lookup failure (correction §8)", () => {
  it("transient preflight failure → honest refusal, NO blind payment, recoverable afterwards", async () => {
    const w = mutatedWorld(() => undefined, { behavior: "ok" });
    w.failures = [{ on: "invoice_lookup", kind: "transient_network" }];
    await expect(execute({}, w)).rejects.toMatchObject({ problem: { status: 500 } });
    expect(w.pay!.operations ?? []).toHaveLength(0); // never a blind payment
    expect(await attempts()).toHaveLength(0); // nothing durable assumed an outcome
    expect((await preflightAuditReasons())[0]).toContain("provider_lookup_failed:transient_network");
    // recoverable: once the provider is reachable again the SAME command succeeds
    const healthy = mutatedWorld(() => undefined, { behavior: "ok", idempotentReplay: true });
    const res = await execute({ idempotencyKey: "after-outage-0001" }, healthy);
    expect(res.status).toBe("succeeded");
  });

  it("concurrent executions still produce at most ONE provider payment operation (regression)", async () => {
    const w = mutatedWorld(() => undefined, { behavior: "ok", idempotentReplay: true });
    setStripeGatewayForTests(fixtureGateway(w));
    const ctx = await ctxFor(rig.owner, rig.slug, "operate");
    const [x, y] = await Promise.all([
      recoveryService.requestRetry(ctx, rig.caseId, { idempotencyKey: "preflight-conc-001" }, {}),
      recoveryService.requestRetry(ctx, rig.caseId, { idempotencyKey: "preflight-conc-001" }, {})
    ]);
    expect(x.executionId).toBe(y.executionId);
    expect(w.pay!.operations ?? []).toHaveLength(1);
    expect(await attempts()).toHaveLength(1);
  });
});

/* ==== PHASE 4C CORRECTION 2: payment-level TOCTOU / double-charge guard ====
 * The payment advisory lock is the FINAL serialization boundary: local and
 * provider truth are re-read UNDER the lock, immediately before invoices.pay.
 * The pre-lock preflight is preliminary only — two executions with DIFFERENT
 * idempotency keys can both pass it before either charges. Invariant:
 * different idempotency keys ≠ permission to charge twice. */

type ProviderInvoiceTruth = {
  invoiceId: string; customerId: string | null;
  amountDue: number | null; amountRemaining: number | null;
  currency: string | null; status: string | null; attempted: boolean;
};

/** Deterministic race harness: the FIRST provider lookup (preliminary
 *  preflight) sees a healthy payable invoice; lookups ≥ 2 (the authoritative
 *  post-lock re-read) see `postLockOverride`. `onFirstLookup` runs after the
 *  first read (used to move LOCAL truth mid-flight). No sleeps — the
 *  interleaving is fixed by the code path itself. */
function raceGateway(
  world: FixtureWorld,
  postLockOverride: Partial<ProviderInvoiceTruth> | null,
  opts?: { onFirstLookup?: () => void | Promise<void> }
) {
  const gw = fixtureGateway(world);
  const pay = world.pay ?? (world.pay = { behavior: "ok" });
  pay.operations = pay.operations ?? [];
  let lookups = 0;
  return {
    ...gw,
    getInvoiceForExecution: async (key: string, invoiceId: string): Promise<ProviderInvoiceTruth> => {
      lookups += 1;
      if (lookups === 1 && opts?.onFirstLookup) await opts.onFirstLookup();
      const truth = await gw.getInvoiceForExecution(key, invoiceId);
      return lookups >= 2 && postLockOverride ? { ...truth, ...postLockOverride } : truth;
    }
  };
}

async function executeViaGateway(world: FixtureWorld, idempotencyKey: string) {
  setStripeGatewayForTests(fixtureGateway(world));
  const ctx = await ctxFor(rig.owner, rig.slug, "operate");
  return recoveryService.requestRetry(ctx, rig.caseId, { idempotencyKey }, {});
}

async function attemptByKey(key: string) {
  const [row] = await withOrgTx(appDb(), rig.orgId, (tx) =>
    tx.select().from(schema.recoveryAttempts).where(eq(schema.recoveryAttempts.idempotencyKey, key)));
  return row;
}

async function postLockAuditReasons(): Promise<string[]> {
  const audits = await withOrgTx(appDb(), rig.orgId, (tx) =>
    tx.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "payment.preflight_failed")));
  return audits
    .filter((a) => (a.diff as { phase?: string }).phase === "post_lock")
    .map((a) => String((a.diff as { reason?: string }).reason ?? ""));
}

describe("correction 2: different-key same-payment executions cannot double-charge", () => {
  it("sequential different-key execution after success → zero second provider calls", async () => {
    const w = baseWorld();
    w.pay = { behavior: "ok" };
    const a = await executeViaGateway(w, "seq-key-A-000001");
    expect(a.status).toBe("succeeded");
    expect(w.pay!.operations).toHaveLength(1);
    // key-B, same payment: the payment is now paid — refused at the local
    // gate BEFORE any provider interaction; the provider is never re-charged.
    const w2 = baseWorld();
    w2.pay = { behavior: "ok" };
    await expect(executeViaGateway(w2, "seq-key-B-000002"))
      .rejects.toMatchObject({ problem: { status: 400 } });
    expect(w2.pay!.operations ?? []).toHaveLength(0);
    expect(w.pay!.operations).toHaveLength(1);
  });

  it("concurrent different-key executions → at most ONE provider payment operation", async () => {
    const w = baseWorld();
    w.pay = { behavior: "ok", idempotentReplay: true };
    setStripeGatewayForTests(fixtureGateway(w));
    const ctx = await ctxFor(rig.owner, rig.slug, "operate");
    const results = await Promise.allSettled([
      recoveryService.requestRetry(ctx, rig.caseId, { idempotencyKey: "race-key-A-0001" }, {}),
      recoveryService.requestRetry(ctx, rig.caseId, { idempotencyKey: "race-key-B-0002" }, {})
    ]);
    const fulfilled = results.filter((r): r is PromiseFulfilledResult<{ status: string }> => r.status === "fulfilled");
    const rejected = results.filter((r): r is PromiseRejectedResult<{ problem: { status: number } }> => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(fulfilled[0]!.value.status).toBe("succeeded");
    expect(rejected[0]!.reason).toMatchObject({ problem: { status: 409 } }); // refused safely, never charged
    // THE invariant: different keys ≠ permission to charge twice
    expect(w.pay!.operations).toHaveLength(1);
    expect((await attempts()).filter((r) => r.status === "succeeded")).toHaveLength(1);
    const [attempt] = await withOrgTx(appDb(), rig.orgId, (tx) =>
      tx.select().from(schema.paymentAttempts));
    expect(attempt).toBeTruthy(); // exactly one observed provider attempt
  });

  it("local payment becomes paid between the pre-lock gate and the post-lock re-read → refused, zero provider calls", async () => {
    const w = baseWorld();
    w.pay = { behavior: "ok" };
    setStripeGatewayForTests(raceGateway(w, null, {
      onFirstLookup: () => withOrgTx(appDb(), rig.orgId, (tx) =>
        tx.update(schema.payments).set({ status: "paid", paidAt: new Date() })
          .where(eq(schema.payments.id, rig.paymentId)))
    }));
    const ctx = await ctxFor(rig.owner, rig.slug, "operate");
    // passes the pre-lock local gate (still "failed" then), preflight is
    // payable — the post-lock LOCAL re-read sees "paid" and refuses.
    await expect(recoveryService.requestRetry(ctx, rig.caseId, { idempotencyKey: "localflip-key-1" }, {}))
      .rejects.toMatchObject({ problem: { status: 409 } });
    expect(w.pay!.operations).toHaveLength(0); // never reached invoices.pay
    const row = await attemptByKey("localflip-key-1");
    expect(row!.status).toBe("skipped");
    expect(row!.errorCode).toBe("payment_already_paid");
    expect((await postLockAuditReasons())).toContain("payment_already_paid");
  });
});

describe("correction 2: provider truth re-read UNDER the payment lock (TOCTOU closed)", () => {
  it("provider invoice becomes paid between preliminary preflight and post-lock revalidation → zero payment calls", async () => {
    const w = baseWorld();
    setStripeGatewayForTests(raceGateway(w, { status: "paid" }));
    const ctx = await ctxFor(rig.owner, rig.slug, "operate");
    await expect(recoveryService.requestRetry(ctx, rig.caseId, { idempotencyKey: "tocpaid-key-001" }, {}))
      .rejects.toMatchObject({ problem: { status: 409 } });
    expect(w.pay!.operations).toHaveLength(0);
    const row = await attemptByKey("tocpaid-key-001");
    expect(row!.status).toBe("skipped");
    expect(row!.errorCode).toBe("provider_invoice_already_paid");
  });

  it("provider invoice becomes void between the two reads → zero payment calls", async () => {
    const w = baseWorld();
    setStripeGatewayForTests(raceGateway(w, { status: "void" }));
    const ctx = await ctxFor(rig.owner, rig.slug, "operate");
    await expect(recoveryService.requestRetry(ctx, rig.caseId, { idempotencyKey: "tocvoid-key-001" }, {}))
      .rejects.toMatchObject({ problem: { status: 409 } });
    expect(w.pay!.operations).toHaveLength(0);
    expect((await attemptByKey("tocvoid-key-001"))!.errorCode).toBe("provider_invoice_void");
  });

  it("provider amount changes between the two reads → zero payment calls", async () => {
    const w = baseWorld();
    setStripeGatewayForTests(raceGateway(w, { amountDue: 2500, amountRemaining: 2500 }));
    const ctx = await ctxFor(rig.owner, rig.slug, "operate");
    await expect(recoveryService.requestRetry(ctx, rig.caseId, { idempotencyKey: "tocamt-key-0001" }, {}))
      .rejects.toMatchObject({ problem: { status: 409 } });
    expect(w.pay!.operations).toHaveLength(0);
    expect((await attemptByKey("tocamt-key-0001"))!.errorCode).toBe("provider_amount_mismatch");
  });

  it("provider currency changes between the two reads → zero payment calls", async () => {
    const w = baseWorld();
    setStripeGatewayForTests(raceGateway(w, { currency: "EUR" }));
    const ctx = await ctxFor(rig.owner, rig.slug, "operate");
    await expect(recoveryService.requestRetry(ctx, rig.caseId, { idempotencyKey: "toccur-key-0001" }, {}))
      .rejects.toMatchObject({ problem: { status: 409 } });
    expect(w.pay!.operations).toHaveLength(0);
    expect((await attemptByKey("toccur-key-0001"))!.errorCode).toBe("provider_currency_mismatch");
  });

  it("provider customer changes between the two reads → zero payment calls", async () => {
    const w = baseWorld();
    setStripeGatewayForTests(raceGateway(w, { customerId: "cus_remapped_late" }));
    const ctx = await ctxFor(rig.owner, rig.slug, "operate");
    await expect(recoveryService.requestRetry(ctx, rig.caseId, { idempotencyKey: "toccus-key-0001" }, {}))
      .rejects.toMatchObject({ problem: { status: 409 } });
    expect(w.pay!.operations).toHaveLength(0);
    expect((await attemptByKey("toccus-key-0001"))!.errorCode).toBe("provider_customer_mismatch");
  });

  it("exact same-key successful replay returns the original execution WITHOUT any provider lookup (ordering intact)", async () => {
    const w = baseWorld();
    w.pay = { behavior: "ok", idempotentReplay: true };
    const gw = fixtureGateway(w);
    let lookups = 0;
    setStripeGatewayForTests({
      ...gw,
      getInvoiceForExecution: async (key: string, invoiceId: string) => {
        lookups += 1;
        return gw.getInvoiceForExecution(key, invoiceId);
      }
    });
    const ctx = await ctxFor(rig.owner, rig.slug, "operate");
    const a = await recoveryService.requestRetry(ctx, rig.caseId, { idempotencyKey: "replay-lookup-001" }, {});
    expect(a.status).toBe("succeeded");
    const afterFirst = lookups;
    const b = await recoveryService.requestRetry(ctx, rig.caseId, { idempotencyKey: "replay-lookup-001" }, {});
    expect(b.executionId).toBe(a.executionId); // exact replay, before every gate
    expect(lookups).toBe(afterFirst); // zero provider reads on the replay path
    expect(w.pay!.operations).toHaveLength(1);
  });
});
