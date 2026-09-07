/**
 * Auth rate limiting (§7.1: 5 attempts / 15 min / IP+email).
 *
 * Phase 8: the limiter is now DURABLE and SHARED across web instances — one
 * atomic UPSERT on `auth_rate_limits` (0024) per attempt, keyed by a SHA-256
 * of bucket:ip:email (no clear-text IP/address at rest). The Phase 3
 * in-process window is kept ONLY as the fallback when the database call
 * itself fails (it is strictly no weaker than the previous behaviour, and a
 * DB outage already blocks sign-in since sessions live in Postgres).
 */
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Db } from "@revessent/db";
import { ProblemError } from "./problems.js";

const buckets = new Map<string, number[]>();

/** In-process sliding window (fallback + unit tests). */
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

/** Test hook (memory window only; the durable table is per-key and self-resetting). */
export function resetRateLimits(): void {
  buckets.clear();
}

const AUTH_MAX = 5;
const AUTH_WINDOW_MS = 15 * 60 * 1000;

export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for") ?? "";
  return fwd.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown";
}

function keyFor(req: Request, email: string | null, bucket: string): string {
  return `${bucket}:${clientIp(req)}:${(email ?? "").toLowerCase()}`;
}

/**
 * Durable fixed-window check: ONE statement, atomic under concurrency. Returns
 * the hit count inside the current window (after counting this attempt).
 */
export async function durableRateLimit(db: Db, key: string, max: number, windowMs: number): Promise<{ ok: boolean; retryAfterSec: number }> {
  const keyHash = createHash("sha256").update(key).digest("hex");
  const res = await db.execute(sql`
    insert into auth_rate_limits (key_hash, window_start, hits) values (${keyHash}, now(), 1)
    on conflict (key_hash) do update set
      hits = case when auth_rate_limits.window_start < now() - make_interval(secs => ${windowMs / 1000}) then 1 else auth_rate_limits.hits + 1 end,
      window_start = case when auth_rate_limits.window_start < now() - make_interval(secs => ${windowMs / 1000}) then now() else auth_rate_limits.window_start end
    returning hits, extract(epoch from (window_start + make_interval(secs => ${windowMs / 1000}) - now()))::int as retry_after`);
  const row = res.rows[0] as { hits: number; retry_after: number };
  return Number(row.hits) > max
    ? { ok: false, retryAfterSec: Math.max(1, Number(row.retry_after)) }
    : { ok: true, retryAfterSec: 0 };
}

/** Synchronous, process-local form (kept for the fallback path and existing unit tests). */
export function enforceAuthRateLimit(req: Request, email: string | null, bucket = "auth"): void {
  const { ok, retryAfterSec } = rateLimit(keyFor(req, email, bucket), AUTH_MAX, AUTH_WINDOW_MS);
  if (!ok) throw new ProblemError("rate-limited", "Too many attempts. Try again later.", { "retry-after": String(retryAfterSec) });
}

/**
 * Production form: durable + shared. Throws 429 problem+json with Retry-After.
 * Falls back to the process-local window only if the database call fails.
 */
export async function enforceAuthRateLimitDurable(db: Db, req: Request, email: string | null, bucket = "auth"): Promise<void> {
  const key = keyFor(req, email, bucket);
  let verdict: { ok: boolean; retryAfterSec: number };
  try {
    verdict = await durableRateLimit(db, key, AUTH_MAX, AUTH_WINDOW_MS);
  } catch {
    verdict = rateLimit(key, AUTH_MAX, AUTH_WINDOW_MS);
  }
  if (!verdict.ok) throw new ProblemError("rate-limited", "Too many attempts. Try again later.", { "retry-after": String(verdict.retryAfterSec) });
}
