import { sql } from "drizzle-orm";
/**
 * REVESSENT database schema — Drizzle translation of Architecture v1 §5.2 DDL.
 * Conventions (§5): uuid v7 PKs, bigint money in minor units (*_cents), timestamptz,
 * jsonb for raw payloads only, org_id on every tenant row, created_at/updated_at.
 *
 * Auth tables (user/session/account/verification) are Better Auth's — referenced,
 * not redefined (§5.2). Org/membership/RBAC tables are ours per the same DDL.
 */
import { pgEnum, pgTable, text, timestamp, unique, uniqueIndex, uuid, index, boolean, integer, smallint, bigint, jsonb, char, date } from "drizzle-orm/pg-core";
import { v7 as uuidv7 } from "uuid";

/* ---------- Better Auth identity core (schema shape owned by better-auth) ---------- */

export const user = pgTable("user", {
  id: text("id").primaryKey().$defaultFn(() => uuidv7()),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" })
});

export const account = pgTable("account", {
  id: text("id").primaryKey().$defaultFn(() => uuidv7()),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at", { withTimezone: true }),
  scope: text("scope"),
  issuer: text("issuer"), // better-auth 1.7 account field (OIDC issuer; null for credentials)
  password: text("password"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey().$defaultFn(() => uuidv7()),
  identifier: text("identifier").notNull(),
  value: text("value").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});

/* ---------- Tenancy (§5.2, ours) ---------- */

export const organizations = pgTable("organizations", {
  id: uuid().primaryKey().$defaultFn(() => uuidv7()),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  plan: text("plan").notNull().default("ember"), // ember | revessent | studio
  timezone: text("timezone").notNull().default("UTC"),
  pilotStartedAt: timestamp("pilot_started_at", { withTimezone: true }),
  pilotEndsAt: timestamp("pilot_ends_at", { withTimezone: true }),
  trustLevel: smallint("trust_level").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
});

export const memberships = pgTable("memberships", {
  id: uuid().primaryKey().$defaultFn(() => uuidv7()),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  role: text("role").notNull().default("viewer"), // owner | admin | operator | viewer (§7.3)
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
}, (t) => [unique("memberships_org_user_uq").on(t.orgId, t.userId), index("memberships_user_idx").on(t.userId)]);

export const invitations = pgTable("invitations", {
  id: uuid().primaryKey().$defaultFn(() => uuidv7()),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  email: text("email").notNull(),
  role: text("role").notNull().default("operator"),
  tokenHash: text("token_hash").notNull().unique(),
  invitedBy: text("invited_by").notNull().references(() => user.id),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});

/* ---------- Stripe connection (restricted-key model, §8.2) ---------- */

export const stripeConnections = pgTable("stripe_connections", {
  id: uuid().primaryKey().$defaultFn(() => uuidv7()),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  mode: text("mode").notNull(), // test | live
  stripeAccountId: text("stripe_account_id").notNull(), // acct_...
  /** AES-256-GCM envelope (base64), §7.5. Nullable since migration 0011:
   *  revocation DESTROYS the sealed material — a revoked connection keeps
   *  only safe metadata and can never authenticate again. */
  keyCiphertext: text("key_ciphertext"),
  keyLast4: text("key_last4").notNull(),
  /** Safe provider identity (Phase 4A §7) — no secrets can be expressed here. */
  displayName: text("display_name"),
  accountCountry: char("account_country", { length: 2 }),
  defaultCurrency: char("default_currency", { length: 3 }),
  lastValidatedAt: timestamp("last_validated_at", { withTimezone: true }),
  /** Taxonomy CODE of the last validation failure — never provider internals. */
  validationError: text("validation_error"),
  scopes: jsonb("scopes").notNull(),
  webhookEndpointId: text("webhook_endpoint_id"),
  webhookSecretEnc: text("webhook_secret_enc"), // AES-256-GCM envelope (4B)
  /** Any SUCCESSFULLY PROCESSED webhook (4B) — webhook-driven freshness. */
  lastWebhookAt: timestamp("last_webhook_at", { withTimezone: true }),
  status: text("status").notNull().default("active"), // active | revoked | invalid | error | provisioning | orphaned
  /** Endpoint lifecycle (4B correction): null = registered/healthy; see
   *  migration 0016 for the full state list. Never carries secrets. */
  webhookState: text("webhook_state"),
  lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
  backfillDoneAt: timestamp("backfill_done_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
}, (t) => [
  // At most ONE ACTIVE (usable) connection per (org, mode); lifecycle
  // history/transient rows are excluded (partial unique index — 0016).
  uniqueIndex("stripe_connections_org_mode_usable_uq")
    .on(t.orgId, t.mode)
    .where(sql`status = 'active'`)
]);

/**
 * Durable per-entity read-only sync state (Phase 4A §10): cursors/checkpoints,
 * freshness, safe error codes. One row per (org, entity). Webhook processing
 * (4B) will update the same rows — one canonical freshness model.
 */
export const syncState = pgTable("sync_state", {
  id: uuid().primaryKey().$defaultFn(() => uuidv7()),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  entity: text("entity").notNull(), // customers | subscriptions | invoices
  status: text("status").notNull().default("idle"), // idle | running | ok | failed
  cursor: text("cursor"), // provider checkpoint for resume
  providerAccount: text("provider_account"),
  pagesSynced: integer("pages_synced").notNull().default(0),
  recordsUpserted: integer("records_upserted").notNull().default(0),
  lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  /** Safe taxonomy code only (never provider internals). */
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
}, (t) => [unique("sync_state_org_entity_uq").on(t.orgId, t.entity)]);

/* ---------- Billing mirror (read model of the org's Stripe) ---------- */

export const planCatalog = pgTable("plan_catalog", {
  id: uuid().primaryKey().$defaultFn(() => uuidv7()),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  stripePriceId: text("stripe_price_id").notNull(),
  stripeProductId: text("stripe_product_id").notNull(),
  nickname: text("nickname"),
  amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
  currency: char("currency", { length: 3 }).notNull(),
  interval: text("interval").notNull(), // month | year
  rank: integer("rank").notNull(),
  deletedAt: timestamp("deleted_at", { withTimezone: true })
}, (t) => [unique("plan_catalog_org_price_uq").on(t.orgId, t.stripePriceId)]);

export const customers = pgTable("customers", {
  id: uuid().primaryKey().$defaultFn(() => uuidv7()),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  stripeCustomerId: text("stripe_customer_id").notNull(),
  email: text("email"),
  name: text("name"),
  country: char("country", { length: 2 }),
  currency: char("currency", { length: 3 }),
  mrrCents: bigint("mrr_cents", { mode: "number" }).notNull().default(0),
  status: text("status").notNull().default("active"), // active | past_due | canceled
  defaultPayment: jsonb("default_payment"), // {brand,last4,exp_month,exp_year,network_token}
  stripeCreatedAt: timestamp("stripe_created_at", { withTimezone: true }),
  /** Provider deletion (Stripe `deleted: true`) — Stripe stays authoritative. */
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
}, (t) => [
  unique("customers_org_stripe_uq").on(t.orgId, t.stripeCustomerId),
  index("customers_org_status_idx").on(t.orgId, t.status),
  index("customers_org_email_idx").on(t.orgId, t.email)
]);

export const subscriptions = pgTable("subscriptions", {
  id: uuid().primaryKey().$defaultFn(() => uuidv7()),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  customerId: uuid("customer_id").notNull().references(() => customers.id, { onDelete: "cascade" }),
  stripeSubscriptionId: text("stripe_subscription_id").notNull(),
  stripePriceId: text("stripe_price_id").notNull(),
  status: text("status").notNull(), // stripe status verbatim
  amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
  currency: char("currency", { length: 3 }).notNull(),
  interval: text("interval").notNull(),
  currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
  cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
  canceledAt: timestamp("canceled_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
}, (t) => [unique("subscriptions_org_stripe_uq").on(t.orgId, t.stripeSubscriptionId)]);

export const payments = pgTable("payments", {
  id: uuid().primaryKey().$defaultFn(() => uuidv7()),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  customerId: uuid("customer_id").notNull().references(() => customers.id, { onDelete: "cascade" }),
  subscriptionId: uuid("subscription_id").references(() => subscriptions.id, { onDelete: "set null" }),
  stripeInvoiceId: text("stripe_invoice_id"),
  stripePaymentIntentId: text("stripe_payment_intent_id"),
  stripeChargeId: text("stripe_charge_id"),
  amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
  currency: char("currency", { length: 3 }).notNull(),
  status: text("status").notNull(), // open | paid | failed | refunded | void
  attemptedCount: integer("attempted_count").notNull().default(0),
  declineCode: text("decline_code"),
  declineMessage: text("decline_message"),
  networkTokenAvailable: boolean("network_token_available").notNull().default(false),
  hostedInvoiceUrl: text("hosted_invoice_url"),
  periodStart: timestamp("period_start", { withTimezone: true }),
  periodEnd: timestamp("period_end", { withTimezone: true }),
  failedAt: timestamp("failed_at", { withTimezone: true }),
  paidAt: timestamp("paid_at", { withTimezone: true }),
  raw: jsonb("raw"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
}, (t) => [
  index("payments_org_status_failed_idx").on(t.orgId, t.status, t.failedAt),
  index("payments_org_customer_created_idx").on(t.orgId, t.customerId, t.createdAt)
]);

export const paymentAttempts = pgTable("payment_attempts", {
  id: uuid().primaryKey().$defaultFn(() => uuidv7()),
  paymentId: uuid("payment_id").notNull().references(() => payments.id, { onDelete: "cascade" }),
  source: text("source").notNull(), // stripe_default | revessent_retry | checkout | member
  stripeChargeId: text("stripe_charge_id"),
  declineCode: text("decline_code"),
  outcome: text("outcome").notNull(), // succeeded | failed
  attemptedAt: timestamp("attempted_at", { withTimezone: true }).notNull(),
  raw: jsonb("raw")
}, (t) => [index("payment_attempts_payment_idx").on(t.paymentId, t.attemptedAt)]);

/* ---------- Recovery domain ---------- */

export const recoveryStatusEnum = pgEnum("recovery_status", [
  "detected", "analyzing", "retrying", "contacting", "checkout", "recovered",
  "lost", "canceled", "dismissed"
]);

export const recoveryCases = pgTable("recovery_cases", {
  id: uuid().primaryKey().$defaultFn(() => uuidv7()),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  customerId: uuid("customer_id").notNull().references(() => customers.id, { onDelete: "cascade" }),
  subscriptionId: uuid("subscription_id").references(() => subscriptions.id, { onDelete: "set null" }),
  paymentId: uuid("payment_id").notNull().references(() => payments.id, { onDelete: "cascade" }),
  status: recoveryStatusEnum("status").notNull().default("detected"),
  declineCode: text("decline_code").notNull(),
  declineCategory: text("decline_category").notNull(),
  amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
  currency: char("currency", { length: 3 }).notNull(),
  firstFailedAt: timestamp("first_failed_at", { withTimezone: true }).notNull(),
  nextActionAt: timestamp("next_action_at", { withTimezone: true }),
  retryPolicyVersion: integer("retry_policy_version").notNull().default(1),
  attemptNo: integer("attempt_no").notNull().default(0),
  closedAt: timestamp("closed_at", { withTimezone: true }),
  closedReason: text("closed_reason"),
  recoveredCents: bigint("recovered_cents", { mode: "number" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
}, (t) => [
  unique("recovery_cases_org_payment_uq").on(t.orgId, t.paymentId),
  index("recovery_cases_org_status_next_idx").on(t.orgId, t.status, t.nextActionAt),
  index("recovery_cases_org_customer_idx").on(t.orgId, t.customerId, t.createdAt)
]);

export const recoveryAttempts = pgTable("recovery_attempts", {
  id: uuid().primaryKey().$defaultFn(() => uuidv7()),
  caseId: uuid("case_id").notNull().references(() => recoveryCases.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(), // auto_retry | note | checkout | manual_retry
  scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
  executedAt: timestamp("executed_at", { withTimezone: true }),
  status: text("status").notNull().default("scheduled"), // scheduled|executing|succeeded|failed|unknown|skipped|canceled
  // Phase 3 (Phase 1 §5.2); Phase 4C extends it into the durable PAYMENT
  // EXECUTION identity — see migration 0017. Never secrets/card data.
  idempotencyKey: text("idempotency_key"), // unique per (org) — 0017 index
  declineCode: text("decline_code"),
  actor: text("actor").notNull().default("system"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // ---- Phase 4C execution identity (0017) ----
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  /** Immutable execution target: the local payment (invoice mirror). */
  paymentId: uuid("payment_id").references(() => payments.id, { onDelete: "set null" }),
  /** Immutable financial parameters — explicit, never defaulted (§7). */
  amountCents: bigint("amount_cents", { mode: "number" }),
  currency: char("currency", { length: 3 }),
  stripeConnectionId: uuid("stripe_connection_id"),
  providerPaymentIntentId: text("provider_payment_intent_id"),
  /** Hash over payment|amount|currency|operation — detects §11 conflicts. */
  requestHash: text("request_hash"),
  /** Safe failure code (taxonomy-safe, no provider internals). */
  errorCode: text("error_code"),
  outcomeCategory: text("outcome_category"),
  /** 'never' | 'later' — classification ONLY; no retry worker exists (§14). */
  retryClassification: text("retry_classification"),
  providerMeta: jsonb("provider_meta"),
  reconciledAt: timestamp("reconciled_at", { withTimezone: true }),
  /** retry_policies.version snapshot authorizing an automated attempt (0018). */
  policyVersion: integer("policy_version"),
  /**
   * Sequential AUTOMATED retry attempt number for the case — the `attempt`
   * component of the J2 key rv:{org}:{case}:{attempt} (0019). Manual attempts
   * are NULL here: they never consume the automated sequence. Uniqueness per
   * (case, attempt_no) is enforced by a partial unique index for auto rows.
   */
  attemptNo: integer("attempt_no")
}, (t) => [
  index("recovery_attempts_case_idx").on(t.caseId, t.scheduledAt),
  uniqueIndex("recovery_attempts_org_key_uq").on(t.orgId, t.idempotencyKey)
]);

/**
 * Phase 6 safety fix: authoritative customer communication opt-out. One row
 * per (org, customer, channel); append-only for the app role. Read at prepare
 * time and again after the durable send claim, before any provider call.
 */
export const communicationSuppressions = pgTable("communication_suppressions", {
  id: uuid().primaryKey().$defaultFn(() => uuidv7()),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  customerId: uuid("customer_id").notNull().references(() => customers.id, { onDelete: "cascade" }),
  channel: text("channel").notNull().default("email"),
  reason: text("reason").notNull(),      // customer_unsubscribed | operator
  source: text("source").notNull(),      // unsubscribe_token | operator | system
  sourceRef: uuid("source_ref"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
}, (t) => [
  unique("communication_suppressions_org_customer_channel_uq").on(t.orgId, t.customerId, t.channel),
  index("communication_suppressions_customer_idx").on(t.customerId)
]);

export const recoveryMessages = pgTable("recovery_messages", {
  id: uuid().primaryKey().$defaultFn(() => uuidv7()),
  caseId: uuid("case_id").notNull().references(() => recoveryCases.id, { onDelete: "cascade" }),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  template: text("template"),
  aiGenerationId: uuid("ai_generation_id"),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  ctaKind: text("cta_kind").notNull().default("checkout"),
  /** draft|awaiting_approval|approved|auto_approved|suppressed|sent|failed|invalidated
   *  ('invalidated' extends the §5.2 set — required by the Phase 2 UI approval contract:
   *  an approved draft that is edited must display as invalidated. History lives in audit_logs.) */
  approvalStatus: text("approval_status").notNull().default("draft"),
  approvedBy: text("approved_by").references(() => user.id),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  invalidatedAt: timestamp("invalidated_at", { withTimezone: true }),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  providerMessageId: text("provider_message_id"),
  openedAt: timestamp("opened_at", { withTimezone: true }),
  clickedAt: timestamp("clicked_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  // ---- Phase 6 durable communication state (0021) ----
  /** dunning_note | final_notice — chosen by the deterministic policy. */
  purpose: text("purpose"),
  /** retry_failed | case_lost — the Phase 4D lifecycle event that fired. */
  lifecycleTrigger: text("lifecycle_trigger"),
  triggerRef: text("trigger_ref"),
  /** comm:{org}:{case}:{purpose} — one logical communication per identity (partial unique index). */
  dedupeKey: text("dedupe_key"),
  /** Application-resolved recipient (customers.email at prepare time; re-verified at send). Never model-controlled. */
  recipientEmail: text("recipient_email"),
  /** pending|sending|sent|failed|suppressed|unknown */
  sendStatus: text("send_status").notNull().default("pending"),
  sendAfter: timestamp("send_after", { withTimezone: true }),
  sendAttempts: integer("send_attempts").notNull().default(0),
  sendClaimedAt: timestamp("send_claimed_at", { withTimezone: true }),
  /** Safe code only — never provider bodies. */
  lastSendErrorCode: text("last_send_error_code"),
  suppressedReason: text("suppressed_reason"),
  /** ai | fallback */
  generationSource: text("generation_source"),
  fallbackReason: text("fallback_reason"),
  /** Authoritative facts interpolated into the email (amount, currency, org name…) — no secrets, no PII beyond first name. */
  factSnapshot: jsonb("fact_snapshot"),
  autoApproved: boolean("auto_approved").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
}, (t) => [
  index("recovery_messages_case_idx").on(t.caseId),
  index("recovery_messages_awaiting_idx").on(t.orgId, t.approvalStatus),
  index("recovery_messages_send_due_idx").on(t.orgId, t.sendStatus, t.sendAfter)
]);

export const recoveryCheckouts = pgTable("recovery_checkouts", {
  id: uuid().primaryKey().$defaultFn(() => uuidv7()),
  caseId: uuid("case_id").notNull().references(() => recoveryCases.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(), // /c/{token}; SHA-256, hash stored only (§7.2)
  stripeSessionId: text("stripe_session_id"),
  status: text("status").notNull().default("open"), // open|completed|expired|disabled
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
});

export const recoveryAttributions = pgTable("recovery_attributions", {
  id: uuid().primaryKey().$defaultFn(() => uuidv7()),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  caseId: uuid("case_id").notNull().references(() => recoveryCases.id),
  customerId: uuid("customer_id").notNull().references(() => customers.id),
  paymentId: uuid("payment_id").notNull().references(() => payments.id),
  source: text("source").notNull(), // retry | note | checkout | organic_after_nudge
  amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
  withinWindow: boolean("within_window").notNull(),
  policySnapshot: jsonb("policy_snapshot").notNull(),
  attributedAt: timestamp("attributed_at", { withTimezone: true }).notNull().defaultNow()
}, (t) => [
  unique("recovery_attributions_payment_uq").on(t.paymentId),
  index("recovery_attributions_org_idx").on(t.orgId, t.attributedAt)
]);

export const retryPolicies = pgTable("retry_policies", {
  id: uuid().primaryKey().$defaultFn(() => uuidv7()),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  rules: jsonb("rules").notNull(),
  createdBy: text("created_by").references(() => user.id),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
}, (t) => [unique("retry_policies_org_version_uq").on(t.orgId, t.version)]);

export const voiceProfiles = pgTable("voice_profiles", {
  id: uuid().primaryKey().$defaultFn(() => uuidv7()),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  brandKey: text("brand_key").notNull().default("default"),
  sampleText: text("sample_text").notNull(),
  styleSummary: text("style_summary").notNull(),
  greeting: text("greeting"),
  signoff: text("signoff"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
}, (t) => [unique("voice_profiles_org_brand_uq").on(t.orgId, t.brandKey)]);

/* ---------- Expansion domain ---------- */

export const expansionSignals = pgTable("expansion_signals", {
  id: uuid().primaryKey().$defaultFn(() => uuidv7()),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  customerId: uuid("customer_id").notNull().references(() => customers.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(), // usage_limit | near_limit | feature_gate | manual
  payload: jsonb("payload").notNull(),
  detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
  consumedBy: uuid("consumed_by")
});

export const expansionOpportunities = pgTable("expansion_opportunities", {
  id: uuid().primaryKey().$defaultFn(() => uuidv7()),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  customerId: uuid("customer_id").notNull().references(() => customers.id, { onDelete: "cascade" }),
  signalId: uuid("signal_id").references(() => expansionSignals.id),
  currentPriceId: text("current_price_id"),
  recommendedPriceId: text("recommended_price_id").notNull(),
  potentialMrrCents: bigint("potential_mrr_cents", { mode: "number" }).notNull(),
  rationale: text("rationale").notNull(),
  aiGenerationId: uuid("ai_generation_id"),
  status: text("status").notNull().default("new"), // new|awaiting_approval|approved|sent|accepted|declined|expired|dismissed
  approvedBy: text("approved_by").references(() => user.id),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  sentAt: timestamp("sent_at", { withTimezone: true }),
  acceptedAt: timestamp("accepted_at", { withTimezone: true }),
  upgradedSubscriptionId: uuid("upgraded_subscription_id").references(() => subscriptions.id),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  draftSubject: text("draft_subject"),
  draftBody: text("draft_body"),
  draftStatus: text("draft_status").notNull().default("none"), // none|draft|awaiting_approval|approved|invalidated (Phase 2 UI contract)
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
}, (t) => [index("expansion_opportunities_org_status_idx").on(t.orgId, t.status, t.createdAt)]);

/* ---------- AI (schema only in Phase 3; execution = Phase 6) ---------- */

export const aiGenerations = pgTable("ai_generations", {
  id: uuid().primaryKey().$defaultFn(() => uuidv7()),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  purpose: text("purpose").notNull(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  promptVersion: text("prompt_version").notNull(),
  inputRefs: jsonb("input_refs").notNull(),
  inputSanitizedHash: text("input_sanitized_hash").notNull(),
  output: jsonb("output").notNull(),
  valid: boolean("valid").notNull(),
  tokensIn: integer("tokens_in"),
  tokensOut: integer("tokens_out"),
  costMillicents: integer("cost_millicents"),
  latencyMs: integer("latency_ms"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
}, (t) => [index("ai_generations_org_purpose_idx").on(t.orgId, t.purpose, t.createdAt)]);

export const aiUsageBudgets = pgTable("ai_usage_budgets", {
  orgId: uuid("org_id").primaryKey().references(() => organizations.id, { onDelete: "cascade" }),
  month: date("month").notNull(),
  spentMillicents: bigint("spent_millicents", { mode: "number" }).notNull().default(0),
  capMillicents: bigint("cap_millicents", { mode: "number" }).notNull()
});

/* ---------- Ops ---------- */

export const webhookEvents = pgTable("webhook_events", {
  id: uuid().primaryKey().$defaultFn(() => uuidv7()),
  source: text("source").notNull().default("stripe"),
  orgId: uuid("org_id").references(() => organizations.id),
  mode: text("mode"),
  /** Stripe event id — DB-unique: the at-least-once idempotency invariant. */
  // Delivery-unique per (source, account, external_id) — see migration 0014.
  externalId: text("external_id").notNull(),
  type: text("type").notNull(),
  /** The Stripe account the event concerns (when the payload carries one). */
  account: text("account"),
  payload: jsonb("payload").notNull(),
  status: text("status").notNull().default("pending"), // pending|processed|failed|skipped|reconciled
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"), // SAFE code/anomaly only — never payload/PII
  /** Provider sequencing: event.created (unix) — ordering guard input. */
  providerCreatedAt: timestamp("provider_created_at", { withTimezone: true }),
  /** The provider object this event concerns (ordering + reconciliation). */
  objectType: text("object_type"),
  objectId: text("object_id"),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp("processed_at", { withTimezone: true })
}, (t) => [index("webhook_events_pending_idx").on(t.status, t.receivedAt),
  index("webhook_events_object_idx").on(t.orgId, t.objectType, t.objectId)]);

export const auditLogs = pgTable("audit_logs", {
  id: uuid().primaryKey().$defaultFn(() => uuidv7()),
  orgId: uuid("org_id").notNull(),
  actorId: text("actor_id"),
  actorKind: text("actor_kind").notNull().default("user"), // user|system|ai
  action: text("action").notNull(), // 'message.approved', 'policy.updated', ...
  targetType: text("target_type").notNull(),
  targetId: text("target_id").notNull(),
  diff: jsonb("diff"),
  ip: text("ip"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
}, (t) => [index("audit_logs_org_created_idx").on(t.orgId, t.createdAt)]);

export const orgSubscriptions = pgTable("org_subscriptions", {
  orgId: uuid("org_id").primaryKey().references(() => organizations.id, { onDelete: "cascade" }),
  stripeCustomerId: text("stripe_customer_id"),
  stripeSubscriptionId: text("stripe_subscription_id"),
  plan: text("plan").notNull().default("ember"),
  status: text("status").notNull().default("trialing"),
  guaranteeStartedAt: timestamp("guarantee_started_at", { withTimezone: true }),
  guaranteeEndsAt: timestamp("guarantee_ends_at", { withTimezone: true }),
  refundedAt: timestamp("refunded_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  // Phase 7 (0023): synchronized billing state (Stripe Billing is the authority)
  currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
  cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
  providerUpdatedAt: timestamp("provider_updated_at", { withTimezone: true }),
  lastEventId: text("last_event_id"),
  planSource: text("plan_source").notNull().default("default"), // default | stripe_billing | operator
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow()
}, (t) => [index("org_subscriptions_stripe_customer_idx").on(t.stripeCustomerId),
  index("org_subscriptions_stripe_subscription_idx").on(t.stripeSubscriptionId)]);

export const digests = pgTable("digests", {
  id: uuid().primaryKey().$defaultFn(() => uuidv7()),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  periodStart: date("period_start").notNull(),
  periodEnd: date("period_end").notNull(),
  payload: jsonb("payload").notNull(),
  aiGenerationId: uuid("ai_generation_id"),
  sentAt: timestamp("sent_at", { withTimezone: true })
}, (t) => [unique("digests_org_period_uq").on(t.orgId, t.periodStart)]);

/* ---------- API conventions (§6.1) ---------- */

export const idempotencyKeys = pgTable("idempotency_keys", {
  key: text("key").notNull(), // {actor}:{route}:{client key}
  responseBody: jsonb("response_body").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull()
}, (t) => [unique("idempotency_keys_uq").on(t.key)]);

/* ---------- Phase 5: durable job lifecycle (architecture §10) ---------- */

/**
 * Durable authority for background work (§10: at-least-once enqueue,
 * exactly-once effects). Redis/BullMQ delivers; THIS row decides what the
 * work was, whom it belongs to, whether it already ran, and whether a lease
 * went stale. `dedupe_key` is the deterministic business identity; the partial
 * unique index (0020) admits at most one LIVE (queued|leased) job per key, so
 * repeated scheduler discovery or duplicate enqueues cannot amplify work.
 */
export const jobRuns = pgTable("job_runs", {
  id: uuid().primaryKey().$defaultFn(() => uuidv7()),
  orgId: uuid("org_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
  queue: text("queue").notNull(), // §10.1 queue name ('retries')
  jobType: text("job_type").notNull(), // §10.2 job name ('retry.execute')
  /** Deterministic business identity, e.g. `retry-exec:{org}:{case}`. */
  dedupeKey: text("dedupe_key").notNull(),
  /** Target resource (the recovery case); null only if the case was deleted. */
  caseId: uuid("case_id").references(() => recoveryCases.id, { onDelete: "set null" }),
  status: text("status").notNull().default("queued"), // queued|leased|succeeded|failed|canceled
  /** Delivered business result (Phase 4D verdict): executed|blocked|waiting|exhausted|disabled|not_due|no_such_case. */
  outcome: text("outcome"),
  /** Infrastructure attempts consumed (BullMQ retries), not business attempts. */
  attempts: integer("attempts").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(5), // §10.2: exponential backoff ×5, then dead-letter
  runAfter: timestamp("run_after", { withTimezone: true }).notNull().defaultNow(),
  leasedAt: timestamp("leased_at", { withTimezone: true }),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  lastAttemptedAt: timestamp("last_attempted_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  /** Safe category/code only — never provider error bodies (§7 redaction). */
  lastErrorCategory: text("last_error_category"),
  lastErrorCode: text("last_error_code"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow()
}, (t) => [
  index("job_runs_org_created_idx").on(t.orgId, t.createdAt),
  index("job_runs_status_idx").on(t.status)
]);
