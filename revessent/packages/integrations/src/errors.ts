/**
 * PROVIDER ERROR TAXONOMY (Phase 4A §11).
 *
 * Raw Stripe errors NEVER reach the browser or the logs verbatim. Everything
 * provider-shaped is mapped into one of these safe codes; `safeMessage` is
 * the only text a client may see.
 */
export type ProviderErrorCode =
  | "invalid_credentials"    // key rejected (bad format/typo) — 401 from a never-valid key
  | "revoked"                // key worked before, now rejected — reconnection required
  | "auth_failure"           // generic authentication failure (not clearly invalid vs revoked)
  | "permission_failure"     // key valid but lacks the required read scope
  | "rate_limited"           // 429 — back off; preserve known-good data
  | "transient_network"      // connect errors / timeouts — retryable
  | "provider_outage"        // 5xx — retryable later
  | "invalid_provider_object"// an object failed normalization (recorded per-object, not fatal)
  | "malformed_response"     // response didn't match the expected provider shape
  // ---- Phase 4C payment-outcome codes (same taxonomy, execution domain) ----
  | "card_declined"          // generic card_error decline
  | "insufficient_funds"     // decline_code = insufficient_funds
  | "expired_card"           // decline_code = expired_card
  | "authentication_required"// 3DS/SCA — requires customer action, never auto-retried
  | "payment_method_failure" // other card_error outcomes (processing errors, etc.)
  | "invalid_payment_context"// provider rejected the customer/invoice/payment context
  | "unsupported_provider_state" // provider object state incompatible with the operation
  | "idempotency_conflict";  // provider reported conflicting idempotency parameters

const SAFE_MESSAGES: Record<ProviderErrorCode, string> = {
  invalid_credentials: "Stripe rejected this key. Check that it is a valid restricted key for the right account.",
  revoked: "This key no longer works — it was revoked or rotated in Stripe. Reconnect with a fresh key.",
  auth_failure: "Stripe could not authenticate this connection. Reconnect with a fresh restricted key.",
  permission_failure: "This key is missing a required read scope. Re-create it with read access to account, customers, subscriptions and invoices.",
  rate_limited: "Stripe is limiting request frequency. Previous data is preserved — try syncing again shortly.",
  transient_network: "Could not reach Stripe. Previous data is preserved — try again.",
  provider_outage: "Stripe is temporarily unavailable. Previous data is preserved — try again later.",
  invalid_provider_object: "Stripe returned a record this version cannot interpret. Other records were synced; Stripe remains the source of truth.",
  malformed_response: "Stripe returned an unexpected response. Previous data is preserved — try again.",
  card_declined: "The card was declined. Nothing was charged — no automatic retry is scheduled.",
  insufficient_funds: "The card was declined for insufficient funds. Nothing was charged.",
  expired_card: "The card was declined — it has expired. Nothing was charged.",
  authentication_required: "The customer must complete authentication for this payment. Nothing was charged automatically.",
  payment_method_failure: "The payment method could not be used. Nothing was charged.",
  invalid_payment_context: "Stripe rejected the payment context (customer or invoice). Nothing was charged.",
  unsupported_provider_state: "The provider object is in a state this operation cannot act on. Nothing was charged.",
  idempotency_conflict: "This payment was already attempted with different parameters."
};
/** Codes that represent CARD/PAYMENT outcomes (declines) — never auto-retried. */
export const CARD_OUTCOME_CODES: ReadonlySet<string> = new Set([
  "card_declined", "insufficient_funds", "expired_card", "authentication_required", "payment_method_failure"
]);

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly status: number;         // problem+json status
  readonly problemType: string;    // stable /errors/* type
  readonly retryAfterSec: number | null;
  /** Safe, client-displayable message. NEVER includes provider internals. */
  readonly safeMessage: string;

  constructor(code: ProviderErrorCode, opts?: { retryAfterSec?: number | null }) {
    super(`${code}: ${SAFE_MESSAGES[code]}`);
    this.code = code;
    this.safeMessage = SAFE_MESSAGES[code];
    this.retryAfterSec = opts?.retryAfterSec ?? null;
    switch (code) {
      case "rate_limited": this.status = 429; this.problemType = "/errors/rate-limited"; break;
      case "invalid_credentials":
      case "auth_failure": this.status = 400; this.problemType = "/errors/validation"; break;
      case "permission_failure": this.status = 400; this.problemType = "/errors/validation"; break;
      case "provider_outage": this.status = 503; this.problemType = "/errors/provider-unavailable"; break;
      case "transient_network": this.status = 503; this.problemType = "/errors/provider-unavailable"; break;
      case "malformed_response": this.status = 502; this.problemType = "/errors/provider-unavailable"; break;
      case "invalid_provider_object": this.status = 502; this.problemType = "/errors/provider-unavailable"; break;
      case "revoked": this.status = 409; this.problemType = "/errors/connection-revoked"; break;
      // Phase 4C payment-outcome codes: declines are honest failures of the
      // OPERATION (problem+json 402-class semantics without inventing a new
      // type), infrastructure/parameter failures reuse existing types.
      case "card_declined":
      case "insufficient_funds":
      case "expired_card":
      case "authentication_required":
      case "payment_method_failure":
        this.status = 402; this.problemType = "/errors/payment-failed"; break;
      case "invalid_payment_context":
      case "unsupported_provider_state": this.status = 400; this.problemType = "/errors/validation"; break;
      case "idempotency_conflict": this.status = 409; this.problemType = "/errors/idempotency-conflict"; break;
    }
  }
}

/**
 * Identity check that survives module duplication (bundlers can emit the same
 * class in two chunks, breaking `instanceof`). Structural, not nominal.
 */
export function isProviderError(e: unknown): e is ProviderError {
  return !!e && typeof e === "object"
    && typeof (e as { code?: unknown }).code === "string"
    && typeof (e as { safeMessage?: unknown }).safeMessage === "string"
    && typeof (e as { problemType?: unknown }).problemType === "string";
}

/**
 * Maps a raw provider SDK error into the taxonomy. Only the inputs listed
 * below are inspected — provider messages are never copied into `safeMessage`.
 * Already-classified errors pass through unchanged (no double classification).
 */
export function classifyProviderError(err: unknown): ProviderError {
  if (isProviderError(err)) return err;
  const e = err as { type?: string; name?: string; statusCode?: number; code?: string; message?: string } | null;
  const type = e?.type ?? e?.name ?? "";
  const status = e?.statusCode ?? 0;
  // Bundled runtimes can strip SDK subclass metadata; these server-side
  // message markers are classification-only and never reach a client.
  const msg = e?.message ?? "";
  if (/Invalid API Key/i.test(msg)) return new ProviderError("invalid_credentials");
  // undici's bare "fetch failed" (no Stripe envelope at all) = unreachable network
  if (e?.message === "fetch failed" && !type && !status) return new ProviderError("transient_network");
  if (type === "StripeAuthenticationError" || status === 401) return new ProviderError("invalid_credentials");
  if (type === "StripeRateLimitError" || status === 429) {
    const ra = Number((err as { headers?: Record<string, string> })?.headers?.["retry-after"] ?? "0");
    return new ProviderError("rate_limited", { retryAfterSec: Number.isFinite(ra) && ra > 0 ? ra : null });
  }
  if (type === "StripeAPIConnectionError") return new ProviderError("transient_network");
  if (type === "StripeIdempotencyError") return new ProviderError("transient_network");
  if (status >= 500) return new ProviderError("provider_outage");
  if (status === 403 || status === 404) return new ProviderError("permission_failure");
  if (type === "StripeInvalidRequestError") return new ProviderError("invalid_provider_object");
  return new ProviderError("malformed_response");
}
