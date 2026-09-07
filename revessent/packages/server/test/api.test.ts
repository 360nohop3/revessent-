import { describe, expect, it } from "vitest";
import { OverviewSchema } from "@revessent/contracts";
// Route handlers are plain Request → Response functions: import them statically
// and drive them directly (no HTTP server needed).
import * as overviewRoute from "@/app/api/v1/orgs/[slug]/overview/route";
import * as orgRoute from "@/app/api/v1/orgs/[slug]/route";
import * as cTokenRoute from "@/app/api/v1/c/[token]/route";
import * as signInRoute from "@/app/api/v1/auth/sign-in/route";
import * as policyRoute from "@/app/api/v1/orgs/[slug]/settings/policy/route";
import { createTestOrg, createTestUser, signInCookie, type TestUser } from "./helpers";

const BASE = "http://localhost:3000";

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

function call(handler: Handler, method: string, path: string, params: Record<string, string>, opts?: { cookie?: string; body?: unknown }): Promise<Response> {
  const headers: Record<string, string> = {};
  if (opts?.cookie) headers.cookie = opts.cookie;
  if (opts?.body !== undefined) headers["content-type"] = "application/json";
  const req = new Request(new URL(path, BASE), {
    method,
    headers,
    body: opts?.body === undefined ? undefined : JSON.stringify(opts.body)
  });
  return handler(req, { params: Promise.resolve(params) });
}

describe("api contract", () => {
  let owner: TestUser;
  let viewer: TestUser;
  let slug = "";
  let ownerCookie = "";
  let viewerCookie = ""; // eslint-disable-line @typescript-eslint/no-unused-vars
  let booted = false;

  async function boot(): Promise<void> {
    if (booted) return;
    owner = await createTestUser("api-owner");
    viewer = await createTestUser("api-viewer");
    slug = (await createTestOrg(owner, "api", [{ user: viewer, role: "viewer" }])).slug;
    ownerCookie = await signInCookie(owner.email, owner.password);
    viewerCookie = await signInCookie(viewer.email, viewer.password);
    booted = true;
  }

  it("unauthenticated reads get 401 problem+json", async () => {
    await boot();
    const res = await call(overviewRoute.GET as Handler, "GET", `/api/v1/orgs/${slug}/overview`, { slug });
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    const problem = (await res.json()) as { type: string };
    expect(problem.type).toBe("/errors/unauthorized");
  });

  it("validation failures get 400 with a stable type URI", async () => {
    await boot();
    const res = await call(signInRoute.POST as Handler, "POST", "/api/v1/auth/sign-in", {}, { body: { email: "not-an-email", password: "x" } });
    expect(res.status).toBe(400);
    const problem = (await res.json()) as { type: string };
    expect(problem.type).toBe("/errors/validation");
  });

  it("invalid mutation body → 400 problem+json, never a 500 (ZodError regression)", async () => {
    await boot();
    const res = await call(policyRoute.PUT as Handler, "PUT", `/api/v1/orgs/${slug}/settings/policy`, { slug },
      { cookie: ownerCookie, body: { maxAutoRetries: 2 } }); // missing required fields
    expect(res.status).toBe(400);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
    const problem = (await res.json()) as { type: string; detail?: string };
    expect(problem.type).toBe("/errors/validation");
    expect(problem.detail ?? "").not.toMatch(/at\s|node_modules/i); // no internals echo
  });

  it("cross-org reads are 404 — not 403 (no existence oracle)", async () => {
    await boot();
    const other = await createTestUser("api-other");
    const otherOrg = await createTestOrg(other, "api-other");
    const res = await call(overviewRoute.GET as Handler, "GET", `/api/v1/orgs/${otherOrg.slug}/overview`, { slug: otherOrg.slug }, { cookie: ownerCookie });
    expect(res.status).toBe(404);
  });

  it("successful read validates against the Phase 2 contract (validated output)", async () => {
    await boot();
    const res = await call(overviewRoute.GET as Handler, "GET", `/api/v1/orgs/${slug}/overview`, { slug }, { cookie: ownerCookie });
    expect(res.status).toBe(200);
    const parsed = OverviewSchema.parse(await res.json());
    expect(parsed.orgSlug).toBe(slug);
    // financial integrity: money is integer minor units
    if (parsed.cashRecovered30d) expect(Number.isInteger(parsed.cashRecovered30d.minor)).toBe(true);
    if (parsed.potentialMrr) expect(Number.isInteger(parsed.potentialMrr.minor)).toBe(true);
  });

  it("unknown slug: 404 problem, identical shape to a foreign slug", async () => {
    await boot();
    const res = await call(overviewRoute.GET as Handler, "GET", "/api/v1/orgs/never-created/overview", { slug: "never-created" }, { cookie: ownerCookie });
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
  });

  it("org detail endpoint returns the workspace for a member", async () => {
    await boot();
    const res = await call(orgRoute.GET as Handler, "GET", `/api/v1/orgs/${slug}`, { slug }, { cookie: ownerCookie });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { slug: string };
    expect(body.slug).toBe(slug);
  });

  it("public token endpoint answers honestly for an unknown token", async () => {
    const res = await call(cTokenRoute.GET as Handler, "GET", "/api/v1/c/not-a-real-token", { token: "not-a-real-token" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { state: string };
    expect(body.state).toBe("unknown");
  });
});
