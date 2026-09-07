"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { cx } from "./cx";
import type { Tone } from "./tone";

export interface ToastInput {
  title: string;
  description?: string;
  tone?: Tone;
}

interface ToastRecord extends ToastInput {
  id: number;
}

interface ToastApi {
  toast: (input: ToastInput) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}

const BORDER: Record<Tone, string> = {
  neutral: "border-line",
  info: "border-accent/50",
  ok: "border-ok/50",
  warn: "border-warn/50",
  err: "border-err/50"
};

/** Screen-reader-friendly status changes: toasts land in a polite live region. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastRecord[]>([]);
  const seq = useRef(0);

  const toast = useCallback((input: ToastInput) => {
    const id = ++seq.current;
    setToasts((prev) => [...prev.slice(-3), { ...input, id }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 6000);
  }, []);

  const api = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div
        aria-live="polite"
        aria-atomic="false"
        className="pointer-events-none fixed right-4 top-4 z-[60] flex w-[min(360px,calc(100vw-32px))] flex-col gap-2.5"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cx("glass glass-3 pointer-events-auto border p-3.5", BORDER[t.tone ?? "neutral"])}
            role="status"
          >
            <p className="text-[13.5px] font-semibold text-ink">{t.title}</p>
            {t.description ? <p className="mt-0.5 text-[12.5px] text-ink-3">{t.description}</p> : null}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
