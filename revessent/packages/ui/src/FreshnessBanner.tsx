"use client";

import type { Freshness } from "./freshness";
import { Surface } from "./Surface";

export interface FreshnessBannerProps {
  freshness: Freshness;
  /** Backfill/import in progress — "syncing is not empty" (Phase 2 §9). */
  syncing?: boolean;
  lastSyncLabel?: string;
  onAction?: () => void;
  actionLabel?: string;
}

/** Explains data age honestly. Renders nothing when data is fresh. */
export function FreshnessBanner({ freshness, syncing, lastSyncLabel, onAction, actionLabel }: FreshnessBannerProps) {
  if (syncing) {
    return (
      <Surface level={2} role="status" className="flex flex-wrap items-center gap-x-3 gap-y-1 border-accent/30 px-4 py-3">
        <span className="text-[13.5px] font-semibold text-accent-ink" role="status">Syncing with Stripe…</span>
        <span className="text-[13px] text-ink-3">Data is arriving from your provider — this screen is incomplete, not empty.</span>
      </Surface>
    );
  }
  if (freshness === "stale" || freshness === "never") {
    return (
      <Surface level={2} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-warn/40 px-4 py-3">
        <span className="text-[13.5px] font-semibold text-warn-ink">
          {freshness === "never" ? "No sync has completed yet" : "This data is stale"}
        </span>
        <span className="text-[13px] text-ink-3">
          {lastSyncLabel ? `Last sync: ${lastSyncLabel}. ` : ""}
          Actions you take may be based on out-of-date information — check the connection.
        </span>
        {onAction && actionLabel ? (
          <button type="button" className="btn btn-glass btn-sm ml-auto" onClick={onAction}>
            {actionLabel}
          </button>
        ) : null}
      </Surface>
    );
  }
  if (freshness === "aging") {
    return (
      <p className="px-1 text-[12.5px] text-ink-3">Synced {lastSyncLabel ?? "recently"} · data may lag the provider slightly.</p>
    );
  }
  return null;
}
