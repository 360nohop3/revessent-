/**
 * Phase 5 test infrastructure: a dedicated Redis instance (port 6399, spawned
 * per run), a fixture recovery case rig, and direct-processor harnesses.
 * Financial execution uses the fixture Stripe gateway — no live Stripe.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import Redis from "ioredis";
import { eq } from "drizzle-orm";
import { appDb, retryService, settingsService, syncService } from "@revessent/server";
import { createDb, withOrgTx, withoutOrg } from "@revessent/db";
import * as schema from "@revessent/db";
import { setStripeGatewayForTests, resetStripeGateway } from "@revessent/integrations";
import {
  fixtureGateway, fixtureAccount, fixtureCustomer, fixtureSubscription, fixtureInvoice, resetFixtureWorlds
} from "@revessent/integrations/fixtures";
import type { FixtureWorld } from "@revessent/integrations/fixtures";
import { createTestOrg, createTestUser, ctxFor, suffix } from "../../../packages/server/test/helpers";

export const TEST_REDIS_PORT = 6399;
export const TEST_REDIS_URL = `redis://127.0.0.1:${TEST_REDIS_PORT}`;
const DAY = 86_400_000, HOUR = 3_600_000;
export { DAY, HOUR };

let redisProc: ChildProcess | null = null;

/** Starts the dedicated test Redis once; idempotent and shared across the
 *  parallel vitest workers (the first binder wins, the rest see it up). The
 *  instance is killed when this process exits. */
export async function acquireTestRedis(): Promise<void> {
  if (redisProc) return;
  const proc = spawn("redis-server", ["--port", String(TEST_REDIS_PORT), "--save", "", "--appendonly", "no"], {
    stdio: "ignore"
  });
  proc.on("error", () => { /* another worker's instance already bound the port */ });
  redisProc = proc;
  process.once("exit", () => { try { proc.kill("SIGKILL"); } catch { /* already gone */ } });
  // probe with a FRESH client per attempt — one refused connection must not
  // poison the client (retryStrategy null ends it permanently)
  for (let i = 0; i < 100; i++) {
    const probe = new Redis(TEST_REDIS_URL, { maxRetriesPerRequest: 1, retryStrategy: () => null, lazyConnect: false });
    probe.on("error", () => { /* expected while redis binds */ });
    try {
      await probe.ping();
      await probe.quit().catch(() => probe.disconnect());
      return;
    } catch {
      await probe.disconnect();
      await sleep(100);
    }
  }
  throw new Error(`test redis did not come up on port ${TEST_REDIS_PORT}`);
}

/** Per-file cleanup is a no-op: the instance is shared across parallel test
 *  files and dies with the runner process. */
export async function releaseTestRedis(): Promise<void> {
  await Promise.resolve();
}

export async function flushTestRedis(): Promise<void> {
  const c = new Redis(TEST_REDIS_URL, { maxRetriesPerRequest: 1 });
  await c.flushall();
  await c.quit();
}

/* ---------------- fixture rig (mirrors the 4D harness) ---------------- */

export interface Rig {
  slug: string; orgId: string; owner: Awaited<ReturnType<typeof createTestUser>>;
  caseId: string; paymentId: string;
}

let rig: Rig;

export function rigRef(): Rig {
  return rig;
}

export function baseWorld(): FixtureWorld {
  return ({
    account: fixtureAccount(),
    customers: [fixtureCustomer(1)],
    subscriptions: [fixtureSubscription(1, "cus_fixture_001")],
    invoices: [fixtureInvoice(3, "cus_fixture_001", { status: "uncollectible" })]
  }) as unknown as FixtureWorld;
}

function rules(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    maxAutoRetries: 2, quietHoursStart: 21, quietHoursEnd: 8, minGapHours: 24,
    noteAfterFailedRetries: 1, checkoutAfterNote: true,
    autoRetry: {
      perCategory: {
        insufficient_funds: { retryable: true, maxAttempts: 4 },
        rate_limited: { retryable: true, maxAttempts: 4 },
        transient_network: { retryable: true, maxAttempts: 4 }
      },
      backoffMultiplier: 2, maxBackoffHours: 168
    },
    ...over
  };
}

/** Creates user + org + v1 policy + one failed-payment recovery case whose
 *  first backoff gap has elapsed (i.e. due work, from the scheduler's view). */
export async function seedRig(world: FixtureWorld = baseWorld()): Promise<Rig> {
  const owner = await createTestUser("p5-owner");
  const { slug, orgId } = await createTestOrg(owner, `p5${suffix()}`);
  rig = { slug, orgId, owner, caseId: "", paymentId: "" };
  setStripeGatewayForTests(fixtureGateway(world));
  const ctx = await ctxFor(rig.owner, rig.slug, "administer");
  await settingsService.stripeConnect(ctx, "rk_test_0123456789abcdefABCD", {});
  await syncService.triggerSync(ctx, {});
  const [payment] = await withOrgTx(appDb(), rig.orgId, (tx) =>
    tx.select().from(schema.payments).where(eq(schema.payments.status, "failed")).limit(1));
  if (!payment) throw new Error("fixture world did not produce a failed payment");
  const [recCase] = await withOrgTx(appDb(), rig.orgId, (tx) =>
    tx.insert(schema.recoveryCases).values({
      orgId: rig.orgId, customerId: payment.customerId,
      subscriptionId: null, paymentId: payment.id,
      status: "retrying", declineCode: "insufficient_funds", declineCategory: "insufficient_funds",
      amountCents: payment.amountCents, currency: payment.currency,
      firstFailedAt: new Date(Date.now() - 3 * DAY),
      nextActionAt: new Date(Date.now() - HOUR), // due now
      attemptNo: 0, retryPolicyVersion: 1
    }).returning());
  rig.caseId = recCase!.id;
  rig.paymentId = payment.id;
  await withOrgTx(appDb(), rig.orgId, (tx) =>
    tx.insert(schema.retryPolicies).values({ orgId: rig.orgId, version: 1, rules: rules() as never }));
  return rig;
}

/** Org count helper used by scheduler/enumeration tests. */
export async function countOrgs(): Promise<number> {
  const systemDb = createDb(process.env.SCHEDULER_DATABASE_URL!);
  const rows = await withoutOrg(systemDb, (tx) => tx.select().from(schema.organizations));
  return rows.length;
}

export async function attemptsRows(kind?: "auto_retry" | "manual_retry") {
  const rows = await withOrgTx(appDb(), rig.orgId, (tx) =>
    tx.select().from(schema.recoveryAttempts).where(eq(schema.recoveryAttempts.orgId, rig.orgId)));
  return kind ? rows.filter((r) => r.kind === kind) : rows;
}

export async function jobRow(jobRunId: string) {
  const rows = await withOrgTx(appDb(), rig.orgId, (tx) =>
    tx.select().from(schema.jobRuns).where(eq(schema.jobRuns.id, jobRunId)));
  return rows[0] ?? null;
}

export async function caseRowRig() {
  const [row] = await withOrgTx(appDb(), rig.orgId, (tx) =>
    tx.select().from(schema.recoveryCases).where(eq(schema.recoveryCases.id, rig.caseId)));
  return row!;
}

export async function paymentRowRig() {
  const [row] = await withOrgTx(appDb(), rig.orgId, (tx) =>
    tx.select().from(schema.payments).where(eq(schema.payments.id, rig.paymentId)));
  return row!;
}

export function afterEachCleanup(): void {
  resetStripeGateway();
  resetFixtureWorlds();
}

/** Direct-processor harness: builds the deps the real worker would build. */
export async function processorDeps(overrides: Partial<{ leaseMs: number }> = {}) {
  const mod = await import("@revessent/worker");
  const db = createDb(process.env.APP_DATABASE_URL!); // fresh instance; same app role
  const systemDb = createDb(process.env.SCHEDULER_DATABASE_URL!);
  return {
    deps: {
      db,
      systemDb,
      leaseMs: overrides.leaseMs ?? 300_000,
      concurrency: 1,
      redisUrl: TEST_REDIS_URL
    },
    processor: mod.retryExecuteProcessor({
      db,
      systemDb,
      leaseMs: overrides.leaseMs ?? 300_000,
      concurrency: 1,
      redisUrl: TEST_REDIS_URL
    }),
    mod
  };
}

/** Fake BullMQ Job — the processor only reads `data` and `attemptsMade`. */
export function fakeJob(data: unknown, attemptsMade = 0) {
  return { data, attemptsMade } as never;
}

export { retryService, appDb, withOrgTx, withoutOrg, schema, createDb, createTestOrg, createTestUser, ctxFor, suffix };
