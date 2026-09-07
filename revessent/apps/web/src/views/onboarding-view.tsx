"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { z } from "zod";
import { Badge, Button, FormField, Input, Surface } from "@revessent/ui";
import { createWorkspace } from "@/lib/auth-actions";
import { demoMode } from "@revessent/config";

const OrgSchema = z.object({
  name: z.string().trim().min(2, "Give the workspace a name.").max(60),
  slug: z
    .string()
    .trim()
    .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Lowercase letters, numbers and dashes only."),
  ack: z.literal(true, { message: "Please acknowledge the Stripe setup step." })
});

const STEPS = ["Workspace", "Connect Stripe", "Done"];

export function OnboardingView() {
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [ack, setAck] = useState(false);
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [creating, setCreating] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [needsVerification, setNeedsVerification] = useState(false);

  async function create() {
    const parsed = OrgSchema.safeParse({ name, slug, ack: ack ? true : undefined } as unknown);
    if (!parsed.success) {
      const map: Record<string, string | undefined> = {};
      for (const i of parsed.error.issues) map[String(i.path[0])] = i.message;
      setErrors(map);
      return;
    }
    setErrors({});
    setCreating(true);
    setFormError(null);
    try {
      // Demo: creates the org in the in-memory fixture store, then refreshes the
      // demo session cookie so the new membership appears in the switcher.
      const result = await createWorkspace(name, slug);
      if (!result.ok) {
        // Phase 8: the server answers 403 until the account email is verified.
        setNeedsVerification(/verify your email/i.test(result.error ?? ""));
        setFormError(result.error ?? "Could not create the workspace.");
        setCreating(false);
        return;
      }
      if (demoMode()) await fetch("/api/demo/session", { method: "POST" }); // refresh demo memberships
      router.push(`/app/${slug}/overview`);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Could not create the workspace.");
      setCreating(false);
    }
  }

  return (
    <div className="mx-auto w-[min(620px,100%-32px)] py-10">
      <ol className="flex items-center gap-2" aria-label="Setup steps">
        {STEPS.map((s, i) => (
          <li key={s} className="flex items-center gap-2">
            <span
              aria-current={i === step ? "step" : undefined}
              className={`num rounded-full border px-2.5 py-0.5 font-mono text-[12px] ${
                i === step ? "border-accent/50 text-accent-ink" : i < step ? "border-ok/40 text-ok-ink" : "border-line text-ink-4"
              }`}
            >
              {i + 1}. {s}
            </span>
            {i < STEPS.length - 1 ? <span aria-hidden="true" className="h-px w-4 bg-line" /> : null}
          </li>
        ))}
      </ol>

      {step === 0 ? (
        <Surface level={2} className="mt-6 p-6">
          <h1 className="text-[22px] font-bold tracking-[-.02em] text-ink">Create your workspace</h1>
          <p className="mt-1 text-[13.5px] text-ink-3">
            Demo setup — the workspace is created in the local fixture store only. The real
            multi-tenant backend arrives in Phase 3/4.
          </p>
          <div className="mt-5 flex flex-col gap-4">
            <FormField id="ob-name" label="Workspace name" error={errors.name} required>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Acorn Books" autoComplete="organization" />
            </FormField>
            <FormField id="ob-slug" label="URL identifier" hint="Used in app URLs: /app/{id}/overview" error={errors.slug} required>
              <Input value={slug} onChange={(e) => setSlug(e.target.value.toLowerCase())} placeholder="acorn-books" spellCheck={false} />
            </FormField>
            <div>
              <Button onClick={() => { setStep(1); }}>Continue</Button>
            </div>
          </div>
        </Surface>
      ) : null}

      {step === 1 ? (
        <Surface level={2} className="mt-6 p-6">
          <h1 className="text-[22px] font-bold tracking-[-.02em] text-ink">Connect Stripe</h1>
          <p className="mt-1 text-[13.5px] text-ink-3">
            You'll do the real connection in Settings ▸ Stripe. It uses a <strong className="text-ink-2">restricted
            API key</strong> you create in your Stripe dashboard, starting read-only.
          </p>
          <ol className="mt-4 flex flex-col gap-2.5 text-[14px] text-ink-2">
            <li className="flex gap-2.5"><span className="num font-mono text-[12px] text-accent-ink">1.</span> In Stripe: Developers → API keys → Create restricted key.</li>
            <li className="flex gap-2.5"><span className="num font-mono text-[12px] text-accent-ink">2.</span> Grant read scopes: Customers, Subscriptions, Invoices, Charges, Payment methods.</li>
            <li className="flex gap-2.5"><span className="num font-mono text-[12px] text-accent-ink">3.</span> Paste it in Settings ▸ Stripe after setup. Revessent never asks for your main secret key.</li>
          </ol>
          <p className="mt-4 rounded-md border border-warn/40 bg-warn/10 px-3.5 py-2.5 text-[13px] font-medium text-warn-ink">
            The Phase 5 backend performs the actual key validation and data sync. This build stores nothing.
          </p>
          <label className="mt-4 flex cursor-pointer items-start gap-2.5 text-[13.5px] text-ink-2">
            <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} className="mt-1 h-4 w-4 accent-[var(--btnA)]" />
            I understand the connection happens later, in Settings.
          </label>
          {errors.ack ? <p role="alert" className="mt-1 text-[13px] text-err">{errors.ack}</p> : null}
          <div className="mt-5 flex gap-2.5">
            <Button variant="ghost" onClick={() => setStep(0)}>Back</Button>
            <Button loading={creating} onClick={create}>Create workspace</Button>
          </div>
          {formError ? <p role="alert" className="mt-3 text-[13px] text-err">{formError}</p> : null}
          {needsVerification ? (
            <p className="mt-2 text-[13px] text-ink-3">
              <Link className="text-accent-ink underline underline-offset-2" href="/verify-email">Resend the verification email</Link>
            </p>
          ) : null}
        </Surface>
      ) : null}

      {step === 2 ? (
        <Surface level={2} className="mt-6 p-6">
          <Badge tone="ok">Ready</Badge>
          <h1 className="mt-3 text-[22px] font-bold text-ink">All set</h1>
        </Surface>
      ) : null}
    </div>
  );
}
