"use client";

import { useState } from "react";
import { z } from "zod";
import { Button, FormField, Input, Surface } from "@revessent/ui";
import { demoMode } from "@revessent/config";
import { requestPasswordReset } from "@/lib/auth-actions";

const Schema = z.string().trim().regex(/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/, "Enter a valid email address.");

export function ForgotPasswordView() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const parsed = Schema.safeParse(email);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? null);
      setNotice(false);
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const result = await requestPasswordReset(parsed.data);
      if (!result.ok) { setError(result.error ?? "Couldn't start the reset. Try again."); return; }
      setNotice(true);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Surface level={2} className="p-7">
      <h1 className="text-[22px] font-bold tracking-[-.02em] text-ink">Reset your password</h1>
      <form className="mt-5 flex flex-col gap-4" onSubmit={onSubmit} noValidate>
        <FormField id="fp-email" label="Work email" error={error} required>
          <Input type="email" name="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </FormField>
        <Button type="submit" loading={submitting}>Send reset link</Button>
      </form>
      <div aria-live="polite" className="mt-4">
        {notice ? (
          <p role="status" className="rounded-md border border-accent/40 bg-well/60 p-4 text-[13.5px] text-ink-2">
            {demoMode()
              ? <>Demo mode — no email is sent.</>
              : <>If an account exists for that address, a reset link is on its way. The link expires in one hour.</>}
          </p>
        ) : null}
      </div>
    </Surface>
  );
}
