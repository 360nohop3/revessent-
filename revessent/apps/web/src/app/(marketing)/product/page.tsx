import type { Metadata } from "next";
import Link from "next/link";
import { Surface } from "@revessent/ui";

export const metadata: Metadata = { title: "Product" };

const PIPELINE = [
  { k: "Detect", v: "A payment fails. The decline reason and member context arrive with it." },
  { k: "Understand", v: "The failure is classified into a small, readable set of categories — each with its own policy." },
  { k: "Decide", v: "Retry quietly, draft a note, or offer a checkout. The reasoning is shown, never hidden." },
  { k: "Recover", v: "One respectful path back for the member — and a clear record of what worked." },
  { k: "Learn", v: "Weekly forensics: what failed, what recovered, what to change. Attributed per dollar." }
];

export default function ProductPage() {
  return (
    <div className="mx-auto w-[min(1000px,100%-48px)] py-16">
      <p className="pill mx-auto w-fit">Revenue intelligence, not a dashboard</p>
      <h1 className="mt-5 text-center text-[clamp(30px,4.6vw,48px)] font-bold leading-[1.08] tracking-[-.03em] text-ink">
        Evidence, then a decision, then a <em className="serif-em">quiet</em> save.
      </h1>
      <p className="mx-auto mt-4 max-w-[62ch] text-center text-[16px] text-ink-2">
        Revessent reads the story behind each failed payment before it acts. Below is the same
        walkthrough the product team uses — with one honest caveat: this site is a frontend
        foundation, so nothing here executes yet.
      </p>

      <ol className="mt-10 flex flex-col gap-4">
        {PIPELINE.map((s, i) => (
          <li key={s.k}>
            <Surface level={1} className="flex flex-col gap-1.5 p-6 md:flex-row md:items-baseline md:gap-6">
              <span className="num w-20 flex-none font-mono text-[12.5px] text-accent-ink">Step 0{i + 1}</span>
              <div>
                <h2 className="text-[17px] font-bold text-ink">{s.k}</h2>
                <p className="mt-1 max-w-[70ch] text-[14.5px] text-ink-2">{s.v}</p>
              </div>
            </Surface>
          </li>
        ))}
      </ol>

      <section aria-labelledby="voices-h" className="mt-14">
        <h2 id="voices-h" className="text-[24px] font-bold tracking-[-.02em] text-ink">The same moment, two voices</h2>
        <p className="mt-2 max-w-[64ch] text-[14.5px] text-ink-2">
          Tone is a retention lever. Notes go out in your name, written to sound like you — with
          your approval on every send during the pilot.
        </p>
        <div className="mt-6 grid gap-4 md:grid-cols-2">
          <Surface level={2} className="p-5">
            <p className="text-[12px] font-semibold uppercase tracking-[.07em] text-ink-3">Your product · drafted for you</p>
            <p className="mt-3 text-[15px] font-semibold text-ink">A quick card check</p>
            <p className="mt-2 text-[14px] leading-relaxed text-ink-2">
              Hi Zoe — no stress, this happens all the time. The card on file (··4242) expired, so
              your membership couldn't renew. Update it here and you're all set.
            </p>
            <p className="mt-3 rounded-full border border-line px-3 py-1.5 text-[12.5px] text-ink-2">Update card · 30 seconds</p>
          </Surface>
          <Surface level={1} className="p-5 opacity-80">
            <p className="text-[12px] font-semibold uppercase tracking-[.07em] text-ink-3">A billing default, for comparison</p>
            <p className="mt-3 text-[15px] font-semibold text-ink">Payment failed — action required</p>
            <p className="mt-2 text-[14px] leading-relaxed text-ink-2">
              We were unable to charge your card ending in 4242. Please update your payment method
              to continue using the service. If payment is not received within 3 days, your account
              may be paused.
            </p>
          </Surface>
        </div>
      </section>

      <section className="mt-14">
        <Surface level={2} className="flex flex-col items-center gap-4 px-8 py-10 text-center">
          <h2 className="text-[24px] font-bold tracking-[-.02em] text-ink">Expansion, handled with the same care</h2>
          <p className="max-w-[56ch] text-[14.5px] text-ink-2">
            When a member outgrows a plan, Revessent drafts the pitch — evidence first, your
            approval required, billing through Stripe. Nothing is proposed to members automatically.
          </p>
          <Link href="/pricing" className="btn btn-glass">See the plans</Link>
        </Surface>
      </section>
    </div>
  );
}
