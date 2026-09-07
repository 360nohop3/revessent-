import { pingDatabase } from "@revessent/server";
import { serverEnv } from "@revessent/config";

export const dynamic = "force-dynamic";

/**
 * PHASE 8 — web readiness (§16). Lets operators distinguish: app up,
 * configuration incomplete, database unreachable. Contains NO secrets, NO
 * tenant data, NO version of any credential; reports booleans + latency only.
 * (Worker readiness is the worker's own /healthz on WORKER_HEALTH_PORT.)
 */
export async function GET() {
  const startedAt = Date.now();
  let config: "ok" | "invalid" = "ok";
  try { serverEnv(); } catch { config = "invalid"; }
  let db: "up" | "down" | "skipped" = "skipped";
  if (config === "ok") {
    try {
      await Promise.race([
        pingDatabase(),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 3000))
      ]);
      db = "up";
    } catch { db = "down"; }
  }
  const email = process.env.POSTMARK_SERVER_TOKEN ? "configured" : "missing";
  const billingWebhook = process.env.BILLING_WEBHOOK_SECRET ? "configured" : "missing";
  const ok = config === "ok" && db === "up";
  return Response.json(
    { ok, config, db, email, billingWebhook, latencyMs: Date.now() - startedAt },
    { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } }
  );
}
