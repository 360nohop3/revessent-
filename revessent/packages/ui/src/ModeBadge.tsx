import { Badge } from "./Badge";

export interface ModeBadgeProps {
  /** test | live come from the provider connection; demo marks demo data. */
  mode: "test" | "live" | "demo";
}

/** Always-visible indication of which environment the user is looking at. */
export function ModeBadge({ mode }: ModeBadgeProps) {
  if (mode === "demo") return <Badge tone="warn" title="Mock data — no real actions occur in this build">Demo data</Badge>;
  if (mode === "test") return <Badge tone="info" title="Connected to a Stripe test-mode account">Test mode</Badge>;
  return <Badge tone="neutral" title="Connected to Stripe live mode">Live</Badge>;
}
