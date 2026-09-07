import { handle } from "@/lib/api-route";

/**
 * Expansion upgrade tokens arrive with the Phase 4 provider flows (§6.2 J3
 * ends at approval today). Honest unknown — never a fabricated offer.
 */
export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  return handle(req, async () => {
    await params;
    return { state: "unknown" as const, orgName: null, currentPlan: null, recommendedPlan: null, delta: null };
  });
}
