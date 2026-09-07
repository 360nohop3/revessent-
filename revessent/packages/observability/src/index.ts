/**
 * Minimal client-safe logger. Phase 7 will swap the transport for Sentry/Axiom
 * without changing call sites. Never log secrets — redact() is provided for
 * anything user-shaped (emails, tokens, keys).
 */
export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let minLevel: LogLevel = "warn";

export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

export interface Logger {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}

/** Replaces obviously-sensitive substrings in strings before they reach a transport. */
export function redact(value: string): string {
  return value
    .replace(/sk_(live|test)_[A-Za-z0-9]+/g, "sk_$1_…redacted")
    .replace(/rk_(live|test)_[A-Za-z0-9]+/g, "rk_$1_…redacted")
    .replace(/whsec_[A-Za-z0-9]+/g, "whsec_…redacted")
    .replace(/rv\.session_token=[^;"\s]+/g, "rv.session_token=…redacted")
    .replace(/Bearer [A-Za-z0-9._-]+/g, "Bearer …redacted")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+/g, "…@…");
}

export function createLogger(scope: string): Logger {
  const emit = (level: LogLevel) => (message: string, data?: unknown) => {
    if (ORDER[level] < ORDER[minLevel]) return;
    const line = `[${scope}] ${redact(message)}`;
    const payload = data === undefined ? "" : redact(JSON.stringify(data) ?? "");
    if (level === "error") console.error(line, payload);
    else if (level === "warn") console.warn(line, payload);
    else console.log(line, payload);
  };
  return {
    debug: emit("debug"),
    info: emit("info"),
    warn: emit("warn"),
    error: emit("error")
  };
}
