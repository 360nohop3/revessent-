import { z } from "zod";
import { requireOrgRole, settingsService } from "@revessent/server";
import { mutation } from "@/lib/api-route";

const Body = z.object({ key: z.string().min(20).max(300) });

/**
 * Admin+ only. Format-validated, persisted AES-256-GCM-encrypted; the key
 * itself NEVER appears in any response or audit diff (§15/§20).
 */
export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return mutation(req, async (body) => {
    const ctx = await requireOrgRole(req.headers, slug, "administer");
    const { key } = body as { key: string };
    return settingsService.stripeConnect(ctx, key, {
      ip: req.headers.get("x-forwarded-for"), userAgent: req.headers.get("user-agent")
    });
  }, (b) => Body.parse(b));
}
