"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { computeFreshness, formatAge } from "@revessent/domain";
import { qk } from "@revessent/contracts";
import type { SyncEntityState } from "@revessent/contracts";
import { Badge, Button, FormField, Input, Skeleton, Surface, useToast } from "@revessent/ui";
import { api, ApiError } from "@/lib/api";
import { demoMode } from "@revessent/config";
import { can } from "@/lib/permissions";
import { roleFor, useSession } from "@/components/session";
import { useStripeConnection } from "@/lib/queries";

const READ_SCOPES = ["Account (read)", "Customers (read)", "Subscriptions (read)", "Invoices (read)", "Charges (read)"];

const STATUS_BADGE: Record<string, { tone: "neutral" | "ok" | "warn" | "err" | "info"; label: string }> = {
  not_connected: { tone: "neutral", label: "not connected" },
  read_only: { tone: "ok", label: "connected · read-only" },
  full: { tone: "ok", label: "connected" },
  revoked: { tone: "err", label: "revoked — reconnect required" },
  invalid: { tone: "err", label: "validation failed" },
  error: { tone: "warn", label: "degraded" }
};

const SYNC_LABEL: Record<SyncEntityState["status"], string> = {
  never: "never synced",
  running: "syncing…",
  fresh: "fresh",
  stale: "stale",
  failed: "failed — previous data preserved"
};

function safeSyncError(code: string | null): string {
  // Server already sends safe taxonomy codes; never render provider internals.
  const map: Record<string, string> = {
    invalid_credentials: "Stripe rejected the stored key — reconnect.",
    revoked: "This key was revoked in Stripe — reconnect.",
    auth_failure: "Stripe could not authenticate — reconnect.",
    permission_failure: "The key is missing a required read scope.",
    rate_limited: "Stripe rate-limited the sync. Previous data is preserved — retry shortly.",
    transient_network: "Could not reach Stripe. Previous data is preserved — retry.",
    provider_outage: "Stripe is temporarily unavailable. Data preserved — retry later.",
    malformed_response: "Stripe returned an unexpected response. Data preserved.",
    invalid_provider_object: "A record could not be interpreted. Others were synced."
  };
  return code ? map[code] ?? "Sync failed. Previous data is preserved." : "Sync failed. Previous data is preserved.";
}

export function StripeView({ orgSlug }: { orgSlug: string }) {
  const session = useSession();
  const role = roleFor(session, orgSlug);
  const allowed = can(role, "manage_stripe");
  const canSync = can(role, "run_sync");
  const conn = useStripeConnection(orgSlug);
  const qc = useQueryClient();
  const { toast } = useToast();
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [reconciling, setReconciling] = useState(false);

  async function connect(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // Real mode: the server validates against Stripe BEFORE storing — the
      // response only ever contains safe metadata, never the key.
      await api.settings.stripeConnect(orgSlug, key);
      await qc.invalidateQueries({ queryKey: qk.stripe(orgSlug) });
      await qc.invalidateQueries({ queryKey: qk.overview(orgSlug) });
      setKey("");
      const demo = demoMode();
      toast(demo
        ? { title: "Connected (demo)", description: "Format validated only — no key was stored or transmitted anywhere.", tone: "info" as const }
        : { title: "Stripe connected", description: "Validated with a read-only call and stored encrypted. Audits keep only the last 4 characters. Run a sync to import your data.", tone: "info" as const });
    } catch (err) {
      setError(err instanceof ApiError ? err.problem.detail ?? err.problem.title : "Connection failed — nothing was stored.");
    } finally {
      setBusy(false);
    }
  }

  async function disconnect() {
    setBusy(true);
    try {
      await api.settings.stripeDisconnect(orgSlug);
      await qc.invalidateQueries({ queryKey: qk.stripe(orgSlug) });
      await qc.invalidateQueries({ queryKey: qk.overview(orgSlug) });
      toast(demoMode()
        ? { title: "Disconnected (demo)", tone: "info" as const }
        : { title: "Stripe connection removed", description: "The stored connection was deleted from this workspace.", tone: "info" as const });
    } finally {
      setBusy(false);
    }
  }

  async function runSync() {
    setSyncing(true);
    setError(null);
    try {
      const res = await api.settings.sync(orgSlug);
      await qc.invalidateQueries({ queryKey: qk.stripe(orgSlug) });
      await qc.invalidateQueries({ queryKey: qk.overview(orgSlug) });
      await qc.invalidateQueries({ queryKey: qk.cases(orgSlug, {}) });
      await qc.invalidateQueries({ queryKey: qk.customers(orgSlug, {}) });
      await qc.invalidateQueries({ queryKey: qk.opportunities(orgSlug) });
      const failed = Object.entries(res.summary).filter(([, r]) => r.status === "failed");
      if (failed.length > 0) {
        toast({ title: "Sync finished with failures", description: "Previously synced data is preserved. Check the status below.", tone: "warn" as const });
      } else {
        toast({ title: "Sync complete", description: "Customers, subscriptions and payments refreshed from Stripe.", tone: "ok" as const });
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.problem.detail ?? err.problem.title : "Sync failed — previous data is preserved.");
    } finally {
      setSyncing(false);
    }
  }
  async function runReconcile() {
    setReconciling(true);
    try {
      await api.settings.reconcile(orgSlug);
      await qc.invalidateQueries({ queryKey: qk.stripe(orgSlug) });
      toast({ title: "Reconciliation complete", description: "Stripe re-checked as the source of truth; failed webhook events resolved.", tone: "ok" as const });
    } catch (err) {
      setError(err instanceof ApiError ? err.problem.detail ?? err.problem.title : "Reconciliation failed — previous data is preserved.");
    } finally {
      setReconciling(false);
    }
  }


  const d = conn.data;
  const showForm = !d || d.status === "not_connected" || d.status === "revoked" || d.status === "invalid";
  const anyRunning = d?.sync ? Object.values(d.sync).some((s) => s.status === "running") : false;

  return (
    <div className="flex flex-col gap-4">
      <Surface level={2} className="p-6">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-[16px] font-bold text-ink">Stripe connection</h2>
          {conn.isLoading ? (
            <Skeleton className="h-6 w-24" />
          ) : d ? (
            <Badge tone={STATUS_BADGE[d.status]?.tone ?? "neutral"}>
              {STATUS_BADGE[d.status]?.label ?? d.status}
            </Badge>
          ) : null}
          {d?.mode ? <Badge tone={d.mode === "test" ? "warn" : "ok"}>{d.mode} mode</Badge> : null}
        </div>

        {conn.isLoading ? (
          <div className="mt-4" role="status"><Skeleton className="h-16 w-full" /></div>
        ) : d && d.status !== "not_connected" ? (
          <>
            <div className="mt-4 grid gap-x-6 gap-y-1 text-[13.5px] text-ink-2 sm:grid-cols-[160px_1fr]">
              <span className="text-ink-3">Account</span>
              <span className="num font-mono">
                {d.displayName ? `${d.displayName} · ` : ""}{d.accountRef}
              </span>
              {d.country || d.defaultCurrency ? (
                <>
                  <span className="text-ink-3">Locale</span>
                  <span className="num font-mono">{[d.country, d.defaultCurrency?.toUpperCase()].filter(Boolean).join(" · ")}</span>
                </>
              ) : null}
              {d.keyLast4 ? (
                <>
                  <span className="text-ink-3">Restricted key</span>
                  <span className="num font-mono">…{d.keyLast4} (stored encrypted)</span>
                </>
              ) : null}
              <span className="text-ink-3">Validated</span>
              <span className="num font-mono">
                {d.lastValidatedAt ? `${formatAge(d.lastValidatedAt)} (${computeFreshness(d.lastValidatedAt)})` : "at connect time"}
              </span>
              <span className="text-ink-3">Last sync</span>
              <span className="num font-mono">
                {d.lastSyncAt ? `${formatAge(d.lastSyncAt)} (${computeFreshness(d.lastSyncAt)})` : "never"}
              </span>
              <span className="text-ink-3">Write scopes</span>
              <span>{d.status === "full" ? "retry execution enabled" : "none — read-only"}</span>
            </div>

            {d.status === "revoked" ? (
              <p role="note" className="mt-3 rounded-md border border-err/30 bg-well/40 px-3.5 py-2.5 text-[13.5px] text-ink-2">
                This key was revoked or rotated in Stripe. Reconnect with a fresh restricted key below.
              </p>
            ) : null}
            {d.status === "invalid" ? (
              <p role="note" className="mt-3 rounded-md border border-err/30 bg-well/40 px-3.5 py-2.5 text-[13.5px] text-ink-2">
                The last key failed Stripe&apos;s validation. Nothing ambiguous is stored — reconnect with a valid key.
              </p>
            ) : null}

            {/* per-entity sync freshness (§10) — honest states only */}
            {d.sync ? (
              <div className="mt-4 rounded-lg border border-line p-3.5">
                <div className="grid gap-x-6 gap-y-1 text-[13px] sm:grid-cols-[140px_1fr]">
                  {(["customers", "subscriptions", "invoices"] as const).map((entity) => {
                    const s = d.sync![entity];
                    return (
                      <div key={entity} className="contents">
                        <span className="text-ink-3 capitalize">{entity}</span>
                        <span className="num font-mono text-ink-2">
                          {SYNC_LABEL[s.status]}
                          {s.lastSuccessAt ? ` · ${formatAge(s.lastSuccessAt)}` : ""}
                          {s.status === "failed" ? ` — ${safeSyncError(s.errorCode)}` : ""}
                        </span>
                      </div>
                    );
                  })}
                </div>
                {d.status === "read_only" && canSync ? (
                  <Button size="sm" className="mt-3" loading={syncing} onClick={() => void runSync()}>
                    {anyRunning ? "Syncing…" : d.lastSyncAt ? "Sync now" : "Run first sync"}
                  </Button>
                ) : null}
                {d.status === "read_only" && !canSync ? (
                  <p className="mt-3 text-[12.5px] text-ink-3">Syncing requires an operator, admin or owner role.</p>
                ) : null}
              </div>
            ) : null}

            {/* webhook delivery status (Phase 4B §9) — near-real-time truth,
                honest about failed/unprocessed events; reconciliation reuses
                the read-only sync (no second credential system) */}
            {d.webhooks ? (
              <div className="mt-3 rounded-lg border border-line p-3.5" data-testid="webhook-status">
                <div className="grid gap-x-6 gap-y-1 text-[13px] sm:grid-cols-[140px_1fr]">
                  <span className="text-ink-3">Webhooks</span>
                  <span className="num font-mono text-ink-2">
                    {d.webhooks.configured ? `configured · ${d.webhooks.endpointId}` : "not configured — sync remains the source of truth"}
                  </span>
                  <span className="text-ink-3">Last delivery</span>
                  <span className="num font-mono text-ink-2">
                    {d.webhooks.lastWebhookAt ? `${formatAge(d.webhooks.lastWebhookAt)} · ${computeFreshness(d.webhooks.lastWebhookAt)}` : "none received yet"}
                  </span>
                  {d.webhooks.failed > 0 ? (
                    <>
                      <span className="text-ink-3">Failed events</span>
                      <span className="num font-mono text-warn-ink">
                        {d.webhooks.failed} — preserved for reconciliation
                        {d.webhooks.lastFailureCode ? ` (last: ${d.webhooks.lastFailureCode})` : ""}
                      </span>
                    </>
                  ) : null}
                  {d.webhooks.unprocessed > 0 ? (
                    <>
                      <span className="text-ink-3">Unprocessed</span>
                      <span className="num font-mono text-warn-ink">{d.webhooks.unprocessed} awaiting processing</span>
                    </>
                  ) : null}
                  {d.webhooks.lifecycle && d.webhooks.lifecycle !== "healthy" ? (
                    <>
                      <span className="text-ink-3">Lifecycle</span>
                      <span className="num font-mono text-warn-ink">
                        {d.webhooks.lifecycle === "registration_failed"
                          ? "endpoint registration failed — sync covers delivery; reconnect to register"
                          : d.webhooks.lifecycle === "cleanup_pending"
                          ? "endpoint cleanup pending — retry disconnect/reconnect; state is recoverable"
                          : d.webhooks.lifecycle === "provider_removed_local_stale"
                          ? "provider endpoint removed — retry disconnect to finalize locally"
                          : "orphaned endpoint recorded — reconciliation will clean it up"}
                      </span>
                    </>
                  ) : null}
                </div>
                {d.webhooks.failed > 0 && d.status === "read_only" && canSync ? (
                  <Button size="sm" className="mt-3" loading={reconciling} onClick={() => void runReconcile()}>
                    Reconcile with Stripe
                  </Button>
                ) : null}
              </div>
            ) : null}

            <p className="mt-3 text-[12.5px] text-ink-3">
              Upgrading to write scopes (retries, checkout creation) happens in a later phase, with your
              explicit re-authorization.
            </p>
            {allowed ? (
              <Button variant="danger" size="sm" className="mt-4" loading={busy} onClick={() => void disconnect()}>
                Disconnect (revoke access)
              </Button>
            ) : null}
          </>
        ) : null}
      </Surface>

      {showForm ? (
        <Surface level={2} className="p-6">
          <h2 className="text-[16px] font-bold text-ink">Connect with a restricted key</h2>
          <ol className="mt-3 flex flex-col gap-1.5 text-[13.5px] text-ink-2">
            <li>1. In Stripe: Developers → API keys → Create restricted key.</li>
            <li>2. Grant read scopes only: {READ_SCOPES.join(", ")}.</li>
            <li>3. Paste the key below — it is validated with a read-only call, then stored encrypted.</li>
          </ol>
          {allowed ? (
            <form className="mt-4 flex flex-col gap-3 md:flex-row md:items-end" onSubmit={connect} noValidate>
              <FormField
                id="sk"
                label="Restricted key"
                hint={demoMode()
                  ? "Demo validates the FORMAT only (sk_test_… / rk_test_…). Nothing is stored or sent."
                  : "Validated with a harmless read-only Stripe call before anything is stored. Never displayed again."}
                error={error}
                className="flex-1"
              >
                <Input value={key} onChange={(e) => setKey(e.target.value)} placeholder="rk_test_…" spellCheck={false} autoComplete="off" />
              </FormField>
              <Button type="submit" loading={busy}>Connect</Button>
            </form>
          ) : (
            <p role="note" className="mt-4 rounded-md border border-line bg-well/40 px-3.5 py-2.5 text-[13.5px] text-ink-3">
              Connecting Stripe requires an admin or owner role.
            </p>
          )}
        </Surface>
      ) : null}
    </div>
  );
}
