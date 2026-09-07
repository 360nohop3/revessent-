/**
 * In-process sliding-window rate limiter for auth routes (§7.1: 5 attempts /
 * 15 min / IP+email). NOTE (documented): the production limiter is Redis-
 * backed and arrives with Phase 4's worker stack; this per-instance limiter
 * is correct for single-instance deployments and tests.
 */
const buckets = new Map<string, number[]>();

export function rateLimit(key: string, max: number, windowMs: number): { ok: boolean; retryAfterSec: number } {
  const now = Date.now();
  const hits = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= max) {
    const retryAfterSec = Math.ceil((windowMs - (now - hits[0]!)) / 1000);
    return { ok: false, retryAfterSec };
  }
  hits.push(now);
  buckets.set(key, hits);
  return { ok: true, retryAfterSec: 0 };
}

/** Test hook. */
export function resetRateLimits(): void {
  buckets.clear();
}

/**
 * §7.1 enforcement for sensitive auth routes: 5 attempts / 15 min / IP+email.
 * Throws a 429 problem+json with Retry-After when exhausted.
 * NOTE (audit §5): process-local by design — Redis-backed distributed
 * limiting is a Phase 4 / production-hardening requirement.
 */
import { ProblemError } from "./problems.js";

const AUTH_MAX = 5;
const AUTH_WINDOW_MS = 15 * 60 * 1000;

export function enforceAuthRateLimit(req: Request, email: string | null, bucket = "auth"): void {
  const fwd = req.headers.get("x-forwarded-for") ?? "";
  const ip = fwd.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown";
  const key = `${bucket}:${ip}:${(email ?? "").toLowerCase()}`;
  const { ok, retryAfterSec } = rateLimit(key, AUTH_MAX, AUTH_WINDOW_MS);
  if (!ok) {
    throw new ProblemError("rate-limited", "Too many attempts. Try again later.", { "retry-after": String(retryAfterSec) });
  }
}
