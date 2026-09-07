/**
 * PHASE 6 — RECOVERY COMMUNICATION SERVICE.
 *
 *   Phase 4D lifecycle event (retry_failed | case_lost)
 *     → prepareCommunication:   authoritative DB facts → deterministic policy
 *                               → AI (if permitted) → schema + safety validation
 *                               → deterministic fallback → DURABLE recovery_messages row
 *     → (human approval on pilot orgs; policy auto-approval otherwise)
 *     → deliverCommunication:   atomic claim → facts re-verified → application-
 *                               controlled recipient/sender/CTA → email provider
 *                               → durable result (sent | failed | suppressed | unknown)
 *
 * Financial authority is unchanged: this module reads case/payment state and
 * NEVER writes payments, attempts, amounts, currencies, case status, or retry
 * scheduling. AI is a copywriter behind @revessent/ai; it cannot influence
 * recipient, sender, URL, amount, timing, or whether anything is sent.
 */
import { and, desc, eq, inArray, isNotNull, lte, sql } from "drizzle-orm";
import * as schema from "@revessent/db";
import { withOrgTx, type Db } from "@revessent/db";
import {
  evaluateCommunication, communicationDedupeKey, DEFAULT_COMMUNICATION_POLICY, formatMoney,
  type CommunicationFacts, type CommunicationPolicy, type CommunicationPurpose, type LifecycleTrigger, type CommunicationDecision
} from "@revessent/domain";
import { generateCopy, getAiProvider, renderEmail, sanitizeUntrusted, validateCopy, AiCopySchema, type AiCopy } from "@revessent/ai";
import { getEmailProvider, isEmailProviderError, type OutboundEmail } from "@revessent/integrations";
import { communicationEnv } from "@revessent/config";
import { createLogger, redact } from "@revessent/observability";
import type { OrgContext } from "../context.js";
import { appDb } from "../context.js";
import { audit } from "./audit.js";
import { createCheckoutLink } from "./checkout.js";
import { isCustomerSuppressed } from "./suppression.js";

const log = createLogger("communication");

type MessageRow = typeof schema.recoveryMessages.$inferSelect;
type CaseRow = typeof schema.recoveryCases.$inferSelect;
type PaymentRow = typeof schema.payments.$inferSelect;
type CustomerRow = typeof schema.customers.$inferSelect;

export const COMMUNICATION_ACTOR = "system";

/* ---------------------------------------------------------------- policy */

/** Org communication policy from durable settings (retry_policies rules + org trust level). */
export async function resolveCommunicationPolicy(db: Db, orgId: string, trustLevel: number, policyVersion?: number | null): Promise<CommunicationPolicy> {
  type Rules = {
    noteAfterFailedRetries?: number; quietHoursStart?: number; quietHoursEnd?: number;
    communication?: { sendsPaused?: boolean; cooldownHours?: number; aiEnabled?: boolean };
  };
  const { latest, pinned } = await withOrgTx(db, orgId, async (tx) => {
    const [latestRow] = await tx.select().from(schema.retryPolicies)
      .where(eq(schema.retryPolicies.orgId, orgId)).orderBy(desc(schema.retryPolicies.version)).limit(1);
    const [pinnedRow] = policyVersion
      ? await tx.select().from(schema.retryPolicies)
          .where(and(eq(schema.retryPolicies.orgId, orgId), eq(schema.retryPolicies.version, policyVersion))).limit(1)
      : [latestRow];
    return { latest: (latestRow?.rules ?? {}) as Rules, pinned: ((pinnedRow ?? latestRow)?.rules ?? {}) as Rules };
  });
  return {
    // The kill switch is read from the LATEST policy so pausing is immediate
    // for every case, whatever version the case was decided under.
    sendsPaused: latest.communication?.sendsPaused ?? DEFAULT_COMMUNICATION_POLICY.sendsPaused,
    noteAfterFailedRetries: pinned.noteAfterFailedRetries ?? DEFAULT_COMMUNICATION_POLICY.noteAfterFailedRetries,
    quietHoursStart: pinned.quietHoursStart ?? DEFAULT_COMMUNICATION_POLICY.quietHoursStart,
    quietHoursEnd: pinned.quietHoursEnd ?? DEFAULT_COMMUNICATION_POLICY.quietHoursEnd,
    cooldownHours: pinned.communication?.cooldownHours ?? DEFAULT_COMMUNICATION_POLICY.cooldownHours,
    aiEnabled: latest.communication?.aiEnabled ?? DEFAULT_COMMUNICATION_POLICY.aiEnabled,
    trustLevel
  };
}

function localHourIn(timezone: string, at: Date): number {
  try {
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", hourCycle: "h23" }).formatToParts(at);
    const h = Number(parts.find((p) => p.type === "hour")?.value ?? at.getUTCHours());
    return Number.isFinite(h) ? h % 24 : at.getUTCHours();
  } catch {
    return at.getUTCHours();
  }
}

/* ------------------------------------------------------- authoritative facts */

interface Loaded {
  c: CaseRow; p: PaymentRow; customer: CustomerRow | null;
  messages: MessageRow[]; executedAutoRetries: number; hasUnresolvedExecution: boolean;
}

async function loadAuthoritative(db: Db, orgId: string, caseId: string): Promise<Loaded | null> {
  return withOrgTx(db, orgId, async (tx) => {
    const [row] = await tx.select({ c: schema.recoveryCases, p: schema.payments })
      .from(schema.recoveryCases)
      .innerJoin(schema.payments, eq(schema.recoveryCases.paymentId, schema.payments.id))
      .where(and(eq(schema.recoveryCases.id, caseId), eq(schema.recoveryCases.orgId, orgId)));
    if (!row) return null;
    const [customer] = await tx.select().from(schema.customers).where(eq(schema.customers.id, row.c.customerId));
    const attempts = await tx.select().from(schema.recoveryAttempts).where(eq(schema.recoveryAttempts.caseId, caseId));
    const messages = await tx.select().from(schema.recoveryMessages)
      .where(and(eq(schema.recoveryMessages.caseId, caseId), eq(schema.recoveryMessages.orgId, orgId)));
    // Phase 4D count semantics: executed automated attempts only.
    const executedAutoRetries = attempts.filter((a) => a.kind === "auto_retry" && ["executing", "succeeded", "failed", "unknown"].includes(a.status)).length;
    const hasUnresolvedExecution = attempts.some((a) => a.status === "executing" || a.status === "unknown");
    return { c: row.c, p: row.p, customer: customer ?? null, messages, executedAutoRetries, hasUnresolvedExecution };
  });
}

function factsFrom(l: Loaded, timezone: string, now: Date): CommunicationFacts {
  const sent = l.messages.filter((m) => m.sentAt).map((m) => m.sentAt!.getTime());
  return {
    caseStatus: l.c.status,
    paymentStatus: l.p.status,
    declineCategory: l.c.declineCategory,
    executedAutoRetries: l.executedAutoRetries,
    hasUnresolvedExecution: l.hasUnresolvedExecution,
    recipientEmail: l.customer?.email ?? null,
    customerDeleted: Boolean(l.customer?.deletedAt) || !l.customer,
    existingPurposes: l.messages.filter((m) => m.purpose && m.sendStatus !== "suppressed").map((m) => m.purpose as CommunicationPurpose),
    lastSentAt: sent.length ? new Date(Math.max(...sent)) : null,
    now,
    localHour: localHourIn(timezone, now)
  };
}

function firstNameOf(customer: CustomerRow | null): string | null {
  const name = sanitizeUntrusted(customer?.name ?? null, 80);
  if (!name) return null;
  const first = name.split(/\s+/)[0] ?? "";
  // Names are untrusted: letters/marks/apostrophes/hyphens only, short.
  const clean = first.replace(/[^\p{L}\p{M}'’-]/gu, "").slice(0, 30);
  return clean.length >= 2 ? clean : null;
}

function amountBand(minor: number): "small" | "medium" | "large" {
  if (minor < 2_000) return "small";
  if (minor < 20_000) return "medium";
  return "large";
}

/* ---------------------------------------------------------------- prepare */

export type PrepareResult =
  | { result: "created"; messageId: string; source: "ai" | "fallback"; requiresHumanApproval: boolean }
  | { result: "exists"; messageId: string }
  | { result: "not_allowed"; reason: string }
  | { result: "no_such_case" };

export interface PrepareOptions {
  now?: Date;
  triggerRef?: string | null;
  ip?: string | null; userAgent?: string | null;
}

/**
 * Builds the durable communication for a lifecycle trigger. Idempotent on
 * the deterministic identity `comm:{org}:{case}:{purpose}` — duplicate jobs
 * converge on the existing row (partial unique index is the arbiter).
 */
export async function prepareCommunication(
  ctx: OrgContext, caseId: string, trigger: LifecycleTrigger, opts: PrepareOptions = {}
): Promise<PrepareResult> {
  const db = appDb();
  const now = opts.now ?? new Date();
  const loaded = await loadAuthoritative(db, ctx.org.id, caseId);
  if (!loaded) return { result: "no_such_case" };

  // Idempotency first: a duplicate job for an already-prepared purpose
  // converges on the existing row before any policy/AI work.
  const purposeFor: Record<LifecycleTrigger, CommunicationPurpose> = { retry_failed: "dunning_note", case_lost: "final_notice" };
  const priorKey = communicationDedupeKey(ctx.org.id, caseId, purposeFor[trigger]);
  const prior = loaded.messages.find((m) => m.dedupeKey === priorKey);
  if (prior) return { result: "exists", messageId: prior.id };

  // Authoritative opt-out precheck (no AI work for a suppressed customer).
  // The send path re-checks after the claim — this is not the enforcement point.
  if (await isCustomerSuppressed(db, ctx.org.id, loaded.c.customerId)) {
    await withOrgTx(db, ctx.org.id, (tx) => audit(tx as unknown as Db, {
      orgId: ctx.org.id, actorId: ctx.userId, actorKind: "system", action: "communication.not_allowed",
      targetType: "recovery_case", targetId: caseId,
      diff: { trigger, reason: "customer_unsubscribed" }, ip: opts.ip, userAgent: opts.userAgent
    }));
    return { result: "not_allowed", reason: "customer_unsubscribed" };
  }

  const policy = await resolveCommunicationPolicy(db, ctx.org.id, ctx.org.trustLevel, loaded.c.retryPolicyVersion);
  const facts = factsFrom(loaded, ctx.org.timezone, now);
  const decision: CommunicationDecision = evaluateCommunication(trigger, facts, policy);
  if (!decision.allowed) {
    await withOrgTx(db, ctx.org.id, (tx) => audit(tx as unknown as Db, {
      orgId: ctx.org.id, actorId: ctx.userId, actorKind: "system", action: "communication.not_allowed",
      targetType: "recovery_case", targetId: caseId,
      diff: { trigger, reason: decision.reason }, ip: opts.ip, userAgent: opts.userAgent
    }));
    return { result: "not_allowed", reason: decision.reason };
  }
  const dedupeKey = communicationDedupeKey(ctx.org.id, caseId, decision.purpose);
  const existing = loaded.messages.find((m) => m.dedupeKey === dedupeKey);
  if (existing) return { result: "exists", messageId: existing.id };

  // ---- voice (operator-editable ⇒ untrusted data for the model)
  const [voice] = await withOrgTx(db, ctx.org.id, (tx) =>
    tx.select().from(schema.voiceProfiles).where(eq(schema.voiceProfiles.orgId, ctx.org.id)).limit(1));

  const relationshipMonths = loaded.customer?.stripeCreatedAt
    ? Math.max(0, Math.floor((now.getTime() - loaded.customer.stripeCreatedAt.getTime()) / (30 * 86_400_000)))
    : null;

  // ---- AI generation (downstream, optional, fully replaceable)
  const env = communicationEnv();
  const generation = await generateCopy({
    purpose: decision.purpose,
    styleSummary: voice?.styleSummary ?? null,
    greeting: voice?.greeting ?? null,
    signoff: voice?.signoff ?? null,
    customerFirstName: firstNameOf(loaded.customer),
    declineCategory: loaded.c.declineCategory,
    relationshipMonths,
    amountBand: amountBand(loaded.c.amountCents)
  }, {
    aiPermitted: decision.aiPermitted,
    provider: getAiProvider(),
    timeoutMs: env.AI_TIMEOUT_MS,
    requestId: dedupeKey
  });

  // ---- authoritative fact snapshot (what the email will say about money)
  const factSnapshot = {
    amountCents: loaded.c.amountCents, currency: loaded.c.currency,
    amountFormatted: formatMoney({ minor: loaded.c.amountCents, currency: loaded.c.currency }),
    orgName: ctx.org.name, firstName: firstNameOf(loaded.customer),
    declineCategory: loaded.c.declineCategory, caseStatusAtPrepare: loaded.c.status,
    executedAutoRetries: loaded.executedAutoRetries,
    /** Copy metadata (not a financial fact): the CTA button label. */
    ctaLabel: generation.copy.cta_label
  };

  const approvalStatus = decision.requiresHumanApproval ? "awaiting_approval" : "approved";
  const created = await withOrgTx(db, ctx.org.id, async (tx) => {
    let aiGenerationId: string | null = null;
    if (generation.provider) {
      const [gen] = await tx.insert(schema.aiGenerations).values({
        orgId: ctx.org.id, purpose: decision.purpose === "final_notice" ? "final_notice_draft" : "dunning_draft",
        provider: generation.provider.name, model: generation.provider.model,
        promptVersion: generation.promptVersion,
        inputRefs: { caseId, dedupeKey },
        inputSanitizedHash: generation.inputSanitizedHash,
        // Validated + policy-clean structured output only — never raw
        // provider text, and never content that failed the red lines.
        output: generation.source === "ai" ? generation.aiOutput : { rejected: true, reason: generation.fallbackReason, violations: generation.violations },
        valid: generation.source === "ai",
        tokensIn: generation.provider.tokensIn, tokensOut: generation.provider.tokensOut,
        latencyMs: generation.provider.latencyMs
      }).returning();
      aiGenerationId = gen?.id ?? null;
    }
    const [row] = await tx.insert(schema.recoveryMessages).values({
      caseId, orgId: ctx.org.id,
      template: generation.source === "fallback" ? `${decision.purpose}:${generation.promptVersion}` : null,
      aiGenerationId,
      // Stored UNRENDERED (placeholders intact, plain-text paragraphs):
      // rendering happens at send time from authoritative facts — operator
      // edits through the existing draft UI keep the same contract.
      subject: generation.copy.subject,
      body: generation.copy.paragraphs.join("\n\n"),
      ctaKind: "checkout",
      approvalStatus,
      approvedBy: null, approvedAt: decision.requiresHumanApproval ? null : now,
      purpose: decision.purpose, lifecycleTrigger: trigger, triggerRef: opts.triggerRef ?? null,
      dedupeKey,
      recipientEmail: facts.recipientEmail,
      sendStatus: "pending", sendAfter: decision.sendAfter,
      generationSource: generation.source, fallbackReason: generation.fallbackReason,
      factSnapshot,
      autoApproved: !decision.requiresHumanApproval,
      updatedAt: now
    }).onConflictDoNothing().returning();
    if (!row) {
      const [dup] = await tx.select().from(schema.recoveryMessages).where(eq(schema.recoveryMessages.dedupeKey, dedupeKey));
      return { row: dup!, created: false };
    }
    await audit(tx as unknown as Db, {
      orgId: ctx.org.id, actorId: ctx.userId, actorKind: "system", action: "communication.prepared",
      targetType: "recovery_message", targetId: row.id,
      diff: {
        purpose: decision.purpose, trigger, source: generation.source, fallbackReason: generation.fallbackReason,
        violations: generation.violations, approval: approvalStatus, sendAfter: decision.sendAfter.toISOString(),
        trustLevel: policy.trustLevel
      },
      ip: opts.ip, userAgent: opts.userAgent
    });
    return { row, created: true };
  });
  if (!created.created) return { result: "exists", messageId: created.row.id };
  return { result: "created", messageId: created.row.id, source: generation.source, requiresHumanApproval: decision.requiresHumanApproval };
}

/* ---------------------------------------------------------------- deliver */

export type DeliverResult =
  | { result: "sent"; messageId: string; providerMessageId: string; replayed: boolean }
  | { result: "already_sent"; messageId: string }
  | { result: "not_due" | "not_approved" | "claimed_elsewhere" | "no_such_message"; messageId: string }
  | { result: "suppressed"; messageId: string; reason: string }
  | { result: "failed_transient"; messageId: string; code: string; attempts: number }
  | { result: "failed_permanent"; messageId: string; code: string }
  /** Our email configuration is wrong (missing/rejected credentials): nothing sent,
   *  no attempt budget consumed, message stays pending until an operator fixes config. */
  | { result: "deferred_configuration"; messageId: string; code: string }
  | { result: "unknown"; messageId: string; code: string };

/** Body contract stored on the row: plain-text paragraphs, placeholders intact. */
function copyOf(row: MessageRow): AiCopy | null {
  const snap = (row.factSnapshot ?? {}) as { ctaLabel?: unknown };
  const candidate = {
    subject: row.subject,
    paragraphs: row.body.split(/\n{2,}/).map((s) => s.replace(/\s*\n\s*/g, " ").trim()).filter(Boolean),
    cta_label: typeof snap.ctaLabel === "string" ? snap.ctaLabel : "Update payment method",
    tone_check: { formality: "neutral", empathy: "medium" }
  };
  const r = AiCopySchema.safeParse(candidate);
  return r.success ? r.data : null;
}

/** Application-controlled CTA destination: our origin + a case-scoped checkout token. */
async function ctaUrlFor(ctx: OrgContext, caseId: string): Promise<string> {
  const env = communicationEnv();
  const { token } = await createCheckoutLink(ctx, caseId, {});
  const url = new URL(`/c/${encodeURIComponent(token)}`, env.APP_PUBLIC_URL);
  if (url.protocol !== "https:" && process.env.NODE_ENV === "production") throw new Error("cta url must be https");
  return url.toString();
}

/**
 * Sends ONE approved, due communication. Concurrency-safe via the atomic
 * claim (`pending → sending` conditional UPDATE); duplicate/concurrent
 * deliveries converge on one provider call per attempt. Ambiguous provider
 * results become `unknown` and are NEVER auto-resent.
 */
export async function deliverCommunication(
  ctx: OrgContext, messageId: string, opts: { now?: Date; ip?: string | null; userAgent?: string | null } = {}
): Promise<DeliverResult> {
  const db = appDb();
  const now = opts.now ?? new Date();
  const env = communicationEnv();

  const [row] = await withOrgTx(db, ctx.org.id, (tx) =>
    tx.select().from(schema.recoveryMessages)
      .where(and(eq(schema.recoveryMessages.id, messageId), eq(schema.recoveryMessages.orgId, ctx.org.id))));
  if (!row) return { result: "no_such_message", messageId };
  if (row.sendStatus === "sent") return { result: "already_sent", messageId };
  if (row.sendStatus !== "pending") return { result: "claimed_elsewhere", messageId }; // sending|failed|suppressed|unknown
  if (row.approvalStatus !== "approved") return { result: "not_approved", messageId };
  if (row.sendAfter && row.sendAfter.getTime() > now.getTime()) return { result: "not_due", messageId };

  // ---- atomic claim: exactly one deliverer proceeds
  const [claimed] = await withOrgTx(db, ctx.org.id, (tx) =>
    tx.update(schema.recoveryMessages).set({ sendStatus: "sending", sendClaimedAt: now, updatedAt: now })
      .where(and(
        eq(schema.recoveryMessages.id, messageId), eq(schema.recoveryMessages.orgId, ctx.org.id),
        eq(schema.recoveryMessages.sendStatus, "pending"), eq(schema.recoveryMessages.approvalStatus, "approved")
      )).returning());
  if (!claimed) return { result: "claimed_elsewhere", messageId };

  const suppress = async (reason: string): Promise<DeliverResult> => {
    await withOrgTx(db, ctx.org.id, async (tx) => {
      await tx.update(schema.recoveryMessages).set({ sendStatus: "suppressed", suppressedReason: reason, approvalStatus: "suppressed", updatedAt: new Date() })
        .where(eq(schema.recoveryMessages.id, messageId));
      await audit(tx as unknown as Db, {
        orgId: ctx.org.id, actorId: ctx.userId, actorKind: "system", action: "communication.suppressed",
        targetType: "recovery_message", targetId: messageId, diff: { reason }, ip: opts.ip, userAgent: opts.userAgent
      });
    });
    return { result: "suppressed", messageId, reason };
  };

  // ---- re-verify authoritative facts at send time (the world may have moved)
  const loaded = await loadAuthoritative(db, ctx.org.id, row.caseId);
  if (!loaded) return suppress("case_gone");
  // MANDATORY: authoritative opt-out, re-read AFTER the durable claim and
  // BEFORE any provider call. An unsubscribe recorded after preparation or
  // approval still wins; the claim is irreversible (pending → sending → suppressed).
  if (await isCustomerSuppressed(db, ctx.org.id, loaded.c.customerId)) return suppress("customer_unsubscribed");
  const policy = await resolveCommunicationPolicy(db, ctx.org.id, ctx.org.trustLevel, loaded.c.retryPolicyVersion);
  if (policy.sendsPaused) return suppress("sends_paused");
  if (loaded.hasUnresolvedExecution) return suppress("execution_unresolved");
  if (loaded.p.status !== "failed") return suppress(`payment_${loaded.p.status}`); // paid/void ⇒ never dun
  if (["recovered", "canceled", "dismissed"].includes(loaded.c.status)) return suppress(`case_${loaded.c.status}`);
  if (row.purpose === "dunning_note" && loaded.c.status === "lost") return suppress("case_lost");
  if (!loaded.customer || loaded.customer.deletedAt) return suppress("customer_deleted");
  const recipient = loaded.customer.email;
  if (!recipient || recipient !== row.recipientEmail) return suppress("recipient_changed");
  // Financial facts must still match the approved snapshot — otherwise the
  // approved wording is stale and a NEW communication must be prepared.
  const snap = (row.factSnapshot ?? {}) as { amountCents?: number; currency?: string };
  if (snap.amountCents !== loaded.c.amountCents || snap.currency !== loaded.c.currency) return suppress("facts_changed");

  const copy = copyOf(row);
  if (!copy) return suppress("copy_invalid");
  // Operator edits (existing draft UI) are held to the same content red lines
  // as AI output — a URL, money figure or legal threat typed by hand never
  // reaches a customer either.
  const violations = validateCopy(copy);
  if (violations.length) return suppress(`content_violation:${violations.join(",")}`);

  // ---- application-controlled rendering + headers (recipient, sender,
  // CTA destination and every financial value come from the application)
  let outbound: OutboundEmail;
  try {
    const ctaUrl = await ctaUrlFor(ctx, row.caseId);
    const rendered = renderEmail(copy, {
      amountFormatted: formatMoney({ minor: loaded.c.amountCents, currency: loaded.c.currency }),
      orgName: ctx.org.name, firstName: firstNameOf(loaded.customer), ctaUrl
    });
    outbound = {
      to: recipient,
      from: env.EMAIL_FROM_ADDRESS,
      replyTo: null,
      subject: rendered.subject, text: rendered.text, html: rendered.html,
      idempotencyReference: messageId,
      tag: `recovery-${row.purpose ?? "note"}`
    };
  } catch {
    return suppress("render_failed");
  }
  const provider = getEmailProvider();
  const attempts = row.sendAttempts + 1;

  const record = async (patch: Partial<typeof schema.recoveryMessages.$inferInsert>, action: string, diff: Record<string, unknown>) => {
    await withOrgTx(db, ctx.org.id, async (tx) => {
      await tx.update(schema.recoveryMessages).set({ ...patch, sendAttempts: attempts, updatedAt: new Date() })
        .where(eq(schema.recoveryMessages.id, messageId));
      await audit(tx as unknown as Db, {
        orgId: ctx.org.id, actorId: ctx.userId, actorKind: "system", action,
        targetType: "recovery_message", targetId: messageId, diff: { ...diff, attempts }, ip: opts.ip, userAgent: opts.userAgent
      });
    });
  };

  const deferConfiguration = async (code: string): Promise<DeliverResult> => {
    // Not an attempt: send_attempts is left untouched; the claim is released.
    // A 1h cooldown keeps discovery from re-enqueueing every cycle while the
    // configuration is broken (no exponential growth, no budget consumption).
    const CONFIG_COOLDOWN_MS = 3_600_000;
    await withOrgTx(db, ctx.org.id, async (tx) => {
      await tx.update(schema.recoveryMessages).set({
        sendStatus: "pending", sendClaimedAt: null, lastSendErrorCode: code,
        sendAfter: new Date(now.getTime() + CONFIG_COOLDOWN_MS), updatedAt: new Date()
      })
        .where(eq(schema.recoveryMessages.id, messageId));
      await audit(tx as unknown as Db, {
        orgId: ctx.org.id, actorId: ctx.userId, actorKind: "system", action: "communication.send_deferred",
        targetType: "recovery_message", targetId: messageId, diff: { code, kind: "configuration" }, ip: opts.ip, userAgent: opts.userAgent
      });
    });
    return { result: "deferred_configuration", messageId, code };
  };
  if (!provider) return deferConfiguration("not_configured");

  try {
    const res = await provider.send(outbound);
    await record({ sendStatus: "sent", approvalStatus: "sent", sentAt: new Date(), providerMessageId: res.providerMessageId, lastSendErrorCode: null },
      "communication.sent", { provider: res.provider, replayed: res.replayed, purpose: row.purpose });
    // Lifecycle bookkeeping (non-financial): a dunning note moves an open case to `contacting`.
    if (row.purpose === "dunning_note" && ["retrying", "detected", "analyzing"].includes(loaded.c.status)) {
      await withOrgTx(db, ctx.org.id, (tx) =>
        tx.update(schema.recoveryCases).set({ status: "contacting", updatedAt: new Date() })
          .where(and(eq(schema.recoveryCases.id, row.caseId), inArray(schema.recoveryCases.status, ["retrying", "detected", "analyzing"]))));
    }
    return { result: "sent", messageId, providerMessageId: res.providerMessageId, replayed: res.replayed };
  } catch (e) {
    if (!isEmailProviderError(e)) {
      log.warn(`email send threw a non-provider error: ${redact((e as Error).message ?? "error")}`, { messageId });
      await record({ sendStatus: "unknown", lastSendErrorCode: "unexpected_error" }, "communication.send_unknown", { code: "unexpected_error" });
      return { result: "unknown", messageId, code: "unexpected_error" };
    }
    if (e.kind === "configuration") return deferConfiguration(e.code);
    if (e.kind === "permanent") {
      await record({ sendStatus: "failed", approvalStatus: "failed", lastSendErrorCode: e.code }, "communication.send_failed", { code: e.code, kind: "permanent" });
      return { result: "failed_permanent", messageId, code: e.code };
    }
    if (e.kind === "ambiguous") {
      // The provider MAY have accepted the message. Never resend automatically.
      await record({ sendStatus: "unknown", lastSendErrorCode: e.code }, "communication.send_unknown", { code: e.code, kind: "ambiguous" });
      return { result: "unknown", messageId, code: e.code };
    }
    // transient: back to pending until the attempt budget is spent
    if (attempts >= env.EMAIL_MAX_SEND_ATTEMPTS) {
      await record({ sendStatus: "failed", approvalStatus: "failed", lastSendErrorCode: e.code }, "communication.send_failed", { code: e.code, kind: "transient_exhausted" });
      return { result: "failed_permanent", messageId, code: e.code };
    }
    const backoffMs = Math.min(6 * 3_600_000, 5 * 60_000 * Math.pow(2, attempts - 1));
    await record({ sendStatus: "pending", sendClaimedAt: null, sendAfter: new Date(now.getTime() + backoffMs), lastSendErrorCode: e.code },
      "communication.send_deferred", { code: e.code, kind: "transient", retryAfterMs: backoffMs });
    return { result: "failed_transient", messageId, code: e.code, attempts };
  }
}

/* ------------------------------------------------------- reconciliation */

/**
 * Resolves `unknown` sends by provider reference (never by resending).
 * `lookup` is injected: the fixture provider offers findByReference; a live
 * adapter would use the provider's message search. Unresolvable rows stay
 * `unknown` for an operator — silence over a possible duplicate email.
 */
export async function reconcileUnknownSends(
  ctx: OrgContext, lookup: (reference: string) => Promise<string | null> | string | null
): Promise<{ resolvedSent: string[]; stillUnknown: string[] }> {
  const db = appDb();
  const rows = await withOrgTx(db, ctx.org.id, (tx) =>
    tx.select().from(schema.recoveryMessages)
      .where(and(eq(schema.recoveryMessages.orgId, ctx.org.id), eq(schema.recoveryMessages.sendStatus, "unknown"))));
  const out = { resolvedSent: [] as string[], stillUnknown: [] as string[] };
  for (const r of rows) {
    const id = await lookup(r.id);
    if (id) {
      await withOrgTx(db, ctx.org.id, async (tx) => {
        await tx.update(schema.recoveryMessages).set({ sendStatus: "sent", approvalStatus: "sent", sentAt: r.sentAt ?? new Date(), providerMessageId: id, updatedAt: new Date() })
          .where(and(eq(schema.recoveryMessages.id, r.id), eq(schema.recoveryMessages.sendStatus, "unknown")));
        await audit(tx as unknown as Db, {
          orgId: ctx.org.id, actorId: ctx.userId, actorKind: "system", action: "communication.reconciled_sent",
          targetType: "recovery_message", targetId: r.id, diff: { providerMessageId: id }
        });
      });
      out.resolvedSent.push(r.id);
    } else {
      out.stillUnknown.push(r.id);
    }
  }
  return out;
}

/* ---------------------------------------------------------------- discovery */

/** Prepare-discovery: cases whose lifecycle suggests a communication may be due
 *  (candidates only — `prepareCommunication` decides). */
export async function findCommunicationCandidates(
  db: Db, orgId: string, limit: number
): Promise<Array<{ caseId: string; trigger: LifecycleTrigger }>> {
  return withOrgTx(db, orgId, async (tx) => {
    // Open cases with ≥1 executed automated retry and no dunning note yet.
    const notes = await tx.execute<{ case_id: string }>(sql`
      select c.id as case_id
        from recovery_cases c
        join payments p on p.id = c.payment_id
       where c.org_id = ${orgId}
         and c.status in ('retrying','contacting')
         and p.status = 'failed'
         and exists (select 1 from recovery_attempts a
                      where a.case_id = c.id and a.kind = 'auto_retry'
                        and a.status in ('succeeded','failed','unknown','executing'))
         and not exists (select 1 from recovery_messages m
                          where m.case_id = c.id and m.purpose = 'dunning_note')
         and not exists (select 1 from communication_suppressions s
                          where s.org_id = c.org_id and s.customer_id = c.customer_id and s.channel = 'email')
       order by c.updated_at asc
       limit ${limit}`);
    const finals = await tx.execute<{ case_id: string }>(sql`
      select c.id as case_id
        from recovery_cases c
        join payments p on p.id = c.payment_id
       where c.org_id = ${orgId}
         and c.status = 'lost'
         and p.status = 'failed'
         and c.closed_at > now() - interval '7 days'
         and not exists (select 1 from recovery_messages m
                          where m.case_id = c.id and m.purpose = 'final_notice')
         and not exists (select 1 from communication_suppressions s
                          where s.org_id = c.org_id and s.customer_id = c.customer_id and s.channel = 'email')
       order by c.closed_at asc
       limit ${limit}`);
    return [
      ...notes.rows.map((r) => ({ caseId: r.case_id, trigger: "retry_failed" as const })),
      ...finals.rows.map((r) => ({ caseId: r.case_id, trigger: "case_lost" as const }))
    ];
  });
}

/** Send-discovery: approved, pending, due messages. */
export async function findDueSends(db: Db, orgId: string, limit: number, now: Date): Promise<Array<{ messageId: string; caseId: string }>> {
  const rows = await withOrgTx(db, orgId, (tx) =>
    tx.select({ id: schema.recoveryMessages.id, caseId: schema.recoveryMessages.caseId })
      .from(schema.recoveryMessages)
      .where(and(
        eq(schema.recoveryMessages.orgId, orgId),
        eq(schema.recoveryMessages.sendStatus, "pending"),
        eq(schema.recoveryMessages.approvalStatus, "approved"),
        isNotNull(schema.recoveryMessages.dedupeKey),
        lte(schema.recoveryMessages.sendAfter, now)
      ))
      .orderBy(schema.recoveryMessages.sendAfter)
      .limit(limit));
  return rows.map((r) => ({ messageId: r.id, caseId: r.caseId }));
}

/** Retention: purge terminal message bodies older than `days` (keeps the row + metadata). */
export async function redactOldMessageBodies(db: Db, orgId: string, days: number): Promise<number> {
  const cutoff = new Date(Date.now() - days * 86_400_000);
  const rows = await withOrgTx(db, orgId, (tx) =>
    tx.update(schema.recoveryMessages).set({ body: "[redacted: retention]", factSnapshot: null, recipientEmail: null, updatedAt: new Date() })
      .where(and(
        eq(schema.recoveryMessages.orgId, orgId),
        inArray(schema.recoveryMessages.sendStatus, ["sent", "failed", "suppressed"]),
        lte(sql`coalesce(${schema.recoveryMessages.sentAt}, ${schema.recoveryMessages.updatedAt})`, cutoff),
        sql`${schema.recoveryMessages.body} <> '[redacted: retention]'`
      )).returning({ id: schema.recoveryMessages.id }));
  return rows.length;
}
