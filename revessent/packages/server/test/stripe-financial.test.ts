import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { appDb, settingsService, syncService } from "@revessent/server";
import * as schema from "@revessent/db";
import { withOrgTx } from "@revessent/db";
import { setStripeGatewayForTests, resetStripeGateway, normalizeSubscription } from "@revessent/integrations";
import type { StripeSubscriptionLike } from "@revessent/integrations";
import { fixtureGateway, fixtureAccount, fixtureCustomer, fixtureSubscription, fixtureInvoice } from "@revessent/integrations/fixtures";
import { createTestOrg, createTestUser, ctxFor } from "./helpers";

/**
 * PHASE 4A FINAL FINANCIAL-TRUTH AUDIT.
 *
 * Rule: provider truth → validated normalization → domain representation →
 * derived metrics. An unknown provider value never becomes a financial fact.
 * Supported recurring-interval model (Phase 4A): month | year ONLY —
 * anything else is preserved as "unsupported" and excluded from MRR.
 */
describe("adapter normalization: interval / amount / currency honesty", () => {
  const base: StripeSubscriptionLike = {
    id: "sub_raw_001",
    customer: "cus_raw_001",
    status: "active",
    currency: "usd",
    cancel_at_period_end: false,
    canceled_at: null,
    created: 1_700_000_000,
    items: { data: [{ price: { id: "price_001", currency: "usd", unit_amount: 1900, recurring: { interval: "month" } } }] }
  };

  it("interval=week is NOT converted to month — classified unsupported", () => {
    const out = normalizeSubscription({ ...base, items: { data: [{ price: { id: "price_w", currency: "usd", unit_amount: 1000, recurring: { interval: "week" } } }] } });
    expect(out.interval).toBe("unsupported");
    expect(out.amountMinor).toBe(1000); // amount is real; only the cadence is unsupported
  });

  it("interval=day is NOT converted to month", () => {
    const out = normalizeSubscription({ ...base, items: { data: [{ price: { id: "price_d", currency: "usd", unit_amount: 500, recurring: { interval: "day" } } }] } });
    expect(out.interval).toBe("unsupported");
  });

  it("missing recurring data does NOT become monthly", () => {
    const out = normalizeSubscription({ ...base, items: { data: [{ price: { id: "price_nr", currency: "usd", unit_amount: 900, recurring: null } }] } });
    expect(out.interval).toBe("unsupported");
  });

  it("month and year remain verbatim (existing MRR behavior unchanged)", () => {
    const m = normalizeSubscription({ ...base, items: { data: [{ price: { id: "p", currency: "usd", unit_amount: 1900, recurring: { interval: "month" } } }] } });
    const y = normalizeSubscription({ ...base, items: { data: [{ price: { id: "p", currency: "usd", unit_amount: 12000, recurring: { interval: "year" } } }] } });
    expect(m.interval).toBe("month");
    expect(y.interval).toBe("year");
  });

  it("missing unit_amount (tiered price) stays UNKNOWN — not a $0 price", () => {
    const out = normalizeSubscription({ ...base, items: { data: [{ price: { id: "p", currency: "usd", unit_amount: null, recurring: { interval: "month" } } }] } });
    expect(out.amountMinor).toBeNull();
  });

  it("provider-stated zero stays a meaningful zero (free price)", () => {
    const out = normalizeSubscription({ ...base, items: { data: [{ price: { id: "p", currency: "usd", unit_amount: 0, recurring: { interval: "month" } } }] } });
    expect(out.amountMinor).toBe(0); // explicit provider 0 ≠ absent
  });

  it("missing currency stays unknown — never invented as usd", () => {
    const out = normalizeSubscription({ ...base, currency: undefined, items: { data: [{ price: { id: "p", currency: undefined, unit_amount: 1900, recurring: { interval: "month" } } }] } });
    expect(out.currency).toBe("");
  });

  it("missing price identity stays empty — never an invented id", () => {
    const out = normalizeSubscription({ ...base, items: { data: [{ price: null }] } });
    expect(out.priceId).toBe("");
    expect(out.interval).toBe("unsupported");
  });

  it("multi-item subscription records the TRUE item count (first-item limitation surfaced)", () => {
    const out = normalizeSubscription({
      ...base,
      items: {
        data: [
          { price: { id: "p1", currency: "usd", unit_amount: 1900, recurring: { interval: "month" } } },
          { price: { id: "p2", currency: "usd", unit_amount: 999, recurring: { interval: "year" } } }
        ]
      }
    });
    expect(out.itemCount).toBe(2);
    expect(out.amountMinor).toBe(1900); // first item — documented Phase 4A behavior
  });
});

describe("sync-level financial truth (DB persistence + MRR)", () => {
  let owner: Awaited<ReturnType<typeof createTestUser>>;
  let slug = "";
  let orgId = "";

  beforeEach(async () => {
    owner = await createTestUser("fin-owner");
    const o = await createTestOrg(owner, "fin");
    slug = o.slug; orgId = o.orgId;
    const ctx = await ctxFor(owner, slug, "administer");
    setStripeGatewayForTests(fixtureGateway({ account: fixtureAccount(), customers: [], subscriptions: [], invoices: [] }));
    await settingsService.stripeConnect(ctx, "rk_test_0123456789abcdefABCD", {});
  });
  afterEach(() => resetStripeGateway());

  function world(overrides: Parameters<typeof fixtureGateway>[0]) {
    return { account: fixtureAccount(), customers: [], subscriptions: [], invoices: [], ...overrides };
  }

  it("weekly subscription: stored as 'unsupported' (never month), MRR NOT derived, anomaly recorded", async () => {
    const c = fixtureCustomer(1);
    const weekly = fixtureSubscription(1, c.id, { interval: "unsupported", amountMinor: 1000 });
    setStripeGatewayForTests(fixtureGateway(world({ customers: [c], subscriptions: [weekly] })));
    const ctx = await ctxFor(owner, slug, "administer");
    const res = await syncService.triggerSync(ctx, {});
    // provider identity/state preserved…
    const subs = await withOrgTx(appDb(), orgId, (tx) => tx.select().from(schema.subscriptions));
    expect(subs).toHaveLength(1);
    expect(subs[0]!.interval).toBe("unsupported"); // NOT converted to month
    expect(subs[0]!.amountCents).toBe(1000);
    // …but MRR is NOT derived from it (weekly $10 ≠ $10 MRR, ≠ $40 MRR — it is excluded)
    const [cust] = await withOrgTx(appDb(), orgId, (tx) => tx.select().from(schema.customers));
    expect(Number(cust!.mrrCents)).toBe(0);
    // …and the unsupported value is an explicit anomaly, not a silent pass
    expect(res.summary.subscriptions.anomalies).toBe(1);
  });

  it("mixed month+week customer: MRR counts ONLY the supported monthly sub", async () => {
    const c = fixtureCustomer(1);
    const monthly = fixtureSubscription(1, c.id, { interval: "month", amountMinor: 1900 });
    const weekly = fixtureSubscription(2, c.id, { interval: "unsupported", amountMinor: 1000 });
    setStripeGatewayForTests(fixtureGateway(world({ customers: [c], subscriptions: [monthly, weekly] })));
    const ctx = await ctxFor(owner, slug, "administer");
    const res = await syncService.triggerSync(ctx, {});
    expect(res.summary.subscriptions.anomalies).toBe(1); // exactly the weekly exclusion
    const [cust] = await withOrgTx(appDb(), orgId, (tx) => tx.select().from(schema.customers));
    expect(Number(cust!.mrrCents)).toBe(1900); // month contributes; week does not
  });

  it("missing unit amount: no subscription row, no $0 price, no MRR — anomaly recorded", async () => {
    const c = fixtureCustomer(1);
    const tiered = fixtureSubscription(1, c.id, { amountMinor: null });
    setStripeGatewayForTests(fixtureGateway(world({ customers: [c], subscriptions: [tiered] })));
    const ctx = await ctxFor(owner, slug, "administer");
    const res = await syncService.triggerSync(ctx, {});
    const subs = await withOrgTx(appDb(), orgId, (tx) => tx.select().from(schema.subscriptions));
    expect(subs).toHaveLength(0); // never persisted as a fake $0 recurring price
    expect(res.summary.subscriptions.anomalies).toBe(1);
    expect(res.summary.subscriptions.upserted).toBe(0);
    const [cust] = await withOrgTx(appDb(), orgId, (tx) => tx.select().from(schema.customers));
    expect(Number(cust!.mrrCents)).toBe(0);
  });

  it("missing recurring data: interval is not 'month' in the DB", async () => {
    const c = fixtureCustomer(1);
    const mystery = fixtureSubscription(1, c.id, { interval: "unsupported" });
    setStripeGatewayForTests(fixtureGateway(world({ customers: [c], subscriptions: [mystery] })));
    const ctx = await ctxFor(owner, slug, "administer");
    await syncService.triggerSync(ctx, {});
    const subs = await withOrgTx(appDb(), orgId, (tx) => tx.select().from(schema.subscriptions));
    expect(subs[0]!.interval).toBe("unsupported");
  });

  it("multi-item subscription: first item preserved (documented behavior) + explicit anomaly", async () => {
    const c = fixtureCustomer(1);
    const multi = fixtureSubscription(1, c.id, { amountMinor: 1900, itemCount: 2 });
    setStripeGatewayForTests(fixtureGateway(world({ customers: [c], subscriptions: [multi] })));
    const ctx = await ctxFor(owner, slug, "administer");
    const res = await syncService.triggerSync(ctx, {});
    const subs = await withOrgTx(appDb(), orgId, (tx) => tx.select().from(schema.subscriptions));
    expect(subs).toHaveLength(1); // first item behavior retained
    expect(subs[0]!.amountCents).toBe(1900);
    expect(res.summary.subscriptions.anomalies).toBe(1); // limitation surfaced, not silent
  });

  it("supported values unchanged: month → month MRR ×1, year → year MRR ÷12 (no regression)", async () => {
    const c1 = fixtureCustomer(1);
    const c2 = fixtureCustomer(2);
    setStripeGatewayForTests(fixtureGateway(world({
      customers: [c1, c2],
      subscriptions: [
        fixtureSubscription(1, c1.id, { interval: "month", amountMinor: 1900 }),
        fixtureSubscription(2, c2.id, { interval: "year", amountMinor: 12000 })
      ]
    })));
    const ctx = await ctxFor(owner, slug, "administer");
    const res = await syncService.triggerSync(ctx, {});
    expect(res.summary.subscriptions.anomalies).toBe(0);
    const custs = await withOrgTx(appDb(), orgId, (tx) => tx.select().from(schema.customers));
    const byId = Object.fromEntries(custs.map((c) => [c.stripeCustomerId, c]));
    expect(Number(byId[c1.id]!.mrrCents)).toBe(1900);
    expect(Number(byId[c2.id]!.mrrCents)).toBe(1000);
    const subs = await withOrgTx(appDb(), orgId, (tx) => tx.select().from(schema.subscriptions));
    expect(subs.map((s) => s.interval).sort()).toEqual(["month", "year"]);
  });
});


describe("invoice status truth (final provider-state audit)", () => {
  let owner: Awaited<ReturnType<typeof createTestUser>>;
  let slug = "";
  let orgId = "";

  beforeEach(async () => {
    owner = await createTestUser("inv-owner");
    const o = await createTestOrg(owner, "inv");
    slug = o.slug; orgId = o.orgId;
    const ctx = await ctxFor(owner, slug, "administer");
    setStripeGatewayForTests(fixtureGateway({ account: fixtureAccount(), customers: [], subscriptions: [], invoices: [] }));
    await settingsService.stripeConnect(ctx, "rk_test_0123456789abcdefABCD", {});
  });
  afterEach(() => resetStripeGateway());

  async function syncInvoices(invoices: Array<Record<string, unknown>>) {
    const c = fixtureCustomer(1);
    const list = invoices.map((o, i) => fixtureInvoice(i + 1, c.id, o as never));
    setStripeGatewayForTests(fixtureGateway({ account: fixtureAccount(), customers: [c], subscriptions: [], invoices: list }));
    const ctx = await ctxFor(owner, slug, "administer");
    const res = await syncService.triggerSync(ctx, {});
    const pays = await withOrgTx(appDb(), orgId, (tx) => tx.select().from(schema.payments));
    return { res, pays };
  }

  it("supported mapping: paid→paid, void→void, uncollectible→failed, open+attempted→failed, open→open", async () => {
    const { res, pays } = await syncInvoices([
      { status: "paid" },
      { status: "void" },
      { status: "uncollectible" },
      { status: "open", attempted: true },
      { status: "open", attempted: false }
    ]);
    expect(res.summary.invoices.anomalies).toBe(0);
    expect(res.summary.invoices.upserted).toBe(5);
    const byId = new Map(pays.map((p) => [p.stripeInvoiceId, p]));
    expect(byId.get("in_fixture_001")!.status).toBe("paid");
    expect(byId.get("in_fixture_002")!.status).toBe("void");
    expect(byId.get("in_fixture_003")!.status).toBe("failed"); // uncollectible
    expect(byId.get("in_fixture_003")!.declineCode).toBe("uncollectible");
    expect(byId.get("in_fixture_004")!.status).toBe("failed"); // open + attempted
    expect(byId.get("in_fixture_004")!.declineCode).toBe("open_invoice");
    expect(byId.get("in_fixture_005")!.status).toBe("open"); // open + not attempted
  });

  it("status='draft' is NOT stored as open/paid/failed — anomaly, sync continues safely", async () => {
    const { res, pays } = await syncInvoices([
      { status: "paid" },
      { status: "draft" }
    ]);
    expect(pays).toHaveLength(1); // only the paid invoice persisted
    expect(pays[0]!.status).toBe("paid");
    expect(pays.every((p) => !["open"].includes(p.status) || p.stripeInvoiceId !== "in_fixture_002"));
    expect(res.summary.invoices.anomalies).toBe(1);
    expect(res.summary.invoices.upserted).toBe(1); // sync continued, good records preserved
    expect(res.summary.invoices.status).toBe("ok"); // anomalies are not sync failures
  });

  it("arbitrary future provider status cannot become a known REVESSENT status", async () => {
    const { res, pays } = await syncInvoices([
      { status: "future_provider_state" },
      { status: "scheduled" }
    ]);
    expect(pays).toHaveLength(0);
    for (const p of pays) {
      expect(["paid", "failed", "open", "void", "refunded"]).toContain(p.status);
    }
    expect(res.summary.invoices.anomalies).toBe(2);
    expect(res.summary.invoices.upserted).toBe(0);
  });

  it("missing status ('' from the adapter) remains skipped/anomalous", async () => {
    const { res, pays } = await syncInvoices([{ status: "" }]);
    expect(pays).toHaveLength(0);
    expect(res.summary.invoices.anomalies).toBe(1);
  });

  it("repeat sync after an unsupported invoice resolves: honest update (provider wins)", async () => {
    const c = fixtureCustomer(1);
    const draft = fixtureInvoice(1, c.id, { status: "draft" });
    setStripeGatewayForTests(fixtureGateway({ account: fixtureAccount(), customers: [c], subscriptions: [], invoices: [draft] }));
    let ctx = await ctxFor(owner, slug, "administer");
    const first = await syncService.triggerSync(ctx, {});
    expect(first.summary.invoices.anomalies).toBe(1);
    // the provider finalizes the invoice → now paid
    const paid = { ...draft, status: "paid" as const };
    setStripeGatewayForTests(fixtureGateway({ account: fixtureAccount(), customers: [c], subscriptions: [], invoices: [paid] }));
    ctx = await ctxFor(owner, slug, "administer");
    const second = await syncService.triggerSync(ctx, {});
    expect(second.summary.invoices.anomalies).toBe(0);
    const pays = await withOrgTx(appDb(), orgId, (tx) => tx.select().from(schema.payments));
    expect(pays).toHaveLength(1);
    expect(pays[0]!.status).toBe("paid");
  });
});
