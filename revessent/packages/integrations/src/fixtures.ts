/**
 * Deterministic provider FIXTURES for integration tests (Phase 4A §22).
 * These emulate the provider's read APIs page-by-page so the boundary and
 * sync machinery can be tested without live credentials. They are TEST
 * scaffolding — never reachable from application runtime (only tests import
 * this file; production uses stripe-client.ts).
 */
import type {
  Page, ProviderAccount, ProviderCustomer, ProviderInvoice,
  ProviderSubscription, StripeGateway, ListOptions
} from "./gateway.js";
import { ProviderError, type ProviderErrorCode } from "./errors.js";

export interface FixtureCustomerRecord extends ProviderCustomer {
  /** epoch seconds, drives ordering + created-filter tests */
  created: number;
}

export interface FixtureSubscriptionRecord extends ProviderSubscription { created: number }
export interface FixtureInvoiceRecord extends ProviderInvoice { created: number }

export interface FailurePlan {
  /** Where the failure fires: entity + page index (0-based). "invoice_lookup"
   *  = the Phase 4C execution preflight (getInvoiceForExecution). */
  on?: "verify" | "customers" | "subscriptions" | "invoices" | "invoice_lookup";
  pageIndex?: number;
  kind: ProviderErrorCode;
  retryAfterSec?: number;
}

export interface FixtureWorld {
  account: ProviderAccount;
  customers: FixtureCustomerRecord[];
  subscriptions: FixtureSubscriptionRecord[];
  invoices: FixtureInvoiceRecord[];
  /** Page size the fixture gateway serves (tests pagination across pages). */
  pageSize?: number;
  failures?: FailurePlan[];
  /** Counter of provider calls per entity — assertions on request behavior. */
  calls?: {
    customers: number; subscriptions: number; invoices: number; verify: number;
    webhook_create?: number; webhook_delete?: number; webhook_list?: number; pay?: number; invoice_status?: number; invoice_lookup?: number;
  };
  /** 4B: registered webhook endpoints (shared across the fixture world set). */
  webhookEndpoints?: Array<{ id: string; secret: string; url: string; eventTypes: string[] }>;
  /** 4C: invoice payment execution behavior. */
  pay?: {
    /** 'ok' = pay succeeds (invoice becomes paid); 'decline:<code>' throws the
     *  mapped card outcome; 'network_loss_after_success' = the provider
     *  operation SUCCEEDS then the response is lost (§16 hard case);
     *  'ambiguous' = outcome cannot be established (§23 unknown). */
    behavior?: "ok" | `decline:${string}` | "network_loss_after_success" | "ambiguous" | "invalid_request" | "rate_limited" | "transient";
    /** Records idempotency keys → replay returns the SAME recorded result. */
    idempotentReplay?: boolean;
    /** Observation counter: REAL provider operations performed (≤1 per key). */
    operations?: string[];
  };
}

function paginate<T extends { id: string; created: number }>(
  rows: T[], opts: ListOptions | undefined, pageSize: number
): Page<T> {
  const sorted = [...rows].sort((a, b) => a.created - b.created || a.id.localeCompare(b.id));
  let start = 0;
  if (opts?.startingAfter) {
    const idx = sorted.findIndex((r) => r.id === opts.startingAfter);
    start = idx >= 0 ? idx + 1 : 0;
  }
  const slice = sorted.slice(start, start + pageSize);
  const nextStart = start + slice.length;
  return {
    data: slice,
    hasMore: nextStart < sorted.length,
    nextCursor: nextStart < sorted.length ? sorted[nextStart - 1]!.id : null
  };
}

function createdGt<T extends { created: number }>(rows: T[], opts?: ListOptions): T[] {
  return opts?.createdAfterEpoch ? rows.filter((r) => r.created > opts.createdAfterEpoch!) : rows;
}

/** Builds a gateway over the given fixture world, honoring the failure plan. */
function hash(input: string): number {
  let h = 0;
  for (let i = 0; i < input.length; i++) h = ((h << 5) - h + input.charCodeAt(i)) | 0;
  return h;
}

const worlds = new Set<FixtureWorld>();

export function fixtureGateway(world: FixtureWorld): StripeGateway {
  worlds.add(world);
  const pageSize = world.pageSize ?? 2; // small default so pagination is exercised
  const calls = world.calls ?? (world.calls = { customers: 0, subscriptions: 0, invoices: 0, verify: 0, webhook_create: 0, webhook_delete: 0 });
  const pageCounter = { customers: 0, subscriptions: 0, invoices: 0 };

  function maybeFail(entity: "verify" | "customers" | "subscriptions" | "invoices" | "webhook_create" | "webhook_delete" | "pay" | "invoice_status" | "invoice_lookup"): void {
    const plan = world.failures?.find((f) => f.on === entity);
    if (!plan) return;
    const keyed = entity as keyof typeof pageCounter | "verify" | "webhook_create" | "webhook_delete" | "invoice_lookup";
    if (entity === "verify" || entity === "webhook_create" || entity === "webhook_delete"
      || entity === "invoice_lookup"
      || ((keyed in pageCounter) && (plan.pageIndex ?? 0) === pageCounter[entity as keyof typeof pageCounter])) {
      throw new ProviderError(plan.kind, { retryAfterSec: plan.retryAfterSec ?? null });
    }
  }

  return {
    async verifyAccount(_key: string): Promise<ProviderAccount> {
      calls.verify++;
      maybeFail("verify");
      return world.account;
    },
    async listCustomers(_key: string, opts?: ListOptions): Promise<Page<ProviderCustomer>> {
      calls.customers++;
      maybeFail("customers");
      pageCounter.customers++;
      return paginate(createdGt(world.customers, opts), opts, pageSize);
    },
    async listSubscriptions(_key: string, opts?: ListOptions): Promise<Page<ProviderSubscription>> {
      calls.subscriptions++;
      maybeFail("subscriptions");
      pageCounter.subscriptions++;
      return paginate(createdGt(world.subscriptions, opts), opts, pageSize);
    },
    async listInvoices(_key: string, opts?: ListOptions): Promise<Page<ProviderInvoice>> {
      calls.invoices++;
      maybeFail("invoices");
      pageCounter.invoices++;
      return paginate(createdGt(world.invoices, opts), opts, pageSize);
    },

    async createWebhookEndpoint(_key: string, opts: { url: string; eventTypes: string[] }): Promise<{ id: string; secret: string }> {
      calls.webhook_create = (calls.webhook_create ?? 0) + 1;
      maybeFail("webhook_create");
      let seq = 0;
      for (const w of worlds.values()) {
        for (const ep of w.webhookEndpoints ?? []) seq = Math.max(seq, Number(ep.id.replace(/[^0-9]/g, "")) || 0);
      }
      const id = `we_fixture_${String(seq + 1).padStart(3, "0")}`;
      const secret = `whsec_fixture_${id}_${Math.abs(hash(String(seq + 1))).toString(36)}`;
      const endpoint = { id, secret, url: opts.url, eventTypes: [...opts.eventTypes] };
      for (const w of worlds.values()) (w.webhookEndpoints ??= []).push({ ...endpoint });
      return { id, secret };
    },

    async deleteWebhookEndpoint(_key: string, endpointId: string): Promise<void> {
      calls.webhook_delete = (calls.webhook_delete ?? 0) + 1;
      maybeFail("webhook_delete");
      for (const w of worlds.values()) {
        w.webhookEndpoints = (w.webhookEndpoints ?? []).filter((e) => e.id !== endpointId);
      }
    },

    async payInvoice(key: string, opts: { invoiceId: string; idempotencyKey: string }): Promise<{
      invoiceStatus: string; paid: boolean; attempted: boolean;
      paymentIntentId: string | null; chargeId: string | null; attemptedCount: number;
    }> {
      calls.pay = (calls.pay ?? 0) + 1;
      const pay = world.pay ?? {};
      // PROVIDER-IDEMPOTENCY REPLAY: the same key can NEVER create a second
      // operation — the recorded result of the first operation is returned.
      if (pay.idempotentReplay !== false && pay.operations?.includes(opts.idempotencyKey)) {
        const inv = world.invoices.find((i) => i.id === opts.invoiceId);
        return {
          invoiceStatus: inv && "paid" in inv && (inv as { paid?: boolean }).paid ? "paid" : "open",
          paid: Boolean(inv && "paid" in inv && (inv as { paid?: boolean }).paid),
          attempted: true, paymentIntentId: `pi_replay_${opts.idempotencyKey.slice(-8)}`,
          chargeId: null, attemptedCount: 1
        };
      }
      pay.operations = pay.operations ?? [];
      pay.operations.push(opts.idempotencyKey);
      const behavior = pay.behavior ?? "ok";

      const declineCode = behavior.startsWith("decline:") ? behavior.slice("decline:".length) : null;
      if (declineCode) {
        const code = declineCode === "insufficient_funds" ? "insufficient_funds"
          : declineCode === "expired_card" ? "expired_card"
          : declineCode === "authentication_required" ? "authentication_required"
          : "card_declined";
        throw new ProviderError(code as never);
      }
      if (behavior === "invalid_request") throw new ProviderError("invalid_payment_context");
      if (behavior === "rate_limited") throw new ProviderError("rate_limited", { retryAfterSec: 5 });
      if (behavior === "transient") throw new ProviderError("transient_network");
      if (behavior === "ambiguous") throw new ProviderError("transient_network");

      // The provider operation SUCCEEDS: the world's invoice becomes paid
      // (so list-based sync / reconciliation can discover the truth).
      const inv = world.invoices.find((i) => i.id === opts.invoiceId) as unknown as
        | (FixtureInvoiceRecord & { paid?: boolean; status?: string })
        | undefined;
      if (inv) {
        (inv as { status?: string }).status = "paid";
        (inv as { paid?: boolean }).paid = true;
      }
      if (behavior === "network_loss_after_success") {
        // Response lost — REVESSENT cannot know the operation succeeded (§16).
        throw new ProviderError("transient_network");
      }
      return {
        invoiceStatus: "paid", paid: true, attempted: true,
        paymentIntentId: `pi_${opts.idempotencyKey.slice(-12)}`,
        chargeId: `ch_${opts.idempotencyKey.slice(-12)}`,
        attemptedCount: (inv?.attemptCount ?? 0) + 1
      };
    },

    async getInvoiceForExecution(_key: string, invoiceId: string): Promise<{
      invoiceId: string; customerId: string | null;
      amountDue: number | null; amountRemaining: number | null;
      currency: string | null; status: string | null; attempted: boolean;
    }> {
      calls.invoice_lookup = (calls.invoice_lookup ?? 0) + 1;
      maybeFail("invoice_lookup");
      const inv = world.invoices.find((i) => i.id === invoiceId);
      if (!inv) throw new ProviderError("invalid_payment_context");
      // Verbatim world truth — missing fields stay null (never defaulted).
      return {
        invoiceId: inv.id,
        customerId: inv.customerId ?? null,
        amountDue: typeof inv.amountMinor === "number" ? inv.amountMinor : null,
        amountRemaining: typeof inv.amountMinor === "number" ? inv.amountMinor : null,
        currency: inv.currency ? String(inv.currency).toUpperCase() : null,
        status: inv.status ?? null,
        attempted: inv.attempted === true
      };
    },

    async getInvoicePaymentStatus(_key: string, invoiceId: string): Promise<{
      status: string; paid: boolean; attemptedCount: number; paymentIntentStatus: string | null;
    }> {
      calls.invoice_status = (calls.invoice_status ?? 0) + 1;
      const inv = world.invoices.find((i) => i.id === invoiceId) as unknown as
        | (FixtureInvoiceRecord & { paid?: boolean; status?: string })
        | undefined;
      if (!inv) throw new ProviderError("invalid_payment_context");
      const paid = (inv as { paid?: boolean }).paid === true;
      const status = paid ? "paid" : (inv.status === "" ? "open" : inv.status);
      return {
        status, paid, attemptedCount: inv.attemptCount,
        // An unpaid invoice whose payment intent is not in flight ⇒ no
        // provider operation is pending (safe-to-retry signal, §18).
        paymentIntentStatus: paid ? "succeeded" : null
      };
    },

    async listWebhookEndpoints(_key: string, opts: { urlContains?: string }): Promise<Array<{ id: string; url: string }>> {
      calls.webhook_list = (calls.webhook_list ?? 0) + 1;
      const seen = new Map<string, { id: string; url: string }>();
      for (const w of worlds.values()) {
        for (const e of w.webhookEndpoints ?? []) {
          if (!seen.has(e.id)) seen.set(e.id, { id: e.id, url: e.url });
        }
      }
      return [...seen.values()].filter((e) => !opts.urlContains || e.url.includes(opts.urlContains));
    }
  };
}

/** Test isolation: forget all registered fixture worlds (endpoints included). */
export function resetFixtureWorlds(): void {
  worlds.clear();
}

/* ---------- fixture builders (Stripe-shaped, integer minor units) ---------- */

export function fixtureAccount(overrides?: Partial<ProviderAccount>): ProviderAccount {
  return {
    id: "acct_TESTACCT0123456789",
    displayName: "Acorn Books Ltd",
    country: "US",
    defaultCurrency: "usd",
    mode: "test",
    ...overrides
  };
}

export function fixtureCustomer(i: number, overrides?: Partial<FixtureCustomerRecord>): FixtureCustomerRecord {
  return {
    id: `cus_fixture_${String(i).padStart(3, "0")}`,
    email: `cust${i}@example.test`,
    name: `Fixture Customer ${i}`,
    currency: "usd",
    deleted: false,
    createdEpoch: 1_700_000_000 + i * 3600,
    created: 1_700_000_000 + i * 3600,
    ...overrides
  };
}

export function fixtureSubscription(i: number, customerId: string, overrides?: Partial<FixtureSubscriptionRecord>): FixtureSubscriptionRecord {
  return {
    id: `sub_fixture_${String(i).padStart(3, "0")}`,
    customerId,
    priceId: `price_fixture_${i}`,
    status: "active",
    amountMinor: 1900 + i * 100,
    currency: "USD",
    interval: "month",
    itemCount: 1,
    cancelAtPeriodEnd: false,
    canceledAtIso: null,
    currentPeriodEndIso: new Date((1_700_000_000 + i * 3600 + 30 * 86400) * 1000).toISOString(),
    createdEpoch: 1_700_000_000 + i * 3600,
    created: 1_700_000_000 + i * 3600,
    ...overrides
  };
}

export function fixtureInvoice(i: number, customerId: string, overrides?: Partial<FixtureInvoiceRecord>): FixtureInvoiceRecord {
  return {
    id: `in_fixture_${String(i).padStart(3, "0")}`,
    customerId,
    subscriptionId: null,
    paymentIntentId: `pi_fixture_${i}`,
    chargeId: `ch_fixture_${i}`,
    amountMinor: 1900,
    currency: "USD",
    status: i % 3 === 0 ? "paid" : i % 3 === 1 ? "open" : "uncollectible",
    attempted: true,
    attemptCount: 1 + (i % 2),
    hostedInvoiceUrl: `https://invoice.example.test/${i}`,
    periodStartIso: new Date((1_700_000_000 + i * 3600) * 1000).toISOString(),
    periodEndIso: new Date((1_700_000_000 + i * 3600 + 30 * 86400) * 1000).toISOString(),
    paidAtIso: i % 3 === 0 ? new Date((1_700_000_100 + i * 3600) * 1000).toISOString() : null,
    createdEpoch: 1_700_000_500 + i * 3600,
    created: 1_700_000_500 + i * 3600,
    ...overrides
  };
}
