/**
 * RFC 9457 problem+json (Architecture v1 §6.1) with stable type URIs.
 * The same shapes the Phase 2 contracts already speak.
 */
import type { Problem } from "@revessent/contracts";

export type ProblemType =
  | "validation" | "unauthorized" | "forbidden" | "not-found" | "conflict"
  | "not-in-this-phase" | "entitlement-required" | "rate-limited" | "csrf" | "internal";

const TITLES: Record<ProblemType, string> = {
  validation: "Validation failed",
  unauthorized: "Sign in required",
  forbidden: "Not allowed",
  "not-found": "Not found",
  conflict: "Conflict",
  "not-in-this-phase": "Not available in this phase",
  "entitlement-required": "Plan upgrade required",
  "rate-limited": "Too many requests",
  csrf: "Cross-origin request blocked",
  internal: "Internal error"
};

const STATUS: Record<ProblemType, number> = {
  validation: 400, unauthorized: 401, forbidden: 403, "not-found": 404,
  conflict: 409, "not-in-this-phase": 501, "entitlement-required": 402,
  "rate-limited": 429, csrf: 403, internal: 500
};

export class ProblemError extends Error {
  readonly problem: Problem;
  readonly headers: Record<string, string>;
  constructor(type: ProblemType, detail?: string, extraHeaders?: Record<string, string>) {
    super(detail ?? TITLES[type]);
    this.problem = { type: `/errors/${type}`, title: TITLES[type], status: STATUS[type], ...(detail ? { detail } : {}) };
    this.headers = extraHeaders ?? {};
  }
}

export function problemResponse(err: ProblemError, instance?: string): Response {
  const body: Problem = { ...err.problem, ...(instance ? { instance } : {}) };
  return new Response(JSON.stringify(body), {
    status: err.problem.status,
    headers: { "content-type": "application/problem+json", ...err.headers }
  });
}

/** Unknown errors become a safe 500 — internals never leak (brief §16). */
export function safeInternalError(): ProblemError {
  return new ProblemError("internal", "Something went wrong. Nothing was changed.");
}
