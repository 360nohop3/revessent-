/** Presentation metadata for domain statuses (labels + badge tones). */
export type Tone = "neutral" | "info" | "ok" | "warn" | "err";

export const RECOVERY_STATUSES = [
  "detected",
  "analyzing",
  "retrying",
  "contacting",
  "checkout",
  "recovered",
  "lost",
  "canceled",
  "dismissed"
] as const;
export type RecoveryStatus = (typeof RECOVERY_STATUSES)[number];

export const RECOVERY_STATUS_META: Record<RecoveryStatus, { label: string; tone: Tone }> = {
  detected: { label: "Detected", tone: "neutral" },
  analyzing: { label: "Analyzing", tone: "info" },
  retrying: { label: "Retrying", tone: "info" },
  contacting: { label: "Contacting", tone: "info" },
  checkout: { label: "Checkout open", tone: "info" },
  recovered: { label: "Recovered", tone: "ok" },
  lost: { label: "Lost", tone: "err" },
  canceled: { label: "Member canceled", tone: "neutral" },
  dismissed: { label: "Dismissed", tone: "neutral" }
};

export const OPPORTUNITY_STATUSES = [
  "new",
  "awaiting_approval",
  "approved",
  "queued",
  "provider_pending",
  "confirmed",
  "declined",
  "expired",
  "dismissed"
] as const;
export type OpportunityStatus = (typeof OPPORTUNITY_STATUSES)[number];

export const OPPORTUNITY_STATUS_META: Record<OpportunityStatus, { label: string; tone: Tone }> = {
  new: { label: "New signal", tone: "neutral" },
  awaiting_approval: { label: "Awaiting approval", tone: "warn" },
  approved: { label: "Approved", tone: "info" },
  queued: { label: "Queued", tone: "info" },
  provider_pending: { label: "Provider pending", tone: "info" },
  confirmed: { label: "Confirmed", tone: "ok" },
  declined: { label: "Declined by member", tone: "neutral" },
  expired: { label: "Expired", tone: "neutral" },
  dismissed: { label: "Dismissed", tone: "neutral" }
};

export const DECLINE_CATEGORIES = [
  "insufficient_funds",
  "expired_card",
  "transient",
  "issuer_decline",
  "credential",
  "hard",
  "balance"
] as const;
export type DeclineCategory = (typeof DECLINE_CATEGORIES)[number];

export const DECLINE_CATEGORY_LABEL: Record<DeclineCategory, string> = {
  insufficient_funds: "Insufficient funds",
  expired_card: "Card expired",
  transient: "Transient issue",
  issuer_decline: "Issuer declined",
  credential: "Card details need updating",
  hard: "Hard decline",
  balance: "Account / currency issue"
};

/**
 * Hard declines (lost/stolen/fraud markers) must never receive recovery
 * outreach. The UI hides/disable outreach affordances when false.
 */
export function outreachSafe(category: DeclineCategory): boolean {
  return category !== "hard";
}
