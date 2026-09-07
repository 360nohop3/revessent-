import type { Metadata } from "next";
import { Surface } from "@revessent/ui";

export const metadata: Metadata = { title: "Verify email" };

export default function VerifyEmailPage() {
  return (
    <Surface level={2} className="p-7">
      <h1 className="text-[22px] font-bold tracking-[-.02em] text-ink">Verify your email</h1>
      <div role="status" className="mt-4 rounded-md border border-accent/40 bg-well/60 p-4 text-[13.5px] text-ink-2">
        <p>
          Email verification is a Phase 4 capability (real auth backend). This screen is the
          pending state: nothing has been verified, and no verification email exists in this build.
        </p>
      </div>
    </Surface>
  );
}
