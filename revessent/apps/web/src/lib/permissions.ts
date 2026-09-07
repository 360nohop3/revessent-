import type { Role } from "@revessent/contracts";

/**
 * Frontend permission matrix (mirrors Phase 1 §7.3). Used ONLY to shape the UI
 * (hide/disable affordances and explain why). The backend re-checks every
 * action — frontend authorization is never sufficient (Phase 2 §6/§20).
 */
export type Action =
  | "view"
  | "approve"
  | "edit_draft"
  | "request_retry"
  | "create_checkout_link"
  | "manage_voice"
  | "manage_policy"
  | "manage_team"
  | "manage_stripe"
  | "run_sync"
  | "view_audit"
  | "manage_billing"
  | "manage_org";

const OPERATOR: Action[] = ["view", "approve", "edit_draft", "request_retry", "create_checkout_link", "manage_voice", "run_sync"];
const ADMIN: Action[] = [...OPERATOR, "manage_policy", "manage_team", "manage_stripe", "view_audit"];
const OWNER: Action[] = [...ADMIN, "manage_billing", "manage_org"];

const MATRIX: Record<Role, Action[]> = {
  viewer: ["view"],
  operator: OPERATOR,
  admin: ADMIN,
  owner: OWNER
};

export function can(role: Role, action: Action): boolean {
  return MATRIX[role].includes(action);
}

/** Friendly explanation used in permission-denied UI states. */
export function roleExplanation(role: Role): string {
  switch (role) {
    case "viewer":
      return "Your role (viewer) can see this workspace but cannot take actions. Ask an owner for an operator or admin seat.";
    case "operator":
      return "Your role (operator) can review, approve and act on recovery work, but workspace settings need an admin.";
    default:
      return "";
  }
}
