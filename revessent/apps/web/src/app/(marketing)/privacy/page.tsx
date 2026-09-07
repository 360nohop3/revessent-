import type { Metadata } from "next";
import { Surface } from "@revessent/ui";

export const metadata: Metadata = { title: "Privacy" };

export default function PrivacyPage() {
  return (
    <div className="mx-auto w-[min(760px,100%-48px)] py-16">
      <h1 className="text-[32px] font-bold tracking-[-.02em] text-ink">Privacy</h1>
      <Surface level={1} className="mt-6 p-6">
        <p className="text-[14px] font-semibold text-warn-ink">
          Placeholder — final privacy policy is pending legal review before production launch.
        </p>
        <div className="mt-4 flex flex-col gap-3 text-[14.5px] leading-relaxed text-ink-2">
          <p>
            The architecture this product is being built on is privacy-conscious by construction:
            Revessent never receives full card numbers; member data is mirrored from your billing
            provider only as needed for recovery; and access is revoked when you disconnect.
          </p>
          <p>
            This Phase 2 foundation does not collect, transmit, or store any personal data — there
            is no backend yet. When the backend ships, this page will carry the actual policy with
            named processors and retention periods.
          </p>
        </div>
      </Surface>
    </div>
  );
}
