import { z } from "zod";
import { requireOrgRole, recoveryService } from "@revessent/server";
import { mutation } from "@/lib/api-route";

/**
 * EXPLICIT PAYMENT EXECUTION (Phase 4C). Operator+ only: executes ONE
 * idempotent manual retry of the case's failed payment via Stripe. The body
 * carries at most an optional client idempotency key — amount, currency,
 * customer, invoice and organization identity are all resolved server-side
 * from records anchored to the authenticated organization. Nothing financial
 * is accepted from the browser.
 */
export async function POST(req: Request, { params }: { params: Promise<{ slug: string; caseId: string }> }) {
  const { slug, caseId } = await params;
  return mutation(req, async () => {
    const ctx = await requireOrgRole(req.headers, slug, "operate");
    const body = await req.json().catch(() => ({}));
    // Same key charset as the execution core (architecture J2 keys use colons).
    const { idempotencyKey } = z
      .object({ idempotencyKey: z.string().regex(/^[A-Za-z0-9_:.-]{8,120}$/).optional() })
      .parse(body ?? {});
    return recoveryService.requestRetry(ctx, caseId, { idempotencyKey }, {
      ip: req.headers.get("x-forwarded-for"), userAgent: req.headers.get("user-agent")
    });
  });
}
