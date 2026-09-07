import { cookies, headers } from "next/headers";
import { DemoSessionSchema, type DemoSession } from "@revessent/contracts";
import { demoMode } from "@revessent/config";

export const DEMO_SESSION_COOKIE = "rv_demo_session";

/**
 * Two session realms (brief §7/§10):
 *  - REAL: Better Auth session (`rv.session_token` httpOnly) — resolved
 *    server-side via getSessionUser(). This is actual authentication.
 *  - DEMO: the labeled demo cookie, only resolvable when demo mode is on.
 * Guards remain navigation guards; server-side authorization lives in the
 * /api/v1 handlers (requireSession/requireOrgRole).
 */
export function parseDemoSession(raw: string | undefined | null): DemoSession | null {
  if (!raw) return null;
  try {
    const json = Buffer.from(raw, "base64").toString("utf8");
    return DemoSessionSchema.parse(JSON.parse(json));
  } catch {
    return null;
  }
}

export function encodeDemoSession(session: DemoSession): string {
  return Buffer.from(JSON.stringify(session)).toString("base64");
}

export interface ResolvedSession {
  email: string;
  name: string;
  memberships: { slug: string; name: string; role: string; plan: string }[];
  demo: boolean;
}

/**
 * Server-side session resolution for layouts/guards. Real mode reads the
 * Better Auth session; demo mode reads the demo cookie (demo mode only).
 */
export async function resolveSession(): Promise<ResolvedSession | null> {
  if (!demoMode()) {
    const { getSessionUser, appDb, orgsService } = await import("@revessent/server");
    const user = await getSessionUser(await headers());
    if (!user) return null;
    const memberships = await orgsService.listMemberships(appDb(), user);
    return { email: user.email, name: user.name, memberships, demo: false };
  }
  const jar = await cookies();
  const demo = parseDemoSession(jar.get(DEMO_SESSION_COOKIE)?.value);
  return demo ? { email: demo.email, name: demo.name, memberships: demo.memberships, demo: true } : null;
}

export { demoMode };
