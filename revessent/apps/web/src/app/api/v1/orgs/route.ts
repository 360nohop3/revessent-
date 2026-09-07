import { z } from "zod";
import { requireSession, appDb, orgsService } from "@revessent/server";
import { handle, mutation } from "@/lib/api-route";

export async function GET(req: Request) {
  return handle(req, async () => {
    const user = await requireSession(req.headers);
    return orgsService.listMemberships(appDb(), user);
  });
}

const OrgBody = z.object({ name: z.string().min(2).max(120), slug: z.string().min(2).max(63) });

export async function POST(req: Request) {
  return mutation(req, async (body) => {
    const user = await requireSession(req.headers);
    const parsed = OrgBody.parse(body);
    return orgsService.createOrg(appDb(), user, parsed);
  }, (b) => OrgBody.parse(b));
}
