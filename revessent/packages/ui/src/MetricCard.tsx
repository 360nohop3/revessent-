import type { ReactNode } from "react";
import { Badge } from "./Badge";
import { Surface } from "./Surface";
import { cx } from "./cx";

export interface MetricCardProps {
  label: string;
  /** Preformatted value — callers format money via @revessent/domain. */
  value: string;
  /** Financial-truth clarifier, always rendered when provided (Phase 2 §13). */
  clarifier?: string;
  footnote?: ReactNode;
  /** True when the underlying value awaits provider confirmation. */
  pendingProvider?: boolean;
  unavailable?: boolean;
  className?: string;
}

/** Financial figures render in IBM Plex Mono. Values never animate from
 *  fabricated zeros (Phase 2 §9). */
export function MetricCard({ label, value, clarifier, footnote, pendingProvider, unavailable, className }: MetricCardProps) {
  return (
    <Surface level={2} className={cx("flex flex-col gap-2 p-5", className)}>
      <span className="text-[12.5px] font-semibold uppercase tracking-[.08em] text-ink-3">{label}</span>
      <span className="num font-mono text-[26px] font-semibold leading-none tracking-[-0.02em] text-ink">
        {unavailable ? "—" : value}
      </span>
      {pendingProvider ? (
        <Badge tone="info" title="The provider has not confirmed this outcome yet">Pending provider confirmation</Badge>
      ) : null}
      {clarifier ? <span className="text-[12.5px] text-ink-3">{clarifier}</span> : null}
      {footnote ? <span className="text-[12.5px] text-ink-3">{footnote}</span> : null}
    </Surface>
  );
}
