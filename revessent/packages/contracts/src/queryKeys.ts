/**
 * Every org-scoped query is keyed under ["org", slug] so that organization
 * switches can invalidate/remove exactly the right cache slice (Phase 2 §8).
 */
export const qk = {
  org: (slug: string) => ["org", slug] as const,
  overview: (slug: string) => ["org", slug, "overview"] as const,
  cases: (slug: string, filters: { status?: string; q?: string }) =>
    ["org", slug, "cases", filters] as const,
  case: (slug: string, id: string) => ["org", slug, "case", id] as const,
  opportunities: (slug: string) => ["org", slug, "opportunities"] as const,
  entitlements: (slug: string) => ["org", slug, "entitlements"] as const,
  opportunity: (slug: string, id: string) => ["org", slug, "opportunity", id] as const,
  customers: (slug: string, filters: { q?: string; status?: string }) =>
    ["org", slug, "customers", filters] as const,
  customer: (slug: string, id: string) => ["org", slug, "customer", id] as const,
  stripe: (slug: string) => ["org", slug, "settings", "stripe"] as const,
  policy: (slug: string) => ["org", slug, "settings", "policy"] as const,
  voice: (slug: string) => ["org", slug, "settings", "voice"] as const,
  team: (slug: string) => ["org", slug, "settings", "team"] as const,
  billing: (slug: string) => ["org", slug, "settings", "billing"] as const
};
