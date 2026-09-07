/** Shared helpers for backend tests: unique users/orgs, real session contexts. */
import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { appDb, orgsService, requireOrgRole, auth, type OrgContext, type SessionUser } from "@revessent/server";
import { withIdentityTx } from "@revessent/db";
import * as schema from "@revessent/db";

export function suffix(): string {
  return randomBytes(4).toString("hex");
}

export interface TestUser extends SessionUser {
  password: string;
}

export async function createTestUser(name: string): Promise<TestUser> {
  const email = `${name}-${suffix()}@test.example`;
  const password = "correct-horse-battery";
  const res = await auth.api.signUpEmail({ body: { name, email, password } });
  return { id: res.user.id, email, name: res.user.name, emailVerified: res.user.emailVerified, password };
}


/** Real sign-in → the session cookie header value (tests real credential path). */
export async function signInCookie(email: string, password: string): Promise<string> {
  const res = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
  const cookies = res.headers.getSetCookie();
  const sessionCookie = cookies.find((c) => c.startsWith("rv.session_token=") || c.includes("session_token"));
  if (!sessionCookie) throw new Error(`no session cookie in sign-in response: ${cookies.join(" | ")}`);
  return sessionCookie.split(";")[0]!;
}

export function headersWith(cookie: string): Headers {
  return new Headers({ cookie });
}

export async function ctxFor(user: TestUser, slug: string, action: "view" | "operate" | "administer" | "own" = "view"): Promise<OrgContext> {
  const cookie = await signInCookie(user.email, user.password);
  return requireOrgRole(headersWith(cookie), slug, action);
}

export async function membershipRole(userId: string, orgId: string): Promise<string> {
  const rows = await appDb().select().from(schema.memberships)
    .where(and(eq(schema.memberships.orgId, orgId), eq(schema.memberships.userId, userId)));
  return rows[0]?.role ?? "";
}

export async function createTestOrg(
  owner: SessionUser, name: string,
  extras?: { user: SessionUser; role: string }[]
): Promise<{ slug: string; orgId: string }> {
  const verifiedOwner = { ...owner, emailVerified: true };
  const org = await orgsService.createOrg(appDb(), verifiedOwner, { name: `Org ${name}`, slug: `test-${name}-${suffix()}` });
  for (const extra of extras ?? []) {
    // RLS guard (0007): membership writes require an owner/admin caller —
    // so the OWNER inserts the membership row for the new member.
    await withIdentityTx(appDb(), owner.id, (tx) =>
      tx.insert(schema.memberships).values({ orgId: org.id, userId: extra.user.id, role: extra.role }));
  }
  return { slug: org.slug, orgId: org.id };
}
