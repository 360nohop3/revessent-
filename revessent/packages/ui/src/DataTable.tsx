import type { ReactNode } from "react";
import { cx } from "./cx";

export interface Column<T> {
  key: string;
  header: string;
  cell: (row: T) => ReactNode;
  align?: "left" | "right";
  /** Hide this column below the given breakpoint (desktop table only). */
  hideBelow?: "md" | "lg";
}

export interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  getKey: (row: T) => string;
  caption: string;
  /** Rendered instead of the table when rows is empty (e.g. <EmptyState/>). */
  empty?: ReactNode;
  /** Responsive card renderer for small screens (Phase 2 §16). */
  mobileCard: (row: T) => ReactNode;
}

const HIDE: Record<string, string> = { md: "hidden md:table-cell", lg: "hidden lg:table-cell" };

/** Accessible, responsive table. Desktop: semantic <table>. Mobile: stacked
 *  cards rendered by `mobileCard`. No hidden interactive traps. */
export function DataTable<T>({ columns, rows, getKey, caption, empty, mobileCard }: DataTableProps<T>) {
  if (rows.length === 0 && empty) return <>{empty}</>;
  return (
    <>
      {/* Desktop table */}
      <div className="glass hidden overflow-hidden md:block">
        <table className="w-full border-collapse text-[14px]">
          <caption className="sr-only">{caption}</caption>
          <thead>
            <tr className="border-b border-line text-left">
              {columns.map((c) => (
                <th
                  key={c.key}
                  scope="col"
                  className={cx(
                    "px-4 py-3 text-[12px] font-semibold uppercase tracking-[.07em] text-ink-3",
                    c.align === "right" && "text-right",
                    c.hideBelow && HIDE[c.hideBelow]
                  )}
                >
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={getKey(row)} className="border-b border-line-soft last:border-0">
                {columns.map((c) => (
                  <td
                    key={c.key}
                    className={cx("px-4 py-3.5 align-middle", c.align === "right" && "text-right", c.hideBelow && HIDE[c.hideBelow])}
                  >
                    {c.cell(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {/* Mobile cards */}
      <div className="flex flex-col gap-3 md:hidden" role="list" aria-label={caption}>
        {rows.map((row) => (
          <div role="listitem" key={getKey(row)}>
            {mobileCard(row)}
          </div>
        ))}
      </div>
    </>
  );
}
