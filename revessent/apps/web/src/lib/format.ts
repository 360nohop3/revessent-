import { formatMoney } from "@revessent/domain";

export { formatMoney, formatPercent } from "@revessent/domain";
import type { Money } from "@revessent/domain";

export function formatDateTime(isoValue: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit"
  }).format(new Date(isoValue));
}

export function formatDate(isoValue: string): string {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(new Date(isoValue));
}

export function amountLabel(money: Money, interval: "month" | "year" | "unsupported"): string {
  // "unsupported" renders without a cadence suffix — the amount is real, the
  // billing cadence is not represented in the Phase 4A model (never "/mo").
  const per = interval === "month" ? "/mo" : interval === "year" ? "/yr" : "";
  return `${formatMoney(money)}${per}`.trimEnd();
}
