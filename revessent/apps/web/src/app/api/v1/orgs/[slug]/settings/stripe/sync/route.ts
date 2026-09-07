import { requireOrgRole, syncService } from "@revessent/server";
import { mutation } from "@/lib/api-route";

/**
 * Manual read-only Stripe sync (Phase 4A §9). Operator+: refreshes the local
 * read model from Stripe (the authority). No provider write exists on this
 * path. Response = started + per-entity outcome + the fresh connection DTO.
 */
export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return mutation(req, async () => {
    const ctx = await requireOrgRole(req.headers, slug, "operate");
    return syncService.triggerSync(ctx, {
      ip: req.headers.get("x-forwarded-for"), userAgent: req.headers.get("user-agent")
    });
  });
}
