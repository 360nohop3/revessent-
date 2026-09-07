import { Badge } from "./Badge";
import type { Tone } from "./tone";

export interface StatusBadgeProps {
  label: string;
  tone: Tone;
  /** Adds a subtle pulse dot for in-flight states. */
  inFlight?: boolean;
  className?: string;
}

export function StatusBadge({ label, tone, inFlight, className }: StatusBadgeProps) {
  return (
    <Badge tone={tone} className={className}>
      {inFlight ? <span className="inline-block h-1.5 w-1.5 rounded-full bg-current motion-safe:animate-pulse" aria-hidden="true" /> : null}
      {label}
    </Badge>
  );
}
