"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import type { ApprovalStatus } from "@revessent/domain";
import { api } from "@/lib/api";

export interface DemoProviderControlsProps {
  slug: string;
  kind: "case" | "opportunity";
  parentId: string;
  queryKey: readonly unknown[];
  status: ApprovalStatus;
}

const NEXT: Partial<Record<ApprovalStatus, { type: "demo.execution_started" | "demo.provider_pending" | "demo.provider_confirmed" | "demo.provider_failed"; label: string }[]>> = {
  approved: [{ type: "demo.execution_started", label: "Engine picks it up → Executing" }],
  queued: [{ type: "demo.execution_started", label: "Engine picks it up → Executing" }],
  executing: [{ type: "demo.provider_pending", label: "Provider acks → Provider pending" }],
  provider_pending: [
    { type: "demo.provider_confirmed", label: "Provider confirms ✓" },
    { type: "demo.provider_failed", label: "Provider reports failure ✕" }
  ]
};

/**
 * Labeled demo-only controls that walk a draft through provider states.
 * These simulate what REAL provider webhooks will do in Phase 5 — they are
 * fixtures, and every button says so via its parent panel.
 */
export function DemoProviderControls({ slug, kind, parentId, queryKey, status }: DemoProviderControlsProps) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const actions = NEXT[status];
  if (!actions) return null;

  async function fire(action: { type: "demo.execution_started" | "demo.provider_pending" | "demo.provider_confirmed" | "demo.provider_failed" }) {
    setBusy(true);
    setError(null);
    try {
      if (!api.demo) return; // real mode never renders demo controls
      await api.demo.providerAction(slug, kind, parentId, action);
      await qc.invalidateQueries({ queryKey });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Not allowed from this state.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-lg border border-dashed border-warn/50 bg-warn/5 p-3.5">
      <p className="text-[12px] font-semibold uppercase tracking-[.07em] text-warn-ink">
        Demo controls — simulate provider events (fixtures only, nothing real)
      </p>
      <div className="mt-2.5 flex flex-wrap gap-2">
        {actions.map((a) => (
          <button key={a.type} type="button" disabled={busy} className="btn btn-glass btn-sm" onClick={() => void fire(a)}>
            {a.label}
          </button>
        ))}
      </div>
      {error ? <p role="alert" className="mt-2 text-[12.5px] text-err">{error}</p> : null}
    </div>
  );
}
