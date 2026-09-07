/**
 * Server test env — set BEFORE any @revessent/* import (packages/config
 * reads env at first call). Points at the local PostgreSQL 16 (port 5433)
 * with fast argon2id params; production enforces the spec params.
 */
process.env.NODE_ENV = "test";
process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://revessent_app:app_local_dev@127.0.0.1:5433/revessent";
process.env.APP_DATABASE_URL = process.env.APP_DATABASE_URL ?? process.env.DATABASE_URL;
process.env.MIGRATE_DATABASE_URL = process.env.MIGRATE_DATABASE_URL ?? "postgres://postgres@127.0.0.1:5433/revessent";
process.env.BETTER_AUTH_SECRET = process.env.BETTER_AUTH_SECRET ?? "test-secret-0123456789abcdefghij0123456789";
process.env.KEY_ENCRYPTION_KEY = process.env.KEY_ENCRYPTION_KEY ?? "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=";
process.env.BETTER_AUTH_URL = "http://localhost:3000";
// fast-but-valid argon2id for tests (production keeps 65536/3/4 via defaults)
process.env.ARGON2_MEMORY_KIB = process.env.ARGON2_MEMORY_KIB ?? "8192";
process.env.ARGON2_TIME = process.env.ARGON2_TIME ?? "1";
process.env.ARGON2_PARALLELISM = process.env.ARGON2_PARALLELISM ?? "1";

// Phase 5 worker/queue env for tests: dedicated Redis instance/port and the
// owner connection the worker's narrow privileged reads use (org-id
// enumeration + org-row context; everything tenant-scoped stays on app role).
process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://127.0.0.1:6399";
process.env.SCHEDULER_DATABASE_URL = process.env.SCHEDULER_DATABASE_URL ?? "postgres://postgres@127.0.0.1:5433/revessent";
