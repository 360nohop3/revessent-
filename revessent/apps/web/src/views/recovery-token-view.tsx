"use client";

import { useQuery } from "@tanstack/react-query";
import { useParams } from "next/navigation";
import { useState } from "react";
import { formatMoney } from "@revessent/domain";
import { Button, Skeleton, Surface } from "@revessent/ui";
import { api } from "@/lib/api";

const DEMO_TOKENS_NOTE = "Demo tokens: tok_demo_valid · tok_demo_expired · tok_demo_used (anything else is unknown).";

/**
 * Member-facing recovery flow (Phase 2 §14). The card update itself is
 * Stripe-hosted in production (SAQ-A); until the Phase 5 backend exists we
 * show an explicit placeholder — never a look-alike form, never a fake success.
 */
export function RecoveryTokenView() {
  const params = useParams<{ token: string }>();
  const token = params.token;
  const query = useQuery({ queryKey: ["subscriber", "recover", token], queryFn: () => api.subscriber.recoveryToken(token) });
  const [continued, setContinued] = useState(false);
  const [validated, setValidated] = useState(false);

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
        <p className="mt-4 font-mono text-[11px] text-ink-4">{DEMO_TOKENS_NOTE}</p>
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

  if (info.state === "used") {
    return (
      <Surface level={2} className="w-[min(480px,100%)] p-6 text-center">
        <h1 className="text-[19px] font-bold text-ink">This link was already used</h1>
        <p className="mt-2 text-[14px] text-ink-2">
          If your payment still didn't go through, contact {info.orgName ?? "the company"} for a new link.
        </p>
      </Surface>
    );
  }

  return (
    <Surface level={3} className="w-[min(480px,100%)] p-7">
      <p className="text-[12px] font-semibold uppercase tracking-[.08em] text-ink-3">
        Provided by Revessent on behalf of {info.orgName}
      </p>
      <h1 className="mt-2 text-[22px] font-bold tracking-[-.02em] text-ink">Update your card</h1>
      <p className="mt-1 text-[14px] text-ink-2">
        Your {info.productName} renewal ({formatMoney(info.amount ?? { minor: 0, currency: "USD" })}) couldn't be
        charged because the card ending ··{info.cardLast4} has expired.
      </p>

      {!continued ? (
        <>
          <ul className="mt-5 flex flex-col gap-1.5 text-[13.5px] text-ink-3">
            <li>· Takes about 30 seconds.</li>
            <li>· Card details are entered on a Stripe-secured page — this service never sees them.</li>
            <li>· Nothing else about your membership changes.</li>
          </ul>
          <Button className="mt-5 w-full" onClick={() => setContinued(true)}>
            Continue
          </Button>
        </>
      ) : !validated ? (
        <div role="status" className="mt-5">
          <p className="text-[14px] font-semibold text-ink">Preparing your secure update…</p>
          <p className="mt-1 text-[13px] text-ink-3">Checking that the link is still valid before opening the secure page.</p>
          <Skeleton className="mt-3 h-2 w-full" />
          <Button className="mt-4 w-full" variant="glass" onClick={() => setValidated(true)}>
            (demo) Validation done — show next step
          </Button>
        </div>
      ) : (
        <div className="mt-5">
          <div role="note" className="rounded-lg border border-dashed border-warn/50 bg-warn/5 p-4">
            <p className="text-[13.5px] font-semibold text-warn-ink">Stripe-hosted form opens here in production</p>
            <p className="mt-1 text-[13px] text-ink-2">
              The Phase 5 backend creates a Stripe-hosted card-update session and hands this page to
              it. Revessent never renders card fields itself — that boundary is the point.
            </p>
          </div>
          <p className="mt-4 text-[13px] text-ink-3">
            After your bank confirms the update, this page shows a pending state while the payment
            is retried. <strong className="text-ink-2">Nothing has been charged in this build.</strong>
          </p>
        </div>
      )}
    </Surface>
  );
}
