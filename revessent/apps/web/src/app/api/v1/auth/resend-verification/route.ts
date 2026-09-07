import { auth, appDb, requireSession, enforceAuthRateLimitDurable } from "@revessent/server";
import { toProblem, assertSameOrigin } from "@/lib/api-route";

/**
 * Phase 8: re-issue the verification email for the SIGNED-IN account only
 * (no email in the body → no enumeration, no third-party mail bombing).
 * Rate-limited per IP+account like the other auth routes.
 */
export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    const user = await requireSession(req.headers);
    await enforceAuthRateLimitDurable(appDb(), req, user.email, "resend-verify");
    if (user.emailVerified) return Response.json({ accepted: true, alreadyVerified: true });
    await auth.api.sendVerificationEmail({ body: { email: user.email, callbackURL: "/onboarding" }, headers: req.headers });
    return Response.json({ accepted: true, alreadyVerified: false });
  } catch (e) {
    return toProblem(e, req.url);
  }
}
