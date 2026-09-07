/**
 * REAL gateway over stripe-node (Phase 4A §8). Server-only: importing this
 * module from browser code fails the build via `server-only` (see index.ts)
 * and because nothing in the client graph references this package.
 *
 * Restricted key + read calls only. No write API exists in this file.
 */
import Stripe from "stripe";
import { classifyProviderError, ProviderError, type ProviderErrorCode } from "./errors.js";
import {
  normalizeSubscription, normalizeInvoice, normalizeCustomer,
  type StripeCustomerLike, type StripeInvoiceLike
} from "./normalize.js";
import type {
  Page, ProviderAccount, ProviderCustomer, ProviderInvoice,
  ProviderSubscription, StripeGateway, ListOptions
} from "./gateway.js";

/** Bounded in-gateway retry for TRANSIENT failures only (§19: retry when appropriate). */
const TRANSIENT_ATTEMPTS = 3;
const RETRY_BASE_MS = 500;

async function withTransientRetry<T>(op: () => Promise<T>, _what: string): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= TRANSIENT_ATTEMPTS; attempt++) {
    try {
      return await op();
    } catch (err) {
      lastErr = err;
      const mapped = classifyProviderError(err) as ProviderError;
      if (mapped.code !== "transient_network" || attempt === TRANSIENT_ATTEMPTS) throw mapped;
      await new Promise((r) => setTimeout(r, RETRY_BASE_MS * attempt));
    }
  }
  throw lastErr; // unreachable
}

function client(key: string): Stripe {
  // No apiVersion pin: restricted keys are version-independent for reads;
  // pinning arrives with webhook signature verification (Phase 4B).
  // maxNetworkRetries: 0 — transient retries are handled (and counted) at OUR
  // layer (withTransientRetry) so rate-limit/backoff policy stays explicit.
  return new Stripe(key, { timeout: 15000, maxNetworkRetries: 0, telemetry: false });
}

function accountMode(key: string): "test" | "live" {
  return key.startsWith("sk_test") || key.startsWith("rk_test") ? "test" : "live";
}

function page<T, R>(res: Stripe.ApiList<R>, map: (r: R) => T): Page<T> {
  // Provider pagination contract: data + has_more + starting_after cursor.
  const last = res.data.length > 0 ? res.data[res.data.length - 1] : null;
  return {
    data: res.data.map(map),
    hasMore: res.has_more,
    nextCursor: res.has_more && last ? (last as unknown as { id: string }).id : null
  };
}


function createdFilter(opts?: ListOptions): { gte?: number; gt?: number } | undefined {
  if (opts?.createdAfterEpoch) return { gt: opts.createdAfterEpoch };
  return undefined;
}

export const stripeGateway: StripeGateway = {
  async verifyAccount(key: string): Promise<ProviderAccount> {
    try {
      const s = client(key);
      // id=null ⇒ the account this RESTRICTED key belongs to (§7 identity).
      const acct = (await withTransientRetry(() => s.accounts.retrieve(null), "accounts.retrieve")) as unknown as Stripe.Account & { id: string };
      if (!acct?.id?.startsWith("acct_")) {
        throw Object.assign(new Error("unexpected account shape"), { type: "StripeInvalidRequestError" });
      }
      const business = acct.business_profile ?? null;
      return {
        id: acct.id,
        displayName: (acct.settings?.dashboard?.display_name ?? business?.name ?? null) || null,
        country: acct.country ?? null,
        defaultCurrency: acct.default_currency ?? null,
        mode: accountMode(key)
      };
    } catch (err) {
      throw classifyProviderError(err);
    }
  },

  async listCustomers(key: string, opts?: ListOptions): Promise<Page<ProviderCustomer>> {
    try {
      const s = client(key);
      const res = await withTransientRetry(() => s.customers.list({
        limit: Math.min(opts?.limit ?? 50, 100),
        starting_after: opts?.startingAfter ?? undefined,
        created: createdFilter(opts)
      }), "customers.list");
      return page(res, (c) => normalizeCustomer(c as unknown as StripeCustomerLike));
    } catch (err) {
      throw classifyProviderError(err);
    }
  },

  async listSubscriptions(key: string, opts?: ListOptions): Promise<Page<ProviderSubscription>> {
    try {
      const s = client(key);
      const res = await withTransientRetry(() => s.subscriptions.list({
        limit: Math.min(opts?.limit ?? 50, 100),
        starting_after: opts?.startingAfter ?? undefined,
        created: createdFilter(opts)
      }), "subscriptions.list");
      return page(res, normalizeSubscription);
    } catch (err) {
      throw classifyProviderError(err);
    }
  },

  async listInvoices(key: string, opts?: ListOptions): Promise<Page<ProviderInvoice>> {
    try {
      const s = client(key);
      const res = await withTransientRetry(() => s.invoices.list({
        limit: Math.min(opts?.limit ?? 50, 100),
        starting_after: opts?.startingAfter ?? undefined,
        created: createdFilter(opts)
      }), "invoices.list");
      return page(res, (inv) => normalizeInvoice(inv as unknown as StripeInvoiceLike));
    } catch (err) {
      throw classifyProviderError(err);
    }
  },

  async createWebhookEndpoint(key: string, opts: { url: string; eventTypes: string[] }): Promise<{ id: string; secret: string }> {
    try {
      const s = client(key);
      const ep = await s.webhookEndpoints.create({
        url: opts.url,
        enabled_events: opts.eventTypes as never,
        connect: false // this account's own events (restricted-key model)
      });
      return { id: ep.id, secret: ep.secret ?? "" };
    } catch (err) {
      throw classifyProviderError(err);
    }
  },

  async deleteWebhookEndpoint(key: string, endpointId: string): Promise<void> {
    try {
      const s = client(key);
      await s.webhookEndpoints.del(endpointId);
    } catch (err) {
      // Idempotent cleanup (4B correction): "already gone" = success, so a
      // retried lifecycle cleanup after a partial failure never corrupts.
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || /no such webhook endpoint/i.test(err instanceof Error ? err.message : "")) return;
      throw classifyProviderError(err);
    }
  },

  async payInvoice(key: string, opts: { invoiceId: string; idempotencyKey: string }): Promise<{
    invoiceStatus: string; paid: boolean; attempted: boolean;
    paymentIntentId: string | null; chargeId: string | null; attemptedCount: number;
  }> {
    try {
      const s = client(key);
      // THE payment operation. The idempotency key makes Stripe itself
      // replay-safe: the same key can never create a second charge, even if
      // REVESSENT crashes mid-request and retries (provider-side guarantee).
      const inv = await s.invoices.pay(opts.invoiceId, {
        idempotency_key: opts.idempotencyKey
      } as never);
      const invLike = inv as unknown as StripeInvoiceLike;
      const n = normalizeInvoice(invLike);
      return {
        invoiceStatus: invLike.status ?? "",
        paid: invLike.status === "paid",
        attempted: n.attempted,
        paymentIntentId: n.paymentIntentId,
        chargeId: n.chargeId,
        attemptedCount: n.attemptCount
      };
    } catch (err) {
      throw classifyPaymentError(err);
    }
  },

  async getInvoicePaymentStatus(key: string, invoiceId: string): Promise<{
    status: string; paid: boolean; attemptedCount: number; paymentIntentStatus: string | null;
  }> {
    try {
      const s = client(key);
      const inv = await s.invoices.retrieve(invoiceId);
      const invLike = inv as unknown as StripeInvoiceLike & {
        payment_intent?: { status?: string } | string | null;
      };
      const n = normalizeInvoice(invLike);
      const pi = invLike.payment_intent;
      return {
        status: invLike.status ?? "",
        paid: invLike.status === "paid",
        attemptedCount: n.attemptCount,
        paymentIntentStatus: typeof pi === "object" && pi ? pi.status ?? null : null
      };
    } catch (err) {
      throw classifyProviderError(err);
    }
  },

  async getInvoiceForExecution(key: string, invoiceId: string): Promise<{
    invoiceId: string; customerId: string | null;
    amountDue: number | null; amountRemaining: number | null;
    currency: string | null; status: string | null; attempted: boolean;
    hostedInvoiceUrl: string | null;
  }> {
    try {
      const s = client(key);
      const inv = await s.invoices.retrieve(invoiceId);
      const invLike = inv as unknown as StripeInvoiceLike & {
        amount_remaining?: number | null;
      };
      const hosted = typeof invLike.hosted_invoice_url === "string" ? invLike.hosted_invoice_url : null;
      // Explicit field mapping — a missing field stays null ("not
      // established"); nothing is defaulted, converted or normalized away
      // except the locale case of the currency code (compared against the
      // uppercase local execution currency).
      const cust = invLike.customer;
      return {
        invoiceId: invLike.id,
        customerId: typeof cust === "string" ? cust : cust && typeof cust === "object" ? cust.id ?? null : null,
        amountDue: typeof invLike.amount_due === "number" ? invLike.amount_due : null,
        amountRemaining: typeof invLike.amount_remaining === "number" ? invLike.amount_remaining : null,
        currency: invLike.currency ? String(invLike.currency).toUpperCase() : null,
        status: invLike.status ?? null,
        attempted: invLike.attempted === true,
        hostedInvoiceUrl: hosted
      };
    } catch (err) {
      throw classifyProviderError(err);
    }
  },

  async listWebhookEndpoints(key: string, opts: { urlContains?: string }): Promise<Array<{ id: string; url: string }>> {
    try {
      const s = client(key);
      const list = await s.webhookEndpoints.list({ limit: 100 });
      return list.data
        .filter((e) => !opts.urlContains || e.url.includes(opts.urlContains))
        .map((e) => ({ id: e.id, url: e.url }));
    } catch (err) {
      throw classifyProviderError(err);
    }
  }
};

/**
 * Payment-specific error classification (Phase 4C): EXTENDS the shared
 * provider taxonomy with Stripe's card_error semantics. Declines are
 * financial OUTCOMES, not system failures — they get their own codes and are
 * never auto-retried. Everything non-card falls through to the shared
 * classifier (invalid_credentials, rate_limited, transient_network, ...).
 */
export function classifyPaymentError(err: unknown): ProviderError {
  const e = err as { type?: string; code?: string; decline_code?: string; message?: string };
  if (e?.type === "StripeCardError" || e?.type === "card_error") {
    const decline = e.decline_code ?? e.code ?? null;
    const code: ProviderErrorCode =
      decline === "insufficient_funds" ? "insufficient_funds"
      : decline === "expired_card" ? "expired_card"
      : decline === "authentication_required" ? "authentication_required"
      : "card_declined";
    return new ProviderError(code);
  }
  if (e?.type === "StripeInvalidRequestError" || e?.type === "invalid_request_error") {
    const msg = e.message ?? "";
    if (/idempot/i.test(msg)) return new ProviderError("idempotency_conflict");
    return new ProviderError("invalid_payment_context");
  }
  return classifyProviderError(err);
}
