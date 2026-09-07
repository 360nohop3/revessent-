"use client";

import type { ReactNode } from "react";
import { Button } from "./Button";
import { Surface } from "./Surface";

export interface ErrorStateProps {
  title?: string;
  message: ReactNode;
  onRetry?: () => void;
  retrying?: boolean;
  /** Rendered small, e.g. problem type — helps support, never required. */
  technical?: string;
}

export function ErrorState({ title = "Something didn't load", message, onRetry, retrying, technical }: ErrorStateProps) {
  return (
    <Surface level={2} className="flex flex-col items-start gap-3 border-err/30 p-6" role="alert">
      <div>
        <h3 className="text-[16px] font-semibold text-ink">{title}</h3>
        <div className="mt-1 max-w-[60ch] text-[14.5px] text-ink-2">{message}</div>
        {technical ? <p className="mt-1 font-mono text-[11.5px] text-ink-4">{technical}</p> : null}
      </div>
      {onRetry ? (
        <Button variant="glass" size="sm" onClick={onRetry} loading={retrying}>
          Try again
        </Button>
      ) : null}
    </Surface>
  );
}
