/**
 * Request context — the §6.1 handler spine:
 *   HTTP → validation → requireSession() → requireOrgRole() → service → problem+json
 * Layer 3 of tenant isolation lives here (membership + role asserted BEFORE
 * any org-scoped transaction begins). Layer 1 = withOrgTx scoping, layer 2 = RLS.
 */
import { and, eq } from "drizzle-orm";
import { createDb, withIdentityTx, type Db } from "@revessent/db";
import * as schema from "@revessent/db";
import { serverEnv, demoMode } from "@revessent/config";
import { auth } from "./auth/auth.js";
import { can, isRole, type AuthzAction, type Role } from "./authz/rbac.js";
import { ProblemError } from "./http/problems.js";

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
}

let dbInstance: Db | null = null;

/** The application-runtime pool (APP_DATABASE_URL / revessent_app role). */
export function appDb(): Db {
  if (!dbInstance) {
    const env = serverEnv();
    dbInstance = createDb(env.APP_DATABASE_URL ?? env.DATABASE_URL);
  }
  return dbInstance;
}

/** Resolves the Better Auth session from request headers, or null. */
export async function getSessionUser(headers: Headers): Promise<SessionUser | null> {
  const result = await auth.api.getSession({ headers });
  if (!result?.user) return null;
  return {
    id: result.user.id,
    email: result.user.email,
    name: result.user.name,
    emailVerified: result.user.emailVerified
  };
}

export async function requireSession(headers: Headers): Promise<SessionUser> {
  const user = await getSessionUser(headers);
  if (!user) throw new ProblemError("unauthorized");
  return user;
}

export interface OrgContext {
  org: typeof schema.organizations.$inferSelect;
  role: Role;
  userId: string;
  db: Db;
}

/**
 * Asserts the user is a member of the slug's org and holds at least the
 * action's role. Cross-org probing returns 404 (identical to unknown slug) —
 * existence of another org's workspace is never inferable from errors (§20).
 */
export async function requireOrgRole(headers: Headers, slug: string, action: AuthzAction): Promise<OrgContext> {
  const user = await requireSession(headers);
  const db = appDb();

  const ctx = await withIdentityTx(db, user.id, async (tx) => {
    const [org] = await tx.select().from(schema.organizations).where(eq(schema.organizations.slug, slug));
    if (!org) throw new ProblemError("not-found", `No workspace "${slug}".`);
    const [membership] = await tx
      .select()
      .from(schema.memberships)
      .where(and(eq(schema.memberships.orgId, org.id), eq(schema.memberships.userId, user.id)));
    if (!membership) throw new ProblemError("not-found", `No workspace "${slug}".`);
    return { org, membership };
  });

  const role = ctx.membership.role;
  if (!isRole(role)) throw new ProblemError("internal", "Membership has an unknown role.");
  if (!can(role, action)) throw new ProblemError("forbidden", `Your role (${role}) cannot perform this action.`);
  return { org: ctx.org, role, userId: user.id, db };
}

/** CSRF: origin checks on state-changing requests (§7.7). Same-origin only. */
export function assertSameOrigin(req: Request): void {
  const method = req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;
  const origin = req.headers.get("origin");
  if (!origin) return; // non-browser client without Origin (curl, tests)
  const host = req.headers.get("host");
  let originHost = "";
  try {
    originHost = new URL(origin).host;
  } catch {
    throw new ProblemError("csrf", "Malformed Origin header.");
  }
  if (originHost !== host) throw new ProblemError("csrf", "Cross-origin mutation blocked.");
}

export { demoMode };

/** Phase 8 readiness probe: one round-trip on the app pool; throws on failure. */
export async function pingDatabase(): Promise<void> {
  const { sql } = await import("drizzle-orm");
  await appDb().execute(sql`select 1`);
}
