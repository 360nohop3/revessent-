"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cx } from "./cx";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "glass" | "ghost" | "danger";
  size?: "md" | "sm";
  loading?: boolean;
  children?: ReactNode;
}

/** Demo-faithful button (`.btn` recipes in tokens.css). Never reports success
 *  by itself — callers own truthfulness of labels like "Approve". */
export function Button({
  variant = "primary", size = "md", loading = false, className, children, disabled, type = "button", ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cx("btn", `btn-${variant === "primary" ? "pri" : variant}`, size === "sm" && "btn-sm", className)}
      {...rest}
    >
      {loading ? <span className="skl inline-block h-3.5 w-3.5 rounded-full" aria-hidden="true" /> : null}
      {children}
    </button>
  );
}
