"use client";

import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { ModeBadge } from "@revessent/ui";
import type { Org, Role, StripeConnection } from "@revessent/contracts";
import { useStripeConnection } from "@/lib/queries";
import { Sidebar } from "./sidebar";
import { MobileNav } from "./mobile-nav";
import { OrgSwitcher } from "./org-switcher";
import { DemoBar } from "./demo-bar";
import { ThemeMenu } from "@/components/theme";
import { endSession } from "@/lib/auth-actions";

export function AppShell({ org, role, children }: { org: Org; role: Role; children: ReactNode }) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const [navOpen, setNavOpen] = useState(false);
  const { data: connection } = useStripeConnection(org.slug);

  async function signOut() {
    // §8/§11: logout must drop server data, not just the cookie.
    queryClient.clear();
    await endSession();
    router.push("/sign-in");
  }

  return (
    <div className="min-h-dvh">
      <Sidebar org={org} role={role} />
      <div className="lg:pl-[248px]">
        <header className="sticky top-0 z-30 border-b border-line-soft bg-page/85 backdrop-blur-md">
          <div className="flex h-[60px] items-center gap-3 px-4 md:px-7">
            <button
              type="button"
              aria-label="Open menu"
              aria-expanded={navOpen}
              onClick={() => setNavOpen(true)}
              className="btn btn-glass btn-sm !px-3 lg:hidden"
            >
              <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true"><path d="M4 7.5h16M4 12h16M4 16.5h10" /></svg>
            </button>
            <OrgSwitcher current={org} />
            <ModeBadge mode={modeOf(connection)} />
            <span className="ml-auto hidden text-[12px] text-ink-4 md:inline">{org.name} · {org.timezone}</span>
            <ThemeMenu />
            <button type="button" onClick={signOut} className="btn btn-glass btn-sm">Sign out</button>
          </div>
        </header>
        <main id="main" className="px-4 pb-28 pt-6 md:px-7">
          {children}
        </main>
      </div>
      <MobileNav open={navOpen} onOpenChange={setNavOpen} org={org} role={role} />
      <DemoBar orgSlug={org.slug} />
    </div>
  );
}

function modeOf(connection?: StripeConnection): "test" | "live" | "demo" {
  if (!connection) return "demo";
  if (connection.mode === "live") return "live";
  if (connection.mode === "test") return "test";
  return "demo";
}
