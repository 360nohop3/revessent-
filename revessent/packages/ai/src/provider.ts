/**
 * PHASE 6 — NARROW AI PROVIDER ABSTRACTION.
 *
 * The provider receives a system prompt + a user message and returns raw
 * text (expected to be JSON). It knows nothing about cases, money, or email.
 * Credentials are read by the concrete adapter from env only, never passed
 * through application code, never logged.
 */
export interface AiCompletionRequest {
  system: string;
  user: string;
  /** Hard wall-clock budget; adapters must abort at this point. */
  timeoutMs: number;
  maxOutputTokens: number;
  /** Deterministic identity of the generation (for provider-side idempotency/tracing, no PII). */
  requestId: string;
}

export interface AiCompletionResult {
  text: string;
  provider: string;
  model: string;
  tokensIn: number | null;
  tokensOut: number | null;
  latencyMs: number;
}

export type AiFailureCode =
  | "ai_timeout"
  | "ai_unavailable"       // network / 5xx / missing credentials
  | "ai_rate_limited"
  | "ai_rejected"          // 4xx other than rate limit
  | "ai_malformed_response";

export class AiProviderError extends Error {
  constructor(readonly code: AiFailureCode, message?: string) {
    super(message ?? code);
    this.name = "AiProviderError";
  }
}

export interface AiProvider {
  readonly name: string;
  complete(req: AiCompletionRequest): Promise<AiCompletionResult>;
}

export function isAiProviderError(e: unknown): e is AiProviderError {
  return e instanceof AiProviderError;
}
