import { formatMoney } from "./chart-format";

export interface ChartPoint {
  /** e.g. week label */
  label: string;
  recoveredMinor: number;
  lostMinor: number;
}

export interface AccessibleChartProps {
  data: ChartPoint[];
  currency: string;
  /** Visible one-line summary of what the chart shows (also the aria description). */
  caption: string;
}

/**
 * Static, accessible chart: visible SVG with a visually-hidden data table.
 * No animation (reduced-motion by construction), no fabricated data — callers
 * pass provider-confirmed series only.
 */
export function AccessibleChart({ data, currency, caption }: AccessibleChartProps) {
  const max = Math.max(1, ...data.map((d) => Math.max(d.recoveredMinor, d.lostMinor)));
  const W = 640, H = 180, PAD = 8;
  const group = data.length > 0 ? (W - PAD * 2) / data.length : 0;
  const barW = data.length > 0 ? Math.min(26, group / 2.6) : 0;
  const y = (v: number) => H - PAD - (v / max) * (H - PAD * 2 - 14);

  return (
    <figure className="m-0">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={caption}>
        {[0.25, 0.5, 0.75, 1].map((f) => (
          <line key={f} x1={PAD} x2={W - PAD} y1={y(max * f)} y2={y(max * f)} stroke="var(--line-soft)" strokeWidth="1" />
        ))}
        {data.map((d, i) => {
          const cx0 = PAD + group * i + group / 2;
          return (
            <g key={d.label}>
              <rect
                x={cx0 - barW - 2} y={y(d.recoveredMinor)} width={barW}
                height={Math.max(1.5, H - PAD - y(d.recoveredMinor))}
                rx={4} fill="var(--ok)"
              >
                <title>{`${d.label} — recovered ${formatMoney({ minor: d.recoveredMinor, currency })}`}</title>
              </rect>
              <rect
                x={cx0 + 2} y={y(d.lostMinor)} width={barW}
                height={Math.max(1.5, H - PAD - y(d.lostMinor))}
                rx={4} fill="var(--err)" opacity={0.75}
              >
                <title>{`${d.label} — lost ${formatMoney({ minor: d.lostMinor, currency })}`}</title>
              </rect>
              {i % 2 === 0 || data.length <= 8 ? (
                <text x={cx0} y={H - 1} textAnchor="middle" fontSize="10" fill="var(--text-muted)">
                  {d.label}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      <figcaption className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-ink-3">
        <span>{caption}</span>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className="inline-block h-2 w-2 rounded-sm bg-ok" /> Recovered
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden="true" className="inline-block h-2 w-2 rounded-sm bg-err" /> Lost
        </span>
      </figcaption>
      {/* Screen-reader data table */}
      <table className="sr-only">
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Week</th>
            <th scope="col">Recovered</th>
            <th scope="col">Lost</th>
          </tr>
        </thead>
        <tbody>
          {data.map((d) => (
            <tr key={d.label}>
              <th scope="row">{d.label}</th>
              <td>{formatMoney({ minor: d.recoveredMinor, currency })}</td>
              <td>{formatMoney({ minor: d.lostMinor, currency })}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
