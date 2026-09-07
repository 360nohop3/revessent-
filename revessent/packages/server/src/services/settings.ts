/**
 * Settings services: Stripe connection, retry policy, voice, team, billing.
 * §17 boundary: the connection MODEL is persisted (keys envelope-encrypted);
 * real synchronization/execution belongs to the next phase — lastSyncAt stays
 * null (frontend renders honest "never synced") and no sync is ever faked.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import * as schema from "@revessent/db";
import { withOrgTx, type Db } from "@revessent/db";
import { serverEnv } from "@revessent/config";
import type { StripeConnection, RetryPolicy, VoiceProfile, TeamMember, BillingInfo, SyncEntityState, Role as ContractRole } from "@revessent/contracts";
import { sealSecret, openSecret, keyDisplayLast4 } from "../crypto/secret-box.js";
import { getStripeGateway, isProviderError } from "@revessent/integrations";
import { ProblemError } from "../http/problems.js";
import { audit } from "./audit.js";
import { reserveSeat } from "./entitlements.js";
import { resolveEntitlements } from "@revessent/domain";
import { WEBHOOK_EVENT_TYPES, webhookEndpointUrl, webhookStatus, type WebhookLifecycle } from "./webhooks.js";
import type { OrgContext } from "../context.js";

const RESTRICTED_KEY_RE = /^(sk|rk)_(test|live)_[A-Za-z0-9]{16,}$/;

/* ---------------- Stripe ---------------- */

export async function stripeConnection(ctx: OrgContext): Promise<StripeConnection> {
  const rows = await withOrgTx(ctx.db, ctx.org.id, (tx) =>
    tx.select().from(schema.stripeConnections)
      .where(and(eq(schema.stripeConnections.orgId, ctx.org.id), inArray(schema.stripeConnections.status, ["active", "revoked", "invalid", "error"])))
      .orderBy(desc(schema.stripeConnections.createdAt)).limit(1));
  const c = rows[0];
  if (!c) {
    // No usable connection — but recorded lifecycle debris (e.g. an orphaned
    // endpoint from a failed connect) must stay observable, never hidden.
    const orphaned = await withOrgTx(ctx.db, ctx.org.id, (tx) =>
      tx.select({ n: sql<number>`count(*)::int` }).from(schema.stripeConnections)
        .where(and(eq(schema.stripeConnections.orgId, ctx.org.id), eq(schema.stripeConnections.status, "orphaned"))));
    return notConnected((orphaned[0]?.n ?? 0) > 0 ? "orphan_cleanup" : "healthy");
  }
  const readScopes = Array.isArray((c.scopes as { read?: string[] })?.read);
  const status: StripeConnection["status"] =
    c.status === "revoked" ? "revoked"
    : c.status === "invalid" ? "invalid"
    : c.status === "error" ? "error"
    : readScopes ? "read_only" : "error";

  // per-entity freshness (§10) — derived from durable sync_state rows
  const syncRows = await withOrgTx(ctx.db, ctx.org.id, (tx) =>
    tx.select().from(schema.syncState).where(eq(schema.syncState.orgId, ctx.org.id)));
  const sync = {
    customers: entityState(syncRows.find((r) => r.entity === "customers")),
    subscriptions: entityState(syncRows.find((r) => r.entity === "subscriptions")),
    invoices: entityState(syncRows.find((r) => r.entity === "invoices"))
  };

  // webhook delivery status (§9): near-real-time freshness vs sync freshness
  const webhooks = await webhookStatus(ctx.db, ctx.org.id, c);

  return {
    status,
    mode: c.mode as "test" | "live",
    accountRef: c.stripeAccountId,
    lastSyncAt: c.lastSyncAt?.toISOString() ?? null,
    backfill: c.backfillDoneAt ? "done" : null,
    keyLast4: c.keyLast4,
    displayName: c.displayName ?? null,
    country: c.accountCountry ?? null,
    defaultCurrency: c.defaultCurrency ?? null,
    lastValidatedAt: c.lastValidatedAt?.toISOString() ?? null,
    sync,
    webhooks
  };
}

function notConnected(lifecycle: WebhookLifecycle = "healthy"): StripeConnection {
  const webhooks: StripeConnection["webhooks"] = {
    configured: false, endpointId: null, lastWebhookAt: null,
    failed: 0, unprocessed: 0, lastFailureCode: null, lastFailureAt: null,
    lifecycle
  };
  return {
    status: "not_connected", mode: null, accountRef: null, lastSyncAt: null, backfill: null,
    keyLast4: null, displayName: null, country: null, defaultCurrency: null, lastValidatedAt: null,
    sync: {
      customers: { status: "never", lastSuccessAt: null, lastAttemptAt: null, errorCode: null },
      subscriptions: { status: "never", lastSuccessAt: null, lastAttemptAt: null, errorCode: null },
      invoices: { status: "never", lastSuccessAt: null, lastAttemptAt: null, errorCode: null }
    },
    webhooks
  };
}

function entityState(row: typeof schema.syncState["$inferSelect"] | undefined): SyncEntityState {
  if (!row) {
    // connected but never synced is "never" — never an empty/fabricated zero state
    return { status: "never", lastSuccessAt: null, lastAttemptAt: null, errorCode: null };
  }
  const status: SyncEntityState["status"] =
    row.status === "running" ? "running"
    : row.status === "failed" ? "failed"
    : row.lastSuccessAt ? freshnessOf(row.lastSuccessAt)
    : "never";
  return {
    status,
    lastSuccessAt: row.lastSuccessAt?.toISOString() ?? null,
    lastAttemptAt: row.finishedAt?.toISOString() ?? row.startedAt?.toISOString() ?? null,
    errorCode: row.lastError ?? null
  };
}

/** Freshness window (§10): 6h. Past that, display honestly as stale. */
function freshnessOf(date: Date): "fresh" | "stale" {
  return Date.now() - date.getTime() < 6 * 3600 * 1000 ? "fresh" : "stale";
}

/**
 * STRIPE CONNECTION LIFECYCLE (Phase 4B correction).
 *
 * The provider endpoint lifecycle and the PostgreSQL lifecycle cannot share a
 * transaction. Every transition is therefore split into provider operations
 * (NO local transaction open) and local finalizations (NO provider I/O open),
 * with durable states on stripe_connections (migration 0016) so that every
 * crash/failure lands in a RECOVERABLE, OBSERVABLE state:
 *
 *   status 'provisioning' + webhook_state 'creating'
 *     → durable intent written BEFORE the provider call; a crash is cleaned
 *       up by reconciliation (locates our endpoint via its self-registered
 *       URL — read-only discovery — and deletes it; local row reaped).
 *   status 'active' + webhook_state 'registration_failed'
 *     → endpoint creation failed; the read-only connection is valid and the
 *       sync delta path covers delivery (surfaced, never fatal, 4B behavior).
 *   status 'active' + webhook_state 'cleanup_pending'
 *     → a provider endpoint still needs deletion; the sealed key is retained
 *       so a retry/reconciliation can complete the cleanup. Never reported
 *       as a clean success.
 *   status 'active' + webhook_state 'provider_deleted_local_stale'
 *     → provider endpoint confirmed deleted but the local finalization did
 *       not commit; retry or reconciliation completes it locally.
 *   status 'orphaned' + webhook_state 'orphan_cleanup'
 *     → a created endpoint could neither be finalized locally nor
 *       compensated; the row keeps the sealed key + endpoint id so
 *       reconciliation can clean it up. Never surfaced as a connection.
 *
 * Invariants (correction §11): a successfully created provider endpoint can
 * never become permanently unknown; a failed replacement can never silently
 * destroy the last usable local connection; mismatches are recoverable and
 * observable; no failure exposes or logs any secret.
 */
export async function stripeConnect(
  ctx: OrgContext, key: string, meta: { ip?: string | null; userAgent?: string | null }
): Promise<StripeConnection> {
  if (!RESTRICTED_KEY_RE.test(key)) {
    throw new ProblemError("validation", "That doesn't look like a Stripe restricted key (expected sk|rk_test|live_…).");
  }
  const mode = key.startsWith("sk_test") || key.startsWith("rk_test") ? "test" : "live";

  await withOrgTx(ctx.db, ctx.org.id, (tx) => audit(tx as unknown as Db, {
    orgId: ctx.org.id, actorId: ctx.userId, action: "connection.attempted",
    targetType: "stripe_connection", targetId: ctx.org.id,
    diff: { mode }, ip: meta.ip, userAgent: meta.userAgent
  }));

  // Harmless READ-ONLY provider validation (§6 steps 4–5): account identity
  // comes from Stripe itself — never from the key prefix or user input.
  // Nothing is stored on failed validation (§21.10) — unchanged from 4A.
  let account;
  try {
    account = await getStripeGateway().verifyAccount(key);
  } catch (err) {
    if (isProviderError(err)) {
      await withOrgTx(ctx.db, ctx.org.id, (tx) => audit(tx as unknown as Db, {
        orgId: ctx.org.id, actorId: ctx.userId, action: "connection.failed",
        targetType: "stripe_connection", targetId: ctx.org.id,
        diff: { mode, code: err.code }, ip: meta.ip, userAgent: meta.userAgent
      }));
      if (err.code === "rate_limited") throw new ProblemError("rate-limited", err.safeMessage);
      if (err.code === "revoked") throw new ProblemError("conflict", err.safeMessage);
      if (err.status >= 500) throw new ProblemError("internal", err.safeMessage);
      throw new ProblemError("validation", err.safeMessage);
    }
    throw new ProblemError("internal", "Connection could not be validated. Nothing was stored.");
  }

  const sealed = sealSecret(key, serverEnv().KEY_ENCRYPTION_KEY);

  // ---- LOCAL step 1: durable provisioning intent (BEFORE any provider call)
  // The row id names the receiver URL, so the endpoint we are about to create
  // is ALREADY durably associated with a local row before it exists.
  const [provisioned] = await withOrgTx(ctx.db, ctx.org.id, (tx) =>
    tx.insert(schema.stripeConnections).values({
      orgId: ctx.org.id, mode,
      stripeAccountId: account.id,
      displayName: account.displayName,
      accountCountry: account.country,
      defaultCurrency: account.defaultCurrency?.toUpperCase().slice(0, 3) ?? null,
      keyCiphertext: sealed,
      keyLast4: keyDisplayLast4(key),
      scopes: { read: ["account", "customers", "subscriptions", "invoices", "charges"] },
      status: "provisioning",
      webhookState: "creating",
      lastValidatedAt: new Date(),
      validationError: null
    }).returning());

  // ---- PROVIDER step 2: endpoint creation (NO local transaction open)
  const safeLocalFailure = new ProblemError(
    "internal",
    "The Stripe account was validated, but the connection could not be stored. No partial state was kept without a record — retry."
  );
  let endpoint: { id: string; secret: string };
  try {
    endpoint = await getStripeGateway().createWebhookEndpoint(key, {
      url: webhookEndpointUrl(provisioned!.id), // {orgRef} = the CONNECTION id (0013 resolver)
      eventTypes: [...WEBHOOK_EVENT_TYPES]
    });
  } catch (err) {
    const webhookErrorCode = isProviderError(err) ? err.code : "transient_network";
    // Non-fatal (4B behavior preserved): read-only connection becomes active,
    // the sync delta path covers delivery, the failure stays observable.
    await withOrgTx(ctx.db, ctx.org.id, async (tx) => {
      await tx.update(schema.stripeConnections).set({
        status: "active", webhookState: "registration_failed",
        webhookEndpointId: null, webhookSecretEnc: null
      }).where(eq(schema.stripeConnections.id, provisioned!.id));
      await audit(tx as unknown as Db, {
        orgId: ctx.org.id, actorId: ctx.userId, action: "connection.succeeded",
        targetType: "stripe_connection", targetId: provisioned!.id,
        diff: { mode, last4: keyDisplayLast4(key), account: account.id, webhook: `not_registered:${webhookErrorCode}` },
        ip: meta.ip, userAgent: meta.userAgent
      });
    });
    return stripeConnection(ctx);
  }

  // ---- LOCAL step 3: durable finalization of the new connection.
  // ATOMIC with superseding the previous usable row: the old row keeps its
  // provider endpoint + sealed key (moved to recoverable 'error'/
  // 'cleanup_pending') so the org's last usable connection is destroyed by
  // THIS COMMIT ONLY — a failure here rolls back to the old connection
  // untouched. Provider-side deletion of the superseded endpoint happens
  // AFTER this commit (no provider I/O inside transactions).
  try {
    await withOrgTx(ctx.db, ctx.org.id, async (tx) => {
      // Supersede FIRST (the new row is still 'provisioning', so this update
      // can only touch the OLD usable row), then activate the new row — the
      // partial unique index (0016) holds at every statement boundary.
      await tx.update(schema.stripeConnections).set({
        status: "error", webhookState: "cleanup_pending"
      }).where(and(
        eq(schema.stripeConnections.orgId, ctx.org.id),
        eq(schema.stripeConnections.mode, mode),
        eq(schema.stripeConnections.status, "active")
      ));
      await tx.update(schema.stripeConnections).set({
        status: "active", webhookState: null,
        webhookEndpointId: endpoint.id,
        webhookSecretEnc: sealSecret(endpoint.secret, serverEnv().KEY_ENCRYPTION_KEY)
      }).where(eq(schema.stripeConnections.id, provisioned!.id));
      await audit(tx as unknown as Db, {
        orgId: ctx.org.id, actorId: ctx.userId, action: "connection.succeeded",
        targetType: "stripe_connection", targetId: provisioned!.id,
        diff: { mode, last4: keyDisplayLast4(key), account: account.id, webhook: "registered" }, // NEVER the key/secret (§18)
        ip: meta.ip, userAgent: meta.userAgent
      });
    });
  } catch {
    // Provider endpoint EXISTS but local finalization failed → compensate.
    // Never fabricate local success; never expose the secret; safe codes only.
    let compensated = false;
    try {
      await getStripeGateway().deleteWebhookEndpoint(key, endpoint.id);
      compensated = true;
    } catch (compErr) {
      // Compensation failed → durable ORPHAN record (sealed key retained for
      // cleanup authentication; endpoint id is safe operational metadata).
      await withOrgTx(ctx.db, ctx.org.id, async (tx) => {
        await tx.update(schema.stripeConnections).set({
          status: "orphaned", webhookState: "orphan_cleanup",
          webhookEndpointId: endpoint.id,
          webhookSecretEnc: sealSecret(endpoint.secret, serverEnv().KEY_ENCRYPTION_KEY)
        }).where(eq(schema.stripeConnections.id, provisioned!.id));
        await audit(tx as unknown as Db, {
          orgId: ctx.org.id, actorId: ctx.userId, action: "connection.failed",
          targetType: "stripe_connection", targetId: provisioned!.id,
          diff: {
            stage: "finalize", mode, last4: keyDisplayLast4(key), account: account.id,
            orphan_recorded: true, endpoint: endpoint.id,
            code: isProviderError(compErr) ? compErr.code : "transient_network"
          },
          ip: meta.ip, userAgent: meta.userAgent
        });
      }).catch(() => undefined); // even this record is best-effort; the
      // 'provisioning'/'creating' row still routes reconciliation to a
      // URL-based discovery sweep, so the endpoint cannot become unknown.
    }
    if (compensated) {
      // Nothing provider-side remains and the attempt row holds nothing of
      // value → remove the stub; the audit entry IS the durable record.
      await withOrgTx(ctx.db, ctx.org.id, async (tx) => {
        await tx.delete(schema.stripeConnections).where(eq(schema.stripeConnections.id, provisioned!.id));
        await audit(tx as unknown as Db, {
          orgId: ctx.org.id, actorId: ctx.userId, action: "connection.failed",
          targetType: "stripe_connection", targetId: provisioned!.id,
          diff: { stage: "finalize", mode, last4: keyDisplayLast4(key), account: account.id, compensated: true, endpoint: endpoint.id },
          ip: meta.ip, userAgent: meta.userAgent
        });
      }).catch(() => undefined);
    }
    throw safeLocalFailure; // the ORIGINAL safe local failure — nothing fabricated
  }

  // ---- ROTATION (only AFTER the new connection is durably usable): clean up
  // the previous same-mode connection's provider endpoint, then its row.
  // A cleanup failure keeps the old row recoverable (status 'error' +
  // 'cleanup_pending' + sealed key) and NEVER invalidates the new connection.
  const oldRows = await withOrgTx(ctx.db, ctx.org.id, (tx) =>
    tx.select().from(schema.stripeConnections)
      .where(and(
        eq(schema.stripeConnections.orgId, ctx.org.id),
        eq(schema.stripeConnections.mode, mode),
        inArray(schema.stripeConnections.status, ["active", "revoked", "invalid", "error"])
      )));
  for (const old of oldRows) {
    if (old.id === provisioned!.id) continue;
    if (old.webhookEndpointId && old.keyCiphertext) {
      try {
        await getStripeGateway().deleteWebhookEndpoint(
          decryptConnectionKey(old.keyCiphertext), old.webhookEndpointId);
      } catch (err) {
        // Observable, retryable, non-blocking for the new connection.
        await withOrgTx(ctx.db, ctx.org.id, async (tx) => {
          await tx.update(schema.stripeConnections).set({
            status: "error", webhookState: "cleanup_pending",
            validationError: "old_endpoint_cleanup_failed"
          }).where(eq(schema.stripeConnections.id, old.id));
          await audit(tx as unknown as Db, {
            orgId: ctx.org.id, actorId: ctx.userId, action: "connection.cleanup",
            targetType: "stripe_connection", targetId: old.id,
            diff: {
              rotated_from: old.id, endpoint: old.webhookEndpointId,
              webhook: `remove_failed:${isProviderError(err) ? err.code : "transient_network"}`,
              recoverable: true
            },
            ip: meta.ip, userAgent: meta.userAgent
          });
        }).catch(() => undefined);
        continue; // old row retained for retry; new connection untouched
      }
    }
    await withOrgTx(ctx.db, ctx.org.id, async (tx) => {
      await tx.delete(schema.stripeConnections).where(eq(schema.stripeConnections.id, old.id));
      await audit(tx as unknown as Db, {
        orgId: ctx.org.id, actorId: ctx.userId, action: "connection.cleanup",
        targetType: "stripe_connection", targetId: old.id,
        diff: {
          rotated_from: old.id,
          webhook: old.webhookEndpointId ? "removed" : "no_endpoint"
        },
        ip: meta.ip, userAgent: meta.userAgent
      });
    }).catch(() => undefined); // rotation-record failure leaves the old row
    // in place (invisible or 'error') — reconciliation reaps it later.
  }

  return stripeConnection(ctx);
}

export async function stripeDisconnect(
  ctx: OrgContext, meta: { ip?: string | null; userAgent?: string | null }
): Promise<StripeConnection> {
  // Read (no transaction spans provider I/O).
  const [current] = await withOrgTx(ctx.db, ctx.org.id, (tx) =>
    tx.select().from(schema.stripeConnections)
      .where(and(eq(schema.stripeConnections.orgId, ctx.org.id), eq(schema.stripeConnections.status, "active")))
      .orderBy(desc(schema.stripeConnections.createdAt)).limit(1));
  if (!current) return notConnected();

  // ---- PROVIDER step: delete our webhook endpoint (NO local transaction
  // open). Idempotent: an endpoint that is already gone is a success, so a
  // retried disconnect after a partial failure is always safe.
  if (current.webhookEndpointId && current.keyCiphertext) {
    try {
      await getStripeGateway().deleteWebhookEndpoint(
        decryptConnectionKey(current.keyCiphertext), current.webhookEndpointId);
    } catch (err) {
      // Provider deletion failed → the local connection MUST remain
      // recoverable: keep status active + sealed key + endpoint id, record
      // the recoverable state, and report the disconnect honestly as NOT
      // clean (never a fabricated success).
      await withOrgTx(ctx.db, ctx.org.id, async (tx) => {
        await tx.update(schema.stripeConnections)
          .set({ webhookState: "cleanup_pending" })
          .where(eq(schema.stripeConnections.id, current.id));
        await audit(tx as unknown as Db, {
          orgId: ctx.org.id, actorId: ctx.userId, action: "connection.cleanup",
          targetType: "stripe_connection", targetId: current.id,
          diff: {
            op: "disconnect", endpoint: current.webhookEndpointId,
            webhook: `remove_failed:${isProviderError(err) ? err.code : "transient_network"}`,
            recoverable: true
          },
          ip: meta.ip, userAgent: meta.userAgent
        });
      });
      throw new ProblemError(
        "internal",
        "Disconnect could not complete: the webhook endpoint could not be removed from Stripe. The connection remains active and recoverable — retry."
      );
    }
  }

  // ---- LOCAL step: revoke + DESTROY credential material (§5) + audit.
  try {
    await withOrgTx(ctx.db, ctx.org.id, async (tx) => {
      await tx.update(schema.stripeConnections)
        .set({ status: "revoked", keyCiphertext: null, webhookSecretEnc: null, webhookState: null })
        .where(eq(schema.stripeConnections.id, current.id));
      await audit(tx as unknown as Db, {
        orgId: ctx.org.id, actorId: ctx.userId, action: "connection.disconnected",
        targetType: "stripe_connection", targetId: current.id,
        diff: {
          account: current.stripeAccountId, last4: current.keyLast4, keyMaterial: "destroyed",
          webhook: current.webhookEndpointId ? "removed" : "no_endpoint"
        },
        ip: meta.ip, userAgent: meta.userAgent
      });
    });
  } catch {
    // Provider endpoint is gone but the local finalization failed → represent
    // that mismatch explicitly and best-effort durably.
    await withOrgTx(ctx.db, ctx.org.id, async (tx) => {
      await tx.update(schema.stripeConnections)
        .set({ webhookState: "provider_deleted_local_stale" })
        .where(eq(schema.stripeConnections.id, current.id));
      await audit(tx as unknown as Db, {
        orgId: ctx.org.id, actorId: ctx.userId, action: "connection.cleanup",
        targetType: "stripe_connection", targetId: current.id,
        diff: { op: "disconnect_finalize", outcome: "failed_recoverable", endpoint: current.webhookEndpointId },
        ip: meta.ip, userAgent: meta.userAgent
      });
    }).catch(() => undefined);
    throw new ProblemError(
      "internal",
      "The webhook endpoint was removed from Stripe, but the local disconnect could not be recorded. Retry to complete it — nothing was fabricated."
    );
  }

  return notConnected();
}

/** Worker-only: decrypts in memory, per job (§7.2). Never exposed via API. */
export function decryptConnectionKey(sealed: string): string {
  return openSecret(sealed, serverEnv().KEY_ENCRYPTION_KEY);
}

/* ---------------- Retry policy (versioned) ---------------- */

export async function getPolicy(ctx: OrgContext): Promise<RetryPolicy> {
  const rows = await withOrgTx(ctx.db, ctx.org.id, (tx) =>
    tx.select().from(schema.retryPolicies)
      .where(eq(schema.retryPolicies.orgId, ctx.org.id))
      .orderBy(desc(schema.retryPolicies.version)).limit(1));
  const rules = rows[0]?.rules as RetryPolicy | undefined;
  return rules ?? {
    maxAutoRetries: 3, quietHoursStart: 21, quietHoursEnd: 8,
    minGapHours: 48, noteAfterFailedRetries: 1, checkoutAfterNote: true
  };
}

export async function savePolicy(
  ctx: OrgContext, policy: RetryPolicy, meta: { ip?: string | null; userAgent?: string | null }
): Promise<RetryPolicy> {
  await withOrgTx(ctx.db, ctx.org.id, async (tx) => {
    const [latest] = await tx.select().from(schema.retryPolicies)
      .where(eq(schema.retryPolicies.orgId, ctx.org.id))
      .orderBy(desc(schema.retryPolicies.version)).limit(1);
    const [row] = await tx.insert(schema.retryPolicies).values({
      orgId: ctx.org.id, version: (latest?.version ?? 0) + 1, rules: policy, createdBy: ctx.userId
    }).returning();
    await audit(tx as unknown as Db, {
      orgId: ctx.org.id, actorId: ctx.userId, action: "policy.updated",
      targetType: "retry_policy", targetId: row!.id,
      diff: { version: [latest?.version ?? 0, row!.version], rules: policy },
      ip: meta.ip, userAgent: meta.userAgent
    });
  });
  return policy;
}

/* ---------------- Voice ---------------- */

export async function getVoice(ctx: OrgContext): Promise<VoiceProfile> {
  const [vp] = await withOrgTx(ctx.db, ctx.org.id, (tx) =>
    tx.select().from(schema.voiceProfiles).where(eq(schema.voiceProfiles.orgId, ctx.org.id)));
  return {
    sampleText: vp?.sampleText ?? "",
    styleSummary: vp?.styleSummary ?? "",
    greeting: vp?.greeting ?? "",
    signoff: vp?.signoff ?? ""
  };
}

export async function saveVoice(
  ctx: OrgContext, voice: VoiceProfile, meta: { ip?: string | null; userAgent?: string | null }
): Promise<VoiceProfile> {
  await withOrgTx(ctx.db, ctx.org.id, async (tx) => {
    const [existing] = await tx.select().from(schema.voiceProfiles).where(eq(schema.voiceProfiles.orgId, ctx.org.id));
    if (existing) {
      await tx.update(schema.voiceProfiles).set({
        sampleText: voice.sampleText, styleSummary: voice.styleSummary,
        greeting: voice.greeting, signoff: voice.signoff, updatedAt: new Date()
      }).where(eq(schema.voiceProfiles.orgId, ctx.org.id));
    } else {
      await tx.insert(schema.voiceProfiles).values({
        orgId: ctx.org.id, sampleText: voice.sampleText,
        styleSummary: voice.styleSummary || "Pending notes", greeting: voice.greeting, signoff: voice.signoff
      });
    }
    await audit(tx as unknown as Db, {
      orgId: ctx.org.id, actorId: ctx.userId, action: "voice.updated",
      targetType: "voice_profile", targetId: ctx.org.id,
      ip: meta.ip, userAgent: meta.userAgent
    });
  });
  return voice;
}

/* ---------------- Team ---------------- */

export async function team(ctx: OrgContext): Promise<TeamMember[]> {
  const rows = await withOrgTx(ctx.db, ctx.org.id, (tx) =>
    tx.select({ m: schema.memberships, u: schema.user })
      .from(schema.memberships)
      .innerJoin(schema.user, eq(schema.memberships.userId, schema.user.id))
      .where(eq(schema.memberships.orgId, ctx.org.id)));
  return rows.map((r) => ({
    id: r.m.id, name: r.u.name, email: r.u.email, role: r.m.role as ContractRole
  }));
}

/**
 * Invite = persistent invitation row (token hashed, 14d expiry). EMAIL IS NOT
 * SENT (Phase 4) — the response says so; the token is never returned to the
 * client (an admin cannot act as the delivery channel).
 */
export async function invite(
  ctx: OrgContext, input: { email: string; role: ContractRole }, meta: { ip?: string | null; userAgent?: string | null }
): Promise<{ invited: true; emailSent: false }> {
  const { createHash, randomBytes } = await import("node:crypto");
  const token = randomBytes(24).toString("base64url");
  const tokenHash = createHash("sha256").update(token).digest("hex");
  // Phase 7: seats are a plan LIMIT (§1.4) — consumed atomically inside the
  // org transaction under the per-org seat lock (no check-then-insert race).
  const reservation = await reserveSeat(ctx.db, ctx.org.id, async (tx) => {
    await tx.insert(schema.invitations).values({
      orgId: ctx.org.id, email: input.email, role: input.role,
      tokenHash, invitedBy: ctx.userId,
      expiresAt: new Date(Date.now() + 14 * 24 * 3600 * 1000)
    });
    await audit(tx as unknown as Db, {
      orgId: ctx.org.id, actorId: ctx.userId, action: "team.invited",
      targetType: "invitation", targetId: input.email,
      diff: { role: input.role }, // token hash never leaves the DB
      ip: meta.ip, userAgent: meta.userAgent
    });
  });
  if (!reservation.allowed) {
    await audit(ctx.db, {
      orgId: ctx.org.id, actorId: ctx.userId, action: "entitlement.limit_reached",
      targetType: "organization", targetId: ctx.org.id,
      diff: { limit: "seats", used: reservation.used, max: reservation.limit }, ip: meta.ip, userAgent: meta.userAgent
    });
    throw new ProblemError("entitlement-required", `Seat limit reached (${reservation.used}/${reservation.limit}). Upgrade your plan to invite more teammates.`);
  }
  return { invited: true, emailSent: false };
}

/* ---------------- Billing (own plan) ---------------- */

export async function billing(ctx: OrgContext): Promise<BillingInfo> {
  const [sub] = await withOrgTx(ctx.db, ctx.org.id, (tx) =>
    tx.select().from(schema.orgSubscriptions).where(eq(schema.orgSubscriptions.orgId, ctx.org.id)));
  // Phase 7: the resolver is the single interpretation of the durable row.
  const resolved = resolveEntitlements(sub ? { plan: sub.plan, status: sub.status } : { plan: null, status: null, missing: true });
  return {
    plan: resolved.plan,
    status: resolved.status,
    pilotEndsAt: ctx.org.pilotEndsAt?.toISOString() ?? null,
    guaranteeWindowEndsAt: sub?.guaranteeEndsAt?.toISOString() ?? null,
    billingProviderLive: sub?.planSource === "stripe_billing", // true only after a verified Stripe Billing webhook
    currentPeriodEnd: sub?.currentPeriodEnd?.toISOString() ?? null,
    cancelAtPeriodEnd: sub?.cancelAtPeriodEnd ?? false,
    effectivePlan: resolved.effectivePlan,
    restricted: resolved.restricted,
    reasons: resolved.reasons
  };
}
