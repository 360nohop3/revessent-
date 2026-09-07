import { requireOrgRole, recoveryService } from "@revessent/server";
import { handle } from "@/lib/api-route";

export async function GET(req: Request, { params }: { params: Promise<{ slug: string; caseId: string }> }) {
  return handle(req, async () => {
    const ctx = await requireOrgRole(req.headers, (await params).slug, "view");
    return recoveryService.getCase(ctx, (await params).caseId);
  });
}
