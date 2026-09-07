/**
 * Better Auth (Architecture v1 §3/§7.1) — identity core only: user, session,
 * account (credentials), verification. Organizations/memberships/RBAC stay in
 * OUR §5.2 tables (see docs/phase3-gap-analysis.md row 4 — using Better Auth's
 * orgs plugin would create a second source of truth for the same rows).
 *
 * Cookie: rv.session_token — HttpOnly, Secure in production, SameSite=Lax,
 * 30-day sliding expiry (§7.1). Passwords: argon2id via @noble/hashes.
 */
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { serverEnv, isProduction } from "@revessent/config";
import { createDb } from "@revessent/db";
import * as schema from "@revessent/db";
import { hashPassword, verifyPassword } from "../crypto/argon2.js";

/**
 * Lazy singleton: Next.js imports route modules during `build` (page-data
 * collection), which must not require runtime env. First real request
 * initializes the instance (fail-loud is preserved at request time).
 */
type AuthInstance = ReturnType<typeof buildAuth>;

let instance: AuthInstance | null = null;

function getAuth(): AuthInstance {
  instance ??= buildAuth();
  return instance;
}

function buildAuth() {
const env = serverEnv();

return betterAuth({
  appName: "Revessent",
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  database: drizzleAdapter(createDb(env.APP_DATABASE_URL ?? env.DATABASE_URL), {
    provider: "pg",
    schema: {
      user: schema.user,
      session: schema.session,
      account: schema.account,
      verification: schema.verification
    }
  }),
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 10,
    requireEmailVerification: false, // sign-in allowed; ORG CREATION is gated on verified email (§7.1)
    password: {
      hash: async (password: string) => hashPassword(password, {
        memoryKiB: env.ARGON2_MEMORY_KIB, time: env.ARGON2_TIME, parallelism: env.ARGON2_PARALLELISM
      }),
      verify: async ({ password, hash }: { password: string; hash: string }) => verifyPassword(password, hash)
    },
    sendResetPassword: async ({ user }: { user: { email: string } }) => {
      // CONTRACT ONLY (brief §18): production email arrives with Phase 4.
      console.info(`[auth] password-reset token issued for ${user.email} — email sending arrives in Phase 4`);
    }
  },
  emailVerification: {
    sendVerificationEmail: async ({ user }: { user: { email: string } }) => {
      // CONTRACT ONLY (brief §7/§18): the verification token row is persisted by
      // Better Auth; nothing is sent until Phase 4.
      console.info(`[auth] verification token issued for ${user.email} — email sending arrives in Phase 4`);
    }
  },
  session: {
    expiresIn: 60 * 60 * 24 * 30, // 30 days (§7.1)
    updateAge: 60 * 60 * 24        // sliding: refreshed daily on activity
  },
  advanced: {
    cookiePrefix: "rv",
    useSecureCookies: isProduction(),
    defaultCookieAttributes: { sameSite: "lax", path: "/" }
  },
  rateLimit: { enabled: true, window: 900, max: 5, storage: "memory" } // §7.1 auth limits
});
}

/**
 * Stable identity for the lazy instance. Call sites keep `auth.api.*`;
 * property access triggers (one-time) initialization.
 */
export const auth = new Proxy({} as AuthInstance, {
  get(_target, prop) {
    const real = getAuth() as unknown as Record<string | symbol, unknown>;
    const value = real[prop];
    return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(real) : value;
  }
});

export type Auth = typeof auth;
