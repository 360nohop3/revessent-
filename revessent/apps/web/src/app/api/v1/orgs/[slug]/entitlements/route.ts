import { requireOrgRole, entitlementsService } from "@revessent/server";
import { handle } from "@/lib/api-route";

/** Phase 7: what this workspace can do right now — server-resolved from the
 *  authoritative billing row. Any member may read the gating outcome; the
 *  billing status/reasons block is included for admin+ only. Read-only. */
export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  return handle(req, async () => {
    const ctx = await requireOrgRole(req.headers, (await params).slug, "view");
    return entitlementsService.describe(ctx);
  });
}
