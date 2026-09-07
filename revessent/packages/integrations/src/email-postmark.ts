/**
 * Postmark adapter (architecture §4). Thin fetch client; the server token is
 * read from env by the factory, held in a closure, never logged and never
 * placed in an error. Ambiguity is preserved faithfully: a timeout AFTER the
 * request was written, or a 5xx, is reported as `ambiguous` (the provider
 * may have accepted the message) — the caller must not blindly resend.
 *
 * LIVE STATUS: NOT exercised against Postmark in this environment (no
 * credentials, and no customer email may be sent from development).
 */
import { EmailProviderError, assertSafeOutboundEmail, type EmailProvider, type EmailSendResult, type OutboundEmail } from "./email.js";

const ENDPOINT = "https://api.postmarkapp.com/email";

export function postmarkProvider(opts: { serverToken: string; messageStream?: string; timeoutMs?: number }): EmailProvider {
  const token = opts.serverToken;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  return {
    name: "postmark",
    async send(msg: OutboundEmail): Promise<EmailSendResult> {
      assertSafeOutboundEmail(msg);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let res: Response;
      try {
        res = await fetch(ENDPOINT, {
          method: "POST",
          signal: controller.signal,
          headers: { "content-type": "application/json", accept: "application/json", "X-Postmark-Server-Token": token },
          body: JSON.stringify({
            From: msg.from, To: msg.to, ReplyTo: msg.replyTo ?? undefined,
            Subject: msg.subject, TextBody: msg.text, HtmlBody: msg.html,
            Tag: msg.tag, MessageStream: opts.messageStream ?? "outbound",
            Metadata: { reference: msg.idempotencyReference },
            TrackOpens: false, TrackLinks: "None"
          })
        });
      } catch (e) {
        // The request may have reached the provider before the abort/reset.
        throw new EmailProviderError("ambiguous", (e as Error).name === "AbortError" ? "timeout_after_send" : "unknown_provider_state");
      } finally {
        clearTimeout(timer);
      }
      if (res.ok) {
        let json: { MessageID?: string };
        try { json = await res.json() as typeof json; } catch { throw new EmailProviderError("ambiguous", "unknown_provider_state"); }
        if (!json.MessageID) throw new EmailProviderError("ambiguous", "unknown_provider_state");
        return { providerMessageId: json.MessageID, provider: "postmark", replayed: false };
      }
      if (res.status === 401 || res.status === 403) throw new EmailProviderError("configuration", "auth_failure"); // our credentials are wrong: nothing sent, no retry budget consumed
      if (res.status === 429) throw new EmailProviderError("transient", "rate_limited");
      if (res.status >= 500) throw new EmailProviderError("ambiguous", "provider_outage");
      // 422 = Postmark API error (inactive recipient, invalid email, …) — permanent for this message.
      // Body deliberately not read into the error (may echo addresses/content).
      let code: "invalid_recipient" | "recipient_suppressed" | "content_rejected" = "content_rejected";
      try {
        const body = await res.json() as { ErrorCode?: number };
        if (body.ErrorCode === 300) code = "invalid_recipient";
        else if (body.ErrorCode === 406) code = "recipient_suppressed";
      } catch { /* keep generic */ }
      throw new EmailProviderError("permanent", code);
    }
  };
}
