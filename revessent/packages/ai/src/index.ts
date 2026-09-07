/**
 * @revessent/ai — SERVER-ONLY AI boundary (Phase 6).
 *
 * `import "server-only"` makes it a build error for client code to reach
 * this module. The provider is resolved from env here; application services
 * receive an `AiProvider` interface and never see credentials.
 *
 * AI is strictly downstream of financial decisions: it receives a coarse,
 * sanitized brief and returns schema-validated prose fragments. It cannot
 * choose recipients, senders, URLs, amounts, currencies, timing, or whether
 * anything is sent. Every failure degrades to a deterministic template.
 */
import "server-only";

import { anthropicProvider } from "./anthropic.js";
import type { AiProvider } from "./provider.js";

export { AiCopySchema, AI_COPY_JSON_SCHEMA, ALLOWED_PLACEHOLDERS, type AiCopy } from "./schema.js";
export { buildPrompt, sanitizeUntrusted, PROMPT_VERSION, SYSTEM_PROMPT, type PromptContext, type BuiltPrompt } from "./prompt.js";
export { validateCopy, type ContentViolation } from "./validate.js";
export { fallbackCopy, FALLBACK_TEMPLATES, TEMPLATE_VERSION } from "./templates.js";
export { generateCopy, type GenerationResult, type GenerateOptions, type FallbackReason } from "./generate.js";
export { renderEmail, escapeHtml, sanitizeHeaderValue, type RenderFacts, type RenderedEmail } from "./render.js";
export { AiProviderError, isAiProviderError, type AiProvider, type AiCompletionRequest, type AiCompletionResult, type AiFailureCode } from "./provider.js";

let active: AiProvider | null | undefined;

/**
 * The configured provider, or null when none is configured (⇒ every
 * generation uses the deterministic fallback). Resolved once from env.
 */
export function getAiProvider(): AiProvider | null {
  if (active !== undefined) return active;
  const key = process.env.ANTHROPIC_API_KEY;
  if (key && key.length > 10) {
    active = anthropicProvider({ apiKey: key, model: process.env.AI_MODEL ?? "claude-3-5-haiku-latest" });
  } else {
    active = null;
  }
  return active;
}

/** TEST-ONLY injection point (mirrors setStripeGatewayForTests). */
export function setAiProviderForTests(provider: AiProvider | null): void {
  active = provider;
}

/** TEST-ONLY: forget the injected provider (env resolution happens again). */
export function resetAiProvider(): void {
  active = undefined;
}
