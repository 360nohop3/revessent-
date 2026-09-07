"use client";

import Link from "next/link";
import { useState } from "react";
import { z } from "zod";
import { Button, FormField, Input, Surface } from "@revessent/ui";

const SignUpSchema = z.object({
  name: z.string().trim().min(2, "Tell us your name."),
  email: z.string().trim().regex(/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/, "Enter a valid work email."),
  password: z.string().min(10, "Use at least 10 characters — real accounts will need it.")
});

export function SignUpView() {
  const [values, setValues] = useState({ name: "", email: "", password: "" });
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [notice, setNotice] = useState(false);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const parsed = SignUpSchema.safeParse(values);
    if (!parsed.success) {
      const map: Record<string, string | undefined> = {};
      for (const i of parsed.error.issues) map[String(i.path[0])] = i.message;
      setErrors(map);
      setNotice(false);
      return;
    }
    setErrors({});
    // Honest stop: account creation requires the Phase 4 backend. Nothing created.
    setNotice(true);
  }

  return (
    <Surface level={2} className="p-7">
      <h1 className="text-[24px] font-bold tracking-[-.02em] text-ink">Start your free pilot</h1>
      <p className="mt-1.5 text-[13.5px] text-ink-3">
        14 days on your own Stripe data — read-only, approval-gated, no card required.
      </p>
      {notice ? (
        <div role="status" className="mt-5 rounded-md border border-accent/40 bg-well/60 p-4 text-[13.5px] text-ink-2">
          <p className="font-semibold text-ink">This demo stops here — by design.</p>
          <p className="mt-1">
            Account creation and pilot provisioning arrive with the Phase 3/4 backend. Your details
            were validated locally only: nothing was submitted, and no email was sent.
          </p>
          <p className="mt-2">
            To explore the product now, <Link className="text-accent-ink underline underline-offset-2" href="/sign-in">sign into the demo workspace</Link>.
          </p>
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
          <Button type="submit">Continue</Button>
          <p className="text-[13px] text-ink-3">
            Already have a workspace? <Link className="text-accent-ink underline underline-offset-2" href="/sign-in">Sign in</Link>
          </p>
        </form>
      )}
    </Surface>
  );
}
