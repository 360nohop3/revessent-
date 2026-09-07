"use client";

import Link from "next/link";
import { formatMoney } from "@revessent/domain";
import { EmptyState, ErrorState, Skeleton, Surface } from "@revessent/ui";
import { useOpportunities } from "@/lib/queries";
import { OpportunityChip } from "./status-chips";

export function ExpansionListView({ orgSlug }: { orgSlug: string }) {
  const opps = useOpportunities(orgSlug);

  return (
    <div className="mx-auto flex w-[min(1120px,100%)] flex-col gap-5">
      <header>
        <h1 className="text-[24px] font-bold tracking-[-.02em] text-ink">Expansion</h1>
        <p className="mt-1 max-w-[70ch] text-[13.5px] text-ink-3">
          Upgrade opportunities, drafted with evidence. Nothing is proposed to members without your
          approval, and potential figures are never shown as collected revenue.
        </p>
      </header>

      {opps.isLoading ? (
        <div className="flex flex-col gap-3" role="status" aria-label="Loading opportunities">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-28 w-full" />
        </div>
      ) : opps.error ? (
        <ErrorState message="Expansion opportunities failed to load." onRetry={() => void opps.refetch()} retrying={opps.isRefetching} />
      ) : opps.data && opps.data.items.length === 0 ? (
        <EmptyState
          title="No open opportunities"
          body="When a usage or fit signal arrives, an opportunity is drafted here for your review."
        />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {opps.data?.items.map((o) => (
            <Surface key={o.id} level={2} className="flex flex-col p-5">
              <div className="flex items-center justify-between gap-3">
                <Link href={`/app/${orgSlug}/expansion/${o.id}`} className="text-[16px] font-bold text-ink hover:text-accent-ink">
                  {o.customerName}
                </Link>
                <OpportunityChip status={o.status} />
              </div>
              <p className="mt-2 text-[13.5px] text-ink-2">
                {o.currentPlan} → <span className="font-semibold text-ink">{o.recommendedPlan}</span>
              </p>
              <p className="mt-1 text-[12.5px] text-ink-3">{o.signal}</p>
              <p className="num mt-3 font-mono text-[15px] font-semibold text-ink">
                {formatMoney(o.potentialMrr)}<span className="text-[12px] font-normal text-ink-3"> /mo potential — not collected</span>
              </p>
              <Link href={`/app/${orgSlug}/expansion/${o.id}`} className="btn btn-glass btn-sm mt-4 self-start">Open</Link>
            </Surface>
          ))}
        </div>
      )}
    </div>
  );
}
