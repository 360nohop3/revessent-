/**
 * TEST-ONLY deterministic email provider (Phase 6 verification). Emulates the
 * provider boundary — including idempotent replay by reference, transient
 * failures, permanent failures and AMBIGUOUS outcomes (accepted-but-lost) —
 * without network or credentials. Never reachable from application runtime.
 */
import { EmailProviderError, assertSafeOutboundEmail, type EmailErrorCode, type EmailProvider, type EmailSendResult, type OutboundEmail } from "./email.js";

export type FakeEmailBehavior =
  | { kind: "ok" }
  | { kind: "transient"; code?: EmailErrorCode; times?: number }
  | { kind: "permanent"; code?: EmailErrorCode }
  /** The provider ACCEPTS and records the message, then the response is lost. */
  | { kind: "ambiguous_accepted"; code?: EmailErrorCode; times?: number }
  /** The provider did NOT accept, but the caller cannot tell. */
  | { kind: "ambiguous_lost"; code?: EmailErrorCode; times?: number }
  /** Our credentials are rejected (401/403): nothing sent, not retryable until config changes. */
  | { kind: "configuration" }
  | { kind: "hang" };

export interface FakeEmailProvider extends EmailProvider {
  /** Messages the provider actually ACCEPTED (what a customer would receive). */
  accepted: OutboundEmail[];
  /** Every send attempt (including failed ones). */
  attempts: OutboundEmail[];
  /** Reference → message id, for replay + "find by reference" lookups. */
  byReference: Map<string, string>;
  behavior: FakeEmailBehavior;
  /** Provider-side lookup by reference (models Postmark's message search). */
  findByReference(reference: string): string | null;
}

export function fakeEmailProvider(behavior: FakeEmailBehavior = { kind: "ok" }): FakeEmailProvider {
  const accepted: OutboundEmail[] = [];
  const attempts: OutboundEmail[] = [];
  const byReference = new Map<string, string>();
  let failuresLeft: number | null = null;
  const provider: FakeEmailProvider = {
    name: "fake-email",
    accepted, attempts, byReference, behavior,
    findByReference: (ref) => byReference.get(ref) ?? null,
    async send(msg: OutboundEmail): Promise<EmailSendResult> {
      attempts.push(msg);
      assertSafeOutboundEmail(msg);
      // Idempotent replay: an already-accepted reference returns the same id.
      const existing = byReference.get(msg.idempotencyReference);
      if (existing) return { providerMessageId: existing, provider: "fake-email", replayed: true };
      const b = provider.behavior;
      const consume = (times?: number) => {
        if (times == null) return true;
        if (failuresLeft === null) failuresLeft = times;
        if (failuresLeft > 0) { failuresLeft -= 1; return true; }
        return false;
      };
      const accept = (): EmailSendResult => {
        const id = `fake-msg-${byReference.size + 1}-${msg.idempotencyReference.slice(-8)}`;
        byReference.set(msg.idempotencyReference, id);
        accepted.push(msg);
        return { providerMessageId: id, provider: "fake-email", replayed: false };
      };
      switch (b.kind) {
        case "ok": return accept();
        case "transient": if (consume(b.times)) throw new EmailProviderError("transient", b.code ?? "transient_network"); return accept();
        case "permanent": throw new EmailProviderError("permanent", b.code ?? "invalid_recipient");
        case "ambiguous_accepted": if (consume(b.times)) { accept(); throw new EmailProviderError("ambiguous", b.code ?? "timeout_after_send"); } return accept();
        case "ambiguous_lost": if (consume(b.times)) throw new EmailProviderError("ambiguous", b.code ?? "provider_outage"); return accept();
        case "configuration": throw new EmailProviderError("configuration", "auth_failure");
        case "hang": return new Promise<EmailSendResult>(() => { /* never resolves */ });
        default: return accept();
      }
    }
  };
  return provider;
}
