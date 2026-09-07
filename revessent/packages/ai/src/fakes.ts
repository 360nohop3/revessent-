/**
 * TEST-ONLY deterministic AI provider (Phase 6 §verification). Emulates the
 * provider boundary without network or credentials. Never reachable from
 * application runtime (only tests and the fixture wiring import this file).
 */
import { AiProviderError, type AiCompletionRequest, type AiCompletionResult, type AiProvider } from "./provider.js";
import type { AiCopy } from "./schema.js";

export type FakeAiBehavior =
  | { kind: "ok"; copy?: Partial<AiCopy> }
  | { kind: "raw"; text: string }
  | { kind: "raw_then_ok"; text: string; copy?: Partial<AiCopy> }
  | { kind: "throw"; code: AiProviderError["code"] }
  | { kind: "hang" }
  | { kind: "sequence"; steps: FakeAiBehavior[] };

export const GOOD_AI_COPY: AiCopy = {
  subject: "Your payment to {{org_name}} didn't go through",
  paragraphs: [
    "Hi {{first_name}}, just a quick heads-up: the latest payment of {{amount}} for {{org_name}} didn't clear.",
    "Nothing changes on your side for now. If you'd like, you can update your card here: {{cta_link}}",
    "Thanks for being with us."
  ],
  cta_label: "Update card",
  tone_check: { formality: "casual", empathy: "high" }
};

export interface FakeAiProvider extends AiProvider {
  calls: AiCompletionRequest[];
  behavior: FakeAiBehavior;
}

export function fakeAiProvider(behavior: FakeAiBehavior = { kind: "ok" }): FakeAiProvider {
  const calls: AiCompletionRequest[] = [];
  let seqIndex = 0;
  const provider: FakeAiProvider = {
    name: "fake",
    calls,
    behavior,
    async complete(req) {
      calls.push(req);
      let b = provider.behavior;
      if (b.kind === "sequence") b = b.steps[Math.min(seqIndex++, b.steps.length - 1)]!;
      const ok = (copy?: Partial<AiCopy>): AiCompletionResult => ({
        text: JSON.stringify({ ...GOOD_AI_COPY, ...copy }), provider: "fake", model: "fake-1",
        tokensIn: 100, tokensOut: 80, latencyMs: 5
      });
      switch (b.kind) {
        case "ok": return ok(b.copy);
        case "raw": return { text: b.text, provider: "fake", model: "fake-1", tokensIn: 100, tokensOut: 10, latencyMs: 5 };
        case "raw_then_ok":
          return calls.length === 1
            ? { text: b.text, provider: "fake", model: "fake-1", tokensIn: 100, tokensOut: 10, latencyMs: 5 }
            : ok(b.copy);
        case "throw": throw new AiProviderError(b.code);
        case "hang": return new Promise<AiCompletionResult>(() => { /* never resolves; orchestrator timeout fires */ });
        default: return ok();
      }
    }
  };
  return provider;
}
