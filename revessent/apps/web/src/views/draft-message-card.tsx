"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { editability, type ApprovalStatus } from "@revessent/domain";
import type { DraftAction, MessageDraft } from "@revessent/contracts";
import { api } from "@/lib/api";
import { can, roleExplanation } from "@/lib/permissions";
import type { Role } from "@revessent/contracts";
import { useToast } from "@revessent/ui";
import { ApprovalDialog, Badge, Button, FormField, Input, Surface } from "@revessent/ui";
import { ApprovalChip, APPROVAL_NOTICE } from "./status-chips";
import { formatDateTime } from "@/lib/format";

export interface DraftMessageCardProps {
  slug: string;
  kind: "case" | "opportunity";
  parentId: string;
  queryKey: readonly unknown[];
  draft: MessageDraft | null;
  role: Role;
  title?: string;
}

/**
 * The approval surface. Distinguishes Draft → Awaiting approval → Approved →
 * Queued → Executing → Provider pending → Confirmed/Failed, and invalidates
 * approvals on edit (Phase 2 §12). In this build NOTHING is ever sent:
 * provider outcomes exist only through the labeled demo controls.
 */
export function DraftMessageCard({ slug, kind, parentId, queryKey, draft, role, title = "Recovery note" }: DraftMessageCardProps) {
  // Action buttons render only when a draft exists, so this is unreachable in practice.
  const draftEndpoint = (action: DraftAction): Promise<MessageDraft> => {
    if (!draft) throw new Error("No draft to act on.");
    return kind === "case"
      ? api.recovery.draft(slug, parentId, draft.id, action)
      : api.expansion.draft(slug, parentId, draft.id, action);
  };
  const qc = useQueryClient();
  const { toast } = useToast();
  const [dialog, setDialog] = useState<"edit" | "review" | null>(null);
  const [subject, setSubject] = useState(draft?.subject ?? "");
  const [body, setBody] = useState(draft?.body ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!draft) {
    return (
      <Surface level={1} className="p-5">
        <h2 className="text-[15px] font-bold text-ink">{title}</h2>
        <p className="mt-1 text-[13.5px] text-ink-3">
          No draft yet. The engine drafts notes when the policy calls for one (Phase 6).
        </p>
      </Surface>
    );
  }

  const status = draft.approvalStatus;
  const edit = editability(status);
  const canAct = can(role, "approve") && can(role, "edit_draft");

  function openEdit() {
    setSubject(draft?.subject ?? "");
    setBody(draft?.body ?? "");
    setError(null);
    setDialog("edit");
  }

  async function run(action: () => Promise<unknown>, okMessage: string) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await qc.invalidateQueries({ queryKey });
      toast({ title: okMessage, tone: "info" });
      setDialog(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That action isn't allowed right now.");
    } finally {
      setBusy(false);
    }
  }

  const wasApproved = status === "approved";

  return (
    <Surface level={2} className="p-5">
      <div className="flex flex-wrap items-center gap-2.5">
        <h2 className="text-[15px] font-bold text-ink">{title}</h2>
        <ApprovalChip status={status} />
        {draft.approvedAt && !["draft", "awaiting_approval"].includes(status) ? (
          <span className="text-[12px] text-ink-3">
            approved {formatDateTime(draft.approvedAt)} by {draft.approvedBy ?? "—"}
          </span>
        ) : null}
      </div>

      <p className="mt-1.5 max-w-[70ch] text-[13px] text-ink-3">{APPROVAL_NOTICE[status]}</p>

      <div className="mt-4 rounded-lg border border-line bg-well/40 p-4">
        <p className="text-[14px] font-semibold text-ink">{draft.subject}</p>
        <p className="mt-1.5 whitespace-pre-wrap text-[14px] leading-relaxed text-ink-2">{draft.body}</p>
        {draft.providerRef ? (
          <p className="mt-3 font-mono text-[11.5px] text-ink-4">provider ref: {draft.providerRef}</p>
        ) : null}
      </div>

      {error ? <p role="alert" className="mt-3 text-[13px] font-medium text-err">{error}</p> : null}

      {canAct ? (
        <div className="mt-4 flex flex-wrap gap-2.5">
          {edit.allowed ? (
            <Button variant="glass" size="sm" onClick={openEdit}>
              {wasApproved ? "Edit (invalidates approval)" : "Edit draft"}
            </Button>
          ) : null}
          {status === "draft" ? (
            <Button
              size="sm"
              loading={busy}
              onClick={() => void run(() => draftEndpoint({ type: "submit" }), "Submitted for approval — nothing is sent without one.")}
            >
              Submit for approval
            </Button>
          ) : null}
          {status === "awaiting_approval" ? (
            <Button size="sm" onClick={() => { setError(null); setDialog("review"); }}>
              Review &amp; approve
            </Button>
          ) : null}
          {["draft", "awaiting_approval", "approved"].includes(status) ? (
            <Button
              variant="ghost"
              size="sm"
              loading={busy}
              onClick={() => void run(() => draftEndpoint({ type: "cancel", actor: role }), "Draft cancelled — no message was sent.")}
            >
              Discard
            </Button>
          ) : null}
        </div>
      ) : (
        <p className="mt-4 rounded-md border border-line bg-well/40 px-3.5 py-2.5 text-[13px] text-ink-3" role="note">
          {roleExplanation(role)}
        </p>
      )}

      <ApprovalDialog
        open={dialog !== null}
        onOpenChange={(o) => { if (!o) setDialog(null); }}
        title={dialog === "edit" ? (wasApproved ? "Edit approved draft" : "Edit draft") : "Review draft"}
        description={
          dialog === "edit"
            ? "Changes are saved to the draft. Editing an approved draft invalidates its approval."
            : "Approving queues this draft for execution by the recovery engine. Nothing is sent in this build."
        }
        editingApproved={dialog === "edit" && wasApproved}
        footer={
          dialog === "edit" ? (
            <>
              <Button variant="ghost" size="sm" onClick={() => setDialog(null)}>Cancel</Button>
              <Button
                size="sm"
                loading={busy}
                onClick={() =>
                  void run(
                    () => draftEndpoint({ type: "edit", subject, body, actor: role }),
                    wasApproved ? "Saved — the previous approval was invalidated." : "Draft saved."
                  )
                }
              >
                Save draft
              </Button>
            </>
          ) : (
            <>
              <Button variant="ghost" size="sm" onClick={() => { setDialog(null); openEdit(); }}>Edit first</Button>
              <Button
                size="sm"
                loading={busy}
                onClick={() => void run(() => draftEndpoint({ type: "approve", actor: role }), "Approved. It will execute when the engine is connected — nothing was sent.")}
              >
                Approve
              </Button>
            </>
          )
        }
      >
        {dialog === "edit" ? (
          <>
            <FormField id="draft-subject" label="Subject" required>
              <Input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={120} />
            </FormField>
            <FormField id="draft-body" label="Message" hint="Plain words. No urgency tactics. One clear action.">
              <textarea
                id="draft-body"
                className="input min-h-[120px] resize-y"
                value={body}
                onChange={(e) => setBody(e.target.value)}
                maxLength={1200}
              />
            </FormField>
            {subject.trim() === "" ? (
              <p role="alert" className="text-[13px] text-err">The subject can't be empty.</p>
            ) : null}
          </>
        ) : (
          <blockquote className="rounded-lg border border-line bg-well/40 p-4 text-[14px] leading-relaxed text-ink-2">
            <p className="font-semibold text-ink">{draft.subject}</p>
            <p className="mt-1.5 whitespace-pre-wrap">{draft.body}</p>
          </blockquote>
        )}
      </ApprovalDialog>
    </Surface>
  );
}

/** Approval-state legend used on detail pages (Phase 2 §12 states, explicit). */
export function ApprovalStateLegend({ status }: { status: ApprovalStatus }) {
  return (
    <Badge tone={APPROVAL_NOTICE[status] ? "neutral" : "neutral"}>{status}</Badge>
  );
}
