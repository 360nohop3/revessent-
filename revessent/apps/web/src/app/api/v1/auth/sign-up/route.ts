import { z } from "zod";
import { auth, enforceAuthRateLimit } from "@revessent/server";
import { toProblem } from "@/lib/api-route";

const Body = z.object({
  name: z.string().min(1).max(120).optional(),
  email: z.string().email(),
  password: z.string().min(10).max(200)
});

export async function POST(req: Request) {
  try {
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (parsed.success) enforceAuthRateLimit(req, parsed.data.email, "sign-up");
    if (!parsed.success) return Response.json(
      { type: "/errors/validation", title: "Validation failed", status: 400, detail: "Email plus a password of at least 10 characters is required." },
      { status: 400, headers: { "content-type": "application/problem+json" } });
    const name = parsed.data.name ?? parsed.data.email.split("@")[0] ?? "New user";
    return await auth.api.signUpEmail({ body: { name, email: parsed.data.email, password: parsed.data.password }, headers: req.headers, asResponse: true });
  } catch (e) {
    return toProblem(e, req.url);
  }
}
