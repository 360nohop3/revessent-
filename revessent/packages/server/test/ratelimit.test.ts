import { describe, expect, it, beforeEach } from "vitest";
import { enforceAuthRateLimit, resetRateLimits } from "@revessent/server";

/**
 * AUDIT §5: the §7.1 limiter is enforced on sensitive auth routes
 * (sign-in / sign-up / request-password-reset): 5 attempts / 15 min / IP+email.
 * Deliberately PROCESS-LOCAL — Redis-backed distributed limiting is a Phase 4
 * production-hardening requirement (docs/phase3-gap-analysis.md row 16).
 */
describe("auth rate limiting (process-local, §7.1)", () => {
  beforeEach(() => resetRateLimits());

  function req(ip: string): Request {
    return new Request("http://localhost:3000/api/v1/auth/sign-in", {
      method: "POST", headers: { "x-forwarded-for": ip }
    });
  }

  it("allows 5 attempts then answers 429 with Retry-After", () => {
    const r = req("203.0.113.7");
    for (let i = 0; i < 5; i++) {
      enforceAuthRateLimit(r, "user@test.example");
    }
    expect(() => enforceAuthRateLimit(r, "user@test.example"))
      .toThrowError(/Too many attempts/);
    try {
      enforceAuthRateLimit(r, "user@test.example");
    } catch (e) {
      const err = e as { problem?: { status?: number; type?: string }; headers?: Record<string, string> };
      expect(err.problem?.status).toBe(429);
      expect(err.problem?.type).toBe("/errors/rate-limited");
      expect(Number(err.headers?.["retry-after"])).toBeGreaterThan(0);
    }
  });

  it("keys by IP+email: a different email or IP is unaffected", () => {
    const r = req("203.0.113.8");
    for (let i = 0; i < 5; i++) enforceAuthRateLimit(r, "one@test.example");
    expect(() => enforceAuthRateLimit(r, "one@test.example")).toThrow();
    expect(() => enforceAuthRateLimit(r, "two@test.example")).not.toThrow();
    expect(() => enforceAuthRateLimit(req("198.51.100.9"), "one@test.example")).not.toThrow();
  });
});

describe("Phase 8 — durable, shared auth rate limit (0024)", () => {
  it("admits exactly 5 of 20 CONCURRENT attempts for one IP+email, then answers 429 with Retry-After; a different IP is independent", async () => {
    const { appDb, durableRateLimit, enforceAuthRateLimitDurable } = await import("@revessent/server");
    const key = `test:${Math.random().toString(36).slice(2)}:user@test.example`;
    const results = await Promise.all(Array.from({ length: 20 }, () => durableRateLimit(appDb(), key, 5, 60_000)));
    expect(results.filter((r) => r.ok)).toHaveLength(5);
    expect(results.filter((r) => !r.ok && r.retryAfterSec >= 1)).toHaveLength(15);

    const ip = `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`;
    const email = `dur-${Math.random().toString(36).slice(2)}@test.example`;
    const req = (addr: string) => new Request("http://x/api/v1/auth/sign-in", { method: "POST", headers: { "x-forwarded-for": addr } });
    for (let i = 0; i < 5; i++) await enforceAuthRateLimitDurable(appDb(), req(ip), email);
    await expect(enforceAuthRateLimitDurable(appDb(), req(ip), email)).rejects.toMatchObject({ problem: { status: 429 } });
    await expect(enforceAuthRateLimitDurable(appDb(), req(ip + "1"), email)).resolves.toBeUndefined();
  });

  it("stores only a hash — no IP or email at rest", async () => {
    const { appDb } = await import("@revessent/server");
    const { sql } = await import("drizzle-orm");
    const rows = await appDb().execute(sql`select key_hash from auth_rate_limits where key_hash ~ '@' or key_hash ~ '\\.' limit 1`);
    expect(rows.rows).toHaveLength(0);
  });
});
