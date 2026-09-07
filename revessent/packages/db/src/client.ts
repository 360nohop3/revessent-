/**
 * Database client + tenancy primitives (§7.4).
 *
 * Two roles, two URLs:
 *  - DATABASE_URL (migrator/owner, e.g. revessent_owner via postgres) — migrations + seed only.
 *  - APP_DATABASE_URL (revessent_app, non-owner) — the application runtime. RLS binds this role.
 *
 * Every tenant query runs inside `withOrgTx(db, orgId, ...)` which sets
 * `local app.org_id` so both query-layer scoping AND Postgres RLS apply.
 */
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema>;

export function createDb(url: string): Db {
  return drizzle(url, { schema, casing: "snake_case" });
}

/** Runs fn in a transaction scoped to one org: RLS + query layer agree. */
export async function withOrgTx<T>(db: Db, orgId: string, fn: (tx: Db) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.org_id', ${orgId}, true)`);
    return fn(tx as unknown as Db);
  });
}

/** Identity scope only (authorization lookups that must precede org scoping). */
export async function withIdentityTx<T>(db: Db, userId: string, fn: (tx: Db) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${userId}, true)`);
    return fn(tx as unknown as Db);
  });
}

/** Clears the org scope (used by org-agnostic reads like /me, auth). */
export async function withoutOrg<T>(db: Db, fn: (tx: Db) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.org_id', '', true)`);
    return fn(tx as unknown as Db);
  });
}

/* ---------------- Sync single-flight (Phase 4A final audit) ---------------- */

interface LockClient {
  query(q: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  release(): void;
}

export type SyncLockOutcome<T> = { acquired: true; value: T } | { acquired: false };

/**
 * Database-enforced single-flight for the per-org Stripe sync (Phase 4A
 * final-audit correction). The previous check-then-act on
 * `sync_state.status = "running"` was a race: two concurrent requests could
 * both observe "no running sync" and both proceed.
 *
 * Mechanism: a PostgreSQL SESSION advisory lock taken on a DEDICATED pool
 * client, keyed deterministically by organization id (md5 → 64-bit). The
 * guarantees are database-side, so they hold across Node processes, server
 * instances and concurrent HTTP requests:
 *  - `pg_try_advisory_lock` is atomic: exactly one session per org wins; the
 *    loser returns `acquired: false` WITHOUT starting any provider work.
 *  - The lock is scoped to the borrowed connection: released in `finally`
 *    here, and AUTOMATICALLY by PostgreSQL if the process dies mid-sync
 *    (a crashed run can never wedge an organization permanently).
 *  - The dedicated client stays idle (no transaction) while `fn` runs, so
 *    network calls remain outside DB transactions; page transactions use the
 *    regular pool as before. Per-org key ⇒ different orgs never block each
 *    other.
 */
/**
 * Generic database-side single-flight (Phase 4B generalization of the
 * Phase 4A sync lock): a PostgreSQL SESSION advisory lock on a dedicated
 * pool client, keyed by `lockNamespace` + `lockKey`. Atomic acquisition;
 * explicit release in `finally`; crash-safe (session locks die with the
 * connection). Per-key namespace ⇒ independent locks never collide.
 */
export async function withPgAdvisoryLock<T>(
  db: Db, lockNamespace: string, lockKey: string, fn: () => Promise<T>,
  opts?: { waitMs?: number }
): Promise<SyncLockOutcome<T>> {
  const pool = (db as unknown as { $client?: { connect?: () => Promise<LockClient> } }).$client;
  if (!pool || typeof pool.connect !== "function") {
    throw new Error("withPgAdvisoryLock requires a node-postgres-backed Db");
  }
  const client = await pool.connect();
  try {
    // Deterministic 64-bit lock key (md5 of namespaced key → bit64).
    const keyRes = await client.query(
      "select ('x' || substr(md5($1 || ':' || $2), 1, 16))::bit(64)::bigint as key",
      [lockNamespace, lockKey]);
    const key = String(keyRes.rows[0]!.key);
    const got = await client.query("select pg_try_advisory_lock($1::bigint) as ok", [key]);
    let acquired = got.rows[0]!.ok === true;
    if (!acquired && opts?.waitMs) {
      // DETERMINISTIC wait: block on the lock (bounded) instead of polling —
      // when this returns, the winner has RELEASED it, so re-running `fn`
      // observes the winner's committed terminal state. Lock-session timeouts
      // degrade to the not-acquired outcome (never a hang).
      // Utility statements cannot take bind parameters — inline the integer
      // (floored, ≥1 ms; never user-supplied raw text).
      // Bounded blocking wait: pg_advisory_lock returns VOID — a completed
      // query IS the acquisition. (The previous code read a nonexistent `.ok`
      // column and therefore NEVER reported a waited acquisition; session-
      // level timeout because SET LOCAL is a no-op outside a transaction.)
      const waitMsInt = Math.max(1, Math.floor(opts.waitMs));
      await client.query(`set statement_timeout = ${waitMsInt}`);
      try {
        await client.query("select pg_advisory_lock($1::bigint)", [key]);
        acquired = true;
      } catch {
        acquired = false; // statement_timeout exceeded
      } finally {
        await client.query("set statement_timeout = 0").catch(() => undefined);
      }
    }
    if (!acquired) return { acquired: false };
    try {
      return { acquired: true, value: await fn() };
    } finally {
      // Explicit unlock; even if this throws, the session ends below and
      // PostgreSQL releases the lock with the connection.
      try { await client.query("select pg_advisory_unlock($1::bigint)", [key]); } catch { /* released by connection close */ }
    }
  } finally {
    client.release();
  }
}

/** Phase 4A per-organization sync single-flight (see final-audit report). */
export async function withOrgSyncLock<T>(db: Db, orgId: string, fn: () => Promise<T>): Promise<SyncLockOutcome<T>> {
  return withPgAdvisoryLock(db, "revessent:sync-lock", orgId, fn);
}

export { schema };
export * from "./schema";
