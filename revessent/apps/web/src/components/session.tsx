"use client";

import { createContext, useContext, type ReactNode } from "react";
/** Session shape shared by the demo realm and the real (Better Auth) realm. */
export interface AppSession {
  email: string;
  name: string;
  memberships: { slug: string; name: string; role: string; plan: string }[];
}

const SessionContext = createContext<AppSession | null>(null);

export function SessionProvider({ session, children }: { session: AppSession; children: ReactNode }) {
  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}

export function useSession(): AppSession {
  const s = useContext(SessionContext);
  if (!s) throw new Error("useSession used outside (app) layout");
  return s;
}

/** Role of the signed-in demo user within a given org slug. */
export type AppRole = "owner" | "admin" | "operator" | "viewer";

export function roleFor(session: AppSession, slug: string): AppRole {
  const role = session.memberships.find((m) => m.slug === slug)?.role;
  return role === "owner" || role === "admin" || role === "operator" || role === "viewer" ? role : "viewer";
}
