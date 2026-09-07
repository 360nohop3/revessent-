"use client";

import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { cx } from "@revessent/ui";
import { removeOrgCache } from "@/lib/demo-helpers";

/**
 * Demo controls (Phase 2 §10): clearly-labeled reviewer affordances to
 * exercise error/offline states honestly. Production builds (demo mode
 * disabled) render nothing.
 */
export function DemoBar({ orgSlug }: { orgSlug: string }) {
  // AUDIT FIX: was === "false", which rendered the bar when the flag is
  // UNSET — the production default. Demo chrome appears only when explicitly on.
  if (process.env.NEXT_PUBLIC_DEMO_MODE !== "on") return null;
  return <DemoBarInner orgSlug={orgSlug} />;
}

function DemoBarInner({ orgSlug }: { orgSlug: string }) {
  const qc = useQueryClient();
  const [failNext, setFailNext] = useState(false);
  const [offline, setOffline] = useState(false);
  const [open, setOpen] = useState(false);

  async function mockApi() {
    const { getMockApi } = await import("@revessent/contracts");
    return getMockApi();
  }

  function toggleFail() {
    const next = !failNext;
    setFailNext(next);
    void mockApi().then((m) => m.demo.setFailNext(next));
  }

  function toggleOffline() {
    const next = !offline;
    setOffline(next);
    void mockApi().then((m) => m.demo.setOffline(next));
    qc.getQueryCache().clear();
  }

  function reset() {
    void mockApi().then((m) => {
      m.demo.store().reset();
      removeOrgCache(qc, orgSlug);
    });
  }

  return (
    <div role="region" aria-label="Demo controls" className="fixed inset-x-0 bottom-0 z-40 border-t border-warn/40 bg-page/90 backdrop-blur-md">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-2 pb-[max(8px,env(safe-area-inset-bottom))]">
        <span className="pill !border-warn/50 !bg-warn/10 !text-warn-ink">Demo data — no real actions</span>
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="text-[12.5px] font-semibold text-ink-3 underline underline-offset-2">
          {open ? "Hide" : "Show"} state controls
        </button>
        {open ? (
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" aria-pressed={failNext} onClick={toggleFail} className={cx("btn btn-sm", failNext ? "btn-danger" : "btn-glass")}>
              {failNext ? "Fail next request: ON" : "Fail next request"}
            </button>
            <button type="button" aria-pressed={offline} onClick={toggleOffline} className={cx("btn btn-sm", offline ? "btn-danger" : "btn-glass")}>
              {offline ? "Offline: ON" : "Simulate offline"}
            </button>
            <button type="button" onClick={reset} className="btn btn-glass btn-sm">Reset demo data</button>
          </div>
        ) : null}
        {offline ? (
          <p role="alert" className="text-[12.5px] font-semibold text-err">Offline — requests are blocked to show network-failure states.</p>
        ) : null}
      </div>
    </div>
  );
}
