"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { DECLINE_CATEGORY_LABEL, computeFreshness } from "@revessent/domain";
import { DataTable, EmptyState, ErrorState, FreshnessBanner, SkeletonTable, Surface, type Column } from "@revessent/ui";
import type { RecoveryCase } from "@revessent/contracts";
import { amountLabel, formatDateTime } from "@/lib/format";
import { useCases, useStripeConnection } from "@/lib/queries";
import { CaseChip } from "./status-chips";

const STATUS_OPTIONS = ["all", "analyzing", "retrying", "contacting", "checkout", "recovered", "lost", "canceled", "dismissed"] as const;

export function RecoveryListView({ orgSlug }: { orgSlug: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const status = params.get("status") ?? "all";
  const q = params.get("q") ?? "";

  const conn = useStripeConnection(orgSlug);
  const cases = useCases(orgSlug, { status, q });

  function setParam(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value && value !== "all") next.set(key, value);
    else next.delete(key);
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  }

  if (conn.data && (conn.data.status === "not_connected" || conn.data.status === "revoked")) {
    return (
      <div className="mx-auto w-[min(640px,100%)] pt-6">
        <EmptyState
          title="Stripe isn't connected"
          body="Recovery cases appear once a provider connection is syncing. Connect a restricted key to begin."
          action={<Link href={`/app/${orgSlug}/settings/stripe`} className="btn btn-pri">Connect Stripe</Link>}
        />
      </div>
    );
  }

  const columns: Column<RecoveryCase>[] = [
    {
      key: "member",
      header: "Member",
      cell: (c) => (
        <Link href={`/app/${orgSlug}/recovery/${c.id}`} className="group block">
          <span className="font-semibold text-ink group-hover:text-accent-ink">{c.customerName}</span>
          <span className="block text-[12px] text-ink-3">{c.customerEmail}</span>
        </Link>
      )
    },
    {
      key: "amount",
      header: "Amount",
      cell: (c) => <span className="num font-mono text-[13.5px]">{amountLabel(c.amount, c.interval)}</span>,
      align: "right"
    },
    {
      key: "decline",
      header: "Decline",
      hideBelow: "lg",
      cell: (c) => (
        <span>
          {DECLINE_CATEGORY_LABEL[c.category]}
          <span className="num block font-mono text-[11.5px] text-ink-4">{c.declineCode}</span>
        </span>
      )
    },
    { key: "status", header: "Status", cell: (c) => <CaseChip status={c.status} /> },
    {
      key: "next",
      header: "Next action",
      hideBelow: "md",
      cell: (c) => (c.nextActionAt ? <span className="num font-mono text-[12.5px]">{formatDateTime(c.nextActionAt)}</span> : <span className="text-ink-4">—</span>),
      align: "right"
    }
  ];

  return (
    <div className="mx-auto flex w-[min(1120px,100%)] flex-col gap-5">
      <header className="flex flex-wrap items-baseline gap-3">
        <h1 className="text-[24px] font-bold tracking-[-.02em] text-ink">Recovery</h1>
        <p className="text-[13.5px] text-ink-3">Every failed payment, its evidence, and the next step.</p>
      </header>

      {conn.data ? (
        <FreshnessBanner
          freshness={computeFreshness(conn.data.lastSyncAt)}
          syncing={conn.data.backfill === "running"}
          lastSyncLabel={conn.data.lastSyncAt ? formatDateTime(conn.data.lastSyncAt) : undefined}
          actionLabel="Connection settings"
          onAction={() => router.push(`/app/${orgSlug}/settings/stripe`)}
        />
      ) : null}

      <div className="flex flex-wrap items-end gap-3" role="search" aria-label="Filter recovery cases">
        <div>
          <label htmlFor="f-status" className="mb-1 block text-[12px] font-semibold uppercase tracking-[.06em] text-ink-3">Status</label>
          <select
            id="f-status"
            value={status}
            onChange={(e) => setParam("status", e.target.value)}
            className="input !w-auto !py-2"
          >
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>{s === "all" ? "All statuses" : s}</option>
            ))}
          </select>
        </div>
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const data = new FormData(e.currentTarget);
            setParam("q", String(data.get("q") ?? ""));
          }}
        >
          <div>
            <label htmlFor="f-q" className="mb-1 block text-[12px] font-semibold uppercase tracking-[.06em] text-ink-3">Search</label>
            <input id="f-q" name="q" defaultValue={q} placeholder="Name or email" className="input !w-[210px] !py-2" />
          </div>
          <button type="submit" className="btn btn-glass btn-sm">Apply</button>
          {q ? (
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => setParam("q", "")}>Clear</button>
          ) : null}
        </form>
      </div>

      {cases.isLoading ? (
        <SkeletonTable rows={5} />
      ) : cases.error ? (
        <ErrorState
          message="The recovery queue failed to load."
          onRetry={() => void cases.refetch()}
          retrying={cases.isRefetching}
        />
      ) : (
        <DataTable
          columns={columns}
          rows={cases.data?.items ?? []}
          getKey={(c) => c.id}
          caption="Recovery cases"
          empty={
            <EmptyState
              title={status !== "all" || q ? "No cases match this filter" : "No failed payments yet"}
              body={
                status !== "all" || q
                  ? "Try clearing the search or choosing another status."
                  : "When a payment fails, the case opens here with the decline evidence and a proposed next step."
              }
              action={
                status !== "all" || q ? (
                  <button type="button" className="btn btn-glass btn-sm" onClick={() => router.replace(pathname, { scroll: false })}>
                    Clear filters
                  </button>
                ) : undefined
              }
            />
          }
          mobileCard={(c) => (
            <Surface level={2} className="p-4">
              <Link href={`/app/${orgSlug}/recovery/${c.id}`} className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-ink">{c.customerName}</span>
                  <CaseChip status={c.status} />
                </div>
                <div className="flex items-baseline justify-between">
                  <span className="num font-mono text-[13.5px]">{amountLabel(c.amount, c.interval)}</span>
                  <span className="text-[12px] text-ink-3">{DECLINE_CATEGORY_LABEL[c.category]}</span>
                </div>
              </Link>
            </Surface>
          )}
        />
      )}

      {cases.isFetching && !cases.isLoading ? (
        <p role="status" className="px-1 text-[12.5px] text-ink-3">Updating…</p>
      ) : null}
    </div>
  );
}
