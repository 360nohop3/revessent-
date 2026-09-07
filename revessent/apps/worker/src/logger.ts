/**
 * Worker logging (§15 observability). Built on the shared redacting logger:
 * secret-shaped substrings (Stripe keys, webhook secrets, bearer tokens,
 * emails) are redacted at the transport. Redis connection strings are never
 * logged at all — bootstrap reports connectivity, not endpoints.
 */
import { createLogger, redact } from "@revessent/observability";

export const log = createLogger("worker");

/** Strips any redis://… URL accidentally embedded in an error message. */
export function withoutConnectionDetails(message: string): string {
  return redact(message.replace(/rediss?:\/\/\S+/g, "redis://…redacted"));
}

/** Structured job-log fields (§15) — identifiers only, never payloads with secrets. */
export interface JobLogFields {
  jobRunId?: string;
  orgId?: string;
  caseId?: string;
  dedupeKey?: string;
  jobType?: string;
  attempt?: number;
  durationMs?: number;
  result?: string;
  errorCode?: string;
}
