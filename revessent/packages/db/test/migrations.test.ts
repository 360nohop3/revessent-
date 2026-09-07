import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import path from "node:path";

/**
 * §21 MIGRATIONS: empty database → migrations → application primitives work.
 * Runs against a throwaway database on the local PostgreSQL 16.
 */
describe("migrations are deterministic", () => {
  it("bootstraps an empty database from scratch", async () => {
    const admin = new pg.Client({ host: "127.0.0.1", port: 5433, user: "postgres", database: "postgres" });
    await admin.connect();
    const dbName = `rvs_mig_test_${randomBytes(4).toString("hex")}`;
    await admin.query(`create database ${dbName}`);
    // A managed pool we can close BEFORE terminating backends — otherwise the
    // killed socket surfaces as an unhandled pg 'error' event after the test.
    const pool = new pg.Pool({ connectionString: `postgres://postgres@127.0.0.1:5433/${dbName}` });
    const db = drizzle(pool);
    try {
      await migrate(db, { migrationsFolder: path.resolve(__dirname, "../../db/drizzle") });

      // core tables exist after a clean run
      const check = new pg.Client({ host: "127.0.0.1", port: 5433, user: "revessent_app", password: "app_local_dev", database: dbName });
      await check.connect();
      const tables = await check.query(
        "select table_name from information_schema.tables where table_schema='public'"
      );
      const names = tables.rows.map((r) => r.table_name as string);
      for (const expected of [
        "organizations", "memberships", "customers", "payments", "recovery_cases",
        "recovery_messages", "recovery_checkouts", "expansion_opportunities",
        "retry_policies", "voice_profiles", "audit_logs", "org_subscriptions", "user", "session"
      ]) {
        expect(names, expected).toContain(expected);
      }

      // RLS is enabled on tenant tables
      const rls = await check.query(
        "select relname, relrowsecurity from pg_class where relname in ('customers','recovery_cases','audit_logs')"
      );
      expect(rls.rows.every((r) => r.relrowsecurity === true)).toBe(true);

      // Phase 6 (0021): communication columns + deterministic identity + grants
      const cols = await check.query(
        "select column_name from information_schema.columns where table_name='recovery_messages' and column_name in ('dedupe_key','send_status','fact_snapshot','recipient_email','purpose','send_after','generation_source')"
      );
      expect(cols.rows.map((r) => r.column_name as string).sort()).toEqual(
        ["dedupe_key", "fact_snapshot", "generation_source", "purpose", "recipient_email", "send_after", "send_status"]
      );
      const idx = await check.query("select indexname, indexdef from pg_indexes where tablename='recovery_messages' and indexname='recovery_messages_dedupe_uq'");
      expect(idx.rows).toHaveLength(1);
      expect(String(idx.rows[0].indexdef)).toMatch(/UNIQUE/);
      const grants = await check.query(
        "select privilege_type from information_schema.role_table_grants where grantee='revessent_app' and table_name in ('recovery_messages','ai_generations')"
      );
      expect(grants.rows.map((r) => r.privilege_type as string)).toEqual(expect.arrayContaining(["SELECT", "INSERT", "UPDATE"]));
      await check.query("select set_config('app.org_id', gen_random_uuid()::text, true)");
      expect(await check.query("select 1 from recovery_messages where send_status='pending' limit 1")).toBeTruthy(); // RLS-scoped read works

      // Phase 6 safety fix (0022): communication_suppressions — RLS on, unique per org+customer+channel,
      // app role may select/insert but NOT update/delete (append-only opt-out)
      expect(names).toContain("communication_suppressions");
      const supRls = await check.query("select relrowsecurity from pg_class where relname='communication_suppressions'");
      expect(supRls.rows[0].relrowsecurity).toBe(true);
      const supGrants = await check.query(
        "select privilege_type from information_schema.role_table_grants where grantee='revessent_app' and table_name='communication_suppressions'"
      );
      expect(supGrants.rows.map((r) => r.privilege_type as string).sort()).toEqual(["INSERT", "SELECT"]);
      const supUq = await check.query("select 1 from pg_indexes where tablename='communication_suppressions' and indexname='communication_suppressions_org_customer_channel_uq'");
      expect(supUq.rows).toHaveLength(1);

      // Phase 8 (0024): shared auth rate-limit counters — hashed key PK, app-role DML
      const rl = await check.query("select column_name from information_schema.columns where table_name='auth_rate_limits' order by 1");
      expect(rl.rows.map((r) => r.column_name)).toEqual(["hits", "key_hash", "window_start"]);
      const rlGrant = await check.query("select privilege_type from information_schema.table_privileges where grantee='revessent_app' and table_name='auth_rate_limits' order by 1");
      expect(rlGrant.rows.map((r) => r.privilege_type)).toEqual(["DELETE", "INSERT", "SELECT", "UPDATE"]);

      // Phase 7 (0023): billing state columns, lookup indexes, SECURITY DEFINER
      // resolvers granted to the app role, organizations UPDATE limited to (plan, updated_at)
      const billCols = await check.query(
        "select column_name from information_schema.columns where table_name='org_subscriptions' and column_name in ('current_period_end','cancel_at_period_end','provider_updated_at','last_event_id','plan_source','created_at')"
      );
      expect(billCols.rows.map((r) => r.column_name as string).sort()).toEqual(
        ["cancel_at_period_end", "created_at", "current_period_end", "last_event_id", "plan_source", "provider_updated_at"]
      );
      const billIdx = await check.query("select indexname from pg_indexes where tablename='org_subscriptions' and indexname in ('org_subscriptions_stripe_customer_idx','org_subscriptions_stripe_subscription_idx')");
      expect(billIdx.rows).toHaveLength(2);
      const fns = await check.query(
        "select p.proname, p.prosecdef, has_function_privilege('revessent_app', p.oid, 'execute') as ok from pg_proc p where p.proname in ('resolve_billing_org','resolve_billing_org_unlinked')"
      );
      expect(fns.rows).toHaveLength(2);
      expect(fns.rows.every((r) => r.prosecdef === true && r.ok === true)).toBe(true);
      const orgColGrants = await check.query(
        "select column_name from information_schema.role_column_grants where grantee='revessent_app' and table_name='organizations' and privilege_type='UPDATE'"
      );
      expect(orgColGrants.rows.map((r) => r.column_name as string).sort()).toEqual(["plan", "updated_at"]);
      const orgTableUpdate = await check.query(
        "select 1 from information_schema.role_table_grants where grantee='revessent_app' and table_name='organizations' and privilege_type='UPDATE'"
      );
      expect(orgTableUpdate.rows).toHaveLength(0);
      const pol = await check.query("select policyname from pg_policies where tablename='organizations' and policyname='org_self_update'");
      expect(pol.rows).toHaveLength(1);

      // app role cannot mutate audit logs (WORM)
      await check.query("select set_config('app.org_id', gen_random_uuid()::text, true)");
      await expect(check.query("update audit_logs set action='tampered'")).rejects.toThrow();
      await check.end();
      await pool.end(); // no open sessions when the database is dropped
    } finally {
      await admin.query(`select pg_terminate_backend(pid) from pg_stat_activity where datname = '${dbName}' and pid <> pg_backend_pid()`);
      await admin.query(`drop database if exists ${dbName}`);
      await admin.end();
    }
  }, 60000);
});
