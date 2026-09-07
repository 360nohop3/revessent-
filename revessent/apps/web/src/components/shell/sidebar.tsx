"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { PLANS } from "@revessent/domain";
import { cx } from "@revessent/ui";
import type { Org, Role } from "@revessent/contracts";
import { Brand } from "@/components/brand";
import { NAV_ITEMS, navHref } from "./nav-items";
import { NavIcon } from "./nav-icon";

export function Sidebar({ org, role }: { org: Org; role: Role }) {
  const pathname = usePathname();
  return (
    <aside className="fixed inset-y-0 left-0 z-30 hidden w-[248px] flex-col border-r border-line-soft bg-well/25 backdrop-blur-md lg:flex">
      <div className="px-5 pb-4 pt-6">
        <Brand />
      </div>
      <div className="mx-4 mb-4 rounded-lg border border-line bg-well/50 px-3.5 py-3">
        <p className="truncate text-[13.5px] font-bold text-ink">{org.name}</p>
        <p className="mt-0.5 text-[11.5px] text-ink-3">
          {PLANS[org.plan].label} plan · {role}
        </p>
      </div>
      <nav aria-label="Workspace" className="flex flex-1 flex-col gap-0.5 px-3">
        {NAV_ITEMS.map((item) => {
          const href = navHref(org.slug, item.href);
          const active = pathname === href || pathname.startsWith(href + "/");
          return (
            <Link
              key={item.href}
              href={href}
              aria-current={active ? "page" : undefined}
              className={cx(
                "flex items-center gap-2.5 rounded-xl px-3.5 py-2.5 text-[14px] font-medium text-ink-2 transition-colors hover:bg-well/70 hover:text-ink",
                active && "bg-well/80 font-semibold text-ink"
              )}
            >
              <NavIcon icon={item.icon} />
              {item.label}
            </Link>
          );
        })}
      </nav>
      <p className="px-5 pb-5 text-[11px] leading-relaxed text-ink-4">
        Phase 2 foundation · demo data only
      </p>
    </aside>
  );
}
