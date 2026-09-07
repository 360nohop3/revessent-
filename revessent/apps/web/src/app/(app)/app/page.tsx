import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { parseDemoSession, DEMO_SESSION_COOKIE } from "@/lib/session";

export default async function AppIndexPage() {
  const jar = await cookies();
  const session = parseDemoSession(jar.get(DEMO_SESSION_COOKIE)?.value);
  const first = session?.memberships[0];
  if (first) redirect(`/app/${first.slug}/overview`);
  redirect("/onboarding");
}
