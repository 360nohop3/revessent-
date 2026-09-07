/** All money is integer minor units + ISO 4217 code. Never floats, never strings. */
export interface Money {
  /** Minor units (cents). May be negative only for adjustments. */
  minor: number;
  currency: string;
}

export type MoneyTruth =
  | "cash" // settled, collected cash (provider-confirmed)
  | "exposure" // revenue at risk — not yet lost, not yet recovered
  | "potential" // possible future revenue — never imply it is collected
  | "mrr"; // recurring rate, not a cash amount

export const MONEY_TRUTH_LABEL: Record<MoneyTruth, string> = {
  cash: "Settled cash",
  exposure: "Exposure — not yet lost or recovered",
  potential: "Potential — not collected cash",
  mrr: "Recurring rate, not a cash amount"
};

export function formatMoney(money: Money, opts?: { signed?: boolean }): string {
  const abs = Math.abs(money.minor) / 100;
  const body = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: money.currency,
    maximumFractionDigits: abs % 1 === 0 ? 0 : 2
  }).format(abs);
  if (money.minor < 0) return `−${body}`;
  return opts?.signed ? `+${body}` : body;
}

export function formatPercent(ratio: number | null, digits = 0): string {
  if (ratio === null) return "—";
  return `${(ratio * 100).toFixed(digits)}%`;
}

export function sumMoney(amounts: Money[]): Money {
  if (amounts.length === 0) return { minor: 0, currency: "USD" };
  const currency = amounts[0]!.currency;
  if (!amounts.every((a) => a.currency === currency)) {
    // Phase 2 fixtures are single-currency; the Phase 3 backend must aggregate per currency.
    return { minor: NaN, currency };
  }
  return { minor: amounts.reduce((acc, a) => acc + a.minor, 0), currency };
}
