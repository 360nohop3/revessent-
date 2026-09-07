import { requireOrgRole, settingsService } from "@revessent/server";
import { handle } from "@/lib/api-route";

/** Owner only (§7.3: billing = owner). */
export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  return handle(req, async () => {
    const ctx = await requireOrgRole(req.headers, (await params).slug, "own");
    return settingsService.billing(ctx);
  });
}
