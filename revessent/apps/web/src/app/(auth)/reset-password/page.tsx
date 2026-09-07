import type { Metadata } from "next";
import { Surface } from "@revessent/ui";

export const metadata: Metadata = { title: "Reset password" };

export default function ResetPasswordPage() {
  return (
    <Surface level={2} className="p-7">
      <h1 className="text-[22px] font-bold tracking-[-.02em] text-ink">Choose a new password</h1>
      <div role="status" className="mt-4 rounded-md border border-accent/40 bg-well/60 p-4 text-[13.5px] text-ink-2">
        <p>
          Password resets are applied by the Phase 4 auth backend. This screen exists so the flow
          can be built and tested against the real contract later — in this build there is no
          reset token validation and no password can be changed.
        </p>
      </div>
    </Surface>
  );
}
