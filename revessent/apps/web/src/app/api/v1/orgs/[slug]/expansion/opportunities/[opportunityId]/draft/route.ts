import { z } from "zod";
import { requireOrgRole, expansionService } from "@revessent/server";
import { mutation } from "@/lib/api-route";

const Action = z.discriminatedUnion("type", [
  z.object({ type: z.literal("submit") }),
  z.object({ type: z.literal("approve") }),
  z.object({ type: z.literal("cancel") }),
  z.object({ type: z.literal("edit"), subject: z.string().min(1).max(300), body: z.string().min(1).max(20000) })
]);

export async function POST(req: Request, { params }: { params: Promise<{ slug: string; opportunityId: string }> }) {
  const { slug, opportunityId } = await params;
  return mutation(req, async (body) => {
    const ctx = await requireOrgRole(req.headers, slug, "operate");
    const action = body as { type: string; subject?: string; body?: string };
    return expansionService.applyOpportunityDraftAction(ctx, opportunityId,
      action.type === "edit"
        ? { type: "edit", subject: action.subject!, body: action.body!, actor: ctx.userId }
        : { type: action.type as "submit" | "approve" | "cancel", actor: ctx.userId },
      { ip: req.headers.get("x-forwarded-for"), userAgent: req.headers.get("user-agent") });
  }, (b) => Action.parse(b));
}
