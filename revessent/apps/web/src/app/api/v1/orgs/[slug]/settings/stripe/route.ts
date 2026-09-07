import { requireOrgRole, settingsService } from "@revessent/server";
import { handle, mutation } from "@/lib/api-route";

export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  return handle(req, async () => {
    const ctx = await requireOrgRole(req.headers, (await params).slug, "view");
    return settingsService.stripeConnection(ctx);
  });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return mutation(req, async () => {
    const ctx = await requireOrgRole(req.headers, slug, "administer");
    return settingsService.stripeDisconnect(ctx, {
      ip: req.headers.get("x-forwarded-for"), userAgent: req.headers.get("user-agent")
    });
  });
}
