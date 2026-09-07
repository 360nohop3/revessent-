/**
 * PHASE 7 — pure resolver: every plan × every billing status, unknown/missing
 * inputs, determinism, and the price→plan mapping (provider hints only).
 */
import { describe, expect, it } from "vitest";
import {
  resolveEntitlements, BILLING_STATUSES, CAPABILITIES, planFromPriceHints, normalizeBillingStatus, normalizePlan,
  type PlanName, type BillingStatus
} from "../src/entitlements";

const PLANS: PlanName[] = ["ember", "revessent", "studio"];
const ENTITLED: BillingStatus[] = ["active", "trialing"];

describe("resolveEntitlements (pure, deterministic)", () => {
  it("covers every plan × status: only active/trialing entitle a paid plan", () => {
    for (const plan of PLANS) for (const status of BILLING_STATUSES) {
      const r = resolveEntitlements({ plan, status });
      expect(r.plan).toBe(plan);
      expect(r.status).toBe(status);
      if (plan === "ember") {
        expect(r.effectivePlan).toBe("ember"); expect(r.restricted).toBe(false); expect(r.state).toBe("baseline");
      } else if (ENTITLED.includes(status)) {
        expect(r.effectivePlan).toBe(plan); expect(r.restricted).toBe(false); expect(r.state).toBe("entitled");
        expect(r.capabilities.ai_notes).toBe(true); expect(r.capabilities.upgrade_signals).toBe(true); expect(r.capabilities.trust_autonomy).toBe(true);
      } else {
        // past_due, canceled, unpaid, incomplete, incomplete_expired, paused, unknown ⇒ baseline (no grace period in Architecture v1)
        expect(r.effectivePlan).toBe("ember"); expect(r.restricted).toBe(true); expect(r.state).toBe("baseline");
        expect(r.capabilities.ai_notes).toBe(false); expect(r.capabilities.trust_autonomy).toBe(false);
        expect(r.reasons).toContain(`subscription_${status}`);
      }
      // financial safety capabilities are NEVER removed by billing state
      expect(r.capabilities.smart_retries).toBe(true);
      expect(r.capabilities.recovery_checkout).toBe(true);
      for (const c of CAPABILITIES) expect(typeof r.capabilities[c]).toBe("boolean");
    }
  });

  it("limits follow the EFFECTIVE plan (a past_due Studio has Ember limits)", () => {
    expect(resolveEntitlements({ plan: "studio", status: "active" }).limits).toEqual({ memberCap: null, seats: 15 });
    expect(resolveEntitlements({ plan: "revessent", status: "trialing" }).limits).toEqual({ memberCap: null, seats: 5 });
    expect(resolveEntitlements({ plan: "studio", status: "past_due" }).limits).toEqual({ memberCap: 1000, seats: 1 });
    expect(resolveEntitlements({ plan: "ember", status: "active" }).limits).toEqual({ memberCap: 1000, seats: 1 });
  });

  it("unknown plan / unknown status / missing record fail SAFE to the Ember baseline", () => {
    const badPlan = resolveEntitlements({ plan: "enterprise", status: "active" });
    expect(badPlan.plan).toBe("ember"); expect(badPlan.reasons).toContain("unknown_plan_treated_as_ember");
    const badStatus = resolveEntitlements({ plan: "studio", status: "totally_new_status" });
    expect(badStatus.status).toBe("unknown"); expect(badStatus.restricted).toBe(true); expect(badStatus.effectivePlan).toBe("ember");
    expect(badStatus.reasons).toEqual(expect.arrayContaining(["unknown_billing_status", "subscription_unknown"]));
    const missing = resolveEntitlements({ plan: null, status: null, missing: true });
    expect(missing.effectivePlan).toBe("ember"); expect(missing.reasons).toContain("billing_record_missing");
    expect(resolveEntitlements({ plan: undefined, status: undefined }).effectivePlan).toBe("ember");
    expect(normalizePlan("STUDIO")).toEqual({ plan: "ember", known: false }); // case-sensitive: never guesses
    expect(normalizeBillingStatus("")).toBe("unknown");
  });

  it("is deterministic: identical input ⇒ identical output, no clock involved", () => {
    const a = resolveEntitlements({ plan: "revessent", status: "past_due" });
    const b = resolveEntitlements({ plan: "revessent", status: "past_due" });
    expect(a).toEqual(b);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("never grants Studio-only marketing items (SSO/API/multi-brand are not capabilities)", () => {
    const r = resolveEntitlements({ plan: "studio", status: "active" });
    expect(Object.keys(r.capabilities).sort()).toEqual([...CAPABILITIES].sort());
  });
});

describe("planFromPriceHints (provider-side hints only)", () => {
  it("maps lookup keys / price metadata / subscription metadata; strips cadence suffixes", () => {
    expect(planFromPriceHints({ lookupKey: "revessent_monthly" })).toBe("revessent");
    expect(planFromPriceHints({ lookupKey: "studio-annual" })).toBe("studio");
    expect(planFromPriceHints({ priceMetadataPlan: "studio", lookupKey: "revessent_monthly" })).toBe("studio"); // price metadata wins
    expect(planFromPriceHints({ subscriptionMetadataPlan: "revessent" })).toBe("revessent");
  });
  it("unknown ⇒ null (caller keeps the previous plan; never downgrades on a guess)", () => {
    expect(planFromPriceHints({ lookupKey: "enterprise_monthly" })).toBeNull();
    expect(planFromPriceHints({})).toBeNull();
    expect(planFromPriceHints({ lookupKey: null, priceMetadataPlan: null, subscriptionMetadataPlan: null })).toBeNull();
  });
});
