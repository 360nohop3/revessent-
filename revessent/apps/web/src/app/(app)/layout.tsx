import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { resolveSession } from "@/lib/session";
import { SessionProvider } from "@/components/session";

/**
 * Navigation guard (Phase 2 §6) — now backed by a REAL session in real mode
 * (Better Auth cookie) and the labeled demo cookie in demo mode. Guards only
 * decide what renders; authorization is enforced by /api/v1 handlers (§8).
 */
export default async function AppGroupLayout({ children }: { children: ReactNode }) {
  const session = await resolveSession();
  if (!session) redirect("/sign-in?next=/app");
  return (
    <SessionProvider session={{ email: session.email, name: session.name, memberships: session.memberships }}>
      {children}
    </SessionProvider>
  );
}
