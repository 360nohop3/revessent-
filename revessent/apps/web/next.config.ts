import type { NextConfig } from "next";

const config: NextConfig = {
  // Workspace packages ship TypeScript source; Next transpiles them.
  transpilePackages: [
    "@revessent/config",
    "@revessent/contracts",
    "@revessent/domain",
    "@revessent/observability",
    "@revessent/server",
    "@revessent/db",
    "@revessent/ai",
    "@revessent/ui"
  ],
  devIndicators: false,
  experimental: { cpus: 1 },
  // Type checking and linting run as separate gated steps (`tsc --noEmit`,
  // `eslint .`) — running them again inside the build OOMs this sandbox.
  // (Next 16 no longer accepts an `eslint` key in this config.)
  typescript: { ignoreBuildErrors: true },
  webpack: (config) => {
    // Workspace packages are TS source; their relative imports may use `.js`
    // specifiers (Node strip-types style). Teach webpack the same mapping.
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
      ".mts": [".mts", ".ts"],
      ".cts": [".cts", ".ts"]
    };
    return config;
  }
};

export default config;
