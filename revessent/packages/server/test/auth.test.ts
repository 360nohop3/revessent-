import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { appDb, auth, getSessionUser } from "@revessent/server";
import * as schema from "@revessent/db";
import { createTestUser, signInCookie, headersWith } from "./helpers";

describe("authentication (real, Better Auth + argon2id + Postgres sessions)", () => {
  it("signs up with a hashed password (never plaintext) and unverified email", async () => {
    const user = await createTestUser("auth-signup");
    expect(user.emailVerified).toBe(false);
    const [account] = await appDb().select().from(schema.account).where(eq(schema.account.userId, user.id));
    expect(account?.password).toBeTruthy();
    expect(account?.password).toMatch(/^\$argon2id\$/);
    expect(account?.password).not.toContain(user.password);
  });

  it("signs in with valid credentials and resolves the session from the cookie", async () => {
    const user = await createTestUser("auth-signin");
    const cookie = await signInCookie(user.email, user.password);
    const resolved = await getSessionUser(headersWith(cookie));
    expect(resolved?.email).toBe(user.email);
    expect(resolved?.id).toBe(user.id);
  });

  it("rejects wrong credentials without setting a session", async () => {
    const user = await createTestUser("auth-bad");
    await expect(signInCookie(user.email, "wrong-password-123")).rejects.toThrow();
  });

  it("signs out: the session stops resolving", async () => {
    const user = await createTestUser("auth-out");
    const cookie = await signInCookie(user.email, user.password);
    expect(await getSessionUser(headersWith(cookie))).toBeTruthy();
    await auth.api.signOut({ headers: headersWith(cookie) });
    expect(await getSessionUser(headersWith(cookie))).toBeNull();
  });

  it("expires sessions: an expired session row no longer authenticates", async () => {
    const user = await createTestUser("auth-exp");
    const cookie = await signInCookie(user.email, user.password);
    // force-expire server-side (the only truth: the DB row)
    await appDb().update(schema.session)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(schema.session.userId, user.id));
    expect(await getSessionUser(headersWith(cookie))).toBeNull();
  });

  it("stores sessions in Postgres (30-day expiry window)", async () => {
    const user = await createTestUser("auth-ttl");
    await signInCookie(user.email, user.password);
    const [session] = await appDb().select().from(schema.session).where(eq(schema.session.userId, user.id));
    const days = (session!.expiresAt.getTime() - session!.createdAt.getTime()) / (24 * 3600 * 1000);
    expect(days).toBeGreaterThanOrEqual(29);
  });
});
