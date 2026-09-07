/**
 * Public member checkout contract — /c/{token} (§6.2 J4, §7.2).
 * Tokens: 128-bit random, SHA-256 stored, 14-day expiry. No session needed;
 * scope is the single case. The CONFIRM action cannot complete in Phase 3
 * (Stripe-hosted checkout + provider confirmation = next phase) and returns
 * an honest not-in-this-phase problem — never a fabricated completion.
 */
import { createHash, randomBytes } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import * as schema from "@revessent/db";
import { withOrgTx, type Db } from "@revessent/db";
import type { RecoveryTokenInfo } from "@revessent/contracts";
import { ProblemError } from "../http/problems.js";
import { audit } from "./audit.js";

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

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
    const state = checkout!.status === "completed" ? "used"
      : checkout!.status === "disabled" || checkout!.expiresAt.getTime() < Date.now() ? "expired"
      : "valid";
    await tx.select().from(schema.payments).where(eq(schema.payments.id, row.case.paymentId));
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

export function confirmCheckout(): never {
  // Provider confirmation is Stripe's, in the next phase. The browser can
  // never assert it (CRITICAL PRINCIPLE: frontend state ≠ financial truth).
  throw new ProblemError(
    "not-in-this-phase",
    "Checkout completion is confirmed by Stripe in the next phase. Nothing was charged and no confirmation is simulated."
  );
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
