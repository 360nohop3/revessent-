/**
 * PHASE 4D — PURE RETRY ELIGIBILITY + BACKOFF (deterministic, no I/O).
 * Every retryable and non-retryable category, the gate ordering, the
 * give-up window, and the exact backoff curve (brief §24).
 */
import { describe, expect, it } from "vitest";
import {
  evaluateRetryEligibility, backoffDelayHours, nextAutoRetryTime,
  DEFAULT_AUTO_RETRY_POLICY, GIVE_UP_AFTER_DAYS
} from "../src/retry.js";
import type { RetryFacts } from "../src/retry.js";

const NOW = new Date("2026-09-06T10:00:00Z");
const POLICY = {
  maxAutoRetries: 3,
  minGapHours: 48,
  autoRetry: DEFAULT_AUTO_RETRY_POLICY
};

function facts(overrides: Partial<RetryFacts> = {}): RetryFacts {
  return {
    caseStatus: "retrying",
    paymentStatus: "failed",
    connectionActive: true,
    hasStripeInvoice: true,
    amountValid: true,
    currencyValid: true,
    customerMapped: true,
    autoRetryCount: 0,
    categoryAttemptCounts: {},
    lastOutcome: null,
    hasUnresolvedExecution: false,
    hasScheduledAutoAttempt: false,
    lastExecutedAt: null,
    firstFailedAt: new Date(NOW.getTime() - 3600_000),
    now: NOW,
    ...overrides
  };
}

describe("retry eligibility — hard safety gates", () => {
  it("terminal cases never retry (guard #5)", () => {
    for (const status of ["recovered", "lost", "canceled", "dismissed"]) {
      expect(evaluateRetryEligibility(facts({ caseStatus: status }), POLICY).reason).toBe("case_terminal");
    }
  });
  it("inactive/revoked connection disables automation", () => {
    expect(evaluateRetryEligibility(facts({ connectionActive: false }), POLICY))
      .toMatchObject({ verdict: "disabled", reason: "connection_inactive" });
  });
  it("cases outside retrying|contacting are blocked (guard #4)", () => {
    expect(evaluateRetryEligibility(facts({ caseStatus: "analyzing" }), POLICY).reason).toBe("case_not_retryable");
  });
  it("a paid payment blocks (converge, never charge again)", () => {
    expect(evaluateRetryEligibility(facts({ paymentStatus: "paid" }), POLICY).reason).toBe("payment_already_paid");
  });
  it("non-failed, non-paid payment states block", () => {
    expect(evaluateRetryEligibility(facts({ paymentStatus: "open" }), POLICY).reason).toBe("payment_not_retryable");
  });
  it("missing invoice/amount/currency/customer disable automation (no invented values)", () => {
    expect(evaluateRetryEligibility(facts({ hasStripeInvoice: false }), POLICY).reason).toBe("no_provider_invoice");
    expect(evaluateRetryEligibility(facts({ amountValid: false }), POLICY).reason).toBe("amount_unknown");
    expect(evaluateRetryEligibility(facts({ currencyValid: false }), POLICY))
      .toMatchObject({ verdict: "disabled", reason: "currency_unknown" });
    expect(evaluateRetryEligibility(facts({ customerMapped: false }), POLICY))
      .toMatchObject({ verdict: "disabled", reason: "customer_unmapped" });
  });
});

describe("retry eligibility — unknown outcomes are a hard boundary", () => {
  it("an unresolved (executing|unknown) execution blocks until reconciled", () => {
    const d = evaluateRetryEligibility(facts({ hasUnresolvedExecution: true }), POLICY);
    expect(d).toMatchObject({ verdict: "blocked", reason: "unresolved_execution_reconcile_first" });
  });
  it("an unknown last outcome is never retryable even with attempts left", () => {
    const d = evaluateRetryEligibility(facts({
      lastOutcome: { category: "unknown" }
    }), POLICY);
    expect(d.reason).toBe("outcome_not_retryable:unknown");
  });
});

describe("retry eligibility — policy limits", () => {
  it("maxAutoRetries 0 disables automation", () => {
    expect(evaluateRetryEligibility(facts(), { ...POLICY, maxAutoRetries: 0 }).reason).toBe("automation_disabled");
  });
  it("at the cap the case is exhausted", () => {
    const d = evaluateRetryEligibility(facts({ autoRetryCount: 3 }), POLICY);
    expect(d).toMatchObject({ verdict: "exhausted", reason: "max_auto_retries" });
  });
  it("a fresh case waits out the first gap, then becomes eligible", () => {
    // anchor = first failure (1h ago) → first retry due 48h after failure
    const d = evaluateRetryEligibility(facts(), POLICY);
    expect(d.verdict).toBe("waiting");
    expect(d.reason).toBe("backoff");
    expect(d.nextEligibleAt?.getTime()).toBe(facts().firstFailedAt.getTime() + 48 * 3600_000);
    // once the gap has elapsed → eligible
    const due = evaluateRetryEligibility(facts({
      firstFailedAt: new Date(NOW.getTime() - 3 * 86_400_000)
    }), POLICY);
    expect(due).toMatchObject({ verdict: "eligible", reason: "policy_allows_retry" });
  });
  it("give-up window (21d) exhausts the case", () => {
    const d = evaluateRetryEligibility(facts({
      firstFailedAt: new Date(NOW.getTime() - (GIVE_UP_AFTER_DAYS + 1) * 86_400_000)
    }), POLICY);
    expect(d).toMatchObject({ verdict: "exhausted", reason: "give_up_after_days" });
  });
});

describe("retry eligibility — outcome routing (§5/§6, final correction: rule is the sole authority)", () => {
  const cases: Array<[string, string]> = [
    ["insufficient_funds", "policy_allows_retry"],
    ["expired_card", "policy_allows_retry"],
    ["card_declined", "policy_allows_retry"],
    ["rate_limited", "policy_allows_retry"],
    ["transient_network", "policy_allows_retry"],
    ["authentication_required", "outcome_not_retryable:authentication_required"],
    ["payment_method_failure", "outcome_not_retryable:payment_method_failure"],
    ["invalid_payment_context", "outcome_not_retryable:invalid_payment_context"],
    ["unsupported_provider_state", "outcome_not_retryable:unsupported_provider_state"],
    ["idempotency_conflict", "outcome_not_retryable:idempotency_conflict"],
    ["invalid_credentials", "outcome_not_retryable:invalid_credentials"],
    ["revoked", "outcome_not_retryable:revoked"],
    ["provider_customer_mismatch", "outcome_not_retryable:provider_customer_mismatch"],
    ["provider_currency_mismatch", "outcome_not_retryable:provider_currency_mismatch"],
    ["provider_amount_mismatch", "outcome_not_retryable:provider_amount_mismatch"],
    ["provider_invoice_already_paid", "outcome_not_retryable:provider_invoice_already_paid"],
    ["provider_invoice_void", "outcome_not_retryable:provider_invoice_void"],
    ["malformed_response", "outcome_not_retryable:malformed_response"]
  ];
  for (const [category, expected] of cases) {
    it(`${category} → ${expected}`, () => {
      const d = evaluateRetryEligibility(facts({
        lastOutcome: { category },
        lastExecutedAt: new Date(NOW.getTime() - 10 * 86_400_000) // backoff long elapsed
      }), POLICY);
      expect(d.reason).toBe(expected);
      expect(d.verdict).toBe(expected === "policy_allows_retry" ? "eligible" : "blocked");
    });
  }
  it("an unlisted category fails closed EVEN when the old taxonomy would call it retry-later (fail-open hole removed)", () => {
    const d = evaluateRetryEligibility(facts({
      lastOutcome: { category: "processing_error" }, // no policy rule at all
      lastExecutedAt: new Date(NOW.getTime() - 10 * 86_400_000)
    }), POLICY);
    expect(d).toMatchObject({ verdict: "blocked", reason: "outcome_not_retryable:processing_error" });
  });
  it("an explicit retryable=false rule blocks regardless of taxonomy classification", () => {
    const d = evaluateRetryEligibility(facts({
      lastOutcome: { category: "insufficient_funds" },
      lastExecutedAt: new Date(NOW.getTime() - 10 * 86_400_000)
    }), { ...POLICY, autoRetry: { ...POLICY.autoRetry, perCategory: { ...POLICY.autoRetry.perCategory, insufficient_funds: { retryable: false, maxAttempts: 4 } } } });
    expect(d).toMatchObject({ verdict: "blocked", reason: "outcome_not_retryable:insufficient_funds" });
  });
  it("per-category caps block beyond the policy maximum", () => {
    const d = evaluateRetryEligibility(facts({
      lastOutcome: { category: "insufficient_funds" },
      categoryAttemptCounts: { insufficient_funds: 4 }
    }), POLICY);
    expect(d.reason).toBe("category_exhausted:insufficient_funds");
  });
  it("effective limit is min(global, category): global 2 with category 4 exhausts at 2", () => {
    const d = evaluateRetryEligibility(facts({
      lastOutcome: { category: "insufficient_funds" },
      autoRetryCount: 2,
      categoryAttemptCounts: { insufficient_funds: 2 }
    }), { ...POLICY, maxAutoRetries: 2 }); // category allows 4, global allows 2
    expect(d).toMatchObject({ verdict: "exhausted", reason: "max_auto_retries" });
  });
  it("effective limit is min(global, category): category 2 with global 4 exhausts at 2", () => {
    const d = evaluateRetryEligibility(facts({
      lastOutcome: { category: "insufficient_funds" },
      autoRetryCount: 2,
      categoryAttemptCounts: { insufficient_funds: 2 }
    }), {
      ...POLICY, maxAutoRetries: 4, // global allows 4…
      autoRetry: { ...POLICY.autoRetry, perCategory: { ...POLICY.autoRetry.perCategory, insufficient_funds: { retryable: true, maxAttempts: 2 } } } // …category caps at 2
    });
    expect(d).toMatchObject({ verdict: "blocked", reason: "category_exhausted:insufficient_funds" });
  });
});

describe("retry eligibility — scheduling / backoff", () => {
  it("inside the backoff window → waiting with the exact next time", () => {
    const lastExecutedAt = new Date(NOW.getTime() - 3600_000); // 1h ago
    const d = evaluateRetryEligibility(facts({
      lastOutcome: { category: "insufficient_funds" },
      lastExecutedAt,
      autoRetryCount: 1
    }), POLICY);
    expect(d.verdict).toBe("waiting");
    expect(d.reason).toBe("backoff");
    expect(d.nextEligibleAt?.getTime()).toBe(lastExecutedAt.getTime() + 96 * 3600_000); // 2nd retry: 2×48h
  });
  it("a scheduled-but-unexecuted attempt is resumed, not re-created", () => {
    const d = evaluateRetryEligibility(facts({
      hasScheduledAutoAttempt: true,
      lastOutcome: { category: "rate_limited" }
    }), POLICY);
    expect(d).toMatchObject({ verdict: "eligible", reason: "resume_scheduled_attempt" });
  });
});

describe("backoff calculation (deterministic)", () => {
  it("first retry = minGapHours, second = 2×, then capped at maxBackoffHours", () => {
    expect(backoffDelayHours(0, POLICY.autoRetry, 48)).toBe(48);
    expect(backoffDelayHours(1, POLICY.autoRetry, 48)).toBe(96);
    expect(backoffDelayHours(2, POLICY.autoRetry, 48)).toBe(168); // 192 → capped
    expect(backoffDelayHours(3, POLICY.autoRetry, 48)).toBe(168); // capped
    expect(backoffDelayHours(8, POLICY.autoRetry, 48)).toBe(168); // capped
  });
  it("never overflows into invalid time and never returns non-positive values", () => {
    expect(backoffDelayHours(500, POLICY.autoRetry, 72)).toBe(168);
    const t = nextAutoRetryTime({
      now: NOW, lastExecutedAt: NOW, firstFailedAt: NOW
    }, { minGapHours: 48, autoRetry: POLICY.autoRetry }, 999);
    expect(Number.isFinite(t.getTime())).toBe(true);
    expect(t.getTime()).toBeGreaterThan(NOW.getTime());
  });
  it("absolute next time anchors on the last executed attempt", () => {
    const lastExecutedAt = new Date("2026-09-05T00:00:00Z");
    const t = nextAutoRetryTime({
      now: NOW, lastExecutedAt, firstFailedAt: new Date("2026-09-01T00:00:00Z")
    }, { minGapHours: 24, autoRetry: POLICY.autoRetry }, 0);
    expect(t.toISOString()).toBe("2026-09-06T00:00:00.000Z");
  });
});
