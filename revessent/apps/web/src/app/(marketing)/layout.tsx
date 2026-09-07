import type { ReactNode } from "react";
import Link from "next/link";
import { Brand } from "@/components/brand";
import { SiteHeaderNav } from "@/components/marketing/site-header-nav";

export default function MarketingLayout({ children }: { children: ReactNode }) {
  return (
    <div className="relative min-h-dvh">
      {/* Static atmospheric wash — CSS only, theme-aware, zero JS (Phase 2 §17). */}
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 -z-10"
        style={{
          background:
            "radial-gradient(120% 90% at 50% -10%, rgb(var(--accC) / .14), transparent 60%), radial-gradient(90% 60% at 80% 110%, rgb(var(--lc) / .10), transparent 55%)"
        }}
      />
      <SiteHeaderNav />
      <main id="main">{children}</main>
      <footer className="mt-24 border-t border-line-soft">
        <div className="mx-auto flex w-[min(1120px,100%-48px)] flex-col gap-6 py-10 md:flex-row md:items-start md:justify-between">
          <div className="flex flex-col gap-2">
            <Brand />
            <p className="max-w-[46ch] text-[13px] text-ink-3">
              Revenue intelligence for subscription businesses. This is the Phase 2 frontend
              foundation — data on this site is demo data, and no real actions can be taken yet.
            </p>
          </div>
          <nav aria-label="Footer" className="flex flex-wrap gap-x-8 gap-y-2 text-[13.5px] text-ink-2">
            <Link className="hover:text-ink" href="/product">Product</Link>
            <Link className="hover:text-ink" href="/pricing">Pricing</Link>
            <Link className="hover:text-ink" href="/privacy">Privacy</Link>
            <Link className="hover:text-ink" href="/terms">Terms</Link>
            <Link className="hover:text-ink" href="/sign-in">Sign in</Link>
          </nav>
        </div>
        <div className="mx-auto w-[min(1120px,100%-48px)] pb-10 text-[12px] text-ink-4">
          © 2026 Revessent — foundation build. Figures shown anywhere on this site are illustrative.
        </div>
      </footer>
    </div>
  );
}
