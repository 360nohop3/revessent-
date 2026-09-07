import { describe, expect, it } from "vitest";
import { verifyStripeWebhook, generateTestSignatureHeader, WEBHOOK_TOLERANCE_SECONDS } from "@revessent/integrations";

/**
 * PHASE 4B — signature-verification unit layer (no DB): the OFFICIAL SDK
 * verification primitive is exercised for every safe failure shape and the
 * §7.5 replay-tolerance boundary. The receive path (service + RLS + domain)
 * is covered end-to-end in packages/server/test/webhook-receive.test.ts.
 */
const SECRET = "whsec_unit_test_secret";
const EVENT = JSON.stringify({
  id: "evt_unit_1", object: "event", api_version: "2024-06-20",
  created: Math.floor(Date.now() / 1000), data: { object: { id: "cus_1", object: "customer" } },
  livemode: false, pending_webhooks: 1, request: { id: null, idempotency_key: null },
  type: "customer.updated"
});

describe("verifyStripeWebhook (official SDK, raw body)", () => {
  it("accepts an officially signed fresh event", async () => {
    const sig = await generateTestSignatureHeader({ payload: EVENT, secret: SECRET });
    const out = await verifyStripeWebhook(EVENT, sig, SECRET);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.event.id).toBe("evt_unit_1");
      expect(out.event.type).toBe("customer.updated");
      expect(out.event.livemode).toBe(false);
    }
  });

  it("constant rejections: missing header / malformed header / wrong secret / tampered body", async () => {
    const sig = await generateTestSignatureHeader({ payload: EVENT, secret: SECRET });

    const missing = await verifyStripeWebhook(EVENT, null, SECRET);
    expect(missing).toMatchObject({ ok: false, code: "missing_signature" });

    const malformed = await verifyStripeWebhook(EVENT, "v1=only", SECRET);
    expect(malformed).toMatchObject({ ok: false, code: "invalid_signature" }); // safe code either way

    const wrong = await verifyStripeWebhook(EVENT, sig, "whsec_different");
    expect(wrong).toMatchObject({ ok: false, code: "invalid_signature" });

    const tampered = await verifyStripeWebhook(EVENT.replace("cus_1", "cus_2"), sig, SECRET);
    expect(tampered).toMatchObject({ ok: false, code: "invalid_signature" });
  });

  it("replay window §7.5: at tolerance accepted, past tolerance stale, override honored", async () => {
    const now = Math.floor(Date.now() / 1000);
    const at = await generateTestSignatureHeader({ payload: EVENT, secret: SECRET, timestampSeconds: now - WEBHOOK_TOLERANCE_SECONDS });
    expect(await verifyStripeWebhook(EVENT, at, SECRET)).toMatchObject({ ok: true });

    const past = await generateTestSignatureHeader({ payload: EVENT, secret: SECRET, timestampSeconds: now - WEBHOOK_TOLERANCE_SECONDS - 1 });
    const out = await verifyStripeWebhook(EVENT, past, SECRET);
    expect(out).toMatchObject({ ok: false, code: "stale_timestamp" });

    const lenient = await verifyStripeWebhook(EVENT, past, SECRET, WEBHOOK_TOLERANCE_SECONDS + 60);
    expect(lenient).toMatchObject({ ok: true }); // override exists for tests/ops, default stays 300
  });

  it("malformed payload is rejected with a safe code (never a crash)", async () => {
    const sig = await generateTestSignatureHeader({ payload: "{nope", secret: SECRET });
    const out = await verifyStripeWebhook("{nope", sig, SECRET);
    expect(out).toMatchObject({ ok: false, code: "malformed_payload" });
  });
});

describe("describeStripeEvent (safe extraction, lazy normalizers)", () => {
  it("extracts identity + object coordinates for a customer event", async () => {
    const sig = await generateTestSignatureHeader({ payload: EVENT, secret: SECRET });
    const verdict = await verifyStripeWebhook(EVENT, sig, SECRET);
    if (!verdict.ok) throw new Error("expected ok");
    const d = verdict.event; // already described by verify
    expect(d.objectType).toBe("customer");
    expect(d.objectId).toBe("cus_1");
    expect(d.customer).not.toBeNull();
    expect(d.customer!().id).toBe("cus_1");
  });

  it("non-object payloads are guarded — no fabricated coordinates or accessors", async () => {
    const weird = JSON.stringify({
      id: "evt_unit_2", object: "event", created: Math.floor(Date.now() / 1000),
      data: { object: "not-an-object" }, livemode: false, type: "customer.updated"
    });
    const sig = await generateTestSignatureHeader({ payload: weird, secret: SECRET });
    const verdict = await verifyStripeWebhook(weird, sig, SECRET);
    if (!verdict.ok) throw new Error("expected ok");
    const d = verdict.event;
    expect(d.objectId).toBeNull();      // object-kind guard: no id from a string "object"
    expect(d.customer).toBeNull();      // and no accessor over garbage
  });

  it("payload round-trips losslessly for durable storage (raw provenance)", async () => {
    const sig = await generateTestSignatureHeader({ payload: EVENT, secret: SECRET });
    const verdict = await verifyStripeWebhook(EVENT, sig, SECRET);
    if (!verdict.ok) throw new Error("expected ok");
    expect(verdict.event.payload).toEqual(JSON.parse(EVENT));
  });
});
