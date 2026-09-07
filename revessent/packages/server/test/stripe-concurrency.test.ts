import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { appDb, settingsService, syncService, ProblemError } from "@revessent/server";
import * as schema from "@revessent/db";
import { withOrgTx } from "@revessent/db";
import { setStripeGatewayForTests, resetStripeGateway } from "@revessent/integrations";
import type { ListOptions, Page, ProviderCustomer, StripeGateway } from "@revessent/integrations";
import {
  fixtureGateway, fixtureAccount, fixtureCustomer
} from "@revessent/integrations/fixtures";
import { createTestOrg, createTestUser, ctxFor } from "./helpers";

/**
 * PHASE 4A FINAL-AUDIT CORRECTION — SYNC SINGLE-FLIGHT + CREDENTIAL LIFECYCLE.
 *
 * The original single-flight was a check-then-act race (SELECT running →
 * proceed). It is now a PostgreSQL SESSION advisory lock on a dedicated
 * connection, keyed per organization. These tests exercise the REAL
 * database primitive (no mocking of the concurrency): concurrent service
 * calls, real pool contention, deliberate fixture-gateway delays to
 * guarantee overlap.
 */
describe("sync single-flight (database-enforced, per-org)", () => {
  let owner: Awaited<ReturnType<typeof createTestUser>>;
  let slug = "";
  let orgId = "";

  beforeEach(async () => {
    owner = await createTestUser("race-owner");
    const o = await createTestOrg(owner, "race");
    slug = o.slug; orgId = o.orgId;
    const ctx = await ctxFor(owner, slug, "administer");
    setStripeGatewayForTests(fixtureGateway({ account: fixtureAccount(), customers: [], subscriptions: [], invoices: [] }));
    await settingsService.stripeConnect(ctx, "rk_test_0123456789abcdefABCD", {});
  });
  afterEach(() => resetStripeGateway());

  /** Fixture gateway with a deliberate delay on listCustomers + call counter. */
  function delayed(worldCustomers: ProviderCustomer[], ms: number, counter: { customers: number }): StripeGateway {
    const gw = fixtureGateway({ account: fixtureAccount(), customers: worldCustomers, subscriptions: [], invoices: [] });
    return {
      ...gw,
      listCustomers: async (key: string, opts?: ListOptions): Promise<Page<ProviderCustomer>> => {
        counter.customers++;
        await new Promise((r) => setTimeout(r, ms));
        return gw.listCustomers(key, opts);
      }
    };
  }

  it("concurrent syncs, same org: exactly one runs, the loser gets 409 conflict and NEVER calls the provider", async () => {
    const customers = [1, 2, 3, 4, 5].map((i) => fixtureCustomer(i));
    const counter = { customers: 0 };
    setStripeGatewayForTests(delayed(customers, 150, counter)); // 3 pages × 150ms ⇒ lock held ≥450ms

    const ctxA = await ctxFor(owner, slug, "administer");
    const ctxB = await ctxFor(owner, slug, "administer");

    const [resA, resB] = await Promise.allSettled([
      syncService.triggerSync(ctxA, {}),
      new Promise((r) => setTimeout(r, 40)).then(() => syncService.triggerSync(ctxB, {}))
    ]);

    // exactly one accepted…
    const fulfilled = [resA, resB].filter((r) => r.status === "fulfilled");
    const rejected = [resA, resB].filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    // …the loser receives a SAFE CONFLICT response (409, "already in progress")
    const err = (rejected[0] as PromiseRejectedResult).reason as ProblemError;
    expect(err).toBeInstanceOf(ProblemError);
    expect(err.problem.status).toBe(409);
    expect(String(err.problem.detail ?? err.message)).toMatch(/already in progress/i);

    // the loser never started provider synchronization: 5 customers at page
    // size 2 = exactly 3 listCustomers calls — a double run would make 6
    expect(counter.customers).toBe(3);

    // exactly one synchronization ran: one sync.started audit for the org
    const started = await withOrgTx(appDb(), orgId, (tx) =>
      tx.select().from(schema.auditLogs)
        .where(and(eq(schema.auditLogs.orgId, orgId), eq(schema.auditLogs.action, "sync.started"))));
    expect(started).toHaveLength(1);

    // no duplicate side effects + sync state finished correctly
    const local = await withOrgTx(appDb(), orgId, (tx) => tx.select().from(schema.customers));
    expect(local).toHaveLength(5);
    const states = await withOrgTx(appDb(), orgId, (tx) => tx.select().from(schema.syncState));
    expect(states.map((s) => s.status).sort()).toEqual(["ok", "ok", "ok"]);
    expect(states.every((s) => s.finishedAt != null && s.lastError == null)).toBe(true);

    // lock released: a subsequent sync after completion succeeds
    setStripeGatewayForTests(fixtureGateway({ account: fixtureAccount(), customers, subscriptions: [], invoices: [] }));
    const again = await syncService.triggerSync(ctxA, {});
    expect(again.summary.customers.status).toBe("ok");
  });

  it("lock is released when a sync FAILS — the organization is never wedged", async () => {
    const customers = [1, 2, 3].map((i) => fixtureCustomer(i));
    const failing = fixtureGateway({
      account: fixtureAccount(), customers, subscriptions: [], invoices: [],
      failures: [{ on: "customers", pageIndex: 0, kind: "rate_limited" }]
    });
    setStripeGatewayForTests(failing);
    const ctx = await ctxFor(owner, slug, "administer");
    const first = await syncService.triggerSync(ctx, {});
    expect(first.summary.customers.status).toBe("failed");

    // immediately after a failed run the lock must be free
    setStripeGatewayForTests(fixtureGateway({ account: fixtureAccount(), customers, subscriptions: [], invoices: [] }));
    const second = await syncService.triggerSync(ctx, {});
    expect(second.summary.customers.status).toBe("ok");
  });

  it("different organizations sync CONCURRENTLY — the lock is per-org, not global", async () => {
    const other = await createTestUser("race-other");
    const o2 = await createTestOrg(other, "race-b");
    const ctxBconnect = await ctxFor(other, o2.slug, "administer");
    await settingsService.stripeConnect(ctxBconnect, "rk_test_ffffffffffffffffffff", {});

    const counter = { customers: 0 };
    const shared = delayed([fixtureCustomer(1), fixtureCustomer(2)], 250, counter);
    setStripeGatewayForTests(shared); // same gateway world for both orgs

    const ctxA = await ctxFor(owner, slug, "administer");
    const ctxB = await ctxFor(other, o2.slug, "administer");
    const [resA, resB] = await Promise.allSettled([
      syncService.triggerSync(ctxA, {}),
      syncService.triggerSync(ctxB, {})
    ]);
    expect(resA.status).toBe("fulfilled");
    expect(resB.status).toBe("fulfilled"); // neither blocked by the other's lock
    // both orgs actually overlapped (4 page calls total: 1+1 pages × 2 orgs… 2 customers = 1 page each ⇒ 2 calls)
    expect(counter.customers).toBe(2);
    // and each org's rows stay isolated
    const rowsA = await withOrgTx(appDb(), orgId, (tx) => tx.select().from(schema.customers));
    const rowsB = await withOrgTx(appDb(), o2.orgId, (tx) => tx.select().from(schema.customers));
    expect(rowsA).toHaveLength(2);
    expect(rowsB).toHaveLength(2);
    expect(rowsA.every((r) => r.orgId === orgId)).toBe(true);
    expect(rowsB.every((r) => r.orgId === o2.orgId)).toBe(true);
  });

  it("a crashed run (orphaned 'running' state) does not wedge the org — next sync cleans up honestly", async () => {
    const customers = [fixtureCustomer(1)];
    // simulate a crashed process: running rows with no lock owner
    await withOrgTx(appDb(), orgId, async (tx) => {
      for (const entity of ["customers", "subscriptions", "invoices"] as const) {
        await tx.insert(schema.syncState).values({
          orgId, entity, status: "running", startedAt: new Date(),
          providerAccount: "acct_TESTACCT0123456789", updatedAt: new Date()
        }).onConflictDoUpdate({
          target: [schema.syncState.orgId, schema.syncState.entity],
          set: { status: "running", startedAt: new Date(), updatedAt: new Date() }
        });
      }
    });
    setStripeGatewayForTests(fixtureGateway({ account: fixtureAccount(), customers, subscriptions: [], invoices: [] }));
    const ctx = await ctxFor(owner, slug, "administer");
    const res = await syncService.triggerSync(ctx, {});
    expect(res.summary.customers.status).toBe("ok"); // proceeded — not blocked by the orphan
    const states = await withOrgTx(appDb(), orgId, (tx) => tx.select().from(schema.syncState));
    expect(states.every((s) => s.status === "ok")).toBe(true);
  });
});

describe("credential lifecycle on revocation (final audit §8)", () => {
  let owner: Awaited<ReturnType<typeof createTestUser>>;
  let slug = "";
  let orgId = "";

  beforeEach(async () => {
    owner = await createTestUser("cred-owner");
    const o = await createTestOrg(owner, "cred");
    slug = o.slug; orgId = o.orgId;
  });
  afterEach(() => resetStripeGateway());

  async function connect(): Promise<void> {
    const ctx = await ctxFor(owner, slug, "administer");
    setStripeGatewayForTests(fixtureGateway({ account: fixtureAccount(), customers: [], subscriptions: [], invoices: [] }));
    await settingsService.stripeConnect(ctx, "rk_test_0123456789abcdefABCD", {});
  }

  it("disconnect DESTROYS the sealed key material; safe metadata retained; sync then refuses", async () => {
    await connect();
    const ctx = await ctxFor(owner, slug, "administer");
    await settingsService.stripeDisconnect(ctx, {});
    const [row] = await withOrgTx(appDb(), orgId, (tx) => tx.select().from(schema.stripeConnections));
    expect(row!.status).toBe("revoked");
    expect(row!.keyCiphertext).toBeNull(); // cryptographically unusable
    expect(row!.keyLast4).toBe("ABCD"); // safe history metadata retained
    expect(row!.stripeAccountId).toBe("acct_TESTACCT0123456789");
    // audit preserved the disconnection with safe metadata only
    const audits = await withOrgTx(appDb(), orgId, (tx) =>
      tx.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "connection.disconnected")));
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits[0]!.diff)).toContain("destroyed");
    expect(JSON.stringify(audits[0]!.diff)).not.toContain("rk_test");

    // a revoked connection CANNOT be used by any sync or provider operation
    await expect(syncService.triggerSync(ctx, {}))
      .rejects.toMatchObject({ problem: { status: 409 } });

    // reconnection rotates in fresh material and works again
    setStripeGatewayForTests(fixtureGateway({ account: fixtureAccount(), customers: [fixtureCustomer(1)], subscriptions: [], invoices: [] }));
    const conn = await settingsService.stripeConnect(ctx, "rk_test_ffffffffffffffffffff", {});
    expect(conn.status).toBe("read_only");
    const res = await syncService.triggerSync(ctx, {});
    expect(res.summary.customers.status).toBe("ok");
  });

  it("provider-side revocation during sync: connection marked revoked, credential destroyed, audited, unusable", async () => {
    await connect();
    const ctx = await ctxFor(owner, slug, "administer");
    setStripeGatewayForTests(fixtureGateway({
      account: fixtureAccount(), customers: [fixtureCustomer(1)], subscriptions: [], invoices: [],
      failures: [{ on: "customers", pageIndex: 0, kind: "revoked" }]
    }));
    const res = await syncService.triggerSync(ctx, {});
    expect(res.summary.customers.status).toBe("failed");
    expect(res.summary.customers.errorCode).toBe("revoked");

    // Stripe is the authority: the connection is now revoked and the sealed
    // credential is destroyed — no future provider operation can use it.
    const [row] = await withOrgTx(appDb(), orgId, (tx) => tx.select().from(schema.stripeConnections));
    expect(row!.status).toBe("revoked");
    expect(row!.keyCiphertext).toBeNull();
    const audits = await withOrgTx(appDb(), orgId, (tx) =>
      tx.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, "credential.revoked")));
    expect(audits).toHaveLength(1);
    expect(JSON.stringify(audits[0]!.diff)).not.toContain("rk_test");

    // and the revoked connection cannot sync again
    await expect(syncService.triggerSync(ctx, {}))
      .rejects.toMatchObject({ problem: { status: 409 } });
  });
});
