import { demoMode, isProduction } from "@revessent/config";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getMockApi } from "@revessent/contracts";
import { DEMO_SESSION_COOKIE, encodeDemoSession } from "@/lib/session";

/**
 * DEMO-ONLY session endpoint. Sets an httpOnly cookie that carries a
 * demo:true payload — it authenticates nothing. The real session/auth model
 * arrives in Phase 4. Guarded routes treat this cookie as a navigation guard
 * exclusively (Phase 2 §6).
 */
export async function POST() {
  // isProduction() checked FIRST: demoMode() refuses demo-in-production with a
  // ConfigError (fail-loud for misconfiguration); here it surfaces as a plain
  // 404 — a production process never exposes demo endpoints.
  if (isProduction() || !demoMode()) {
    return NextResponse.json({ ok: false, error: "Demo mode disabled" }, { status: 404 });
  }
  const session = getMockApi().demo.session();
  const jar = await cookies();
  jar.set(DEMO_SESSION_COOKIE, encodeDemoSession(session), {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 8
  });
  return NextResponse.json({ ok: true, demo: true, session });
}

export async function DELETE() {
  const jar = await cookies();
  jar.delete(DEMO_SESSION_COOKIE);
  return NextResponse.json({ ok: true });
}
