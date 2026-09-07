import { cx } from "./cx";

export interface EvidenceItem {
  label: string;
  value: string;
  /** Where the evidence comes from, e.g. "Stripe" — shown as a mono source tag. */
  source?: string;
}

/** Evidence-first presentation: every claim in the UI is traceable to a field
 *  the provider reported. No invented confidence scores (Phase 2 §11). */
export function EvidenceList({ items, className }: { items: EvidenceItem[]; className?: string }) {
  return (
    <dl className={cx("flex flex-col divide-y divide-line-soft", className)}>
      {items.map((item) => (
        <div key={item.label} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5 py-2.5 first:pt-0 last:pb-0">
          <dt className="text-[13px] font-semibold uppercase tracking-[.06em] text-ink-3">{item.label}</dt>
          <dd className="flex items-baseline gap-2 text-right">
            <span className="num font-mono text-[13.5px] text-ink">{item.value}</span>
            {item.source ? (
              <span className="rounded-full border border-line px-1.5 py-px font-mono text-[10.5px] uppercase text-ink-4">{item.source}</span>
            ) : null}
          </dd>
        </div>
      ))}
    </dl>
  );
}
