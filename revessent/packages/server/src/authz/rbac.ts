/**
 * Server-side RBAC (Architecture v1 §7.3 matrix). This is the authority;
 * the frontend's lib/permissions is a UX mirror only (brief §8: hidden UI
 * is supplementary — the server rejects).
 */
export type Role = "owner" | "admin" | "operator" | "viewer";

const RANK: Record<Role, number> = { owner: 4, admin: 3, operator: 2, viewer: 1 };

export type AuthzAction =
  | "view"                    // dashboards, queues, customers
  | "operate"                 // approve/reject notes & upgrades, manual retry, checkout links
  | "edit_voice"              // voice profile only (operator+)
  | "administer"              // team, Stripe connect/revoke, retry policy, audit
  | "own";                    // billing, plan, delete org, trust level

export function roleHasAtLeast(role: Role, min: Role): boolean {
  return RANK[role] >= RANK[min];
}

/** §7.3 matrix, expressed per action. */
export function can(role: Role, action: AuthzAction): boolean {
  switch (action) {
    case "view": return RANK[role] >= RANK.viewer;
    case "operate": return RANK[role] >= RANK.operator;
    case "edit_voice": return RANK[role] >= RANK.operator;
    case "administer": return RANK[role] >= RANK.admin;
    case "own": return RANK[role] >= RANK.owner;
  }
}

export function isRole(value: string): value is Role {
  return value === "owner" || value === "admin" || value === "operator" || value === "viewer";
}
