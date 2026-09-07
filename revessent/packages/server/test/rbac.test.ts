import { describe, expect, it } from "vitest";
import { can, type Role } from "@revessent/server";
import { createTestOrg, createTestUser, ctxFor, type TestUser } from "./helpers";

/** §7.3 RBAC matrix — enforced server-side (hidden UI is UX only). */
describe("authorization: role matrix", () => {
  it("mirrors the Phase 1 matrix for every action", () => {
    const matrix: Array<[Role, Record<string, boolean>]> = [
      ["viewer", { view: true, operate: false, edit_voice: false, administer: false, own: false }],
      ["operator", { view: true, operate: true, edit_voice: true, administer: false, own: false }],
      ["admin", { view: true, operate: true, edit_voice: true, administer: true, own: false }],
      ["owner", { view: true, operate: true, edit_voice: true, administer: true, own: true }]
    ];
    const actions = ["view", "operate", "edit_voice", "administer", "own"] as const;
    for (const [role, expected] of matrix) {
      for (const action of actions) {
        expect(can(role, action), `${role}×${action}`).toBe(expected[action]);
      }
    }
  });
});

describe("authorization: server rejects unauthorized writes", () => {
  let owner: TestUser;
  let admin: TestUser;
  let operator: TestUser;
  let viewer: TestUser;
  let slug = "";
  let booted = false;

  async function bootstrap(): Promise<void> {
    if (booted) return;
    owner = await createTestUser("owner");
    admin = await createTestUser("admin");
    operator = await createTestUser("operator");
    viewer = await createTestUser("viewer");
    slug = (await createTestOrg(owner, "rbac", [
      { user: admin, role: "admin" },
      { user: operator, role: "operator" },
      { user: viewer, role: "viewer" }
    ])).slug;
    booted = true;
  }

  it("viewer cannot operate (403 from the server, not hidden UI)", async () => {
    await bootstrap();
    await expect(ctxFor(viewer, slug, "operate")).rejects.toMatchObject({ problem: { status: 403 } });
  });

  it("operator can operate but cannot administer", async () => {
    await bootstrap();
    const ctx = await ctxFor(operator, slug, "operate");
    expect(ctx.role).toBe("operator");
    await expect(ctxFor(operator, slug, "administer")).rejects.toMatchObject({ problem: { status: 403 } });
  });

  it("admin can administer but cannot touch billing (owner-only)", async () => {
    await bootstrap();
    const ctx = await ctxFor(admin, slug, "administer");
    expect(ctx.role).toBe("admin");
    await expect(ctxFor(admin, slug, "own")).rejects.toMatchObject({ problem: { status: 403 } });
  });

  it("owner passes every gate", async () => {
    await bootstrap();
    for (const action of ["view", "operate", "administer", "own"] as const) {
      const ctx = await ctxFor(owner, slug, action);
      expect(ctx.role).toBe("owner");
    }
  });
});
