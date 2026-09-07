/**
 * PHASE 6 — AI OUTPUT SCHEMA (the ONLY shape a model may return).
 *
 * The model produces prose fragments. It never produces: recipients,
 * senders, reply-to, URLs, amounts, currencies, dates, invoice ids, case
 * states, or payment instructions. Financial facts are interpolated by the
 * application from authoritative records via fixed placeholders; the model
 * may only reference them with the placeholders below.
 */
import { z } from "zod";

/** Placeholders the application fills from authoritative facts. */
export const ALLOWED_PLACEHOLDERS = ["{{amount}}", "{{org_name}}", "{{first_name}}", "{{cta_link}}"] as const;
export type AllowedPlaceholder = (typeof ALLOWED_PLACEHOLDERS)[number];

export const SUBJECT_MAX = 90;
export const PARAGRAPH_MAX = 420;
export const PARAGRAPHS_MAX = 4;
export const CTA_LABEL_MAX = 40;

const noControlChars = (s: string) => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(s);
const singleLine = (s: string) => !/[\r\n]/.test(s);

export const AiCopySchema = z.object({
  /** Single line; no header-breaking characters. */
  subject: z.string().trim().min(4).max(SUBJECT_MAX).refine(singleLine, "subject must be one line").refine(noControlChars),
  /** Plain-text paragraphs. Markdown/HTML are NOT interpreted. */
  paragraphs: z.array(
    z.string().trim().min(1).max(PARAGRAPH_MAX).refine(noControlChars)
  ).min(1).max(PARAGRAPHS_MAX),
  /** Button label only — the destination is always application-controlled. */
  cta_label: z.string().trim().min(2).max(CTA_LABEL_MAX).refine(singleLine).refine(noControlChars),
  tone_check: z.object({
    formality: z.enum(["casual", "neutral", "formal"]),
    empathy: z.enum(["low", "medium", "high"])
  })
}).strict();

export type AiCopy = z.infer<typeof AiCopySchema>;

/** JSON-schema rendering handed to providers that support structured output. */
export const AI_COPY_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["subject", "paragraphs", "cta_label", "tone_check"],
  properties: {
    subject: { type: "string", maxLength: SUBJECT_MAX },
    paragraphs: { type: "array", minItems: 1, maxItems: PARAGRAPHS_MAX, items: { type: "string", maxLength: PARAGRAPH_MAX } },
    cta_label: { type: "string", maxLength: CTA_LABEL_MAX },
    tone_check: {
      type: "object", additionalProperties: false, required: ["formality", "empathy"],
      properties: {
        formality: { type: "string", enum: ["casual", "neutral", "formal"] },
        empathy: { type: "string", enum: ["low", "medium", "high"] }
      }
    }
  }
} as const;
