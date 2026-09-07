import { z } from "zod";
import { auth, appDb, enforceAuthRateLimitDurable } from "@revessent/server";
import { toProblem } from "@/lib/api-route";

const Body = z.object({ email: z.string().email(), password: z.string().min(1) });

export async function POST(req: Request) {
  try {
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return Response.json(
      { type: "/errors/validation", title: "Validation failed", status: 400, detail: "Enter a valid email and password." },
      { status: 400, headers: { "content-type": "application/problem+json" } });
    await enforceAuthRateLimitDurable(appDb(), req, parsed.data.email);
    // Better Auth: verifies argon2id hash, creates the session, sets rv.session_token.
    return await auth.api.signInEmail({ body: parsed.data, headers: req.headers, asResponse: true });
  } catch (e) {
    return toProblem(e, req.url);
  }
}
