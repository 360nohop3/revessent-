/** Plan entitlement matrix — Phase 1 §1.4. Frontend uses this for gating UI; the
 *  backend re-checks everything (Phase 2 §20). Prices are display-only here. */
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
