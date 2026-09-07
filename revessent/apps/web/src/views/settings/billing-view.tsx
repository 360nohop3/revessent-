"use client";

import { PLANS } from "@revessent/domain";
import { Badge, EvidenceList, Skeleton, Surface } from "@revessent/ui";
import { formatDate } from "@/lib/format";
import { useBilling, useEntitlements } from "@/lib/queries";

const CAPABILITY_LABELS: Record<string, string> = {
  smart_retries: "Smart retries",
  recovery_checkout: "Recovery checkout",
  ai_notes: "AI recovery notes",
  upgrade_signals: "Upgrade signals",
  weekly_digest: "Weekly forensics digest",
  trust_autonomy: "Trust-level autonomy"
};

/**
 * Phase 7: current plan, billing status, capabilities and usage/limits — all
 * read from the server-resolved entitlements. This screen displays; it never
 * decides. There is no client-side plan switch: plan changes arrive only via
 * verified Stripe Billing webhooks.
 */
export function BillingView({ orgSlug }: { orgSlug: string }) {
  const billing = useBilling(orgSlug);
  const ent = useEntitlements(orgSlug);

  if (billing.isLoading || ent.isLoading) return <Skeleton className="h-56 w-full" role="status" aria-label="Loading billing" />;
  if (billing.error || !billing.data) {
    return <Surface level={2} className="p-6 text-[13.5px] text-ink-3">Billing info unavailable.</Surface>;
  }

  const b = billing.data;
  const e = ent.data ?? null;
  const tone = b.status === "trialing" ? "info" : b.status === "active" ? "ok" : "warn";
  return (
    <div className="flex flex-col gap-4">
      <Surface level={2} className="p-6">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-[16px] font-bold text-ink">Your Revessent plan</h2>
          <Badge tone="neutral">{PLANS[b.plan].label}</Badge>
          <Badge tone={tone}>{b.status.replace(/_/g, " ")}</Badge>
          {b.restricted ? <Badge tone="warn">restricted to {PLANS[b.effectivePlan].label}</Badge> : null}
        </div>
        {b.restricted ? (
          <p className="mt-3 text-[13.5px] text-ink-2" role="status">
            Your {PLANS[b.plan].label} subscription is {b.status.replace(/_/g, " ")}. Paid capabilities are paused
            until billing is resolved; smart retries and recovery checkout continue on the {PLANS[b.effectivePlan].label} baseline.
          </p>
        ) : null}
        <div className="mt-4">
          <EvidenceList
            items={[
              { label: "Pilot ends", value: b.pilotEndsAt ? formatDate(b.pilotEndsAt) : "—", source: b.billingProviderLive ? "live" : "demo" },
              { label: "Current period ends", value: b.currentPeriodEnd ? formatDate(b.currentPeriodEnd) : "—", source: b.billingProviderLive ? "live" : "demo" },
              { label: "Cancels at period end", value: b.cancelAtPeriodEnd ? "Yes" : "No", source: b.billingProviderLive ? "live" : "demo" },
              { label: "Guarantee window ends", value: b.guaranteeWindowEndsAt ? formatDate(b.guaranteeWindowEndsAt) : "—", source: "demo" }
            ]}
          />
        </div>
      </Surface>

      {e ? (
        <Surface level={2} className="p-6">
          <h3 className="text-[14px] font-bold text-ink">What this workspace can do</h3>
          <ul className="mt-3 grid gap-2 sm:grid-cols-2" aria-label="Capabilities">
            {Object.entries(e.capabilities).map(([key, on]) => (
              <li key={key} className="flex items-center justify-between rounded-md border border-line px-3 py-2 text-[13px]">
                <span className="text-ink-2">{CAPABILITY_LABELS[key] ?? key}</span>
                <Badge tone={on ? "ok" : "neutral"}>{on ? "included" : "not included"}</Badge>
              </li>
            ))}
          </ul>
          <div className="mt-4">
            <EvidenceList
              items={[
                { label: "Team seats", value: `${e.usage.seatsUsed} / ${e.limits.seats}`, source: "live" },
                { label: "Members", value: e.limits.memberCap === null ? `${e.usage.members} / unlimited` : `${e.usage.members} / ${e.limits.memberCap}`, source: "live" }
              ]}
            />
            {e.overMemberCap ? (
              <p className="mt-2 text-[13px] text-ink-2" role="status">
                This workspace is above the {PLANS[e.effectivePlan].label} member cap. Existing recovery work continues; upgrade to stay within plan.
              </p>
            ) : null}
          </div>
        </Surface>
      ) : null}

      <Surface level={1} className="p-6">
        <p className="text-[13.5px] text-ink-2">
          {b.billingProviderLive ? (
            <><strong className="text-ink">Synchronised from Stripe Billing.</strong> Plan changes arrive only through verified billing events; nothing on this page can change your plan.</>
          ) : (
            <><strong className="text-ink">No billing events received yet.</strong> This workspace is on the default record; plan changes arrive only through verified Stripe Billing events.</>
          )}
        </p>
      </Surface>
    </div>
  );
}
