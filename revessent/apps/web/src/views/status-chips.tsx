"use client";

import type { ApprovalStatus } from "@revessent/domain";
import { RECOVERY_STATUS_META, OPPORTUNITY_STATUS_META, type RecoveryStatus, type OpportunityStatus } from "@revessent/domain";
import { StatusBadge } from "@revessent/ui";
import type { Tone } from "@revessent/ui";

export const APPROVAL_META: Record<ApprovalStatus, { label: string; tone: Tone; inFlight?: boolean }> = {
  draft: { label: "Draft", tone: "neutral" },
  awaiting_approval: { label: "Awaiting approval", tone: "warn" },
  approved: { label: "Approved", tone: "info" },
  queued: { label: "Queued", tone: "info", inFlight: true },
  executing: { label: "Executing", tone: "info", inFlight: true },
  provider_pending: { label: "Provider pending", tone: "info", inFlight: true },
  confirmed: { label: "Confirmed", tone: "ok" },
  failed: { label: "Failed", tone: "err" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  invalidated: { label: "Approval invalidated", tone: "warn" }
};

/** Truthful one-liner per approval state. Approval ≠ execution ≠ confirmation. */
export const APPROVAL_NOTICE: Record<ApprovalStatus, string> = {
  draft: "Draft — nothing has been submitted for approval.",
  awaiting_approval: "Waiting for an approval. Nothing is sent without one.",
  approved: "Approved. Execution happens in the recovery engine (Phase 3/5) — nothing has been sent in this build.",
  queued: "Queued for execution — awaiting the engine (Phase 3/5).",
  executing: "Execution in progress — no outcome is known yet.",
  provider_pending: "Sent to the provider — awaiting confirmation. Pending is not success.",
  confirmed: "Confirmed by the provider (demo fixture). In production this state requires a provider webhook.",
  failed: "The provider reported a failure. No message was sent and no payment was taken.",
  cancelled: "Cancelled before execution.",
  invalidated: "An earlier approval was invalidated (the draft was edited after approval)."
};

export function ApprovalChip({ status }: { status: ApprovalStatus }) {
  const meta = APPROVAL_META[status];
  return <StatusBadge label={meta.label} tone={meta.tone} inFlight={meta.inFlight} />;
}

export function CaseChip({ status }: { status: RecoveryStatus }) {
  const meta = RECOVERY_STATUS_META[status];
  return <StatusBadge label={meta.label} tone={meta.tone} inFlight={["detected", "analyzing", "retrying", "contacting", "checkout"].includes(status)} />;
}

export function OpportunityChip({ status }: { status: OpportunityStatus }) {
  const meta = OPPORTUNITY_STATUS_META[status];
  return <StatusBadge label={meta.label} tone={meta.tone} inFlight={["queued", "provider_pending"].includes(status)} />;
}
