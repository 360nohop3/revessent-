"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { z } from "zod";
import { qk } from "@revessent/contracts";
import { Button, ErrorState, FormField, Input, Skeleton, Surface, useToast } from "@revessent/ui";
import { api } from "@/lib/api";
import { demoMode } from "@revessent/config";
import { can } from "@/lib/permissions";
import { roleFor, useSession } from "@/components/session";
import { usePolicy } from "@/lib/queries";

const PolicySchema = z.object({
  maxAutoRetries: z.coerce.number().int().min(0).max(8),
  quietHoursStart: z.coerce.number().int().min(0).max(23),
  quietHoursEnd: z.coerce.number().int().min(0).max(23),
  minGapHours: z.coerce.number().int().min(1).max(72),
  noteAfterFailedRetries: z.coerce.number().int().min(0).max(4)
});

export function RecoveryPolicyView({ orgSlug }: { orgSlug: string }) {
  const session = useSession();
  const role = roleFor(session, orgSlug);
  const allowed = can(role, "manage_policy");
  const policy = usePolicy(orgSlug);
  const qc = useQueryClient();
  const { toast } = useToast();
  const [form, setForm] = useState({ maxAutoRetries: "4", quietHoursStart: "22", quietHoursEnd: "8", minGapHours: "24", noteAfterFailedRetries: "2" });
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (policy.data) {
      setForm({
        maxAutoRetries: String(policy.data.maxAutoRetries),
        quietHoursStart: String(policy.data.quietHoursStart),
        quietHoursEnd: String(policy.data.quietHoursEnd),
        minGapHours: String(policy.data.minGapHours),
        noteAfterFailedRetries: String(policy.data.noteAfterFailedRetries)
      });
    }
  }, [policy.data]);

  if (policy.isLoading) return <Skeleton className="h-64 w-full" />;
  if (policy.error) return <ErrorState message="Recovery policy failed to load." onRetry={() => void policy.refetch()} retrying={policy.isRefetching} />;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const parsed = PolicySchema.safeParse(form);
    if (!parsed.success) {
      const map: Record<string, string | undefined> = {};
      for (const i of parsed.error.issues) map[String(i.path[0])] = i.message;
      setErrors(map);
      return;
    }
    setErrors({});
    setBusy(true);
    try {
      await api.settings.savePolicy(orgSlug, { ...parsed.data, checkoutAfterNote: true });
      await qc.invalidateQueries({ queryKey: qk.policy(orgSlug) });
      toast(demoMode()
        ? { title: "Policy saved (demo)", description: "Policies are enforced by the Phase 5 engine — this demo stores the values locally.", tone: "info" as const }
        : { title: "Policy saved", description: "Stored as a new versioned policy for this workspace. The retry engine that enforces it arrives in Phase 5.", tone: "info" as const });
    } finally {
      setBusy(false);
    }
  }

  const fields: { key: keyof typeof form; label: string; hint: string }[] = [
    { key: "maxAutoRetries", label: "Max auto retries", hint: "0–8 silent retries per case" },
    { key: "quietHoursStart", label: "Quiet hours start", hint: "0–23, member-local time" },
    { key: "quietHoursEnd", label: "Quiet hours end", hint: "0–23, member-local time" },
    { key: "minGapHours", label: "Min gap between retries", hint: "1–72 hours" },
    { key: "noteAfterFailedRetries", label: "Draft note after N failures", hint: "0–4 failed retries before a note" }
  ];

  return (
    <Surface level={2} className="p-6">
      <h2 className="text-[16px] font-bold text-ink">Recovery policy</h2>
      <p className="mt-1 max-w-[70ch] text-[13.5px] text-ink-3">
        The readable policy the engine follows. Policies are versioned in production — running cases
        keep the version they started with.
      </p>
      <form className="mt-5 grid gap-4 sm:grid-cols-2" onSubmit={save} noValidate>
        {fields.map((f) => (
          <FormField key={f.key} id={`pol-${f.key}`} label={f.label} hint={f.hint} error={errors[f.key]}>
            <Input
              inputMode="numeric"
              value={form[f.key]}
              onChange={(e) => setForm((v) => ({ ...v, [f.key]: e.target.value }))}
              disabled={!allowed}
            />
          </FormField>
        ))}
        <div className="sm:col-span-2">
          <Button type="submit" loading={busy} disabled={!allowed}>Save policy</Button>
          {!allowed ? (
            <p role="note" className="mt-2 text-[13px] text-ink-3">Editing the policy requires an admin or owner role.</p>
          ) : null}
        </div>
      </form>
    </Surface>
  );
}
