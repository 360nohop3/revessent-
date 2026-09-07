/**
 * PHASE 4D — RETRY ELIGIBILITY, POLICY DEFAULTS AND BACKOFF (pure domain).
 *
 * Architecture §8.4/§8.7/§9.1/§9.2 + §5.3 guards: WHEN to retry is decided by
 * deterministic, auditable rules — never an LLM, never wall-clock randomness.
 * This module is PURE: structured facts in, verdict out. Provider truth is
 * enforced separately at execution time by the Phase 4C boundary (preflight +
 * payment-level lock + post-lock revalidation); eligibility never charges.
 */

export type RetryVerdict = "eligible" | "waiting" | "blocked" | "exhausted" | "disabled";

export interface AutoRetryCategoryRule {
  /** Whether the policy allows a LATER automated attempt after this outcome. */
  retryable: boolean;
  /** Maximum EXECUTED attempts (any initiation) with this outcome category. */
  maxAttempts: number;
}

export interface AutoRetryPolicy {
  /** Outcome category → routing rule (architecture §8.4 per_decline). */
  perCategory: Record<string, AutoRetryCategoryRule>;
  /** Deterministic exponential backoff multiplier (§9.2 fixed curves). */
  backoffMultiplier: number;
  /** Upper bound on a single gap — retries stay conservative. */
  maxBackoffHours: number;
}

/**
 * Default automated-retry routing = architecture §8.4/§8.7 defaults mapped
 * onto the Phase 4C outcome taxonomy. Any category NOT listed is NOT
 * retryable (fail-closed): authentication_required, payment_method_failure,
 * invalid_payment_context, unsupported_provider_state, idempotency_conflict,
 * invalid_credentials, revoked, auth_failure, permission_failure, unknown,
 * malformed_response, no_provider_operation (first re-attempt after a
 * reconciled no-provider result is governed by the generic limits), and all
 * preflight financial refusals. Declines retry ONLY where §8.7 says so.
 */
export const DEFAULT_AUTO_RETRY_POLICY: AutoRetryPolicy = {
  perCategory: {
    insufficient_funds: { retryable: true, maxAttempts: 4 },   // payday-aware (§8.7)
    expired_card: { retryable: true, maxAttempts: 1 },         // token-first, once (§8.7)
    card_declined: { retryable: true, maxAttempts: 3 },        // issuer decline "spread" (§8.7)
    rate_limited: { retryable: true, maxAttempts: 4 },         // rejected pre-execution ('later')
    transient_network: { retryable: true, maxAttempts: 4 },    // provably pre-execution only
    provider_outage: { retryable: true, maxAttempts: 4 }       // provably pre-execution only
  },
  backoffMultiplier: 2,
  maxBackoffHours: 168
};

/** Architecture §8.4 give_up: stop retrying after 21 days from first failure. */
export const GIVE_UP_AFTER_DAYS = 21;
/** Architecture §5.3: cases in exactly these states may execute retries. */
export const RETRYABLE_CASE_STATUSES = new Set(["retrying", "contacting"]);
/** Terminal case states never transition again (guard #5). */
export const TERMINAL_CASE_STATUSES = new Set(["recovered", "lost", "canceled", "dismissed"]);

/** Facts the eligibility decision is made from — all resolved server-side
 *  from local records + persisted outcomes. No UI text, no request bodies. */
export interface RetryFacts {
  caseStatus: string;
  paymentStatus: string;                 // local mirror ("failed" is the retry target)
  connectionActive: boolean;
  hasStripeInvoice: boolean;
  amountValid: boolean;                  // integer > 0 on the local record
  currencyValid: boolean;                // /^[A-Z]{3}$/
  customerMapped: boolean;               // customer.stripe_customer_id present
  /** Executed automated attempts (executing|succeeded|failed|unknown). */
  autoRetryCount: number;
  /** Executed automated attempts per outcome category — manual attempts
   *  NEVER consume the automated category budget (final correction §7). */
  categoryAttemptCounts: Record<string, number>;
  /** The latest executed attempt's outcome category, or — before any automated
   *  attempt exists — the case payment's own decline category, so unlisted /
   *  non-retryable categories fail closed on the FIRST decision (final
   *  correction §6). Null only when neither is known. */
  lastOutcome: { category: string | null } | null;
  /** Any attempt is executing|unknown ⇒ its outcome must be established first. */
  hasUnresolvedExecution: boolean;
  /** When the latest executed attempt finished (backoff anchor; null = none). */
  lastExecutedAt: Date | null;
  /** A scheduled automated attempt exists ⇒ it is resumed, not re-created. */
  hasScheduledAutoAttempt: boolean;
  firstFailedAt: Date;
  now: Date;
}

export interface RetryDecision {
  verdict: RetryVerdict;
  /** Stable machine-readable reason (audit + UI). */
  reason: string;
  /** When an automated attempt becomes possible (waiting/eligible). */
  nextEligibleAt: Date | null;
}

/**
 * The ONE authoritative eligibility decision (brief §4). Deterministic and
 * total: every input combination yields exactly one verdict + reason.
 * Order matters and is documented — safety gates precede policy gates.
 */
export function evaluateRetryEligibility(facts: RetryFacts, policy: {
  maxAutoRetries: number; minGapHours: number; autoRetry: AutoRetryPolicy
}): RetryDecision {
  // --- hard safety gates (case / payment / connection / financial truth)
  if (TERMINAL_CASE_STATUSES.has(facts.caseStatus)) {
    return { verdict: "blocked", reason: "case_terminal", nextEligibleAt: null };
  }
  if (!facts.connectionActive) {
    return { verdict: "disabled", reason: "connection_inactive", nextEligibleAt: null };
  }
  if (!RETRYABLE_CASE_STATUSES.has(facts.caseStatus)) {
    return { verdict: "blocked", reason: "case_not_retryable", nextEligibleAt: null };
  }
  if (facts.paymentStatus === "paid") {
    // provider/local truth already converged — reconcile/transition, never charge
    return { verdict: "blocked", reason: "payment_already_paid", nextEligibleAt: null };
  }
  if (facts.paymentStatus !== "failed") {
    return { verdict: "blocked", reason: "payment_not_retryable", nextEligibleAt: null };
  }
  if (!facts.hasStripeInvoice) {
    return { verdict: "disabled", reason: "no_provider_invoice", nextEligibleAt: null };
  }
  if (!facts.amountValid) {
    return { verdict: "disabled", reason: "amount_unknown", nextEligibleAt: null };
  }
  if (!facts.currencyValid) {
    return { verdict: "disabled", reason: "currency_unknown", nextEligibleAt: null };
  }
  if (!facts.customerMapped) {
    return { verdict: "disabled", reason: "customer_unmapped", nextEligibleAt: null };
  }
  // --- unresolved outcomes are a HARD boundary (§13): unknown → reconcile →
  // paid ⇒ stop; failed ⇒ may become eligible; still unknown ⇒ stay blocked.
  if (facts.hasUnresolvedExecution) {
    return { verdict: "blocked", reason: "unresolved_execution_reconcile_first", nextEligibleAt: null };
  }
  // --- policy gates
  if (policy.maxAutoRetries <= 0) {
    return { verdict: "disabled", reason: "automation_disabled", nextEligibleAt: null };
  }
  if (facts.autoRetryCount >= policy.maxAutoRetries) {
    return { verdict: "exhausted", reason: "max_auto_retries", nextEligibleAt: null };
  }
  const ageDays = Math.floor((facts.now.getTime() - facts.firstFailedAt.getTime()) / 86_400_000);
  if (ageDays >= GIVE_UP_AFTER_DAYS) {
    return { verdict: "exhausted", reason: "give_up_after_days", nextEligibleAt: null };
  }
  // --- outcome routing (§5/§6, final correction): the perCategory rule is
  // the SINGLE retryability authority. A category with no rule, or with
  // retryable=false, fails closed — no invented limits, no taxonomy-based
  // bypasses. Combined with the global gate above, the effective automated
  // limit for a category is min(maxAutoRetries, rule.maxAttempts), and BOTH
  // ceilings must permit another attempt.
  if (facts.lastOutcome?.category) {
    const category = facts.lastOutcome.category;
    const rule = policy.autoRetry.perCategory[category];
    if (!(rule?.retryable === true)) {
      return { verdict: "blocked", reason: `outcome_not_retryable:${category}`, nextEligibleAt: null };
    }
    if ((facts.categoryAttemptCounts[category] ?? 0) >= rule.maxAttempts) {
      return { verdict: "blocked", reason: `category_exhausted:${category}`, nextEligibleAt: null };
    }
  }
  // --- scheduling: deterministic backoff from the last executed attempt
  if (facts.hasScheduledAutoAttempt) {
    // A reserved-but-unexecuted attempt is RESUMED with the same identity —
    // never a second reservation (crash recovery, brief §14/§20).
    return { verdict: "eligible", reason: "resume_scheduled_attempt", nextEligibleAt: facts.now };
  }
  const nextEligibleAt = nextAutoRetryTime(facts, policy, facts.autoRetryCount);
  if (facts.now.getTime() < nextEligibleAt.getTime()) {
    return { verdict: "waiting", reason: "backoff", nextEligibleAt };
  }
  return { verdict: "eligible", reason: "policy_allows_retry", nextEligibleAt: facts.now };
}

/**
 * Deterministic backoff (§9.2 fixed curve, brief §17):
 *   attempt n → minGapHours × multiplier^(n−1), capped at maxBackoffHours.
 * Integer-hour math; the exponent is capped so the product can never
 * overflow into an invalid date. `autoRetryCount` = attempts already made,
 * so the FIRST retry (count 0) waits minGapHours, the second 2×, …
 */
export function backoffDelayHours(autoRetryCount: number, policy: AutoRetryPolicy, minGapHours: number): number {
  const exponent = Math.min(Math.max(1, autoRetryCount + 1) - 1, 16);
  const raw = minGapHours * Math.pow(policy.backoffMultiplier, exponent);
  if (!Number.isFinite(raw) || raw <= 0) return policy.maxBackoffHours;
  return Math.min(Math.floor(raw), policy.maxBackoffHours);
}

/** When the NEXT automated attempt may run (absolute time): the backoff
 *  anchor is the last EXECUTED attempt (or first failure), + delay(n). */
export function nextAutoRetryTime(facts: Pick<RetryFacts, "now" | "lastExecutedAt" | "firstFailedAt">, policy: {
  minGapHours: number; autoRetry: AutoRetryPolicy
}, autoRetryCount = 0): Date {
  const anchor = facts.lastExecutedAt ?? facts.firstFailedAt;
  return new Date(anchor.getTime() + backoffDelayHours(autoRetryCount, policy.autoRetry, policy.minGapHours) * 3_600_000);
}
