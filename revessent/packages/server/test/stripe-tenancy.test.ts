import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { appDb, settingsService, syncService } from "@revessent/server";
import * as schema from "@revessent/db";
import { withOrgTx } from "@revessent/db";
import { setStripeGatewayForTests, resetStripeGateway } from "@revessent/integrations";
import { fixtureGateway, fixtureAccount, fixtureCustomer } from "@revessent/integrations/fixtures";
import { createTestOrg, createTestUser, ctxFor } from "./helpers";

/**
 * PHASE 4A — TENANCY (§11). Stripe surfaces are org-scoped end to end:
 * connections, sync state and synced records never cross workspaces —
 * verified at BOTH the query layer (org_id predicates) and RLS.
 */
describe("stripe tenancy isolation (fixture provider)", () => {
  let aOwner: Awaited<ReturnType<typeof createTestUser>>;
  let bOwner: Awaited<ReturnType<typeof createTestUser>>;
  let a = ""; let b = "";
  let aOrgId = ""; let bOrgId = "";

  beforeEach(async () => {
    aOwner = await createTestUser("ten-a");
    bOwner = await createTestUser("ten-b");
    const oa = await createTestOrg(aOwner, "tenancy-a");
    const ob = await createTestOrg(bOwner, "tenancy-b");
    a = oa.slug; b = ob.slug; aOrgId = oa.orgId; bOrgId = ob.orgId;
  });
  afterEach(() => resetStripeGateway());

  async function connectBoth(): Promise<void> {
    const acctA = fixtureAccount({ id: "acct_ORG_A_00000000000", displayName: "Org A Books" });
    const acctB = fixtureAccount({ id: "acct_ORG_B_00000000000", displayName: "Org B Books" });
    const ctxA = await ctxFor(aOwner, a, "administer");
    const ctxB = await ctxFor(bOwner, b, "administer");
    setStripeGatewayForTests(fixtureGateway({ account: acctA, customers: [], subscriptions: [], invoices: [] }));
    await settingsService.stripeConnect(ctxA, "rk_test_0123456789abcdefABCD", {});
    setStripeGatewayForTests(fixtureGateway({ account: acctB, customers: [], subscriptions: [], invoices: [] }));
    await settingsService.stripeConnect(ctxB, "rk_test_ffffffffffffffffffff", {});
  }

  it("connections are per-org: each org sees only its own provider account", async () => {
    await connectBoth();
    const ctxA = await ctxFor(aOwner, a, "administer");
    const ctxB = await ctxFor(bOwner, b, "administer");
    const connA = await settingsService.stripeConnection(ctxA);
    const connB = await settingsService.stripeConnection(ctxB);
    expect(connA.accountRef).toBe("acct_ORG_A_00000000000");
    expect(connB.accountRef).toBe("acct_ORG_B_00000000000");
  });

  it("exactly one stripe_connections row per org — org B's key never touches org A's row", async () => {
    await connectBoth();
    const rowsA = await withOrgTx(appDb(), aOrgId, (tx) =>
      tx.select().from(schema.stripeConnections));
    const rowsB = await withOrgTx(appDb(), bOrgId, (tx) =>
      tx.select().from(schema.stripeConnections));
    expect(rowsA).toHaveLength(1);
    expect(rowsB).toHaveLength(1);
    expect(rowsA[0]!.stripeAccountId).toBe("acct_ORG_A_00000000000");
    expect(rowsB[0]!.stripeAccountId).toBe("acct_ORG_B_00000000000");
  });

  it("synced records never cross orgs: A's customers invisible to B at the query layer", async () => {
    const acctA = fixtureAccount({ id: "acct_ORG_A_00000000000" });
    const ctxA = await ctxFor(aOwner, a, "administer");
    setStripeGatewayForTests(fixtureGateway({
      account: acctA,
      customers: [fixtureCustomer(1), fixtureCustomer(2)],
      subscriptions: [], invoices: []
    }));
    await settingsService.stripeConnect(ctxA, "rk_test_0123456789abcdefABCD", {});
    await syncService.triggerSync(ctxA, {});

    // org B connects + syncs with DIFFERENT provider data
    const ctxB = await ctxFor(bOwner, b, "administer");
    setStripeGatewayForTests(fixtureGateway({
      account: fixtureAccount({ id: "acct_ORG_B_00000000000" }),
      customers: [fixtureCustomer(7)],
      subscriptions: [], invoices: []
    }));
    await settingsService.stripeConnect(ctxB, "rk_test_ffffffffffffffffffff", {});
    await syncService.triggerSync(ctxB, {});

    const seenA = await withOrgTx(appDb(), aOrgId, (tx) => tx.select().from(schema.customers));
    const seenB = await withOrgTx(appDb(), bOrgId, (tx) => tx.select().from(schema.customers));
    expect(seenA.map((c) => c.stripeCustomerId).sort()).toEqual(["cus_fixture_001", "cus_fixture_002"]);
    expect(seenB.map((c) => c.stripeCustomerId)).toEqual(["cus_fixture_007"]);
    // every row is stamped with exactly one org — no bleed
    for (const row of [...seenA, ...seenB]) {
      expect([aOrgId, bOrgId]).toContain(row.orgId);
    }
  });

  it("RLS holds for stripe tables: org B's tx cannot read or mutate org A's connection/sync state", async () => {
    await connectBoth();
    // inside org B's RLS transaction, org A's stripe rows do not exist
    const bConnRows = await withOrgTx(appDb(), bOrgId, (tx) =>
      tx.select().from(schema.stripeConnections).where(eq(schema.stripeConnections.stripeAccountId, "acct_ORG_A_00000000000")));
    expect(bConnRows).toHaveLength(0);
    const bSyncRows = await withOrgTx(appDb(), bOrgId, (tx) =>
      tx.select().from(schema.syncState).where(eq(schema.syncState.orgId, aOrgId)));
    expect(bSyncRows).toHaveLength(0);
    // B cannot UPDATE A's connection even by direct id
    const [aRow] = await withOrgTx(appDb(), aOrgId, (tx) => tx.select().from(schema.stripeConnections));
    const bUpdate = await withOrgTx(appDb(), bOrgId, (tx) =>
      tx.update(schema.stripeConnections).set({ status: "revoked" }).where(eq(schema.stripeConnections.id, aRow!.id)).returning());
    expect(bUpdate).toHaveLength(0); // RLS silently excludes the foreign row
    const after = await withOrgTx(appDb(), aOrgId, (tx) =>
      tx.select().from(schema.stripeConnections).where(eq(schema.stripeConnections.id, aRow!.id)));
    expect(after[0]!.status).toBe("active"); // untouched
  });

  it("concurrent-equivalent syncs stamp rows with the triggering org only — no cross-org writes", async () => {
    await connectBoth();
    const ctxA = await ctxFor(aOwner, a, "administer");
    const ctxB = await ctxFor(bOwner, b, "administer");
    // shared provider fixture: both orgs see the SAME provider objects
    setStripeGatewayForTests(fixtureGateway({
      account: fixtureAccount({ id: "acct_ORG_A_00000000000" }),
      customers: [fixtureCustomer(1), fixtureCustomer(2)], subscriptions: [], invoices: []
    }));
    await syncService.triggerSync(ctxA, {});
    await syncService.triggerSync(ctxB, {});
    // every synced row belongs wholly to the org that triggered its sync
    const aRows = await withOrgTx(appDb(), aOrgId, (tx) => tx.select().from(schema.customers));
    const bRows = await withOrgTx(appDb(), bOrgId, (tx) => tx.select().from(schema.customers));
    expect(aRows).toHaveLength(2);
    expect(bRows).toHaveLength(2);
    expect(aRows.every((r) => r.orgId === aOrgId)).toBe(true);
    expect(bRows.every((r) => r.orgId === bOrgId)).toBe(true);
    // separate local ids: B's rows are distinct DB entities, not A's rows
    expect(aRows.map((r) => r.id).sort()).not.toEqual(bRows.map((r) => r.id).sort());
  });
});
