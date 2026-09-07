import { z } from "zod";
import { auth, enforceAuthRateLimit } from "@revessent/server";
import { toProblem } from "@/lib/api-route";

const Body = z.object({ email: z.string().email() });

/** Contract endpoint (§7): the reset token is persisted; email delivery is Phase 4. */
export async function POST(req: Request) {
  try {
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (parsed.success) enforceAuthRateLimit(req, parsed.data.email, "pw-reset");
    if (!parsed.success) return Response.json(
      { type: "/errors/validation", title: "Validation failed", status: 400, detail: "Enter a valid email." },
      { status: 400, headers: { "content-type": "application/problem+json" } });
    await auth.api.requestPasswordReset({ body: { email: parsed.data.email, redirectTo: "/reset-password" }, headers: req.headers }).catch(() => undefined);
    // Always the same answer — no account existence oracle.
    return Response.json({ accepted: true, emailSent: false });
  } catch (e) {
    return toProblem(e, req.url);
  }
}
