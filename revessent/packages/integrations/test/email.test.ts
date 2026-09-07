/**
 * Phase 6 — email provider boundary: header-injection guards, fixture
 * provider semantics (idempotent replay by reference, failure classes) and
 * the Postmark adapter's classification of HTTP outcomes via a stubbed fetch
 * (no network; the token never leaves the closure into errors or logs).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertSafeOutboundEmail, EmailProviderError, postmarkProvider, type OutboundEmail } from "@revessent/integrations";
import { fakeEmailProvider } from "@revessent/integrations/email-fixtures";

const msg = (over: Partial<OutboundEmail> = {}): OutboundEmail => ({
  to: "member@example.test", from: "billing@notifications.revessent.test", replyTo: null,
  subject: "Your payment", text: "Hello", html: "<p>Hello</p>", idempotencyReference: "ref-1", tag: "recovery-dunning_note", ...over
});

describe("outbound email guards", () => {
  it("rejects header injection in to/from/reply-to/subject", () => {
    for (const bad of ["a@b.co\r\nBcc: x@y.z", "a@b.co\nX: y", "a@b.co, c@d.e", "Name <a@b.co>", "a b@c.d"]) {
      expect(() => assertSafeOutboundEmail(msg({ to: bad }))).toThrow(EmailProviderError);
      expect(() => assertSafeOutboundEmail(msg({ from: bad }))).toThrow(EmailProviderError);
      expect(() => assertSafeOutboundEmail(msg({ replyTo: bad }))).toThrow(EmailProviderError);
    }
    expect(() => assertSafeOutboundEmail(msg({ subject: "Hi\r\nBcc: x@y.z" }))).toThrow(/header/i);
    expect(() => assertSafeOutboundEmail(msg({ subject: "" }))).toThrow(EmailProviderError);
    expect(() => assertSafeOutboundEmail(msg({ subject: "x".repeat(201) }))).toThrow(EmailProviderError);
    expect(() => assertSafeOutboundEmail(msg({ text: "  " }))).toThrow(EmailProviderError);
    expect(() => assertSafeOutboundEmail(msg())).not.toThrow();
  });
});

describe("fixture email provider", () => {
  it("accepts once and replays idempotently by reference", async () => {
    const p = fakeEmailProvider({ kind: "ok" });
    const a = await p.send(msg());
    const b = await p.send(msg());
    expect(a.replayed).toBe(false);
    expect(b.replayed).toBe(true);
    expect(b.providerMessageId).toBe(a.providerMessageId);
    expect(p.accepted).toHaveLength(1);
    expect(p.attempts).toHaveLength(2);
    expect(p.findByReference("ref-1")).toBe(a.providerMessageId);
    expect(p.findByReference("nope")).toBeNull();
  });
  it("failure classes", async () => {
    await expect(fakeEmailProvider({ kind: "transient" }).send(msg())).rejects.toMatchObject({ kind: "transient" });
    await expect(fakeEmailProvider({ kind: "permanent" }).send(msg())).rejects.toMatchObject({ kind: "permanent" });
    await expect(fakeEmailProvider({ kind: "configuration" }).send(msg())).rejects.toMatchObject({ kind: "configuration", code: "auth_failure" });
    const acc = fakeEmailProvider({ kind: "ambiguous_accepted" });
    await expect(acc.send(msg())).rejects.toMatchObject({ kind: "ambiguous" });
    expect(acc.findByReference("ref-1")).not.toBeNull(); // it DID go out
    const lost = fakeEmailProvider({ kind: "ambiguous_lost" });
    await expect(lost.send(msg())).rejects.toMatchObject({ kind: "ambiguous" });
    expect(lost.findByReference("ref-1")).toBeNull();
  });
  it("guards run before the fake too", async () => {
    await expect(fakeEmailProvider({ kind: "ok" }).send(msg({ to: "a@b.co\nBcc: c@d.e" }))).rejects.toMatchObject({ code: "header_injection" });
  });
});

describe("postmark adapter (stubbed fetch, no network)", () => {
  afterEach(() => vi.unstubAllGlobals());
  const TOKEN = "pm-secret-token-0123456789";
  function stub(status: number, body: unknown, opts: { throwName?: string } = {}) {
    const fn = vi.fn(async () => {
      if (opts.throwName) { const e = new Error("boom"); e.name = opts.throwName; throw e; }
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    });
    vi.stubGlobal("fetch", fn);
    return fn;
  }
  it("200 with MessageID ⇒ sent; token is sent as a header only, tracking disabled, metadata carries the reference", async () => {
    const fetchFn = stub(200, { MessageID: "pm-1" });
    const r = await postmarkProvider({ serverToken: TOKEN }).send(msg());
    expect(r).toEqual({ providerMessageId: "pm-1", provider: "postmark", replayed: false });
    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)["X-Postmark-Server-Token"]).toBe(TOKEN);
    const sent = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(sent.TrackOpens).toBe(false);
    expect(sent.TrackLinks).toBe("None");
    expect(sent.Metadata).toEqual({ reference: "ref-1" });
    expect(JSON.stringify(sent)).not.toContain(TOKEN);
  });
  it("classifies: 429 transient, 401/403 configuration, 5xx ambiguous, 422 permanent (with code), timeout ambiguous, 200-without-id ambiguous", async () => {
    const p = postmarkProvider({ serverToken: TOKEN, timeoutMs: 50 });
    stub(429, {}); await expect(p.send(msg())).rejects.toMatchObject({ kind: "transient", code: "rate_limited" });
    stub(401, {}); await expect(p.send(msg())).rejects.toMatchObject({ kind: "configuration", code: "auth_failure" });
    stub(403, {}); await expect(p.send(msg())).rejects.toMatchObject({ kind: "configuration", code: "auth_failure" });
    stub(503, {}); await expect(p.send(msg())).rejects.toMatchObject({ kind: "ambiguous", code: "provider_outage" });
    stub(422, { ErrorCode: 300 }); await expect(p.send(msg())).rejects.toMatchObject({ kind: "permanent", code: "invalid_recipient" });
    stub(422, { ErrorCode: 406 }); await expect(p.send(msg())).rejects.toMatchObject({ kind: "permanent", code: "recipient_suppressed" });
    stub(422, { ErrorCode: 1 }); await expect(p.send(msg())).rejects.toMatchObject({ kind: "permanent", code: "content_rejected" });
    stub(0, {}, { throwName: "AbortError" }); await expect(p.send(msg())).rejects.toMatchObject({ kind: "ambiguous", code: "timeout_after_send" });
    stub(200, {}); await expect(p.send(msg())).rejects.toMatchObject({ kind: "ambiguous", code: "unknown_provider_state" });
  });
  it("error messages never include the token or the recipient", async () => {
    stub(422, { ErrorCode: 300, Message: "The 'To' address member@example.test is invalid" });
    const err = await postmarkProvider({ serverToken: TOKEN }).send(msg()).catch((e: Error) => e);
    expect(String((err as Error).message)).not.toContain(TOKEN);
    expect(String((err as Error).message)).not.toContain("member@example.test");
  });
  it("guards run before any request is made", async () => {
    const fetchFn = stub(200, { MessageID: "x" });
    await expect(postmarkProvider({ serverToken: TOKEN }).send(msg({ to: "a@b.co\r\nBcc: x@y.z" }))).rejects.toMatchObject({ code: "header_injection" });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
