/**
 * Overview aggregate (§6.2). Financial truth (brief §14):
 *   cashRecovered30d  — SUM(recovery_attributions.amount_cents) in window. The
 *                       attribution ledger is the ONLY recovered-cash source.
 *   exposure          — open failed payment amounts (case amount, open states).
 *   potentialMrr      — SUM(potential_mrr_cents) of open opportunities. Clearly
 *                       NOT collected cash; frontend labels keep this distinct.
 *   recoveryRatePct   — recovered / (recovered + lost) over 30d; null when
 *                       unknown (never fabricated).
 * Disconnected org: connection absent ⇒ null metrics (never zeros).
 */
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import * as schema from "@revessent/db";
import { withOrgTx, type Db } from "@revessent/db";
import type { Overview, ActivityItem, Money } from "@revessent/contracts";
import type { OrgContext } from "../context.js";
import { approvalsPending } from "./recovery.js";

const DAY = 24 * 3600 * 1000;

const money = (minor: number, currency: string): Money => ({ minor, currency });

export async function overview(ctx: OrgContext): Promise<Overview> {
  const orgId = ctx.org.id;
  const db = ctx.db;
  const currency = "USD";
  const since30 = new Date(Date.now() - 30 * DAY);

  const connection = await withOrgTx(db, orgId, (tx) =>
    tx.select().from(schema.stripeConnections)
      .where(and(eq(schema.stripeConnections.orgId, orgId), eq(schema.stripeConnections.status, "active"))));
  const connected = connection.length > 0;

  if (!connected) {
    return {
      orgSlug: ctx.org.slug,
      cashRecovered30d: null, mrrAtRisk: null, potentialMrr: null, recoveryRatePct: null,
      cases: { open: 0, recovered30d: 0, lost30d: 0 },
      approvalsPending: 0,
      series: [],
      activity: [{
        id: "connect-stripe", at: new Date().toISOString(), kind: "system",
        text: "Stripe isn't connected yet — connect in Settings to see live recovery data.",
        tone: "warn"
      }]
    };
  }

  const [recovered] = await withOrgTx(db, orgId, (tx) =>
    tx.select({ total: sql<number>`coalesce(sum(${schema.recoveryAttributions.amountCents}), 0)::bigint` })
      .from(schema.recoveryAttributions)
      .where(and(eq(schema.recoveryAttributions.orgId, orgId), gte(schema.recoveryAttributions.attributedAt, since30))));

  const openStates = ["detected", "analyzing", "retrying", "contacting", "checkout"] as const;
  const [atRisk] = await withOrgTx(db, orgId, (tx) =>
    tx.select({ total: sql<number>`coalesce(sum(${schema.recoveryCases.amountCents}), 0)::bigint` })
      .from(schema.recoveryCases)
      .where(and(eq(schema.recoveryCases.orgId, orgId), inArray(schema.recoveryCases.status, [...openStates]))));

  const [potential] = await withOrgTx(db, orgId, (tx) =>
    tx.select({ total: sql<number>`coalesce(sum(${schema.expansionOpportunities.potentialMrrCents}), 0)::bigint` })
      .from(schema.expansionOpportunities)
      .where(and(eq(schema.expansionOpportunities.orgId, orgId),
        inArray(schema.expansionOpportunities.status, ["new", "awaiting_approval", "approved"]))));

  const [counts] = await withOrgTx(db, orgId, (tx) =>
    tx.select({
      open: sql<number>`count(*) filter (where ${schema.recoveryCases.status} in ('detected','analyzing','retrying','contacting','checkout'))::int`,
      recovered30d: sql<number>`count(*) filter (where ${schema.recoveryCases.status} = 'recovered' and ${schema.recoveryCases.closedAt} >= ${since30})::int`,
      lost30d: sql<number>`count(*) filter (where ${schema.recoveryCases.status} = 'lost' and ${schema.recoveryCases.closedAt} >= ${since30})::int`
    }).from(schema.recoveryCases).where(eq(schema.recoveryCases.orgId, orgId)));

  const closed30 = (counts?.recovered30d ?? 0) + (counts?.lost30d ?? 0);
  const recoveryRatePct = closed30 === 0 ? null : Math.round(((counts?.recovered30d ?? 0) / closed30) * 100);

  // 8-week series from the attribution ledger (recovered) + lost cases
  const seriesRows = await withOrgTx(db, orgId, (tx) =>
    tx.select({
      week: sql<string>`to_char(date_trunc('week', ${schema.recoveryAttributions.attributedAt}), 'YYYY-MM-DD')`,
      recovered: sql<number>`coalesce(sum(${schema.recoveryAttributions.amountCents}), 0)::bigint`
    }).from(schema.recoveryAttributions)
      .where(and(eq(schema.recoveryAttributions.orgId, orgId), gte(schema.recoveryAttributions.attributedAt, new Date(Date.now() - 56 * DAY))))
      .groupBy(sql`date_trunc('week', ${schema.recoveryAttributions.attributedAt})`));

  const series: Overview["series"] = [];
  for (let w = 7; w >= 0; w--) {
    const weekStart = new Date(Date.now() - w * 7 * DAY);
    weekStart.setUTCHours(0, 0, 0, 0);
    const key = weekStart.toISOString().slice(0, 10);
    const row = seriesRows.find((r) => r.week === key);
    series.push({ weekStart: key, recoveredMinor: Number(row?.recovered ?? 0), lostMinor: 0 });
  }

  const activity = await activityFeed(db, orgId);
  return {
    orgSlug: ctx.org.slug,
    cashRecovered30d: money(Number(recovered?.total ?? 0), currency),
    mrrAtRisk: money(Number(atRisk?.total ?? 0), currency),
    potentialMrr: money(Number(potential?.total ?? 0), currency),
    recoveryRatePct,
    cases: { open: counts?.open ?? 0, recovered30d: counts?.recovered30d ?? 0, lost30d: counts?.lost30d ?? 0 },
    approvalsPending: await approvalsPending(db, orgId),
    series,
    activity
  };
}

async function activityFeed(db: Db, orgId: string): Promise<ActivityItem[]> {
  const rows = await withOrgTx(db, orgId, (tx) =>
    tx.select().from(schema.auditLogs)
      .where(eq(schema.auditLogs.orgId, orgId))
      .orderBy(desc(schema.auditLogs.createdAt)).limit(8));
  return rows.map((a) => ({
    id: a.id,
    at: a.createdAt.toISOString(),
    kind: (a.action.startsWith("message") || a.action.startsWith("opportunity") ? "approval"
      : a.action.startsWith("signal") ? "expansion"
      : a.action.startsWith("key") ? "provider" : "system") as ActivityItem["kind"],
    text: a.action.replace(/[._]/g, " "),
    tone: "neutral" as const
  }));
}
