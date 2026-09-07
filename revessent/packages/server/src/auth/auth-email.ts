/**
 * PHASE 8 — account-lifecycle email (verification + password reset).
 *
 * Audit finding: the Better Auth hooks were Phase 3 CONTRACT stubs that only
 * `console.info`-ed the user's email. Because org creation requires a verified
 * email (§7.1), no production tenant could ever onboard, and no password could
 * ever be reset. This module closes the loop through the EXISTING Phase 6
 * email provider boundary (Postmark adapter, header-injection guards, safe
 * error taxonomy) — no second provider, no new queue.
 *
 * Safety:
 *   - the token/URL is application-built by Better Auth; we never log it
 *   - recipient = the account email only (application-resolved)
 *   - production without a configured provider FAILS CLOSED (throws) so the
 *     misconfiguration is loud instead of silently stranding users; outside
 *     production the message is dropped with a redacted log line (dev/test)
 *   - provider failures are logged as safe codes only (no bodies, no PII)
 */
import { isProduction } from "@revessent/config";
import { getEmailProvider, isEmailProviderError, type OutboundEmail } from "@revessent/integrations";
import { createLogger } from "@revessent/observability";
import { escapeHtml } from "@revessent/ai";

const log = createLogger("auth-email");

export type AuthEmailKind = "verify_email" | "reset_password";

export class AuthEmailNotConfiguredError extends Error {
  constructor() { super("Account email delivery is not configured (POSTMARK_SERVER_TOKEN)."); this.name = "AuthEmailNotConfiguredError"; }
}

export function renderAuthEmail(kind: AuthEmailKind, url: string, appName = "Revessent"): Pick<OutboundEmail, "subject" | "text" | "html" | "tag"> {
  const safeUrl = escapeHtml(url);
  if (kind === "verify_email") {
    return {
      tag: "auth-verify-email",
      subject: `Verify your email for ${appName}`,
      text: `Confirm your email address to finish setting up ${appName}.\n\nVerify: ${url}\n\nThis link expires in one hour. If you did not create an account, ignore this message.`,
      html: `<p>Confirm your email address to finish setting up ${escapeHtml(appName)}.</p><p><a href="${safeUrl}">Verify my email</a></p><p style="color:#6b7280;font-size:12px">This link expires in one hour. If you did not create an account, ignore this message.</p>`
    };
  }
  return {
    tag: "auth-reset-password",
    subject: `Reset your ${appName} password`,
    text: `Someone asked to reset the password for this ${appName} account.\n\nChoose a new password: ${url}\n\nThis link expires in one hour. If you did not request this, you can ignore this message — your password is unchanged.`,
    html: `<p>Someone asked to reset the password for this ${escapeHtml(appName)} account.</p><p><a href="${safeUrl}">Choose a new password</a></p><p style="color:#6b7280;font-size:12px">This link expires in one hour. If you did not request this, ignore this message — your password is unchanged.</p>`
  };
}

/**
 * Sends one account email through the configured provider. Never throws on a
 * provider failure (the auth flow already answered the client with a
 * non-enumerating response); throws ONLY for the production fail-closed case.
 */
export async function sendAuthEmail(kind: AuthEmailKind, to: string, url: string, fromAddress: string): Promise<{ sent: boolean; code: string | null }> {
  const provider = getEmailProvider();
  if (!provider) {
    if (isProduction()) throw new AuthEmailNotConfiguredError();
    log.warn(`${kind} not sent: no email provider configured (non-production)`);
    return { sent: false, code: "not_configured" };
  }
  const rendered = renderAuthEmail(kind, url);
  try {
    await provider.send({ to, from: fromAddress, replyTo: null, idempotencyReference: `${kind}:${Date.now()}`, ...rendered });
    return { sent: true, code: null };
  } catch (e) {
    const code = isEmailProviderError(e) ? `${e.kind}:${e.code}` : "unknown";
    log.error(`${kind} delivery failed`, { code }); // safe code only — never the address, URL or token
    return { sent: false, code };
  }
}
