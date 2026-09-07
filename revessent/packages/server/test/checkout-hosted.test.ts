/**
 * PHASE 8 CORRECTION — HOSTED RECOVERY CHECKOUT (real Postgres + fixture
 * provider + real signed webhook receipt).
 *
 * Proves: token security (forged/expired/rotated/cross-org), financial
 * boundary (no amount/customer/invoice from the client; 4C preflight rules
 * gate the hand-off; stale/paid/void/mismatched provider truth refuses),
 * idempotency (repeat/concurrent starts converge on ONE provider URL and
 * ZERO payment calls), completion ONLY via provider truth (webhook before
 * or after redirect, duplicates, out-of-order, abandoned), failure honesty,
 * PCI/logging hygiene, and that the 4C/4D execution path is unchanged.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { appDb, checkoutService, recoveryService, retryService, settingsService, syncService, webhooksService } from "@revessent/server";
import * as schema from "@revessent/db";
import { withOrgTx } from "@revessent/db";
import { setStripeGatewayForTests, resetStripeGateway, generateTestSignatureHeader, ProviderError } from "@revessent/integrations";
import {
  fixtureGateway, fixtureAccount, fixtureCustomer, fixtureSubscription, fixtureInvoice, resetFixtureWorlds
} from "@revessent/integrations/fixtures";
import type { FixtureWorld } from "@revessent/integrations/fixtures";
import { createTestOrg, createTestUser, ctxFor, suffix } from "./helpers";

const GOOD_KEY = "rk_test_0123456789abcdefABCD";
const DAY = 86_400_000;
const INVOICE = "in_fixture_003";
const CUSTOMER = "cus_fixture_001";

interface Rig {
  slug: string; orgId: string; owner: Awaited<ReturnType<typeof createTestUser>>;
  caseId: string; paymentId: string; token: string; connId: string; secret: string; world: FixtureWorld;
}
let rig: Rig;

function baseWorld(): FixtureWorld {
  return {
    account: fixtureAccount({ id: "acct_ck_" + suffix() }),
    customers: [fixtureCustomer(1)],
    subscriptions: [fixtureSubscription(1, CUSTOMER)],
    invoices: [fixtureInvoice(3, CUSTOMER, { status: "uncollectible" })]
  };
}

async function buildRig(): Promise<Rig> {
  const owner = await createTestUser("ck-owner");
  const { slug, orgId } = await createTestOrg(owner, `ck${suffix()}`);
  const world = baseWorld();
  const gw = fixtureGateway(world);
  const secret = `whsec_test_${suffix()}`;
  const realCreate = gw.createWebhookEndpoint.bind(gw);
  gw.createWebhookEndpoint = async (key, opts) => ({ ...(await realCreate(key, opts)), secret });
  setStripeGatewayForTests(gw);
  const ctx = await ctxFor(owner, slug, "administer");
  await settingsService.stripeConnect(ctx, GOOD_KEY, {});
  await syncService.triggerSync(ctx, {});
  const [conn] = await withOrgTx(appDb(), orgId, (tx) => tx.select().from(schema.stripeConnections).where(eq(schema.stripeConnections.orgId, orgId)));
  const [payment] = await withOrgTx(appDb(), orgId, (tx) =>
    tx.select().from(schema.payments).where(eq(schema.payments.status, "failed")).limit(1));
  if (!payment) throw new Error("fixture world did not produce a failed payment");
  const [recCase] = await withOrgTx(appDb(), orgId, (tx) =>
    tx.insert(schema.recoveryCases).values({
      orgId, customerId: payment.customerId, subscriptionId: null, paymentId: payment.id,
      status: "contacting", declineCode: "expired_card", declineCategory: "expired_card",
      amountCents: payment.amountCents, currency: payment.currency,
      firstFailedAt: new Date(Date.now() - 3 * DAY), attemptNo: 0, retryPolicyVersion: 1
    }).returning());
  const link = await checkoutService.createCheckoutLink(await ctxFor(owner, slug, "operate"), recCase!.id, {});
  return { slug, orgId, owner, caseId: recCase!.id, paymentId: payment.id, token: link.token, connId: conn!.id, secret, world };
}

beforeEach(async () => { rig = await buildRig(); });
afterEach(() => { resetStripeGateway(); resetFixtureWorlds(); });

const start = (token = rig.token) => checkoutService.startCheckout(appDb(), token, { ip: "127.0.0.1", userAgent: "vitest" });

async function caseRow() {
  const [r] = await withOrgTx(appDb(), rig.orgId, (tx) => tx.select().from(schema.recoveryCases).where(eq(schema.recoveryCases.id, rig.caseId)));
  return r!;
}
async function paymentRow() {
  const [r] = await withOrgTx(appDb(), rig.orgId, (tx) => tx.select().from(schema.payments).where(eq(schema.payments.id, rig.paymentId)));
  return r!;
}
async function checkoutRows() {
  return withOrgTx(appDb(), rig.orgId, (tx) => tx.select().from(schema.recoveryCheckouts).where(eq(schema.recoveryCheckouts.caseId, rig.caseId)));
}
async function attributions() {
  return withOrgTx(appDb(), rig.orgId, (tx) => tx.select().from(schema.recoveryAttributions).where(eq(schema.recoveryAttributions.caseId, rig.caseId)));
}
async function attempts() {
  return withOrgTx(appDb(), rig.orgId, (tx) => tx.select().from(schema.recoveryAttempts).where(eq(schema.recoveryAttempts.caseId, rig.caseId)));
}
async function audits(action: string) {
  return withOrgTx(appDb(), rig.orgId, (tx) =>
    tx.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.orgId, rig.orgId), eq(schema.auditLogs.action, action))));
}

let seq = 0;
function invoicePaidEvent(overrides: Record<string, unknown> = {}, createdOffsetSec = 0, id?: string) {
  seq++;
  const event = {
    id: id ?? `evt_ck_${suffix()}_${seq}`, object: "event", api_version: "2024-06-20",
    created: Math.floor(Date.now() / 1000) + createdOffsetSec,
    data: { object: {
      id: INVOICE, object: "invoice", customer: CUSTOMER, status: "paid", attempted: true, attempt_count: 2,
      amount_due: 1900, amount_paid: 1900, currency: "usd", created: 1_700_000_500 + 3 * 3600,
      hosted_invoice_url: "https://invoice.stripe.com/i/fixture_3",
      status_transitions: { paid_at: Math.floor(Date.now() / 1000) }, ...overrides
    } },
    livemode: false, pending_webhooks: 1, request: { id: null, idempotency_key: null }, type: "invoice.paid"
  };
  return JSON.stringify(event);
}
async function deliver(payload: string) {
  const sig = await generateTestSignatureHeader({ payload, secret: rig.secret });
  return webhooksService.receiveStripeWebhook({ orgRef: rig.connId, rawBody: payload, sigHeader: sig });
}

/* ================= A. security ================= */

describe("token security", () => {
  it("valid token → ready with the provider's OWN hosted page for THIS invoice, nothing else exposed", async () => {
    const r = await start();
    expect(r).toEqual({ state: "ready", url: "https://invoice.stripe.com/i/fixture_3" });
    expect(JSON.stringify(r)).not.toMatch(rig.orgId);
    expect(JSON.stringify(r)).not.toMatch(rig.caseId);
    expect(rig.world.calls?.pay ?? 0).toBe(0); // NEVER a payment call
    expect(rig.world.calls?.invoice_lookup).toBe(1);
  });

  it("malformed / forged / unknown tokens → unknown, no provider call, no rows touched", async () => {
    for (const t of ["", "x", "not-a-real-token-value-0000", rig.token.slice(0, -1) + (rig.token.endsWith("A") ? "B" : "A")]) {
      expect(await start(t)).toEqual({ state: "unknown" });
    }
    expect(rig.world.calls?.invoice_lookup ?? 0).toBe(0);
    expect((await checkoutRows())[0]!.startCount).toBe(0);
  });

  it("expired token → expired (no provider call)", async () => {
    await withOrgTx(appDb(), rig.orgId, (tx) => tx.update(schema.recoveryCheckouts).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.recoveryCheckouts.caseId, rig.caseId)));
    expect(await start()).toEqual({ state: "expired" });
    expect(rig.world.calls?.invoice_lookup ?? 0).toBe(0);
  });

  it("rotated token: the old link is disabled and refused; only the new one works", async () => {
    const fresh = await checkoutService.createCheckoutLink(await ctxFor(rig.owner, rig.slug, "operate"), rig.caseId, {});
    expect(await start(rig.token)).toEqual({ state: "expired" });
    expect((await start(fresh.token)).state).toBe("ready");
  });

  it("cross-org: another org's token can never resolve this org's case", async () => {
    const other = await createTestUser("ck-other");
    const { slug, orgId } = await createTestOrg(other, `cko${suffix()}`);
    // a case in the other org with a link; the link must only ever see ITS case
    const [cust] = await withOrgTx(appDb(), orgId, (tx) => tx.insert(schema.customers).values({ orgId, stripeCustomerId: "cus_other", email: "o@test.example", name: "O" }).returning());
    const [pay] = await withOrgTx(appDb(), orgId, (tx) => tx.insert(schema.payments).values({ orgId, customerId: cust!.id, stripeInvoiceId: "in_other", amountCents: 500, currency: "USD", status: "failed" }).returning());
    const [c] = await withOrgTx(appDb(), orgId, (tx) => tx.insert(schema.recoveryCases).values({ orgId, customerId: cust!.id, paymentId: pay!.id, status: "contacting", declineCode: "expired_card", declineCategory: "expired_card", amountCents: 500, currency: "USD", firstFailedAt: new Date(), attemptNo: 0, retryPolicyVersion: 1 }).returning());
    const link = await checkoutService.createCheckoutLink(await ctxFor(other, slug, "operate"), c!.id, {});
    // other org has no Stripe connection → honest provider_unavailable, and nothing in OUR org moved
    expect(await start(link.token)).toEqual({ state: "provider_unavailable" });
    expect((await checkoutRows())[0]!.startCount).toBe(0);
    expect((await caseRow()).status).toBe("contacting");
  });

  it("client body cannot influence anything: amount/currency/customer/invoice come only from server records", async () => {
    // startCheckout accepts nothing but the token; the URL returned is the
    // provider's page for the server-resolved invoice, regardless of intent.
    const r = await start();
    expect(r.url).toBe("https://invoice.stripe.com/i/fixture_3");
    const audit = (await audits("checkout.started"))[0]!;
    expect(audit.diff).toMatchObject({ amountCents: 1900, currency: "USD", surface: "stripe_hosted_invoice" });
  });
});

/* ================= B. financial boundary / staleness ================= */

describe("financial boundary: provider truth gates the hand-off (4C rules)", () => {
  it("provider says already paid → already_paid, no URL", async () => {
    rig.world.invoices[0]!.status = "paid";
    expect(await start()).toEqual({ state: "already_paid" });
    expect((await audits("checkout.start_refused")).at(-1)!.diff).toMatchObject({ reason: "provider_invoice_already_paid" });
  });

  it("local payment already paid / case already recovered → already_paid without a provider call", async () => {
    await withOrgTx(appDb(), rig.orgId, (tx) => tx.update(schema.payments).set({ status: "paid" }).where(eq(schema.payments.id, rig.paymentId)));
    expect(await start()).toEqual({ state: "already_paid" });
    expect(rig.world.calls?.invoice_lookup ?? 0).toBe(0);
  });

  it("amount changed on the provider → unavailable (never a hand-off for a different amount)", async () => {
    rig.world.invoices[0]!.amountMinor = 2900;
    expect(await start()).toEqual({ state: "unavailable" });
    expect((await audits("checkout.start_refused")).at(-1)!.diff).toMatchObject({ reason: "provider_amount_mismatch" });
  });

  it("currency mismatch / customer mismatch / void / uncollectible-partial → unavailable", async () => {
    rig.world.invoices[0]!.currency = "EUR";
    expect(await start()).toEqual({ state: "unavailable" });
    rig.world.invoices[0]!.currency = "USD";
    rig.world.invoices[0]!.customerId = "cus_somebody_else";
    expect(await start()).toEqual({ state: "unavailable" });
    rig.world.invoices[0]!.customerId = CUSTOMER;
    rig.world.invoices[0]!.status = "void";
    expect(await start()).toEqual({ state: "unavailable" });
    const reasons = (await audits("checkout.start_refused")).map((a) => (a.diff as { reason: string }).reason);
    expect(reasons).toEqual(expect.arrayContaining(["provider_currency_mismatch", "provider_customer_mismatch", "provider_invoice_void"]));
  });

  it("missing provider fields (amount/customer/status) fail safely — nothing is defaulted", async () => {
    const gw = fixtureGateway(rig.world);
    setStripeGatewayForTests({ ...gw, getInvoiceForExecution: async () => ({ invoiceId: INVOICE, customerId: null, amountDue: null, amountRemaining: null, currency: null, status: null, attempted: false, hostedInvoiceUrl: "https://invoice.stripe.com/i/x" }) });
    expect(await start()).toEqual({ state: "unavailable" });
  });

  it("provider offers no hosted page, or a non-Stripe URL → provider_unavailable (we never construct or forward a foreign URL)", async () => {
    const gw = fixtureGateway(rig.world);
    const base = await gw.getInvoiceForExecution("k", INVOICE);
    setStripeGatewayForTests({ ...gw, getInvoiceForExecution: async () => ({ ...base, hostedInvoiceUrl: null }) });
    expect(await start()).toEqual({ state: "provider_unavailable" });
    setStripeGatewayForTests({ ...gw, getInvoiceForExecution: async () => ({ ...base, hostedInvoiceUrl: "https://evil.example/pay" }) });
    expect(await start()).toEqual({ state: "provider_unavailable" });
  });

  it("disconnected / revoked provider → provider_unavailable; transient outage → provider_error (retryable)", async () => {
    rig.world.failures = [{ on: "invoice_lookup", kind: "revoked" }];
    expect(await start()).toEqual({ state: "provider_unavailable" });
    rig.world.failures = [{ on: "invoice_lookup", kind: "provider_outage" }];
    expect(await start()).toEqual({ state: "provider_error" });
    rig.world.failures = [{ on: "invoice_lookup", kind: "transient_network" }];
    expect(await start()).toEqual({ state: "provider_error" });
    rig.world.failures = [];
    expect((await start()).state).toBe("ready"); // recovers once the provider does
    await withOrgTx(appDb(), rig.orgId, (tx) => tx.update(schema.stripeConnections).set({ status: "revoked", keyCiphertext: null }).where(eq(schema.stripeConnections.orgId, rig.orgId)));
    expect(await start()).toEqual({ state: "provider_unavailable" });
  });

  it("terminal (lost/canceled) case → unavailable", async () => {
    await withOrgTx(appDb(), rig.orgId, (tx) => tx.update(schema.recoveryCases).set({ status: "lost" }).where(eq(schema.recoveryCases.id, rig.caseId)));
    expect(await start()).toEqual({ state: "unavailable" });
  });
});

/* ================= C. idempotency ================= */

describe("idempotency", () => {
  it("double-click / refresh / multi-tab: repeated and concurrent starts converge on the SAME provider URL, zero payment calls", async () => {
    const results = await Promise.all([start(), start(), start(), start(), start()]);
    expect(new Set(results.map((r) => JSON.stringify(r))).size).toBe(1);
    expect(results[0]).toEqual({ state: "ready", url: "https://invoice.stripe.com/i/fixture_3" });
    const again = await start();
    expect(again).toEqual(results[0]);
    const [ck] = await checkoutRows();
    expect(ck!.startCount).toBe(6);
    expect(ck!.status).toBe("open");
    expect(ck!.startedAt).not.toBeNull();
    expect(rig.world.calls?.pay ?? 0).toBe(0);
    expect(await attempts()).toHaveLength(0); // no execution row was ever created
    expect((await caseRow()).status).toBe("contacting"); // a click is not a financial event
  });
});

/* ================= D. completion via provider truth ONLY ================= */

describe("completion", () => {
  it("redirect-before-webhook: nothing is marked paid until invoice.paid arrives; then recovered(source=checkout) + attribution", async () => {
    expect((await start()).state).toBe("ready");
    // "success" redirect happened — the browser can only re-read state:
    expect((await checkoutService.tokenInfo(appDb(), rig.token)).state).toBe("valid");
    expect((await paymentRow()).status).toBe("failed");
    expect((await caseRow()).status).toBe("contacting");
    const rec = await deliver(invoicePaidEvent());
    expect(rec.status).toBe("processed");
    expect((await paymentRow()).status).toBe("paid");
    const c = await caseRow();
    expect(c.status).toBe("recovered");
    expect(c.recoveredCents).toBe(1900);
    const [ck] = await checkoutRows();
    expect(ck!.status).toBe("completed");
    expect(ck!.completedAt).not.toBeNull();
    const attr = await attributions();
    expect(attr).toHaveLength(1);
    expect(attr[0]!.source).toBe("checkout");
    expect(attr[0]!.amountCents).toBe(1900);
    expect((await checkoutService.tokenInfo(appDb(), rig.token)).state).toBe("used");
    expect(await start()).toEqual({ state: "already_paid" });
    expect((await audits("case.recovered")).at(-1)!.diff).toMatchObject({ source: "checkout" });
  });

  it("webhook-before-redirect (browser closed / never returned): completion still lands from provider truth alone", async () => {
    expect((await start()).state).toBe("ready");
    await deliver(invoicePaidEvent());
    expect((await caseRow()).status).toBe("recovered");
    expect((await attributions())[0]!.source).toBe("checkout");
  });

  it("duplicate + delayed + out-of-order deliveries converge: one recovery, one attribution", async () => {
    expect((await start()).state).toBe("ready");
    const paid = invoicePaidEvent({}, 0, `evt_dup_${suffix()}`);
    await deliver(paid);
    const dup = await deliver(paid);
    expect(dup.duplicate).toBe(true);
    // an OLDER failed event arrives late: superseded, domain untouched
    const older = JSON.stringify({ ...JSON.parse(invoicePaidEvent({ status: "open", attempted: true, amount_paid: 0 }, -600)), type: "invoice.payment_failed" });
    const late = await deliver(older);
    expect(late.status).toBe("skipped");
    expect((await paymentRow()).status).toBe("paid");
    expect((await caseRow()).status).toBe("recovered");
    expect(await attributions()).toHaveLength(1);
  });

  it("paid truth arriving via sync/reconciliation (no webhook) also completes the started checkout", async () => {
    expect((await start()).state).toBe("ready");
    rig.world.invoices[0]!.status = "paid";
    rig.world.invoices[0]!.paidAtIso = new Date().toISOString();
    await syncService.triggerSync(await ctxFor(rig.owner, rig.slug, "administer"), {});
    expect((await paymentRow()).status).toBe("paid");
    expect((await caseRow()).status).toBe("recovered");
    expect((await attributions())[0]!.source).toBe("checkout");
  });

  it("abandoned: started but never paid → nothing changes; later expiry keeps it honest", async () => {
    expect((await start()).state).toBe("ready");
    expect((await paymentRow()).status).toBe("failed");
    expect((await caseRow()).status).toBe("contacting");
    expect(await attributions()).toHaveLength(0);
    await withOrgTx(appDb(), rig.orgId, (tx) => tx.update(schema.recoveryCheckouts).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(schema.recoveryCheckouts.caseId, rig.caseId)));
    expect(await start()).toEqual({ state: "expired" });
  });

  it("paid without a started checkout (organic/other) → case NOT attributed to checkout; open link is closed", async () => {
    await deliver(invoicePaidEvent());
    expect((await paymentRow()).status).toBe("paid");
    expect((await caseRow()).status).toBe("contacting"); // 4D/organic paths own this transition
    expect(await attributions()).toHaveLength(0);
    expect((await checkoutRows())[0]!.status).toBe("completed");
    expect((await checkoutService.tokenInfo(appDb(), rig.token)).state).toBe("used");
  });

  it("local state can never fabricate paid: an unpaid provider invoice with a completed-looking local row does not recover", async () => {
    expect((await start()).state).toBe("ready");
    const failedEvent = JSON.stringify({ ...JSON.parse(invoicePaidEvent({ status: "open", attempted: true, amount_paid: 0 })), type: "invoice.payment_failed" });
    await deliver(failedEvent);
    expect((await paymentRow()).status).toBe("failed");
    expect((await caseRow()).status).toBe("contacting");
    expect(await attributions()).toHaveLength(0);
  });
});

/* ================= E. regression: 4C/4D unchanged ================= */

describe("4C/4D regression", () => {
  it("a started checkout does not interfere with manual execution; execution still runs the 4C preflight and pays once", async () => {
    expect((await start()).state).toBe("ready");
    rig.world.pay = { behavior: "ok" };
    const r = await recoveryService.requestRetry(await ctxFor(rig.owner, rig.slug, "operate"), rig.caseId, { idempotencyKey: "ck-regress-000001" }, {});
    expect(r.status).toBe("succeeded");
    expect(rig.world.calls?.pay).toBe(1);
    const c = await caseRow();
    expect(c.status).toBe("recovered");
    // attribution is unique per payment: the retry path attributed first
    const attr = await attributions();
    expect(attr).toHaveLength(1);
    expect(attr[0]!.source).toBe("retry");
    expect(await start()).toEqual({ state: "already_paid" });
  });

  it("automated retry on a case with an open checkout link is unaffected (policy, numbering, preflight)", async () => {
    await withOrgTx(appDb(), rig.orgId, async (tx) => {
      await tx.insert(schema.retryPolicies).values({
        orgId: rig.orgId, version: 1,
        rules: { maxAutoRetries: 2, quietHoursStart: 0, quietHoursEnd: 0, minGapHours: 24, noteAfterFailedRetries: 1, checkoutAfterNote: true,
          autoRetry: { perCategory: { expired_card: { retryable: true, maxAttempts: 2 } }, backoffMultiplier: 2, maxBackoffHours: 168 } }
      });
      await tx.update(schema.recoveryCases).set({ status: "retrying" }).where(eq(schema.recoveryCases.id, rig.caseId));
    });
    expect((await start()).state).toBe("ready");
    rig.world.pay = { behavior: "ok" };
    const res = await retryService.runDueRetries(await ctxFor(rig.owner, rig.slug, "operate"), { caseId: rig.caseId });
    expect(JSON.stringify(res)).toMatch(/succeeded|executed/);
    const auto = (await attempts()).filter((a) => a.kind === "auto_retry");
    expect(auto).toHaveLength(1);
    expect(auto[0]!.attemptNo).toBe(1);
  });
});

/* ================= F. logging / PCI hygiene ================= */

describe("logging hygiene", () => {
  it("audit rows never contain the raw token, the hosted URL, or provider secrets", async () => {
    await start();
    rig.world.failures = [{ on: "invoice_lookup", kind: "provider_outage" }];
    await start();
    const rows = await withOrgTx(appDb(), rig.orgId, (tx) => tx.select().from(schema.auditLogs).where(eq(schema.auditLogs.orgId, rig.orgId)));
    const blob = JSON.stringify(rows);
    expect(blob).not.toContain(rig.token);
    expect(blob).not.toContain("invoice.stripe.com");
    expect(blob).not.toContain(GOOD_KEY);
    expect(blob).not.toMatch(/whsec_test_/);
  });

  it("ProviderError surfaced to the member is a state, never the provider message", async () => {
    rig.world.failures = [{ on: "invoice_lookup", kind: "invalid_credentials" }];
    const r = await start();
    expect(Object.keys(r)).toEqual(["state"]);
    expect(new ProviderError("invalid_credentials").message).not.toBe(r.state);
  });
});
