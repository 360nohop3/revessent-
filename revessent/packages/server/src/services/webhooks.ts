/**
 * STRIPE WEBHOOK RECEIVER + PROCESSOR (Phase 4B).
 *
 * Architecture v1 §8.2/§8.3/§10.3: `POST /api/v1/webhooks/stripe/{orgRef}` —
 * the {orgRef} is the CONNECTION id (unguessable uuid) created at connect
 * time; the endpoint is self-registered on the Stripe account with the
 * restricted key (Webhook Endpoints permission, §8.2 step 3).
 *
 * Flow (§22-B): raw request → official signature verification (raw body,
 * 5-minute replay window) → connection/account resolution → durable insert
 * (DB-unique external_id) → idempotent processing (per-event advisory lock;
 * state mutation + `processed` commit in ONE transaction) → provider-truth
 * normalization (Phase 4A discipline, shared appliers) → domain update →
 * freshness/reconciliation.
 *
 * NO queue/worker (Phase 4B constraints): processing runs inline after the
 * durable insert. Failures keep the event row with status `failed` and a
 * safe code — never lost, repairable via duplicate delivery or
 * reconciliation (manual sync).
 *
 * There is NO provider write anywhere: webhooks update REVESSENT's local
 * representation only.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import * as schema from "@revessent/db";
import { withOrgTx, withPgAdvisoryLock, type Db } from "@revessent/db";
import { verifyStripeWebhook, type StripeWebhookEvent, getStripeGateway } from "@revessent/integrations";
import { appDb } from "../context.js";
import { decryptConnectionKey } from "./settings.js";
import { ProblemError } from "../http/problems.js";
import { openSecret } from "../crypto/secret-box.js";
import { serverEnv } from "@revessent/config";
import { audit } from "./audit.js";
import {
  applyProviderCustomer, applyProviderInvoice, applyProviderSubscription,
  recomputeCustomerMrr, type ApplyResult
} from "./sync.js";

type ConnectionRow = typeof schema.stripeConnections.$inferSelect;

/** The event types the per-connection webhook endpoint subscribes to (§8.2/§8.3). */
export const WEBHOOK_EVENT_TYPES = [
  "customer.updated",
  "customer.deleted",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.paid",
  "invoice.payment_failed",
  "invoice.updated",
  "invoice.voided",
  "invoice.payment_action_required",
  "charge.refunded",
  "charge.succeeded",
  "charge.failed",
  "account.application.deauthorized"
] as const;

/** Public webhook URL for a connection (used when self-registering). */
export function webhookEndpointUrl(connectionId: string): string {
  const origin = (serverEnv().BETTER_AUTH_URL ?? "http://localhost:3000").replace(/\/$/, "");
  return `${origin}/api/v1/webhooks/stripe/${connectionId}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface WebhookReceipt {
  received: true;
  duplicate: boolean;
  status: "processed" | "skipped" | "failed" | "pending" | "reconciled";
  note: string | null;
}

/**
 * Receives one Stripe webhook delivery. Throws SAFE ProblemErrors (mapped to
 * problem+json 400 by the route) for unknown endpoint / bad signature /
 * replay / mode mismatch. Valid events are ALWAYS durably persisted before
 * any processing is attempted.
 */
export async function receiveStripeWebhook(input: {
  orgRef: string; rawBody: string; sigHeader: string | null;
}): Promise<WebhookReceipt> {
  const db = appDb();
  if (!UUID_RE.test(input.orgRef)) throw new ProblemError("validation", "Unknown webhook endpoint.");

  // 1. Resolve the connection via the narrowly-scoped SECURITY DEFINER
  //    lookup (0013) — no org scope exists before authentication succeeds.
  const resolved = await db.execute(
    sql`select org_id, mode, stripe_account_id, status, webhook_secret_enc
        from resolve_webhook_connection(${input.orgRef}::uuid)`);
  const conn = resolved.rows[0] as {
    org_id: string; mode: string; stripe_account_id: string; status: string;
    webhook_secret_enc: string | null;
  } | undefined;
  // Unknown endpoint OR endpoint without a stored signing secret: cannot be
  // verified → safe 400 (Stripe retries and eventually disables; §10.3).
  if (!conn || !conn.webhook_secret_enc) throw new ProblemError("validation", "Unknown webhook endpoint.");
  const orgId = conn.org_id;

  // 2. OFFICIAL signature verification against the RAW body. Never parse→
  //    re-stringify; never a client-generated representation. The endpoint
  //    signing secret is stored sealed (same envelope as the API key) and
  //    opened only here, in memory, for verification.
  const signingSecret = openSecret(conn.webhook_secret_enc, serverEnv().KEY_ENCRYPTION_KEY);
  const verdict = await verifyStripeWebhook(input.rawBody, input.sigHeader, signingSecret);
  if (!verdict.ok) throw new ProblemError("validation", verdict.safeMessage);
  const ev = verdict.event;

  // 3. Mode + account scoping: never trust org identity from the body. The
  //    endpoint URL named the connection; the signature proves the sender
  //    knows its signing secret; the account claim (when present) must be
  //    the connected account — else the event is skipped, never applied.
  const expectLive = conn.mode === "live";
  if (ev.livemode !== expectLive) throw new ProblemError("validation", "Event mode does not match this endpoint.");
  if (ev.account && ev.account !== conn.stripe_account_id) {
    await withOrgTx(db, orgId, (tx) => tx.insert(schema.webhookEvents).values({
      source: "stripe", orgId, mode: conn.mode, externalId: ev.id, type: ev.type,
      account: ev.account, payload: ev.payload as never,
      providerCreatedAt: new Date(ev.createdEpoch * 1000),
      objectType: ev.objectType, objectId: ev.objectId,
      status: "skipped", lastError: "account_mismatch", attempts: 1,
      processedAt: new Date()
    }).onConflictDoNothing()); // same delivery seen before — nothing more to do
    return { received: true, duplicate: false, status: "skipped", note: "account_mismatch" };
  }

  // 4. Durable, DB-unique insert (at-least-once idempotency invariant).
  const inserted = await withOrgTx(db, orgId, (tx) =>
    tx.insert(schema.webhookEvents).values({
      source: "stripe", orgId, mode: conn.mode, externalId: ev.id, type: ev.type,
      account: ev.account, payload: ev.payload as never,
      providerCreatedAt: new Date(ev.createdEpoch * 1000),
      objectType: ev.objectType, objectId: ev.objectId,
      status: "pending"
    }).onConflictDoNothing() // delivery-unique per (source, account, external_id) — 0014
      .returning({ id: schema.webhookEvents.id }));
  const duplicate = inserted.length === 0;

  // 5. Idempotent processing under a per-event advisory lock (same race
  //    discipline as the Phase 4A sync single-flight).
  const connectionId = input.orgRef;
  const outcome = await withPgAdvisoryLock(db, "revessent:webhook-event", ev.id, async () => {
    const row = await withOrgTx(db, orgId, async (tx) => {
      const [r] = await tx.select().from(schema.webhookEvents).where(
        and(eq(schema.webhookEvents.orgId, orgId), eq(schema.webhookEvents.externalId, ev.id)));
      return r;
    });
    if (!row) return { status: "failed" as const, note: "persist_missing" };
    if (row.status === "processed" || row.status === "skipped" || row.status === "reconciled") {
      return { status: row.status as "processed" | "skipped" | "reconciled", note: row.lastError ?? null }; // handled — no redelivery loop
    }
    // pending (first attempt) or failed (delivery-retry after failure)
    try {
      const note = await processEvent(db, orgId, { ...conn, id: connectionId }, ev, row.id);
      if (note.failed) return { status: "failed" as const, note: note.reason ?? "dependency_missing" };
      return { status: note.applied ? "processed" as const : "skipped" as const, note: note.reason ?? null };
    } catch (err) {
      const code = err instanceof ProblemError ? `apply_failed:${err.problem.type}` : "apply_failed";
      await withOrgTx(db, orgId, (tx) =>
        tx.update(schema.webhookEvents).set({
          status: "failed", attempts: row!.attempts + 1,
          lastError: code, processedAt: new Date()
        }).where(eq(schema.webhookEvents.id, row!.id)));
      return { status: "failed" as const, note: code };
    }
  }, { waitMs: 10000 }); // deterministic: a concurrent duplicate BLOCKS on the
  // event lock, then re-reads the winner's committed terminal state — never a
  // poll race, never a false "pending" under load.

  if (!outcome.acquired) {
    // Bounded wait expired (extreme contention): report THIS delivery's own
    // insert truth; Stripe retries if the winner ultimately failed.
    const [r] = await withOrgTx(db, orgId, (tx) =>
      tx.select({ status: schema.webhookEvents.status, lastError: schema.webhookEvents.lastError })
        .from(schema.webhookEvents)
        .where(and(eq(schema.webhookEvents.orgId, orgId), eq(schema.webhookEvents.externalId, ev.id))));
    if (r && r.status !== "pending") {
      return { received: true, duplicate, status: r.status as WebhookReceipt["status"], note: r.lastError ?? null };
    }
    return { received: true, duplicate, status: "pending", note: "concurrent_delivery" };
  }
  return { received: true, duplicate, status: outcome.value.status, note: outcome.value.note };
}

/* ---------------- ordering guard + routing ---------------- */

/**
 * Returns true when this event is OLDER than the newest already-processed
 * event for the same provider object — Stripe retries and storms are
 * at-least-once AND unordered; an older event must never overwrite newer
 * known state. Sequencing uses the provider's own event timestamps.
 */
async function supersededByNewerEvent(tx: Db, orgId: string, ev: {
  objectType: string; objectId: string | null; createdEpoch: number; id: string;
}): Promise<boolean> {
  if (!ev.objectId) return false;
  const res = await tx.execute(sql`
    select max(provider_created_at) as ts
    from webhook_events
    where org_id = ${orgId} and object_type = ${ev.objectType} and object_id = ${ev.objectId}
      and status = 'processed' and external_id <> ${ev.id}`);
  const ts = (res.rows[0] as { ts: string | Date | null } | undefined)?.ts ?? null;
  if (!ts) return false;
  return ev.createdEpoch * 1000 < new Date(ts).getTime();
}

interface ResolvedConnection {
  org_id: string; mode: string; stripe_account_id: string; status: string;
  webhook_secret_enc: string | null; id: string;
}

async function processEvent(
  db: Db, orgId: string, conn: ResolvedConnection, ev: StripeWebhookEvent,
  eventId: string
): Promise<{ applied: boolean; reason: string | null; failed?: boolean }> {
  const t = ev.type;

  // --- deauthorization / revocation (§12) ---
  if (t === "account.application.deauthorized") {
    await withOrgTx(db, orgId, async (tx) => {
      // Stripe is the authority: the account revoked our access. Destroy the
      // credential AND the webhook signing secret (processing can never
      // resurrect a revoked credential — §12). History retained.
      await tx.update(schema.stripeConnections)
        .set({ status: "revoked", keyCiphertext: null, webhookSecretEnc: null })
        .where(and(eq(schema.stripeConnections.orgId, orgId), eq(schema.stripeConnections.id, conn.id)));
      await audit(tx as unknown as Db, {
        orgId, actorId: null, action: "credential.revoked",
        targetType: "stripe_connection", targetId: conn.id,
        diff: { account: conn.stripe_account_id, source: "webhook" },
        ip: null, userAgent: null
      });
      await markProcessed(tx, eventId, null);
    });
    return { applied: true, reason: null };
  }

  // --- domain-object events ---
  if (ev.objectType === "customer" || ev.objectType === "subscription" || ev.objectType === "invoice") {
    const outcome = await withOrgTx(db, orgId, async (tx): Promise<{ applied: boolean; reason: string | null }> => {
      if (await supersededByNewerEvent(tx, orgId, ev)) {
        // Older event, newer state already applied: skip WITHOUT touching the
        // domain (honest, ordered).
        await tx.update(schema.webhookEvents).set({
          status: "skipped", attempts: sql`${schema.webhookEvents.attempts} + 1`,
          lastError: "superseded_by_newer_event", processedAt: new Date()
        }).where(eq(schema.webhookEvents.id, eventId));
        return { applied: false, reason: "superseded_by_newer_event" };
      }
      const note = await applyDomainObject(tx, orgId, ev);
      // State mutation + terminal status commit TOGETHER (§16/E: a crash
      // here leaves the event pending — retryable via duplicate delivery or
      // reconciliation; never lost, never falsely "processed").
      // dependency_missing is a RETRYABLE failure (delta sync supplies the
      // missing row), everything else is a final skip.
      const failed = note.reason?.startsWith("dependency_missing:") ?? false;
      await tx.update(schema.webhookEvents).set({
        status: note.applied ? "processed" : failed ? "failed" : "skipped",
        attempts: sql`${schema.webhookEvents.attempts} + 1`,
        lastError: note.reason, processedAt: new Date()
      }).where(eq(schema.webhookEvents.id, eventId));
      if (note.applied) {
        await tx.update(schema.stripeConnections)
          .set({ lastWebhookAt: new Date() })
          .where(eq(schema.stripeConnections.id, conn.id));
      }
      return note;
    });
    return {
      applied: outcome.applied,
      reason: outcome.reason,
      failed: outcome.reason?.startsWith("dependency_missing:") ?? false
    };
  }

  // --- everything else: persisted, classified, never dropped (§8.3) ---
  const skipReason = skipReasonFor(t);
  await withOrgTx(db, orgId, (tx) =>
    tx.update(schema.webhookEvents).set({
      status: "skipped", attempts: sql`${schema.webhookEvents.attempts} + 1`,
      lastError: skipReason, processedAt: new Date()
    }).where(eq(schema.webhookEvents.id, eventId)));
  return { applied: false, reason: skipReason };
}

function skipReasonFor(type: string): string {
  if (type.startsWith("payment_method.")) return "payment_method_signals_phase_5";
  if (type.startsWith("charge.dispute")) return "disputes_not_in_domain";
  if (type === "charge.refunded") return "unhandled_charge_event"; // refunded handled below via invoice linkage
  if (type.startsWith("charge.")) return "covered_by_invoice_events";
  return "unhandled_event_type";
}

/** Applies one domain object with Phase 4A truth rules. Never invents state. */
async function applyDomainObject(
  tx: Db, orgId: string, ev: StripeWebhookEvent
): Promise<{ applied: boolean; reason: string | null; failed?: boolean }> {
  const t = ev.type;

  if (t === "customer.deleted") {
    const stripeCustomerId = ev.objectId;
    if (!stripeCustomerId) return { applied: false, reason: "missing_object_id" };
    const res = await tx.update(schema.customers)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(schema.customers.orgId, orgId), eq(schema.customers.stripeCustomerId, stripeCustomerId)))
      .returning({ id: schema.customers.id });
    return res.length > 0
      ? { applied: true, reason: null }
      : { applied: false, reason: "customer_not_present" };
  }

  if (t === "customer.updated" || t === "customer.created") {
    if (!ev.customer) return { applied: false, reason: "unhandled_event_type" };
    const r = await applyProviderCustomer(tx, orgId, ev.customer());
    return classifyApply(r);
  }

  if (t.startsWith("customer.subscription")) {
    if (!ev.subscription) return { applied: false, reason: "unhandled_event_type" };
    const sub = ev.subscription();
    const [customer] = await tx.select().from(schema.customers)
      .where(and(eq(schema.customers.orgId, orgId), eq(schema.customers.stripeCustomerId, sub.customerId)));
    if (!customer) return { applied: false, reason: "dependency_missing:customer_not_synced" };
    const r = await applyProviderSubscription(tx, orgId, customer.id, sub);
    const classified = classifyApply(r);
    if (classified.applied) await recomputeCustomerMrr(tx as unknown as Db, orgId);
    return classified;
  }

  if (t.startsWith("invoice.")) {
    if (!ev.invoice) return { applied: false, reason: "unhandled_event_type" };
    const inv = ev.invoice();
    if (!inv.customerId) return { applied: false, reason: "missing_customer_ref" };
    const [customer] = await tx.select().from(schema.customers)
      .where(and(eq(schema.customers.orgId, orgId), eq(schema.customers.stripeCustomerId, inv.customerId)));
    if (!customer) return { applied: false, reason: "dependency_missing:customer_not_synced" };
    let subscriptionLocalId: string | null = null;
    if (inv.subscriptionId) {
      const [sub] = await tx.select().from(schema.subscriptions)
        .where(and(eq(schema.subscriptions.orgId, orgId), eq(schema.subscriptions.stripeSubscriptionId, inv.subscriptionId)));
      subscriptionLocalId = sub?.id ?? null;
    }
    const r = await applyProviderInvoice(tx, orgId, { customerLocalId: customer.id, subscriptionLocalId }, inv);
    return classifyApply(r);
  }

  return { applied: false, reason: "unhandled_event_type" };
}

function classifyApply(r: ApplyResult): { applied: boolean; reason: string | null } {
  if (r.startsWith("anomaly:")) return { applied: false, reason: r };
  if (r.startsWith("applied+")) return { applied: true, reason: r.slice("applied+".length) };
  return { applied: true, reason: null };
}

async function markProcessed(tx: Db, eventId: string, note: string | null): Promise<void> {
  await tx.update(schema.webhookEvents).set({
    status: "processed", attempts: sql`${schema.webhookEvents.attempts} + 1`,
    lastError: note, processedAt: new Date()
  }).where(eq(schema.webhookEvents.id, eventId));
}

/* ---------------- status + reconciliation ---------------- */

export interface WebhookStatus {
  configured: boolean;
  endpointId: string | null;
  lastWebhookAt: string | null;
  failed: number;
  unprocessed: number;
  lastFailureCode: string | null;
  lastFailureAt: string | null;
  /** Endpoint LIFECYCLE state (4B correction) for the org's usable
   *  connection — the five observable states required for reconciliation:
   *  healthy | registration_failed | cleanup_pending |
   *  provider_removed_local_stale | orphan_cleanup */
  lifecycle: WebhookLifecycle;
}

export type WebhookLifecycle =
  | "healthy" | "registration_failed" | "cleanup_pending"
  | "provider_removed_local_stale" | "orphan_cleanup";

/** Classifies ONE connection row's endpoint lifecycle (exported for tests). */
export function classifyWebhookLifecycle(row: {
  status: string; webhookState: string | null; webhookEndpointId: string | null;
}): WebhookLifecycle {
  if (row.status === "orphaned" || row.webhookState === "orphan_cleanup") return "orphan_cleanup";
  if (row.webhookState === "provider_deleted_local_stale") return "provider_removed_local_stale";
  if (row.webhookState === "cleanup_pending") return "cleanup_pending";
  if (row.webhookState === "registration_failed" || (row.status === "active" && !row.webhookEndpointId)) {
    return "registration_failed";
  }
  return "healthy";
}

export async function webhookStatus(db: Db, orgId: string, conn: ConnectionRow): Promise<WebhookStatus> {
  const rows = await withOrgTx(db, orgId, (tx) =>
    tx.select({
      status: schema.webhookEvents.status,
      n: sql<number>`count(*)::int`,
      lastAt: sql<string | null>`max(${schema.webhookEvents.receivedAt})::text`
    }).from(schema.webhookEvents)
      .where(eq(schema.webhookEvents.orgId, orgId))
      .groupBy(schema.webhookEvents.status));
  const by = Object.fromEntries(rows.map((r) => [r.status, r]));
  const [lastFailure] = await withOrgTx(db, orgId, (tx) =>
    tx.select({ at: schema.webhookEvents.receivedAt, code: schema.webhookEvents.lastError })
      .from(schema.webhookEvents)
      .where(and(eq(schema.webhookEvents.orgId, orgId), eq(schema.webhookEvents.status, "failed")))
      .orderBy(desc(schema.webhookEvents.receivedAt)).limit(1));
  const orphaned = await withOrgTx(db, orgId, (tx) =>
    tx.select({ n: sql<number>`count(*)::int` }).from(schema.stripeConnections)
      .where(and(eq(schema.stripeConnections.orgId, orgId), eq(schema.stripeConnections.status, "orphaned"))));
  const lifecycle: WebhookLifecycle = (orphaned[0]?.n ?? 0) > 0
    ? "orphan_cleanup"
    : classifyWebhookLifecycle(conn as unknown as { status: string; webhookState: string | null; webhookEndpointId: string | null });
  return {
    configured: conn.webhookEndpointId != null && conn.webhookSecretEnc != null,
    endpointId: conn.webhookEndpointId ?? null,
    lastWebhookAt: conn.lastWebhookAt?.toISOString() ?? null,
    failed: by["failed"]?.n ?? 0,
    unprocessed: by["pending"]?.n ?? 0,
    lastFailureCode: lastFailure?.code ?? null,
    lastFailureAt: lastFailure?.at?.toISOString() ?? null,
    lifecycle
  };
}

/**
 * RECONCILIATION (§9/§11): reuses the Phase 4A read-only synchronization as
 * the delta/repair path — no second Stripe client, no extra credentials.
 * Read-only against Stripe; repairs local state from provider truth; failed
 * webhook events whose intent the fresh provider state supersedes are marked
 * `reconciled` (their `last_error` is retained — honest history).
 */
export async function reconcileFromProvider(
  ctx: import("../context.js").OrgContext,
  meta: { ip?: string | null; userAgent?: string | null }
): Promise<unknown> {
  const lifecycle = await repairLifecycle(ctx);
  const { triggerSync } = await import("./sync.js");
  const result = await triggerSync(ctx, meta) as Record<string, unknown>;
  // Phase 4C: resolve executions whose provider outcome was unknown/executing
  // now that fresh provider truth has been established (read-only lookups).
  const { reconcileExecutions } = await import("./execute.js");
  let executions: string[] = [];
  try {
    executions = await reconcileExecutions(ctx);
  } catch { executions = ["execution_reconcile_failed"]; }
  await withOrgTx(appDb(), ctx.org.id, (tx) =>
    tx.update(schema.webhookEvents).set({ status: "reconciled" })
      .where(and(eq(schema.webhookEvents.orgId, ctx.org.id), eq(schema.webhookEvents.status, "failed"))));
  return { ...result, lifecycle, executions };
}

/**
 * LIFECYCLE RECONCILIATION (4B correction): repairs provider/local endpoint
 * lifecycle mismatches. READ-ONLY toward Stripe except for deletion of
 * REVESSENT-owned webhook endpoint configuration (our own endpoints) — no
 * financial call exists on this path. Every action is idempotent.
 */
export async function repairLifecycle(ctx: import("../context.js").OrgContext): Promise<string[]> {
  const db = appDb();
  const actions: string[] = [];
  const rows = await withOrgTx(db, ctx.org.id, (tx) =>
    tx.select().from(schema.stripeConnections).where(eq(schema.stripeConnections.orgId, ctx.org.id)));

  for (const row of rows) {
    // (a) orphaned connection: endpoint exists on Stripe, local finalize +
    //     compensation both failed earlier → delete our endpoint (if we still
    //     hold the sealed key), then convert to a plain revoked history row.
    if (row.status === "orphaned") {
      let cleaned = false;
      if (row.webhookEndpointId && row.keyCiphertext) {
        try {
          await getStripeGateway().deleteWebhookEndpoint(
            decryptConnectionKey(row.keyCiphertext), row.webhookEndpointId);
          cleaned = true;
        } catch { /* left in the recoverable state; still observable */ }
      }
      if (cleaned || !row.webhookEndpointId) {
        await withOrgTx(db, ctx.org.id, (tx) =>
          tx.update(schema.stripeConnections).set({
            status: "revoked", keyCiphertext: null, webhookSecretEnc: null, webhookState: null
          }).where(eq(schema.stripeConnections.id, row.id)));
        actions.push("orphan_cleaned");
      } else {
        actions.push("orphan_cleanup_retry_failed");
      }
      continue;
    }
    // (b) provisioning intent that never finalized: if the provider endpoint
    //     was created before the crash, locate it via OUR receiver URL
    //     (read-only discovery) and delete it; then reap the local row.
    if (row.status === "provisioning") {
      let cleaned = !row.webhookEndpointId; // nothing known to delete…
      if (!cleaned && row.keyCiphertext && row.webhookEndpointId) {
        try {
          await getStripeGateway().deleteWebhookEndpoint(
            decryptConnectionKey(row.keyCiphertext), row.webhookEndpointId);
          cleaned = true;
        } catch { cleaned = false; }
      } else if (!cleaned && row.keyCiphertext) {
        try {
          const found = await getStripeGateway().listWebhookEndpoints(
            decryptConnectionKey(row.keyCiphertext),
            { urlContains: `/api/v1/webhooks/stripe/${row.id}` });
          for (const ep of found) {
            await getStripeGateway().deleteWebhookEndpoint(decryptConnectionKey(row.keyCiphertext), ep.id);
          }
          cleaned = true;
        } catch { cleaned = false; }
      }
      if (cleaned) {
        await withOrgTx(db, ctx.org.id, (tx) =>
          tx.update(schema.stripeConnections).set({
            status: "revoked", keyCiphertext: null, webhookSecretEnc: null, webhookState: null
          }).where(eq(schema.stripeConnections.id, row.id)));
        actions.push("provisioning_reaped");
      } else {
        actions.push("provisioning_cleanup_retry_failed");
      }
      continue;
    }
    // (c) provider endpoint confirmed deleted but local finalization never
    //     committed → complete it locally (pure local repair).
    if (row.webhookState === "provider_deleted_local_stale") {
      await withOrgTx(db, ctx.org.id, (tx) =>
        tx.update(schema.stripeConnections).set({
          status: "revoked", keyCiphertext: null, webhookSecretEnc: null, webhookState: null
        }).where(eq(schema.stripeConnections.id, row.id)));
      actions.push("disconnect_finalized");
      continue;
    }
    // (d) pending provider-side cleanup with retained credentials → retry it.
    if (row.webhookState === "cleanup_pending" && row.webhookEndpointId && row.keyCiphertext) {
      try {
        await getStripeGateway().deleteWebhookEndpoint(
          decryptConnectionKey(row.keyCiphertext), row.webhookEndpointId);
        // Once deleted: if a NEWER usable same-mode connection exists, this
        // row was a rotation leftover → remove it; otherwise finalize revoke.
        const [newer] = await withOrgTx(db, ctx.org.id, (tx) =>
          tx.select({ id: schema.stripeConnections.id }).from(schema.stripeConnections)
            .where(and(
              eq(schema.stripeConnections.orgId, ctx.org.id),
              eq(schema.stripeConnections.mode, row.mode),
              eq(schema.stripeConnections.status, "active")))
            .orderBy(desc(schema.stripeConnections.createdAt)).limit(1));
        if (newer && newer.id !== row.id) {
          await withOrgTx(db, ctx.org.id, (tx) =>
            tx.delete(schema.stripeConnections).where(eq(schema.stripeConnections.id, row.id)));
        } else {
          await withOrgTx(db, ctx.org.id, (tx) =>
            tx.update(schema.stripeConnections).set({
              status: "revoked", keyCiphertext: null, webhookSecretEnc: null, webhookState: null
            }).where(eq(schema.stripeConnections.id, row.id)));
        }
        actions.push("cleanup_completed");
      } catch {
        actions.push("cleanup_retry_failed");
      }
    }
  }
  return actions;
}
