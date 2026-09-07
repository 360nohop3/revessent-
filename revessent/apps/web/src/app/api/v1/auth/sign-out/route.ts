import { auth } from "@revessent/server";
import { toProblem } from "@/lib/api-route";

export async function POST(req: Request) {
  try {
    return await auth.api.signOut({ headers: req.headers, asResponse: true });
  } catch (e) {
    return toProblem(e, req.url);
  }
}
