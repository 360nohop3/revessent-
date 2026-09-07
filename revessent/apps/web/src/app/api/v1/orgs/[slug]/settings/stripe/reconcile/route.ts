import { requireOrgRole, webhooksService } from "@revessent/server";
import { mutation } from "@/lib/api-route";

/**
 * RECONCILIATION TRIGGER (Phase 4B §9/§11). Operator+: runs the Phase 4A
 * read-only provider synchronization as the deeper reconciliation pass, then
 * marks failed webhook events `reconciled` (provider truth superseded them).
 * No second Stripe client; no provider writes.
 */
export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return mutation(req, async () => {
    const ctx = await requireOrgRole(req.headers, slug, "operate");
    return webhooksService.reconcileFromProvider(ctx, {
      ip: req.headers.get("x-forwarded-for"), userAgent: req.headers.get("user-agent")
    });
  });
}
