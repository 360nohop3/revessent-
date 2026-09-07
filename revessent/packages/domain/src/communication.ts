/**
 * PHASE 6 — COMMUNICATION POLICY (pure domain).
 *
 * Rules decide WHETHER/WHEN REVESSENT recovers money (Phase 4C/4D). This
 * module decides — deterministically, from authoritative facts only —
 * whether, when, and how REVESSENT *communicates* about that recovery:
 *   - whether a communication is allowed at all
 *   - its purpose (which template family) and lifecycle trigger
 *   - timing (quiet hours) and cooldown/deduplication
 *   - whether AI generation is permitted (AI is an optional stylist, never
 *     a decision maker) and whether a human must approve before sending
 * No LLM is consulted here, and nothing here can influence a payment,
 * a retry, an amount, a currency, a recipient or a case state.
 */

export type CommunicationPurpose = "dunning_note" | "final_notice";
export type LifecycleTrigger = "retry_failed" | "case_lost";
export type CommunicationChannel = "email";

export interface CommunicationFacts {
  caseStatus: string;                 // recovery_cases.status
  paymentStatus: string;              // payments.status — 'failed' is the only communicable state
  declineCategory: string;            // case decline category (hard ⇒ never outreach)
  /** Executed automated retries (Phase 4D count semantics — manual attempts excluded). */
  executedAutoRetries: number;
  /** Any attempt executing|unknown ⇒ financial truth is unresolved ⇒ say nothing. */
  hasUnresolvedExecution: boolean;
  recipientEmail: string | null;      // customers.email (application-resolved)
  customerDeleted: boolean;
  /** Purposes already recorded for this case (any send_status except 'suppressed'). */
  existingPurposes: CommunicationPurpose[];
  /** Most recent sent_at across the case's messages (cooldown anchor). */
  lastSentAt: Date | null;
  now: Date;
  /** Wall-clock hour in the organization's timezone (0–23). */
  localHour: number;
}

export interface CommunicationPolicy {
  /** Org-wide kill switch (architecture §9.6 #3). */
  sendsPaused: boolean;
  /** retry_policies.noteAfterFailedRetries — 0 disables notes entirely. */
  noteAfterFailedRetries: number;
  quietHoursStart: number;            // inclusive local hour
  quietHoursEnd: number;              // exclusive local hour
  /** Minimum gap between two emails to the same case. */
  cooldownHours: number;
  /** Whether the organization allows AI-styled copy (deterministic templates otherwise). */
  aiEnabled: boolean;
  /** organizations.trust_level: 0 = every email awaits a human (pilot). */
  trustLevel: number;
}

export type CommunicationDecision =
  | { allowed: false; reason: string }
  | {
      allowed: true;
      purpose: CommunicationPurpose;
      trigger: LifecycleTrigger;
      channel: CommunicationChannel;
      /** Earliest send time (quiet hours / cooldown applied). */
      sendAfter: Date;
      aiPermitted: boolean;
      /** Human approval required before any send (trust ladder). */
      requiresHumanApproval: boolean;
      dedupeKeySuffix: string;
    };

export const DEFAULT_COMMUNICATION_POLICY: Omit<CommunicationPolicy, "trustLevel"> = {
  sendsPaused: false,
  noteAfterFailedRetries: 1,
  quietHoursStart: 21,
  quietHoursEnd: 8,
  cooldownHours: 72,
  aiEnabled: true
};

const COMMUNICABLE_CASE_STATUSES = new Set(["retrying", "contacting", "lost"]);

export function inQuietHours(localHour: number, start: number, end: number): boolean {
  if (start === end) return false;
  return start < end ? localHour >= start && localHour < end : localHour >= start || localHour < end;
}

/** Next local moment at/after `now` outside quiet hours (hour granularity, deterministic). */
export function nextAllowedTime(now: Date, localHour: number, start: number, end: number): Date {
  if (!inQuietHours(localHour, start, end)) return now;
  const hoursUntilEnd = ((end - localHour) % 24 + 24) % 24;
  const next = new Date(now.getTime() + hoursUntilEnd * 3_600_000);
  next.setUTCMinutes(0, 0, 0);
  return next;
}

/**
 * The ONE communication decision. Total and deterministic: safety gates first
 * (financial truth unresolved, hard declines, missing recipient, kill
 * switch), then dedupe/cooldown, then purpose selection from the lifecycle
 * trigger, then timing.
 */
export function evaluateCommunication(
  trigger: LifecycleTrigger, facts: CommunicationFacts, policy: CommunicationPolicy
): CommunicationDecision {
  if (policy.sendsPaused) return { allowed: false, reason: "sends_paused" };
  if (facts.hasUnresolvedExecution) return { allowed: false, reason: "execution_unresolved" };
  if (facts.customerDeleted) return { allowed: false, reason: "customer_deleted" };
  if (!facts.recipientEmail || !isPlausibleEmail(facts.recipientEmail)) return { allowed: false, reason: "no_recipient" };
  if (facts.declineCategory === "hard") return { allowed: false, reason: "decline_not_outreach_safe" };
  if (facts.paymentStatus !== "failed") return { allowed: false, reason: "payment_not_failed" };
  if (!COMMUNICABLE_CASE_STATUSES.has(facts.caseStatus)) return { allowed: false, reason: "case_not_communicable" };

  let purpose: CommunicationPurpose;
  if (trigger === "case_lost") {
    if (facts.caseStatus !== "lost") return { allowed: false, reason: "case_not_lost" };
    purpose = "final_notice";
  } else {
    if (facts.caseStatus === "lost") return { allowed: false, reason: "case_lost_use_final_notice" };
    if (policy.noteAfterFailedRetries <= 0) return { allowed: false, reason: "notes_disabled" };
    if (facts.executedAutoRetries < policy.noteAfterFailedRetries) {
      return { allowed: false, reason: `note_threshold_not_met:${facts.executedAutoRetries}/${policy.noteAfterFailedRetries}` };
    }
    purpose = "dunning_note";
  }
  if (facts.existingPurposes.includes(purpose)) return { allowed: false, reason: "already_communicated" };

  let sendAfter = nextAllowedTime(facts.now, facts.localHour, policy.quietHoursStart, policy.quietHoursEnd);
  if (facts.lastSentAt) {
    const cooldownUntil = new Date(facts.lastSentAt.getTime() + policy.cooldownHours * 3_600_000);
    if (cooldownUntil.getTime() > sendAfter.getTime()) sendAfter = cooldownUntil;
  }
  return {
    allowed: true, purpose, trigger, channel: "email", sendAfter,
    aiPermitted: policy.aiEnabled,
    requiresHumanApproval: policy.trustLevel < 1,
    dedupeKeySuffix: purpose
  };
}

/** Structural sanity only (a real address is verified by the provider). */
export function isPlausibleEmail(value: string): boolean {
  if (value.length > 254) return false;
  if (/[\r\n\t<>,;"\s]/.test(value)) return false;
  return /^[^@]+@[^@]+\.[^@]+$/.test(value);
}

/** Deterministic logical identity of a communication. */
export function communicationDedupeKey(orgId: string, caseId: string, purpose: CommunicationPurpose): string {
  return `comm:${orgId}:${caseId}:${purpose}`;
}
