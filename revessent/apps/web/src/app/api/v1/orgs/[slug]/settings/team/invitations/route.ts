import { z } from "zod";
import { requireOrgRole, settingsService } from "@revessent/server";
import { mutation } from "@/lib/api-route";

const Body = z.object({ email: z.string().email(), role: z.enum(["admin", "operator", "viewer"]) });

/** Admin+ only (§7.3). Invite → persisted row (token hashed); no email sent. */
export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return mutation(req, async (body) => {
    const ctx = await requireOrgRole(req.headers, slug, "administer");
    const result = await settingsService.invite(ctx, body as never, {
      ip: req.headers.get("x-forwarded-for"), userAgent: req.headers.get("user-agent")
    });
    return { ...result, team: await settingsService.team(ctx) };
  }, (b) => Body.parse(b));
}
