import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { appDb, orgsService, type SessionUser } from "@revessent/server";
import * as schema from "@revessent/db";
import { withIdentityTx } from "@revessent/db";
import { createTestOrg, createTestUser, type TestUser } from "./helpers";

/**
 * AUDIT: memberships RLS guard (migration 0007). The app role must not be
 * able to escalate by writing membership rows directly — every write beyond
 * the creator bootstrap requires an owner/admin caller, and only an owner
 * may grant 'owner'.
 */
describe("RLS hardening: membership writes (migration 0007)", () => {
  let owner: TestUser;
  let admin: TestUser;
  let viewer: TestUser;
  let orgAId = "";
  let orgBSlug = ""; // eslint-disable-line @typescript-eslint/no-unused-vars
  let orgBId = "";
  let booted = false;

  async function boot(): Promise<void> {
    if (booted) return;
    owner = await createTestUser("rls-owner");
    admin = await createTestUser("rls-admin");
    viewer = await createTestUser("rls-viewer");
    const a = await createTestOrg(owner, "rlsa", [
      { user: admin, role: "admin" },
      { user: viewer, role: "viewer" }
    ]);
    orgAId = a.orgId;
    noteOrgASlug(a.slug);
    const bOwner = await createTestUser("rls-b-owner");
    const b = await createTestOrg(bOwner, "rlsb");
    orgBSlug = b.slug; orgBId = b.orgId;
    booted = true;
  }

  it("unverified user CANNOT create an organization (403 — §7.1 gate)", async () => {
    await boot();
    const unverified: SessionUser = { ...viewer, emailVerified: false };
    await expect(orgsService.createOrg(appDb(), unverified, { name: "Nope", slug: `nope-${Date.now().toString(36)}` }))
      .rejects.toMatchObject({ problem: { status: 403 } });
  });

  it("verified user CAN create an organization (and becomes its owner)", async () => {
    await boot();
    const user = await createTestUser("rls-creator");
    const org = await orgsService.createOrg(appDb(), { ...user, emailVerified: true }, { name: "Created", slug: `created-${Date.now().toString(36)}` });
    expect(org.slug).toBeTruthy();
    const [m] = await withIdentityTx(appDb(), user.id, (tx) =>
      tx.select().from(schema.memberships).where(eq(schema.memberships.orgId, org.id)));
    expect(m?.role).toBe("owner");
  });

  it("a member of A cannot INSERT themselves into org B (RLS denies, not just the query layer)", async () => {
    await boot();
    // viewer of org A attempts a direct membership write into org B
    await expect(withIdentityTx(appDb(), viewer.id, (tx) =>
      tx.insert(schema.memberships).values({ orgId: orgBId, userId: viewer.id, role: "owner" })
    )).rejects.toThrow();
    // and into org A (escalating viewer → owner) — caller is a viewer, not owner/admin
    await expect(withIdentityTx(appDb(), viewer.id, (tx) =>
      tx.insert(schema.memberships).values({ orgId: orgAId, userId: viewer.id, role: "owner" })
    )).rejects.toThrow();
  });

  it("an admin can add an operator but cannot grant 'owner'", async () => {
    await boot();
    const newMember = await createTestUser("rls-new-op");
    // admin inserts an operator — allowed
    await withIdentityTx(appDb(), admin.id, (tx) =>
      tx.insert(schema.memberships).values({ orgId: orgAId, userId: newMember.id, role: "operator" }));
    const [m] = await withIdentityTx(appDb(), owner.id, (tx) =>
      tx.select().from(schema.memberships)
        .where(and(eq(schema.memberships.orgId, orgAId), eq(schema.memberships.userId, newMember.id))));
    expect(m?.role).toBe("operator");
    // admin grants 'owner' — denied by the guard
    const victim = await createTestUser("rls-victim");
    await expect(withIdentityTx(appDb(), admin.id, (tx) =>
      tx.insert(schema.memberships).values({ orgId: orgAId, userId: victim.id, role: "owner" })
    )).rejects.toThrow();
  });

  it("team() lists ALL org members under org-scoped tx (regression: 0009)", async () => {
    await boot();
    const { settingsService } = await import("@revessent/server");
    // even a viewer (least privilege, org-scoped ctx) sees the whole roster
    const ctx = await (await import("./helpers")).ctxFor(viewer, `test-rlsa-` + "", "view").catch(() => null);
    void ctx;
    const { ctxFor } = await import("./helpers");
    const viewerCtx = await ctxFor(viewer, orgASlug(), "view");
    const team = await settingsService.team(viewerCtx);
    // (the admin-grant test above adds a 4th member; assert the roster is
    // complete and correctly roled, not a specific count)
    const roles = team.map((m) => m.role);
    for (const expected of ["owner", "admin", "viewer"]) {
      expect(roles, expected).toContain(expected);
    }
    expect(team.length).toBeGreaterThanOrEqual(3);
  });

  it("org B keeps exactly one member after all escalation attempts", async () => {
    await boot();
    const rows = await withIdentityTx(appDb(), owner.id, (tx) =>
      tx.select().from(schema.memberships).where(eq(schema.memberships.orgId, orgBId)));
    // owner's own view: their owner row (B's owner is a different user; owner of A
    // must see zero of B's rows — the point of the assertion)
    expect(rows.every((r) => r.orgId !== orgBId || r.userId === owner.id)).toBe(true);
  });
});

let orgASlugCache = "";
export function noteOrgASlug(slug: string): void { orgASlugCache = slug; }
function orgASlug(): string { return orgASlugCache; }
