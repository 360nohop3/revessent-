import { requireOrgRole, expansionService } from "@revessent/server";
import { mutation } from "@/lib/api-route";

export async function POST(req: Request, { params }: { params: Promise<{ slug: string; opportunityId: string }> }) {
  const { slug, opportunityId } = await params;
  return mutation(req, async () => {
    const ctx = await requireOrgRole(req.headers, slug, "operate");
    return expansionService.dismiss(ctx, opportunityId, {
      ip: req.headers.get("x-forwarded-for"), userAgent: req.headers.get("user-agent")
    });
  });
}
