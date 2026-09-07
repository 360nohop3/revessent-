/**
 * Client-side auth adapters. Demo mode keeps the Phase 2 demo-session flow
 * (still visibly labeled); real mode talks to /api/v1 (Better Auth).
 * Kept in one place so views don't branch on mode (§22: minimal UI churn).
 */
import { demoMode } from "@revessent/config";

export interface StartResult { ok: boolean; error?: string }

export async function startSession(email: string, password: string): Promise<StartResult> {
  if (demoMode()) {
    const res = await fetch("/api/demo/session", { method: "POST" });
    return res.ok ? { ok: true } : { ok: false, error: "Demo session unavailable — try again." };
  }
  const res = await fetch("/api/v1/auth/sign-in", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password })
  });
  if (res.ok) return { ok: true };
  const problem = (await res.json().catch(() => null)) as { detail?: string } | null;
  return { ok: false, error: problem?.detail ?? "That email and password didn't match. Try again." };
}

export async function registerAccount(name: string, email: string, password: string): Promise<StartResult> {
  if (demoMode()) return { ok: true }; // demo has no accounts to create
  const res = await fetch("/api/v1/auth/sign-up", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, email, password })
  });
  if (res.ok) return { ok: true };
  const problem = (await res.json().catch(() => null)) as { detail?: string } | null;
  return { ok: false, error: problem?.detail ?? "Couldn't create the account. Try again." };
}

export async function endSession(): Promise<void> {
  if (demoMode()) {
    await fetch("/api/demo/session", { method: "DELETE" }).catch(() => undefined);
    return;
  }
  await fetch("/api/v1/auth/sign-out", { method: "POST" }).catch(() => undefined);
}

export async function createWorkspace(name: string, slug: string): Promise<StartResult & { slug?: string }> {
  if (demoMode()) {
    const { getMockApi } = await import("@revessent/contracts");
    await getMockApi().demo.createOrg(name, slug);
    return { ok: true, slug };
  }
  const res = await fetch("/api/v1/orgs", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, slug })
  });
  if (res.ok) return { ok: true, slug };
  const problem = (await res.json().catch(() => null)) as { detail?: string } | null;
  return { ok: false, error: problem?.detail ?? "Couldn't create the workspace. Try again." };
}
