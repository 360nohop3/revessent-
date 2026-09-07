import { requireOrgRole, settingsService } from "@revessent/server";
import { handle } from "@/lib/api-route";

export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  return handle(req, async () => {
    const ctx = await requireOrgRole(req.headers, (await params).slug, "view");
    return settingsService.team(ctx);
  });
}
