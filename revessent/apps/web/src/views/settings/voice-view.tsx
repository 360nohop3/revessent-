"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { z } from "zod";
import { qk } from "@revessent/contracts";
import { Button, FormField, Input, Skeleton, Surface, useToast } from "@revessent/ui";
import { api } from "@/lib/api";
import { demoMode } from "@revessent/config";
import { can } from "@/lib/permissions";
import { roleFor, useSession } from "@/components/session";
import { useVoice } from "@/lib/queries";

const VoiceSchema = z.object({
  sampleText: z.string().max(2000),
  greeting: z.string().max(120),
  signoff: z.string().max(120)
});

export function VoiceView({ orgSlug }: { orgSlug: string }) {
  const session = useSession();
  const role = roleFor(session, orgSlug);
  const allowed = can(role, "manage_voice");
  const voice = useVoice(orgSlug);
  const qc = useQueryClient();
  const { toast } = useToast();
  const [form, setForm] = useState({ sampleText: "", greeting: "", signoff: "" });
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (voice.data) setForm({ sampleText: voice.data.sampleText, greeting: voice.data.greeting, signoff: voice.data.signoff });
  }, [voice.data]);

  if (voice.isLoading) return <Skeleton className="h-64 w-full" />;
  if (voice.error || !voice.data) return <Skeleton className="h-64 w-full" />;

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const parsed = VoiceSchema.safeParse(form);
    if (!parsed.success) return;
    setBusy(true);
    try {
      await api.settings.saveVoice(orgSlug, { ...parsed.data, styleSummary: voice.data?.styleSummary ?? "" });
      await qc.invalidateQueries({ queryKey: qk.voice(orgSlug) });
      toast(demoMode()
        ? { title: "Voice saved (demo)", description: "AI drafting arrives in Phase 6 — no notes are generated yet.", tone: "info" as const }
        : { title: "Voice profile saved", description: "Stored for this workspace. AI drafting that uses it arrives in Phase 6.", tone: "info" as const });
    } finally {
      setBusy(false);
    }
  }

  return (
    <Surface level={2} className="p-6">
      <h2 className="text-[16px] font-bold text-ink">Recovery notes in your voice</h2>
      <p className="mt-1 max-w-[70ch] text-[13.5px] text-ink-3">
        Paste a couple of real emails you've sent members. In production this distills a style
        summary that guides AI drafts — every send stays approval-gated.
      </p>
      <form className="mt-5 flex flex-col gap-4" onSubmit={save} noValidate>
        <FormField id="v-sample" label="Voice samples" hint="A few sentences in your usual tone.">
          <textarea id="v-sample" className="input min-h-[110px] resize-y" value={form.sampleText} onChange={(e) => setForm((v) => ({ ...v, sampleText: e.target.value }))} disabled={!allowed} />
        </FormField>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField id="v-greeting" label="Greeting"><Input value={form.greeting} onChange={(e) => setForm((v) => ({ ...v, greeting: e.target.value }))} disabled={!allowed} /></FormField>
          <FormField id="v-signoff" label="Sign-off"><Input value={form.signoff} onChange={(e) => setForm((v) => ({ ...v, signoff: e.target.value }))} disabled={!allowed} /></FormField>
        </div>
        <div>
          <Button type="submit" loading={busy} disabled={!allowed}>Save voice</Button>
        </div>
      </form>
    </Surface>
  );
}
