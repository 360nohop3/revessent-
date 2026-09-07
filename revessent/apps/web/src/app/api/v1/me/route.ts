import { requireSession, appDb, orgsService } from "@revessent/server";
import { toProblem } from "@/lib/api-route";

/** GET /api/v1/me (§6.2): profile + orgs + role + entitlements. */
export async function GET(req: Request) {
  try {
    const user = await requireSession(req.headers);
    const memberships = await orgsService.listMemberships(appDb(), user);
    return Response.json({ user, memberships });
  } catch (e) {
    return toProblem(e, req.url);
  }
}
