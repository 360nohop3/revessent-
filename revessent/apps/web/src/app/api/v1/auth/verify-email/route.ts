import { z } from "zod";
import { auth } from "@revessent/server";
import { toProblem } from "@/lib/api-route";

const Body = z.object({ token: z.string().min(10) });

/** Contract endpoint (§7): consumes the persisted verification token. */
export async function POST(req: Request) {
  try {
    const parsed = Body.safeParse(await req.json().catch(() => null));
    if (!parsed.success) return Response.json(
      { type: "/errors/validation", title: "Validation failed", status: 400, detail: "A verification token is required." },
      { status: 400, headers: { "content-type": "application/problem+json" } });
    return await auth.api.verifyEmail({ query: { token: parsed.data.token }, headers: req.headers, asResponse: true });
  } catch (e) {
    return toProblem(e, req.url);
  }
}
