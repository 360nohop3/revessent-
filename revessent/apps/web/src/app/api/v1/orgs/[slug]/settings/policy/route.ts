import { z } from "zod";
import { requireOrgRole, settingsService } from "@revessent/server";
import { handle, mutation } from "@/lib/api-route";

const Policy = z.object({
  maxAutoRetries: z.number().int().min(0).max(8),
  quietHoursStart: z.number().int().min(0).max(23),
  quietHoursEnd: z.number().int().min(0).max(23),
  minGapHours: z.number().int().min(1).max(72),
  noteAfterFailedRetries: z.number().int().min(0).max(4),
  checkoutAfterNote: z.boolean()
});

export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  return handle(req, async () => {
    const ctx = await requireOrgRole(req.headers, (await params).slug, "view");
    return settingsService.getPolicy(ctx);
  });
}

/** Admin+ only (§7.3: retry policy = admin). Versioned + audited. */
export async function PUT(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return mutation(req, async (body) => {
    const ctx = await requireOrgRole(req.headers, slug, "administer");
    return settingsService.savePolicy(ctx, body as never, {
      ip: req.headers.get("x-forwarded-for"), userAgent: req.headers.get("user-agent")
    });
  }, (b) => Policy.parse(b));
}
