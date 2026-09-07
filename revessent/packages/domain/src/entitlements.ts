/** Plan entitlement matrix — Phase 1 §1.4. Frontend uses this for gating UI; the
 *  backend re-checks everything (Phase 2 §20). Prices are display-only here.
 *
 *  PHASE 7: `resolveEntitlements` below is THE authoritative, pure, deterministic
 *  decision layer (plan + billing status → capabilities + limits + effective
 *  state + reasons). The server wraps it with authoritative data
 *  (org_subscriptions, synchronized from Revessent's own Stripe Billing) and
 *  usage counters; nothing else in the codebase may branch on a plan name. */
export type PlanName = "ember" | "revessent" | "studio";

export type Feature =
  | "smart_retries"
  | "recovery_checkout"
  | "ai_notes"
  | "upgrade_signals"
  | "weekly_digest"
  | "slack_alerts"
  | "team_seats";

export interface PlanDef {
  name: PlanName;
  label: string;
  monthlyMinor: number;
  annualMinor: number;
  memberCap: number | null;
  features: Feature[];
}

export const PLANS: Record<PlanName, PlanDef> = {
  ember: {
    name: "ember",
    label: "Ember",
    monthlyMinor: 0,
    annualMinor: 0,
    memberCap: 1000,
    features: ["smart_retries", "recovery_checkout"]
  },
  revessent: {
    name: "revessent",
    label: "Revessent",
    monthlyMinor: 24900,
    annualMinor: 19900,
    memberCap: null,
    features: ["smart_retries", "recovery_checkout", "ai_notes", "upgrade_signals", "weekly_digest", "team_seats"]
  },
  studio: {
    name: "studio",
    label: "Studio",
    monthlyMinor: 59900,
    annualMinor: 47900,
    memberCap: null,
    features: ["smart_retries", "recovery_checkout", "ai_notes", "upgrade_signals", "weekly_digest", "slack_alerts", "team_seats"]
  }
};

export function hasEntitlement(plan: PlanName, feature: Feature): boolean {
  return PLANS[plan].features.includes(feature);
}

/* =========================================================================
 * PHASE 7 — authoritative resolver
 * ========================================================================= */

/** Boolean capabilities (§1.4 rows). `trust_autonomy` = "Trust-level autonomy
 *  (post-pilot automation)": Ember is approval-only regardless of trust_level. */
export type Capability =
  | "smart_retries"
  | "recovery_checkout"
  | "ai_notes"
  | "upgrade_signals"
  | "weekly_digest"
  | "trust_autonomy";

export const CAPABILITIES: readonly Capability[] = [
  "smart_retries", "recovery_checkout", "ai_notes", "upgrade_signals", "weekly_digest", "trust_autonomy"
];

/** Quantitative limits (§1.4 rows). null = unlimited. */
export interface PlanLimits {
  /** Customers (non-deleted) the org may hold — reported, not an admission gate (see report §6). */
  memberCap: number | null;
  /** Team seats = memberships + pending invitations. Enforced atomically at invite time. */
  seats: number;
}

const PLAN_LIMITS: Record<PlanName, PlanLimits> = {
  ember: { memberCap: 1000, seats: 1 },
  revessent: { memberCap: null, seats: 5 },
  studio: { memberCap: null, seats: 15 }
};

const PLAN_CAPABILITIES: Record<PlanName, Capability[]> = {
  ember: ["smart_retries", "recovery_checkout"],
  revessent: ["smart_retries", "recovery_checkout", "ai_notes", "upgrade_signals", "weekly_digest", "trust_autonomy"],
  studio: ["smart_retries", "recovery_checkout", "ai_notes", "upgrade_signals", "weekly_digest", "trust_autonomy"]
};

/** Stripe subscription statuses we recognise VERBATIM (Stripe is the authority
 *  for Revessent's own billing) plus our pre-billing default. Anything else is
 *  `unknown` and is NEVER treated as entitled. */
export type BillingStatus =
  | "trialing" | "active" | "past_due" | "canceled" | "unpaid"
  | "incomplete" | "incomplete_expired" | "paused" | "unknown";

export const BILLING_STATUSES: readonly BillingStatus[] = [
  "trialing", "active", "past_due", "canceled", "unpaid", "incomplete", "incomplete_expired", "paused", "unknown"
];

/** The two statuses that entitle an org to its PAID plan. Architecture v1
 *  defines no grace period, so past_due is NOT active (brief §7). */
const ENTITLED_STATUSES: ReadonlySet<BillingStatus> = new Set(["trialing", "active"]);

/** Effective entitlement state:
 *  - `entitled`   paid plan capabilities in force (active/trialing)
 *  - `baseline`   Ember (free) capabilities — either the org IS on Ember, or a
 *                 paid subscription is not in an entitled status (restricted). */
export type EffectiveState = "entitled" | "baseline";

export interface BillingSnapshot {
  /** org_subscriptions.plan (may be any string from the DB — normalised here). */
  plan: string | null | undefined;
  /** org_subscriptions.status (verbatim Stripe status or pre-billing default). */
  status: string | null | undefined;
  /** True when the org_subscriptions row is missing entirely. */
  missing?: boolean;
}

export interface ResolvedEntitlements {
  /** Normalised plan the org is SUBSCRIBED to (record), even when restricted. */
  plan: PlanName;
  /** Plan whose capabilities are actually IN FORCE right now. */
  effectivePlan: PlanName;
  status: BillingStatus;
  state: EffectiveState;
  restricted: boolean;
  capabilities: Record<Capability, boolean>;
  limits: PlanLimits;
  /** Stable, machine-readable reason codes explaining the decision (no secrets, no PII). */
  reasons: string[];
}

export function normalizePlan(plan: string | null | undefined): { plan: PlanName; known: boolean } {
  if (plan === "ember" || plan === "revessent" || plan === "studio") return { plan, known: true };
  return { plan: "ember", known: false };
}

export function normalizeBillingStatus(status: string | null | undefined): BillingStatus {
  return (BILLING_STATUSES as readonly string[]).includes(status ?? "") ? (status as BillingStatus) : "unknown";
}

/**
 * Pure resolver. Same input ⇒ same output; no clock, no I/O, no AI.
 * Fail-safe by construction: anything unrecognised collapses to the Ember
 * baseline (which still includes smart retries + recovery checkout — losing a
 * plan never disables the tenant's financial safety machinery).
 */
export function resolveEntitlements(input: BillingSnapshot): ResolvedEntitlements {
  const reasons: string[] = [];
  const { plan, known } = normalizePlan(input.plan);
  if (input.missing) reasons.push("billing_record_missing");
  if (!known) reasons.push("unknown_plan_treated_as_ember");
  const status = normalizeBillingStatus(input.status);
  if (status === "unknown") reasons.push("unknown_billing_status");

  let effectivePlan: PlanName = plan;
  let restricted = false;
  if (plan !== "ember") {
    if (!ENTITLED_STATUSES.has(status)) {
      effectivePlan = "ember";
      restricted = true;
      reasons.push(`subscription_${status}`);
    } else {
      reasons.push(`subscription_${status}`);
    }
  } else {
    reasons.push("free_plan");
  }

  const caps = new Set(PLAN_CAPABILITIES[effectivePlan]);
  const capabilities = Object.fromEntries(CAPABILITIES.map((c) => [c, caps.has(c)])) as Record<Capability, boolean>;
  return {
    plan, effectivePlan, status,
    state: effectivePlan === "ember" ? "baseline" : "entitled",
    restricted,
    capabilities,
    limits: { ...PLAN_LIMITS[effectivePlan] },
    reasons
  };
}

/** Maps a Stripe Price to a plan using ONLY provider-side, operator-controlled
 *  fields (lookup_key / price metadata / subscription metadata). Client input
 *  never reaches this function. Unknown ⇒ null (caller must NOT downgrade). */
export function planFromPriceHints(hints: {
  lookupKey?: string | null; priceMetadataPlan?: string | null; subscriptionMetadataPlan?: string | null;
}): PlanName | null {
  for (const candidate of [hints.priceMetadataPlan, hints.lookupKey, hints.subscriptionMetadataPlan]) {
    if (!candidate) continue;
    const base = candidate.toLowerCase().replace(/[-_](monthly|annual|yearly|month|year)$/, "");
    if (base === "revessent" || base === "studio" || base === "ember") return base;
  }
  return null;
}
