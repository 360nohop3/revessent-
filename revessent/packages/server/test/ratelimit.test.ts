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
