/**
 * STRIPE WEBHOOK RECEIVER (Architecture v1 §10.3) — Phase 4B.
 *
 * Public provider-callback surface: authentication IS the Stripe signature
 * over the RAW request body (never a browser session, never a body-supplied
 * org id — the connection is named by the unguessable {orgRef} and the
 * signature proves the sender). Responses are plain JSON acks, not
 * problem+json auth errors, matching §10.3: invalid/unverifiable → safe 400
 * so Stripe retries; valid → fast 200 after the durable insert.
 */
import { webhooksService, ProblemError, problemResponse, safeInternalError } from "@revessent/server";

export async function POST(req: Request, { params }: { params: Promise<{ orgRef: string }> }) {
  const { orgRef } = await params;
  // RAW body exactly as received — verification uses this string; the parsed
  // representation inside the service is derived AFTER the signature check.
  const rawBody = await req.text();
  const sigHeader = req.headers.get("stripe-signature");
  try {
    const receipt = await webhooksService.receiveStripeWebhook({ orgRef, rawBody, sigHeader });
    return Response.json(receipt, { status: 200 });
  } catch (err) {
    if (err instanceof ProblemError) return problemResponse(err, req.url);
    return problemResponse(safeInternalError(), req.url); // internals never leak (§18)
  }
}
