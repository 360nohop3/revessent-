"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { ErrorState, EvidenceList, Skeleton } from "@revessent/ui";
import { formatMoney } from "@revessent/domain";
import { useOpportunity } from "@/lib/queries";
import { roleFor, useSession } from "@/components/session";
import { OpportunityChip } from "./status-chips";
import { DraftMessageCard } from "./draft-message-card";
import { DemoProviderControls } from "./demo-provider-controls";

export function ExpansionDetailView() {
  const params = useParams<{ orgSlug: string; opportunityId: string }>();
  const slug = params.orgSlug;
  const id = params.opportunityId;
  const session = useSession();
  const role = roleFor(session, slug);
  const query = useOpportunity(slug, id);

  if (query.isLoading) {
    return (
      <div className="mx-auto flex w-[min(900px,100%)] flex-col gap-4" role="status" aria-label="Loading opportunity">
        <Skeleton className="h-9 w-72" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  if (query.error || !query.data) {
    return (
      <div className="mx-auto w-[min(640px,100%)] pt-6">
        <ErrorState
          title="Opportunity unavailable"
          message="This opportunity couldn't be loaded."
          onRetry={() => void query.refetch()}
          retrying={query.isRefetching}
        />
        <div className="mt-4 text-center">
          <Link href={`/app/${slug}/expansion`} className="btn btn-glass btn-sm">Back to expansion</Link>
        </div>
      </div>
    );
  }

  const opp = query.data;
  const qk = ["org", slug, "opportunity", id] as const;

  return (
    <div className="mx-auto flex w-[min(900px,100%)] flex-col gap-5">
      <nav aria-label="Breadcrumb" className="text-[12.5px] text-ink-3">
        <Link href={`/app/${slug}/expansion`} className="underline underline-offset-2 hover:text-ink">Expansion</Link>
        <span aria-hidden="true"> / </span>
        <span className="text-ink-2">{opp.customerName}</span>
      </nav>

      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-[24px] font-bold tracking-[-.02em] text-ink">{opp.customerName}</h1>
        <OpportunityChip status={opp.status} />
        <span className="num ml-auto font-mono text-[14px] text-ink-2">
          {formatMoney(opp.potentialMrr)}<span className="text-[12px] text-ink-3"> /mo potential — not collected</span>
        </span>
      </header>

      <section aria-label="Evidence" className="glass p-5">
        <h2 className="text-[15px] font-bold text-ink">Signal &amp; evidence</h2>
        <div className="mt-3">
          <EvidenceList
            items={[
              { label: "Signal", value: opp.signal, source: "operator" },
              { label: "Current plan", value: opp.currentPlan, source: "Stripe" },
              { label: "Recommended", value: opp.recommendedPlan, source: "policy" },
              { label: "Potential", value: `${formatMoney(opp.potentialMrr)} /mo`, source: "calc" }
            ]}
          />
        </div>
        <p className="mt-3 text-[13px] text-ink-3">{opp.signalEvidence}</p>
        <p className="mt-2 max-w-[72ch] text-[13.5px] text-ink-2">{opp.rationale}</p>
      </section>

      <DraftMessageCard
        slug={slug}
        kind="opportunity"
        parentId={opp.id}
        queryKey={qk}
        draft={opp.draft}
        role={role}
        title="Upgrade pitch"
      />

      {opp.draft ? <DemoProviderControls slug={slug} kind="opportunity" parentId={opp.id} queryKey={qk} status={opp.draft.approvalStatus} /> : null}
    </div>
  );
}
