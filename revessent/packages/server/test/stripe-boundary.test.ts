import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * PHASE 4A — INTEGRATION BOUNDARY (§7): browser code must not be able to
 * import the Stripe integration package or any secret-bearing server module.
 * Enforced by (a) `server-only` in the package entry and (b) a source grep
 * over the web app (the same discipline as the Phase 3 demo-safety greps).
 */
const WEB_SRC = join(__dirname, "../../../apps/web/src");
const INTEGRATIONS_SRC = join(__dirname, "../../../packages/integrations/src");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") || p.endsWith(".tsx") ? [p] : [];
  });
}

describe("stripe integration boundary", () => {
  it("packages/integrations entry imports 'server-only' — browser imports fail at build time", () => {
    const index = readFileSync(join(INTEGRATIONS_SRC, "index.ts"), "utf8");
    expect(index).toContain('import "server-only"');
  });

  it("the real stripe-client is not exported for direct import — only via the gateway interface", () => {
    const index = readFileSync(join(INTEGRATIONS_SRC, "index.ts"), "utf8");
    expect(index).not.toMatch(/export\s+.*from\s+".*stripe-client/);
    expect(index).toContain("getStripeGateway");
  });

  it("no web app module imports the integrations package or its fixtures", () => {
    const offenders = walk(WEB_SRC).filter((f) => {
      const src = readFileSync(f, "utf8");
      return /@revessent\/integrations|integrations\/fixtures|stripe-client/.test(src);
    });
    expect(offenders).toEqual([]);
  });

  it("no web app module imports the server crypto envelope (secret-bearing)", () => {
    const offenders = walk(WEB_SRC).filter((f) => {
      const src = readFileSync(f, "utf8");
      return /sealSecret|openSecret|KEY_ENCRYPTION_KEY/.test(src);
    });
    expect(offenders).toEqual([]);
  });
});
