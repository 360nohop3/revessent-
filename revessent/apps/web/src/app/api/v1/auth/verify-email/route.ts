import { z } from "zod";
import { auth, appDb, enforceAuthRateLimitDurable } from "@revessent/server";
import { toProblem } from "@/lib/api-route";

const Body = z.object({ token: z.string().min(10).max(2000) });

/** Consumes the persisted verification token. Phase 8: rate-limited per IP. */
export async function POST(req: Request) {
  try {
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return Response.json(
      { type: "/errors/validation", title: "Validation failed", status: 400, detail: "A verification token is required." },
      { status: 400, headers: { "content-type": "application/problem+json" } });
    await enforceAuthRateLimitDurable(appDb(), req, null, "verify-token");
    return await auth.api.verifyEmail({ query: { token: parsed.data.token }, headers: req.headers, asResponse: true });
  } catch (e) {
    return toProblem(e, req.url);
  }
}
