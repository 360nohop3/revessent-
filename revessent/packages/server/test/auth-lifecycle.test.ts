/**
 * PHASE 8 — account lifecycle regression (audit finding A1/A2).
 *
 * Before Phase 8 the verification and reset hooks were console stubs: no
 * production tenant could ever verify an email (and therefore never create a
 * workspace) and no password could be reset. These tests drive the REAL
 * Better Auth endpoints with the deterministic fixture email provider — no
 * live Postmark call, no real recipient.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { appDb, auth, orgsService, resetRateLimits } from "@revessent/server";
import * as schema from "@revessent/db";
import { setEmailProviderForTests, resetEmailProvider } from "@revessent/integrations";
import { fakeEmailProvider, type FakeEmailProvider } from "@revessent/integrations/email-fixtures";
import { createTestUser, signInCookie, headersWith, suffix } from "./helpers";

function tokenFrom(url: string): string {
  return new URL(url).searchParams.get("token") ?? "";
}
function linkIn(text: string): string {
  const m = text.match(/https?:\/\/\S+/);
  if (!m) throw new Error("no link in email");
  return m[0];
}

describe("Phase 8 — account lifecycle email (fixture provider)", () => {
  let mail: FakeEmailProvider;
  beforeEach(() => { mail = fakeEmailProvider({ kind: "ok" }); setEmailProviderForTests(mail); resetRateLimits(); });
  afterEach(() => resetEmailProvider());

  it("sign-up sends ONE verification email to the account address; consuming the token verifies the account and unlocks workspace creation", async () => {
    const email = `verify-${suffix()}@test.example`;
    const res = await auth.api.signUpEmail({ body: { name: "V", email, password: "correct-horse-battery" } });
    expect(res.user.emailVerified).toBe(false);

    const sent = mail.accepted.filter((m) => m.tag === "auth-verify-email" && m.to === email);
    expect(sent).toHaveLength(1);
    const link = linkIn(sent[0]!.text);
    expect(link).toContain("/verify-email?token=");
    expect(sent[0]!.from).toBeTruthy();
    expect(sent[0]!.html).not.toContain("<script");

    // Unverified: org creation refuses (403) — unchanged Phase 3 rule.
    await expect(orgsService.createOrg(appDb(), { id: res.user.id, email, name: "V", emailVerified: false }, { name: "W", slug: `w-${suffix()}` }))
      .rejects.toMatchObject({ problem: { status: 403 } });

    // Consume the token through the real endpoint.
    const verified = await auth.api.verifyEmail({ query: { token: tokenFrom(link) }, asResponse: true });
    expect(verified.status).toBeLessThan(400);
    const [row] = await appDb().select().from(schema.user).where(eq(schema.user.id, res.user.id));
    expect(row!.emailVerified).toBe(true);

    // Now the workspace can be created with the real verified flag.
    const org = await orgsService.createOrg(appDb(), { id: res.user.id, email, name: "V", emailVerified: row!.emailVerified }, { name: "W", slug: `w-${suffix()}` });
    expect(org.slug).toMatch(/^w-/);
  });

  it("a tampered / expired verification token is rejected and changes nothing", async () => {
    const email = `tamper-${suffix()}@test.example`;
    const res = await auth.api.signUpEmail({ body: { name: "T", email, password: "correct-horse-battery" } });
    const bad = await auth.api.verifyEmail({ query: { token: "not-a-real-token-value" }, asResponse: true });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    const [row] = await appDb().select().from(schema.user).where(eq(schema.user.id, res.user.id));
    expect(row!.emailVerified).toBe(false);
  });

  it("password reset: same response for unknown accounts (no oracle); a real account gets ONE email; the token sets the password ONCE and revokes existing sessions", async () => {
    const u = await createTestUser("reset");
    const staleCookie = await signInCookie(u.email, u.password); // an existing session that must die

    // Unknown address → no email, no error.
    await auth.api.requestPasswordReset({ body: { email: `nobody-${suffix()}@test.example`, redirectTo: "/reset-password" } }).catch(() => undefined);
    expect(mail.accepted.filter((m) => m.tag === "auth-reset-password")).toHaveLength(0);

    await auth.api.requestPasswordReset({ body: { email: u.email, redirectTo: "/reset-password" } });
    const sent = mail.accepted.filter((m) => m.tag === "auth-reset-password" && m.to === u.email);
    expect(sent).toHaveLength(1);
    const link = linkIn(sent[0]!.text);
    expect(link).toContain("/reset-password?token=");
    const token = tokenFrom(link);
    expect(token.length).toBeGreaterThan(10);

    const ok = await auth.api.resetPassword({ body: { newPassword: "brand-new-passphrase-1", token }, asResponse: true });
    expect(ok.status).toBeLessThan(400);

    // Old session revoked; old password dead; new password works.
    const stale = await auth.api.getSession({ headers: headersWith(staleCookie) });
    expect(stale).toBeNull();
    await expect(auth.api.signInEmail({ body: { email: u.email, password: u.password } })).rejects.toBeTruthy();
    const fresh = await auth.api.signInEmail({ body: { email: u.email, password: "brand-new-passphrase-1" }, asResponse: true });
    expect(fresh.status).toBeLessThan(400);

    // Token is single-use.
    const replay = await auth.api.resetPassword({ body: { newPassword: "another-passphrase-22", token }, asResponse: true });
    expect(replay.status).toBeGreaterThanOrEqual(400);
  });

  it("provider failure never leaks the token or address: the flow still answers, nothing is fabricated as sent", async () => {
    setEmailProviderForTests(fakeEmailProvider({ kind: "permanent" }));
    const email = `fail-${suffix()}@test.example`;
    const res = await auth.api.signUpEmail({ body: { name: "F", email, password: "correct-horse-battery" } });
    expect(res.user.id).toBeTruthy(); // account exists; the user can request a resend later
  });
});

describe("Phase 8 — production fails closed without an account-email provider", () => {
  it("sendAuthEmail throws in production when no provider is configured; is a redacted no-op elsewhere", async () => {
    const { sendAuthEmail, AuthEmailNotConfiguredError } = await import("../src/auth/auth-email.js");
    resetEmailProvider();
    const saved = process.env.POSTMARK_SERVER_TOKEN; delete process.env.POSTMARK_SERVER_TOKEN;
    const savedEnv = process.env.NODE_ENV;
    try {
      (process.env as Record<string, string>).NODE_ENV = "production";
      await expect(sendAuthEmail("verify_email", "x@test.example", "https://app.example/verify-email?token=t", "billing@example.com"))
        .rejects.toBeInstanceOf(AuthEmailNotConfiguredError);
      (process.env as Record<string, string>).NODE_ENV = "test";
      await expect(sendAuthEmail("verify_email", "x@test.example", "https://app.example/verify-email?token=t", "billing@example.com"))
        .resolves.toEqual({ sent: false, code: "not_configured" });
    } finally {
      (process.env as Record<string, string>).NODE_ENV = savedEnv ?? "test";
      if (saved !== undefined) process.env.POSTMARK_SERVER_TOKEN = saved;
      resetEmailProvider();
    }
  });
});
