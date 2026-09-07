import { describe, expect, it } from "vitest";
import {
  DemoSessionSchema, OverviewSchema, RecoveryCaseSchema, OpportunitySchema, CustomerSchema,
  StripeConnectionSchema, getMockApi
} from "../src";

describe("demo fixtures satisfy the API contracts", () => {
  it("every seeded recovery case validates", async () => {
    const api = getMockApi();
    const { items } = await api.recovery.list("acorn-books", {});
    expect(items.length).toBeGreaterThan(3);
    for (const c of items) expect(RecoveryCaseSchema.parse(c)).toBeTruthy();
  });

  it("every seeded opportunity and customer validates", async () => {
    const api = getMockApi();
    const opps = await api.expansion.list("acorn-books");
    for (const o of opps.items) expect(OpportunitySchema.parse(o)).toBeTruthy();
    const custs = await api.customers.list("acorn-books", {});
    for (const c of custs.items) expect(CustomerSchema.parse(c)).toBeTruthy();
  });

  it("overview validates and marks disconnected orgs with null metrics", async () => {
    const api = getMockApi();
    const connected = await api.overview("acorn-books");
    expect(OverviewSchema.parse(connected)).toBeTruthy();
    expect(connected.cashRecovered30d).not.toBeNull();

    const disconnected = await api.overview("fernbrook");
    expect(OverviewSchema.parse(disconnected)).toBeTruthy();
    expect(disconnected.cashRecovered30d).toBeNull(); // null ≠ zero
  });

  it("session payload validates", () => {
    const api = getMockApi();
    expect(DemoSessionSchema.parse(api.demo.session())).toBeTruthy();
  });

  it("stripe connect validates key format only and never stores it", async () => {
    const api = getMockApi();
    await expect(api.settings.stripeConnect("fernbrook", "not-a-key")).rejects.toMatchObject({
      problem: { status: 422 }
    });
    const conn = await api.settings.stripeConnect("fernbrook", "rk_test_abcdefghijklmnop");
    expect(StripeConnectionSchema.parse(conn)).toBeTruthy();
    expect(conn.status).toBe("read_only");
    expect(JSON.stringify(conn)).not.toContain("rk_test_abcdefghijklmnop");
  });
});

describe("draft actions route through the domain machine", () => {
  it("approve then edit returns the draft to draft state with invalidation", async () => {
    const api = getMockApi();
    const slug = "acorn-books";
    const { items } = await api.recovery.list(slug, { status: "contacting" });
    const maya = items.find((c) => c.customerName === "Maya Chen");
    expect(maya?.draft).toBeTruthy();
    const draftId = maya!.draft!.id;

    await api.recovery.draft(slug, maya!.id, draftId, { type: "approve", actor: "priya" });
    let after = await api.recovery.get(slug, maya!.id);
    expect(after.case.draft?.approvalStatus).toBe("approved");

    const edited = await api.recovery.draft(slug, maya!.id, draftId, {
      type: "edit", subject: "Edited subject", body: "Edited body", actor: "priya"
    });
    expect(edited.approvalStatus).toBe("draft");
    expect(edited.subject).toBe("Edited subject");

    after = await api.recovery.get(slug, maya!.id);
    expect(after.case.draft?.approvalStatus).toBe("draft");
  });

  it("rejects invalid transitions with a clear problem", async () => {
    const api = getMockApi();
    const { items } = await api.recovery.list("acorn-books", {});
    const approved = items.find((c) => c.draft?.approvalStatus === "provider_pending");
    expect(approved).toBeTruthy();
    await expect(
      api.recovery.draft("acorn-books", approved!.id, approved!.draft!.id, { type: "edit", subject: "x", body: "y", actor: "priya" })
    ).rejects.toThrow(/Execution has started|not valid/);
  });

  it("demo provider simulation is the only path to confirmed (fixtures)", async () => {
    const api = getMockApi();
    const { items } = await api.recovery.list("acorn-books", {});
    const pending = items.find((c) => c.draft?.approvalStatus === "provider_pending")!;
    const status = await api.demo.providerAction("acorn-books", "case", pending.id, {
      type: "demo.provider_confirmed", providerRef: "pi_demo_fixture"
    });
    expect(status).toBe("confirmed");
    const after = await api.recovery.get("acorn-books", pending.id);
    expect(after.case.status).toBe("recovered");
    expect(after.case.draft?.providerRef).toBe("pi_demo_fixture");
  });

  it("fault injection surfaces an ApiError with a problem body", async () => {
    const api = getMockApi();
    api.demo.setFailNext(true);
    await expect(api.overview("acorn-books")).rejects.toMatchObject({
      problem: { type: "/errors/demo-injected" }
    });
  });
});
