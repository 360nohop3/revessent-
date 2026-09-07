/**
 * PHASE 6 — DETERMINISTIC APPROVED FALLBACK COPY (architecture §9.6 #2).
 *
 * Pre-approved plain-text templates used whenever AI is disabled, times out,
 * fails, returns invalid or prohibited output, or is unavailable. Same
 * placeholder contract as AI copy; the application interpolates every value.
 * Recovery communication never blocks on AI.
 */
import type { CommunicationPurpose } from "@revessent/domain";
import type { AiCopy } from "./schema.js";

export const TEMPLATE_VERSION = "fallback-v1";

export const FALLBACK_TEMPLATES: Record<CommunicationPurpose, AiCopy> = {
  dunning_note: {
    subject: "A quick note about your {{org_name}} payment",
    paragraphs: [
      "Hi {{first_name}},",
      "Your most recent payment of {{amount}} to {{org_name}} didn't go through. This happens for all sorts of ordinary reasons — an expired card, a bank limit, a new card in the mail.",
      "Nothing has changed with your account yet. When you have a moment, you can update your payment method here: {{cta_link}}",
      "Thanks for being with us."
    ],
    cta_label: "Update payment method",
    tone_check: { formality: "neutral", empathy: "medium" }
  },
  final_notice: {
    subject: "Your {{org_name}} subscription needs attention",
    paragraphs: [
      "Hi {{first_name}},",
      "We've tried a few times to collect your payment of {{amount}} for {{org_name}} and it hasn't gone through. We won't keep trying automatically.",
      "To keep your subscription, please update your payment method here: {{cta_link}}",
      "If you'd rather let it lapse, no action is needed."
    ],
    cta_label: "Update payment method",
    tone_check: { formality: "neutral", empathy: "medium" }
  }
};

export function fallbackCopy(purpose: CommunicationPurpose): AiCopy {
  const t = FALLBACK_TEMPLATES[purpose];
  return { ...t, paragraphs: [...t.paragraphs], tone_check: { ...t.tone_check } };
}
