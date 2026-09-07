/**
 * PHASE 4B CORRECTION — WEBHOOK ENDPOINT LIFECYCLE CONSISTENCY.
 *
 * The Stripe endpoint lifecycle and the PostgreSQL lifecycle cannot share a
 * transaction. These tests prove the correction's invariants:
 *   Connect    — a created provider endpoint can never become permanently
 *                unknown (compensation or durable orphan record);
 *   Reconnect  — a failed replacement can never silently destroy the last
 *                usable local connection;
 *   Disconnect — provider/local mismatches are recoverable + observable and
 *                never reported as a clean success when cleanup failed;
 *   Secrets    — no failure exposes or logs the API key or signing secret.
 *
 * Local-finalization failures are injected with a REAL database trigger
 * (superuser, test-only) so the failure paths exercise genuine DB errors.
 * Provider failures use the deterministic fixture failure plans.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { appDb, settingsService, webhooksService } from "@revessent/server";
import * as schema from "@revessent/db";
import { withOrgTx } from "@revessent/db";
import { setStripeGatewayForTests, resetStripeGateway } from "@revessent/integrations";
import { fixtureGateway, fixtureAccount, resetFixtureWorlds } from "@revessent/integrations/fixtures";
import type { FixtureWorld } from "@revessent/integrations/fixtures";
import { createTestOrg, createTestUser, ctxFor, suffix } from "./helpers";

const GOOD_KEY = "rk_test_0123456789abcdefABCD";

interface Rig {
  slug: string; orgId: string; owner: Awaited<ReturnType<typeof createTestUser>>;
  world: FixtureWorld;
}

let rig: Rig;

function newWorld(overrides?: Partial<FixtureWorld>): FixtureWorld {
  return { account: fixtureAccount(overrides ? { ...overrides } : undefined), customers: [], subscriptions: [], invoices: [] };
}

async function connectWith(world: FixtureWorld, key = GOOD_KEY): Promise<void> {
  rig.world = world;
  if (!seenWorlds.includes(world)) seenWorlds.push(world);
  setStripeGatewayForTests(fixtureGateway(world));
  const ctx = await ctxFor(rig.owner, rig.slug, "administer");
  await settingsService.stripeConnect(ctx, key, { ip: "127.0.0.1", userAgent: "vitest" });
}

async function currentRow(): Promise<schema.StripeConnectionRow> {
  const [row] = await withOrgTx(appDb(), rig.orgId, (tx) =>
    tx.select().from(schema.stripeConnections)
      .where(and(eq(schema.stripeConnections.orgId, rig.orgId), eq(schema.stripeConnections.mode, "test")))
      .orderBy(schema.stripeConnections.createdAt));
  return row!;
}

async function rows(): Promise<schema.StripeConnectionRow[]> {
  return withOrgTx(appDb(), rig.orgId, (tx) =>
    tx.select().from(schema.stripeConnections).where(eq(schema.stripeConnections.orgId, rig.orgId)));
}

const seenWorlds: FixtureWorld[] = [];
function worldEndpoints(): Array<{ id: string; url: string }> {
  const seen = new Map<string, { id: string; url: string }>();
  for (const w of seenWorlds) for (const e of w.webhookEndpoints ?? []) if (!seen.has(e.id)) seen.set(e.id, { id: e.id, url: e.url });
  return [...seen.values()];
}

async function audits(action: string) {
  return withOrgTx(appDb(), rig.orgId, (tx) =>
    tx.select().from(schema.auditLogs).where(eq(schema.auditLogs.action, action)));
}

async function dto() {
  const ctx = await ctxFor(rig.owner, rig.slug, "view");
  return settingsService.stripeConnection(ctx);
}

/* ---------- real-DB failure injection (superuser triggers) ---------- */

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { Client: PgClient } = require("pg") as typeof import("pg");

let admin: import("pg").Client | null = null;
async function adminClient(): Promise<import("pg").Client> {
  if (!admin) {
    admin = new PgClient({ connectionString: process.env.MIGRATE_DATABASE_URL });
    await admin.connect();
    await admin.query(`create or replace function raise_injected_lifecycle_failure() returns trigger
      as $$ begin raise exception 'injected lifecycle failure (test)'; end $$ language plpgsql;`);
  }
  return admin;
}
async function installLifecycleTriggers(): Promise<void> {
  const c = await adminClient();
  await c.query(`drop trigger if exists fail_connect_finalize on stripe_connections`);
  await c.query(`drop trigger if exists fail_disconnect_finalize on stripe_connections`);
  await c.query(`create trigger fail_connect_finalize before update of status on stripe_connections
    for each row when (old.display_name = 'LIFECYCLE_FAIL_CONNECT' and new.status = 'active')
    execute function raise_injected_lifecycle_failure()`);
  await c.query(`create trigger fail_disconnect_finalize before update of status on stripe_connections
    for each row when (old.display_name = 'LIFECYCLE_FAIL_DISCONNECT' and new.status = 'revoked')
    execute function raise_injected_lifecycle_failure()`);
}
async function dropLifecycleTriggers(): Promise<void> {
  if (!admin) return;
  await admin.query(`drop trigger if exists fail_connect_finalize on stripe_connections`);
  await admin.query(`drop trigger if exists fail_disconnect_finalize on stripe_connections`);
}

beforeEach(async () => {
  const owner = await createTestUser("lcowner");
  const { slug, orgId } = await createTestOrg(owner, `lc${suffix()}`);
  rig = { slug, orgId, owner, world: newWorld() };
  seenWorlds.length = 0;
  seenWorlds.push(rig.world);
  await installLifecycleTriggers();
});
afterEach(async () => {
  resetStripeGateway();
  resetFixtureWorlds();
});

/* ================= Connect ================= */

describe("connect lifecycle", () => {
  it("1. provider endpoint creation + local success: endpoint durably associated, URL names the CONNECTION id", async () => {
    await connectWith(rig.world);
    const row = await currentRow();
    expect(row.status).toBe("active");
    expect(row.webhookState).toBeNull();
    expect(row.webhookEndpointId).toBeTruthy();
    expect(row.webhookSecretEnc).toBeTruthy();
    expect(row.webhookSecretEnc).not.toContain("whsec_"); // sealed, never plaintext
    // the receiver URL must carry the connection id (the {orgRef} the 0013 resolver looks up)
    const eps = worldEndpoints();
    expect(eps).toHaveLength(1);
    expect(eps[0]!.url.endsWith(`/api/v1/webhooks/stripe/${row.id}`)).toBe(true);
    expect((await audits("connection.succeeded")).length).toBe(1);
  });

  it("2. provider endpoint creation failure: connection stays valid, registration failure observable", async () => {
    const world = newWorld();
    world.failures = [{ on: "webhook_create", kind: "provider_outage" }];
    await connectWith(world);
    const row = await currentRow();
    expect(row.status).toBe("active"); // read-only connection remains usable (4B behavior)
    expect(row.webhookState).toBe("registration_failed");
    expect(row.webhookEndpointId).toBeNull();
    const d = await dto();
    expect(d.webhooks?.configured).toBe(false);
    expect(d.webhooks?.lifecycle).toBe("registration_failed");
  });

  it("3. provider success + local finalize failure + SUCCESSFUL compensation: no endpoint left behind, safe failure", async () => {
    await expect(connectWith(newWorld({ displayName: "LIFECYCLE_FAIL_CONNECT" })))
      .rejects.toMatchObject({ problem: { status: 500 } });
    // compensation deleted the provider endpoint — nothing orphaned
    expect(worldEndpoints()).toHaveLength(0);
    // no usable connection, no orphan — the attempt row is a revoked stub
    const all = await rows();
    expect(all.every((r) => r.status === "revoked" && r.keyCiphertext === null && r.webhookEndpointId === null)).toBe(true);
    const d = await dto();
    expect(d.status).toBe("not_connected");
  });

  it("4. provider success + local finalize failure + FAILED compensation: durable ORPHAN, no secret exposure", async () => {
    const world = newWorld({ displayName: "LIFECYCLE_FAIL_CONNECT" });
    world.failures = [{ on: "webhook_delete", kind: "provider_outage" }];
    await expect(connectWith(world))
      .rejects.toMatchObject({ problem: { status: 500 } });
    const all = await rows();
    const orphan = all.find((r) => r.status === "orphaned");
    expect(orphan).toBeTruthy();
    expect(orphan!.webhookEndpointId).toMatch(/^we_fixture_/); // durable orphan identity
    expect(orphan!.webhookState).toBe("orphan_cleanup");
    expect(orphan!.keyCiphertext).toBeTruthy(); // sealed key retained for cleanup auth
    expect(orphan!.webhookSecretEnc).not.toContain("whsec_");
    const d = await dto();
    expect(d.webhooks?.lifecycle).toBe("orphan_cleanup"); // surfaced, never hidden
    expect(JSON.stringify(d)).not.toContain("whsec_");
    expect((await audits("connection.failed")).length).toBe(1); // safe codes only
    expect(JSON.stringify(await audits("connection.failed"))).not.toContain("whsec_");
  });

  it("5. reconnect failure PRESERVES the existing usable connection (old row + endpoint intact)", async () => {
    await connectWith(rig.world); // connection 1 (usable)
    const first = await currentRow();
    await expect(connectWith(newWorld({ displayName: "LIFECYCLE_FAIL_CONNECT" })))
      .rejects.toMatchObject({ problem: { status: 500 } });
    // replacement endpoint compensated — not orphaned
    expect(worldEndpoints().map((e) => e.id)).toEqual([first.webhookEndpointId]);
    const d = await dto();
    expect(d.status).toBe("read_only");
    expect(d.webhooks?.endpointId).toBe(first.webhookEndpointId); // org's usable connection SURVIVED
    const all = await rows();
    expect(all.filter((r) => r.status === "active")).toHaveLength(1);
    expect(all.find((r) => r.status === "active")!.id).toBe(first.id);
  });

  it("6. successful reconnect cleans up the old provider endpoint and keeps ONE row", async () => {
    await connectWith(rig.world);
    const first = await currentRow();
    await connectWith(rig.world, "rk_test_ffffffffffffffffffff"); // same-mode rotation
    const all = await rows();
    expect(all).toHaveLength(1); // rotation replaced, not duplicated (4A invariant)
    const second = all[0]!;
    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe("active");
    expect(second.webhookEndpointId).not.toBe(first.webhookEndpointId);
    expect(worldEndpoints().map((e) => e.id)).toEqual([second.webhookEndpointId]); // old endpoint deleted
    const cleanups = await audits("connection.cleanup");
    expect(cleanups.length).toBe(1);
    expect(JSON.stringify(cleanups[0]!.diff)).toContain("removed");
  });

  it("7. old endpoint cleanup failure: observable + recoverable, NEW connection stays valid", async () => {
    await connectWith(rig.world);
    const first = await currentRow();
    const world = newWorld();
    world.failures = [{ on: "webhook_delete", kind: "provider_outage" }];
    await connectWith(world, "rk_test_ffffffffffffffffffff"); // reconnect; old-endpoint delete fails
    const all = await rows();
    const second = all.find((r) => r.status === "active")!;
    expect(second.webhookEndpointId).not.toBe(first.webhookEndpointId);
    const d = await dto();
    expect(d.status).toBe("read_only"); // new connection fully usable
    expect(d.webhooks?.endpointId).toBe(second.webhookEndpointId);
    const oldRow = all.find((r) => r.id === first.id)!;
    expect(oldRow.status).toBe("error");
    expect(oldRow.webhookState).toBe("cleanup_pending"); // recoverable, retryable
    expect(oldRow.keyCiphertext).toBeTruthy(); // material retained for cleanup
    const cleanups = await audits("connection.cleanup");
    expect(cleanups.length).toBe(1);
    expect(JSON.stringify(cleanups[0]!.diff)).toContain("remove_failed");
    expect(JSON.stringify(cleanups[0]!.diff)).toContain("recoverable");
  });
});

/* ================= Disconnect ================= */

describe("disconnect lifecycle", () => {
  it("8. provider deletion + local success: revoked, material destroyed, endpoint removed", async () => {
    await connectWith(rig.world);
    const row = await currentRow();
    const ctx = await ctxFor(rig.owner, rig.slug, "administer");
    const after = await settingsService.stripeDisconnect(ctx, {});
    expect(after.status).toBe("not_connected");
    const revoked = await currentRow();
    expect(revoked.status).toBe("revoked");
    expect(revoked.keyCiphertext).toBeNull();
    expect(revoked.webhookSecretEnc).toBeNull();
    expect(revoked.webhookState).toBeNull();
    expect(worldEndpoints()).toHaveLength(0); // provider endpoint deleted
    expect((await audits("connection.disconnected")).length).toBe(1);
    void row;
  });

  it("9. provider deletion failure: connection stays ACTIVE + recoverable; disconnect NOT reported clean", async () => {
    const world = newWorld();
    await connectWith(world);
    const row = await currentRow();
    const failing = newWorld();
    failing.failures = [{ on: "webhook_delete", kind: "provider_outage" }];
    setStripeGatewayForTests(fixtureGateway(failing));
    const ctx = await ctxFor(rig.owner, rig.slug, "administer");
    await expect(settingsService.stripeDisconnect(ctx, {}))
      .rejects.toMatchObject({ problem: { status: 500 } });
    const still = await currentRow();
    expect(still.status).toBe("active"); // recoverable — NOT revoked
    expect(still.keyCiphertext).toBeTruthy(); // sealed key retained for retry
    expect(still.webhookState).toBe("cleanup_pending");
    expect(worldEndpoints().map((e) => e.id)).toEqual([row.webhookEndpointId]); // endpoint still on provider
    const d = await dto();
    expect(d.status).toBe("read_only");
    expect(d.webhooks?.lifecycle).toBe("cleanup_pending"); // honest, observable
    const cleanups = await audits("connection.cleanup");
    expect(JSON.stringify(cleanups[0]!.diff)).toContain("remove_failed");
  });

  it("10. provider deletion succeeds + local finalization fails: mismatch recorded, nothing faked", async () => {
    await connectWith(newWorld({ displayName: "LIFECYCLE_FAIL_DISCONNECT" }));
    const row = await currentRow();
    const ctx = await ctxFor(rig.owner, rig.slug, "administer");
    await expect(settingsService.stripeDisconnect(ctx, {}))
      .rejects.toMatchObject({ problem: { status: 500 } });
    const still = await currentRow();
    expect(still.status).toBe("active"); // local finalize rolled back
    expect(still.keyCiphertext).toBeTruthy();
    expect(still.webhookState).toBe("provider_deleted_local_stale"); // mismatch explicit
    expect(worldEndpoints()).toHaveLength(0); // provider side IS gone
    const cleanups = await audits("connection.cleanup");
    expect(JSON.stringify(cleanups[0]!.diff)).toContain("failed_recoverable");
    void row;
  });

  it("11. retry after partial disconnect completes idempotently (endpoint already gone)", async () => {
    await connectWith(newWorld({ displayName: "LIFECYCLE_FAIL_DISCONNECT" }));
    const ctx = await ctxFor(rig.owner, rig.slug, "administer");
    await expect(settingsService.stripeDisconnect(ctx, {})).rejects.toMatchObject({ problem: { status: 500 } });
    // the injected local failure was transient — remove it before the retry
    await dropLifecycleTriggers();
    // RETRY: provider delete runs again against an already-deleted endpoint → idempotent success
    setStripeGatewayForTests(fixtureGateway(newWorld()));
    const after = await settingsService.stripeDisconnect(ctx, {});
    expect(after.status).toBe("not_connected");
    const done = await currentRow();
    expect(done.status).toBe("revoked");
    expect(done.keyCiphertext).toBeNull();
    expect(done.webhookState).toBeNull();
    expect((await audits("connection.disconnected")).length).toBe(1);
  });

  it("12. already-deleted provider endpoint: disconnect is idempotent and safe", async () => {
    await connectWith(rig.world);
    rig.world.webhookEndpoints = []; // simulate provider-side deletion (e.g. Stripe dashboard)
    const ctx = await ctxFor(rig.owner, rig.slug, "administer");
    const after = await settingsService.stripeDisconnect(ctx, {});
    expect(after.status).toBe("not_connected");
    expect((await currentRow()).status).toBe("revoked");
    // and a second disconnect (no active row) is a no-op, not an error
    const again = await settingsService.stripeDisconnect(ctx, {});
    expect(again.status).toBe("not_connected");
  });
});

/* ================= Recovery / reconciliation ================= */

describe("lifecycle reconciliation", () => {
  it("13. the five lifecycle states are distinguishable", async () => {
    const { classifyWebhookLifecycle } = webhooksService;
    expect(classifyWebhookLifecycle({ status: "active", webhookState: null, webhookEndpointId: "we_1" })).toBe("healthy");
    expect(classifyWebhookLifecycle({ status: "active", webhookState: "registration_failed", webhookEndpointId: null })).toBe("registration_failed");
    expect(classifyWebhookLifecycle({ status: "active", webhookState: "cleanup_pending", webhookEndpointId: "we_2" })).toBe("cleanup_pending");
    expect(classifyWebhookLifecycle({ status: "active", webhookState: "provider_deleted_local_stale", webhookEndpointId: "we_3" })).toBe("provider_removed_local_stale");
    expect(classifyWebhookLifecycle({ status: "orphaned", webhookState: "orphan_cleanup", webhookEndpointId: "we_4" })).toBe("orphan_cleanup");
    // org-level status surfaces the worst state
    await withOrgTx(appDb(), rig.orgId, (tx) => tx.insert(schema.stripeConnections).values({
      orgId: rig.orgId, mode: "test", stripeAccountId: "acct_orphan", keyCiphertext: "sealed.x.y",
      keyLast4: "last", scopes: {}, status: "orphaned", webhookState: "orphan_cleanup",
      webhookEndpointId: "we_orphan_1", displayName: null, accountCountry: null, defaultCurrency: null
    }));
    const d = await dto();
    expect(d.webhooks?.lifecycle).toBe("orphan_cleanup");
  });

  it("14. reconciliation repairs the provider/local mismatch", async () => {
    // REAL failure flow: connect #1 (good) → connect #2 whose local finalize
    // fails AND whose compensation fails → durable orphan + superseded row in
    // 'cleanup_pending' (old endpoint still on the provider).
    // 1) good connection
    await connectWith(newWorld());
    // 2) reconnect whose local finalize fails AND compensation fails → durable orphan
    const failing = newWorld({ displayName: "LIFECYCLE_FAIL_CONNECT" });
    failing.failures = [{ on: "webhook_delete", kind: "provider_outage" }];
    await expect(connectWith(failing)).rejects.toMatchObject({ problem: { status: 500 } });
    const orphan = (await rows()).find((r) => r.status === "orphaned")!;
    expect(orphan).toBeTruthy();
    // 3) reconnect that finalizes but fails OLD-ENDPOINT cleanup → cleanup_pending
    const cleanupFails = newWorld();
    cleanupFails.failures = [{ on: "webhook_delete", kind: "provider_outage" }];
    await connectWith(cleanupFails, "rk_test_eeeeeeeeeeeeeeeeeeee");
    const oldRow = (await rows()).find((r) => r.status === "error" && r.webhookState === "cleanup_pending")!;
    expect(oldRow).toBeTruthy();
    const live2 = (await rows()).find((r) => r.status === "active")!;

    // reconcile with a HEALTHY provider: orphan endpoint deleted + rows settled
    setStripeGatewayForTests(fixtureGateway(newWorld()));
    const ctx = await ctxFor(rig.owner, rig.slug, "operate");
    const result = await webhooksService.reconcileFromProvider(ctx, {}) as { lifecycle: string[] };
    expect(result.lifecycle).toContain("orphan_cleaned");
    expect(result.lifecycle).toContain("cleanup_completed");
    const all = await rows();
    expect(all.find((r) => r.id === orphan.id)!.status).toBe("revoked"); // converted to history
    expect(all.find((r) => r.id === orphan.id)!.keyCiphertext).toBeNull(); // material destroyed
    expect(all.find((r) => r.id === oldRow.id)).toBeUndefined(); // superseded leftover removed after cleanup
    expect((await rows()).find((r) => r.status === "active")!.id).toBe(live2.id); // usable connection untouched
    // the ONLY provider endpoint left is the live connection's
    const eps = worldEndpoints().map((e) => e.id);
    expect(eps).toEqual([live2.webhookEndpointId]);
    const d = await dto();
    expect(d.webhooks?.lifecycle).toBe("healthy");
  });

  it("15. lifecycle reconciliation is read-only toward Stripe except REVESSENT-owned endpoint cleanup", async () => {
    const { orgId } = rig;
    await connectWith(newWorld());
    const live = await currentRow();
    // real orphan (sealed key is genuine, so the cleanup can authenticate)
    const failing = newWorld({ displayName: "LIFECYCLE_FAIL_CONNECT" });
    failing.failures = [{ on: "webhook_delete", kind: "provider_outage" }];
    await expect(connectWith(failing)).rejects.toMatchObject({ problem: { status: 500 } });
    const orphan = (await rows()).find((r) => r.status === "orphaned")!;
    expect(orphan).toBeTruthy();

    const ctx = await ctxFor(rig.owner, rig.slug, "operate");
    const world = newWorld(); // healthy provider for the repair
    rig.world = world;
    setStripeGatewayForTests(fixtureGateway(world));
    const before = { ...world.calls! };
    await webhooksService.repairLifecycle(ctx);
    const after = { ...world.calls! };
    // NO endpoint creation, NO read-model provider reads — repairLifecycle
    // only ever DELETES REVESSENT-owned webhook endpoint configuration.
    expect(after.webhook_create ?? 0).toBe(before.webhook_create ?? 0);
    expect(after.customers ?? 0).toBe(before.customers ?? 0);
    expect(after.subscriptions ?? 0).toBe(before.subscriptions ?? 0);
    expect(after.invoices ?? 0).toBe(before.invoices ?? 0);
    expect(after.webhook_delete).toBe((before.webhook_delete ?? 0) + 1); // exactly the orphan's endpoint
    expect(worldEndpoints().map((e) => e.id)).toEqual([live.webhookEndpointId]);
    // domain data untouched by the lifecycle repair
    const pays = await withOrgTx(appDb(), orgId, (tx) => tx.select().from(schema.payments).where(eq(schema.payments.orgId, orgId)));
    expect(pays).toHaveLength(0);
  });
});
