import type { ReactNode } from "react";
import Link from "next/link";
import { Brand } from "@/components/brand";
import { ThemeMenu } from "@/components/theme";

export default function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="relative flex min-h-dvh flex-col">
      <div
        aria-hidden="true"
        className="pointer-events-none fixed inset-0 -z-10"
        style={{ background: "radial-gradient(110% 80% at 50% -10%, rgb(var(--accC) / .12), transparent 60%)" }}
      />
      <header className="flex items-center justify-between px-6 py-5">
        <Brand />
        <div className="flex items-center gap-2.5">
          <ThemeMenu />
          <Link href="/" className="btn btn-ghost btn-sm">Back to site</Link>
        </div>
      </header>
      <main id="main" className="flex flex-1 items-start justify-center px-4 pb-16 pt-6">
        <div className="w-[min(440px,100%)]">{children}</div>
      </main>
    </div>
  );
}
