import { describe, expect, it } from "vitest";
import {
  canConfirmFromProvider,
  editability,
  isTerminalApproval,
  transition,
  type ApprovalStatus
} from "../src/approval";

describe("approval state machine", () => {
  it("moves a draft through approval to queued", () => {
    expect(transition("draft", { type: "submit" })).toEqual({ ok: true, status: "awaiting_approval" });
    expect(transition("awaiting_approval", { type: "approve", actor: "u1" })).toEqual({
      ok: true,
      status: "approved"
    });
    expect(transition("approved", { type: "queue" })).toEqual({ ok: true, status: "queued" });
  });

  it("editing an approved draft invalidates the approval", () => {
    const result = transition("approved", { type: "edit" });
    expect(result).toEqual({ ok: true, status: "draft", approvalInvalidated: true });
    expect(editability("approved").invalidatesApproval).toBe(true);
  });

  it("editing while awaiting approval returns to draft without invalidation", () => {
    expect(transition("awaiting_approval", { type: "edit" })).toEqual({
      ok: true,
      status: "draft",
      approvalInvalidated: undefined
    });
  });

  it("editing is impossible once execution started", () => {
    expect(editability("queued").allowed).toBe(false);
    expect(editability("executing").allowed).toBe(false);
    expect(editability("provider_pending").allowed).toBe(false);
  });

  it("confirmed is reachable only from provider_pending", () => {
    expect(transition("provider_pending", { type: "provider_confirmed", providerRef: "pi_1" })).toEqual({
      ok: true,
      status: "confirmed"
    });
    expect(transition("approved", { type: "provider_confirmed" }).ok).toBe(false);
    expect(transition("queued", { type: "provider_confirmed" }).ok).toBe(false);
    expect(transition("executing", { type: "provider_confirmed" }).ok).toBe(false);
    expect(canConfirmFromProvider("provider_pending")).toBe(true);
    expect(canConfirmFromProvider("approved")).toBe(false);
  });

  it("provider failure lands on failed, never on a success state", () => {
    expect(transition("provider_pending", { type: "provider_failed" }).status).toBe("failed");
    expect(transition("executing", { type: "provider_failed" }).status).toBe("failed");
  });

  it("terminal states reject every transition", () => {
    const terminals: ApprovalStatus[] = ["confirmed", "failed", "cancelled", "invalidated"];
    for (const t of terminals) {
      expect(isTerminalApproval(t)).toBe(true);
      const r = transition(t, { type: "edit" });
      expect(r.ok).toBe(false);
    }
  });

  it("rejects structurally invalid moves instead of guessing", () => {
    expect(transition("draft", { type: "approve", actor: "u1" }).ok).toBe(false);
    expect(transition("executing", { type: "cancel", actor: "u1" }).ok).toBe(false);
  });
});
