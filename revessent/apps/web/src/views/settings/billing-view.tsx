"use client";

import { Badge, EvidenceList, Skeleton, Surface } from "@revessent/ui";
import { formatDate } from "@/lib/format";
import { useBilling } from "@/lib/queries";

export function BillingView({ orgSlug }: { orgSlug: string }) {
  const billing = useBilling(orgSlug);

  if (billing.isLoading) return <Skeleton className="h-56 w-full" role="status" aria-label="Loading billing" />;
  if (billing.error || !billing.data) {
    return <Surface level={2} className="p-6 text-[13.5px] text-ink-3">Billing info unavailable.</Surface>;
  }

  const b = billing.data;
  return (
    <div className="flex flex-col gap-4">
      <Surface level={2} className="p-6">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-[16px] font-bold text-ink">Your Revessent plan</h2>
          <Badge tone={b.status === "trialing" ? "info" : b.status === "active" ? "ok" : "warn"}>{b.status}</Badge>
        </div>
        <div className="mt-4">
          <EvidenceList
            items={[
              { label: "Pilot ends", value: b.pilotEndsAt ? formatDate(b.pilotEndsAt) : "—", source: "demo" },
              { label: "Guarantee window ends", value: b.guaranteeWindowEndsAt ? formatDate(b.guaranteeWindowEndsAt) : "—", source: "demo" }
            ]}
          />
        </div>
      </Surface>
      <Surface level={1} className="p-6">
        <p className="text-[13.5px] text-ink-2">
          <strong className="text-ink">Billing is not live in this build.</strong> Revessent bills
          through Stripe Billing in Phase 5 — until then nothing can be charged, and this screen
          only reports the demo pilot window.
        </p>
      </Surface>
    </div>
  );
}
