/**
 * System execution context (Phase 5 §14 — documented privileged surface).
 *
 * The worker is org-agnostic infrastructure: it must be able to deliver work
 * for ANY organization, but it is not a user and holds no session. Two narrow
 * privileged reads run on the scheduler/owner connection (`systemDb`):
 *   1. organization ID enumeration (scheduler discovery loop), and
 *   2. the single organization ROW needed to build an OrgContext.
 * EVERY tenant read/write — job rows, recovery cases, payments, retries —
 * runs on the application connection (`appDb`, revessent_app) inside
 * `withOrgTx`, so Postgres RLS remains fully enforced for all tenant data.
 * RLS is not weakened; the privileged connection is only ever handed
 * organization IDs and organization rows.
 *
 * Per Phase 4D §19, system runs are operator-class but never anonymous:
 * the context carries role "operate" and the stable actor id "system"
 * (audit_logs.actor_id is a free-text column; the 4D engine stamps
 * `actor: "system"` into its attempt rows and audit diffs regardless).
 */
import { eq } from "drizzle-orm";
import { appDb, type OrgContext } from "@revessent/server";
import { withoutOrg, type Db } from "@revessent/db";
import * as schema from "@revessent/db";

export const SYSTEM_ACTOR_ID = "system";

/** Loads the durable organization row (privileged, narrow) and builds the
 *  system execution context whose tenant operations are RLS-scoped. */
export async function systemOrgContext(systemDb: Db, orgId: string): Promise<OrgContext | null> {
  const [org] = await withoutOrg(systemDb, (tx) =>
    tx.select().from(schema.organizations).where(eq(schema.organizations.id, orgId)));
  if (!org) return null;
  return { org, role: "operator", userId: SYSTEM_ACTOR_ID, db: appDb() };
}
