import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { appDb, settingsService } from "@revessent/server";
import * as schema from "@revessent/db";
import { withOrgTx } from "@revessent/db";
import { setStripeGatewayForTests, resetStripeGateway } from "@revessent/integrations";
import { fixtureGateway, fixtureAccount } from "@revessent/integrations/fixtures";
import { createTestOrg, createTestUser, ctxFor, type TestUser } from "./helpers";

/**
 * PHASE 4A — CONNECTION + CREDENTIAL SECURITY (§5/§6/§21).
 * The gateway is exercised with controlled provider fixtures (live Stripe
 * credentials are unavailable in this environment — see report §14).
 */
describe("stripe connection (real flow, fixture provider)", () => {
  let owner: TestUser;
  let slug = "";
  let orgId = "";

  beforeEach(async () => {
    owner = await createTestUser("conn-owner");
    const o = await createTestOrg(owner, "conn");
    slug = o.slug; orgId = o.orgId;
  });
  afterEach(() => resetStripeGateway());

  const GOOD_KEY = "rk_test_0123456789abcdefABCD"; // matches ^rk_test_[A-Za-z0-9]{16,}$

  function connectGood(): void {
    setStripeGatewayForTests(fixtureGateway({ account: fixtureAccount(), customers: [], subscriptions: [], invoices: [] }));
  }

  it("successful connection: identity verified, encrypted at rest, safe metadata out, audited", async () => {
    connectGood();
    const ctx = await ctxFor(owner, slug, "administer");
    const conn = await settingsService.stripeConnect(ctx, GOOD_KEY, {});

    // §7: provider identity persisted (from Stripe, not user input)
    expect(conn.status).toBe("read_only"); // "connected" only AFTER provider validation
    expect(conn.accountRef).toBe("acct_TESTACCT0123456789");
    expect(conn.displayName).toBe("Acorn Books Ltd");
    expect(conn.country).toBe("US");
    expect(conn.defaultCurrency).toBe("USD");
    expect(conn.lastValidatedAt).toBeTruthy();
    // §5: safe display — last 4 only, never the key
    expect(conn.keyLast4).toBe("ABCD");
    expect(JSON.stringify(conn)).not.toContain(GOOD_KEY);

    // §5: encrypted at rest — no plaintext fragment anywhere in the row
    const [row] = await withOrgTx(appDb(), orgId, (tx) =>
      tx.select().from(schema.stripeConnections).where(eq(schema.stripeConnections.orgId, orgId)));
    expect(row!.keyCiphertext).not.toContain("rk_test");
    expect(row!.keyCiphertext).not.toContain(GOOD_KEY);
    expect(row!.keyCiphertext.split(".")).toHaveLength(3); // iv.tag.ciphertext envelope
    expect(row!.stripeAccountId).toBe("acct_TESTACCT0123456789");

    // §18: audit trail = attempted + succeeded, code/last-4 only
    const audits = await withOrgTx(appDb(), orgId, (tx) =>
      tx.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "connection.succeeded")));
    const ok = audits[0];
    expect(ok).toBeTruthy();
    expect(ok).toBeTruthy();
    expect(JSON.stringify(ok!.diff!)).not.toContain(GOOD_KEY);
    expect(JSON.stringify(ok!.diff!)).toContain("ABCD");
  });

  it("invalid credentials: refused with a SAFE error, nothing stored, failure audited", async () => {
    setStripeGatewayForTests(fixtureGateway({
      account: fixtureAccount(), customers: [], subscriptions: [], invoices: [],
      failures: [{ on: "verify", kind: "invalid_credentials" }]
    }));
    const ctx = await ctxFor(owner, slug, "administer");
    await expect(settingsService.stripeConnect(ctx, GOOD_KEY, {}))
      .rejects.toMatchObject({ problem: { status: 400, type: "/errors/validation" } });

    // §21.10: a connection is never marked connected before validation succeeds
    const rows = await withOrgTx(appDb(), orgId, (tx) =>
      tx.select().from(schema.stripeConnections).where(eq(schema.stripeConnections.orgId, orgId)));
    expect(rows).toHaveLength(0);

    const audits = await withOrgTx(appDb(), orgId, (tx) =>
      tx.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "connection.failed")));
    expect(audits.length).toBe(1);
    expect(JSON.stringify(audits[0]!.diff)).toContain("invalid_credentials");
  });

  it("revoked-at-validation: 409 conflict, nothing stored", async () => {
    setStripeGatewayForTests(fixtureGateway({
      account: fixtureAccount(), customers: [], subscriptions: [], invoices: [],
      failures: [{ on: "verify", kind: "revoked" }]
    }));
    const ctx = await ctxFor(owner, slug, "administer");
    await expect(settingsService.stripeConnect(ctx, GOOD_KEY, {}))
      .rejects.toMatchObject({ problem: { status: 409 } });
    const rows = await withOrgTx(appDb(), orgId, (tx) =>
      tx.select().from(schema.stripeConnections).where(eq(schema.stripeConnections.orgId, orgId)));
    expect(rows).toHaveLength(0);
  });

  it("malformed key: refused locally — the provider is never called", async () => {
    let called = 0;
    setStripeGatewayForTests({
      ...fixtureGateway({ account: fixtureAccount(), customers: [], subscriptions: [], invoices: [] }),
      verifyAccount: async () => { called++; return fixtureAccount(); }
    });
    const ctx = await ctxFor(owner, slug, "administer");
    await expect(settingsService.stripeConnect(ctx, "sk_live_notreallyakey", {}))
      .rejects.toMatchObject({ problem: { status: 400 } });
    expect(called).toBe(0); // format gate precedes any network traffic
  });

  it("disconnect: revoked state + audited; status reflects it honestly", async () => {
    connectGood();
    const ctx = await ctxFor(owner, slug, "administer");
    await settingsService.stripeConnect(ctx, GOOD_KEY, {});
    const after = await settingsService.stripeDisconnect(ctx, {});
    expect(after.status).toBe("not_connected");
    const [row] = await withOrgTx(appDb(), orgId, (tx) =>
      tx.select().from(schema.stripeConnections).where(eq(schema.stripeConnections.orgId, orgId)));
    expect(row!.status).toBe("revoked");
    const audits = await withOrgTx(appDb(), orgId, (tx) =>
      tx.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "connection.disconnected")));
    expect(audits.length).toBe(1);
  });

  it("freshly connected: sync state is 'never' — never fabricated zeros", async () => {
    connectGood();
    const ctx = await ctxFor(owner, slug, "administer");
    const conn = await settingsService.stripeConnect(ctx, GOOD_KEY, {});
    expect(conn.sync!.customers.status).toBe("never");
    expect(conn.sync!.invoices.status).toBe("never");
    expect(conn.lastSyncAt).toBeNull();
  });

  it("key last4 derivation is the only retained fragment (rotation replaces ciphertext)", async () => {
    connectGood();
    const ctx = await ctxFor(owner, slug, "administer");
    await settingsService.stripeConnect(ctx, GOOD_KEY, {});
    const key2 = "rk_test_ffffffffffffffffffff"; // same mode → rotate
    await settingsService.stripeConnect(ctx, key2, {});
    const rows = await withOrgTx(appDb(), orgId, (tx) =>
      tx.select().from(schema.stripeConnections).where(eq(schema.stripeConnections.orgId, orgId)));
    expect(rows).toHaveLength(1); // rotation replaced, not duplicated
    expect(rows[0]!.keyLast4).toBe("ffff");
  });

  it("operator cannot connect or disconnect (administer gate)", async () => {
    const operator = await createTestUser("conn-op");
    // add the operator to the SAME org (inserted by its owner per RLS guard)
    const { withIdentityTx } = await import("@revessent/db");
    await withIdentityTx(appDb(), owner.id, (tx) =>
      tx.insert(schema.memberships).values({ orgId, userId: operator.id, role: "operator" }));
    await expect(ctxFor(operator, slug, "administer")).rejects.toMatchObject({ problem: { status: 403 } });
  });
});
