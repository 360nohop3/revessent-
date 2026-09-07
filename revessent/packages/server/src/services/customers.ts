import { and, desc, eq, ilike, or, isNull } from "drizzle-orm";
import * as schema from "@revessent/db";
import { withOrgTx } from "@revessent/db";
import type { Customer, CustomerFilters, Paged } from "@revessent/contracts";
import { ProblemError } from "../http/problems.js";
import type { OrgContext } from "../context.js";

export async function listCustomers(ctx: OrgContext, filters: CustomerFilters): Promise<Paged<Customer>> {
  const rows = await withOrgTx(ctx.db, ctx.org.id, (tx) => {
    const base = tx.select().from(schema.customers);
    const conds = [eq(schema.customers.orgId, ctx.org.id), isNull(schema.customers.deletedAt)];
    if (filters.status && filters.status !== "all") conds.push(eq(schema.customers.status, filters.status));
    if (filters.q) {
      const like = `%${filters.q}%`;
      const search = or(ilike(schema.customers.name, like), ilike(schema.customers.email, like));
      if (search) conds.push(search);
    }
    return base.where(and(...conds)).orderBy(desc(schema.customers.mrrCents)).limit(100);
  });
  const items = rows.map((r) => toDto(r, ctx.org.slug, [], []));
  return { items, nextCursor: null };
}

function toDto(
  c: (typeof schema.customers)["$inferSelect"],
  orgSlug: string,
  subs: (typeof schema.subscriptions)["$inferSelect"][],
  payments: (typeof schema.payments)["$inferSelect"][]
): Customer {
  return {
    id: c.id,
    orgSlug,
    name: c.name ?? "Unknown",
    email: c.email ?? "",
    // MRR currency: prefer a provider-validated subscription currency, then
    // the provider customer currency; "USD" labels only the ZERO case (no
    // supported recurring revenue) — a presentation default, not a fact.
    mrr: { minor: c.mrrCents, currency: subs[0]?.currency ?? c.currency ?? "USD" },
    status: c.status as Customer["status"],
    riskStatus: c.status === "past_due" ? "at_risk" : "none",
    expansionStatus: "none",
    subscriptions: subs.map((s) => ({
      id: s.id, plan: s.stripePriceId,
      amount: { minor: s.amountCents, currency: s.currency },
      interval: s.interval as "month" | "year" | "unsupported", status: s.status
    })),
    payments: payments.map((p) => ({
      id: p.id, at: (p.failedAt ?? p.paidAt ?? p.createdAt).toISOString(),
      amount: { minor: p.amountCents, currency: p.currency },
      // Verbatim payment status (open|paid|failed|refunded|void) — since 4A
      // syncs real invoices, open/void are honest states and are NEVER
      // coerced into "failed" (final provider-state audit).
      outcome: p.status as "paid" | "failed" | "refunded" | "open" | "void",
      source: p.stripeChargeId ?? "stripe"
    }))
  };
}

export async function getCustomer(ctx: OrgContext, id: string): Promise<Customer> {
  return withOrgTx(ctx.db, ctx.org.id, async (tx) => {
    const [c] = await tx.select().from(schema.customers)
      .where(and(eq(schema.customers.id, id), eq(schema.customers.orgId, ctx.org.id)));
    if (!c) throw new ProblemError("not-found", "No such customer in this workspace.");
    const subs = await tx.select().from(schema.subscriptions).where(eq(schema.subscriptions.customerId, id));
    const pays = await tx.select().from(schema.payments)
      .where(eq(schema.payments.customerId, id)).orderBy(desc(schema.payments.createdAt)).limit(20);
    return toDto(c, ctx.org.slug, subs, pays);
  });
}
