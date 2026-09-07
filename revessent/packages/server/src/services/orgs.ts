/**
 * Organization lifecycle: create (onboarding), list memberships.
 * Creation requires a VERIFIED email (§7.1). The transaction inserts the org
 * plus the owner membership atomically; RLS org policy allows the insert and
 * the identity-scoped membership policy accepts the creator's row.
 */
import { eq, sql } from "drizzle-orm";
import * as schema from "@revessent/db";
import { withIdentityTx, type Db } from "@revessent/db";
import { MembershipOrgSchema, OrgSchema, type MembershipOrg, type Org } from "@revessent/contracts";
import type { SessionUser } from "../context.js";
import { ProblemError } from "../http/problems.js";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;

export async function listMemberships(db: Db, user: SessionUser): Promise<MembershipOrg[]> {
  return withIdentityTx(db, user.id, async (tx) => {
    const rows = await tx
      .select({ org: schema.organizations, m: schema.memberships })
      .from(schema.memberships)
      .innerJoin(schema.organizations, eq(schema.memberships.orgId, schema.organizations.id))
      .where(eq(schema.memberships.userId, user.id));
    return rows.map((r) => ({
      slug: r.org.slug, name: r.org.name, role: r.m.role as MembershipOrg["role"], plan: r.org.plan as MembershipOrg["plan"]
    }));
  }).then((rows) => rows.map((r) => MembershipOrgSchema.parse(r)));
}

export async function createOrg(
  db: Db, user: SessionUser, input: { name: string; slug: string }
): Promise<Org> {
  if (!SLUG_RE.test(input.slug)) {
    throw new ProblemError("validation", "Workspace URL may contain lowercase letters, numbers and dashes (2–63 chars).");
  }
  if (!user.emailVerified) {
    throw new ProblemError("forbidden", "Verify your email before creating a workspace — open the link we emailed you.");
  }
  const org = await withIdentityTx(db, user.id, async (tx) => {
    const [existing] = await tx.select().from(schema.organizations).where(eq(schema.organizations.slug, input.slug));
    if (existing) throw new ProblemError("conflict", "That workspace URL is taken.");
    // RLS ordering: plain org INSERT (with-check=true, no RETURNING) → creator
    // membership (FK satisfied, makes the org readable) → SELECT back.
    const orgId = crypto.randomUUID();
    await tx.insert(schema.organizations).values({ id: orgId, name: input.name, slug: input.slug });
    await tx.insert(schema.memberships).values({ orgId, userId: user.id, role: "owner" });
    // own-billing rows are org-scoped by RLS; scope the tx now that we're a member
    await tx.execute(sql`select set_config('app.org_id', ${orgId}, true)`);
    await tx.insert(schema.orgSubscriptions).values({ orgId, plan: "ember", status: "trialing" });
    const [created] = await tx.select().from(schema.organizations).where(eq(schema.organizations.id, orgId));
    return created!;
  });
  return OrgSchema.parse({
    id: org.id, slug: org.slug, name: org.name, plan: org.plan,
    timezone: org.timezone, pilotEndsAt: org.pilotEndsAt?.toISOString() ?? null
  });
}

export async function orgBySlug(db: Db, user: SessionUser, slug: string): Promise<Org | null> {
  const memberships = await listMemberships(db, user);
  const m = memberships.find((x) => x.slug === slug);
  if (!m) return null;
  const rows = await withIdentityTx(db, user.id, async (tx) =>
    tx.select().from(schema.organizations).where(eq(schema.organizations.slug, slug)));
  const org = rows[0];
  if (!org) return null;
  return OrgSchema.parse({
    id: org.id, slug: org.slug, name: org.name, plan: org.plan,
    timezone: org.timezone, pilotEndsAt: org.pilotEndsAt?.toISOString() ?? null
  });
}
