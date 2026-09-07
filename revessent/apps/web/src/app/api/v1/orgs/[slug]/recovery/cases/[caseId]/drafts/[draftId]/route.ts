import { z } from "zod";
import { requireOrgRole, recoveryService } from "@revessent/server";
import { mutation } from "@/lib/api-route";

const Action = z.discriminatedUnion("type", [
  z.object({ type: z.literal("submit") }),
  z.object({ type: z.literal("approve") }),
  z.object({ type: z.literal("cancel") }),
  z.object({ type: z.literal("edit"), subject: z.string().min(1).max(300), body: z.string().min(1).max(20000) })
]);

/** Operator+ only (§7.3: approve/reject/edit = operator). Server identity is the actor. */
export async function POST(req: Request, { params }: { params: Promise<{ slug: string; caseId: string; draftId: string }> }) {
  const { slug, caseId, draftId } = await params;
  return mutation(req, async (body) => {
    const ctx = await requireOrgRole(req.headers, slug, "operate");
    const action = body as { type: string; subject?: string; body?: string };
    return recoveryService.applyDraftAction(ctx, caseId, draftId,
      action.type === "edit"
        ? { type: "edit", subject: action.subject!, body: action.body!, actor: ctx.userId }
        : { type: action.type as "submit" | "approve" | "cancel", actor: ctx.userId },
      { ip: req.headers.get("x-forwarded-for"), userAgent: req.headers.get("user-agent") });
  }, (b) => Action.parse(b));
}
