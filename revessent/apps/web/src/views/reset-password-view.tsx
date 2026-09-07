"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { z } from "zod";
import { Button, FormField, Input, Surface } from "@revessent/ui";
import { resetPassword } from "@/lib/auth-actions";

const Schema = z.object({
  password: z.string().min(10, "Use at least 10 characters."),
  confirm: z.string()
}).refine((v) => v.password === v.confirm, { path: ["confirm"], message: "Passwords don't match." });

export function ResetPasswordView() {
  const router = useRouter();
  const token = useSearchParams().get("token") ?? "";
  const [values, setValues] = useState({ password: "", confirm: "" });
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    const parsed = Schema.safeParse(values);
    if (!parsed.success) {
      const map: Record<string, string | undefined> = {};
      for (const i of parsed.error.issues) map[String(i.path[0])] = i.message;
      setErrors(map);
      return;
    }
    setErrors({});
    setSubmitting(true);
    try {
      const result = await resetPassword(token, parsed.data.password);
      if (!result.ok) { setFormError(result.error ?? "This reset link is invalid or has expired."); return; }
      router.push("/sign-in?reset=1");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Surface level={2} className="p-7">
      <h1 className="text-[22px] font-bold tracking-[-.02em] text-ink">Choose a new password</h1>
      {!token ? (
        <div role="status" className="mt-4 rounded-md border border-warn/40 bg-well/60 p-4 text-[13.5px] text-ink-2">
          This page needs the link from your reset email. <Link className="text-accent-ink underline underline-offset-2" href="/forgot-password">Request a new one</Link>.
        </div>
      ) : (
        <form className="mt-5 flex flex-col gap-4" onSubmit={onSubmit} noValidate>
          <FormField id="rp-password" label="New password" hint="At least 10 characters. Other sessions are signed out." error={errors.password} required>
            <Input type="password" name="password" autoComplete="new-password" value={values.password} onChange={(e) => setValues((v) => ({ ...v, password: e.target.value }))} />
          </FormField>
          <FormField id="rp-confirm" label="Confirm password" error={errors.confirm} required>
            <Input type="password" name="confirm" autoComplete="new-password" value={values.confirm} onChange={(e) => setValues((v) => ({ ...v, confirm: e.target.value }))} />
          </FormField>
          {formError ? (
            <p role="alert" className="rounded-md border border-err/40 bg-err/10 px-3.5 py-2.5 text-[13px] font-medium text-err">{formError}</p>
          ) : null}
          <Button type="submit" loading={submitting}>Set new password</Button>
        </form>
      )}
    </Surface>
  );
}
