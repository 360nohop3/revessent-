/**
 * STRIPE WEBHOOK VERIFICATION + EVENT DESCRIPTION (Phase 4B §10.3).
 *
 * Verification uses Stripe's OFFICIAL mechanism (`Stripe.webhooks.constructEventAsync`)
 * against the RAW request body — never a re-serialized representation. Replay
 * tolerance: 5 minutes (architecture §7.5). No custom cryptography.
 *
 * Server-only discipline is inherited from the package entry (`server-only`).
 */
import Stripe from "stripe";
import type { ProviderInvoice, ProviderCustomer, ProviderSubscription } from "./gateway.js";
import { normalizeInvoice, normalizeCustomer, normalizeSubscription, type StripeInvoiceLike, type StripeCustomerLike, type StripeSubscriptionLike } from "./normalize.js";

/** Architecture replay window (§7.5): 5 minutes. */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

/**
 * TEST-SIDE counterpart to {@link verifyStripeWebhook}: generates a valid
 * Stripe-Signature header with the OFFICIAL SDK helper (the same crypto the
 * verify path trusts). Never used by production code paths.
 */
export async function generateTestSignatureHeader(input: {
  payload: string; secret: string; timestampSeconds?: number;
}): Promise<string> {
  const { default: Stripe } = await import("stripe");
  return Stripe.webhooks.generateTestHeaderString({
    payload: input.payload, secret: input.secret,
    timestamp: input.timestampSeconds
  });
}

export type WebhookVerifyCode =
  | "missing_signature"
  | "malformed_signature"
  | "invalid_signature"
  | "stale_timestamp"
  | "malformed_payload";

export interface StripeWebhookEvent {
  id: string;
  type: string;
  /** The Stripe account the event concerns, when the payload carries one. */
  account: string | null;
  livemode: boolean;
  /** Event creation time (provider sequencing — ordering guard input). */
  createdEpoch: number;
  /** The provider object this event concerns. */
  objectType: "customer" | "subscription" | "invoice" | "charge" | "payment_method" | "account" | "other";
  objectId: string | null;
  /** Raw provider payload (persisted for audit/replay; contains no secrets). */
  payload: unknown;
  /** Normalized views (provider-truth, 4A discipline). */
  customer: (() => ProviderCustomer) | null;
  subscription: (() => ProviderSubscription) | null;
  invoice: (() => ProviderInvoice) | null;
}

/**
 * Official signature verification. Returns a discriminated result so routes
 * can emit safe problem+json without ever echoing provider internals.
 */
export async function verifyStripeWebhook(
  rawBody: string, sigHeader: string | null, secret: string,
  toleranceSeconds: number = WEBHOOK_TOLERANCE_SECONDS
): Promise<{ ok: true; event: StripeWebhookEvent } | { ok: false; code: WebhookVerifyCode; safeMessage: string }> {
  if (!sigHeader) {
    return { ok: false, code: "missing_signature", safeMessage: "Missing Stripe-Signature header." };
  }
  let event: Stripe.Event;
  try {
    event = await Stripe.webhooks.constructEventAsync(rawBody, sigHeader, secret, toleranceSeconds);
  } catch (err) {
    const message = err instanceof Error ? err.message : "";
    // Classify via the OFFICIAL SDK's error types only — never custom crypto.
    if (err instanceof Stripe.errors.StripeSignatureVerificationError) {
      if (/timestamp/i.test(message) && /tolerance/i.test(message)) {
        return { ok: false, code: "stale_timestamp", safeMessage: "Event timestamp outside the accepted replay window." };
      }
      return { ok: false, code: "invalid_signature", safeMessage: "Signature verification failed." };
    }
    if (message.startsWith("Unexpected token") || /JSON/i.test(message)) {
      return { ok: false, code: "malformed_payload", safeMessage: "Malformed webhook payload." };
    }
    // "Unable to extract timestamp and signatures from header" etc.
    return { ok: false, code: "malformed_signature", safeMessage: "Malformed Stripe-Signature header." };
  }
  return { ok: true, event: describeStripeEvent(event) };
}

function objectTypeOf(type: string): StripeWebhookEvent["objectType"] {
  if (type.startsWith("customer.subscription")) return "subscription";
  if (type.startsWith("customer.")) return "customer";
  if (type.startsWith("invoice.")) return "invoice";
  if (type.startsWith("charge.")) return "charge";
  if (type.startsWith("payment_method.")) return "payment_method";
  if (type.startsWith("account.")) return "account";
  return "other";
}

function objectIdOf(event: Stripe.Event): string | null {
  const obj = event.data?.object as { id?: string; object?: string } | undefined;
  if (!obj?.id || !obj?.object) return null;
  // Guard against a payload whose object kind contradicts the event type.
  const expected: Record<string, string> = {
    customer: "customer", subscription: "subscription", invoice: "invoice", charge: "charge"
  };
  const wanted = expected[objectTypeOf(event.type)];
  if (wanted && obj.object !== wanted) return null;
  return obj.id;
}

export function describeStripeEvent(event: Stripe.Event): StripeWebhookEvent {
  const object = event.data?.object as unknown as Record<string, unknown> | undefined;
  // Object-kind guard: accessors exist only when data.object is genuinely a
  // provider OBJECT — a malformed payload yields null, never invented state.
  const isObject = object !== null && typeof object === "object"
    && !Array.isArray(object) && typeof object.id === "string";
  const type = event.type;
  return {
    id: event.id,
    type,
    account: typeof event.account === "string" ? event.account : null,
    livemode: event.livemode === true,
    createdEpoch: event.created,
    objectType: objectTypeOf(type),
    objectId: objectIdOf(event),
    payload: event as unknown as Record<string, unknown>, // FULL raw event — durable provenance
    customer: isObject && type.startsWith("customer.") && !type.startsWith("customer.subscription")
      ? () => normalizeCustomer(object as unknown as StripeCustomerLike)
      : null,
    subscription: isObject && type.startsWith("customer.subscription")
      ? () => normalizeSubscription(object as unknown as StripeSubscriptionLike)
      : null,
    invoice: isObject && type.startsWith("invoice.")
      ? () => normalizeInvoice(object as unknown as StripeInvoiceLike)
      : null
  };
}

