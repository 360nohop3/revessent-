/**
 * READ-ONLY STRIPE SYNCHRONIZATION (Phase 4A §9).
 *
 * Stripe is the authority: local rows are synchronized representations keyed
 * by provider IDs (DB-unique per org → idempotent upserts, §13). Network
 * calls NEVER happen inside a DB transaction: fetch page (gateway) → persist
 * page (one short org-scoped tx) → advance checkpoint (§14). A failed sync
 * preserves all previously synced data and records a safe taxonomy code —
 * valid data is never converted into zeros (§19/§21.7).
 *
 * There is NO write call anywhere: no charge, retry, refund, capture or
 * subscription modification is expressed in this phase.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import * as schema from "@revessent/db";
import { withOrgTx, withOrgSyncLock, type Db } from "@revessent/db";
import { serverEnv } from "@revessent/config";
import { getStripeGateway, isProviderError } from "@revessent/integrations";
import { openSecret, } from "../crypto/secret-box.js";
import { ProblemError } from "../http/problems.js";
import { audit } from "./audit.js";
import { stripeConnection } from "./settings.js";
import type { OrgContext } from "../context.js";

/** Safety bound: pages per entity per run (200 × 50 = 10k records). The
 *  checkpoint is retained when hit, so a re-run CONTINUES — never silent
 *  truncation (§9). */
const MAX_PAGES_PER_ENTITY = 200;
const PAGE_SIZE = 50;

type Entity = "customers" | "subscriptions" | "invoices";
const ENTITIES: Entity[] = ["customers", "subscriptions", "invoices"];

export interface SyncSummary {
  started: true;
  results: Record<Entity, { status: "ok" | "failed" | "skipped"; pages: number; upserted: number; anomalies: number; errorCode: string | null }>;
}

function decryptedKey(sealed: string): string {
  return openSecret(sealed, serverEnv().KEY_ENCRYPTION_KEY); // server-side only (§5)
}

async function activeConnection(ctx: OrgContext) {
  const rows = await withOrgTx(ctx.db, ctx.org.id, (tx) =>
    tx.select().from(schema.stripeConnections)
      .where(and(eq(schema.stripeConnections.orgId, ctx.org.id), eq(schema.stripeConnections.status, "active")))
      .limit(1));
  return rows[0] ?? null;
}

/**
 * Manual read-only sync (§9: "manual sync"). Runs to completion in the
 * request (bounded); workers/schedules arrive in a later phase.
 *
 * SINGLE-FLIGHT (database-enforced, final-audit correction): the whole run
 * executes inside a per-org PostgreSQL session advisory lock
 * (`withOrgSyncLock`). A concurrent request for the SAME organization gets a
 * safe 409 conflict and never starts provider synchronization; DIFFERENT
 * organizations never block each other. The lock is acquired before any
 * connection/provider access and released in `finally` on every path
 * (success, failure, provider throw, unexpected exception); a crashed
 * process cannot wedge an org because PostgreSQL releases session locks when
 * the connection disappears.
 */
export async function triggerSync(
  ctx: OrgContext, meta: { ip?: string | null; userAgent?: string | null }
): Promise<{ started: true; connection: Awaited<ReturnType<typeof stripeConnection>>; summary: SyncSummary["results"] }> {
  const outcome = await withOrgSyncLock(ctx.db, ctx.org.id, () => runSyncExclusive(ctx, meta));
  if (!outcome.acquired) {
    throw new ProblemError("conflict", "A sync is already in progress for this workspace.");
  }
  return outcome.value;
}

/** Runs with the exclusive per-org sync lock held. Never called unlocked. */
async function runSyncExclusive(
  ctx: OrgContext, meta: { ip?: string | null; userAgent?: string | null }
): Promise<{ started: true; connection: Awaited<ReturnType<typeof stripeConnection>>; summary: SyncSummary["results"] }> {
  const conn = await activeConnection(ctx);
  // activeConnection filters status='active'; keyCiphertext=null (revoked
  // credential destroyed) is defense-in-depth — no key, no provider op.
  if (!conn || conn.keyCiphertext == null) {
    throw new ProblemError("conflict", "Connect Stripe before syncing.");
  }

  // We hold the exclusive lock: any 'running' state row is an orphan from a
  // crashed process. Mark it honestly failed (safe code) — never a stuck
  // "running" display, never a permanently locked organization.
  await withOrgTx(ctx.db, ctx.org.id, (tx) =>
    tx.update(schema.syncState)
      .set({ status: "failed", lastError: "interrupted", finishedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(schema.syncState.orgId, ctx.org.id), eq(schema.syncState.status, "running"))));

  const key = decryptedKey(conn.keyCiphertext);
  const gateway = getStripeGateway();

  await withOrgTx(ctx.db, ctx.org.id, (tx) => audit(tx as unknown as Db, {
    orgId: ctx.org.id, actorId: ctx.userId, action: "sync.started",
    targetType: "stripe_connection", targetId: conn.id,
    diff: { account: conn.stripeAccountId }, ip: meta.ip, userAgent: meta.userAgent
  }));

  const results = {} as SyncSummary["results"];
  let anyFailed = false;
  let providerRevoked = false;

  for (const entity of ENTITIES) {
    try {
      const r = await syncEntity(ctx, gateway, key, conn, entity);
      results[entity] = r;
      if (r.status === "failed") { anyFailed = true; if (r.errorCode === "revoked") providerRevoked = true; }
    } catch (err) {
      const code = isProviderError(err) ? err.code : "transient_network";
      results[entity] = { status: "failed", pages: 0, upserted: 0, anomalies: 0, errorCode: code };
      anyFailed = true;
      if (code === "revoked") providerRevoked = true;
    }
  }

  if (providerRevoked) {
    // Stripe is the authority: it says this key no longer works. The
    // credential becomes cryptographically unusable (sealed material
    // destroyed — §5 lifecycle decision) and the connection is marked
    // revoked; audit records safe metadata only (§18). Historical safe
    // metadata (last4, account id) remains in the audit ledger.
    await withOrgTx(ctx.db, ctx.org.id, async (tx) => {
      await tx.update(schema.stripeConnections)
        .set({ status: "revoked", keyCiphertext: null })
        .where(eq(schema.stripeConnections.id, conn.id));
      await audit(tx as unknown as Db, {
        orgId: ctx.org.id, actorId: ctx.userId, action: "credential.revoked",
        targetType: "stripe_connection", targetId: conn.id,
        diff: { account: conn.stripeAccountId, source: "sync" }, // code/metadata only — NEVER the key
        ip: meta.ip, userAgent: meta.userAgent
      });
    });
  }

  if (anyFailed) {
    await withOrgTx(ctx.db, ctx.org.id, (tx) => audit(tx as unknown as Db, {
      orgId: ctx.org.id, actorId: ctx.userId, action: "sync.failed",
      targetType: "stripe_connection", targetId: conn.id,
      diff: { codes: Object.fromEntries(ENTITIES.map((e) => [e, results[e].errorCode])) },
      ip: meta.ip, userAgent: meta.userAgent
    }));
  } else {
    await withOrgTx(ctx.db, ctx.org.id, async (tx) => {
      await tx.update(schema.stripeConnections).set({ lastSyncAt: new Date(), backfillDoneAt: new Date() })
        .where(eq(schema.stripeConnections.id, conn.id));
      await audit(tx as unknown as Db, {
        orgId: ctx.org.id, actorId: ctx.userId, action: "sync.succeeded",
        targetType: "stripe_connection", targetId: conn.id,
        diff: Object.fromEntries(ENTITIES.map((e) => [e, { upserted: results[e].upserted, pages: results[e].pages }])),
        ip: meta.ip, userAgent: meta.userAgent
      });
    });
  }

  return { started: true, connection: await stripeConnection(ctx), summary: results };
}

type EntityResult = SyncSummary["results"][Entity];

async function syncEntity(
  ctx: OrgContext, gateway: ReturnType<typeof getStripeGateway>, key: string,
  conn: typeof schema.stripeConnections["$inferSelect"], entity: Entity
): Promise<EntityResult> {
  // durable state row (upsert) → running
  await withOrgTx(ctx.db, ctx.org.id, async (tx) => {
    await tx.insert(schema.syncState).values({
      orgId: ctx.org.id, entity, status: "running", startedAt: new Date(),
      providerAccount: conn.stripeAccountId, updatedAt: new Date()
    }).onConflictDoUpdate({
      target: [schema.syncState.orgId, schema.syncState.entity],
      set: { status: "running", startedAt: new Date(), lastError: null, updatedAt: new Date() }
    });
  });

  const stateRows = await withOrgTx(ctx.db, ctx.org.id, (tx) =>
    tx.select().from(schema.syncState)
      .where(and(eq(schema.syncState.orgId, ctx.org.id), eq(schema.syncState.entity, entity))));
  const state = stateRows[0]!;

  // incremental after a complete backfill (§9): only objects created since the
  // last full pass. In-place provider edits arrive via webhooks in 4B — the
  // initial pass always pulls everything.
  // Phase 4A has no webhook execution (4B): a created-filter incremental pass
  // could never see provider UPDATES/DELETIONS and would let local data drift
  // from Stripe — the authority. Manual sync is therefore a bounded FULL
  // refresh (≤ MAX_PAGES_PER_ENTITY pages, resumable via the cursor
  // checkpoint). createdAfterEpoch stays in the gateway contract for the 4B
  // automatic scheduler, where webhooks make incremental passes safe.
  const createdAfterEpoch: number | null = null;

  let cursor: string | null = state.cursor;
  let pages = 0;
  let upserted = 0;
  let anomalies = 0;

  try {
    do {
      const page = await fetchPage(gateway, key, entity, { startingAfter: cursor, limit: PAGE_SIZE, createdAfterEpoch });
      // persist page in its own short org-scoped transaction (§14: no network in tx)
      const res = await withOrgTx(ctx.db, ctx.org.id, (tx) => persistPage(tx as unknown as Db, ctx, entity, page.data));
      upserted += res.upserted;
      anomalies += res.anomalies;
      pages++;
      cursor = page.nextCursor;
      if (pages >= MAX_PAGES_PER_ENTITY && page.hasMore) break; // checkpoint keeps cursor; resumable
    } while (cursor);

    await withOrgTx(ctx.db, ctx.org.id, (tx) =>
      tx.update(schema.syncState).set({
        status: "ok", lastSuccessAt: new Date(), finishedAt: new Date(),
        cursor: null, pagesSynced: pages, recordsUpserted: upserted,
        lastError: null, updatedAt: new Date()
      }).where(eq(schema.syncState.id, state.id)));

    if (entity === "subscriptions") await recomputeCustomerMrr(ctx.db, ctx.org.id);
    return { status: "ok", pages, upserted, anomalies, errorCode: null };
  } catch (err) {
    const code = isProviderError(err) ? err.code : "transient_network";
    await withOrgTx(ctx.db, ctx.org.id, (tx) =>
      tx.update(schema.syncState).set({
        status: "failed", finishedAt: new Date(), cursor, // cursor RETAINED → resumable (§19)
        pagesSynced: pages, recordsUpserted: upserted, lastError: code, updatedAt: new Date()
      }).where(eq(schema.syncState.id, state.id)));
    return { status: "failed", pages, upserted, anomalies, errorCode: code };
  }
}

async function fetchPage(
  gateway: ReturnType<typeof getStripeGateway>, key: string, entity: Entity,
  opts: { startingAfter: string | null; limit: number; createdAfterEpoch: number | null }
) {
  switch (entity) {
    case "customers": return gateway.listCustomers(key, opts);
    case "subscriptions": return gateway.listSubscriptions(key, opts);
    case "invoices": return gateway.listInvoices(key, opts);
  }
}

/** Result of one provider-record application: "applied", "applied+<notes>"
 *  (applied AND anomaly-counted, e.g. unsupported interval persisted
 *  verbatim), or "anomaly:<reason>" (not persisted). */
export type ApplyResult = "applied" | `applied+${string}` | `anomaly:${string}`;

/**
 * Applies ONE provider customer (4A truth rules; shared with webhooks 4B).
 * Returns "applied" or an anomaly reason — never throws for provider-data
 * shape problems (invalid id/shape ⇒ anomaly, sync continues).
 */
export async function applyProviderCustomer(db: Db, orgId: string, c: {
  id: string; email: string | null; name: string | null; currency: string | null;
  deleted: boolean; createdEpoch: number | null;
}): Promise<ApplyResult> {
  if (!c.id || !c.id.startsWith("cus_")) return "anomaly:invalid_provider_object";
  await db.insert(schema.customers).values({
    orgId, stripeCustomerId: c.id, email: c.email, name: c.name,
    currency: c.currency?.toUpperCase().slice(0, 3) ?? null,
    stripeCreatedAt: c.createdEpoch ? new Date(c.createdEpoch * 1000) : null,
    deletedAt: c.deleted ? new Date() : null,
    updatedAt: new Date()
  }).onConflictDoUpdate({
    target: [schema.customers.orgId, schema.customers.stripeCustomerId],
    set: {
      email: c.email, name: c.name,
      currency: c.currency?.toUpperCase().slice(0, 3) ?? null,
      stripeCreatedAt: c.createdEpoch ? new Date(c.createdEpoch * 1000) : null,
      deletedAt: c.deleted ? new Date() : null,
      updatedAt: new Date()
    }
  });
  return "applied";
}

/**
 * Applies ONE provider subscription for a RESOLVED local customer (4A truth
 * rules: explicit supported mapping only; unsupported interval stored
 * verbatim and excluded from MRR; unknown price/amount/currency ⇒ anomaly).
 */
export async function applyProviderSubscription(db: Db, orgId: string, customerLocalId: string, sub: {
  id: string; priceId: string; status: string; amountMinor: number | null; currency: string;
  interval: "month" | "year" | "unsupported"; itemCount?: number; cancelAtPeriodEnd: boolean;
  canceledAtIso: string | null; currentPeriodEndIso: string | null;
}): Promise<ApplyResult> {
  if (!sub.priceId) return "anomaly:unknown_price_identity";
  const amount = sub.amountMinor;
  if (typeof amount !== "number" || !Number.isInteger(amount) || amount < 0) return "anomaly:unknown_amount";
  if (!/^[a-zA-Z]{3}$/.test(sub.currency)) return "anomaly:unknown_currency";
  if (sub.interval === "unsupported") { /* persisted verbatim below; MRR excludes */ }
  if ((sub.itemCount ?? 1) > 1) { /* first item applied; limitation surfaced via anomaly */ }
  // unsupported interval / multi-item: STILL PERSISTED (verbatim, Stripe is
  // the authority; MRR excludes them) — the note marks the counted anomaly.
  const note = (sub.interval === "unsupported" ? "unsupported_interval" : "")
    + ((sub.itemCount ?? 1) > 1 ? (sub.interval === "unsupported" ? "+" : "") + "multi_item_first_priced" : "");
  await db.insert(schema.subscriptions).values({
    orgId, customerId: customerLocalId, stripeSubscriptionId: sub.id,
    stripePriceId: sub.priceId, status: sub.status,
    amountCents: amount, currency: sub.currency.slice(0, 3),
    interval: sub.interval, cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
    canceledAt: sub.canceledAtIso ? new Date(sub.canceledAtIso) : null,
    currentPeriodEnd: sub.currentPeriodEndIso ? new Date(sub.currentPeriodEndIso) : null,
    updatedAt: new Date()
  }).onConflictDoUpdate({
    target: [schema.subscriptions.orgId, schema.subscriptions.stripeSubscriptionId],
    set: {
      customerId: customerLocalId, stripePriceId: sub.priceId, status: sub.status,
      amountCents: amount, currency: sub.currency.slice(0, 3), interval: sub.interval,
      cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
      canceledAt: sub.canceledAtIso ? new Date(sub.canceledAtIso) : null,
      currentPeriodEnd: sub.currentPeriodEndIso ? new Date(sub.currentPeriodEndIso) : null,
      updatedAt: new Date()
    }
  });
  await db.update(schema.customers).set({ updatedAt: new Date() }).where(eq(schema.customers.id, customerLocalId));
  return note ? (`applied+${note}` as ApplyResult) : "applied";
}

/**
 * Applies ONE provider invoice (4A truth rules: the explicit five-state
 * whitelist; unsupported provider status ⇒ anomaly + skip — never coerced).
 */
export async function applyProviderInvoice(db: Db, orgId: string, refs: {
  customerLocalId: string; subscriptionLocalId: string | null;
}, inv: {
  id: string; customerId: string | null; subscriptionId: string | null;
  paymentIntentId: string | null; chargeId: string | null; amountMinor: number;
  currency: string; status: string; attempted: boolean; attemptCount: number;
  hostedInvoiceUrl: string | null; periodStartIso: string | null;
  periodEndIso: string | null; paidAtIso: string | null; createdEpoch: number;
}): Promise<ApplyResult> {
  if (!inv.id || !inv.id.startsWith("in_")) return "anomaly:invalid_provider_object";
  if (!Number.isInteger(inv.amountMinor)) return "anomaly:unknown_amount";
  if (!inv.status) return "anomaly:unknown_status";
  if (!/^[a-zA-Z]{3}$/.test(inv.currency)) return "anomaly:unknown_currency";
  // Stripe invoice status → Phase 1 payment status. EXPLICIT supported
  // mapping ONLY (final audit): paid→paid, void→void, uncollectible→failed,
  // open+attempted→failed, open+!attempted→open. ANY other provider status
  // is UNSUPPORTED data — anomaly + skip, never a known REVESSENT status.
  const status = inv.status === "paid" ? "paid"
    : inv.status === "void" ? "void"
    : inv.status === "uncollectible" ? "failed"
    : inv.status === "open" ? (inv.attempted ? "failed" : "open")
    : null;
  if (status === null) return "anomaly:unsupported_invoice_status";
  const failedAt = status === "failed" ? new Date(inv.createdEpoch * 1000) : null;
  const values = {
    orgId, customerId: refs.customerLocalId, subscriptionId: refs.subscriptionLocalId,
    stripeInvoiceId: inv.id, stripePaymentIntentId: inv.paymentIntentId, stripeChargeId: inv.chargeId,
    amountCents: inv.amountMinor, currency: inv.currency.slice(0, 3),
    status, attemptedCount: inv.attemptCount,
    declineCode: status === "failed" ? (inv.status === "uncollectible" ? "uncollectible" : "open_invoice") : null,
    declineMessage: null,
    hostedInvoiceUrl: inv.hostedInvoiceUrl,
    periodStart: inv.periodStartIso ? new Date(inv.periodStartIso) : null,
    periodEnd: inv.periodEndIso ? new Date(inv.periodEndIso) : null,
    failedAt, paidAt: inv.paidAtIso ? new Date(inv.paidAtIso) : null,
    raw: null, updatedAt: new Date()
  };
  await db.insert(schema.payments).values(values)
    .onConflictDoUpdate({
      target: [schema.payments.orgId, schema.payments.stripeInvoiceId],
      // payments_org_invoice_uq is partial — the target must repeat its
      // predicate or Postgres rejects the inference (42P10)
      targetWhere: sql`stripe_invoice_id is not null`,
      set: { ...values, createdAt: undefined }
    });
  return "applied";
}

async function persistPage(db: Db, ctx: OrgContext, entity: Entity, data: unknown[]): Promise<{ upserted: number; anomalies: number }> {
  let upserted = 0;
  let anomalies = 0;
  if (entity === "customers") {
    for (const raw of data) {
      const c = raw as { id: string; email: string | null; name: string | null; currency: string | null; deleted: boolean; createdEpoch: number | null };
      const r = await applyProviderCustomer(db, ctx.org.id, c);
      if (r.startsWith("anomaly:")) { anomalies++; continue; }
      if (r.startsWith("applied+")) anomalies++;
      upserted++;
    }
  }

  if (entity === "subscriptions") {
    for (const raw of data) {
      const sub = raw as { id: string; customerId: string; priceId: string; status: string; amountMinor: number | null; currency: string; interval: "month" | "year" | "unsupported"; itemCount?: number; cancelAtPeriodEnd: boolean; canceledAtIso: string | null; currentPeriodEndIso: string | null; createdEpoch: number };
      if (!sub.id || !sub.id.startsWith("sub_") || !sub.customerId) { anomalies++; continue; }
      const [customer] = await db.select().from(schema.customers)
        .where(and(eq(schema.customers.orgId, ctx.org.id), eq(schema.customers.stripeCustomerId, sub.customerId)));
      if (!customer) { anomalies++; continue; } // provider referenced an unknown customer — recorded, not fabricated
      const r = await applyProviderSubscription(db, ctx.org.id, customer.id, sub);
      if (r.startsWith("anomaly:")) { anomalies++; continue; }
      if (r.startsWith("applied+")) anomalies++;
      upserted++;
    }
  }

  if (entity === "invoices") {
    for (const raw of data) {
      const inv = raw as { id: string; customerId: string | null; subscriptionId: string | null; paymentIntentId: string | null; chargeId: string | null; amountMinor: number; currency: string; status: string; attempted: boolean; attemptCount: number; hostedInvoiceUrl: string | null; periodStartIso: string | null; periodEndIso: string | null; paidAtIso: string | null; createdEpoch: number };
      let customerId: string | null = null;
      if (inv.customerId) {
        const [customer] = await db.select().from(schema.customers)
          .where(and(eq(schema.customers.orgId, ctx.org.id), eq(schema.customers.stripeCustomerId, inv.customerId)));
        customerId = customer?.id ?? null;
      }
      if (!customerId) { anomalies++; continue; } // no local customer (never fabricate one)
      let subscriptionId: string | null = null;
      if (inv.subscriptionId) {
        const [sub] = await db.select().from(schema.subscriptions)
          .where(and(eq(schema.subscriptions.orgId, ctx.org.id), eq(schema.subscriptions.stripeSubscriptionId, inv.subscriptionId)));
        subscriptionId = sub?.id ?? null;
      }
      const r = await applyProviderInvoice(db, ctx.org.id, { customerLocalId: customerId, subscriptionLocalId: subscriptionId }, inv);
      if (r.startsWith("anomaly:")) { anomalies++; continue; }
      if (r.startsWith("applied+")) anomalies++;
      upserted++;
    }
  }
  return { upserted, anomalies };
}

/** MRR is DERIVED from provider subscription data (integer math only). */
export async function recomputeCustomerMrr(db: Db, orgId: string): Promise<void> {
  await withOrgTx(db, orgId, async (tx) => {
    await tx.execute(sql`
      update customers c set mrr_cents = coalesce(s.mrr, 0), updated_at = now()
      from (
        select cu.id as customer_id,
          sum(case when sub.interval = 'year' then round(sub.amount_cents / 12.0)
                   when sub.interval = 'month' then sub.amount_cents
                   else 0 end) as mrr
        from subscriptions sub
        join customers cu on cu.id = sub.customer_id
        where sub.org_id = ${orgId}
          and sub.status in ('active', 'trialing', 'past_due')
        group by cu.id
      ) s where s.customer_id = c.id and c.org_id = ${orgId}
    `);
    await tx.execute(sql`
      update customers c set mrr_cents = 0, updated_at = now()
      where c.org_id = ${orgId}
        and c.deleted_at is null
        and not exists (
          select 1 from subscriptions sub
          where sub.customer_id = c.id and sub.status in ('active', 'trialing', 'past_due')
        )
    `);
    // customer status mirrors the provider's subscription health (authority: Stripe)
    await tx.execute(sql`
      update customers c set status = 'past_due'
      where c.org_id = ${orgId} and c.deleted_at is null
        and exists (select 1 from subscriptions sub
                    where sub.customer_id = c.id and sub.status = 'past_due')
    `);
    await tx.execute(sql`
      update customers c set status = 'canceled'
      where c.org_id = ${orgId} and c.deleted_at is not null
    `);
  });
  void inArray; // (kept import surface stable)
}
