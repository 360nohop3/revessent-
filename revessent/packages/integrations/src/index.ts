/**
 * SERVER-ONLY Stripe integration boundary (Phase 4A §8).
 *
 * `import "server-only"` makes it a BUILD ERROR for any client component to
 * reach this module through the React graph. Nothing in apps/web imports
 * this package; only @revessent/server services do.
 *
 * Exposed surface = the read-only gateway + safe error taxonomy. The Stripe
 * SDK, credentials and raw provider errors never leave this package.
 */
import "server-only";

import { stripeGateway } from "./stripe-client.js";
import type { StripeGateway } from "./gateway.js";

export type { StripeGateway, ProviderAccount, Page, ProviderCustomer, ProviderSubscription, ProviderInvoice, ListOptions } from "./gateway.js";
export { ProviderError, classifyProviderError, isProviderError } from "./errors.js";
export { normalizeSubscription, normalizeInvoice, normalizeCustomer, type StripeSubscriptionLike, type StripeInvoiceLike, type StripeCustomerLike } from "./normalize.js";
export {
  verifyStripeWebhook, describeStripeEvent, WEBHOOK_TOLERANCE_SECONDS, generateTestSignatureHeader,
  type StripeWebhookEvent, type WebhookVerifyCode
} from "./webhook.js";
export type { ProviderErrorCode } from "./errors.js";
export {
  EmailProviderError, isEmailProviderError, assertSafeHeaderValue, assertSafeOutboundEmail,
  type EmailProvider, type OutboundEmail, type EmailSendResult, type EmailFailureKind, type EmailErrorCode
} from "./email.js";

const realGateway: StripeGateway = stripeGateway;
let active: StripeGateway = realGateway;

/** The gateway used by services (real stripe-node). */
export function getStripeGateway(): StripeGateway {
  return active;
}

/**
 * TEST-ONLY injection point: integration tests drive the boundary with
 * deterministic provider FIXTURES (§22 — live credentials unavailable in
 * this environment; the live success path is marked as such in the report).
 * Never call this from application code.
 */
export function setStripeGatewayForTests(gateway: StripeGateway): void {
  active = gateway;
}

/** TEST-ONLY: restore the real stripe-node gateway. */
export function resetStripeGateway(): void {
  active = realGateway;
}

/* ---------------- Phase 6: email provider (server-only) ---------------- */
import { postmarkProvider } from "./email-postmark.js";
export { postmarkProvider };
import type { EmailProvider } from "./email.js";

let activeEmail: EmailProvider | null | undefined;

/**
 * The configured email provider, or null when none is configured. A null
 * provider means deliveries fail SAFELY as `not_configured` (transient) —
 * nothing is fabricated as sent. The token is read from env here only.
 */
export function getEmailProvider(): EmailProvider | null {
  if (activeEmail !== undefined) return activeEmail;
  const token = process.env.POSTMARK_SERVER_TOKEN;
  activeEmail = token && token.length > 10
    ? postmarkProvider({ serverToken: token, messageStream: process.env.POSTMARK_MESSAGE_STREAM })
    : null;
  return activeEmail;
}

/** TEST-ONLY injection point (mirrors setStripeGatewayForTests). */
export function setEmailProviderForTests(provider: EmailProvider | null): void {
  activeEmail = provider;
}

/** TEST-ONLY: forget the injected provider. */
export function resetEmailProvider(): void {
  activeEmail = undefined;
}
