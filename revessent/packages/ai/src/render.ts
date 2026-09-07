/**
 * PHASE 6 — RENDERING: application-controlled interpolation.
 *
 * Financial and identity facts are inserted HERE, from authoritative
 * application state, never by the model. Unknown placeholders are removed.
 * HTML output escapes every interpolated value and every model/template
 * string; the only anchor is the application-supplied CTA URL (validated to
 * be https and to belong to the application origin by the caller).
 */
import type { AiCopy } from "./schema.js";

export interface RenderFacts {
  /** Pre-formatted by the application from integer minor units + ISO currency. */
  amountFormatted: string;
  orgName: string;
  /** Sanitized first name or null (⇒ greeting falls back to "there"). */
  firstName: string | null;
  ctaUrl: string;
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

const PLACEHOLDER_RE = /\{\{\s*([a-z_]+)\s*\}\}/g;

function fill(s: string, facts: RenderFacts): string {
  return s.replace(PLACEHOLDER_RE, (_m, key: string) => {
    switch (key) {
      case "amount": return facts.amountFormatted;
      case "org_name": return facts.orgName;
      case "first_name": return facts.firstName ?? "there";
      case "cta_link": return facts.ctaUrl;
      default: return "";
    }
  }).replace(/[ \t]{2,}/g, " ").trim();
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Subject line: single line, no header separators (defense in depth). */
export function sanitizeHeaderValue(s: string): string {
  return s.replace(/[\r\n\u2028\u2029\u0000-\u001F\u007F]+/g, " ").trim().slice(0, 200);
}

export function renderEmail(copy: AiCopy, facts: RenderFacts): RenderedEmail {
  const subject = sanitizeHeaderValue(fill(copy.subject, facts));
  const paragraphs = copy.paragraphs.map((p) => fill(p, facts)).filter((p) => p.length > 0);
  const ctaLabel = fill(copy.cta_label, facts) || "Update payment method";
  const hasInlineCta = copy.paragraphs.some((p) => p.includes("{{cta_link}}"));

  const textLines = [...paragraphs];
  if (!hasInlineCta) textLines.push(`${ctaLabel}: ${facts.ctaUrl}`);
  const text = textLines.join("\n\n");

  const htmlParas = paragraphs.map((p) => {
    // The CTA URL is the only permitted anchor; it is inserted as an escaped href by the application.
    const escaped = escapeHtml(p);
    const withLink = escaped.split(escapeHtml(facts.ctaUrl)).join(`<a href="${escapeHtml(facts.ctaUrl)}">${escapeHtml(facts.ctaUrl)}</a>`);
    return `<p>${withLink}</p>`;
  });
  const button = `<p><a href="${escapeHtml(facts.ctaUrl)}" style="display:inline-block;padding:10px 16px;border-radius:6px;background:#1f2937;color:#ffffff;text-decoration:none">${escapeHtml(ctaLabel)}</a></p>`;
  const html = `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.5;color:#111827;max-width:560px;margin:0 auto;padding:24px">${htmlParas.join("")}${button}</body></html>`;
  return { subject, text, html };
}
