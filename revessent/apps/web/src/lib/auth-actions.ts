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

/* ---------------- Phase 8: account lifecycle (real mode only) ---------------- */

/** Always resolves ok — the server answers identically whether or not the account exists. */
export async function requestPasswordReset(email: string): Promise<StartResult> {
  if (demoMode()) return { ok: true };
  const res = await fetch("/api/v1/auth/request-password-reset", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email })
  });
  if (res.ok) return { ok: true };
  const problem = (await res.json().catch(() => null)) as { detail?: string } | null;
  return { ok: false, error: problem?.detail ?? "Couldn't start the reset. Try again." };
}

export async function resetPassword(token: string, newPassword: string): Promise<StartResult> {
  if (demoMode()) return { ok: false, error: "Password resets are not available in the demo." };
  const res = await fetch("/api/v1/auth/reset-password", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, newPassword })
  });
  if (res.ok) return { ok: true };
  const problem = (await res.json().catch(() => null)) as { detail?: string; message?: string } | null;
  return { ok: false, error: problem?.detail ?? problem?.message ?? "This reset link is invalid or has expired. Request a new one." };
}

export async function verifyEmail(token: string): Promise<StartResult> {
  if (demoMode()) return { ok: false, error: "Email verification is not available in the demo." };
  const res = await fetch("/api/v1/auth/verify-email", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token })
  });
  if (res.ok) return { ok: true };
  return { ok: false, error: "This verification link is invalid or has expired. Sign in and request a new one." };
}

export async function resendVerification(): Promise<StartResult> {
  if (demoMode()) return { ok: true };
  const res = await fetch("/api/v1/auth/resend-verification", { method: "POST" });
  return res.ok ? { ok: true } : { ok: false, error: "Couldn't resend the verification email. Try again shortly." };
}
