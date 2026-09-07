import { z } from "zod";
import { appDb, checkoutService } from "@revessent/server";
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

/** Public confirm: provider-confirmed completion = next phase. Honest 501. */
export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  return mutation(req, async () => {
    await params; // token validated by shape; confirmation is Stripe's, later phase
    checkoutService.confirmCheckout();
  }, (b) => z.object({}).parse(b ?? {}));
}
