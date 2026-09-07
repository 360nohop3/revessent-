import { NextResponse, type NextRequest } from "next/server";

/**
 * Platform hardening, first slice (§7.7 — "wired now, deepened Phase 4/8"):
 * security headers on every response. CSP nonce-based strictness lands with
 * the Phase 8 hardening pass; navigation/auth/data work with effects disabled.
 */
export function middleware(req: NextRequest) {
  const res = NextResponse.next();
  // Phase 8: API and token-bearing pages are never cacheable by shared caches.
  const p = req.nextUrl.pathname;
  if (p.startsWith("/api/") || p.startsWith("/c/") || p.startsWith("/u/") || p.startsWith("/unsubscribe") || p.startsWith("/reset-password") || p.startsWith("/verify-email")) {
    res.headers.set("Cache-Control", "no-store");
  }
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  res.headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.headers.set("X-Frame-Options", "DENY");
  res.headers.set("Content-Security-Policy", "frame-ancestors 'none'");
  if (process.env.NODE_ENV === "production") {
    res.headers.set("Strict-Transport-Security", "max-age=63072000; includeSubDomains; preload");
  }
  return res;
}

export const config = { matcher: ["/((?!_next/static|_next/image|favicon.ico|fonts).*)"] };
