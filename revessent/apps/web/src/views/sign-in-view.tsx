"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { z } from "zod";
import { Button, FormField, Input, Surface } from "@revessent/ui";
import { startSession } from "@/lib/auth-actions";
import { demoMode } from "@revessent/config";

const SignInSchema = z.object({
  email: z.string().trim().regex(/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/, "Enter a valid email address."),
  password: z.string().min(8, "Passwords are at least 8 characters.")
});

export function SignInView() {
  const router = useRouter();
  const params = useSearchParams();
  const nextUrl = params.get("next");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<{ email?: string; password?: string }>({});
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    const parsed = SignInSchema.safeParse({ email, password });
    if (!parsed.success) {
      const issues = parsed.error.issues;
      setErrors({
        email: issues.find((i) => i.path[0] === "email")?.message,
        password: issues.find((i) => i.path[0] === "password")?.message
      });
      return;
    }
    setErrors({});
    setSubmitting(true);
    try {
      const result = await startSession(email, password);
      if (!result.ok) {
        setFormError(result.error ?? "That email and password didn't match. Try again.");
        setSubmitting(false);
        return;
      }
      router.push(nextUrl && nextUrl.startsWith("/") ? nextUrl : "/app");
    } catch {
      setFormError("Couldn't sign in. Try again.");
      setSubmitting(false);
    }
  }

  return (
    <Surface level={2} className="p-7">
      <h1 className="text-[24px] font-bold tracking-[-.02em] text-ink">Sign in</h1>
      <p className="mt-1.5 text-[13.5px] text-ink-3">
        {demoMode() ? (
          <>
            Demo mode: signing in starts a <strong className="text-ink-2">demo session</strong> with
            demo data — no credential is checked, nothing is stored beyond a session cookie.
          </>
        ) : (
          <>Sign in with your Revessent account. Sessions expire after 30 days.</>
        )}
      </p>
      <form className="mt-5 flex flex-col gap-4" onSubmit={onSubmit} noValidate>
        <FormField id="email" label="Work email" error={errors.email} required>
          <Input type="email" name="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </FormField>
        <FormField id="password" label="Password" error={errors.password} hint={demoMode() ? "Any value of 8+ characters works in the demo." : undefined} required>
          <Input type="password" name="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </FormField>
        {formError ? (
          <p role="alert" className="rounded-md border border-err/40 bg-err/10 px-3.5 py-2.5 text-[13px] font-medium text-err">{formError}</p>
        ) : null}
        <Button type="submit" loading={submitting}>Continue</Button>
      </form>
      <div className="mt-5 flex flex-col gap-1.5 text-[13px] text-ink-3">
        <p>
          No account yet? <Link className="text-accent-ink underline underline-offset-2" href="/sign-up">Start a pilot</Link>
        </p>
        <p>
          Forgot your password? <Link className="text-accent-ink underline underline-offset-2" href="/forgot-password">Reset it</Link>{demoMode() ? " — resets aren't available in the demo." : "."}
        </p>
      </div>
    </Surface>
  );
}
