import type { HTMLAttributes } from "react";
import { cx } from "./cx";

export function Skeleton({ className, ...rest }: { className?: string } & HTMLAttributes<HTMLDivElement>) {
  return <div className={cx("skl", className)} aria-hidden="true" {...rest} />;
}

export function SkeletonCard() {
  return (
    <div className="glass flex flex-col gap-3 p-5" role="status" aria-label="Loading">
      <Skeleton className="h-3 w-24" />
      <Skeleton className="h-7 w-32" />
      <Skeleton className="h-3 w-40" />
    </div>
  );
}

export function SkeletonTable({ rows = 4 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-2.5" role="status" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-12 w-full" />
      ))}
    </div>
  );
}
