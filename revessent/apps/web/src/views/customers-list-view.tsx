"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { formatMoney } from "@revessent/domain";
import { Badge, DataTable, EmptyState, ErrorState, SkeletonTable, type Column } from "@revessent/ui";
import type { Customer } from "@revessent/contracts";
import { useCustomers } from "@/lib/queries";

const STATUS_OPTIONS = ["all", "active", "past_due", "canceled"] as const;

const RISK_BADGE: Record<Customer["riskStatus"], { label: string; tone: "neutral" | "warn" | "info" | "err" }> = {
  none: { label: "Healthy", tone: "neutral" },
  at_risk: { label: "At risk", tone: "warn" },
  recovering: { label: "In recovery", tone: "info" },
  lost: { label: "Lost", tone: "err" }
};

export function CustomersListView({ orgSlug }: { orgSlug: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const status = params.get("status") ?? "all";
  const q = params.get("q") ?? "";
  const customers = useCustomers(orgSlug, { status, q });

  function setParam(key: string, value: string) {
    const next = new URLSearchParams(params);
    if (value && value !== "all") next.set(key, value);
    else next.delete(key);
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  }

  const columns: Column<Customer>[] = [
    {
      key: "name",
      header: "Customer",
      cell: (c) => (
        <Link href={`/app/${orgSlug}/customers/${c.id}`} className="group">
          <span className="font-semibold text-ink group-hover:text-accent-ink">{c.name}</span>
          <span className="block text-[12px] text-ink-3">{c.email}</span>
        </Link>
      )
    },
    { key: "status", header: "Subscription", cell: (c) => <Badge tone={c.status === "active" ? "ok" : c.status === "past_due" ? "warn" : "neutral"}>{c.status.replace("_", " ")}</Badge> },
    { key: "mrr", header: "MRR", align: "right", cell: (c) => <span className="num font-mono text-[13.5px]">{formatMoney(c.mrr)}</span> },
    { key: "risk", header: "Risk", hideBelow: "lg", cell: (c) => <Badge tone={RISK_BADGE[c.riskStatus].tone}>{RISK_BADGE[c.riskStatus].label}</Badge> },
    { key: "expansion", header: "Expansion", hideBelow: "md", cell: (c) => <span className="text-[12.5px] text-ink-3">{c.expansionStatus === "none" ? "—" : c.expansionStatus}</span> }
  ];

  return (
    <div className="mx-auto flex w-[min(1120px,100%)] flex-col gap-5">
      <header>
        <h1 className="text-[24px] font-bold tracking-[-.02em] text-ink">Customers</h1>
        <p className="mt-1 text-[13.5px] text-ink-3">The directory mirrors your provider — it is read-only in Phase 2.</p>
      </header>

      <div className="flex flex-wrap items-end gap-3" role="search" aria-label="Filter customers">
        <div>
          <label htmlFor="c-status" className="mb-1 block text-[12px] font-semibold uppercase tracking-[.06em] text-ink-3">Status</label>
          <select id="c-status" value={status} onChange={(e) => setParam("status", e.target.value)} className="input !w-auto !py-2">
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>{s === "all" ? "All statuses" : s.replace("_", " ")}</option>
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
            <label htmlFor="c-q" className="mb-1 block text-[12px] font-semibold uppercase tracking-[.06em] text-ink-3">Search</label>
            <input id="c-q" name="q" defaultValue={q} placeholder="Name or email" className="input !w-[210px] !py-2" />
          </div>
          <button type="submit" className="btn btn-glass btn-sm">Apply</button>
        </form>
      </div>

      {customers.isLoading ? (
        <SkeletonTable rows={5} />
      ) : customers.error ? (
        <ErrorState message="Customers failed to load." onRetry={() => void customers.refetch()} retrying={customers.isRefetching} />
      ) : (
        <DataTable
          columns={columns}
          rows={customers.data?.items ?? []}
          getKey={(c) => c.id}
          caption="Customers"
          empty={
            <EmptyState
              title="No customers match"
              body="Adjust the filters, or connect Stripe to sync your directory."
            />
          }
          mobileCard={(c) => (
            <Link href={`/app/${orgSlug}/customers/${c.id}`} className="glass block p-4">
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-ink">{c.name}</span>
                <Badge tone={c.status === "active" ? "ok" : c.status === "past_due" ? "warn" : "neutral"}>{c.status.replace("_", " ")}</Badge>
              </div>
              <span className="num mt-1 block font-mono text-[13px] text-ink-2">{formatMoney(c.mrr)} /mo</span>
            </Link>
          )}
        />
      )}
    </div>
  );
}
