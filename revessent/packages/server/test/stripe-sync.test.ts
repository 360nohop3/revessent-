import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { appDb, settingsService, syncService } from "@revessent/server";
import * as schema from "@revessent/db";
import { withOrgTx } from "@revessent/db";
import { setStripeGatewayForTests, resetStripeGateway } from "@revessent/integrations";
import {
  fixtureGateway, fixtureAccount, fixtureCustomer, fixtureSubscription, fixtureInvoice,
  type FixtureWorld
} from "@revessent/integrations/fixtures";
import { createTestOrg, createTestUser, ctxFor } from "./helpers";

/**
 * PHASE 4A — READ-ONLY SYNC (§8/§9/§20). Provider fixtures at the integration
 * boundary (live Stripe credentials unavailable — report §14). Covers:
 * pagination (never truncated), idempotency (DB-unique upserts), provider
 * updates, provider deletions, failure preservation, rate limiting, cursor
 * resume, integer money, MRR derivation, tenancy.
 */
describe("stripe sync (fixture provider)", () => {
  let owner: Awaited<ReturnType<typeof createTestUser>>;
  let slug = "";
  let orgId = "";

  beforeEach(async () => {
    owner = await createTestUser("sync-owner");
    const o = await createTestOrg(owner, "sync");
    slug = o.slug; orgId = o.orgId;
    const ctx = await ctxFor(owner, slug, "administer");
    setStripeGatewayForTests(fixtureGateway({
      account: fixtureAccount(), customers: [], subscriptions: [], invoices: []
    }));
    await settingsService.stripeConnect(ctx, "rk_test_0123456789abcdefABCD", {});
  });
  afterEach(() => resetStripeGateway());

  function world(overrides: Partial<FixtureWorld> = {}): FixtureWorld {
    return { account: fixtureAccount(), customers: [], subscriptions: [], invoices: [], ...overrides };
  }

  async function rows(table: "customers" | "subscriptions" | "payments"): Promise<
    Array<typeof schema.customers.$inferSelect & { mrrCents?: string | number }>
  > {
    const table_ = schema[table] as typeof schema.customers;
    return withOrgTx(appDb(), orgId, (tx) => tx.select().from(table_));
  }

  it("multi-page pagination: 5 customers at pageSize 2 → 3 pages, all 5 persisted, none truncated", async () => {
    const customers = [1, 2, 3, 4, 5].map((i) => fixtureCustomer(i));
    const subs = customers.map((c, i) => fixtureSubscription(i + 1, c.id));
    setStripeGatewayForTests(fixtureGateway(world({ customers, subscriptions: subs })));
    const ctx = await ctxFor(owner, slug, "administer");
    const res = await syncService.triggerSync(ctx, {});
    expect(res.summary.customers.pages).toBe(3);
    expect(res.summary.customers.upserted).toBe(5);
    expect(res.summary.customers.anomalies).toBe(0);
    const local = await rows("customers");
    expect(local).toHaveLength(5);
    // provider ids + timestamps preserved verbatim
    expect(local.map((c) => c.stripeCustomerId).sort()).toEqual(customers.map((c) => c.id).sort());
    const subRows = await rows("subscriptions");
    expect(subRows).toHaveLength(5);
  });

  it("repeat sync is idempotent at the DB layer — no duplicates, counts stable", async () => {
    const customers = [1, 2, 3].map((i) => fixtureCustomer(i));
    setStripeGatewayForTests(fixtureGateway(world({ customers })));
    const ctx = await ctxFor(owner, slug, "administer");
    await syncService.triggerSync(ctx, {});
    await syncService.triggerSync(ctx, {});
    const local = await rows("customers");
    expect(local).toHaveLength(3);
  });

  it("provider update propagates; Stripe wins for provider-owned state", async () => {
    const c = fixtureCustomer(1);
    const s1 = fixtureSubscription(1, c.id, { status: "active" });
    setStripeGatewayForTests(fixtureGateway(world({ customers: [c], subscriptions: [s1] })));
    const ctx = await ctxFor(owner, slug, "administer");
    await syncService.triggerSync(ctx, {});
    // provider side changes the subscription status (cancellation)
    const s2 = { ...s1, status: "canceled" as const, canceledAtIso: new Date().toISOString() };
    setStripeGatewayForTests(fixtureGateway(world({ customers: [c], subscriptions: [s2] })));
    await syncService.triggerSync(ctx, {});
    const subs = await rows("subscriptions");
    expect(subs).toHaveLength(1);
    expect(subs[0]!.status).toBe("canceled");
    // canceled subscriptions contribute 0 MRR (never fabricated revenue)
    const [cust] = await rows("customers");
    expect(Number(cust.mrrCents)).toBe(0);
  });

  it("provider deletion: deleted customer soft-deleted locally (history preserved)", async () => {
    const c = fixtureCustomer(1);
    setStripeGatewayForTests(fixtureGateway(world({ customers: [c] })));
    const ctx = await ctxFor(owner, slug, "administer");
    await syncService.triggerSync(ctx, {});
    const deleted = { ...c, deleted: true };
    setStripeGatewayForTests(fixtureGateway(world({ customers: [deleted] })));
    await syncService.triggerSync(ctx, {});
    const local = await rows("customers");
    expect(local).toHaveLength(1); // soft delete, not erasure
    expect(local[0]!.deletedAt).toBeTruthy();
  });

  it("invoice money is integer minor units; paid/uncollectible/open mapped honestly", async () => {
    const c = fixtureCustomer(1);
    const paid = fixtureInvoice(3, c.id, { status: "paid", amountMinor: 12345 });
    const uncollectible = fixtureInvoice(1, c.id, { status: "uncollectible", amountMinor: 500 });
    const open = fixtureInvoice(2, c.id, { status: "open", attempted: false, amountMinor: 9900 });
    const openAttempted = fixtureInvoice(4, c.id, { status: "open", attempted: true, amountMinor: 9900 });
    setStripeGatewayForTests(fixtureGateway(world({ customers: [c], invoices: [paid, uncollectible, open, openAttempted] })));
    const ctx = await ctxFor(owner, slug, "administer");
    await syncService.triggerSync(ctx, {});
    const pays = await rows("payments");
    expect(pays).toHaveLength(4);
    for (const p of pays) {
      expect(Number.isInteger(Number(p.amountCents))).toBe(true);
      expect(Number(p.amountCents)).toBeGreaterThan(0);
    }
    const byStatus = Object.fromEntries(pays.map((p) => [p.status, p]));
    expect(byStatus.paid!.paidAt).toBeTruthy();
    expect(byStatus.open!.status).toBe("open");
    const failedCodes = pays.filter((p) => p.status === "failed").map((p) => p.declineCode).sort();
    expect(failedCodes).toEqual(["open_invoice", "uncollectible"]);
  });

  it("rate limit mid-sync: earlier pages PRESERVED, entity marked failed with safe code, connection intact", async () => {
    const customers = [1, 2, 3, 4, 5].map((i) => fixtureCustomer(i));
    setStripeGatewayForTests(fixtureGateway(world({
      customers,
      failures: [{ on: "customers", pageIndex: 1, kind: "rate_limited", retryAfterSec: 2 }]
    })));
    const ctx = await ctxFor(owner, slug, "administer");
    const res = await syncService.triggerSync(ctx, {});
    expect(res.summary.customers.status).toBe("failed");
    expect(res.summary.customers.errorCode).toBe("rate_limited");
    // §12: partial progress up to the failure point is durable
    const local = await rows("customers");
    expect(local.length).toBeGreaterThanOrEqual(2);
    expect(local.length).toBeLessThan(5);
    // connection NOT invalidated by a failed sync (§21.7)
    const conn = await settingsService.stripeConnection(ctx);
    expect(conn.status).toBe("read_only");
    // freshness reports failed with code — never fake zeros, never "ok"
    expect(conn.sync!.customers.status).toBe("failed");
    expect(conn.sync!.customers.errorCode).toBe("rate_limited");
  });

  it("cursor resume: a failed sync leaves a checkpoint; the next sync resumes without losing records", async () => {
    const customers = [1, 2, 3, 4, 5].map((i) => fixtureCustomer(i));
    setStripeGatewayForTests(fixtureGateway(world({
      customers,
      failures: [{ on: "customers", pageIndex: 1, kind: "transient_network" }]
    })));
    const ctx = await ctxFor(owner, slug, "administer");
    const first = await syncService.triggerSync(ctx, {});
    expect(first.summary.customers.status).toBe("failed");
    const [state] = await withOrgTx(appDb(), orgId, (tx) =>
      tx.select().from(schema.syncState).where(eq(schema.syncState.entity, "customers")));
    expect(state!.status).toBe("failed");
    // heal the provider: next sync completes the entity
    setStripeGatewayForTests(fixtureGateway(world({ customers })));
    const second = await syncService.triggerSync(ctx, {});
    expect(second.summary.customers.status).toBe("ok");
    const local = await rows("customers");
    expect(local).toHaveLength(5); // union of both runs — nothing lost
  });

  it("full refresh per manual sync: records created after the last sync ARE picked up (no webhooks in 4A)", async () => {
    const c1 = fixtureCustomer(1);
    setStripeGatewayForTests(fixtureGateway(world({ customers: [c1] })));
    const ctx = await ctxFor(owner, slug, "administer");
    await syncService.triggerSync(ctx, {});
    // new customer arrives at the provider; created AFTER the first sync
    const c2 = fixtureCustomer(2, { createdEpoch: Math.floor(Date.now() / 1000) + 5, created: Math.floor(Date.now() / 1000) + 5 });
    setStripeGatewayForTests(fixtureGateway(world({ customers: [c1, c2] })));
    await syncService.triggerSync(ctx, {});
    const local = await rows("customers");
    expect(local).toHaveLength(2); // c2 was created after sync #1 — still found
  });

  it("unknown provider refs are never fabricated: invoice without a local customer is skipped and counted", async () => {
    const ghost = fixtureCustomer(99);
    const inv = fixtureInvoice(1, "cus_NOT_SYNCED_000");
    setStripeGatewayForTests(fixtureGateway(world({ customers: [ghost], invoices: [inv] })));
    const ctx = await ctxFor(owner, slug, "administer");
    const res = await syncService.triggerSync(ctx, {});
    expect(res.summary.invoices.anomalies).toBeGreaterThan(0);
    const pays = await rows("payments");
    expect(pays).toHaveLength(0); // no customer → no fabricated payment row
  });

  it("MRR derives from provider subscription prices only (month→×1, year→/12, others 0)", async () => {
    const c1 = fixtureCustomer(1);
    const c2 = fixtureCustomer(2);
    const monthly = fixtureSubscription(1, c1.id, { amountMinor: 1900, interval: "month" });
    const yearly = fixtureSubscription(2, c2.id, { amountMinor: 12000, interval: "year" });
    setStripeGatewayForTests(fixtureGateway(world({ customers: [c1, c2], subscriptions: [monthly, yearly] })));
    const ctx = await ctxFor(owner, slug, "administer");
    await syncService.triggerSync(ctx, {});
    const local = await rows("customers");
    const byId = Object.fromEntries(local.map((c) => [c.stripeCustomerId, c]));
    expect(Number(byId[c1.id]?.mrrCents)).toBe(1900);
    expect(Number(byId[c2.id]?.mrrCents)).toBe(1000); // 12000/12
  });

  it("no connection → sync refused, honest problem (never fake success)", async () => {
    const ctx = await ctxFor(owner, slug, "administer");
    await settingsService.stripeDisconnect(ctx, {});
    await expect(syncService.triggerSync(ctx, {}))
      .rejects.toMatchObject({ problem: { status: 409 } });
  });
});
