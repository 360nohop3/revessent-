import { z } from "zod";
import { appDb, checkoutService, clientIp, rateLimit, ProblemError } from "@revessent/server";
import { handle, mutation } from "@/lib/api-route";

const TOKEN_RE = /^[A-Za-z0-9_-]{10,120}$/;

/** Public (no session): member checkout info — token is the authorization. */
export async function GET(req: Request, { params }: { params: Promise<{ token: string }> }) {
  return handle(req, async () => {
    const { token } = await params;
    if (!TOKEN_RE.test(token)) return {
      state: "unknown" as const, orgName: null, productName: null,
      amount: null, cardLast4: null, expiresAt: null
    };
    return checkoutService.tokenInfo(appDb(), token);
  });
}

/**
 * Public start (Phase 8 Hosted Recovery Checkout): verifies the link and the
 * CURRENT provider invoice server-side, then returns Stripe's own hosted page
 * for that exact invoice. Nothing is charged here and no body field is
 * trusted — the token is the only input. Completion is provider truth only
 * (invoice.paid → reconciliation), never this endpoint or a redirect.
 */
export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  return mutation(req, async () => {
    const { token } = await params;
    if (!TOKEN_RE.test(token)) return { state: "unknown" as const };
    // Public surface: bound provider lookups per client (existing in-memory limiter).
    const rl = rateLimit(`checkout-start:${clientIp(req)}`, 20, 60_000);
    if (!rl.ok) throw new ProblemError("rate-limited", "Too many attempts. Please wait a moment and try again.", { "Retry-After": String(rl.retryAfterSec) });
    return checkoutService.startCheckout(appDb(), token, {
      ip: clientIp(req), userAgent: req.headers.get("user-agent")
    });
  }, (b) => z.object({}).strict().parse(b ?? {}));
}
