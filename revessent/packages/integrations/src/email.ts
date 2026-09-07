/**
 * PHASE 6 — EMAIL PROVIDER BOUNDARY (architecture §4: Postmark).
 *
 * A narrow server-side abstraction: the application hands over a fully
 * rendered message with application-controlled headers; the adapter sends
 * it and returns a provider reference or a safe error code. Credentials are
 * read from env by the concrete adapter only; raw provider responses never
 * leave this module (no bodies in errors, no bodies in logs).
 *
 * Outcome taxonomy — the durable communication record keys off these:
 *   sent       — provider accepted; `providerMessageId` is the evidence
 *   transient  — safe to retry with the SAME idempotency reference later
 *   permanent  — never retry (bad recipient, suppressed, rejected content)
 *   ambiguous  — a request MAY have been accepted (timeout after send, 5xx
 *                after partial processing): never auto-resent; reconciled
 *                by reference or by an operator
 */

export interface OutboundEmail {
  /** Application-resolved recipient — never model-controlled. */
  to: string;
  /** Application-controlled sender/reply-to. */
  from: string;
  replyTo: string | null;
  subject: string;
  text: string;
  html: string;
  /** Deterministic reference (the communication id) — provider-side dedupe/trace. */
  idempotencyReference: string;
  /** Provider "stream"/"tag" style routing — application constant. */
  tag: string;
}

/**
 *  transient     – retry with backoff (rate limit, network before send)
 *  permanent     – never retry this message (bad recipient, rejected content)
 *  ambiguous     – the provider MAY have accepted it; never auto-resend
 *  configuration – our credentials/config are wrong (401/403, missing token):
 *                  nothing was sent, no retry budget is consumed; an operator
 *                  must fix configuration before delivery can resume.
 */
export type EmailFailureKind = "transient" | "permanent" | "ambiguous" | "configuration";

export type EmailErrorCode =
  | "invalid_recipient" | "recipient_suppressed" | "content_rejected" | "auth_failure"
  | "rate_limited" | "provider_outage" | "transient_network" | "timeout_after_send"
  | "unknown_provider_state" | "header_injection" | "not_configured";

export class EmailProviderError extends Error {
  constructor(readonly kind: EmailFailureKind, readonly code: EmailErrorCode) {
    super(`${kind}:${code}`);
    this.name = "EmailProviderError";
  }
}

export interface EmailSendResult {
  providerMessageId: string;
  provider: string;
  /** True when the provider reported this reference as already accepted earlier. */
  replayed: boolean;
}

export interface EmailProvider {
  readonly name: string;
  send(msg: OutboundEmail): Promise<EmailSendResult>;
}

/** Header-bearing values must be single-line and free of injection vectors. */
export function assertSafeHeaderValue(name: string, value: string): void {
  // eslint-disable-next-line no-control-regex
  if (/[\r\n\u2028\u2029\u0000-\u001F\u007F]/.test(value)) throw new EmailProviderError("permanent", "header_injection");
  if (name !== "subject" && /[\s<>,;"]/.test(value)) throw new EmailProviderError("permanent", "header_injection");
  if (name !== "subject" && !/^[^@]+@[^@]+\.[^@]+$/.test(value)) throw new EmailProviderError("permanent", "invalid_recipient");
}

/** Validates every header-bearing field before ANY adapter sees the message. */
export function assertSafeOutboundEmail(msg: OutboundEmail): void {
  assertSafeHeaderValue("to", msg.to);
  assertSafeHeaderValue("from", msg.from);
  if (msg.replyTo) assertSafeHeaderValue("reply-to", msg.replyTo);
  assertSafeHeaderValue("subject", msg.subject);
  if (msg.subject.length === 0 || msg.subject.length > 200) throw new EmailProviderError("permanent", "content_rejected");
  if (!msg.text.trim()) throw new EmailProviderError("permanent", "content_rejected");
}

export function isEmailProviderError(e: unknown): e is EmailProviderError {
  return e instanceof EmailProviderError;
}
