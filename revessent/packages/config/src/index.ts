import { z } from "zod";

/**
 * Environment configuration (Architecture v1 §7.5: all env through Zod —
 * boot fails loudly on missing/weak values).
 *
 * Phase 3 rules (brief §10/§23):
 *  - Demo mode must be EXPLICITLY enabled and can never run in production.
 *  - Real mode requires DATABASE_URL + auth/encryption secrets; boot fails
 *    otherwise (fail closed).
 */
const PublicEnvSchema = z.object({
  NEXT_PUBLIC_DEMO_MODE: z.string().optional()
});

export const publicEnv = PublicEnvSchema.safeParse({
  NEXT_PUBLIC_DEMO_MODE: process.env.NEXT_PUBLIC_DEMO_MODE
}).success
  ? { NEXT_PUBLIC_DEMO_MODE: process.env.NEXT_PUBLIC_DEMO_MODE }
  : { NEXT_PUBLIC_DEMO_MODE: undefined };

export function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

export class ConfigError extends Error {}

/**
 * Demo mode = mock data + demo UI chrome. Explicit opt-in only; production
 * always refuses. (Default changed in Phase 3: Phase 2 defaulted ON because
 * no backend existed. See docs/phase3-gap-analysis.md row 13.)
 */
export function demoMode(): boolean {
  const requested = publicEnv.NEXT_PUBLIC_DEMO_MODE === "on" || publicEnv.NEXT_PUBLIC_DEMO_MODE === "1";
  if (requested && isProduction()) {
    throw new ConfigError(
      "DEMO_MODE requested while NODE_ENV=production — refused. A production deployment must never serve demo fixtures (brief §23)."
    );
  }
  return requested;
}

/** Server env for the real (non-demo) application. Throws when incomplete. */
export const ServerEnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  APP_DATABASE_URL: z.string().min(1).optional(),
  BETTER_AUTH_SECRET: z.string().min(32),
  /** 32-byte base64 master key for AES-256-GCM envelope encryption (§7.5). */
  KEY_ENCRYPTION_KEY: z.string().min(43),
  BETTER_AUTH_URL: z.string().optional(),
  /** argon2id params (doc §7.1: m=65536 KiB, t=3, p=4). Tests may lower them. */
  ARGON2_MEMORY_KIB: z.coerce.number().int().min(8).default(65536),
  ARGON2_TIME: z.coerce.number().int().min(1).default(3),
  ARGON2_PARALLELISM: z.coerce.number().int().min(1).default(4)
});

export type ServerEnv = z.infer<typeof ServerEnvSchema>;

let cachedServerEnv: ServerEnv | null = null;

export function serverEnv(): ServerEnv {
  if (cachedServerEnv) return cachedServerEnv;
  const parsed = ServerEnvSchema.safeParse({
    DATABASE_URL: process.env.DATABASE_URL,
    APP_DATABASE_URL: process.env.APP_DATABASE_URL,
    BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
    KEY_ENCRYPTION_KEY: process.env.KEY_ENCRYPTION_KEY,
    BETTER_AUTH_URL: process.env.BETTER_AUTH_URL,
    ARGON2_MEMORY_KIB: process.env.ARGON2_MEMORY_KIB,
    ARGON2_TIME: process.env.ARGON2_TIME,
    ARGON2_PARALLELISM: process.env.ARGON2_PARALLELISM
  });
  if (!parsed.success) {
    throw new ConfigError(
      `Server env incomplete for real mode: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}. ` +
      "Real mode (demo disabled) requires DATABASE_URL, BETTER_AUTH_SECRET (≥32 chars) and KEY_ENCRYPTION_KEY (32-byte base64)."
    );
  }
  cachedServerEnv = parsed.data;
  return cachedServerEnv;
}

/* ---------------- Phase 5: worker / queue environment ---------------- */

/**
 * Worker + queue configuration (Architecture v1 §10: Redis 7 + BullMQ;
 * §10.1: retries queue concurrency 5). Boot fails loudly when REDIS_URL is
 * missing — the worker never guesses connection targets. The URL is treated
 * as a credential: never logged, never echoed in errors (only field names).
 */
export const WorkerEnvSchema = ServerEnvSchema.extend({
  REDIS_URL: z.string().min(1),
  /** §10.1: the money queue runs concurrency 5. */
  WORKER_RETRIES_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(5),
  /** §10.1: the notes (communication) queue runs concurrency 5. */
  WORKER_NOTES_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(5),
  /** Scheduler poll interval (durable-state discovery sweep). */
  WORKER_POLL_MS: z.coerce.number().int().min(1_000).default(15_000),
  /** Job lease window; a lease outliving its worker is reclaimed as stale. */
  WORKER_LEASE_SECONDS: z.coerce.number().int().min(30).default(300),
  /** Max due candidates discovered per org per scheduler cycle (bounded work). */
  WORKER_SCAN_LIMIT: z.coerce.number().int().min(1).max(500).default(100),
  /** Orgs swept per cycle (bounded; the rest wait for the next cycle). */
  WORKER_ORG_LIMIT: z.coerce.number().int().min(1).max(500).default(200),
  /** Cool-off for re-delivering cases whose last delivery ended
   *  blocked/disabled/exhausted (queue-amplification control, §8 — the
   *  engine still re-decides on every real delivery). */
  WORKER_BLOCKED_COOLDOWN_HOURS: z.coerce.number().int().min(1).max(720).default(24),
  /** Owner/migrator connection: org-id enumeration + org-row context reads ONLY. */
  SCHEDULER_DATABASE_URL: z.string().min(1).optional(),
  /** Optional local health/readiness HTTP endpoint (worker-only). */
  WORKER_HEALTH_PORT: z.coerce.number().int().min(1).max(65535).optional()
});

export type WorkerEnv = z.infer<typeof WorkerEnvSchema>;

let cachedWorkerEnv: WorkerEnv | null = null;

export function workerEnv(): WorkerEnv {
  if (cachedWorkerEnv) return cachedWorkerEnv;
  const parsed = WorkerEnvSchema.safeParse({
    DATABASE_URL: process.env.DATABASE_URL,
    APP_DATABASE_URL: process.env.APP_DATABASE_URL,
    BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
    KEY_ENCRYPTION_KEY: process.env.KEY_ENCRYPTION_KEY,
    BETTER_AUTH_URL: process.env.BETTER_AUTH_URL,
    ARGON2_MEMORY_KIB: process.env.ARGON2_MEMORY_KIB,
    ARGON2_TIME: process.env.ARGON2_TIME,
    ARGON2_PARALLELISM: process.env.ARGON2_PARALLELISM,
    REDIS_URL: process.env.REDIS_URL,
    WORKER_RETRIES_CONCURRENCY: process.env.WORKER_RETRIES_CONCURRENCY,
    WORKER_NOTES_CONCURRENCY: process.env.WORKER_NOTES_CONCURRENCY,
    WORKER_POLL_MS: process.env.WORKER_POLL_MS,
    WORKER_LEASE_SECONDS: process.env.WORKER_LEASE_SECONDS,
    WORKER_SCAN_LIMIT: process.env.WORKER_SCAN_LIMIT,
    WORKER_ORG_LIMIT: process.env.WORKER_ORG_LIMIT,
    WORKER_BLOCKED_COOLDOWN_HOURS: process.env.WORKER_BLOCKED_COOLDOWN_HOURS,
    SCHEDULER_DATABASE_URL: process.env.SCHEDULER_DATABASE_URL,
    WORKER_HEALTH_PORT: process.env.WORKER_HEALTH_PORT
  });
  if (!parsed.success) {
    throw new ConfigError(
      `Worker env incomplete: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}. ` +
      "The worker requires the server env plus REDIS_URL. Connection strings are never logged."
    );
  }
  cachedWorkerEnv = parsed.data;
  return cachedWorkerEnv;
}

/* ---------------- Phase 6: communication (AI + email) environment ---------------- */

/**
 * Communication configuration. Everything is OPTIONAL and fail-safe:
 *   - no ANTHROPIC_API_KEY  ⇒ every email uses the deterministic template
 *   - no POSTMARK_SERVER_TOKEN ⇒ deliveries are recorded as not_configured
 *     (transient) and nothing is ever fabricated as "sent"
 * Secrets are credentials: never logged, never echoed in errors.
 */
export const CommunicationEnvSchema = z.object({
  ANTHROPIC_API_KEY: z.string().min(10).optional(),
  AI_MODEL: z.string().min(1).optional(),
  /** Hard wall-clock budget for one AI generation (the fallback covers overruns). */
  AI_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(60_000).default(12_000),
  POSTMARK_SERVER_TOKEN: z.string().min(10).optional(),
  POSTMARK_MESSAGE_STREAM: z.string().min(1).optional(),
  /** Application-controlled sender identity (never model- or customer-controlled). */
  EMAIL_FROM_ADDRESS: z.string().email().default("billing@notifications.revessent.test"),
  /** Public application origin used to build CTA links (https enforced outside tests). */
  APP_PUBLIC_URL: z.string().url().default("http://localhost:3000"),
  /** Max provider send attempts per communication before terminal failure. */
  EMAIL_MAX_SEND_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(4)
});

export type CommunicationEnv = z.infer<typeof CommunicationEnvSchema>;

let cachedCommunicationEnv: CommunicationEnv | null = null;

export function communicationEnv(): CommunicationEnv {
  if (cachedCommunicationEnv) return cachedCommunicationEnv;
  const parsed = CommunicationEnvSchema.safeParse({
    // Empty strings (a common .env footgun) mean "not configured".
    ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY || undefined,
    AI_MODEL: process.env.AI_MODEL || undefined,
    AI_TIMEOUT_MS: process.env.AI_TIMEOUT_MS,
    POSTMARK_SERVER_TOKEN: process.env.POSTMARK_SERVER_TOKEN || undefined,
    POSTMARK_MESSAGE_STREAM: process.env.POSTMARK_MESSAGE_STREAM || undefined,
    EMAIL_FROM_ADDRESS: process.env.EMAIL_FROM_ADDRESS,
    APP_PUBLIC_URL: process.env.APP_PUBLIC_URL ?? process.env.BETTER_AUTH_URL,
    EMAIL_MAX_SEND_ATTEMPTS: process.env.EMAIL_MAX_SEND_ATTEMPTS
  });
  if (!parsed.success) {
    throw new ConfigError(
      `Communication env invalid: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}. Secrets are never logged.`
    );
  }
  if (isProduction() && !parsed.data.APP_PUBLIC_URL.startsWith("https://")) {
    throw new ConfigError("APP_PUBLIC_URL must be https in production (customer-facing links).");
  }
  cachedCommunicationEnv = parsed.data;
  return cachedCommunicationEnv;
}

/** TEST-ONLY: drop the cached communication env. */
export function resetCommunicationEnvForTests(): void {
  cachedCommunicationEnv = null;
}

/* ---------------- Phase 7: Revessent's own billing (Stripe Billing) ---------------- */

/**
 * Platform billing webhook configuration. OPTIONAL and fail-safe: without a
 * signing secret the endpoint verifies nothing and applies nothing (safe 400).
 * The secret is a credential: never logged, never echoed.
 */
export const BillingEnvSchema = z.object({
  BILLING_WEBHOOK_SECRET: z.string().min(10).optional(),
  /** Which Stripe mode this deployment's platform endpoint accepts (default: test). */
  BILLING_LIVEMODE: z.enum(["true", "false"]).default("false").transform((v) => v === "true")
});

export type BillingEnv = z.infer<typeof BillingEnvSchema>;

let cachedBillingEnv: BillingEnv | null = null;

export function billingEnv(): BillingEnv {
  if (cachedBillingEnv) return cachedBillingEnv;
  const parsed = BillingEnvSchema.safeParse({
    BILLING_WEBHOOK_SECRET: process.env.BILLING_WEBHOOK_SECRET || undefined,
    BILLING_LIVEMODE: process.env.BILLING_LIVEMODE || undefined
  });
  if (!parsed.success) throw new ConfigError("Billing env invalid: BILLING_WEBHOOK_SECRET / BILLING_LIVEMODE. Secrets are never logged.");
  cachedBillingEnv = parsed.data;
  return cachedBillingEnv;
}

/** Tests only: re-read the billing environment. */
export function resetBillingEnvForTests(): void { cachedBillingEnv = null; }
