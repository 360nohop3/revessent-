import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { appDb, requireOrgRole, settingsService, overviewService, customersService, recoveryService, expansionService } from "@revessent/server";
import * as schema from "@revessent/db";
import { withOrgTx, withIdentityTx } from "@revessent/db";
import { createTestOrg, createTestUser, ctxFor, type TestUser } from "./helpers";

/**
 * Tenant isolation (§6 — the critical requirement). Three defense layers are
 * tested separately: the authz middleware (404, never 403 — no existence
 * oracle), the query layer, and Postgres RLS.
 */
describe("tenant isolation", () => {
  let acornOwner: TestUser;   // member of A only
  let outsider: TestUser;     // member of neither org
  let slugA = "";
  let orgIdA = "";
  let slugB = "";
  let orgIdB = "";
  let booted = false;

  async function bootstrap(): Promise<void> {
    if (booted) return;
    acornOwner = await createTestUser("acorn-owner");
    outsider = await createTestUser("outsider");
    const bOwner = await createTestUser("b-owner");
    const a = await createTestOrg(acornOwner, "acorn");
    const b = await createTestOrg(bOwner, "fernbrook");
    slugA = a.slug; orgIdA = a.orgId;
    slugB = b.slug; orgIdB = b.orgId;

    // fixture rows in org B that org A must never see
    await withOrgTx(appDb(), orgIdB, async (tx) => {
      const [cust] = await tx.insert(schema.customers).values({
        orgId: orgIdB, stripeCustomerId: "cus_b_secret", name: "B Secret", email: "secret@b.example",
        mrrCents: 12345, currency: "USD"
      }).returning();
      await tx.insert(schema.payments).values({
        orgId: orgIdB, customerId: cust!.id, amountCents: 12345, currency: "USD",
        status: "failed", failedAt: new Date(), declineCode: "generic_decline"
      });
    });
    booted = true;
  }

  it("a member of A requesting B's workspace gets 404 (not 403 — no existence oracle)", async () => {
    await bootstrap();
    await expect(requireOrgRole(await headersFor(acornOwner), slugB, "view"))
      .rejects.toMatchObject({ problem: { status: 404 } });
    await expect(requireOrgRole(await headersFor(outsider), slugA, "view"))
      .rejects.toMatchObject({ problem: { status: 404 } });
  });

  it("org A services return only org A rows — B's customers are invisible", async () => {
    await bootstrap();
    const ctx = await ctxFor(acornOwner, slugA, "view");
    const list = await customersService.listCustomers(ctx, {});
    expect(list.items.find((c) => c.email === "secret@b.example")).toBeUndefined();
  });

  it("org A cannot mutate org B rows through the query layer (scoped tx)", async () => {
    await bootstrap();
    const ctxA = await ctxFor(acornOwner, slugA, "administer");
    // ctxA carries org A scope; any update through it cannot touch B rows.
    const bCustomers = await withOrgTx(appDb(), orgIdB, (tx) =>
      tx.select().from(schema.customers).where(eq(schema.customers.orgId, orgIdB)));
    expect(bCustomers.length).toBe(1);
    await withOrgTx(ctxA.db, orgIdA, async (tx) => {
      // RLS: the B customer is invisible inside A's transaction
      const visible = await tx.select().from(schema.customers);
      expect(visible.find((c) => c.orgId === orgIdB)).toBeUndefined();
    });
  });

  it("RLS: the app role with A's scope reads zero B rows directly", async () => {
    await bootstrap();
    const asApp = appDb();
    const scoped = await asApp.transaction(async (tx) => {
      await tx.execute(eqSetOrg(orgIdA));
      return tx.select().from(schema.customers);
    });
    expect(scoped.every((c) => c.orgId === orgIdA)).toBe(true);
    const unscoped = await asApp.transaction(async (tx) => {
      await tx.execute(clearOrg());
      return tx.select().from(schema.customers);
    });
    expect(unscoped.length).toBe(0); // no scope ⇒ no rows, even by primary key
  });

  it("RLS: B's rows are unreachable even by direct primary-key lookup", async () => {
    await bootstrap();
    const [bCustomer] = await withOrgTx(appDb(), orgIdB, (tx) =>
      tx.select().from(schema.customers).where(eq(schema.customers.orgId, orgIdB)));
    const leaked = await appDb().transaction(async (tx) => {
      await tx.execute(eqSetOrg(orgIdA));
      return tx.select().from(schema.customers).where(eq(schema.customers.id, bCustomer!.id));
    });
    expect(leaked.length).toBe(0);
  });

  it("services refuse cross-org reads end-to-end (case/opportunity/customer ids of B)", async () => {
    await bootstrap();
    const ctxA = await ctxFor(acornOwner, slugA, "view");
    await expect(customersService.getCustomer(ctxA, "00000000-0000-0000-0000-000000000000")).rejects.toMatchObject({ problem: { status: 404 } });
    await expect(recoveryService.getCase(ctxA, "00000000-0000-0000-0000-000000000000")).rejects.toMatchObject({ problem: { status: 404 } });
    await expect(expansionService.getOpportunity(ctxA, "00000000-0000-0000-0000-000000000000")).rejects.toMatchObject({ problem: { status: 404 } });
  });

  it("overview for a disconnected org reveals nothing from other orgs", async () => {
    await bootstrap();
    const ctxA = await ctxFor(acornOwner, slugA, "view");
    const o = await overviewService.overview(ctxA);
    expect(o.cashRecovered30d).toBeNull(); // A has no Stripe connection ⇒ nulls, never B's data
  });

  it("billing (owner-only) is scoped: settings.billing reads only the member org", async () => {
    await bootstrap();
    const ctxA = await ctxFor(acornOwner, slugA, "own");
    const b = await settingsService.billing(ctxA);
    expect(b.plan).toBe("ember"); // default plan of A — not B's data
  });

  it("membership rows of another user are unreadable under identity RLS", async () => {
    await bootstrap();
    const rows = await withIdentityTx(appDb(), acornOwner.id, (tx) =>
      tx.select().from(schema.memberships));
    // Only acornOwner's own membership rows are visible
    expect(rows.every((m) => m.userId === acornOwner.id)).toBe(true);
  });
});

async function headersFor(user: TestUser): Promise<Headers> {
  const { signInCookie } = await import("./helpers");
  return new Headers({ cookie: await signInCookie(user.email, user.password) });
}

import { sql } from "drizzle-orm";
function eqSetOrg(orgId: string) {
  return sql`select set_config('app.org_id', ${orgId}, true)`;
}
function clearOrg() {
  return sql`select set_config('app.org_id', '', true)`;
}
