"use client";

import Link from "next/link";
import { computeFreshness, formatAge, formatMoney, formatPercent } from "@revessent/domain";
import {
  AccessibleChart, EmptyState, ErrorState, FreshnessBanner, MetricCard, ModeBadge, Skeleton, SkeletonCard, SkeletonTable
} from "@revessent/ui";
import { formatDateTime } from "@/lib/format";
import { useOverview, useStripeConnection } from "@/lib/queries";
import type { Org } from "@revessent/contracts";

export function OverviewView({ org }: { org: Org }) {
  const slug = org.slug;
  const conn = useStripeConnection(slug);
  const ov = useOverview(slug);

  if (conn.isLoading || ov.isLoading) {
    return (
      <div className="mx-auto flex w-[min(1120px,100%)] flex-col gap-5">
        <Skeleton className="h-9 w-64" />
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <SkeletonCard /><SkeletonCard /><SkeletonCard /><SkeletonCard />
        </div>
        <Skeleton className="h-56 w-full" />
        <SkeletonTable rows={3} />
      </div>
    );
  }

  if (conn.error || ov.error || !conn.data || !ov.data) {
    return (
      <div className="mx-auto w-[min(640px,100%)]">
        <ErrorState
          message="The workspace summary failed to load. You can retry — if it keeps failing, this is exactly the state the demo controls can reproduce."
          onRetry={() => {
            void conn.refetch();
            void ov.refetch();
          }}
          retrying={conn.isRefetching || ov.isRefetching}
          technical={conn.error ? "connection query failed" : ov.error ? "overview query failed" : undefined}
        />
      </div>
    );
  }

  const connection = conn.data;
  const disconnected = connection.status === "not_connected" || connection.status === "revoked";

  if (disconnected) {
    return (
      <div className="mx-auto w-[min(640px,100%)] pt-6">
        <EmptyState
          title={connection.status === "revoked" ? "Stripe access was revoked" : "Stripe isn't connected yet"}
          body={
            connection.status === "revoked"
              ? "Historical data stays available, but nothing is syncing. Reconnect whenever you're ready."
              : "Connect a Stripe restricted key (read-only to start) and your recovery overview will fill with real, provider-confirmed data."
          }
          action={<Link href={`/app/${slug}/settings/stripe`} className="btn btn-pri">Go to Stripe settings</Link>}
        />
      </div>
    );
  }

  const data = ov.data;
  const syncing = connection.backfill === "running";
  const freshness = computeFreshness(connection.lastSyncAt);
  const isEmpty = !syncing && data.cases.open === 0 && data.cases.recovered30d === 0 && data.cases.lost30d === 0;

  return (
    <div className="mx-auto flex w-[min(1120px,100%)] flex-col gap-5">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-[24px] font-bold tracking-[-.02em] text-ink">Overview</h1>
        <ModeBadge mode={connection.mode ?? "demo"} />
        <span className="ml-auto text-[12.5px] text-ink-3">
          {connection.accountRef ?? ""} {connection.lastSyncAt ? `· synced ${formatAge(connection.lastSyncAt)}` : ""}
        </span>
      </header>

      {syncing ? (
        <FreshnessBanner freshness="fresh" syncing />
      ) : (
        <FreshnessBanner
          freshness={freshness}
          lastSyncLabel={connection.lastSyncAt ? formatAge(connection.lastSyncAt) : undefined}
          actionLabel="Connection settings"
          onAction={() => undefined}
        />
      )}

      {isEmpty ? (
        <EmptyState
          title="Nothing needs recovering right now"
          body="The provider is connected and synced. When a payment fails, its case appears here with the evidence and the next step."
        />
      ) : (
        <>
          <section aria-label="Key metrics" className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
            <MetricCard
              label="Cash recovered · 30 days"
              value={formatMoney(data.cashRecovered30d ?? { minor: 0, currency: "USD" })}
              clarifier="Settled, provider-confirmed recoveries"
              footnote="Demo fixture — labeled illustrative on purpose"
            />
            <MetricCard
              label="Revenue at risk"
              value={formatMoney(data.mrrAtRisk ?? { minor: 0, currency: "USD" })}
              clarifier="Exposure — open failed payments, not yet lost or recovered"
              footnote="Demo fixture"
            />
            <MetricCard
              label="Potential upgrade MRR"
              value={formatMoney(data.potentialMrr ?? { minor: 0, currency: "USD" })}
              clarifier="Potential — not collected cash"
              footnote="Demo fixture"
            />
            <MetricCard
              label="Recovery rate"
              value={formatPercent(data.recoveryRatePct)}
              clarifier="Confirmed recoveries ÷ decided cases"
              footnote={data.recoveryRatePct === null ? "No decided cases yet — unknown, not zero" : "Demo fixture"}
            />
          </section>

          <section aria-label="Recovered vs lost" className="glass p-5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <h2 className="text-[15px] font-bold text-ink">Recovered vs. lost, week by week</h2>
              <span className="font-mono text-[11.5px] text-ink-4">provider-confirmed outcomes only</span>
            </div>
            <div className="mt-3">
              <AccessibleChart
                currency="USD"
                caption="Weekly recovered versus lost revenue, demo fixture data"
                data={data.series.map((p) => ({
                  label: new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(p.weekStart)),
                  recoveredMinor: p.recoveredMinor,
                  lostMinor: p.lostMinor
                }))}
              />
            </div>
          </section>

          <div className="grid gap-4 lg:grid-cols-[1.1fr_.9fr]">
            <section aria-label="Pending approvals" className="glass p-5">
              <h2 className="text-[15px] font-bold text-ink">Approvals waiting for you</h2>
              <p className="mt-1 text-[13.5px] text-ink-3">
                {data.approvalsPending === 0
                  ? "Nothing is waiting. Nothing is ever sent without an approval."
                  : `${data.approvalsPending} draft${data.approvalsPending === 1 ? "" : "s"} need a human decision.`}
              </p>
              <div className="mt-4 flex flex-wrap gap-2.5">
                <Link href={`/app/${slug}/recovery`} className="btn btn-glass btn-sm">Review recovery drafts</Link>
                <Link href={`/app/${slug}/expansion`} className="btn btn-glass btn-sm">Review expansion drafts</Link>
              </div>
            </section>

            <section aria-label="Recent activity" className="glass p-5">
              <h2 className="text-[15px] font-bold text-ink">Recent activity</h2>
              <ol className="mt-3 flex flex-col divide-y divide-line-soft">
                {data.activity.length === 0 ? (
                  <li className="py-2 text-[13.5px] text-ink-3">No activity yet.</li>
                ) : (
                  data.activity.map((a) => (
                    <li key={a.id} className="flex flex-wrap items-baseline justify-between gap-x-4 py-2.5">
                      <span className="text-[13.5px] text-ink-2">{a.text}</span>
                      <span className="num font-mono text-[11.5px] text-ink-4">{formatDateTime(a.at)}</span>
                    </li>
                  ))
                )}
              </ol>
            </section>
          </div>

          <p className="px-1 text-[12px] text-ink-4">
            Every figure on this page comes from the labeled demo fixture store — no provider, payment
            or email system is connected in Phase 2.
          </p>
        </>
      )}
    </div>
  );
}
