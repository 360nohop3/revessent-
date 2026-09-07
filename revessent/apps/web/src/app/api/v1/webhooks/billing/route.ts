/**
 * PLATFORM BILLING WEBHOOK (Phase 7) — Revessent's OWN Stripe Billing account.
 *
 * Authentication IS the official Stripe signature over the RAW body against
 * BILLING_WEBHOOK_SECRET. No session, no body-claimed org id: the tenant is
 * resolved from the subscription/customer ids we stored (or, for first
 * linkage, the org id WE placed in provider metadata, only while unlinked).
 * Unverifiable → safe 400 (Stripe retries); verified → durable row → apply.
 */
import { billingService, ProblemError, problemResponse, safeInternalError } from "@revessent/server";

export async function POST(req: Request) {
  const rawBody = await req.text();
  const sigHeader = req.headers.get("stripe-signature");
  try {
    const receipt = await billingService.receiveBillingWebhook({ rawBody, sigHeader });
    return Response.json(receipt, { status: 200 });
  } catch (err) {
    if (err instanceof ProblemError) return problemResponse(err, req.url);
    return problemResponse(safeInternalError(), req.url);
  }
}
