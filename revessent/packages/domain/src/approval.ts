/**
 * Approval / execution state machine (Phase 2 §12).
 *
 * Invariants encoded here and enforced by the UI:
 *  - Draft, awaiting approval, approved, queued, executing, provider-pending,
 *    confirmed are DISTINCT. Approval is never collapsed into execution.
 *  - `confirmed` is reachable ONLY from `provider_pending` (provider evidence).
 *    The frontend can never confirm on its own.
 *  - Editing an approved draft invalidates that approval (Phase 2 §12).
 *  - failed / cancelled / invalidated are terminal for a given draft; a new
 *    draft must be created rather than resurrecting a terminal state.
 */

export const APPROVAL_STATUSES = [
  "draft",
  "awaiting_approval",
  "approved",
  "queued",
  "executing",
  "provider_pending",
  "confirmed",
  "failed",
  "cancelled",
  "invalidated"
] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

export type ApprovalEvent =
  | { type: "submit" }
  | { type: "approve"; actor: string }
  | { type: "queue" }
  | { type: "execution_started" }
  | { type: "provider_pending" }
  | { type: "provider_confirmed"; providerRef?: string }
  | { type: "provider_failed"; reason?: string }
  | { type: "cancel"; actor: string }
  | { type: "edit"; subject?: string; body?: string }
  | { type: "invalidate"; reason: string };

export type TransitionResult =
  | { ok: true; status: ApprovalStatus; approvalInvalidated?: boolean }
  | { ok: false; status: ApprovalStatus; reason: string };

const TRANSITIONS: Record<ApprovalStatus, Partial<Record<ApprovalEvent["type"], ApprovalStatus>>> = {
  draft: { submit: "awaiting_approval", edit: "draft" },
  awaiting_approval: {
    approve: "approved",
    edit: "draft",
    cancel: "cancelled",
    invalidate: "invalidated"
  },
  approved: {
    queue: "queued",
    edit: "draft", // invalidates the approval — flagged by the transition result
    cancel: "cancelled",
    invalidate: "invalidated"
  },
  queued: {
    execution_started: "executing",
    cancel: "cancelled",
    invalidate: "invalidated"
  },
  executing: {
    provider_pending: "provider_pending",
    provider_failed: "failed"
  },
  provider_pending: {
    provider_confirmed: "confirmed",
    provider_failed: "failed"
  },
  confirmed: {},
  failed: {},
  cancelled: {},
  invalidated: {}
};

const TERMINAL: ApprovalStatus[] = ["confirmed", "failed", "cancelled", "invalidated"];

export function isTerminalApproval(status: ApprovalStatus): boolean {
  return TERMINAL.includes(status);
}

/**
 * Can this draft still be edited? Editing an approved draft is allowed but
 * invalidates the approval — the UI must surface `invalidatesApproval`.
 */
export function editability(status: ApprovalStatus): {
  allowed: boolean;
  invalidatesApproval: boolean;
  reason?: string;
} {
  switch (status) {
    case "draft":
      return { allowed: true, invalidatesApproval: false };
    case "awaiting_approval":
      return { allowed: true, invalidatesApproval: false };
    case "approved":
      return { allowed: true, invalidatesApproval: true };
    case "queued":
    case "executing":
    case "provider_pending":
      return {
        allowed: false,
        invalidatesApproval: false,
        reason: "Execution has started — edits are no longer possible."
      };
    default:
      return {
        allowed: false,
        invalidatesApproval: false,
        reason: "This draft is closed. Create a new draft to continue."
      };
  }
}

export function transition(current: ApprovalStatus, event: ApprovalEvent): TransitionResult {
  const next = TRANSITIONS[current][event.type];
  if (!next) {
    return {
      ok: false,
      status: current,
      reason: `"${event.type}" is not valid from "${current}".`
    };
  }
  if (event.type === "edit" && current === "approved") {
    return { ok: true, status: next, approvalInvalidated: true };
  }
  return { ok: true, status: next };
}

/** Explicit provider-confirmation guard for UI enable/disable logic. */
export function canConfirmFromProvider(status: ApprovalStatus): boolean {
  return status === "provider_pending";
}
