import type { Metadata } from "next";
import { Surface } from "@revessent/ui";

export const metadata: Metadata = { title: "Terms" };

export default function TermsPage() {
  return (
    <div className="mx-auto w-[min(760px,100%-48px)] py-16">
      <h1 className="text-[32px] font-bold tracking-[-.02em] text-ink">Terms of service</h1>
      <Surface level={1} className="mt-6 p-6">
        <p className="text-[14px] font-semibold text-warn-ink">
          Placeholder — final terms are pending legal review before production launch.
        </p>
        <div className="mt-4 flex flex-col gap-3 text-[14.5px] leading-relaxed text-ink-2">
          <p>
            The recovery guarantee described on the pricing page is a commercial commitment and will
            be defined precisely here: attribution rules, the 90-day window, and refund mechanics.
          </p>
          <p>
            Nothing on this site is a binding offer. This build is a frontend foundation and makes
            no live commitments.
          </p>
        </div>
      </Surface>
    </div>
  );
}
