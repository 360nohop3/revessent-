/**
 * PHASE 6 — POST-GENERATION SAFETY VALIDATION (architecture §9.6 #6).
 *
 * Runs AFTER schema validation and BEFORE anything is persisted as sendable.
 * A single hit ⇒ the AI output is discarded and the deterministic fallback is
 * used. Checks are conservative by design: false positives cost only a
 * template; false negatives could reach a customer.
 */
import { ALLOWED_PLACEHOLDERS, type AiCopy } from "./schema.js";

export type ContentViolation =
  | "contains_url"
  | "contains_email"
  | "contains_phone"
  | "contains_money_figure"
  | "contains_card_like_number"
  | "mentions_revessent"
  | "legal_threat"
  | "promises_outcome"
  | "requests_card_details"
  | "unknown_placeholder"
  | "header_injection"
  | "html_markup"
  | "instruction_leak";

const URL_RE = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(?:com|net|org|io|co|app|dev|me|link|info|biz|xyz)\b/i;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const PHONE_RE = /(?:\+?\d[\d\s().-]{8,}\d)/;
const MONEY_RE = /(?:[$€£¥]\s?\d|\d\s?(?:usd|eur|gbp|cad|aud|dollars|euros|pounds)\b|\b\d+[.,]\d{2}\b)/i;
const CARD_RE = /\b(?:\d[ -]?){13,19}\b/;
const REVESSENT_RE = /revessent/i;
const LEGAL_RE = /\b(lawsuit|legal action|attorney|collections? agency|debt collector|credit (?:score|report|bureau)|court|prosecut|garnish|sue\b)/i;
const PROMISE_RE = /\b(guarantee[ds]?|refund|we will (?:not )?charge|full refund|money back|no charge)\b/i;
const CARD_REQUEST_RE = /\b(reply (?:with|to this (?:email|message) with)|send (?:us|me)|share|provide|type|enter)\b[^.]{0,60}\b(card|cvv|cvc|card number|expiry|expiration|pin|password|ssn|social security)\b/i;
const HTML_RE = /<\s*\/?\s*[a-z][^>]*>/i;
const INSTRUCTION_LEAK_RE = /\b(as an ai|language model|system prompt|ignore (?:the )?(?:previous|above) instructions|json object|schema)\b/i;
const PLACEHOLDER_RE = /\{\{\s*[^}]*\s*\}\}|\{[a-z_]+\}|\$\{[^}]*\}|%\([^)]*\)s|%[sd]/gi;

function scanText(text: string): ContentViolation[] {
  const v: ContentViolation[] = [];
  if (URL_RE.test(text)) v.push("contains_url");
  if (EMAIL_RE.test(text)) v.push("contains_email");
  if (CARD_RE.test(text)) v.push("contains_card_like_number");
  else if (PHONE_RE.test(text)) v.push("contains_phone");
  if (MONEY_RE.test(text)) v.push("contains_money_figure");
  if (REVESSENT_RE.test(text)) v.push("mentions_revessent");
  if (LEGAL_RE.test(text)) v.push("legal_threat");
  if (PROMISE_RE.test(text)) v.push("promises_outcome");
  if (CARD_REQUEST_RE.test(text)) v.push("requests_card_details");
  if (HTML_RE.test(text)) v.push("html_markup");
  if (INSTRUCTION_LEAK_RE.test(text)) v.push("instruction_leak");
  for (const m of text.matchAll(PLACEHOLDER_RE)) {
    if (!(ALLOWED_PLACEHOLDERS as readonly string[]).includes(m[0].replace(/\s+/g, ""))) { v.push("unknown_placeholder"); break; }
  }
  return v;
}

/** All violations found across the copy (empty ⇒ acceptable). */
export function validateCopy(copy: AiCopy): ContentViolation[] {
  const found = new Set<ContentViolation>();
  // Subject/CTA label: header-bearing fields must be single-line and free of separators.
  for (const field of [copy.subject, copy.cta_label]) {
    if (/[\r\n\u2028\u2029]/.test(field) || /(?:^|\s)(?:bcc|cc|to|from|reply-to|content-type)\s*:/i.test(field)) found.add("header_injection");
    for (const x of scanText(field)) found.add(x);
  }
  const body = copy.paragraphs.join("\n\n");
  for (const x of scanText(body)) found.add(x);
  return [...found];
}
