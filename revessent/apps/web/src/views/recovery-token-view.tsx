"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { useState } from "react";
import { formatMoney } from "@revessent/domain";
import { Button, Skeleton, Surface } from "@revessent/ui";
import { api } from "@/lib/api";

const DEMO_TOKENS_NOTE = "Demo tokens: tok_demo_valid · tok_demo_expired · tok_demo_used (anything else is unknown).";
const isDemo = process.env.NEXT_PUBLIC_DEMO_MODE === "on";

/**
 * Member-facing recovery flow (Phase 2 §14, Phase 8 Hosted Recovery Checkout).
 * The payment itself happens on Stripe's own hosted page for the exact
 * invoice (SAQ-A): this page only asks the server to verify the link and the
 * live invoice, then hands the browser to Stripe. It never renders card
 * fields and never claims success — a paid state is shown only after the
 * server has learned it from Stripe.
 */
export function RecoveryTokenView() {
  const params = useParams<{ token: string }>();
  const token = params.token;
  const query = useQuery({ queryKey: ["subscriber", "recover", token], queryFn: () => api.subscriber.recoveryToken(token) });
  const [continued, setContinued] = useState(false);
  const start = useMutation({
    mutationFn: () => api.subscriber.startRecoveryCheckout(token),
    onSuccess: (r) => { if (r.state === "ready" && r.url) window.location.assign(r.url); }
  });

  if (query.isLoading) return <Skeleton className="h-72 w-[min(480px,100%)]" />;
  if (query.error || !query.data) {
    return (
      <Surface level={2} className="w-[min(480px,100%)] p-6 text-center">
        <h1 className="text-[19px] font-bold text-ink">This link couldn't be checked</h1>
        <p className="mt-2 text-[14px] text-ink-2">The service didn't respond. Please try again in a moment.</p>
      </Surface>
    );
  }

  const info = query.data;

  if (info.state === "unknown") {
    return (
      <Surface level={2} className="w-[min(480px,100%)] p-6 text-center">
        <h1 className="text-[19px] font-bold text-ink">This link isn't recognized</h1>
        <p className="mt-2 text-[14px] text-ink-2">
          Double-check the link from your email. If it keeps failing, contact the company you
          subscribed to — they can send a fresh one.
        </p>
        {isDemo && <p className="mt-4 font-mono text-[11px] text-ink-4">{DEMO_TOKENS_NOTE}</p>}
      </Surface>
    );
  }

  if (info.state === "expired") {
    return (
      <Surface level={2} className="w-[min(480px,100%)] p-6 text-center">
        <h1 className="text-[19px] font-bold text-ink">This link has expired</h1>
        <p className="mt-2 text-[14px] text-ink-2">
          Recovery links are time-limited for your security. Ask {info.orgName ?? "the company"} for a fresh link.
        </p>
      </Surface>
    );
  }

  if (info.state === "used" || start.data?.state === "already_paid") {
    return (
      <Surface level={2} className="w-[min(480px,100%)] p-6 text-center">
        <h1 className="text-[19px] font-bold text-ink">Nothing left to pay</h1>
        <p className="mt-2 text-[14px] text-ink-2">
          This payment has already been settled with {info.orgName ?? "the company"}. No further action is needed.
        </p>
      </Surface>
    );
  }

  const refusal = start.data && start.data.state !== "ready" ? start.data.state : null;

  return (
    <Surface level={3} className="w-[min(480px,100%)] p-7">
      <p className="text-[12px] font-semibold uppercase tracking-[.08em] text-ink-3">
        Provided by Revessent on behalf of {info.orgName}
      </p>
      <h1 className="mt-2 text-[22px] font-bold tracking-[-.02em] text-ink">Complete your payment</h1>
      <p className="mt-1 text-[14px] text-ink-2">
        Your {info.productName} renewal ({formatMoney(info.amount ?? { minor: 0, currency: "USD" })}) couldn't be
        charged{info.cardLast4 ? <> to the card ending ··{info.cardLast4}</> : null}. You can settle it securely on Stripe.
      </p>

      {!continued ? (
        <>
          <ul className="mt-5 flex flex-col gap-1.5 text-[13.5px] text-ink-3">
            <li>· Takes about 30 seconds.</li>
            <li>· Card details are entered on a Stripe-secured page — this service never sees them.</li>
            <li>· Nothing else about your membership changes.</li>
          </ul>
          <Button className="mt-5 w-full" onClick={() => { setContinued(true); start.mutate(); }}>
            Continue to secure payment
          </Button>
        </>
      ) : start.isPending || start.data?.state === "ready" ? (
        <div role="status" className="mt-5">
          <p className="text-[14px] font-semibold text-ink">Preparing your secure payment…</p>
          <p className="mt-1 text-[13px] text-ink-3">
            {start.data?.state === "ready"
              ? "Opening Stripe's secure page. If nothing happens, use the link below."
              : "Checking with Stripe that the amount is still correct before opening the secure page."}
          </p>
          <Skeleton className="mt-3 h-2 w-full" />
          {start.data?.state === "ready" && start.data.url && (
            <a className="mt-4 block text-center text-[13.5px] font-semibold text-accent-ink underline" href={start.data.url}>
              Open the secure Stripe page
            </a>
          )}
        </div>
      ) : (
        <div className="mt-5">
          <div role="alert" className="rounded-lg border border-dashed border-warn/50 bg-warn/5 p-4">
            <p className="text-[13.5px] font-semibold text-warn-ink">{refusalTitle(refusal, start.isError)}</p>
            <p className="mt-1 text-[13px] text-ink-2">{refusalBody(refusal, start.isError, info.orgName)}</p>
          </div>
          <p className="mt-3 text-[13px] text-ink-3">Nothing has been charged.</p>
          {(refusal === "provider_error" || start.isError) && (
            <Button className="mt-4 w-full" variant="glass" onClick={() => start.mutate()} disabled={start.isPending}>
              Try again
            </Button>
          )}
        </div>
      )}
    </Surface>
  );
}

function refusalTitle(state: string | null, networkError: boolean): string {
  if (networkError) return "We couldn't reach the service";
  switch (state) {
    case "expired": return "This link is no longer valid";
    case "unavailable": return "This payment can't be completed from this link";
    case "provider_unavailable": return "Secure payment isn't available right now";
    case "provider_error": return "Stripe didn't respond";
    default: return "This link isn't recognized";
  }
}

function refusalBody(state: string | null, networkError: boolean, orgName: string | null): string {
  const org = orgName ?? "the company";
  if (networkError) return "Please check your connection and try again in a moment.";
  switch (state) {
    case "expired": return `Recovery links are time-limited or may have been replaced. Ask ${org} for a fresh link.`;
    case "unavailable": return `The invoice behind this link has changed since it was sent (for example its amount or status). Contact ${org} so they can send an up-to-date link.`;
    case "provider_unavailable": return `${org} needs to finish their payment setup before this link can be used. Please contact them directly.`;
    case "provider_error": return "This is usually temporary. Try again in a moment — nothing was charged.";
    default: return `Double-check the link from your email or contact ${org} for a fresh one.`;
  }
}
