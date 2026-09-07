/**
 * Phase 6 — durable communication state: policy from authoritative facts,
 * deterministic identity (no duplicate logical sends), concurrent delivery,
 * email failure classes, send-time re-verification, reconciliation,
 * retention, and tenant isolation. Providers are fakes (no network).
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { appDb, communicationService, recoveryService } from "@revessent/server";
import * as schema from "@revessent/db";
import { withOrgTx, createDb } from "@revessent/db";
import { setEmailProviderForTests, resetEmailProvider } from "@revessent/integrations";
import { fakeEmailProvider } from "@revessent/integrations/email-fixtures";
import { setAiProviderForTests, resetAiProvider } from "@revessent/ai";
import { fakeAiProvider } from "@revessent/ai/fakes";
import { createTestOrg, createTestUser, ctxFor, setPlanForTests, suffix, type TestUser } from "./helpers";


interface Fixture { caseId: string; customerId: string; paymentId: string }

async function seedCase(orgId: string, over: { status?: string; email?: string | null; autoRetries?: number; amountCents?: number; declineCategory?: string; policyVersion?: number } = {}): Promise<Fixture> {
  return withOrgTx(appDb(), orgId, async (tx) => {
    const [cust] = await tx.insert(schema.customers).values({
      orgId, stripeCustomerId: `cus_${suffix()}`, name: "Zoe Example <script>", email: over.email === undefined ? `zoe-${suffix()}@example.test` : over.email, currency: "USD"
    }).returning();
    const [payment] = await tx.insert(schema.payments).values({
      orgId, customerId: cust!.id, amountCents: over.amountCents ?? 4900, currency: "USD", status: "failed", failedAt: new Date(), declineCode: "insufficient_funds"
    }).returning();
    const [c] = await tx.insert(schema.recoveryCases).values({
      orgId, customerId: cust!.id, paymentId: payment!.id, status: over.status ?? "retrying",
      declineCode: "insufficient_funds", declineCategory: over.declineCategory ?? "insufficient_funds",
      amountCents: over.amountCents ?? 4900, currency: "USD", firstFailedAt: new Date(),
      retryPolicyVersion: over.policyVersion ?? 1
    }).returning();
    for (let i = 1; i <= (over.autoRetries ?? 1); i++) {
      await tx.insert(schema.recoveryAttempts).values({
        orgId, caseId: c!.id, kind: "auto_retry", status: "failed", attemptNo: i, scheduledFor: new Date(), decisionReason: "test", policyVersion: 1
      });
    }
    return { caseId: c!.id, customerId: cust!.id, paymentId: payment!.id };
  });
}

async function messageRow(orgId: string, id: string) {
  const [m] = await withOrgTx(appDb(), orgId, (tx) => tx.select().from(schema.recoveryMessages).where(eq(schema.recoveryMessages.id, id)));
  return m!;
}
/** trust_level is an operator-of-the-platform setting (no tenant API by design); tests set it with the privileged role. */
async function setTrust(orgId: string, level: number) {
  const systemDb = createDb(process.env.SCHEDULER_DATABASE_URL!);
  await systemDb.update(schema.organizations).set({ trustLevel: level }).where(eq(schema.organizations.id, orgId));
}

const NO_QUIET = { quietHoursStart: 0, quietHoursEnd: 0 } as const;

describe("communication service (Phase 6)", () => {
  let owner: TestUser; let slug = ""; let orgId = "";
  beforeAll(async () => {
    owner = await createTestUser("comm-owner");
    const o = await createTestOrg(owner, "comm"); slug = o.slug; orgId = o.orgId;
    await setPlanForTests(orgId, "revessent", "active"); // Phase 7: AI notes + trust autonomy are paid capabilities
    // Deterministic timing: quiet hours disabled (start === end) so these tests
    // do not depend on the wall-clock hour the suite happens to run at.
    await withOrgTx(appDb(), orgId, (tx) => tx.insert(schema.retryPolicies).values({ orgId, version: 1, rules: NO_QUIET, createdBy: owner.id }));
  });
  afterEach(() => { resetEmailProvider(); resetAiProvider(); });

  it("prepare: refuses from authoritative facts, audits, creates no row", async () => {
    const ctx = await ctxFor(owner, slug, "operate");
    const f = await seedCase(orgId, { autoRetries: 0 });
    const r = await communicationService.prepareCommunication(ctx, f.caseId, "retry_failed");
    expect(r).toEqual({ result: "not_allowed", reason: "note_threshold_not_met:0/1" });
    const msgs = await withOrgTx(appDb(), orgId, (tx) => tx.select().from(schema.recoveryMessages).where(eq(schema.recoveryMessages.caseId, f.caseId)));
    expect(msgs).toHaveLength(0);
    const audits = await withOrgTx(appDb(), orgId, (tx) => tx.select().from(schema.auditLogs).where(and(eq(schema.auditLogs.targetId, f.caseId), eq(schema.auditLogs.action, "communication.not_allowed"))));
    expect(audits).toHaveLength(1);
  });

  it("prepare: creates ONE durable row per purpose; duplicates converge (idempotent identity)", async () => {
    setAiProviderForTests(fakeAiProvider({ kind: "ok" }));
    const ctx = await ctxFor(owner, slug, "operate");
    const f = await seedCase(orgId);
    const [a, b, c] = await Promise.all([
      communicationService.prepareCommunication(ctx, f.caseId, "retry_failed"),
      communicationService.prepareCommunication(ctx, f.caseId, "retry_failed"),
      communicationService.prepareCommunication(ctx, f.caseId, "retry_failed")
    ]);
    const ids = new Set([a, b, c].map((r) => (r as { messageId: string }).messageId));
    expect(ids.size).toBe(1);
    expect([a, b, c].filter((r) => r.result === "created")).toHaveLength(1);
    const again = await communicationService.prepareCommunication(ctx, f.caseId, "retry_failed");
    expect(again.result).toBe("exists");
    const row = await messageRow(orgId, [...ids][0]!);
    expect(row.dedupeKey).toBe(`comm:${orgId}:${f.caseId}:dunning_note`);
    expect(row.generationSource).toBe("ai");
    expect(row.approvalStatus).toBe("awaiting_approval"); // trust 0 ⇒ human
    expect(row.sendStatus).toBe("pending");
    expect(row.body).not.toMatch(/\$|49|https?:/); // unrendered, no money/links
    expect(row.body).toContain("{{amount}}");
    expect((row.factSnapshot as { amountFormatted: string }).amountFormatted).toBe("$49");
    // ai_generations stores validated output only
    const [gen] = await withOrgTx(appDb(), orgId, (tx) => tx.select().from(schema.aiGenerations).where(eq(schema.aiGenerations.id, row.aiGenerationId!)));
    expect(gen!.valid).toBe(true);
    expect(gen!.provider).toBe("fake");
  });

  it("prepare: AI failure ⇒ deterministic fallback row, still one identity", async () => {
    setAiProviderForTests(fakeAiProvider({ kind: "throw", code: "ai_unavailable" }));
    const ctx = await ctxFor(owner, slug, "operate");
    const f = await seedCase(orgId);
    const r = await communicationService.prepareCommunication(ctx, f.caseId, "retry_failed");
    expect(r.result).toBe("created");
    const row = await messageRow(orgId, (r as { messageId: string }).messageId);
    expect(row.generationSource).toBe("fallback");
    expect(row.fallbackReason).toBe("ai_unavailable");
    expect(row.template).toMatch(/^dunning_note:/);
  });

  it("prepare: prohibited AI content ⇒ fallback, and the rejected output is recorded as invalid (no raw text)", async () => {
    setAiProviderForTests(fakeAiProvider({ kind: "ok", copy: { paragraphs: ["Pay now at https://evil.example or face legal action"] } }));
    const ctx = await ctxFor(owner, slug, "operate");
    const f = await seedCase(orgId);
    const r = await communicationService.prepareCommunication(ctx, f.caseId, "retry_failed");
    const row = await messageRow(orgId, (r as { messageId: string }).messageId);
    expect(row.generationSource).toBe("fallback");
    expect(row.fallbackReason).toBe("ai_prohibited_content");
    expect(row.body).not.toContain("evil.example");
    const [gen] = await withOrgTx(appDb(), orgId, (tx) => tx.select().from(schema.aiGenerations).where(eq(schema.aiGenerations.id, row.aiGenerationId!)));
    expect(gen!.valid).toBe(false);
    expect(JSON.stringify(gen!.output)).not.toContain("evil.example");
  });

  it("deliver: not approved ⇒ nothing sent; approved+due ⇒ exactly one provider call under concurrency", async () => {
    const email = fakeEmailProvider({ kind: "ok" });
    setEmailProviderForTests(email);
    setAiProviderForTests(null);
    const ctx = await ctxFor(owner, slug, "operate");
    const f = await seedCase(orgId);
    const p = await communicationService.prepareCommunication(ctx, f.caseId, "retry_failed");
    const id = (p as { messageId: string }).messageId;
    expect((await communicationService.deliverCommunication(ctx, id)).result).toBe("not_approved");
    expect(email.attempts).toHaveLength(0);

    await recoveryService.applyDraftAction(ctx, f.caseId, id, { type: "approve", actor: ctx.userId }, {});
    const results = await Promise.all(Array.from({ length: 6 }, () => communicationService.deliverCommunication(ctx, id)));
    expect(results.filter((r) => r.result === "sent")).toHaveLength(1);
    expect(results.filter((r) => r.result === "claimed_elsewhere" || r.result === "already_sent")).toHaveLength(5);
    expect(email.attempts).toHaveLength(1);
    const sent = email.accepted[0]!;
    expect(sent.to).toBe((await withOrgTx(appDb(), orgId, (tx) => tx.select().from(schema.customers).where(eq(schema.customers.id, f.customerId))))[0]!.email);
    expect(sent.from).toBe("billing@notifications.revessent.test");
    expect(sent.replyTo).toBeNull();
    expect(sent.idempotencyReference).toBe(id);
    // application-rendered facts, app-owned CTA, HTML escaped name
    expect(sent.text).toContain("$49");
    expect(sent.text).toMatch(/http:\/\/localhost:3000\/c\/[A-Za-z0-9_-]{22}/);
    expect(sent.text).not.toContain("{{");
    expect(sent.html).not.toContain("<script>");
    expect(sent.subject).not.toMatch(/[\r\n]/);
    const row = await messageRow(orgId, id);
    expect(row.sendStatus).toBe("sent");
    expect(row.approvalStatus).toBe("sent");
    expect(row.providerMessageId).toBeTruthy();
    // a replayed delivery after success is a no-op
    expect((await communicationService.deliverCommunication(ctx, id)).result).toBe("already_sent");
    expect(email.attempts).toHaveLength(1);
    const [c] = await withOrgTx(appDb(), orgId, (tx) => tx.select().from(schema.recoveryCases).where(eq(schema.recoveryCases.id, f.caseId)));
    expect(c!.status).toBe("contacting");
  });

  it("deliver: trust_level ≥ 1 auto-approves, but quiet hours/cooldown still gate (not_due)", async () => {
    await setTrust(orgId, 1);
    await withOrgTx(appDb(), orgId, (tx) => tx.insert(schema.retryPolicies).values({ orgId, version: 10, rules: { quietHoursStart: 21, quietHoursEnd: 8 }, createdBy: owner.id }));
    try {
      setAiProviderForTests(null);
      const ctx = await ctxFor(owner, slug, "operate");
      const f = await seedCase(orgId, { policyVersion: 10 }); // pinned to the quiet-hours policy version
      const p = await communicationService.prepareCommunication(ctx, f.caseId, "retry_failed", { now: new Date("2026-09-06T02:00:00Z") }); // 02:00 UTC = quiet
      const id = (p as { messageId: string }).messageId;
      const row = await messageRow(orgId, id);
      expect(row.approvalStatus).toBe("approved");
      expect(row.autoApproved).toBe(true);
      expect(row.sendAfter!.getTime()).toBe(new Date("2026-09-06T08:00:00Z").getTime());
      expect((await communicationService.deliverCommunication(ctx, id, { now: new Date("2026-09-06T03:00:00Z") })).result).toBe("not_due");
    } finally {
      await setTrust(orgId, 0);
      await withOrgTx(appDb(), orgId, (tx) => tx.insert(schema.retryPolicies).values({ orgId, version: 11, rules: NO_QUIET, createdBy: owner.id }));
    }
  });

  async function approvedMessage(ctx: Awaited<ReturnType<typeof ctxFor>>, f: Fixture): Promise<string> {
    const p = await communicationService.prepareCommunication(ctx, f.caseId, "retry_failed");
    const id = (p as { messageId: string }).messageId;
    // prepared rows are already awaiting_approval (trust 0): a human approves
    await recoveryService.applyDraftAction(ctx, f.caseId, id, { type: "approve", actor: ctx.userId }, {});
    return id;
  }

  it("deliver: transient provider failure ⇒ back to pending with backoff, budget exhaustion ⇒ failed", async () => {
    setAiProviderForTests(null);
    const email = fakeEmailProvider({ kind: "transient" });
    setEmailProviderForTests(email);
    const ctx = await ctxFor(owner, slug, "operate");
    const id = await approvedMessage(ctx, await seedCase(orgId));
    const now = new Date();
    const r1 = await communicationService.deliverCommunication(ctx, id, { now });
    expect(r1.result).toBe("failed_transient");
    let row = await messageRow(orgId, id);
    expect(row.sendStatus).toBe("pending");
    expect(row.sendAttempts).toBe(1);
    expect(row.sendAfter!.getTime()).toBe(now.getTime() + 5 * 60_000);
    // Not due yet ⇒ refused without provider call
    expect((await communicationService.deliverCommunication(ctx, id, { now })).result).toBe("not_due");
    expect(email.attempts).toHaveLength(1);
    // spend the budget (EMAIL_MAX_SEND_ATTEMPTS default 4)
    for (let i = 2; i <= 4; i++) {
      row = await messageRow(orgId, id);
      await communicationService.deliverCommunication(ctx, id, { now: new Date(row.sendAfter!.getTime() + 1) });
    }
    row = await messageRow(orgId, id);
    expect(row.sendStatus).toBe("failed");
    expect(row.approvalStatus).toBe("failed");
    expect(row.sendAttempts).toBe(4);
    expect(email.attempts).toHaveLength(4);
  });

  it("deliver: permanent failure ⇒ failed, never retried", async () => {
    setAiProviderForTests(null);
    const email = fakeEmailProvider({ kind: "permanent" });
    setEmailProviderForTests(email);
    const ctx = await ctxFor(owner, slug, "operate");
    const id = await approvedMessage(ctx, await seedCase(orgId));
    expect((await communicationService.deliverCommunication(ctx, id)).result).toBe("failed_permanent");
    expect((await communicationService.deliverCommunication(ctx, id)).result).toBe("claimed_elsewhere");
    expect(email.attempts).toHaveLength(1);
    expect((await messageRow(orgId, id)).lastSendErrorCode).toBe("invalid_recipient");
  });

  it("deliver: AMBIGUOUS result ⇒ unknown, never auto-resent; reconciliation resolves by reference only", async () => {
    setAiProviderForTests(null);
    const email = fakeEmailProvider({ kind: "ambiguous_accepted" });
    setEmailProviderForTests(email);
    const ctx = await ctxFor(owner, slug, "operate");
    const id = await approvedMessage(ctx, await seedCase(orgId));
    expect((await communicationService.deliverCommunication(ctx, id)).result).toBe("unknown");
    expect((await communicationService.deliverCommunication(ctx, id)).result).toBe("claimed_elsewhere");
    expect(email.attempts).toHaveLength(1);
    expect((await messageRow(orgId, id)).sendStatus).toBe("unknown");
    // the provider actually accepted it — reconcile marks it sent WITHOUT a second send
    const rec = await communicationService.reconcileUnknownSends(ctx, (ref) => email.findByReference(ref));
    expect(rec.resolvedSent).toContain(id);
    expect((await messageRow(orgId, id)).sendStatus).toBe("sent");
    expect(email.attempts).toHaveLength(1);
  });

  it("deliver: AMBIGUOUS + lost ⇒ stays unknown for an operator (silence over a duplicate email)", async () => {
    setAiProviderForTests(null);
    const email = fakeEmailProvider({ kind: "ambiguous_lost" });
    setEmailProviderForTests(email);
    const ctx = await ctxFor(owner, slug, "operate");
    const id = await approvedMessage(ctx, await seedCase(orgId));
    expect((await communicationService.deliverCommunication(ctx, id)).result).toBe("unknown");
    const rec = await communicationService.reconcileUnknownSends(ctx, (ref) => email.findByReference(ref));
    expect(rec.stillUnknown).toContain(id);
    expect((await messageRow(orgId, id)).sendStatus).toBe("unknown");
  });

  it("deliver: no provider / rejected credentials ⇒ deferred_configuration (pending, no attempt consumed, 1h cooldown)", async () => {
    setAiProviderForTests(null);
    setEmailProviderForTests(null);
    const ctx = await ctxFor(owner, slug, "operate");
    const id = await approvedMessage(ctx, await seedCase(orgId));
    const now = new Date();
    const r = await communicationService.deliverCommunication(ctx, id, { now });
    expect(r).toMatchObject({ result: "deferred_configuration", code: "not_configured" });
    let row = await messageRow(orgId, id);
    expect(row.sendStatus).toBe("pending");
    expect(row.sendAttempts).toBe(0);
    expect(row.sendAfter!.getTime()).toBe(now.getTime() + 3_600_000);
    // 401/403 from the provider is the same class: configuration, not a retry
    const email = fakeEmailProvider({ kind: "configuration" });
    setEmailProviderForTests(email);
    const later = new Date(now.getTime() + 3_600_001);
    const r2 = await communicationService.deliverCommunication(ctx, id, { now: later });
    expect(r2).toMatchObject({ result: "deferred_configuration", code: "auth_failure" });
    row = await messageRow(orgId, id);
    expect(row.sendStatus).toBe("pending");
    expect(row.sendAttempts).toBe(0);
    expect(email.attempts).toHaveLength(1);
  });

  it("deliver: send-time re-verification suppresses when the payment got paid / facts changed / recipient changed", async () => {
    setAiProviderForTests(null);
    const email = fakeEmailProvider({ kind: "ok" });
    setEmailProviderForTests(email);
    const ctx = await ctxFor(owner, slug, "operate");
    // paid
    const f1 = await seedCase(orgId); const id1 = await approvedMessage(ctx, f1);
    await withOrgTx(appDb(), orgId, (tx) => tx.update(schema.payments).set({ status: "paid" }).where(eq(schema.payments.id, f1.paymentId)));
    expect(await communicationService.deliverCommunication(ctx, id1)).toMatchObject({ result: "suppressed", reason: "payment_paid" });
    // amount changed after approval
    const f2 = await seedCase(orgId); const id2 = await approvedMessage(ctx, f2);
    await withOrgTx(appDb(), orgId, (tx) => tx.update(schema.recoveryCases).set({ amountCents: 9900 }).where(eq(schema.recoveryCases.id, f2.caseId)));
    expect(await communicationService.deliverCommunication(ctx, id2)).toMatchObject({ result: "suppressed", reason: "facts_changed" });
    // recipient changed
    const f3 = await seedCase(orgId); const id3 = await approvedMessage(ctx, f3);
    await withOrgTx(appDb(), orgId, (tx) => tx.update(schema.customers).set({ email: "other@example.test" }).where(eq(schema.customers.id, f3.customerId)));
    expect(await communicationService.deliverCommunication(ctx, id3)).toMatchObject({ result: "suppressed", reason: "recipient_changed" });
    // kill switch
    const f4 = await seedCase(orgId); const id4 = await approvedMessage(ctx, f4);
    // (a NEW policy version — policies are append-only; the kill switch is read from the latest version)
    await withOrgTx(appDb(), orgId, (tx) => tx.insert(schema.retryPolicies).values({ orgId, version: 20, rules: { ...NO_QUIET, communication: { sendsPaused: true } }, createdBy: owner.id }));
    try {
      expect(await communicationService.deliverCommunication(ctx, id4)).toMatchObject({ result: "suppressed", reason: "sends_paused" });
    } finally {
      await withOrgTx(appDb(), orgId, (tx) => tx.insert(schema.retryPolicies).values({ orgId, version: 21, rules: NO_QUIET, createdBy: owner.id }));
    }
    expect(email.attempts).toHaveLength(0);
  });

  it("operator edits are held to the same content red lines (edit path + send path)", async () => {
    setAiProviderForTests(null);
    const email = fakeEmailProvider({ kind: "ok" });
    setEmailProviderForTests(email);
    const ctx = await ctxFor(owner, slug, "operate");
    const f = await seedCase(orgId);
    const p = await communicationService.prepareCommunication(ctx, f.caseId, "retry_failed");
    const id = (p as { messageId: string }).messageId;
    await expect(recoveryService.applyDraftAction(ctx, f.caseId, id,
      { type: "edit", subject: "Pay now", body: "Send $49 to https://evil.example", actor: ctx.userId }, {})).rejects.toThrow(/not allowed/);
    // bypass the edit API (direct DB write) — the send path still refuses
    await withOrgTx(appDb(), orgId, (tx) => tx.update(schema.recoveryMessages).set({ body: "Legal action will follow. {{cta_link}}" }).where(eq(schema.recoveryMessages.id, id)));
    await recoveryService.applyDraftAction(ctx, f.caseId, id, { type: "approve", actor: ctx.userId }, {});
    const r = await communicationService.deliverCommunication(ctx, id);
    expect(r).toMatchObject({ result: "suppressed", reason: "content_violation:legal_threat" });
    expect(email.attempts).toHaveLength(0);
  });

  it("final notice: only for lost cases, distinct identity from the dunning note", async () => {
    setAiProviderForTests(null);
    const ctx = await ctxFor(owner, slug, "operate");
    const f = await seedCase(orgId, { status: "lost" });
    expect((await communicationService.prepareCommunication(ctx, f.caseId, "retry_failed")).result).toBe("not_allowed");
    const r = await communicationService.prepareCommunication(ctx, f.caseId, "case_lost");
    expect(r.result).toBe("created");
    const row = await messageRow(orgId, (r as { messageId: string }).messageId);
    expect(row.purpose).toBe("final_notice");
    expect(row.dedupeKey).toBe(`comm:${orgId}:${f.caseId}:final_notice`);
  });

  it("discovery: candidates and due sends are org-scoped and exclude already-communicated cases", async () => {
    setAiProviderForTests(null);
    const ctx = await ctxFor(owner, slug, "operate");
    const f = await seedCase(orgId);
    const before = await communicationService.findCommunicationCandidates(appDb(), orgId, 500);
    expect(before.some((c) => c.caseId === f.caseId && c.trigger === "retry_failed")).toBe(true);
    const id = await approvedMessage(ctx, f);
    const after = await communicationService.findCommunicationCandidates(appDb(), orgId, 500);
    expect(after.some((c) => c.caseId === f.caseId)).toBe(false);
    const due = await communicationService.findDueSends(appDb(), orgId, 500, new Date());
    expect(due.some((d) => d.messageId === id)).toBe(true);
  });

  it("retention: bodies of old sent messages are redacted, snapshot/audit retained", async () => {
    setAiProviderForTests(null);
    setEmailProviderForTests(fakeEmailProvider({ kind: "ok" }));
    const ctx = await ctxFor(owner, slug, "operate");
    const id = await approvedMessage(ctx, await seedCase(orgId));
    expect((await communicationService.deliverCommunication(ctx, id)).result).toBe("sent");
    await withOrgTx(appDb(), orgId, (tx) => tx.update(schema.recoveryMessages).set({ sentAt: new Date(Date.now() - 400 * 86_400_000) }).where(eq(schema.recoveryMessages.id, id)));
    expect(await communicationService.redactOldMessageBodies(appDb(), orgId, 365)).toBeGreaterThanOrEqual(1);
    const row = await messageRow(orgId, id);
    expect(row.body).toBe("[redacted: retention]");
    expect(row.recipientEmail).toBeNull();
    expect(row.sendStatus).toBe("sent"); // state + audit retained, content gone
    expect(await communicationService.redactOldMessageBodies(appDb(), orgId, 365)).toBe(0);
  });

  it("TENANT ISOLATION: another org cannot prepare, deliver, discover or read this org's communications", async () => {
    setAiProviderForTests(null);
    const email = fakeEmailProvider({ kind: "ok" });
    setEmailProviderForTests(email);
    const ctx = await ctxFor(owner, slug, "operate");
    const f = await seedCase(orgId);
    const id = await approvedMessage(ctx, f);

    const other = await createTestUser("comm-other");
    const o2 = await createTestOrg(other, "comm2");
    const ctx2 = await ctxFor(other, o2.slug, "operate");
    expect(await communicationService.prepareCommunication(ctx2, f.caseId, "retry_failed")).toEqual({ result: "no_such_case" });
    expect(await communicationService.deliverCommunication(ctx2, id)).toEqual({ result: "no_such_message", messageId: id });
    expect(email.attempts).toHaveLength(0);
    expect((await communicationService.findDueSends(appDb(), o2.orgId, 500, new Date())).some((d) => d.messageId === id)).toBe(false);
    expect((await communicationService.findCommunicationCandidates(appDb(), o2.orgId, 500)).some((c) => c.caseId === f.caseId)).toBe(false);
    const leaked = await withOrgTx(appDb(), o2.orgId, (tx) => tx.select().from(schema.recoveryMessages).where(eq(schema.recoveryMessages.id, id)));
    expect(leaked).toHaveLength(0);
    // RLS: cross-org insert with a forged org_id is rejected
    await expect(withOrgTx(appDb(), o2.orgId, (tx) => tx.insert(schema.recoveryMessages).values({
      caseId: f.caseId, orgId, subject: "x", body: "y", approvalStatus: "draft"
    }))).rejects.toThrow();
    // the real org still delivers fine
    expect((await communicationService.deliverCommunication(ctx, id)).result).toBe("sent");
  });
});
