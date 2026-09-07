import { requireOrgRole } from "@revessent/server";
import { recoveryService } from "@revessent/server";
import { handle } from "@/lib/api-route";

export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  return handle(req, async () => {
    const ctx = await requireOrgRole(req.headers, (await params).slug, "view");
    const url = new URL(req.url);
    return recoveryService.listCases(ctx, {
      status: url.searchParams.get("status") ?? undefined,
      q: url.searchParams.get("q") ?? undefined,
      cursor: url.searchParams.get("cursor")
    });
  });
}
