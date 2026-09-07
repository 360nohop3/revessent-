/**
 * STRIPE GATEWAY — the domain-appropriate READ-ONLY surface (Phase 4A §8).
 *
 * Services see THIS interface, never the Stripe SDK. There is no write
 * operation anywhere in Phase 4A: no charge, retry, capture, refund,
 * payment-method mutation, or subscription change can even be expressed.
 * (Phase 1 §8.2: restricted key, read-only first.)
 */

/** Safe provider account identity (§7) — no secrets can be expressed here. */
export interface ProviderAccount {
  /** acct_… — proves which merchant account the key belongs to. */
  id: string;
  /** Business/display name when the account exposes one. */
  displayName: string | null;
  /** Two-letter country, when available. */
  country: string | null;
  /** Three-letter default currency, when available. */
  defaultCurrency: string | null;
  /** "test" | "live" — derived from the key prefix, never from provider data. */
  mode: "test" | "live";
}

export interface Page<T> {
  data: T[];
  /** True when the provider has more results after this page. */
  hasMore: boolean;
  /** Opaque provider cursor (starting_after) for the next page. */
  nextCursor: string | null;
}

export interface ListOptions {
  /** Provider cursor from a previous page. */
  startingAfter?: string | null;
  /** Page size (≤ 100 — provider maximum). */
  limit?: number;
  /** Incremental sync: only objects created strictly after this epoch-second. */
  createdAfterEpoch?: number | null;
}

/** Normalized provider customer. Provider statuses/IDs kept verbatim. */
export interface ProviderCustomer {
  id: string;                 // cus_…
  email: string | null;
  name: string | null;
  currency: string | null;    // three-letter
  deleted: boolean;           // provider deletion flag (§ test: provider deletion)
  createdEpoch: number | null;
}

/** Normalized provider subscription (Phase 1 read model). */
export interface ProviderSubscription {
  id: string;                 // sub_…
  customerId: string;         // cus_… (must exist as a customer record)
  priceId: string;            // price_…
  /** Stripe subscription status, VERBATIM (Stripe is the authority). */
  status: string;
  /** Unit amount of the first item, integer minor units. null = the provider
   *  did not surface one (tiered price) — UNKNOWN, never defaulted to 0. */
  amountMinor: number | null;
  /** Uppercase ISO currency from the provider; "" = not surfaced (never defaulted). */
  currency: string;
  /** Supported cadence model (Phase 4A): month | year ONLY. Any other
   *  provider interval (day, week, missing recurring) → "unsupported" —
   *  NEVER reinterpreted, and excluded from MRR upstream with an anomaly. */
  interval: "month" | "year" | "unsupported";
  /** Number of provider items on the subscription. Phase 4A prices the FIRST
   *  item only; >1 surfaces an explicit anomaly upstream (documented
   *  limitation — not total subscription revenue). */
  itemCount: number;
  cancelAtPeriodEnd: boolean;
  canceledAtIso: string | null;
  currentPeriodEndIso: string | null;
  createdEpoch: number;
}

/** Normalized provider invoice = one payment record (Phase 1 §5.2 payments). */
export interface ProviderInvoice {
  id: string;                       // in_…
  customerId: string | null;        // cus_… (may be null for deleted customers)
  subscriptionId: string | null;    // sub_…
  paymentIntentId: string | null;
  chargeId: string | null;
  /** amount_due while open; amount_paid when paid — integer minor units. */
  amountMinor: number;
  currency: string;
  /** Stripe invoice status verbatim: draft|open|paid|void|uncollectible. */
  status: string;
  attempted: boolean;
  attemptCount: number;
  hostedInvoiceUrl: string | null;
  periodStartIso: string | null;
  periodEndIso: string | null;
  paidAtIso: string | null;
  createdEpoch: number;
}

export interface StripeGateway {
  /** Harmless read-only validation: account identity for the key (§6 step 4/5). */
  verifyAccount(key: string): Promise<ProviderAccount>;
  listCustomers(key: string, opts?: ListOptions): Promise<Page<ProviderCustomer>>;
  listSubscriptions(key: string, opts?: ListOptions): Promise<Page<ProviderSubscription>>;
  listInvoices(key: string, opts?: ListOptions): Promise<Page<ProviderInvoice>>;
  /** Phase 4B §8.2: self-register the per-connection webhook endpoint.
   *  Configuration only — never a financial call. Requires the key to carry
   *  the Webhook Endpoints permission; otherwise a permission_failure. */
  /**
   * Phase 4C — the ONE provider-side payment operation: pay a failed/open
   * invoice with its default payment method (Stripe `invoices.pay`). The
   * idempotency key MUST be derived from the durable execution identity.
   * Card outcomes throw ProviderError with the payment-outcome codes.
   * Configuration of financial truth: the returned invoice snapshot is the
   * immediate provider response — webhooks remain authoritative for final state.
   */
  payInvoice(key: string, opts: { invoiceId: string; idempotencyKey: string }): Promise<{
    invoiceStatus: string; paid: boolean; attempted: boolean;
    paymentIntentId: string | null; chargeId: string | null; attemptedCount: number;
  }>;
  /** Read-only provider lookup used to resolve UNKNOWN execution outcomes
   *  (Phase 4C §16/§18) — never a payment operation. */
  getInvoicePaymentStatus(key: string, invoiceId: string): Promise<{
    status: string; paid: boolean; attemptedCount: number;
    paymentIntentStatus: string | null;
  }>;
  /** Phase 4C CORRECTION — read-only PRE-FLIGHT for a NEW payment execution:
   *  the CURRENT provider invoice truth, exposing ONLY the fields needed to
   *  verify it against the local financial authority before `invoices.pay`.
   *  Stripe collects according to the provider invoice, so the local amount
   *  alone does not constrain the charge — every field below is compared
   *  server-side (customer, currency, amount, payable state) and any
   *  mismatch refuses execution with ZERO payment/mutation calls. `null`
   *  always means "not established by the provider" — never defaulted.
   *  Server-side only; never a raw provider object; never the frontend. */
  getInvoiceForExecution(key: string, invoiceId: string): Promise<{
    invoiceId: string;
    /** invoice.customer — the provider-side owner of the debt. */
    customerId: string | null;
    /** amount_due — the invoice's final due amount. */
    amountDue: number | null;
    /** amount_remaining — what a NEW payment on this invoice would collect
     *  (the authoritative payable amount for `invoices.pay`). */
    amountRemaining: number | null;
    /** Uppercase ISO currency as reported by the provider; null = missing. */
    currency: string | null;
    /** Verbatim provider invoice status; null = missing. */
    status: string | null;
    attempted: boolean;
  }>;
  createWebhookEndpoint(key: string, opts: { url: string; eventTypes: string[] }): Promise<{ id: string; secret: string }>;
  /** Idempotent: deleting an endpoint that is already gone succeeds (the
   *  provider/local lifecycle cannot share a transaction — cleanup retries
   *  must be safe, 4B correction). */
  deleteWebhookEndpoint(key: string, endpointId: string): Promise<void>;
  /** Read-only discovery of OUR webhook endpoints (lifecycle reconciliation:
   *  locating an endpoint whose creation crashed before it could be recorded).
   *  Configuration reads only — never a financial call. */
  listWebhookEndpoints(key: string, opts: { urlContains?: string }): Promise<Array<{ id: string; url: string }>>;
}
