/**
 * PHASE 4B — WEBHOOK RECEIVER END-TO-END (Architecture v1 §8.2/§8.3/§10.3).
 *
 * Real Postgres + real official Stripe signature verification. The provider
 * gateway is the deterministic fixture (no network); the SIGNATURE path uses
 * the official SDK both to sign (test helper) and to verify (service) —
 * no custom crypto anywhere.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { appDb, settingsService, webhooksService } from "@revessent/server";
import * as schema from "@revessent/db";
import { withOrgTx } from "@revessent/db";
import {
  setStripeGatewayForTests, resetStripeGateway, verifyStripeWebhook, generateTestSignatureHeader,
  WEBHOOK_TOLERANCE_SECONDS
} from "@revessent/integrations";
import { fixtureGateway, fixtureAccount } from "@revessent/integrations/fixtures";
import type { FixtureWorld } from "@revessent/integrations/fixtures";
import { createTestOrg, createTestUser, ctxFor, suffix } from "./helpers";

/* ---------- event payload builder (Stripe Event wire shape) ---------- */

let eventSeq = 0;
function evt(input: {
  type: string;
  object?: Record<string, unknown>;
  createdOffsetSec?: number; // relative to now (negative = past)
  livemode?: boolean;
  account?: string;
  id?: string;
}): { id: string; payload: string } {
  eventSeq++;
  const id = input.id ?? `evt_test_${suffix()}_${eventSeq}`;
  const created = Math.floor(Date.now() / 1000) + (input.createdOffsetSec ?? 0);
  const event = {
    id,
    object: "event",
    api_version: "2024-06-20",
    created,
    data: { object: input.object ?? {} },
    livemode: input.livemode ?? false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    type: input.type,
    ...(input.account ? { account: input.account } : {})
  };
  return { id, payload: JSON.stringify(event) };
}

/* ---------- per-test harness: connected org + captured signing secret ---------- */

interface Rig { slug: string; orgId: string; connId: string; secret: string; world: FixtureWorld; owner: Awaited<ReturnType<typeof createTestUser>>; }

let rig: Rig;

async function buildRig(): Promise<Rig> {
  const owner = await createTestUser("whowner");
  const { slug, orgId } = await createTestOrg(owner, `wh${suffix()}`);
  const world: FixtureWorld = { account: fixtureAccount({ id: "acct_wh_" + suffix() }) };
  const gw = fixtureGateway(world);
  setStripeGatewayForTests(gw);
  const secret = `whsec_test_${suffix()}`;
  // capture the secret the fixture endpoint lifecycle would return
  const realCreate = gw.createWebhookEndpoint.bind(gw);
  gw.createWebhookEndpoint = async (key, opts) => ({ ...(await realCreate(key, opts)), secret });
  const ctx = await ctxFor(owner, slug, "administer");
  await settingsService.stripeConnect(ctx, `rk_test_${suffix()}${suffix()}`, { ip: "127.0.0.1", userAgent: "vitest" });
  const [conn] = await withOrgTx(appDb(), orgId, (tx) =>
    tx.select().from(schema.stripeConnections).where(eq(schema.stripeConnections.orgId, orgId)));
  expect(conn?.webhookEndpointId).toBeTruthy();
  expect(conn?.webhookSecretEnc).toBeTruthy();
  return { slug, orgId, connId: conn!.id, secret, world, owner };
}

beforeEach(async () => { rig = await buildRig(); });
afterEach(() => { resetStripeGateway(); });

async function events(orgId: string) {
  return withOrgTx(appDb(), orgId, (tx) =>
    tx.select().from(schema.webhookEvents).where(eq(schema.webhookEvents.orgId, orgId)));
}

async function connRow(orgId: string) {
  const [c] = await withOrgTx(appDb(), orgId, (tx) =>
    tx.select().from(schema.stripeConnections).where(eq(schema.stripeConnections.orgId, orgId)));
  return c!;
}

async function receive(payload: string, sig: string | null, orgRef = rig.connId) {
  return webhooksService.receiveStripeWebhook({ orgRef, rawBody: payload, sigHeader: sig });
}

/* ================= B. signature & replay (§7.5/§10.3) ================= */

describe("webhook signature verification + replay window", () => {
  it("official header + official verify round-trip accepts a fresh event", async () => {
    const { payload } = evt({ type: "customer.updated", object: { id: "cus_x", object: "customer", email: null, name: null, currency: null, deleted: false, created: 1 } });
    const sig = await generateTestSignatureHeader({ payload, secret: rig.secret });
    const res = await receive(payload, sig);
    expect(res.received).toBe(true);
    expect(res.status).toBe("processed");
    expect(res.duplicate).toBe(false);
  });

  it("missing signature header is rejected (400-class) and NOTHING is persisted", async () => {
    const { payload } = evt({ type: "customer.updated", object: { id: "cus_x", object: "customer", email: null, name: null, currency: null, deleted: false, created: 1 } });
    await expect(receive(payload, null)).rejects.toMatchObject({ problem: { status: 400 } });
    expect((await events(rig.orgId)).length).toBe(0);
  });

  it("tampered payload breaks the signature — rejected, nothing persisted", async () => {
    const { payload } = evt({ type: "customer.updated", object: { id: "cus_x", object: "customer", email: null, name: null, currency: null, deleted: false, created: 1 } });
    const sig = await generateTestSignatureHeader({ payload, secret: rig.secret });
    const tampered = payload.replace("cus_x", "cus_evil");
    await expect(receive(tampered, sig)).rejects.toMatchObject({ problem: { status: 400 } });
    expect((await events(rig.orgId)).length).toBe(0);
  });

  it("wrong signing secret is rejected", async () => {
    const { payload } = evt({ type: "customer.updated", object: { id: "cus_x", object: "customer", email: null, name: null, currency: null, deleted: false, created: 1 } });
    const sig = await generateTestSignatureHeader({ payload, secret: "whsec_other_secret" });
    await expect(receive(payload, sig)).rejects.toMatchObject({ problem: { status: 400 } });
  });

  it("older than the 5-minute tolerance is rejected as stale (no persistence)", async () => {
    const { payload } = evt({ type: "customer.updated", object: { id: "cus_x", object: "customer", email: null, name: null, currency: null, deleted: false, created: 1 } });
    const stale = Math.floor(Date.now() / 1000) - (WEBHOOK_TOLERANCE_SECONDS + 5);
    const sig = await generateTestSignatureHeader({ payload, secret: rig.secret, timestampSeconds: stale });
    await expect(receive(payload, sig)).rejects.toMatchObject({ problem: { status: 400 } });
    expect((await events(rig.orgId)).length).toBe(0);
  });

  it("boundary: exactly at tolerance is ACCEPTED; one second past is REJECTED", async () => {
    const at = Math.floor(Date.now() / 1000) - WEBHOOK_TOLERANCE_SECONDS;
    const past = at - 1;
    const mk = () => evt({ type: "customer.updated", object: { id: "cus_x", object: "customer", email: null, name: null, currency: null, deleted: false, created: 1 } });
    const a = mk();
    const sigA = await generateTestSignatureHeader({ payload: a.payload, secret: rig.secret, timestampSeconds: at });
    await expect(receive(a.payload, sigA)).resolves.toMatchObject({ received: true });

    const b = mk();
    const sigB = await generateTestSignatureHeader({ payload: b.payload, secret: rig.secret, timestampSeconds: past });
    await expect(receive(b.payload, sigB)).rejects.toMatchObject({ problem: { status: 400 } });
  });

  it("malformed JSON payload is rejected safely", async () => {
    const sig = await generateTestSignatureHeader({ payload: "{not json", secret: rig.secret });
    await expect(receive("{not json", sig)).rejects.toMatchObject({ problem: { status: 400 } });
    expect((await events(rig.orgId)).length).toBe(0);
  });

  it("unknown {orgRef} cannot verify (no secret) — safe 400, no enumeration difference", async () => {
    const { payload } = evt({ type: "customer.updated", object: { id: "cus_x", object: "customer", email: null, name: null, currency: null, deleted: false, created: 1 } });
    const sig = await generateTestSignatureHeader({ payload, secret: rig.secret });
    await expect(receive(payload, sig, "00000000-0000-0000-0000-000000000000"))
      .rejects.toMatchObject({ problem: { status: 400 } });
  });

  it("direct verifyStripeWebhook: safe codes for each failure shape", async () => {
    const { payload } = evt({ type: "customer.updated" });
    const ok = await verifyStripeWebhook(payload, await generateTestSignatureHeader({ payload, secret: "whsec_k" }), "whsec_k");
    expect(ok.ok).toBe(true);
    const bad = await verifyStripeWebhook(payload, "t=1,v1=deadbeef", "whsec_k");
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.code).toBe("invalid_signature");
    const missing = await verifyStripeWebhook(payload, null, "whsec_k");
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.code).toBe("missing_signature");
    const garbage = await verifyStripeWebhook(payload, "not a signature", "whsec_k");
    expect(garbage.ok).toBe(false);
    if (!garbage.ok) expect(garbage.code).toBe("invalid_signature"); // safe code either way
  });
});

/* ================= C/D. persistence, idempotency, processing ================= */

describe("durable persistence + idempotent processing", () => {
  it("valid event persists full provenance and processes the domain update", async () => {
    const { payload, id } = evt({
      type: "customer.updated",
      object: { id: "cus_W1", object: "customer", email: "w1@test.example", name: "Web One", currency: "usd", deleted: false, created: 1_700_000_000 }
    });
    const sig = await generateTestSignatureHeader({ payload, secret: rig.secret });
    await receive(payload, sig);
    const rows = await events(rig.orgId);
    expect(rows.length).toBe(1);
    const row = rows[0]!;
    expect(row.externalId).toBe(id);
    expect(row.source).toBe("stripe");
    expect(row.status).toBe("processed");
    expect(row.type).toBe("customer.updated");
    expect(row.objectType).toBe("customer");
    expect(row.objectId).toBe("cus_W1");
    expect(row.attempts).toBe(1);
    // payload persisted raw-ish, but never the signing secret
    const stored = JSON.stringify(row.payload);
    expect(stored).not.toContain("whsec_");
    const [cust] = await withOrgTx(appDb(), rig.orgId, (tx) =>
      tx.select().from(schema.customers).where(eq(schema.customers.stripeCustomerId, "cus_W1")));
    expect(cust?.email).toBe("w1@test.example");
  });

  it("duplicate delivery: no second row, no second application, safe ack", async () => {
    const { payload } = evt({
      type: "customer.updated",
      object: { id: "cus_D1", object: "customer", email: "d1@test.example", name: null, currency: null, deleted: false, created: 1 }
    });
    const sig = await generateTestSignatureHeader({ payload, secret: rig.secret });
    const first = await receive(payload, sig);
    expect(first.duplicate).toBe(false);
    const second = await receive(payload, sig);
    expect(second.duplicate).toBe(true);
    expect(second.status).toBe("processed");
    const rows = await events(rig.orgId);
    expect(rows.length).toBe(1);
    expect(rows[0]!.attempts).toBe(1); // not re-processed
  });

  it("concurrent duplicate deliveries: exactly one processing wins (advisory lock)", async () => {
    const { payload } = evt({
      type: "customer.updated",
      object: { id: "cus_C1", object: "customer", email: "c1@test.example", name: null, currency: null, deleted: false, created: 1 }
    });
    const sig = await generateTestSignatureHeader({ payload, secret: rig.secret });
    const [a, b] = await Promise.all([receive(payload, sig), receive(payload, sig)]);
    const statuses = [a, b].map((r) => `${r.duplicate ? "dup" : "first"}/${r.status}`).sort();
    expect(statuses).toEqual(["dup/processed", "first/processed"]);
    expect(a.duplicate !== b.duplicate).toBe(true); // exactly one processed it
    const rows = await events(rig.orgId);
    expect(rows.length).toBe(1);
    expect(rows[0]!.status).toBe("processed");
  });

  it("duplicate-after-FAILURE reprocesses once the dependency appears (§16)", async () => {
    // subscription event for an unsynced customer → durable failure
    const { payload, id } = evt({
      type: "customer.subscription.updated",
      object: {
        id: "sub_F1", object: "subscription", customer: "cus_missing", status: "active",
        currency: "usd", cancel_at_period_end: false, canceled_at: null, created: 1_700_000_000,
        start_date: 1_700_000_000,
        items: { data: [{ price: { id: "price_F", currency: "usd", unit_amount: 1900, recurring: { interval: "month" } } }] }
      }
    });
    const sig = await generateTestSignatureHeader({ payload, secret: rig.secret });
    const first = await receive(payload, sig);
    expect(first.status).toBe("failed");
    expect(first.note).toBe("dependency_missing:customer_not_synced");
    const rows1 = await events(rig.orgId);
    expect(rows1[0]!.status).toBe("failed");
    expect(rows1[0]!.attempts).toBe(1);

    // reconciliation: the customer syncs in via the delta path
    await withOrgTx(appDb(), rig.orgId, (tx) =>
      tx.insert(schema.customers).values({
        orgId: rig.orgId, stripeCustomerId: "cus_missing", email: null, name: null,
        currency: "usd", stripeCreatedAt: new Date(), updatedAt: new Date()
      }));

    // Stripe redelivers the SAME event id → it IS a duplicate delivery, but
    // the failed row is retried and now completes safely
    const second = await receive(payload, sig);
    expect(second.duplicate).toBe(true);
    expect(second.status).toBe("processed");
    const rows2 = await events(rig.orgId);
    expect(rows2.length).toBe(1);
    expect(rows2[0]!.externalId).toBe(id);
    expect(rows2[0]!.status).toBe("processed");
    expect(rows2[0]!.attempts).toBe(2);
  });
});

/* ================= E. ordering (§16-D) ================= */

describe("event ordering", () => {
  it("older event arriving after a newer one does NOT overwrite newer state", async () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const newer = evt({
      type: "customer.updated", createdOffsetSec: -2,
      object: { id: "cus_O1", object: "customer", email: "newer@test.example", name: "Newer", currency: null, deleted: false, created: nowSec }
    });
    const older = evt({
      type: "customer.updated", createdOffsetSec: -60,
      object: { id: "cus_O1", object: "customer", email: "older@test.example", name: "Older", currency: null, deleted: false, created: nowSec - 60 }
    });
    const sigN = await generateTestSignatureHeader({ payload: newer.payload, secret: rig.secret });
    const sigO = await generateTestSignatureHeader({ payload: older.payload, secret: rig.secret });
    await receive(newer.payload, sigN);
    const res = await receive(older.payload, sigO);
    expect(res.status).toBe("skipped");
    expect(res.note).toBe("superseded_by_newer_event");
    const [cust] = await withOrgTx(appDb(), rig.orgId, (tx) =>
      tx.select().from(schema.customers).where(eq(schema.customers.stripeCustomerId, "cus_O1")));
    expect(cust?.email).toBe("newer@test.example"); // authoritative state preserved
    const rows = await events(rig.orgId);
    expect(rows.length).toBe(2);
    expect(rows.find((r) => r.lastError === "superseded_by_newer_event")?.status).toBe("skipped");
  });

  it("equal-timestamp duplicates remain idempotent (event-id uniqueness wins)", async () => {
    const { payload } = evt({
      type: "customer.updated",
      object: { id: "cus_E1", object: "customer", email: "e1@test.example", name: null, currency: null, deleted: false, created: 5 }
    });
    const sig = await generateTestSignatureHeader({ payload, secret: rig.secret });
    await receive(payload, sig);
    const again = await receive(payload, sig);
    expect(again.duplicate).toBe(true);
  });
});

/* ================= F. domain truth + unhandled types ================= */

describe("domain processing (4A truth discipline)", () => {
  it("invoice whitelist: open+attempted maps failed; void maps void; unknown status is an anomaly skip", async () => {
    const cust = evt({
      type: "customer.updated",
      object: { id: "cus_I1", object: "customer", email: null, name: null, currency: "usd", deleted: false, created: 1 }
    });
    await receive(cust.payload, await generateTestSignatureHeader({ payload: cust.payload, secret: rig.secret }));

    const failedInv = evt({
      type: "invoice.payment_failed",
      object: { id: "in_F", object: "invoice", customer: "cus_I1", status: "open", attempted: true, attempt_count: 2, amount_due: 1900, currency: "usd", created: 1_700_000_500 }
    });
    const rf = await receive(failedInv.payload, await generateTestSignatureHeader({ payload: failedInv.payload, secret: rig.secret }));
    expect(rf.status).toBe("processed");

    const voidInv = evt({
      type: "invoice.voided",
      object: { id: "in_V", object: "invoice", customer: "cus_I1", status: "void", attempted: true, attempt_count: 1, amount_due: 1900, currency: "usd", created: 1_700_000_600 }
    });
    const rv = await receive(voidInv.payload, await generateTestSignatureHeader({ payload: voidInv.payload, secret: rig.secret }));
    expect(rv.status).toBe("processed");

    const weird = evt({
      type: "invoice.updated",
      object: { id: "in_W", object: "invoice", customer: "cus_I1", status: "some_future_status", attempted: false, attempt_count: 0, amount_due: 1900, currency: "usd", created: 1_700_000_700 }
    });
    const rw = await receive(weird.payload, await generateTestSignatureHeader({ payload: weird.payload, secret: rig.secret }));
    expect(rw.status).toBe("skipped");
    expect(rw.note).toBe("anomaly:unsupported_invoice_status");

    const pays = await withOrgTx(appDb(), rig.orgId, (tx) =>
      tx.select().from(schema.payments).where(eq(schema.payments.orgId, rig.orgId)));
    const byInv = Object.fromEntries(pays.map((p) => [p.stripeInvoiceId, p.status]));
    expect(byInv["in_F"]).toBe("failed");
    expect(byInv["in_V"]).toBe("void");
    expect(byInv["in_W"]).toBeUndefined(); // unknown stayed unknown — nothing written
  });

  it("unchanged types from §8.3 are persisted as skipped — never dropped, never invented", async () => {
    for (const t of ["charge.refunded", "charge.succeeded", "invoice.payment_action_required", "payment_method.attached"]) {
      const e = evt({ type: t, object: { id: "pm_1", object: "payment_method" } });
      const res = await receive(e.payload, await generateTestSignatureHeader({ payload: e.payload, secret: rig.secret }));
      expect(res.status).toBe("skipped");
    }
    const rows = await events(rig.orgId);
    expect(rows.map((r) => r.type).sort()).toEqual(
      ["charge.refunded", "charge.succeeded", "invoice.payment_action_required", "payment_method.attached"].sort());
    expect(rows.every((r) => r.status === "skipped" && r.lastError)).toBe(true);
  });

  it("subscription event recomputes customer MRR from provider truth", async () => {
    const cust = evt({
      type: "customer.updated",
      object: { id: "cus_M1", object: "customer", email: null, name: null, currency: "usd", deleted: false, created: 1 }
    });
    await receive(cust.payload, await generateTestSignatureHeader({ payload: cust.payload, secret: rig.secret }));
    const sub = evt({
      type: "customer.subscription.created",
      object: {
        id: "sub_M1", object: "subscription", customer: "cus_M1", status: "active",
        currency: "usd", cancel_at_period_end: false, canceled_at: null, created: 1_700_000_000,
        start_date: 1_700_000_000,
        items: { data: [{ price: { id: "price_M", currency: "usd", unit_amount: 12000, recurring: { interval: "year" } } }] }
      }
    });
    const res = await receive(sub.payload, await generateTestSignatureHeader({ payload: sub.payload, secret: rig.secret }));
    expect(res.status).toBe("processed");
    const [c] = await withOrgTx(appDb(), rig.orgId, (tx) =>
      tx.select().from(schema.customers).where(eq(schema.customers.stripeCustomerId, "cus_M1")));
    expect(c?.mrrCents).toBe(1000); // 12000/12 — year normalization unchanged from 4A
  });
});

/* ================= G. account scoping + revocation/deauth ================= */

describe("account scoping, mode, deauthorization", () => {
  it("event whose account claim does not match the connection is skipped — never applied", async () => {
    const e = evt({
      type: "customer.updated",
      account: "acct_OTHER_account",
      object: { id: "cus_X1", object: "customer", email: "x@test.example", name: null, currency: null, deleted: false, created: 1 }
    });
    const res = await receive(e.payload, await generateTestSignatureHeader({ payload: e.payload, secret: rig.secret }));
    expect(res.status).toBe("skipped");
    expect(res.note).toBe("account_mismatch");
    const [cust] = await withOrgTx(appDb(), rig.orgId, (tx) =>
      tx.select().from(schema.customers).where(eq(schema.customers.stripeCustomerId, "cus_X1")));
    expect(cust).toBeUndefined();
  });

  it("livemode mismatch with the endpoint is rejected", async () => {
    const e = evt({ type: "customer.updated", livemode: true, object: { id: "cus_L1", object: "customer", email: null, name: null, currency: null, deleted: false, created: 1 } });
    await expect(receive(e.payload, await generateTestSignatureHeader({ payload: e.payload, secret: rig.secret })))
      .rejects.toMatchObject({ problem: { status: 400 } });
  });

  it("account.application.deauthorized: revoked + credential AND webhook secret destroyed + audited", async () => {
    const before = await connRow(rig.orgId);
    expect(before.keyCiphertext).toBeTruthy();
    const e = evt({
      type: "account.application.deauthorized",
      account: before.stripeAccountId,
      object: { id: "acct_connect_event", object: "application", name: "REVESSENT" }
    });
    const res = await receive(e.payload, await generateTestSignatureHeader({ payload: e.payload, secret: rig.secret }));
    expect(res.status).toBe("processed");
    const after = await connRow(rig.orgId);
    expect(after.status).toBe("revoked");
    expect(after.keyCiphertext).toBeNull();        // API credential material destroyed (§12)
    expect(after.webhookSecretEnc).toBeNull();     // signing secret destroyed — no resurrection
    const audits = await withOrgTx(appDb(), rig.orgId, (tx) =>
      tx.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.orgId, rig.orgId), eq(schema.auditLogs.action, "credential.revoked"))));
    expect(audits.length).toBe(1);
    const diff = JSON.stringify(audits[0]!.diff);
    expect(diff).toContain("webhook");   // source recorded
    expect(diff).not.toContain("whsec"); // never secrets (§18)
    // and after revocation, further deliveries cannot verify at all
    const e2 = evt({ type: "customer.updated", account: before.stripeAccountId, object: { id: "cus_Z", object: "customer", email: null, name: null, currency: null, deleted: false, created: 1 } });
    await expect(receive(e2.payload, await generateTestSignatureHeader({ payload: e2.payload, secret: rig.secret })))
      .rejects.toMatchObject({ problem: { status: 400 } });
  });
});

/* ================= H. freshness, isolation, reconciliation ================= */

describe("freshness signals + org isolation + reconciliation", () => {
  it("webhook freshness is honest: failed events are counted, not hidden", async () => {
    const bad = evt({
      type: "customer.subscription.updated",
      object: {
        id: "sub_H", object: "subscription", customer: "cus_nope", status: "active",
        currency: "usd", cancel_at_period_end: false, canceled_at: null, created: 1,
        items: { data: [{ price: { id: "p", currency: "usd", unit_amount: 100, recurring: { interval: "month" } } }] }
      }
    });
    await receive(bad.payload, await generateTestSignatureHeader({ payload: bad.payload, secret: rig.secret }));
    const ctx = await ctxFor(rig.owner, rig.slug, "view"); // member sees the DTO too
    const dto = await settingsService.stripeConnection(ctx);
    expect(dto.webhooks?.configured).toBe(true);
    expect(dto.webhooks?.failed).toBe(1);
    expect(dto.webhooks?.lastFailureCode).toBe("dependency_missing:customer_not_synced");
    expect(dto.webhooks?.unprocessed).toBe(0);
  });

  it("org isolation: the same event id cannot cross orgs; second org gets its own row", async () => {
    const owner = await createTestUser("whiso");
    const { slug: slug2, orgId: orgId2 } = await createTestOrg(owner, `wh2${suffix()}`);
    const world2: FixtureWorld = { account: fixtureAccount({ id: "acct_wh2_" + suffix() }) };
    const gw2 = fixtureGateway(world2);
    const secret2 = `whsec_test_${suffix()}`;
    const realCreate2 = gw2.createWebhookEndpoint.bind(gw2);
    gw2.createWebhookEndpoint = async (k, o) => ({ ...(await realCreate2(k, o)), secret: secret2 });
    setStripeGatewayForTests(gw2);
    const ctx2 = await ctxFor(owner, slug2, "administer");
    await settingsService.stripeConnect(ctx2, `rk_test_${suffix()}${suffix()}`, { ip: null, userAgent: null });

    const { payload, id } = evt({
      type: "customer.updated",
      object: { id: "cus_ISO", object: "customer", email: "iso@test.example", name: null, currency: null, deleted: false, created: 1 }
    });
    // delivered to org A's endpoint
    await receive(payload, await generateTestSignatureHeader({ payload, secret: rig.secret }));
    // the SAME event id delivered to org B's endpoint: valid for B (its own connection),
    // but the customer lands in B — org A's row is untouched.
    const res2 = await webhooksService.receiveStripeWebhook({
      orgRef: (await withOrgTx(appDb(), orgId2, (tx) =>
        tx.select().from(schema.stripeConnections).where(eq(schema.stripeConnections.orgId, orgId2))))[0]!.id,
      rawBody: payload, sigHeader: await generateTestSignatureHeader({ payload, secret: secret2 })
    });
    expect(res2.received).toBe(true);
    const rowsA = await events(rig.orgId);
    const rowsB = await withOrgTx(appDb(), orgId2, (tx) =>
      tx.select().from(schema.webhookEvents).where(eq(schema.webhookEvents.orgId, orgId2)));
    expect(rowsA.length).toBe(1);
    expect(rowsB.length).toBe(1);
    expect(rowsB[0]!.externalId).toBe(id);
    const custB = await withOrgTx(appDb(), orgId2, (tx) =>
      tx.select().from(schema.customers).where(and(eq(schema.customers.orgId, orgId2), eq(schema.customers.stripeCustomerId, "cus_ISO"))));
    expect(custB.length).toBe(1);
  });

  it("reconciliation: runs the read-only sync and marks failed events reconciled", async () => {
    const ctx = await ctxFor(rig.owner, rig.slug, "operate");
    // a failed event exists
    const bad = evt({
      type: "customer.subscription.updated",
      object: {
        id: "sub_R", object: "subscription", customer: "cus_absent", status: "active",
        currency: "usd", cancel_at_period_end: false, canceled_at: null, created: 1,
        items: { data: [{ price: { id: "p", currency: "usd", unit_amount: 100, recurring: { interval: "month" } } }] }
      }
    });
    await receive(bad.payload, await generateTestSignatureHeader({ payload: bad.payload, secret: rig.secret }));
    expect((await events(rig.orgId))[0]!.status).toBe("failed");

    const gw = fixtureGateway(rig.world);
    setStripeGatewayForTests(gw);
    const result = await webhooksService.reconcileFromProvider(ctx, { ip: null, userAgent: null }) as {
      summary: Record<string, { status: string }>;
    };
    expect(result.summary).toBeTruthy();
    const rows = await events(rig.orgId);
    expect(rows[0]!.status).toBe("reconciled");
    expect(rows[0]!.lastError).toBeTruthy(); // history retained — honest
  });
});
