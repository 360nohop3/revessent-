/**
 * Anthropic Messages API adapter (architecture §4: Claude primary). Thin
 * fetch-based client — no SDK dependency, no retries of its own (the
 * orchestrator's single repair attempt and the deterministic fallback own
 * resilience). The API key is read from env inside this module only, is
 * never logged, and never appears in thrown errors.
 *
 * LIVE STATUS: this adapter has NOT been exercised against the live API in
 * this environment (no credentials). Verification uses the fake provider.
 */
import { AiProviderError, type AiCompletionRequest, type AiCompletionResult, type AiProvider } from "./provider.js";

const ENDPOINT = "https://api.anthropic.com/v1/messages";

export function anthropicProvider(opts: { apiKey: string; model: string }): AiProvider {
  const apiKey = opts.apiKey;
  return {
    name: "anthropic",
    async complete(req: AiCompletionRequest): Promise<AiCompletionResult> {
      const startedAt = Date.now();
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), req.timeoutMs);
      let res: Response;
      try {
        res = await fetch(ENDPOINT, {
          method: "POST",
          signal: controller.signal,
          headers: {
            "content-type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": "2023-06-01"
          },
          body: JSON.stringify({
            model: opts.model,
            max_tokens: req.maxOutputTokens,
            temperature: 0.4,
            system: req.system,
            messages: [{ role: "user", content: req.user }],
            metadata: { user_id: req.requestId }
          })
        });
      } catch (e) {
        if ((e as Error).name === "AbortError") throw new AiProviderError("ai_timeout");
        throw new AiProviderError("ai_unavailable");
      } finally {
        clearTimeout(timer);
      }
      if (res.status === 429) throw new AiProviderError("ai_rate_limited");
      if (res.status >= 500) throw new AiProviderError("ai_unavailable");
      if (!res.ok) throw new AiProviderError("ai_rejected", `status ${res.status}`); // body intentionally not read into the error
      let json: { content?: Array<{ type: string; text?: string }>; model?: string; usage?: { input_tokens?: number; output_tokens?: number } };
      try { json = await res.json() as typeof json; } catch { throw new AiProviderError("ai_malformed_response"); }
      const text = (json.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("");
      if (!text) throw new AiProviderError("ai_malformed_response");
      return {
        text,
        provider: "anthropic",
        model: json.model ?? opts.model,
        tokensIn: json.usage?.input_tokens ?? null,
        tokensOut: json.usage?.output_tokens ?? null,
        latencyMs: Date.now() - startedAt
      };
    }
  };
}
