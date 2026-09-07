/**
 * PHASE 6 — GENERATION ORCHESTRATOR.
 *
 *   policy says aiPermitted? ──no──▶ fallback (ai_disabled)
 *          │ yes
 *   provider.complete (hard timeout) ──throws/timeout──▶ fallback (ai_timeout|ai_unavailable|…)
 *          │
 *   parse JSON + zod strict ──invalid──▶ ONE repair attempt ──invalid──▶ fallback (ai_invalid_output)
 *          │
 *   validateCopy (content red lines) ──violation──▶ fallback (ai_prohibited_content)
 *          │
 *   accepted AI copy
 *
 * Every path returns a usable, schema-valid copy. Raw provider text is never
 * returned to callers, never logged; only a safe failure code and metrics.
 */
import { AiCopySchema, type AiCopy } from "./schema.js";
import { buildPrompt, type PromptContext } from "./prompt.js";
import { validateCopy, type ContentViolation } from "./validate.js";
import { fallbackCopy, TEMPLATE_VERSION } from "./templates.js";
import { AiProviderError, type AiProvider, type AiCompletionResult } from "./provider.js";

export type FallbackReason =
  | "ai_disabled" | "ai_no_provider" | "ai_timeout" | "ai_unavailable" | "ai_rate_limited"
  | "ai_rejected" | "ai_malformed_response" | "ai_invalid_output" | "ai_prohibited_content" | "ai_error"
  /** Phase 7: the plan does not include AI notes (templates only) — not a provider failure. */
  | "ai_not_entitled";

export interface GenerationResult {
  copy: AiCopy;
  source: "ai" | "fallback";
  fallbackReason: FallbackReason | null;
  promptVersion: string;
  inputSanitizedHash: string;
  /** Provider metrics for ai_generations (never the raw text). */
  provider: { name: string; model: string; tokensIn: number | null; tokensOut: number | null; latencyMs: number } | null;
  /** Diagnostics: schema issue count / violations (codes only). */
  violations: ContentViolation[];
  schemaValid: boolean;
  /** The validated structured output when AI succeeded (for ai_generations.output). */
  aiOutput: AiCopy | null;
}

export interface GenerateOptions {
  aiPermitted: boolean;
  provider: AiProvider | null;
  timeoutMs?: number;
  maxOutputTokens?: number;
  requestId: string;
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidate = fenced ? fenced[1]! : trimmed;
  try { return JSON.parse(candidate); } catch { /* fall through */ }
  const start = candidate.indexOf("{"), end = candidate.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try { return JSON.parse(candidate.slice(start, end + 1)); } catch { /* invalid */ }
  }
  return undefined;
}

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AiProviderError("ai_timeout")), ms);
  });
  try { return await Promise.race([p, timeout]); } finally { if (timer) clearTimeout(timer); }
}

export async function generateCopy(ctx: PromptContext, opts: GenerateOptions): Promise<GenerationResult> {
  const prompt = buildPrompt(ctx);
  const base = {
    promptVersion: prompt.promptVersion,
    inputSanitizedHash: prompt.inputSanitizedHash,
    violations: [] as ContentViolation[],
    schemaValid: false,
    aiOutput: null
  };
  const fallback = (reason: FallbackReason, extra?: Partial<GenerationResult>): GenerationResult => ({
    ...base, copy: fallbackCopy(ctx.purpose), source: "fallback", fallbackReason: reason, provider: null,
    promptVersion: `${prompt.promptVersion}+${TEMPLATE_VERSION}`, ...extra
  });

  if (!opts.aiPermitted) return fallback("ai_disabled");
  if (!opts.provider) return fallback("ai_no_provider");
  const timeoutMs = opts.timeoutMs ?? 12_000;
  const maxOutputTokens = opts.maxOutputTokens ?? 700;

  let completion: AiCompletionResult;
  try {
    completion = await withTimeout(opts.provider.complete({
      system: prompt.system, user: prompt.user, timeoutMs, maxOutputTokens, requestId: opts.requestId
    }), timeoutMs);
  } catch (e) {
    const code: FallbackReason = e instanceof AiProviderError ? e.code : "ai_error";
    return fallback(code);
  }
  const providerMeta = {
    name: completion.provider, model: completion.model,
    tokensIn: completion.tokensIn, tokensOut: completion.tokensOut, latencyMs: completion.latencyMs
  };

  let parsed = AiCopySchema.safeParse(extractJson(completion.text));
  if (!parsed.success) {
    // ONE automatic repair attempt (§9.6 #2): same prompt, explicit reminder.
    try {
      const repair = await withTimeout(opts.provider.complete({
        system: prompt.system,
        user: prompt.user + "\n\nREMINDER: respond with ONLY the JSON object. Your previous response did not match the schema.",
        timeoutMs, maxOutputTokens, requestId: `${opts.requestId}:repair`
      }), timeoutMs);
      providerMeta.tokensIn = (providerMeta.tokensIn ?? 0) + (repair.tokensIn ?? 0);
      providerMeta.tokensOut = (providerMeta.tokensOut ?? 0) + (repair.tokensOut ?? 0);
      providerMeta.latencyMs += repair.latencyMs;
      parsed = AiCopySchema.safeParse(extractJson(repair.text));
    } catch {
      return fallback("ai_invalid_output", { provider: providerMeta });
    }
    if (!parsed.success) return fallback("ai_invalid_output", { provider: providerMeta });
  }

  const violations = validateCopy(parsed.data);
  if (violations.length) return fallback("ai_prohibited_content", { provider: providerMeta, violations, schemaValid: true, aiOutput: parsed.data });

  return {
    ...base, copy: parsed.data, source: "ai", fallbackReason: null, provider: providerMeta,
    schemaValid: true, aiOutput: parsed.data
  };
}
