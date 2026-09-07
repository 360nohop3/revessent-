import { Children, cloneElement, isValidElement, type ReactElement } from "react";
import { cx } from "./cx";

interface FieldControlProps {
  id?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean | "false" | "true" | undefined;
}

export interface FormFieldProps {
  id: string;
  label: string;
  hint?: string;
  error?: string | null;
  required?: boolean;
  children: ReactElement<FieldControlProps>;
  /** Renders the error visually immediately (live-region announces it). */
  className?: string;
}

/** Accessible field wrapper: label association, hint + error wiring via
 *  aria-describedby, aria-invalid on error. (Phase 2 §15.) */
export function FormField({ id, label, hint, error, required, children, className }: FormFieldProps) {
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;

  const child = Children.only(children);
  const control = isValidElement(child)
    ? cloneElement(child, {
        id,
        "aria-describedby": describedBy,
        "aria-invalid": error ? true : child.props["aria-invalid"]
      })
    : child;

  return (
    <div className={cx("flex flex-col gap-1.5", className)}>
      <label htmlFor={id} className="text-[13.5px] font-semibold text-ink-2">
        {label}
        {required ? <span aria-hidden="true" className="text-err"> *</span> : null}
      </label>
      {control}
      {hint ? (
        <p id={hintId} className="text-[13px] text-ink-3">
          {hint}
        </p>
      ) : null}
      <p id={errorId} role={error ? "alert" : undefined} className="min-h-0 text-[13px] font-medium text-err">
        {error ?? ""}
      </p>
    </div>
  );
}
