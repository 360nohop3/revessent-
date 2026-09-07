import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const pkg = (name: string) => path.resolve(__dirname, `packages/${name}/src/index.ts`);
const webAliases = {
  "@revessent/config": pkg("config"),
  "@revessent/contracts": pkg("contracts"),
  "@revessent/domain": pkg("domain"),
  "@revessent/observability": pkg("observability"),
  "@revessent/ui": pkg("ui"),
  "@": path.resolve(__dirname, "apps/web/src")
};
const serverAliases = {
  ...webAliases,
  "@revessent/db": pkg("db"),
  "@revessent/server": pkg("server"),
  "@revessent/integrations/fixtures": path.resolve(__dirname, "packages/integrations/src/fixtures.ts"),
  "@revessent/integrations/email-fixtures": path.resolve(__dirname, "packages/integrations/src/email-fixtures.ts"),
  "@revessent/ai/fakes": path.resolve(__dirname, "packages/ai/src/fakes.ts"),
  "@revessent/ai$": path.resolve(__dirname, "packages/ai/src/index.ts"),
  "@revessent/integrations$": path.resolve(__dirname, "packages/integrations/src/index.ts"),
  "@revessent/worker": path.resolve(__dirname, "apps/worker/src/index.ts"),
  "@worker": path.resolve(__dirname, "apps/worker/src")
};

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "server",
          environment: "node",
          include: ["packages/server/test/**/*.test.ts", "packages/db/test/**/*.test.ts", "packages/ai/test/**/*.test.ts", "packages/integrations/test/**/*.test.ts", "apps/worker/test/**/*.test.ts"],
          setupFiles: ["./vitest.server-setup.ts"],
          testTimeout: 30000,
          hookTimeout: 60000
        },
        resolve: {
          alias: {
            ...serverAliases,
            // vitest node runs server code; grant the react-server condition
            "server-only": path.resolve(__dirname, "node_modules/.pnpm/server-only@0.0.1/node_modules/server-only/empty.js")
          }
        }
      },
      {
        plugins: [react()],
        test: {
          name: "web",
          environment: "jsdom",
          setupFiles: ["./vitest.setup.ts"],
          // Phase 2 regression suite exercises the labeled mock client; the
          // Phase 3 default is real mode, so demo is pinned ON for these tests.
          env: { NEXT_PUBLIC_DEMO_MODE: "on" },
          include: ["packages/domain/test/**/*.test.ts", "packages/contracts/test/**/*.test.ts", "apps/web/test/**/*.test.{ts,tsx}"],
          css: false
        },
        resolve: { alias: webAliases }
      }
    ]
  }
});
