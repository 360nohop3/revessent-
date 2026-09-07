/** Local copy of money formatting for the chart component so the ui package
 *  stays dependency-light (mirrors @revessent/domain#formatMoney). */
export function formatMoney(money: { minor: number; currency: string }): string {
  const abs = Math.abs(money.minor) / 100;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: money.currency,
    maximumFractionDigits: abs % 1 === 0 ? 0 : 2
  }).format(abs);
}
