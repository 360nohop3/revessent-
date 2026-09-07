import { z } from "zod";

/**
 * API contracts (Phase 1 §6) as Zod schemas. These are the single source of
 * truth shared by the mock client today and the real fetch client in Phase 3.
 * Types are inferred — do not redeclare them by hand.
 */

export const RoleSchema = z.enum(["owner", "admin", "operator", "viewer"]);
export type Role = z.infer<typeof RoleSchema>;

export const PlanSchema = z.enum(["ember", "revessent", "studio"]);
export type Plan = z.infer<typeof PlanSchema>;

export const MembershipOrgSchema = z.object({
  slug: z.string(),
  name: z.string(),
  role: RoleSchema,
  plan: PlanSchema
});
export type MembershipOrg = z.infer<typeof MembershipOrgSchema>;

export const OrgSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  plan: PlanSchema,
  timezone: z.string(),
  pilotEndsAt: z.string().nullable()
});
export type Org = z.infer<typeof OrgSchema>;

/** Demo session payload — carried in an httpOnly cookie set by /api/demo/session.
 *  This is NOT authentication; the real session arrives with the Phase 4 backend. */
export const DemoSessionSchema = z.object({
  email: z.string(),
  name: z.string(),
  demo: z.literal(true),
  memberships: z.array(MembershipOrgSchema)
});
export type DemoSession = z.infer<typeof DemoSessionSchema>;


/** never: connected but never synced · fresh: recent success · stale: old success
 *  · failed: last attempt failed (data preserved) · running: sync in progress */
export const SyncEntityStateSchema = z.object({
  status: z.enum(["never", "fresh", "stale", "failed", "running"]),
  lastSuccessAt: z.string().nullable(),
  lastAttemptAt: z.string().nullable(),
  errorCode: z.string().nullable()
});
export type SyncEntityState = z.infer<typeof SyncEntityStateSchema>;



export const StripeConnectionSchema = z.object({
  /** not_connected: nothing linked · read_only: connected, read scopes (Phase 4A
   *  state) · full: retry scopes (later phase) · revoked: reconnection required ·
   *  invalid: last validation failed · error: degraded */
  status: z.enum(["not_connected", "read_only", "full", "revoked", "invalid", "error"]),
  mode: z.enum(["test", "live"]).nullable(),
  accountRef: z.string().nullable(),
  lastSyncAt: z.string().nullable(),
  backfill: z.enum(["idle", "running", "done"]).nullable(),
  /** Phase 4A additions (additive, optional for older clients): */
  /** Last 4 of the restricted key — the ONLY credential fragment ever displayed. */
  keyLast4: z.string().nullable().optional(),
  /** Safe provider identity (§7). */
  displayName: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
  defaultCurrency: z.string().nullable().optional(),
  lastValidatedAt: z.string().nullable().optional(),
  /** Per-entity read-only sync freshness (§10). */
  sync: z.object({
    customers: SyncEntityStateSchema,
    subscriptions: SyncEntityStateSchema,
    invoices: SyncEntityStateSchema
  }).optional(),
  /** Phase 4B: webhook delivery status (§9) — near-real-time freshness,
   *  honest about failed/unprocessed events; never faked by sync success. */
  webhooks: z.object({
    configured: z.boolean(),
    endpointId: z.string().nullable(),
    lastWebhookAt: z.string().nullable(),
    failed: z.number().int(),
    unprocessed: z.number().int(),
    lastFailureCode: z.string().nullable(),
    lastFailureAt: z.string().nullable(),
    /** 4B correction: endpoint lifecycle state — recoverable mismatches are
     *  observable, never silently represented as healthy. */
    lifecycle: z.enum(["healthy", "registration_failed", "cleanup_pending", "provider_removed_local_stale", "orphan_cleanup"]).optional()
  }).optional()
});
export type StripeConnection = z.infer<typeof StripeConnectionSchema>;

/** Response of POST /settings/stripe/sync (Phase 4A manual read-only sync). */
export const SyncEntityResultSchema = z.object({
  status: z.enum(["ok", "failed", "skipped"]),
  pages: z.number().int(),
  upserted: z.number().int(),
  anomalies: z.number().int(),
  errorCode: z.string().nullable()
});
/** Phase 4C: durable payment-execution record (narrow DTO — no secrets,
 *  no raw provider payloads, no provider idempotency key). */
export const RecoveryExecutionSchema = z.object({
  executionId: z.string(),
  caseId: z.string(),
  paymentId: z.string().nullable(),
  status: z.enum(["scheduled", "executing", "succeeded", "failed", "unknown", "skipped", "canceled"]),
  outcomeCategory: z.string().nullable(),
  errorCode: z.string().nullable(),
  declineCode: z.string().nullable(),
  retryClassification: z.enum(["never", "later"]).nullable(),
  amountCents: z.number().int().nullable(),
  currency: z.string().nullable(),
  idempotencyKey: z.string(),
  createdAt: z.string(),
  executedAt: z.string().nullable(),
  reconciledAt: z.string().nullable()
});
export type RecoveryExecution = z.infer<typeof RecoveryExecutionSchema>;

export const SyncResponseSchema = z.object({
  started: z.literal(true),
  connection: StripeConnectionSchema,
  summary: z.record(z.string(), SyncEntityResultSchema)
});
export type SyncEntityResult = z.infer<typeof SyncEntityResultSchema>;
export type SyncResponse = z.infer<typeof SyncResponseSchema>;


export const MoneySchema = z.object({ minor: z.number().int(), currency: z.string().length(3) });
export type Money = z.infer<typeof MoneySchema>;

export const DeclineEvidenceSchema = z.object({
  declineCode: z.string(),
  category: z.enum([
    "insufficient_funds",
    "expired_card",
    "transient",
    "issuer_decline",
    "credential",
    "hard",
    "balance"
  ]),
  attempts: z.array(
    z.object({
      at: z.string(),
      source: z.enum(["stripe_default", "revessent_retry", "checkout", "member"]),
      outcome: z.enum(["succeeded", "failed"]),
      declineCode: z.string().nullable()
    })
  )
});
export type DeclineEvidence = z.infer<typeof DeclineEvidenceSchema>;

export const ApprovalStatusSchema = z.enum([
  "draft",
  "awaiting_approval",
  "approved",
  "queued",
  "executing",
  "provider_pending",
  "confirmed",
  "failed",
  "cancelled",
  "invalidated"
]);

export const MessageDraftSchema = z.object({
  id: z.string(),
  approvalStatus: ApprovalStatusSchema,
  subject: z.string(),
  body: z.string(),
  /** Provider reference — present only when a provider confirmed. Never fabricated. */
  providerRef: z.string().nullable(),
  updatedAt: z.string(),
  approvedAt: z.string().nullable(),
  approvedBy: z.string().nullable()
});
export type MessageDraft = z.infer<typeof MessageDraftSchema>;

export const RecoveryCaseSchema = z.object({
  id: z.string(),
  orgSlug: z.string(),
  customerName: z.string(),
  customerEmail: z.string(),
  amount: MoneySchema,
  /** Provider-derived cadence; "unsupported" = Stripe returned a cadence
   *  outside the Phase 4A model or no subscription backs the case — never
   *  invented as "month". */
  interval: z.enum(["month", "year", "unsupported"]),
  status: z.enum([
    "detected", "analyzing", "retrying", "contacting", "checkout",
    "recovered", "lost", "canceled", "dismissed"
  ]),
  declineCode: z.string(),
  category: DeclineEvidenceSchema.shape.category,
  outreachSafe: z.boolean(),
  nextActionAt: z.string().nullable(),
  createdAt: z.string(),
  evidence: DeclineEvidenceSchema,
  draft: MessageDraftSchema.nullable(),
  /** Phase 4D automated-retry state — computed from the pure eligibility
   *  function over local records (never UI text, never provider I/O). */
  retry: z.object({
    autoAttempts: z.number().int(),
    maxAutoRetries: z.number().int(),
    state: z.enum(["eligible", "waiting", "blocked", "exhausted", "disabled"]),
    reason: z.string(),
    nextEligibleAt: z.string().nullable(),
    reconciliationRequired: z.boolean()
  })
});
export type RecoveryCase = z.infer<typeof RecoveryCaseSchema>;

export const TimelineEntrySchema = z.object({
  id: z.string(),
  at: z.string(),
  kind: z.enum(["system", "attempt", "message", "approval", "provider", "note"]),
  title: z.string(),
  detail: z.string().nullable(),
  tone: z.enum(["neutral", "info", "ok", "warn", "err"])
});
export type TimelineEntry = z.infer<typeof TimelineEntrySchema>;

export const OpportunitySchema = z.object({
  id: z.string(),
  orgSlug: z.string(),
  customerName: z.string(),
  currentPlan: z.string(),
  recommendedPlan: z.string(),
  potentialMrr: MoneySchema,
  signal: z.string(),
  signalEvidence: z.string(),
  rationale: z.string(),
  status: z.enum([
    "new", "awaiting_approval", "approved", "queued",
    "provider_pending", "confirmed", "declined", "expired", "dismissed"
  ]),
  draft: MessageDraftSchema.nullable()
});
export type Opportunity = z.infer<typeof OpportunitySchema>;

export const SubscriptionRowSchema = z.object({
  id: z.string(),
  plan: z.string(),
  amount: MoneySchema,
  /** "unsupported" = Stripe returned a cadence outside the Phase 4A model
   *  (day/week): preserved verbatim, EXCLUDED from MRR — never converted. */
  interval: z.enum(["month", "year", "unsupported"]),
  status: z.string()
});

export const PaymentRowSchema = z.object({
  id: z.string(),
  at: z.string(),
  amount: MoneySchema,
  /** Verbatim payment state: open/void added when 4A began syncing real
   *  invoices — a never-attempted or voided invoice is not a "failed" one. */
  outcome: z.enum(["paid", "failed", "refunded", "open", "void"]),
  source: z.string()
});

export type PaymentRow = z.infer<typeof PaymentRowSchema>;

export const CustomerSchema = z.object({
  id: z.string(),
  orgSlug: z.string(),
  name: z.string(),
  email: z.string(),
  mrr: MoneySchema,
  status: z.enum(["active", "past_due", "canceled"]),
  riskStatus: z.enum(["none", "at_risk", "recovering", "lost"]),
  expansionStatus: z.enum(["none", "signal", "opportunity"]),
  subscriptions: z.array(SubscriptionRowSchema),
  payments: z.array(PaymentRowSchema)
});
export type Customer = z.infer<typeof CustomerSchema>;

export const ActivityItemSchema = z.object({
  id: z.string(),
  at: z.string(),
  kind: z.enum(["recovery", "expansion", "system", "approval", "provider"]),
  text: z.string(),
  tone: z.enum(["neutral", "info", "ok", "warn", "err"])
});

export type ActivityItem = z.infer<typeof ActivityItemSchema>;

export const OverviewSchema = z.object({
  orgSlug: z.string(),
  /** null metrics = never synced (provider disconnected) — they are NOT zeros. */
  cashRecovered30d: MoneySchema.nullable(),
  mrrAtRisk: MoneySchema.nullable(),
  potentialMrr: MoneySchema.nullable(),
  /** Computed only from provider-confirmed outcomes; null when unknown. */
  recoveryRatePct: z.number().nullable(),
  cases: z.object({ open: z.number(), recovered30d: z.number(), lost30d: z.number() }),
  approvalsPending: z.number(),
  series: z.array(
    z.object({
      weekStart: z.string(),
      recoveredMinor: z.number(),
      lostMinor: z.number()
    })
  ),
  activity: z.array(ActivityItemSchema)
});
export type Overview = z.infer<typeof OverviewSchema>;

export const PageSchema = <T extends z.ZodTypeAny>(item: T) =>
  z.object({ items: z.array(item), nextCursor: z.string().nullable() });

export const AutoRetryCategoryRuleSchema = z.object({
  retryable: z.boolean(),
  maxAttempts: z.number().int().min(0).max(8)
});
export const AutoRetryPolicySchema = z.object({
  /** Outcome category (4C taxonomy) → routing rule; unlisted = never retry. */
  perCategory: z.record(z.string(), AutoRetryCategoryRuleSchema).optional(),
  backoffMultiplier: z.number().min(1).max(4).optional(),
  maxBackoffHours: z.number().int().min(1).max(720).optional()
});
export const RetryPolicySchema = z.object({
  maxAutoRetries: z.number().int().min(0).max(8),
  quietHoursStart: z.number().int().min(0).max(23),
  quietHoursEnd: z.number().int().min(0).max(23),
  minGapHours: z.number().int().min(1).max(72),
  noteAfterFailedRetries: z.number().int().min(0).max(4),
  checkoutAfterNote: z.boolean(),
  /** Phase 4D automated-retry routing (architecture §8.4); absent → defaults. */
  autoRetry: AutoRetryPolicySchema.optional()
});
export type RetryPolicy = z.infer<typeof RetryPolicySchema>;

export const VoiceProfileSchema = z.object({
  sampleText: z.string(),
  styleSummary: z.string(),
  greeting: z.string(),
  signoff: z.string()
});
export type VoiceProfile = z.infer<typeof VoiceProfileSchema>;

export const TeamMemberSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  role: RoleSchema
});
export type TeamMember = z.infer<typeof TeamMemberSchema>;

export const BillingStatusSchema = z.enum([
  "trialing", "active", "past_due", "canceled", "unpaid", "incomplete", "incomplete_expired", "paused", "unknown"
]);
export const BillingInfoSchema = z.object({
  plan: PlanSchema,
  status: BillingStatusSchema,
  pilotEndsAt: z.string().nullable(),
  guaranteeWindowEndsAt: z.string().nullable(),
  /** Phase 7: true once this org's billing row has been synchronised from a
   *  Stripe Billing webhook (plan_source = stripe_billing). Never pretended. */
  billingProviderLive: z.boolean(),
  currentPeriodEnd: z.string().nullable(),
  cancelAtPeriodEnd: z.boolean(),
  /** Plan whose capabilities are actually in force (Ember baseline when restricted). */
  effectivePlan: PlanSchema,
  restricted: z.boolean(),
  reasons: z.array(z.string())
});
export type BillingInfo = z.infer<typeof BillingInfoSchema>;

/** Phase 7 — what the workspace can do right now (server-resolved; display only). */
export const CapabilitySchema = z.enum(["smart_retries", "recovery_checkout", "ai_notes", "upgrade_signals", "weekly_digest", "trust_autonomy"]);
export type Capability = z.infer<typeof CapabilitySchema>;
export const EntitlementsSchema = z.object({
  plan: PlanSchema,
  effectivePlan: PlanSchema,
  state: z.enum(["entitled", "baseline"]),
  restricted: z.boolean(),
  capabilities: z.record(CapabilitySchema, z.boolean()),
  limits: z.object({ memberCap: z.number().int().nullable(), seats: z.number().int() }),
  usage: z.object({ seatsUsed: z.number().int(), members: z.number().int() }),
  overMemberCap: z.boolean(),
  billing: z.object({ status: BillingStatusSchema, reasons: z.array(z.string()) }).nullable()
});
export type Entitlements = z.infer<typeof EntitlementsSchema>;

/** RFC 9457 problem detail (Phase 1 §6.1). */
export const ProblemSchema = z.object({
  type: z.string(),
  title: z.string(),
  status: z.number().int(),
  detail: z.string().optional(),
  instance: z.string().optional()
});
export type Problem = z.infer<typeof ProblemSchema>;

export const RecoveryTokenSchema = z.object({
  state: z.enum(["valid", "expired", "used", "unknown"]),
  orgName: z.string().nullable(),
  productName: z.string().nullable(),
  amount: MoneySchema.nullable(),
  cardLast4: z.string().nullable(),
  expiresAt: z.string().nullable()
});
export type RecoveryTokenInfo = z.infer<typeof RecoveryTokenSchema>;

/** Phase 8 Hosted Recovery Checkout — result of POST /c/{token}. `ready`
 *  carries ONLY the provider's own hosted page URL; every other state is an
 *  honest refusal (nothing was charged, no URL). */
export const RecoveryCheckoutStartSchema = z.object({
  state: z.enum(["ready", "already_paid", "expired", "unavailable", "provider_unavailable", "provider_error", "unknown"]),
  url: z.string().url().optional()
});
export type RecoveryCheckoutStart = z.infer<typeof RecoveryCheckoutStartSchema>;

export const UpgradeTokenSchema = z.object({
  state: z.enum(["valid", "expired", "used", "unknown"]),
  orgName: z.string().nullable(),
  currentPlan: z.string().nullable(),
  recommendedPlan: z.string().nullable(),
  delta: MoneySchema.nullable()
});
export type UpgradeTokenInfo = z.infer<typeof UpgradeTokenSchema>;
