"use client";

import * as Dialog from "@radix-ui/react-dialog";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { cx } from "@revessent/ui";
import type { Org, Role } from "@revessent/contracts";
import { Brand } from "@/components/brand";
import { NAV_ITEMS, navHref } from "./nav-items";
import { NavIcon } from "./nav-icon";

export function MobileNav({ open, onOpenChange, org, role }: { open: boolean; onOpenChange: (o: boolean) => void; org: Org; role: Role }) {
  const pathname = usePathname();
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/35 backdrop-blur-[2px]" />
        <Dialog.Content className="glass glass-3 fixed inset-y-0 left-0 z-50 flex max-h-dvh w-[min(320px,86vw)] flex-col overflow-y-auto rounded-r-xl p-5 pl-[max(20px,env(safe-area-inset-left))] pt-[max(20px,env(safe-area-inset-top))]">
          <div className="flex items-center justify-between">
            <Dialog.Title asChild>
              <span><Brand /></span>
            </Dialog.Title>
            <Dialog.Close aria-label="Close menu" className="rounded-full border border-line px-2.5 py-0.5 text-[13px] text-ink-3">✕</Dialog.Close>
          </div>
          <Dialog.Description className="sr-only">Workspace navigation</Dialog.Description>
          <p className="mt-4 text-[11.5px] font-semibold uppercase tracking-[.07em] text-ink-4">{org.name} · {role}</p>
          <nav aria-label="Workspace" className="mt-2 flex flex-col">
            {NAV_ITEMS.map((item) => {
              const href = navHref(org.slug, item.href);
              const active = pathname === href || pathname.startsWith(href + "/");
              return (
                <Link
                  key={item.href}
                  href={href}
                  onClick={() => onOpenChange(false)}
                  aria-current={active ? "page" : undefined}
                  className={cx(
                    "flex items-center gap-2.5 rounded-xl px-3.5 py-3 text-[15px] font-medium text-ink-2",
                    active && "bg-well/80 font-semibold text-ink"
                  )}
                >
                  <NavIcon icon={item.icon} />
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
