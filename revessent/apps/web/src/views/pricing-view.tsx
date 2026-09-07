"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { z } from "zod";
import { PLANS, type PlanName } from "@revessent/domain";
import { formatMoney } from "@/lib/format";
import { Badge, Button, FormField, Input, Surface, cx } from "@revessent/ui";

const EmailSchema = z.string().trim().regex(/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/, "Enter a valid work email.");

/** Feature lists rendered from the plan matrix — the Studio line items the
 *  demo sold (SSO, API, multi-brand, SLA) are NOT in v1 and are labeled
 *  "coming soon" rather than promised (Phase 2 §11, Architecture B-3). */
const FEATURES: Record<PlanName, { text: string; muted?: boolean; soon?: boolean }[]> = {
  ember: [
    { text: "14-day full pilot, no card required" },
    { text: "Smart retries + recovery checkout" },
    { text: "Up to 1,000 members" },
    { text: "Upgrade signals", muted: true, soon: true },
    { text: "Weekly forensics digest", muted: true, soon: true }
  ],
  revessent: [
    { text: "Everything in Ember, unlimited members" },
    { text: "Upgrade signals — drafted, approved, sent" },
    { text: "Recovery notes in your brand voice" },
    { text: "Weekly decline forensics digest" },
    { text: "5 team seats" }
  ],
  studio: [
    { text: "Everything in Revessent" },
    { text: "More team seats (15)" },
    { text: "Slack alerts", muted: true, soon: true },
    { text: "SSO / SAML", muted: true, soon: true },
    { text: "API + webhooks, multi-brand, 99.9% SLA", muted: true, soon: true }
  ]
};

const FAQ = [
  {
    q: "Which billing platforms do you support?",
    a: "Stripe is the native integration — connect in about six minutes, read-only to start. Chargebee and Recurly connectors are planned next."
  },
  {
    q: "What counts as a recovery?",
    a: "Any payment Revessent's retries, notes, or recovery checkout wins back within 90 days of the first failure. Every dollar is attributed per member, so you always know what you're paying for."
  },
  {
    q: "Will you email our customers as \"Revessent\"?",
    a: "Never. Every note goes out in your name, written to sound like you. During the pilot every send requires your approval."
  },
  {
    q: "Is this PCI-scope-heavy?",
    a: "No. Revessent never touches raw card numbers — card updates happen on Stripe-hosted surfaces. Read-only access first; revoke in one click."
  }
];

export function PricingView() {
  const router = useRouter();
  const params = useSearchParams();
  const annual = params.get("billing") === "annual";

  const [email, setEmail] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [pilotNotice, setPilotNotice] = useState<string | null>(null);

  function setBilling(value: "monthly" | "annual") {
    router.replace(value === "annual" ? "/pricing?billing=annual" : "/pricing", { scroll: false });
  }

  function submitPilot(e: React.FormEvent) {
    e.preventDefault();
    const parsed = EmailSchema.safeParse(email);
    if (!parsed.success) {
      setEmailError(parsed.error.issues[0]?.message ?? "Enter a valid work email.");
      setPilotNotice(null);
      return;
    }
    setEmailError(null);
    // Honest stop: pilot provisioning needs the Phase 3/4 backend. Nothing was sent.
    setPilotNotice(
      "This demo stops here on purpose — pilot signup arrives with the Phase 3/4 backend. Nothing was submitted and no email was sent."
    );
  }

  return (
    <div className="mx-auto w-[min(1120px,100%-48px)] py-16">
      <div className="mx-auto max-w-[680px] text-center">
        <span className="pill mx-auto">Outcome pricing — paid for by the revenue it recovers</span>
        <h1 className="mt-5 text-[clamp(30px,4.6vw,48px)] font-bold tracking-[-.03em] text-ink">
          Plans that pay for <em className="serif-em">themselves</em>.
        </h1>
        <p className="mt-4 text-[16px] text-ink-2">
          If Revessent doesn't recover more than it costs in the first 90 days, your fees are
          refunded. That's not a discount — it's how confident we are.
        </p>
      </div>

      <div className="mt-8 flex items-center justify-center gap-3" role="group" aria-label="Billing period">
        <span id="lab-mo" className={cx("text-[14px] font-semibold", !annual ? "text-ink" : "text-ink-3")}>Monthly</span>
        <button
          type="button"
          role="switch"
          aria-checked={annual}
          aria-label="Annual billing, saves 20 percent"
          onClick={() => setBilling(annual ? "monthly" : "annual")}
          className={cx(
            "relative h-8 w-[52px] rounded-full border border-edge bg-well/60 transition-colors",
            annual && "bg-action/80"
          )}
        >
          <span
            className={cx(
              "absolute top-1/2 h-6 w-6 -translate-y-1/2 rounded-full bg-page shadow transition-[left]",
              annual ? "left-[24px]" : "left-[3px]"
            )}
            aria-hidden="true"
          />
        </button>
        <span id="lab-an" className={cx("text-[14px] font-semibold", annual ? "text-ink" : "text-ink-3")}>
          Annual <span className="text-ok-ink">save 20%</span>
        </span>
      </div>

      <div className="mt-9 grid gap-4 md:grid-cols-3">
        {(Object.keys(PLANS) as PlanName[]).map((name) => {
          const plan = PLANS[name];
          const price = annual ? plan.annualMinor : plan.monthlyMinor;
          const featured = name === "revessent";
          return (
            <Surface key={name} level={featured ? 3 : 1} className={cx("relative flex flex-col p-6", featured && "border-accent/40 shadow-[var(--sh-md)]")}>
              {featured ? (
                <span className="absolute -top-3 left-6"><Badge tone="info">Most chosen</Badge></span>
              ) : null}
              <h2 className="text-[15px] font-bold uppercase tracking-[.08em] text-ink-2">{plan.label}</h2>
              <p className="num mt-3 font-mono text-[34px] font-semibold leading-none text-ink">
                {price === 0 ? "$0" : formatMoney({ minor: price, currency: "USD" })}
                <span className="text-[14px] font-medium text-ink-3">/month</span>
              </p>
              {annual && price > 0 ? <p className="mt-1 text-[12px] text-ok-ink">billed annually — 20% off</p> : <p className="mt-1 text-[12px] text-ink-4">{price === 0 ? "free while you evaluate" : "billed monthly"}</p>}
              <ul className="mt-5 flex flex-1 flex-col gap-2.5">
                {FEATURES[name].map((f) => (
                  <li key={f.text} className={cx("flex items-start gap-2.5 text-[14px]", f.muted ? "text-ink-3" : "text-ink-2")}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" className="mt-1 flex-none text-ok" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>
                    <span>
                      {f.text}
                      {f.soon ? <Badge tone="neutral" className="ml-2 !py-0 text-[10.5px]">coming soon</Badge> : null}
                    </span>
                  </li>
                ))}
              </ul>
              <Link href="/sign-up" className={cx("btn mt-6", featured ? "btn-pri" : "btn-glass")}>
                {price === 0 ? "Start free pilot" : "Start free pilot"}
              </Link>
            </Surface>
          );
        })}
      </div>

      <Surface level={2} className="mt-8 flex flex-col gap-2 p-6 md:flex-row md:items-center md:gap-5">
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className="flex-none text-accent-ink" aria-hidden="true">
          <path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1 1 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z" />
        </svg>
        <div>
          <p className="text-[15px] font-bold text-ink">The Revessent guarantee</p>
          <p className="mt-1 max-w-[78ch] text-[13.5px] text-ink-2">
            Recoveries are attributed per member, per email, per retry. If your net recovered
            revenue doesn't exceed your platform fee in the first 90 days, we refund the full term —
            and you keep everything recovered.
          </p>
        </div>
      </Surface>

      <section aria-labelledby="faq-h" className="mt-14 max-w-[760px]">
        <h2 id="faq-h" className="text-[22px] font-bold tracking-[-.02em] text-ink">Questions, answered</h2>
        <div className="mt-5 flex flex-col gap-2.5">
          {FAQ.map((f) => (
            <details key={f.q} className="glass group px-5 py-4">
              <summary className="cursor-pointer list-none text-[15px] font-semibold text-ink marker:hidden">
                {f.q}
                <span aria-hidden="true" className="float-right text-ink-3 group-open:rotate-45 transition-transform">+</span>
              </summary>
              <p className="mt-3 max-w-[68ch] text-[14px] text-ink-2">{f.a}</p>
            </details>
          ))}
        </div>
      </section>

      <section className="mt-12">
        <Surface level={2} className="flex flex-col items-center gap-4 px-8 py-10 text-center">
          <h2 className="text-[24px] font-bold tracking-[-.02em] text-ink">Meet the member you almost lost.</h2>
          <form className="flex w-full max-w-[520px] flex-col gap-3 sm:flex-row" onSubmit={submitPilot} noValidate>
            <FormField id="pilot-email" label="Work email" error={emailError} className="flex-1 !gap-1 [&>label]:sr-only">
              <Input
                type="email"
                name="email"
                autoComplete="email"
                placeholder="you@yourcompany.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </FormField>
            <Button type="submit" className="sm:self-start">Start free pilot</Button>
          </form>
          <p role="status" aria-live="polite" className="max-w-[52ch] text-[13px] text-ink-3">
            {pilotNotice ?? "14 days free · no card required · cancel anytime"}
          </p>
        </Surface>
      </section>
    </div>
  );
}
