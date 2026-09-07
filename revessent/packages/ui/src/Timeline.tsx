import { cx } from "./cx";
import type { Tone } from "./tone";

export interface TimelineEntryView {
  id: string;
  at: string;
  title: string;
  detail?: string | null;
  tone?: Tone;
  /** Preformatted time (caller formats) — rendered in mono. */
  timeLabel: string;
}

const DOT: Record<Tone, string> = {
  neutral: "bg-ink-4",
  info: "bg-accent",
  ok: "bg-ok",
  warn: "bg-warn",
  err: "bg-err"
};

export function Timeline({ entries, label }: { entries: TimelineEntryView[]; label: string }) {
  return (
    <ol aria-label={label} className="relative flex flex-col gap-0 pl-1">
      {entries.map((e, i) => (
        <li key={e.id} className="relative flex gap-3.5 pb-5 last:pb-0">
          {/* connector */}
          {i < entries.length - 1 ? (
            <span aria-hidden="true" className="absolute left-[5px] top-4 h-[calc(100%-16px)] w-px bg-line" />
          ) : null}
          <span
            aria-hidden="true"
            className={cx("mt-[7px] h-[11px] w-[11px] flex-none rounded-full ring-4 ring-page", DOT[e.tone ?? "neutral"])}
          />
          <div className="min-w-0">
            <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5">
              <span className="text-[14.5px] font-semibold text-ink">{e.title}</span>
              <span className="num font-mono text-[11.5px] text-ink-4">{e.timeLabel}</span>
            </div>
            {e.detail ? <p className="mt-0.5 max-w-[62ch] text-[13.5px] text-ink-3">{e.detail}</p> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}
