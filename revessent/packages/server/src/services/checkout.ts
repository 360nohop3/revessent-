/**
 * Public member checkout contract — /c/{token} (§6.2 J4, §7.2, §8.6).
 * Tokens: 128-bit random, SHA-256 stored, 14-day expiry. No session needed;
 * scope is the single case.
 *
 * PHASE 8 CORRECTION — HOSTED RECOVERY CHECKOUT (B-2 decision: Stripe's
 * hosted invoice page for the SAME open invoice).
 *
 *   /c/{token}  →  POST start  →  302-style hand-off to Stripe's own hosted
 *   page for the exact provider invoice behind the case  →  customer pays on
 *   Stripe  →  `invoice.paid` webhook / sync / reconciliation (Phase 4A/4B
 *   truth path)  →  payments.status = paid  →  case = recovered (source
 *   `checkout`) + attribution.
 *
 * Financial boundary (mandatory):
 *   · This is NOT a payment execution path. REVESSENT never charges here,
 *     never supplies an amount/currency/customer to the provider, never
 *     builds a payment URL. The ONLY provider call is the existing read-only
 *     4C preflight (`getInvoiceForExecution`) and the ONLY thing handed to the
 *     browser is the provider's own `hosted_invoice_url` for that invoice.
 *   · Before the hand-off the provider invoice is verified against the local
 *     financial authority with the SAME rules as Phase 4C execution
 *     (`providerInvoiceFault`: customer identity, currency, amount, payable
 *     state). Any mismatch → honest refusal, no URL.
 *   · The browser is never authoritative: `success` redirects mark nothing.
 *     Completion happens ONLY when provider truth marks the payment paid
 *     (`applyCheckoutCompletion` is invoked from the single invoice-apply
 *     choke point every truth path shares).
 *   · Idempotent by construction: the durable identity is (case, invoice).
 *     Stripe hosts exactly one page per invoice, so double-click / refresh /
 *     multi-tab / revisit all converge on the same page and Stripe's invoice
 *     state machine forbids paying an invoice twice.
 */
import { createHash, randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import * as schema from "@revessent/db";
import { withOrgTx, type Db } from "@revessent/db";
import type { RecoveryTokenInfo, RecoveryCheckoutStart } from "@revessent/contracts";
import { ProviderError, getStripeGateway, isProviderError } from "@revessent/integrations";
import { TERMINAL_CASE_STATUSES } from "@revessent/domain";
import { ProblemError } from "../http/problems.js";
import { audit } from "./audit.js";
import { decryptConnectionKey } from "./settings.js";
import { providerInvoiceFault } from "./execute.js";

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Only the provider's own hosted-invoice origin is ever handed to a browser. */
const HOSTED_INVOICE_URL_RE = /^https:\/\/invoice\.stripe\.com\//;

/**
 * Single-transaction token flow: hash-GUC first (admitting only the matched
 * checkout), then token_flow=1 for the dependent reads — all RLS-bound.
 */
async function tokenFlow<T>(db: Db, token: string, fn: (tx: Db) => Promise<T>): Promise<T | null> {
  const tokenHash = hashToken(token);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.checkout_token_hash', ${tokenHash}, true)`);
    const [checkout] = await tx.select().from(schema.recoveryCheckouts).where(eq(schema.recoveryCheckouts.tokenHash, tokenHash));
    if (!checkout) return null;
    await tx.execute(sql`select set_config('app.token_flow', '1', true)`);
    return fn(tx as unknown as Db);
  });
}

type CheckoutRow = typeof schema.recoveryCheckouts.$inferSelect;

function linkState(checkout: CheckoutRow): "valid" | "expired" | "used" {
  return checkout.status === "completed" ? "used"
    : checkout.status === "disabled" || checkout.status === "expired" || checkout.expiresAt.getTime() < Date.now() ? "expired"
    : "valid";
}

export async function tokenInfo(db: Db, token: string): Promise<RecoveryTokenInfo> {
  const unknown: RecoveryTokenInfo = { state: "unknown", orgName: null, productName: null, amount: null, cardLast4: null, expiresAt: null };
  return (await tokenFlow(db, token, async (tx) => {
    const [checkout] = await tx.select().from(schema.recoveryCheckouts).where(eq(schema.recoveryCheckouts.tokenHash, hashToken(token)));
    const [row] = await tx.select({ case: schema.recoveryCases, org: schema.organizations, customer: schema.customers })
      .from(schema.recoveryCases)
      .innerJoin(schema.organizations, eq(schema.recoveryCases.orgId, schema.organizations.id))
      .innerJoin(schema.customers, eq(schema.recoveryCases.customerId, schema.customers.id))
      .where(eq(schema.recoveryCases.id, checkout!.caseId));
    if (!row) return unknown;
    const [payment] = await tx.select().from(schema.payments).where(eq(schema.payments.id, row.case.paymentId));
    // Local paid truth (from provider, via 4A/4B) or a recovered case → the
    // link is "used": nothing more to pay, even if the checkout row itself
    // has not yet been flipped (the flip follows provider truth, never the
    // other way round).
    const state = payment?.status === "paid" || row.case.status === "recovered" ? "used" : linkState(checkout!);
    return {
      state,
      orgName: row.org.name,
      productName: row.case.subscriptionId ? "subscription" : "invoice",
      amount: { minor: row.case.amountCents, currency: row.case.currency },
      cardLast4: (row.customer.defaultPayment as { last4?: string } | null)?.last4 ?? null,
      expiresAt: checkout!.expiresAt.toISOString()
    };
  })) ?? unknown;
}

/* ------------------------------------------------------------------ */
/*  START: hand the member to Stripe's hosted page for THIS invoice    */
/* ------------------------------------------------------------------ */

type Resolved = {
  checkout: CheckoutRow;
  orgId: string; caseId: string; caseStatus: string;
  payment: typeof schema.payments.$inferSelect;
  customerStripeId: string | null;
};

/**
 * Member action from /c/{token}: verifies the link, the local case/payment
 * state and the CURRENT provider invoice, then returns Stripe's hosted page
 * for that exact invoice. Every refusal is an explicit, honest state — no
 * URL is ever returned on a refusal, and nothing is ever charged here.
 */
export async function startCheckout(
  db: Db, token: string, meta: { ip?: string | null; userAgent?: string | null } = {}
): Promise<RecoveryCheckoutStart> {
  // 1. Token flow (RLS-bound) — resolve everything server-side. The browser
  //    supplied ONLY the token; no ids, amounts or provider refs are accepted.
  const resolved = await tokenFlow(db, token, async (tx): Promise<Resolved | null> => {
    const [checkout] = await tx.select().from(schema.recoveryCheckouts).where(eq(schema.recoveryCheckouts.tokenHash, hashToken(token)));
    if (!checkout) return null;
    const [c] = await tx.select().from(schema.recoveryCases).where(eq(schema.recoveryCases.id, checkout.caseId));
    if (!c) return null;
    const [payment] = await tx.select().from(schema.payments).where(eq(schema.payments.id, c.paymentId));
    if (!payment) return null;
    const [customer] = await tx.select({ stripeCustomerId: schema.customers.stripeCustomerId })
      .from(schema.customers).where(eq(schema.customers.id, c.customerId));
    return {
      checkout, orgId: c.orgId, caseId: c.id, caseStatus: c.status, payment,
      customerStripeId: customer?.stripeCustomerId ?? null
    };
  });
  if (!resolved) return { state: "unknown" };
  const { checkout, orgId, caseId, payment } = resolved;

  const refuse = async (state: RecoveryCheckoutStart["state"], reason: string): Promise<RecoveryCheckoutStart> => {
    await withOrgTx(db, orgId, (tx) => audit(tx as unknown as Db, {
      orgId, actorId: "customer", actorKind: "system", action: "checkout.start_refused",
      targetType: "recovery_checkout", targetId: checkout.id,
      diff: { reason, caseId }, ip: meta.ip, userAgent: meta.userAgent
    }));
    return { state };
  };

  // 2. Local gates (cheap, authoritative for what is local).
  if (payment.status === "paid" || resolved.caseStatus === "recovered") return refuse("already_paid", payment.status === "paid" ? "payment_already_paid" : "case_already_recovered");
  if (linkState(checkout) !== "valid") return refuse("expired", `link_${linkState(checkout)}`);
  if (TERMINAL_CASE_STATUSES.has(resolved.caseStatus)) return refuse("unavailable", `case_${resolved.caseStatus}`);
  if (payment.status !== "failed" && payment.status !== "open") return refuse("unavailable", `payment_${payment.status}`);
  if (!payment.stripeInvoiceId) return refuse("unavailable", "payment_without_provider_invoice");
  if (!resolved.customerStripeId) return refuse("unavailable", "customer_without_provider_identity");
  if (!Number.isInteger(payment.amountCents) || payment.amountCents <= 0 || !/^[A-Z]{3}$/.test(payment.currency)) {
    return refuse("unavailable", "local_financial_authority_invalid");
  }

  // 3. Connection — the org's ACTIVE credential (resolved server-side, org
  //    scoped; never derived from anything the browser sent).
  const [conn] = await withOrgTx(db, orgId, (tx) =>
    tx.select().from(schema.stripeConnections)
      .where(and(eq(schema.stripeConnections.orgId, orgId), eq(schema.stripeConnections.status, "active")))
      .orderBy(sql`created_at desc`).limit(1));
  if (!conn || !conn.keyCiphertext) return refuse("provider_unavailable", "no_active_connection");

  // 4. CURRENT provider truth through the existing read-only 4C boundary,
  //    verified with the SAME rules that gate payment execution.
  let truth: Awaited<ReturnType<ReturnType<typeof getStripeGateway>["getInvoiceForExecution"]>>;
  try {
    truth = await getStripeGateway().getInvoiceForExecution(decryptConnectionKey(conn.keyCiphertext), payment.stripeInvoiceId);
  } catch (err) {
    const code = isProviderError(err) || err instanceof ProviderError ? (err as ProviderError).code : "provider_error";
    const configFault = code === "invalid_credentials" || code === "revoked" || code === "auth_failure" || code === "permission_failure";
    // Unverified provider truth is never acted on: no URL, honest state.
    return refuse(configFault ? "provider_unavailable" : "provider_error", `provider_lookup_failed:${code}`);
  }
  const fault = providerInvoiceFault(truth, {
    customerStripeId: resolved.customerStripeId, currency: payment.currency, amountCents: payment.amountCents
  });
  if (fault) {
    return refuse(fault.reason === "provider_invoice_already_paid" ? "already_paid" : "unavailable", fault.reason);
  }
  // The provider must offer its own hosted page for this invoice; we never
  // construct one, and only the provider's hosted-invoice origin is accepted.
  const url = truth.hostedInvoiceUrl ?? null;
  if (!url || !HOSTED_INVOICE_URL_RE.test(url)) return refuse("provider_unavailable", "hosted_invoice_url_missing");

  // 5. Record the hand-off (never completion) + audit; return the provider URL.
  //    The row is updated under the org scope; the URL is not persisted (it
  //    is provider-owned and re-read fresh on every start).
  await withOrgTx(db, orgId, async (tx) => {
    await tx.update(schema.recoveryCheckouts).set({
      startedAt: sql`coalesce(${schema.recoveryCheckouts.startedAt}, now())`,
      startCount: sql`${schema.recoveryCheckouts.startCount} + 1`
    }).where(eq(schema.recoveryCheckouts.id, checkout.id));
    // The case status is deliberately NOT moved by a member click: a click
    // is not a financial event, and moving the case out of the retryable
    // states on an abandoned start would silently stall the 4D policy.
    await audit(tx as unknown as Db, {
      orgId, actorId: "customer", actorKind: "system", action: "checkout.started",
      targetType: "recovery_checkout", targetId: checkout.id,
      diff: { caseId, paymentId: payment.id, amountCents: payment.amountCents, currency: payment.currency, surface: "stripe_hosted_invoice" },
      ip: meta.ip, userAgent: meta.userAgent
    });
  });
  return { state: "ready", url };
}

/* ------------------------------------------------------------------ */
/*  COMPLETION: provider truth only                                    */
/* ------------------------------------------------------------------ */

/**
 * Called from the ONE place every truth path (webhook, sync, reconciliation,
 * execution) converges — when a payment row becomes `paid`. If an open
 * checkout was STARTED for the case behind this payment, the case is closed
 * as recovered with source `checkout` and the checkout row completed.
 * Idempotent; terminal cases never move; the attribution row is unique per
 * payment. The browser cannot reach this function.
 */
export async function applyCheckoutCompletion(
  tx: Db, orgId: string, paymentId: string
): Promise<boolean> {
  const [p] = await tx.select().from(schema.payments)
    .where(and(eq(schema.payments.orgId, orgId), eq(schema.payments.id, paymentId)));
  if (!p || p.status !== "paid") return false; // provider truth is the ONLY completion signal
  const [c] = await tx.select().from(schema.recoveryCases)
    .where(and(eq(schema.recoveryCases.orgId, orgId), eq(schema.recoveryCases.paymentId, paymentId)));
  if (!c) return false;
  const open = await tx.select().from(schema.recoveryCheckouts)
    .where(and(eq(schema.recoveryCheckouts.caseId, c.id), eq(schema.recoveryCheckouts.status, "open")));
  const started = open.filter((k) => k.startedAt !== null);
  // Close every open link for the case: nothing is left to pay.
  if (open.length > 0) {
    await tx.update(schema.recoveryCheckouts)
      .set({ status: "completed", completedAt: new Date() })
      .where(and(eq(schema.recoveryCheckouts.caseId, c.id), eq(schema.recoveryCheckouts.status, "open")));
  }
  if (started.length === 0) return false; // organic/retry recovery — not a checkout recovery
  if (TERMINAL_CASE_STATUSES.has(c.status)) return false;
  await tx.update(schema.recoveryCases).set({
    status: "recovered", closedAt: new Date(), closedReason: "payment_recovered",
    recoveredCents: p.amountCents, updatedAt: new Date()
  }).where(eq(schema.recoveryCases.id, c.id));
  await tx.insert(schema.recoveryAttributions).values({
    orgId, caseId: c.id, customerId: c.customerId, paymentId: p.id,
    source: "checkout", amountCents: p.amountCents,
    withinWindow: Date.now() - c.firstFailedAt.getTime() <= 90 * 86_400_000,
    policySnapshot: { recoveredVia: "hosted_checkout_v1", checkoutId: started[0]!.id }
  }).onConflictDoNothing({ target: schema.recoveryAttributions.paymentId });
  await audit(tx, {
    orgId, actorId: null, actorKind: "system", action: "case.recovered",
    targetType: "recovery_case", targetId: c.id,
    diff: { status: "recovered", recoveredCents: p.amountCents, source: "checkout" }
  });
  return true;
}

/** Operator action: create/rotate the /c/{token} link (§6.2, operator role). */
export async function createCheckoutLink(
  ctx: import("../context.js").OrgContext, caseId: string,
  meta: { ip?: string | null; userAgent?: string | null }
): Promise<{ token: string; expiresAt: string }> {
  return withOrgTx(ctx.db, ctx.org.id, async (tx) => {
    const [c] = await tx.select().from(schema.recoveryCases)
      .where(and(eq(schema.recoveryCases.id, caseId), eq(schema.recoveryCases.orgId, ctx.org.id)));
    if (!c) throw new ProblemError("not-found", "No such recovery case in this workspace.");
    const token = randomBytes(16).toString("base64url"); // 128-bit (§7.2)
    await tx.update(schema.recoveryCheckouts).set({ status: "disabled" })
      .where(and(eq(schema.recoveryCheckouts.caseId, caseId), eq(schema.recoveryCheckouts.status, "open")));
    const [row] = await tx.insert(schema.recoveryCheckouts).values({
      caseId, tokenHash: hashToken(token), expiresAt: new Date(Date.now() + 14 * 24 * 3600 * 1000)
    }).returning();
    await audit(tx as unknown as Db, {
      orgId: ctx.org.id, actorId: ctx.userId, action: "checkout.link_created",
      targetType: "recovery_checkout", targetId: row!.id,
      ip: meta.ip, userAgent: meta.userAgent
    });
    return { token, expiresAt: row!.expiresAt.toISOString() };
  });
}
