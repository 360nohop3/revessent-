"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Brand } from "@/components/brand";
import { ThemeMenu } from "@/components/theme";
import { cx } from "@revessent/ui";

const LINKS = [
  { href: "/product", label: "Product" },
  { href: "/pricing", label: "Pricing" }
];

export function SiteHeaderNav() {
  const pathname = usePathname();
  return (
    <header className="sticky top-0 z-30 border-b border-line-soft bg-page/80 backdrop-blur-md">
      <div className="mx-auto flex h-[68px] w-[min(1120px,100%-48px)] items-center gap-6">
        <Brand />
        <nav aria-label="Primary" className="flex items-center gap-1">
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              aria-current={pathname === l.href ? "page" : undefined}
              className={cx(
                "rounded-full px-3.5 py-1.5 text-[14px] font-medium text-ink-2 hover:bg-well/60 hover:text-ink",
                pathname === l.href && "bg-well/70 text-ink"
              )}
            >
              {l.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2.5">
          <ThemeMenu />
          <Link href="/sign-in" className="btn btn-glass btn-sm">Sign in</Link>
          <Link href="/sign-up" className="btn btn-pri btn-sm max-sm:hidden">Start free pilot</Link>
        </div>
      </div>
    </header>
  );
}
