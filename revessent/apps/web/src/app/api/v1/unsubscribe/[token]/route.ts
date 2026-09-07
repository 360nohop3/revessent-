import { appDb, suppressionService } from "@revessent/server";
import { mutation } from "@/lib/api-route";

const TOKEN_RE = /^[A-Za-z0-9_-]{10,120}$/;

/**
 * Public unsubscribe (no session): the unguessable /c/{token} recovery token
 * is the only authorization. Persists an authoritative, append-only
 * communication suppression for the token's customer (idempotent). Unknown,
 * expired or disabled tokens do nothing and return `unknown`.
 */
export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  return mutation(req, async () => {
    const { token } = await params;
    if (!TOKEN_RE.test(token)) return { state: "unknown" as const };
    return suppressionService.unsubscribeByToken(appDb(), token, {
      ip: req.headers.get("x-forwarded-for"), userAgent: req.headers.get("user-agent")
    });
  });
}
