"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Button, Surface } from "@revessent/ui";
import { resendVerification, verifyEmail } from "@/lib/auth-actions";

type State = { kind: "pending" } | { kind: "checking" } | { kind: "verified" } | { kind: "failed"; error: string } | { kind: "resent" };

export function VerifyEmailView() {
  const token = useSearchParams().get("token");
  const [state, setState] = useState<State>({ kind: token ? "checking" : "pending" });

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    verifyEmail(token).then((r) => {
      if (cancelled) return;
      setState(r.ok ? { kind: "verified" } : { kind: "failed", error: r.error ?? "Verification failed." });
    });
    return () => { cancelled = true; };
  }, [token]);

  async function resend() {
    const r = await resendVerification();
    setState(r.ok ? { kind: "resent" } : { kind: "failed", error: r.error ?? "Couldn't resend." });
  }

  return (
    <Surface level={2} className="p-7">
      <h1 className="text-[22px] font-bold tracking-[-.02em] text-ink">Verify your email</h1>
      <div role="status" aria-live="polite" className="mt-4 rounded-md border border-accent/40 bg-well/60 p-4 text-[13.5px] text-ink-2">
        {state.kind === "checking" ? <p>Checking your verification link…</p> : null}
        {state.kind === "verified" ? (
          <p>
            Your email is verified. <Link className="text-accent-ink underline underline-offset-2" href="/onboarding">Create your workspace</Link>.
          </p>
        ) : null}
        {state.kind === "pending" ? (
          <p>Open the verification link we emailed you. Signed in but missing the email? Resend it below.</p>
        ) : null}
        {state.kind === "resent" ? <p>A fresh verification link is on its way (valid for one hour).</p> : null}
        {state.kind === "failed" ? <p className="text-err">{state.error}</p> : null}
      </div>
      {state.kind === "pending" || state.kind === "failed" ? (
        <Button className="mt-4" variant="glass" onClick={resend}>Resend verification email</Button>
      ) : null}
    </Surface>
  );
}
