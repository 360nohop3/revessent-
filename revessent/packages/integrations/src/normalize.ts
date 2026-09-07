/**
 * PROVIDER → DOMAIN NORMALIZATION (Phase 4A final financial-truth audit).
 *
 * Provider truth → validated normalization → domain representation → derived
 * metrics. A value the provider did not surface stays UNKNOWN here: it is
 * never converted into a default (0, "month", "usd") that downstream code
 * could mistake for a provider fact.
 *
 * Supported recurring-interval model (Phase 4A): `month` and `year` ONLY.
 * Stripe may return `day` or `week` — these are preserved as
 * `"unsupported"` (never reinterpreted as month) and are excluded from MRR
 * upstream with an explicit anomaly.
 */
import type { ProviderSubscription, ProviderInvoice, ProviderCustomer } from "./gateway.js";

/** Minimal structural view of a Stripe Subscription object (Stripe 22). */
export interface StripeSubscriptionLike {
  id: string;
  customer: string | { id: string } | null | undefined;
  status: string;
  currency?: string | null;
  cancel_at_period_end?: boolean | null;
  canceled_at?: number | null;
  created: number;
  items?: {
    data?: Array<{
      current_period_end?: number | null;
      price?: {
        id?: string | null;
        currency?: string | null;
        /** Tiered/volume prices have no unit_amount — absence is NOT zero. */
        unit_amount?: number | null;
        recurring?: { interval?: string | null } | null;
      } | null;
    }>;
  } | null;
}

export function normalizeSubscription(sub: StripeSubscriptionLike): ProviderSubscription {
  const item = sub.items?.data?.[0] ?? null;
  const price = item?.price ?? null;
  const recurring = price?.recurring ?? null;

  // Interval: verbatim when SUPPORTED (month|year); anything else — day,
  // week, or a missing recurring object — is "unsupported". Never converted.
  const rawInterval = recurring?.interval;
  const interval: ProviderSubscription["interval"] =
    rawInterval === "month" || rawInterval === "year" ? rawInterval : "unsupported";

  // Amount: present-and-integer wins (0 is a meaningful provider-stated
  // value, e.g. a free price); absent/undefined/null stays null (unknown).
  const unit = price?.unit_amount;
  const amountMinor: number | null =
    typeof unit === "number" && Number.isInteger(unit) && unit >= 0 ? unit : null;

  // Currency: never defaulted. Empty string = provider did not surface one.
  const currency = (price?.currency ?? sub.currency ?? "").toUpperCase();

  // Phase 4A prices the FIRST item only; the true item count travels with the
  // record so multi-item subscriptions surface an explicit limitation
  // upstream instead of silently under-counting revenue.
  const itemCount = sub.items?.data?.length ?? 0;

  return {
    id: sub.id,
    customerId: typeof sub.customer === "string" ? sub.customer : (sub.customer as { id: string } | null | undefined)?.id ?? "",
    priceId: price?.id ?? "",
    status: sub.status,
    amountMinor,
    currency,
    interval,
    itemCount,
    cancelAtPeriodEnd: sub.cancel_at_period_end === true,
    canceledAtIso: sub.canceled_at ? new Date(sub.canceled_at * 1000).toISOString() : null,
    currentPeriodEndIso: typeof item?.current_period_end === "number" ? new Date(item.current_period_end * 1000).toISOString() : null,
    createdEpoch: sub.created
  };
}


/* ---------------- Invoices (webhook objects share the list shape) ---------------- */

export interface StripeInvoiceLike {
  id: string;
  customer?: string | { id: string } | null;
  subscription?: string | { id: string } | null;
  parent?: { subscription_details?: { subscription?: string | { id: string } } | null } | null;
  payments?: { data?: Array<{ payment?: { type?: string; payment_intent?: string | { id: string }; charge?: string | { id: string } } | null }> } | null;
  /** Provider guarantees these on invoice objects; a malformed object without
   *  them fails the sync integer guard downstream (never a fabricated 0). */
  amount_paid?: number;
  amount_due?: number;
  currency?: string | null;
  status?: string | null;
  attempted?: boolean | null;
  attempt_count?: number | null;
  hosted_invoice_url?: string | null;
  period_start?: number | null;
  period_end?: number | null;
  status_transitions?: { paid_at?: number | null } | null;
  created: number;
}

/** Stripe 22: the generating subscription moved to parent.subscription_details. */
export function extractInvoiceSubscriptionId(inv: StripeInvoiceLike): string | null {
  const direct = inv.subscription;
  if (typeof direct === "string") return direct;
  const details = inv.parent?.subscription_details ?? null;
  const sub = details?.subscription;
  if (typeof sub === "string") return sub;
  if (sub && typeof sub === "object" && "id" in sub) return (sub as { id: string }).id;
  return null;
}

/** Stripe 22: top-level invoice.payment_intent/charge live in invoice.payments[]. */
export function extractInvoicePaymentIds(inv: StripeInvoiceLike): { paymentIntentId: string | null; chargeId: string | null } {
  let paymentIntentId: string | null = null;
  let chargeId: string | null = null;
  for (const ip of inv.payments?.data ?? []) {
    const p = ip.payment;
    if (!p) continue;
    if (!paymentIntentId && typeof p.payment_intent === "string") paymentIntentId = p.payment_intent;
    if (!chargeId && typeof p.charge === "string") chargeId = p.charge;
  }
  return { paymentIntentId, chargeId };
}

export function normalizeInvoice(inv: StripeInvoiceLike): ProviderInvoice {
  return {
    id: inv.id,
    customerId: typeof inv.customer === "string" ? inv.customer : (inv.customer as { id: string } | null)?.id ?? null,
    subscriptionId: extractInvoiceSubscriptionId(inv),
    paymentIntentId: extractInvoicePaymentIds(inv).paymentIntentId,
    chargeId: extractInvoicePaymentIds(inv).chargeId,
    amountMinor: (inv.status === "paid" ? inv.amount_paid : inv.amount_due) as number,
    currency: (inv.currency ?? "").toUpperCase(), // "" = not surfaced — never defaulted to "usd"
    status: inv.status ?? "", // "" = unknown — never mislabeled "open"
    attempted: inv.attempted === true,
    attemptCount: inv.attempt_count ?? 0, // provider represents "no attempts" as 0
    hostedInvoiceUrl: inv.hosted_invoice_url ?? null,
    periodStartIso: inv.period_start ? new Date(inv.period_start * 1000).toISOString() : null,
    periodEndIso: inv.period_end ? new Date(inv.period_end * 1000).toISOString() : null,
    paidAtIso: inv.status_transitions?.paid_at ? new Date(inv.status_transitions.paid_at * 1000).toISOString() : null,
    createdEpoch: typeof inv.created === "number" ? inv.created : 0
  };
}

/* ---------------- Customers ---------------- */

export interface StripeCustomerLike {
  id: string;
  email?: string | null;
  name?: string | null;
  currency?: string | null;
  deleted?: boolean | null;
  created?: number | null;
}

export function normalizeCustomer(c: StripeCustomerLike): ProviderCustomer {
  return {
    id: c.id,
    email: c.email ?? null,
    name: c.name ?? null,
    currency: c.currency ?? null,
    deleted: c.deleted != null,
    createdEpoch: typeof c.created === "number" ? c.created : null
  };
}
