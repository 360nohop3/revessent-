"use client";

import { Surface } from "@revessent/ui";

export function AiView() {
  return (
    <Surface level={2} className="p-6">
      <h2 className="text-[16px] font-bold text-ink">AI preferences</h2>
      <div role="note" className="mt-3 rounded-md border border-line bg-well/40 px-4 py-3 text-[13.5px] text-ink-2">
        <p className="font-semibold text-ink">Not available yet — by design.</p>
        <p className="mt-1">
          AI drafting (recovery notes, upgrade pitches, digest narratives) arrives in Phase 6, with
          structured validation, a template fallback, and approval gates that cannot be bypassed.
          There is nothing to configure until then.
        </p>
      </div>
    </Surface>
  );
}
