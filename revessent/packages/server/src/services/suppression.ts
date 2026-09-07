/**
 * PHASE 6 (safety fix) — AUTHORITATIVE COMMUNICATION SUPPRESSION.
 *
 * `communication_suppressions` is the single durable source of truth for
 * "this customer must not receive recovery email". It is written by:
 *   • the public unsubscribe flow — authorized ONLY by the existing
 *     unguessable /c/{token} checkout token (hash-matched under the 0003/0005
 *     token-flow RLS policies); the browser never supplies a customer id;
 *   • (future) org-scoped operator/system actions via `suppressCustomer`.
 * It is read by the communication service at prepare time and — mandatorily —
 * after the durable send claim, before any provider call.
 *
 * The table is append-only for the app role: an opt-out cannot be reversed by
 * application code. Repeated unsubscribes are idempotent (unique per
 * org+customer+channel; ON CONFLICT DO NOTHING).
 */
import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import * as schema from "@revessent/db";
import { withOrgTx, type Db } from "@revessent/db";
import { audit } from "./audit.js";

export const SUPPRESSION_CHANNEL = "email" as const;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Authoritative read (RLS org scope). True ⇒ never send. */
export async function isCustomerSuppressed(db: Db, orgId: string, customerId: string): Promise<boolean> {
  const rows = await withOrgTx(db, orgId, (tx) =>
    tx.select({ id: schema.communicationSuppressions.id }).from(schema.communicationSuppressions)
      .where(and(
        eq(schema.communicationSuppressions.orgId, orgId),
        eq(schema.communicationSuppressions.customerId, customerId),
        eq(schema.communicationSuppressions.channel, SUPPRESSION_CHANNEL)
      )).limit(1));
  return rows.length > 0;
}

export interface SuppressInput {
  orgId: string; customerId: string;
  reason: "customer_unsubscribed" | "operator";
  source: "unsubscribe_token" | "operator" | "system";
  sourceRef?: string | null;
  actorId: string;
  actorKind?: "user" | "system";
  ip?: string | null; userAgent?: string | null;
}

/** Idempotent durable suppression + audit. Returns whether a row was created. */
export async function suppressCustomer(db: Db, input: SuppressInput): Promise<{ created: boolean }> {
  return withOrgTx(db, input.orgId, async (tx) => {
    const [row] = await tx.insert(schema.communicationSuppressions).values({
      orgId: input.orgId, customerId: input.customerId, channel: SUPPRESSION_CHANNEL,
      reason: input.reason, source: input.source, sourceRef: input.sourceRef ?? null
    }).onConflictDoNothing().returning({ id: schema.communicationSuppressions.id });
    if (!row) return { created: false };
    await audit(tx as unknown as Db, {
      orgId: input.orgId, actorId: input.actorId, actorKind: input.actorKind ?? "system",
      action: "communication.customer_suppressed", targetType: "customer", targetId: input.customerId,
      diff: { reason: input.reason, source: input.source, channel: SUPPRESSION_CHANNEL, sourceRef: input.sourceRef ?? null },
      ip: input.ip, userAgent: input.userAgent
    });
    return { created: true };
  });
}

export type UnsubscribeState = "done" | "unknown";

/**
 * Public unsubscribe: the raw token is the ONLY authorization. Resolution
 * happens under the token-flow RLS policies (hash GUC → matched checkout →
 * its case → its customer); the write then happens under the resolved org
 * scope. Unknown/expired/disabled tokens do nothing and reveal nothing.
 * `done` is returned for both first and repeated unsubscribes (idempotent).
 */
export async function unsubscribeByToken(
  db: Db, token: string, meta: { ip?: string | null; userAgent?: string | null } = {}
): Promise<{ state: UnsubscribeState }> {
  const tokenHash = hashToken(token);
  const resolved = await db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.checkout_token_hash', ${tokenHash}, true)`);
    const [checkout] = await tx.select().from(schema.recoveryCheckouts).where(eq(schema.recoveryCheckouts.tokenHash, tokenHash));
    if (!checkout) return null;
    // An unsubscribe link keeps working for the life of the recovery link
    // (14 d) and while the operator has not rotated it; anything else is unknown.
    if (checkout.status === "disabled" || checkout.expiresAt.getTime() < Date.now()) return null;
    await tx.execute(sql`select set_config('app.token_flow', '1', true)`);
    const [c] = await tx.select({ id: schema.recoveryCases.id, orgId: schema.recoveryCases.orgId, customerId: schema.recoveryCases.customerId })
      .from(schema.recoveryCases).where(eq(schema.recoveryCases.id, checkout.caseId));
    return c ?? null;
  });
  if (!resolved) return { state: "unknown" };
  await suppressCustomer(db, {
    orgId: resolved.orgId, customerId: resolved.customerId,
    reason: "customer_unsubscribed", source: "unsubscribe_token", sourceRef: resolved.id,
    actorId: "customer", actorKind: "system", ip: meta.ip, userAgent: meta.userAgent
  });
  return { state: "done" };
}
