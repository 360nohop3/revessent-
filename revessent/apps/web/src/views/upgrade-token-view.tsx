"use client";

import { useQuery } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { formatMoney } from "@revessent/domain";
import { Skeleton, Surface } from "@revessent/ui";
import { api } from "@/lib/api";

export function UpgradeTokenView() {
  const params = useParams<{ token: string }>();
  const query = useQuery({ queryKey: ["subscriber", "upgrade", params.token], queryFn: () => api.subscriber.upgradeToken(params.token) });

  if (query.isLoading) return <Skeleton className="h-72 w-[min(480px,100%)]" />;
  const info = query.data;

  if (!info || info.state !== "valid") {
    return (
      <Surface level={2} className="w-[min(480px,100%)] p-6 text-center">
        <h1 className="text-[19px] font-bold text-ink">This link isn't available</h1>
        <p className="mt-2 text-[14px] text-ink-2">It may have expired or already been used. Ask the company for a fresh link.</p>
      </Surface>
    );
  }

  return (
    <Surface level={3} className="w-[min(480px,100%)] p-7">
      <p className="text-[12px] font-semibold uppercase tracking-[.08em] text-ink-3">{info.orgName}</p>
      <h1 className="mt-2 text-[22px] font-bold tracking-[-.02em] text-ink">
        Move from {info.currentPlan} to {info.recommendedPlan}?
      </h1>
      <p className="mt-2 text-[14px] text-ink-2">
        This changes your plan price by {formatMoney(info.delta ?? { minor: 0, currency: "USD" })} per
        month, starting from your next renewal. You can switch back anytime.
      </p>
      <div role="note" className="mt-5 rounded-lg border border-dashed border-warn/50 bg-warn/5 p-4">
        <p className="text-[13.5px] font-semibold text-warn-ink">Stripe-hosted checkout opens here in production</p>
        <p className="mt-1 text-[13px] text-ink-2">
          The upgrade is billed by Stripe once you confirm on their secure page (Phase 5 backend).
          Nothing is confirmed in this build.
        </p>
      </div>
    </Surface>
  );
}
