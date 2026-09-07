import type { ReactNode } from "react";
import { cx } from "./cx";
import type { Tone } from "./tone";

export type { Tone };
export interface BadgeProps {
  tone?: Tone;
  children: ReactNode;
  className?: string;
  title?: string;
}

const TONE_CLASS: Record<Tone, string> = {
  neutral: "border-line text-ink-2 bg-well/40",
  info: "border-edge text-accent-ink bg-well/60",
  ok: "border-ok/40 text-ok-ink bg-ok/15",
  warn: "border-warn/40 text-warn-ink bg-warn/15",
  err: "border-err/40 text-err bg-err/10"
};

export function Badge({ tone = "neutral", children, className, title }: BadgeProps) {
  return (
    <span
      title={title}
      className={cx(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[12px] font-semibold leading-5",
        TONE_CLASS[tone],
        className
      )}
    >
      {children}
    </span>
  );
}
