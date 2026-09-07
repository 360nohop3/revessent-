"use client";

import Link from "next/link";
import { usePathname, useParams } from "next/navigation";
import type { ReactNode } from "react";
import { cx } from "@revessent/ui";

const TABS = [
  { seg: "", label: "Account" },
  { seg: "team", label: "Team" },
  { seg: "stripe", label: "Stripe" },
  { seg: "recovery", label: "Recovery" },
  { seg: "messaging", label: "Messaging" },
  { seg: "ai", label: "AI" },
  { seg: "billing", label: "Billing" }
];

export default function SettingsLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const params = useParams<{ orgSlug: string }>();
  const base = `/app/${params.orgSlug}/settings`;

  return (
    <div className="mx-auto flex w-[min(860px,100%)] flex-col gap-5">
      <header>
        <h1 className="text-[24px] font-bold tracking-[-.02em] text-ink">Settings</h1>
      </header>
      <nav aria-label="Settings sections" className="flex flex-wrap gap-1.5">
        {TABS.map((t) => {
          const href = t.seg ? `${base}/${t.seg}` : base;
          const active = t.seg ? pathname === href : pathname === base || pathname === `${base}/account`;
          return (
            <Link
              key={t.label}
              href={href}
              aria-current={active ? "page" : undefined}
              className={cx(
                "rounded-full border border-line px-3.5 py-1.5 text-[13px] font-medium text-ink-2 hover:bg-well/60",
                active && "border-edge bg-well/80 font-semibold text-ink"
              )}
            >
              {t.label}
            </Link>
          );
        })}
      </nav>
      {children}
    </div>
  );
}
