import type { ReactNode } from "react";
import { Surface } from "./Surface";

export interface EmptyStateProps {
  title: string;
  body: string;
  action?: ReactNode;
  icon?: ReactNode;
}

export function EmptyState({ title, body, action, icon }: EmptyStateProps) {
  return (
    <Surface level={2} className="flex flex-col items-center gap-3 px-8 py-12 text-center">
      {icon ? <div aria-hidden="true" className="text-ink-3">{icon}</div> : null}
      <h3 className="text-[17px] font-semibold text-ink">{title}</h3>
      <p className="max-w-[46ch] text-[14.5px] text-ink-3">{body}</p>
      {action ? <div className="mt-1">{action}</div> : null}
    </Surface>
  );
}
