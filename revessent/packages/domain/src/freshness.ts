/** Data freshness model — powers FreshnessBanner (Phase 2 §9 "stale" state). */
export type Freshness = "fresh" | "aging" | "stale" | "never";

export const FRESH_MS = 15 * 60 * 1000;
export const STALE_MS = 24 * 60 * 60 * 1000;

export function computeFreshness(lastSyncAt: string | null | undefined, now = Date.now()): Freshness {
  if (!lastSyncAt) return "never";
  const age = now - new Date(lastSyncAt).getTime();
  if (Number.isNaN(age)) return "never";
  if (age <= FRESH_MS) return "fresh";
  if (age <= STALE_MS) return "aging";
  return "stale";
}

export function formatAge(lastSyncAt: string, now = Date.now()): string {
  const age = Math.max(0, now - new Date(lastSyncAt).getTime());
  const mins = Math.floor(age / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `${days} d ago`;
}
