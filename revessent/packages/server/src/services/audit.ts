/**
 * Persistent audit events (brief §15, Architecture v1 §5.2 audit_logs).
 * Append-only at the database level (migration 0002: no UPDATE/DELETE grant).
 * Redaction: callers pass structured diffs; secrets/PANs must never be placed
 * in diffs — redact() from observability is applied defensively anyway.
 */
import { withOrgTx } from "@revessent/db";
import type { Db } from "@revessent/db";
import * as schema from "@revessent/db";
import { redact } from "@revessent/observability";

export interface AuditInput {
  orgId: string;
  actorId: string | null;
  actorKind?: "user" | "system" | "ai";
  action: string; // 'message.approved', 'policy.updated', 'key.connected', ...
  targetType: string;
  targetId: string;
  diff?: Record<string, unknown>;
  ip?: string | null;
  userAgent?: string | null;
}

export async function audit(db: Db, input: AuditInput): Promise<void> {
  await withOrgTx(db, input.orgId, async (tx) => {
    await tx.insert(schema.auditLogs).values({
      orgId: input.orgId,
      actorId: input.actorId,
      actorKind: input.actorKind ?? "user",
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      diff: input.diff ? (JSON.parse(redact(JSON.stringify(input.diff))) as Record<string, unknown>) : null,
      ip: input.ip ?? null,
      userAgent: input.userAgent ?? null
    });
  });
}
