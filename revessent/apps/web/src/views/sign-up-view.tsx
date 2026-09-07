"use client";

import Link from "next/link";
import { useState } from "react";
import { z } from "zod";
import { Button, FormField, Input, Surface } from "@revessent/ui";
import { demoMode } from "@revessent/config";
import { registerAccount } from "@/lib/auth-actions";

const SignUpSchema = z.object({
  name: z.string().trim().min(2, "Tell us your name."),
  email: z.string().trim().regex(/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/, "Enter a valid work email."),
  password: z.string().min(10, "Use at least 10 characters.")
});

export function SignUpView() {
  const [values, setValues] = useState({ name: "", email: "", password: "" });
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    const parsed = SignUpSchema.safeParse(values);
    if (!parsed.success) {
      const map: Record<string, string | undefined> = {};
      for (const i of parsed.error.issues) map[String(i.path[0])] = i.message;
      setErrors(map);
      return;
    }
    setErrors({});
    setSubmitting(true);
    try {
      const result = await registerAccount(parsed.data.name, parsed.data.email, parsed.data.password);
      if (!result.ok) { setFormError(result.error ?? "Couldn't create the account. Try again."); return; }
      setCreated(true);
    } catch {
      setFormError("Couldn't create the account. Try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Surface level={2} className="p-7">
      <h1 className="text-[24px] font-bold tracking-[-.02em] text-ink">Start your free pilot</h1>
      <p className="mt-1.5 text-[13.5px] text-ink-3">
        14 days on your own Stripe data — read-only, approval-gated, no card required.
      </p>
      {created ? (
        <div role="status" className="mt-5 rounded-md border border-accent/40 bg-well/60 p-4 text-[13.5px] text-ink-2">
          {demoMode() ? (
            <>
              <p className="font-semibold text-ink">Demo mode — no account was created.</p>
              <p className="mt-2">To explore the product, <Link className="text-accent-ink underline underline-offset-2" href="/sign-in">sign into the demo workspace</Link>.</p>
            </>
          ) : (
            <>
              <p className="font-semibold text-ink">Check your inbox</p>
              <p className="mt-1">
                We sent a verification link to <strong className="text-ink-2">{values.email}</strong>. Verify your email, then
                <Link className="ml-1 text-accent-ink underline underline-offset-2" href="/onboarding">create your workspace</Link>.
              </p>
            </>
          )}
        </div>
      ) : (
        <form className="mt-5 flex flex-col gap-4" onSubmit={onSubmit} noValidate>
          <FormField id="name" label="Your name" error={errors.name} required>
            <Input name="name" autoComplete="name" value={values.name} onChange={(e) => setValues((v) => ({ ...v, name: e.target.value }))} />
          </FormField>
          <FormField id="email" label="Work email" error={errors.email} required>
            <Input type="email" name="email" autoComplete="email" value={values.email} onChange={(e) => setValues((v) => ({ ...v, email: e.target.value }))} />
          </FormField>
          <FormField id="password" label="Password" hint="At least 10 characters." error={errors.password} required>
            <Input type="password" name="password" autoComplete="new-password" value={values.password} onChange={(e) => setValues((v) => ({ ...v, password: e.target.value }))} />
          </FormField>
          {formError ? (
            <p role="alert" className="rounded-md border border-err/40 bg-err/10 px-3.5 py-2.5 text-[13px] font-medium text-err">{formError}</p>
          ) : null}
          <Button type="submit" loading={submitting}>Continue</Button>
          <p className="text-[13px] text-ink-3">
            Already have a workspace? <Link className="text-accent-ink underline underline-offset-2" href="/sign-in">Sign in</Link>
          </p>
        </form>
      )}
    </Surface>
  );
}
