"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { z } from "zod";
import { qk } from "@revessent/contracts";
import { Badge, Button, ErrorState, FormField, Input, Skeleton, Surface, useToast } from "@revessent/ui";
import { api } from "@/lib/api";
import { can } from "@/lib/permissions";
import { roleFor, useSession } from "@/components/session";
import { useTeam } from "@/lib/queries";

const InviteSchema = z.object({
  email: z.string().trim().regex(/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/, "Enter a valid email."),
  role: z.enum(["operator", "viewer", "admin"])
});

export function TeamView({ orgSlug }: { orgSlug: string }) {
  const session = useSession();
  const role = roleFor(session, orgSlug);
  const allowed = can(role, "manage_team");
  const team = useTeam(orgSlug);
  const qc = useQueryClient();
  const { toast } = useToast();
  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"operator" | "viewer" | "admin">("operator");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!allowed) {
    return (
      <Surface level={2} className="p-6">
        <h2 className="text-[16px] font-bold text-ink">Team</h2>
        <p role="note" className="mt-2 rounded-md border border-line bg-well/40 px-3.5 py-2.5 text-[13.5px] text-ink-3">
          Managing the team requires an admin or owner role. You can still view the member list below.
        </p>
      </Surface>
    );
  }

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    const parsed = InviteSchema.safeParse({ email, role: inviteRole });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? null);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const result = await api.settings.invite(orgSlug, parsed.data);
      await qc.invalidateQueries({ queryKey: qk.team(orgSlug) });
      setEmail("");
      toast({
        title: result.emailSent
          ? "Invitation sent"
          : "Member added — email delivery arrives in Phase 4",
        description: result.emailSent
          ? undefined
          : "The invitation is recorded; nothing was emailed in this build.",
        tone: "info"
      });
    } catch {
      setError("Couldn't add the member. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <Surface level={2} className="p-6">
        <h2 className="text-[16px] font-bold text-ink">Invite a teammate</h2>
        <form className="mt-4 flex flex-col gap-3 md:flex-row md:items-end" onSubmit={invite} noValidate>
          <FormField id="inv-email" label="Email" error={error} className="flex-1">
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="teammate@company.com" autoComplete="off" />
          </FormField>
          <div>
            <label htmlFor="inv-role" className="mb-1 block text-[12px] font-semibold uppercase tracking-[.06em] text-ink-3">Role</label>
            <select id="inv-role" value={inviteRole} onChange={(e) => setInviteRole(e.target.value as typeof inviteRole)} className="input !w-auto !py-2.5">
              <option value="operator">operator</option>
              <option value="viewer">viewer</option>
              <option value="admin">admin</option>
            </select>
          </div>
          <Button type="submit" loading={busy}>Add member</Button>
        </form>
        <p className="mt-3 text-[12.5px] text-ink-3">
          Demo: the member is added to the local fixture roster only. Real invitations (email +
          acceptance flow) arrive with the Phase 4 backend.
        </p>
      </Surface>

      <Surface level={2} className="p-6">
        <h2 className="text-[16px] font-bold text-ink">Members</h2>
        {team.isLoading ? (
          <div className="mt-4 flex flex-col gap-2" role="status" aria-label="Loading team">
            <Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-full" />
          </div>
        ) : team.error ? (
          <div className="mt-4">
            <ErrorState message="The member list failed to load." onRetry={() => void team.refetch()} retrying={team.isRefetching} />
          </div>
        ) : (
          <ul className="mt-3 flex flex-col divide-y divide-line-soft">
            {team.data?.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                <span>
                  <span className="block text-[14px] font-semibold text-ink">{m.name}</span>
                  <span className="block text-[12.5px] text-ink-3">{m.email}</span>
                </span>
                <Badge tone={m.role === "owner" ? "info" : "neutral"}>{m.role}</Badge>
              </li>
            ))}
          </ul>
        )}
      </Surface>
    </div>
  );
}
