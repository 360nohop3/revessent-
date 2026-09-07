import { defineConfig } from "drizzle-kit";

const url = process.env.MIGRATE_DATABASE_URL ?? process.env.DATABASE_URL; // env provided by caller
if (!url) throw new Error("MIGRATE_DATABASE_URL (owner role) is required for drizzle-kit");

export default defineConfig({
  schema: "./src/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: { url },
  strict: true,
  verbose: true
});
