/**
 * PHASE 7 — REVESSENT'S OWN BILLING STATE (Stripe Billing → org_subscriptions).
 *
 * Architecture v1 §3: Revessent bills orgs with Stripe Billing (Checkout +
 * Customer Portal). The PLATFORM account's webhook endpoint
 * (`POST /api/v1/webhooks/billing`) is verified with the official SDK against
 * the raw body and BILLING_WEBHOOK_SECRET, then synchronised here.
 *
 * Discipline (same as the Phase 4B tenant receiver):
 *   - durable, org-scoped, DB-unique event row BEFORE processing (at-least-once)
 *   - per-event advisory lock; duplicates converge on the committed outcome
 *   - provider ordering guard: an event older than the last applied one is
 *     skipped (out-of-order deliveries never regress state)
 *   - tenant resolution ONLY through ids WE stored (stripe_subscription_id /
 *     stripe_customer_id) or — for first linkage — the org id we placed in
 *     the subscription/checkout metadata, and only while the org is unlinked
 *   - status is stored VERBATIM; the resolver decides what it entitles
 *   - no provider write, no plan mutation from any client-controlled value
 */
import { and, eq, sql } from "drizzle-orm";
import * as schema from "@revessent/db";
import { withOrgTx, withPgAdvisoryLock, type Db } from "@revessent/db";
import { verifyStripeWebhook } from "@revessent/integrations";
import { billingEnv } from "@revessent/config";
import { planFromPriceHints, resolveEntitlements, normalizeBillingStatus, type PlanName } from "@revessent/domain";
import { appDb } from "../context.js";
import { ProblemError } from "../http/problems.js";
import { audit } from "./audit.js";

export const BILLING_EVENT_SOURCE = "stripe_billing";

/** Verified, minimally-typed view of the Stripe events we consume. */
export interface BillingEvent {
  id: string;
  type: string;
  createdEpoch: number;
  livemode: boolean;
  /** Raw event (persisted as provenance; contains no secrets). */
  payload: unknown;
  subscription: {
    id: string;
    customerId: string | null;
    status: string;
    cancelAtPeriodEnd: boolean;
    currentPeriodEndEpoch: number | null;
    /** Operator-controlled hints on the PROVIDER side (never client input). */
    lookupKey: string | null;
    priceMetadataPlan: string | null;
    metadataOrgId: string | null;
    metadataPlan: string | null;
  } | null;
  /** checkout.session.completed: links an unlinked org to its customer/subscription. */
  checkout: { customerId: string | null; subscriptionId: string | null; metadataOrgId: string | null } | null;
}

const SUBSCRIPTION_TYPES = new Set([
  "customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted",
  "customer.subscription.paused", "customer.subscription.resumed"
]);

function str(v: unknown): string | null { return typeof v === "string" && v.length > 0 ? v : null; }
function idOf(v: unknown): string | null {
  if (typeof v === "string") return v || null;
  if (v && typeof v === "object" && typeof (v as { id?: unknown }).id === "string") return (v as { id: string }).id;
  return null;
}

/** Shapes a verified Stripe event into the billing view. Pure. */
export function describeBillingEvent(event: {
  id: string; type: string; created: number; livemode?: boolean; data?: { object?: unknown };
}): BillingEvent {
  const obj = (event.data?.object ?? null) as Record<string, unknown> | null;
  const isObj = obj !== null && typeof obj === "object" && typeof obj.id === "string";
  let subscription: BillingEvent["subscription"] = null;
  let checkout: BillingEvent["checkout"] = null;
  if (isObj && SUBSCRIPTION_TYPES.has(event.type) && obj.object === "subscription") {
    const items = (obj.items as { data?: Array<Record<string, unknown>> } | undefined)?.data ?? [];
    const price = (items[0]?.price ?? null) as Record<string, unknown> | null;
    const md = (obj.metadata ?? {}) as Record<string, unknown>;
    const pmd = (price?.metadata ?? {}) as Record<string, unknown>;
    const cpe = typeof obj.current_period_end === "number" ? obj.current_period_end
      : typeof items[0]?.current_period_end === "number" ? (items[0]!.current_period_end as number) : null;
    subscription = {
      id: obj.id as string,
      customerId: idOf(obj.customer),
      status: str(obj.status) ?? "unknown",
      cancelAtPeriodEnd: obj.cancel_at_period_end === true,
      currentPeriodEndEpoch: cpe,
      lookupKey: str(price?.lookup_key),
      priceMetadataPlan: str(pmd.plan),
      metadataOrgId: str(md.org_id),
      metadataPlan: str(md.plan)
    };
  } else if (isObj && event.type === "checkout.session.completed" && obj.object === "checkout.session") {
    const md = (obj.metadata ?? {}) as Record<string, unknown>;
    checkout = { customerId: idOf(obj.customer), subscriptionId: idOf(obj.subscription), metadataOrgId: str(md.org_id) };
  }
  return { id: event.id, type: event.type, createdEpoch: event.created, livemode: event.livemode === true, payload: event, subscription, checkout };
}

/* ---------------------------------------------------------------- receive */

export interface BillingReceipt {
  received: true;
  duplicate: boolean;
  status: "processed" | "skipped" | "failed" | "pending";
  note: string | null;
}

/** HTTP entry: official signature verification over the RAW body, then apply. */
export async function receiveBillingWebhook(input: { rawBody: string; sigHeader: string | null }): Promise<BillingReceipt> {
  const secret = billingEnv().BILLING_WEBHOOK_SECRET;
  // Not configured ⇒ nothing can be verified ⇒ safe 400 (never "processed").
  if (!secret) throw new ProblemError("validation", "Billing webhook endpoint is not configured.");
  const verdict = await verifyStripeWebhook(input.rawBody, input.sigHeader, secret);
  if (!verdict.ok) throw new ProblemError("validation", verdict.safeMessage);
  const raw = verdict.event.payload as { id: string; type: string; created: number; livemode?: boolean; data?: { object?: unknown } };
  const ev = describeBillingEvent(raw);
  if (billingEnv().BILLING_LIVEMODE !== ev.livemode) throw new ProblemError("validation", "Event mode does not match this endpoint.");
  return applyBillingEvent(appDb(), ev);
}

/* ---------------------------------------------------------------- apply */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Tenant resolution through ids we stored; first linkage via provider metadata only while unlinked. */
async function resolveOrg(db: Db, ev: BillingEvent): Promise<{ orgId: string; linkedBy: "stored" | "metadata" } | null> {
  const customer = ev.subscription?.customerId ?? ev.checkout?.customerId ?? null;
  const subscription = ev.subscription?.id ?? ev.checkout?.subscriptionId ?? null;
  if (customer || subscription) {
    const res = await db.execute(sql`select org_id from resolve_billing_org(${customer}, ${subscription})`);
    const row = res.rows[0] as { org_id: string } | undefined;
    if (row) return { orgId: row.org_id, linkedBy: "stored" };
  }
  const claimed = ev.subscription?.metadataOrgId ?? ev.checkout?.metadataOrgId ?? null;
  if (claimed && UUID_RE.test(claimed)) {
    const res = await db.execute(sql`select org_id from resolve_billing_org_unlinked(${claimed}::uuid)`);
    const row = res.rows[0] as { org_id: string } | undefined;
    if (row) return { orgId: row.org_id, linkedBy: "metadata" };
  }
  return null;
}

/**
 * Applies ONE verified billing event. Safe under duplicates (DB-unique per
 * org+source+event id + per-event lock), out-of-order deliveries (provider
 * timestamp guard) and concurrent deliveries (lock + serialised row update).
 */
export async function applyBillingEvent(db: Db, ev: BillingEvent): Promise<BillingReceipt> {
  if (!ev.subscription && !ev.checkout) return { received: true, duplicate: false, status: "skipped", note: "unhandled_event_type" };
  const resolved = await resolveOrg(db, ev);
  // An event we cannot attribute to a tenant is acknowledged and NOT applied
  // (no org scope ⇒ no durable row; nothing to regress). Stripe keeps the
  // event; reconciliation is an operator action.
  if (!resolved) return { received: true, duplicate: false, status: "skipped", note: "org_unresolved" };
  const { orgId } = resolved;

  const inserted = await withOrgTx(db, orgId, (tx) =>
    tx.insert(schema.webhookEvents).values({
      source: BILLING_EVENT_SOURCE, orgId, mode: ev.livemode ? "live" : "test", externalId: ev.id, type: ev.type,
      account: null, payload: ev.payload as never, providerCreatedAt: new Date(ev.createdEpoch * 1000),
      objectType: ev.subscription ? "subscription" : "other", objectId: ev.subscription?.id ?? null,
      status: "pending"
    }).onConflictDoNothing().returning({ id: schema.webhookEvents.id }));
  const duplicate = inserted.length === 0;

  const outcome = await withPgAdvisoryLock(db, "revessent:billing-event", `${orgId}:${ev.id}`, async () => {
    const [row] = await withOrgTx(db, orgId, (tx) => tx.select().from(schema.webhookEvents).where(and(
      eq(schema.webhookEvents.orgId, orgId), eq(schema.webhookEvents.source, BILLING_EVENT_SOURCE), eq(schema.webhookEvents.externalId, ev.id))));
    if (!row) return { status: "failed" as const, note: "persist_missing" };
    if (row.status === "processed" || row.status === "skipped") return { status: row.status as "processed" | "skipped", note: row.lastError ?? null };
    try {
      return await withOrgTx(db, orgId, async (tx) => {
        const note = await applyInTx(tx, orgId, ev, resolved.linkedBy);
        await tx.update(schema.webhookEvents).set({
          status: note.applied ? "processed" : "skipped", attempts: sql`${schema.webhookEvents.attempts} + 1`,
          lastError: note.reason, processedAt: new Date()
        }).where(eq(schema.webhookEvents.id, row.id));
        return { status: note.applied ? "processed" as const : "skipped" as const, note: note.reason };
      });
    } catch (err) {
      const code = err instanceof ProblemError ? `apply_failed:${err.problem.type}` : "apply_failed";
      await withOrgTx(db, orgId, (tx) => tx.update(schema.webhookEvents).set({
        status: "failed", attempts: sql`${schema.webhookEvents.attempts} + 1`, lastError: code, processedAt: new Date()
      }).where(eq(schema.webhookEvents.id, row.id)));
      return { status: "failed" as const, note: code };
    }
  }, { waitMs: 10_000 });

  if (!outcome.acquired) return { received: true, duplicate, status: "pending", note: "concurrent_delivery" };
  return { received: true, duplicate, status: outcome.value.status, note: outcome.value.note };
}

async function applyInTx(tx: Db, orgId: string, ev: BillingEvent, linkedBy: "stored" | "metadata"): Promise<{ applied: boolean; reason: string | null }> {
  // Serialise on the billing row (the transaction holds the row lock until commit).
  const [current] = await tx.select().from(schema.orgSubscriptions).where(eq(schema.orgSubscriptions.orgId, orgId)).for("update");
  if (!current) return { applied: false, reason: "billing_row_missing" };
  const eventAt = new Date(ev.createdEpoch * 1000);
  if (current.providerUpdatedAt && eventAt.getTime() < current.providerUpdatedAt.getTime()) {
    return { applied: false, reason: "superseded_by_newer_event" };
  }
  // Already-linked org: a subscription id that differs from the stored one is
  // a foreign object (a second subscription, or a forged metadata claim) — never applied.
  const subId = ev.subscription?.id ?? ev.checkout?.subscriptionId ?? null;
  if (current.stripeSubscriptionId && subId && subId !== current.stripeSubscriptionId) {
    return { applied: false, reason: "subscription_mismatch" };
  }
  if (current.stripeCustomerId && ev.subscription?.customerId && ev.subscription.customerId !== current.stripeCustomerId) {
    return { applied: false, reason: "customer_mismatch" };
  }

  const before = resolveEntitlements({ plan: current.plan, status: current.status });
  const patch: Partial<typeof schema.orgSubscriptions.$inferInsert> = {
    providerUpdatedAt: eventAt, lastEventId: ev.id, updatedAt: new Date(), planSource: "stripe_billing"
  };
  const reasons: string[] = [linkedBy === "metadata" ? "linked_by_metadata" : "linked_by_stored_ids"];

  if (ev.checkout) {
    if (ev.checkout.customerId) patch.stripeCustomerId = ev.checkout.customerId;
    if (ev.checkout.subscriptionId) patch.stripeSubscriptionId = ev.checkout.subscriptionId;
    reasons.push("checkout_linked");
  }
  let plan: PlanName = before.plan;
  if (ev.subscription) {
    const s = ev.subscription;
    patch.stripeSubscriptionId = s.id;
    if (s.customerId) patch.stripeCustomerId = s.customerId;
    patch.status = ev.type === "customer.subscription.deleted" ? "canceled" : normalizeBillingStatus(s.status);
    patch.cancelAtPeriodEnd = s.cancelAtPeriodEnd;
    patch.currentPeriodEnd = s.currentPeriodEndEpoch ? new Date(s.currentPeriodEndEpoch * 1000) : null;
    if (ev.type === "customer.subscription.deleted") {
      // A deleted subscription leaves the org on the free plan record.
      plan = "ember";
      reasons.push("subscription_deleted");
    } else {
      const mapped = planFromPriceHints({ lookupKey: s.lookupKey, priceMetadataPlan: s.priceMetadataPlan, subscriptionMetadataPlan: s.metadataPlan });
      if (mapped) plan = mapped; else reasons.push("plan_unmapped_kept_previous");
    }
    patch.plan = plan;
  }

  await tx.update(schema.orgSubscriptions).set(patch).where(eq(schema.orgSubscriptions.orgId, orgId));
  const after = resolveEntitlements({ plan: patch.plan ?? current.plan, status: patch.status ?? current.status });
  if (after.plan !== before.plan) {
    // Display mirror (0023 policy: current tenant scope, plan column only).
    await tx.update(schema.organizations).set({ plan: after.plan, updatedAt: new Date() }).where(eq(schema.organizations.id, orgId));
  }

  const base = { orgId, actorId: null, actorKind: "system" as const, targetType: "org_subscription", targetId: orgId, ip: null, userAgent: null };
  await audit(tx, { ...base, action: "billing.state_transitioned", diff: {
    eventType: ev.type, eventId: ev.id, status: [before.status, after.status], plan: [before.plan, after.plan], reasons
  } });
  if (after.plan !== before.plan) {
    await audit(tx, { ...base, action: "entitlement.plan_changed", diff: { plan: [before.plan, after.plan], eventId: ev.id } });
  }
  const changedCaps = (Object.keys(after.capabilities) as Array<keyof typeof after.capabilities>)
    .filter((c) => after.capabilities[c] !== before.capabilities[c]);
  if (changedCaps.length || after.state !== before.state) {
    await audit(tx, { ...base, action: "entitlement.changed", diff: {
      state: [before.state, after.state], effectivePlan: [before.effectivePlan, after.effectivePlan],
      gained: changedCaps.filter((c) => after.capabilities[c]), lost: changedCaps.filter((c) => !after.capabilities[c]), eventId: ev.id
    } });
  }
  return { applied: true, reason: null };
}
