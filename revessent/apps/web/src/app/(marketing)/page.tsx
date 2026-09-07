import type { Metadata } from "next";
import Link from "next/link";
import { Badge, Surface } from "@revessent/ui";

export const metadata: Metadata = { title: "Never lose another member to a failed card" };

const STEPS = [
  { k: "Detect", v: "Failed payments surface the moment your provider reports them — decline reason included." },
  { k: "Understand", v: "Each failure is read in context: decline category, member history, what has worked before." },
  { k: "Decide", v: "A calm, explainable policy chooses the next step — a timed retry, a note in your voice, or a checkout link." },
  { k: "Recover", v: "Members get one clear, respectful path back. Nothing is sent without your approval." },
  { k: "Learn", v: "Every outcome is attributed per member, per note, per retry — so the weekly picture is honest." }
];

const VALUES = [
  { t: "Retries at the right moment", v: "Retries follow a policy you can read and adjust — timed to each member's own payment pattern, inside quiet hours." },
  { t: "Recovery notes in your voice", v: "Notes are drafted to sound like you, and every send is approval-gated. Your members hear from you, never from us." },
  { t: "A checkout that finishes", v: "A branded recovery page your members can trust — card updates happen on Stripe-hosted surfaces, so card numbers never touch Revessent." },
  { t: "Trust by construction", v: "Read-only access to start, one-click revoke, per-dollar attribution, and language that never overpromises." }
];

export default function HomePage() {
  return (
    <div className="mx-auto w-[min(1120px,100%-48px)]">
      <section className="grid items-center gap-10 py-16 md:grid-cols-[1.05fr_.95fr] md:py-24">
        <div>
          <div className="flex flex-wrap gap-2.5">
            <span className="pill"><span className="h-1.5 w-1.5 rounded-full bg-accent" aria-hidden="true" />Revenue intelligence</span>
            <span className="pill"><span className="h-1.5 w-1.5 rounded-full bg-ok" aria-hidden="true" />14-day free pilot · Stripe-native</span>
          </div>
          <h1 className="mt-6 text-[clamp(34px,5.2vw,56px)] font-bold leading-[1.06] tracking-[-.03em] text-ink">
            Never lose another <em className="serif-em">member</em> to a failed card.
          </h1>
          <p className="mt-5 max-w-[54ch] text-[17px] leading-relaxed text-ink-2">
            Revessent recovers revenue that would otherwise be lost. It intelligently decides{" "}
            <em>when</em> and <em>how</em> to retry each failed payment — timed to the member's
            history, sent in your voice, and tracked to the dollar.
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <Link href="/sign-up" className="btn btn-pri">Start your free pilot</Link>
            <Link href="/product" className="btn btn-glass">See Revessent in action</Link>
          </div>
          <p className="mt-6 text-[13px] text-ink-3">
            Stripe-native · No full card numbers · PCI-conscious architecture
          </p>
        </div>

        {/* Product preview — explicitly illustrative */}
        <Surface level={2} className="p-5">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-[14px] font-bold text-ink">Example workspace</p>
              <p className="text-[12px] text-ink-3">stripe test · illustrative data</p>
            </div>
            <Badge tone="warn">Demo data</Badge>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-3">
            <div className="rounded-md border border-line bg-well/40 p-3.5">
              <p className="text-[11.5px] font-semibold uppercase tracking-[.07em] text-ink-3">Recovered · 30 days</p>
              <p className="num mt-1 font-mono text-[22px] font-semibold text-ink">$18,240</p>
              <p className="text-[11.5px] text-ink-4">illustrative figure — not a live workspace</p>
            </div>
            <div className="rounded-md border border-line bg-well/40 p-3.5">
              <p className="text-[11.5px] font-semibold uppercase tracking-[.07em] text-ink-3">Revenue at risk</p>
              <p className="num mt-1 font-mono text-[22px] font-semibold text-ink">$4,830</p>
              <p className="text-[11.5px] text-ink-4">12 members · right now</p>
            </div>
          </div>
          <svg viewBox="0 0 640 150" className="mt-4 h-auto w-full" role="img" aria-label="Illustrative chart: recovered revenue rising week over week">
            <defs>
              <linearGradient id="home-lg" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0" stopColor="var(--acc)" stopOpacity=".35" />
                <stop offset="1" stopColor="var(--acc-ink)" />
              </linearGradient>
            </defs>
            <path d="M0,120 C80,116 140,106 210,96 C280,86 340,80 400,64 C470,46 560,34 640,26" stroke="url(#home-lg)" strokeWidth="2.6" fill="none" strokeLinecap="round" />
            <circle cx="640" cy="26" r="4.5" fill="var(--page)" stroke="var(--acc-ink)" strokeWidth="2" />
          </svg>
          <p className="mt-2 text-[11.5px] text-ink-4">
            Static illustration. The real dashboard renders provider-confirmed data only.
          </p>
        </Surface>
      </section>

      <section aria-labelledby="how-h" className="py-10">
        <h2 id="how-h" className="text-[26px] font-bold tracking-[-.02em] text-ink">From failed payment to kept member</h2>
        <ol className="mt-7 grid gap-4 md:grid-cols-5">
          {STEPS.map((s, i) => (
            <li key={s.k}>
              <Surface level={1} className="h-full p-5">
                <span className="num font-mono text-[12px] text-accent-ink">0{i + 1}</span>
                <h3 className="mt-1 text-[15.5px] font-bold text-ink">{s.k}</h3>
                <p className="mt-1.5 text-[13.5px] leading-relaxed text-ink-3">{s.v}</p>
              </Surface>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="val-h" className="py-10">
        <h2 id="val-h" className="text-[26px] font-bold tracking-[-.02em] text-ink">
          You don't have a churn problem. You have a <em className="serif-em">recovery</em> problem.
        </h2>
        <div className="mt-7 grid gap-4 md:grid-cols-2">
          {VALUES.map((v) => (
            <Surface key={v.t} level={2} className="p-6">
              <h3 className="text-[16px] font-bold text-ink">{v.t}</h3>
              <p className="mt-2 max-w-[58ch] text-[14.5px] leading-relaxed text-ink-2">{v.v}</p>
            </Surface>
          ))}
        </div>
      </section>

      <section className="py-12">
        <Surface level={2} className="flex flex-col items-center gap-4 px-8 py-12 text-center">
          <h2 className="text-[clamp(24px,3.4vw,34px)] font-bold tracking-[-.02em] text-ink">
            Meet the member you almost lost.
          </h2>
          <p className="max-w-[52ch] text-[15px] text-ink-2">
            Start a 14-day pilot on your own Stripe data — read-only, approval-gated, and attributed
            to the dollar.
          </p>
          <Link href="/sign-up" className="btn btn-pri">Start free pilot</Link>
        </Surface>
      </section>
    </div>
  );
}
