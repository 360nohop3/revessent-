import { requireSession, appDb, orgsService } from "@revessent/server";
import { handle } from "@/lib/api-route";

export async function GET(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  return handle(req, async () => {
    const user = await requireSession(req.headers);
    const { slug } = await params;
    const org = await orgsService.orgBySlug(appDb(), user, slug);
    if (!org) return Response.json(
      { type: "/errors/not-found", title: "Not found", status: 404, detail: `No workspace "${slug}".` },
      { status: 404, headers: { "content-type": "application/problem+json" } });
    return org;
  });
}
