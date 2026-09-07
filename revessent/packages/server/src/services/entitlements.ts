/**
 * PHASE 7 — ENTITLEMENTS: the ONE authoritative decision layer.
 *
 *   authoritative billing state (org_subscriptions, synchronised from Stripe
 *   Billing webhooks — services/billing.ts)  ──▶  pure resolver
 *   (@revessent/domain resolveEntitlements)  ──▶  capabilities + limits
 *   + usage counters (live DB counts, org-scoped)
 *
 * Rules:
 *   - nothing else branches on a plan name; callers ask `can()` / `getEntitlements()`
 *   - no cache: every decision re-reads the durable row under RLS
 *   - denial is a plain, audited refusal of NEW work — never a financial
 *     transition and never a weakening of Phase 4C/4D/6 safety
 *   - AI never participates
 */
import { and, count, eq, gt, isNull, sql } from "drizzle-orm";
import * as schema from "@revessent/db";
import { withOrgTx, type Db } from "@revessent/db";
import {
  resolveEntitlements, CAPABILITIES,
  type Capability, type ResolvedEntitlements
} from "@revessent/domain";
import type { OrgContext } from "../context.js";
import { can as roleCan } from "../authz/rbac.js";
import { ProblemError } from "../http/problems.js";
import { audit } from "./audit.js";

export type { Capability };

export interface EntitlementUsage {
  /** memberships + pending (unaccepted, unexpired) invitations. */
  seatsUsed: number;
  /** non-deleted customers mirrored from the tenant's Stripe. */
  members: number;
}

export interface Entitlements extends ResolvedEntitlements {
  usage: EntitlementUsage;
  /** Reported only in Phase 7 (see report §6): the tenant's Stripe mirror is
   *  never blocked, because it is the financial truth for recovery. */
  overMemberCap: boolean;
  seatsRemaining: number;
}

/** Loads the durable billing row (org-scoped; RLS binds) — the only source. */
export async function billingRow(db: Db, orgId: string) {
  const [row] = await withOrgTx(db, orgId, (tx) =>
    tx.select().from(schema.orgSubscriptions).where(eq(schema.orgSubscriptions.orgId, orgId)));
  return row ?? null;
}

export async function usageFor(db: Db, orgId: string, now = new Date()): Promise<EntitlementUsage> {
  return withOrgTx(db, orgId, (tx) => usageInTx(tx, orgId, now));
}

async function usageInTx(tx: Db, orgId: string, now: Date): Promise<EntitlementUsage> {
  const [m] = await tx.select({ n: count() }).from(schema.memberships).where(eq(schema.memberships.orgId, orgId));
  const [i] = await tx.select({ n: count() }).from(schema.invitations).where(and(
    eq(schema.invitations.orgId, orgId), isNull(schema.invitations.acceptedAt), gt(schema.invitations.expiresAt, now)));
  const [c] = await tx.select({ n: count() }).from(schema.customers).where(and(
    eq(schema.customers.orgId, orgId), isNull(schema.customers.deletedAt)));
  return { seatsUsed: Number(m?.n ?? 0) + Number(i?.n ?? 0), members: Number(c?.n ?? 0) };
}

/** Full picture for an org: resolved plan/capabilities/limits + live usage. */
export async function getEntitlements(db: Db, orgId: string, now = new Date()): Promise<Entitlements> {
  const row = await billingRow(db, orgId);
  const resolved = resolveEntitlements(row ? { plan: row.plan, status: row.status } : { plan: null, status: null, missing: true });
  const usage = await usageFor(db, orgId, now);
  return {
    ...resolved, usage,
    overMemberCap: resolved.limits.memberCap !== null && usage.members > resolved.limits.memberCap,
    seatsRemaining: Math.max(0, resolved.limits.seats - usage.seatsUsed)
  };
}

export interface CapabilityDecision {
  allowed: boolean;
  capability: Capability;
  /** Stable reason code when denied (e.g. `capability_not_in_plan:ember`, `subscription_past_due`). */
  reason: string | null;
  entitlements: ResolvedEntitlements;
}

/** Non-throwing decision (workers/services). Re-reads the durable row every time. */
export async function can(db: Db, orgId: string, capability: Capability): Promise<CapabilityDecision> {
  const row = await billingRow(db, orgId);
  const entitlements = resolveEntitlements(row ? { plan: row.plan, status: row.status } : { plan: null, status: null, missing: true });
  if (entitlements.capabilities[capability]) return { allowed: true, capability, reason: null, entitlements };
  const reason = entitlements.restricted
    ? `subscription_${entitlements.status}`
    : `capability_not_in_plan:${entitlements.effectivePlan}`;
  return { allowed: false, capability, reason, entitlements };
}

/**
 * Throwing form for request handlers: 402 /errors/entitlement-required with a
 * safe detail, plus an audit row `entitlement.capability_denied` (no secrets).
 */
export async function requireCapability(
  ctx: OrgContext, capability: Capability, meta: { ip?: string | null; userAgent?: string | null; target?: { type: string; id: string } } = {}
): Promise<CapabilityDecision> {
  const decision = await can(ctx.db, ctx.org.id, capability);
  if (decision.allowed) return decision;
  await audit(ctx.db, {
    orgId: ctx.org.id, actorId: ctx.userId, action: "entitlement.capability_denied",
    targetType: meta.target?.type ?? "organization", targetId: meta.target?.id ?? ctx.org.id,
    diff: { capability, reason: decision.reason, plan: decision.entitlements.plan, effectivePlan: decision.entitlements.effectivePlan },
    ip: meta.ip, userAgent: meta.userAgent
  });
  throw new ProblemError("entitlement-required", detailFor(decision));
}

function detailFor(d: CapabilityDecision): string {
  const label = d.capability.replace(/_/g, " ");
  if (d.entitlements.restricted) return `Your ${d.entitlements.plan} subscription is ${d.entitlements.status.replace(/_/g, " ")}; ${label} is paused until billing is resolved.`;
  return `${label[0]!.toUpperCase()}${label.slice(1)} is not included in the ${d.entitlements.effectivePlan} plan.`;
}

/* ---------------------------------------------------------------- limits */

export type SeatReservation<T> =
  | { allowed: true; value: T; used: number; limit: number }
  | { allowed: false; used: number; limit: number; reason: "seat_limit_reached" };

/**
 * ATOMIC seat consumption. Inside ONE org-scoped transaction: take the
 * per-org transaction advisory lock, count seats (memberships + pending
 * invitations) with a fresh snapshot, then either run `consume` (the insert)
 * or refuse. Two concurrent callers serialize on the lock; the loser's count
 * sees the winner's committed row — the final unit can never be consumed
 * twice. Nothing is cached; the limit is re-resolved from the durable row.
 */
export async function reserveSeat<T>(
  db: Db, orgId: string, consume: (tx: Db) => Promise<T>, now = new Date()
): Promise<SeatReservation<T>> {
  return withOrgTx(db, orgId, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(('x' || substr(md5('revessent:seats:' || ${orgId}), 1, 16))::bit(64)::bigint)`);
    const [row] = await tx.select().from(schema.orgSubscriptions).where(eq(schema.orgSubscriptions.orgId, orgId));
    const resolved = resolveEntitlements(row ? { plan: row.plan, status: row.status } : { plan: null, status: null, missing: true });
    const limit = resolved.limits.seats;
    const usage = await usageInTx(tx, orgId, now);
    if (usage.seatsUsed >= limit) return { allowed: false, used: usage.seatsUsed, limit, reason: "seat_limit_reached" };
    const value = await consume(tx);
    return { allowed: true, value, used: usage.seatsUsed + 1, limit };
  });
}

/* ---------------------------------------------------------------- DTO */

export interface EntitlementsDTO {
  plan: ResolvedEntitlements["plan"];
  effectivePlan: ResolvedEntitlements["effectivePlan"];
  state: ResolvedEntitlements["state"];
  restricted: boolean;
  capabilities: Record<Capability, boolean>;
  limits: { memberCap: number | null; seats: number };
  usage: { seatsUsed: number; members: number };
  overMemberCap: boolean;
  /** Billing detail is owner/admin-only (§7.3); members see the gating outcome only. */
  billing: { status: ResolvedEntitlements["status"]; reasons: string[] } | null;
}

/** GET /orgs/{slug}/entitlements — any member may read what the workspace can do. */
export async function describe(ctx: OrgContext): Promise<EntitlementsDTO> {
  const e = await getEntitlements(ctx.db, ctx.org.id);
  return {
    plan: e.plan, effectivePlan: e.effectivePlan, state: e.state, restricted: e.restricted,
    capabilities: Object.fromEntries(CAPABILITIES.map((c) => [c, e.capabilities[c]])) as Record<Capability, boolean>,
    limits: e.limits, usage: e.usage, overMemberCap: e.overMemberCap,
    billing: roleCan(ctx.role, "administer") ? { status: e.status, reasons: e.reasons } : null
  };
}
