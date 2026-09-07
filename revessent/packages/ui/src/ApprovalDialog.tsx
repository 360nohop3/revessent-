"use client";

import * as Dialog from "@radix-ui/react-dialog";
import type { ReactNode } from "react";
import { cx } from "./cx";

export interface ApprovalDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  children: ReactNode;
  footer: ReactNode;
  /** Shows the invalidation warning: editing an approved draft voids the approval. */
  editingApproved?: boolean;
}

/** Radix-based accessible dialog (focus trap, Escape, aria defaults — Phase 2 §15). */
export function ApprovalDialog({ open, onOpenChange, title, description, children, footer, editingApproved }: ApprovalDialogProps) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/35 backdrop-blur-[2px] data-[state=open]:motion-safe:animate-in" />
        <Dialog.Content
          className={cx(
            "glass glass-3 fixed left-1/2 top-1/2 z-50 max-h-[85dvh] w-[min(560px,calc(100vw-32px))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto p-6",
            "max-md:bottom-0 max-md:left-0 max-md:top-auto max-md:max-h-[88dvh] max-md:w-full max-md:translate-x-0 max-md:translate-y-0 max-md:rounded-b-none"
          )}
        >
          <div className="flex items-start justify-between gap-4">
            <Dialog.Title className="text-[17px] font-semibold text-ink">{title}</Dialog.Title>
            <Dialog.Close
              aria-label="Close dialog"
              className="rounded-full border border-line px-2.5 py-0.5 text-[13px] text-ink-3 hover:bg-well/60"
            >
              ✕
            </Dialog.Close>
          </div>
          <Dialog.Description className="mt-1 max-w-[56ch] text-[13.5px] text-ink-3">{description}</Dialog.Description>
          {editingApproved ? (
            <p role="alert" className="mt-3 rounded-md border border-warn/40 bg-warn/10 px-3.5 py-2.5 text-[13px] font-medium text-warn-ink">
              This draft was already approved. Saving an edit invalidates that approval and returns the draft to Draft — it will need approval again.
            </p>
          ) : null}
          <div className="mt-4 flex flex-col gap-3.5">{children}</div>
          <div className="mt-5 flex flex-wrap justify-end gap-2.5">{footer}</div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
