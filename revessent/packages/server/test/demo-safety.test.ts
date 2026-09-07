import { describe, expect, it, vi } from "vitest";

/**
 * §23 DEMO MODE SAFETY — a production deployment must never serve fixtures.
 * The default is SAFE (demo off); enabling demo in production throws.
 * Assertions run INSIDE the staged environment (config reads live process.env).
 */
describe("demo-mode boundary", () => {
  const KEYS = ["NODE_ENV", "NEXT_PUBLIC_DEMO_MODE", "DATABASE_URL", "BETTER_AUTH_SECRET", "KEY_ENCRYPTION_KEY", "BETTER_AUTH_URL"] as const;

  async function withEnv(
    env: Partial<Record<(typeof KEYS)[number], string>>,
    run: (config: typeof import("@revessent/config")) => void | Promise<void>
  ): Promise<void> {
    const saved: Record<string, string | undefined> = {};
    for (const key of KEYS) {
      saved[key] = process.env[key];
      if (env[key] === undefined) delete process.env[key];
      else process.env[key] = env[key];
    }
    vi.resetModules();
    try {
      const config = await import("@revessent/config");
      await run(config);
    } finally {
      for (const key of KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
      vi.resetModules();
    }
  }

  it("default configuration is safe: no flag ⇒ demo off", async () => {
    await withEnv({ NODE_ENV: "production" }, (config) => {
      expect(config.demoMode()).toBe(false);
    });
  });

  it("production + explicit demo flag is REFUSED (throws)", async () => {
    await withEnv({ NODE_ENV: "production", NEXT_PUBLIC_DEMO_MODE: "on" }, (config) => {
      expect(() => config.demoMode()).toThrow(/production/i);
    });
  });

  it("production + demo flag = 1 is also refused", async () => {
    await withEnv({ NODE_ENV: "production", NEXT_PUBLIC_DEMO_MODE: "1" }, (config) => {
      expect(() => config.demoMode()).toThrow(/production/i);
    });
  });

  it("development + explicit flag ⇒ demo on", async () => {
    await withEnv({ NODE_ENV: "development", NEXT_PUBLIC_DEMO_MODE: "on" }, (config) => {
      expect(config.demoMode()).toBe(true);
    });
  });

  it("test env + flag ⇒ demo on (test is not production)", async () => {
    await withEnv({ NODE_ENV: "test", NEXT_PUBLIC_DEMO_MODE: "on" }, (config) => {
      expect(config.demoMode()).toBe(true);
    });
  });

  it("real mode without server env fails loudly at boot (never silently)", async () => {
    await withEnv({ NODE_ENV: "production" }, (config) => {
      expect(() => config.serverEnv()).toThrow(/Server env incomplete/);
    });
  });

  it("server env accepts a complete configuration", async () => {
    await withEnv({
      NODE_ENV: "production",
      DATABASE_URL: "postgres://x@localhost:5433/x",
      BETTER_AUTH_SECRET: "0123456789abcdef0123456789abcdef",
      KEY_ENCRYPTION_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
      BETTER_AUTH_URL: "https://app.revessent.example" // Phase 8: https origin is mandatory in production
    }, (config) => {
      expect(config.serverEnv().DATABASE_URL).toContain("postgres://");
    });
  });
});
