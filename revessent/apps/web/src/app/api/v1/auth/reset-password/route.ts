import { z } from "zod";
import { auth, appDb, enforceAuthRateLimitDurable } from "@revessent/server";
import { toProblem } from "@/lib/api-route";

const Body = z.object({ token: z.string().min(10).max(500), newPassword: z.string().min(10).max(200) });

/** Phase 8: token guessing is rate-limited per IP (no email in this request). */
export async function POST(req: Request) {
  try {
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return Response.json(
      { type: "/errors/validation", title: "Validation failed", status: 400, detail: "A reset token and a new password (10+ chars) are required." },
      { status: 400, headers: { "content-type": "application/problem+json" } });
    await enforceAuthRateLimitDurable(appDb(), req, null, "pw-reset-token");
    return await auth.api.resetPassword({ body: { newPassword: parsed.data.newPassword, token: parsed.data.token }, headers: req.headers, asResponse: true });
  } catch (e) {
    return toProblem(e, req.url);
  }
}
