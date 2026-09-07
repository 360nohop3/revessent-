/**
 * PHASE 8 — production configuration fails CLOSED (brief §3/§20).
 * Pure env-schema tests; no network, no database.
 */
import { afterEach, describe, expect, it } from "vitest";
import { serverEnv, resetServerEnvForTests, ConfigError, demoMode, communicationEnv, resetCommunicationEnvForTests } from "@revessent/config";

const saved = { ...process.env };
function setEnv(patch: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(patch)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
}

describe("Phase 8 — production configuration gates", () => {
  afterEach(() => { process.env = { ...saved }; resetServerEnvForTests(); resetCommunicationEnvForTests(); });

  it("production refuses a non-https BETTER_AUTH_URL (auth base + webhook endpoint origin)", () => {
    setEnv({ NODE_ENV: "production", BETTER_AUTH_URL: "http://localhost:3000" }); resetServerEnvForTests();
    expect(() => serverEnv()).toThrow(ConfigError);
    setEnv({ BETTER_AUTH_URL: undefined }); resetServerEnvForTests();
    expect(() => serverEnv()).toThrow(ConfigError);
    setEnv({ BETTER_AUTH_URL: "https://app.revessent.example" }); resetServerEnvForTests();
    expect(() => serverEnv()).not.toThrow();
  });

  it("production refuses demo mode from both entry points", () => {
    setEnv({ NODE_ENV: "production", BETTER_AUTH_URL: "https://app.revessent.example", NEXT_PUBLIC_DEMO_MODE: "on" }); resetServerEnvForTests();
    expect(() => serverEnv()).toThrow(/DEMO_MODE/);
  });

  it("production refuses a non-https APP_PUBLIC_URL (customer-facing + account links)", () => {
    setEnv({ NODE_ENV: "production", APP_PUBLIC_URL: "http://app.example", BETTER_AUTH_URL: "https://app.revessent.example" }); resetCommunicationEnvForTests();
    expect(() => communicationEnv()).toThrow(ConfigError);
  });

  it("missing core secrets fail loudly and the message names fields only (never values)", () => {
    setEnv({ NODE_ENV: "test", BETTER_AUTH_SECRET: "short", KEY_ENCRYPTION_KEY: undefined }); resetServerEnvForTests();
    let message = "";
    try { serverEnv(); } catch (e) { message = (e as Error).message; }
    expect(message).toMatch(/BETTER_AUTH_SECRET/);
    expect(message).toMatch(/KEY_ENCRYPTION_KEY/);
    expect(message).not.toContain("short");
    expect(message).not.toContain(saved.DATABASE_URL ?? "@@none@@");
  });

  it("demoMode() is false unless explicitly on", () => {
    expect(demoMode()).toBe(false);
  });
});
