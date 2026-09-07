import { describe, expect, it } from "vitest";
import {
  evaluateCommunication, inQuietHours, nextAllowedTime, communicationDedupeKey, isPlausibleEmail,
  type CommunicationFacts, type CommunicationPolicy
} from "../src/communication";

const NOW = new Date("2026-09-06T12:00:00Z");

function facts(over: Partial<CommunicationFacts> = {}): CommunicationFacts {
  return {
    caseStatus: "retrying", paymentStatus: "failed", declineCategory: "insufficient_funds",
    executedAutoRetries: 1, hasUnresolvedExecution: false, recipientEmail: "member@example.test",
    customerDeleted: false, existingPurposes: [], lastSentAt: null, now: NOW, localHour: 12, ...over
  };
}
function policy(over: Partial<CommunicationPolicy> = {}): CommunicationPolicy {
  return { sendsPaused: false, noteAfterFailedRetries: 1, quietHoursStart: 21, quietHoursEnd: 8, cooldownHours: 72, aiEnabled: true, trustLevel: 0, ...over };
}

describe("communication policy — deterministic, fail-closed", () => {
  it("allows a dunning note after the configured number of failed automated retries", () => {
    const d = evaluateCommunication("retry_failed", facts(), policy());
    expect(d.allowed).toBe(true);
    if (d.allowed) {
      expect(d.purpose).toBe("dunning_note");
      expect(d.channel).toBe("email");
      expect(d.sendAfter.getTime()).toBe(NOW.getTime());
      expect(d.requiresHumanApproval).toBe(true); // trust_level 0 = pilot
      expect(d.aiPermitted).toBe(true);
    }
  });
  it("refuses before the retry threshold (rules decide timing, not AI)", () => {
    const d = evaluateCommunication("retry_failed", facts({ executedAutoRetries: 0 }), policy({ noteAfterFailedRetries: 2 }));
    expect(d).toEqual({ allowed: false, reason: "note_threshold_not_met:0/2" });
  });
  it("kill switch wins over everything", () => {
    expect(evaluateCommunication("retry_failed", facts(), policy({ sendsPaused: true }))).toEqual({ allowed: false, reason: "sends_paused" });
  });
  it("never communicates while a financial outcome is unresolved (4C boundary)", () => {
    expect(evaluateCommunication("retry_failed", facts({ hasUnresolvedExecution: true }), policy())).toEqual({ allowed: false, reason: "execution_unresolved" });
  });
  it("never communicates about a paid/non-failed payment", () => {
    expect(evaluateCommunication("retry_failed", facts({ paymentStatus: "paid" }), policy()).allowed).toBe(false);
    expect(evaluateCommunication("retry_failed", facts({ paymentStatus: "open" }), policy()).allowed).toBe(false);
  });
  it("hard declines (lost/stolen) are never outreach-safe", () => {
    expect(evaluateCommunication("retry_failed", facts({ declineCategory: "hard" }), policy())).toEqual({ allowed: false, reason: "decline_not_outreach_safe" });
  });
  it("missing / malformed recipient ⇒ no communication", () => {
    expect(evaluateCommunication("retry_failed", facts({ recipientEmail: null }), policy())).toEqual({ allowed: false, reason: "no_recipient" });
    expect(evaluateCommunication("retry_failed", facts({ recipientEmail: "bad\r\nbcc: x@y.z" }), policy())).toEqual({ allowed: false, reason: "no_recipient" });
    expect(evaluateCommunication("retry_failed", facts({ customerDeleted: true }), policy())).toEqual({ allowed: false, reason: "customer_deleted" });
  });
  it("terminal recovered/canceled/dismissed cases are not communicable", () => {
    for (const s of ["recovered", "canceled", "dismissed", "detected"]) {
      expect(evaluateCommunication("retry_failed", facts({ caseStatus: s }), policy()).allowed).toBe(false);
    }
  });
  it("case_lost ⇒ final_notice, and only when the case really is lost", () => {
    const d = evaluateCommunication("case_lost", facts({ caseStatus: "lost" }), policy());
    expect(d.allowed && d.purpose).toBe("final_notice");
    expect(evaluateCommunication("case_lost", facts({ caseStatus: "retrying" }), policy())).toEqual({ allowed: false, reason: "case_not_lost" });
    expect(evaluateCommunication("retry_failed", facts({ caseStatus: "lost" }), policy())).toEqual({ allowed: false, reason: "case_lost_use_final_notice" });
  });
  it("deduplicates: one purpose per case", () => {
    expect(evaluateCommunication("retry_failed", facts({ existingPurposes: ["dunning_note"] }), policy())).toEqual({ allowed: false, reason: "already_communicated" });
  });
  it("applies quiet hours deterministically", () => {
    const d = evaluateCommunication("retry_failed", facts({ localHour: 23 }), policy());
    expect(d.allowed && d.sendAfter.getTime()).toBe(new Date("2026-09-06T21:00:00Z").getTime()); // +9h to local 08:00, minutes zeroed
  });
  it("applies the cooldown from the last send", () => {
    const last = new Date(NOW.getTime() - 10 * 3_600_000);
    const d = evaluateCommunication("case_lost", facts({ caseStatus: "lost", lastSentAt: last, existingPurposes: ["dunning_note"] }), policy({ cooldownHours: 72 }));
    expect(d.allowed && d.sendAfter.getTime()).toBe(last.getTime() + 72 * 3_600_000);
  });
  it("AI permission and human approval come from policy, never from content", () => {
    const a = evaluateCommunication("retry_failed", facts(), policy({ aiEnabled: false, trustLevel: 2 }));
    expect(a.allowed && a.aiPermitted).toBe(false);
    expect(a.allowed && a.requiresHumanApproval).toBe(false);
  });
  it("notes disabled (threshold 0) ⇒ no notes at all", () => {
    expect(evaluateCommunication("retry_failed", facts(), policy({ noteAfterFailedRetries: 0 }))).toEqual({ allowed: false, reason: "notes_disabled" });
  });
});

describe("helpers", () => {
  it("quiet-hour window wraps midnight", () => {
    expect(inQuietHours(23, 21, 8)).toBe(true);
    expect(inQuietHours(3, 21, 8)).toBe(true);
    expect(inQuietHours(12, 21, 8)).toBe(false);
    expect(inQuietHours(12, 9, 17)).toBe(true);
    expect(inQuietHours(5, 5, 5)).toBe(false);
  });
  it("nextAllowedTime is identity outside quiet hours", () => {
    expect(nextAllowedTime(NOW, 12, 21, 8).getTime()).toBe(NOW.getTime());
  });
  it("dedupe key is a pure function of org+case+purpose", () => {
    expect(communicationDedupeKey("o", "c", "dunning_note")).toBe("comm:o:c:dunning_note");
  });
  it("email plausibility rejects header-injection shapes", () => {
    expect(isPlausibleEmail("a@b.co")).toBe(true);
    expect(isPlausibleEmail("a@b.co\nbcc:x@y.z")).toBe(false);
    expect(isPlausibleEmail("a b@c.d")).toBe(false);
    expect(isPlausibleEmail("<a@b.co>")).toBe(false);
  });
});
