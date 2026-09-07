import { getSessionUser, appDb, orgsService } from "@revessent/server";
import { toProblem } from "@/lib/api-route";

/** Session bootstrap for the frontend: user + memberships, or 401 problem. */
export async function GET(req: Request) {
  try {
    const user = await getSessionUser(req.headers);
    if (!user) return Response.json(
      { type: "/errors/unauthorized", title: "Sign in required", status: 401 },
      { status: 401, headers: { "content-type": "application/problem+json" } });
    const memberships = await orgsService.listMemberships(appDb(), user);
    return Response.json({ user, memberships });
  } catch (e) {
    return toProblem(e, req.url);
  }
}
