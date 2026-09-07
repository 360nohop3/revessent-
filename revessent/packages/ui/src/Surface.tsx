import type { HTMLAttributes } from "react";
import { cx } from "./cx";

export interface SurfaceProps extends HTMLAttributes<HTMLDivElement> {
  /** glass depth: 1 = far frosted, 2 = mid, 3 = near/clearer, "solid" = opaque */
  level?: 1 | 2 | 3 | "solid";
}

export function Surface({ level = 1, className, ...rest }: SurfaceProps) {
  return (
    <div
      className={cx("glass", level === 2 && "glass-2", level === 3 && "glass-3", level === "solid" && "glass-solid", className)}
      {...rest}
    />
  );
}
