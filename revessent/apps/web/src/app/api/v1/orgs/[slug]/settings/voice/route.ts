import { z } from "zod";
import { requireOrgRole, settingsService } from "@revessent/server";
import { handle, mutation } from "@/lib/api-route";

const Voice = z.object({
  sampleText: z.string().max(4000), styleSummary: z.string().max(2000),
  greeting: z.string().max(300), signoff: z.string().max(300)
});

export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  return handle(req, async () => {
    const ctx = await requireOrgRole(req.headers, (await params).slug, "view");
    return settingsService.getVoice(ctx);
  });
}

/** Operator+ (§7.3: voice = operator). */
export async function PUT(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return mutation(req, async (body) => {
    const ctx = await requireOrgRole(req.headers, slug, "operate");
    return settingsService.saveVoice(ctx, body as never, {
      ip: req.headers.get("x-forwarded-for"), userAgent: req.headers.get("user-agent")
    });
  }, (b) => Voice.parse(b));
}
