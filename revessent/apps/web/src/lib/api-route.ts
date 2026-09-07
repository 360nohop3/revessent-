/**
 * Thin-handler plumbing (§6.1): every route = parse → requireSession →
 * requireOrgRole → service → problem+json. Handlers stay ~10 lines; the
 * business rules live in @revessent/server services.
 */
import { ProblemError, problemResponse, safeInternalError, assertSameOrigin } from "@revessent/server";
import { ZodError } from "zod";
import { createLogger } from "@revessent/observability";

const log = createLogger("api");

export async function handle(req: Request, fn: () => Promise<unknown>, _opts?: { run: (body: unknown) => Promise<unknown>; schema?: { parse: (b: unknown) => unknown } }): Promise<Response> {
  try {
    return Response.json(await fn());
  } catch (e) {
    return toProblem(e, req.url);
  }
}

export function toProblem(e: unknown, instance: string): Response {
  if (e instanceof ProblemError) return problemResponse(e, instance);
  // AUDIT FIX: schema failures on mutation routes surfaced as 500s. A Zod
  // parse failure is the client's mistake → 400 /errors/validation. Only
  // field PATHS are echoed — never values, never internals (brief §16).
  if (e instanceof ZodError) {
    const fields = [...new Set(e.issues.map((i) => i.path.join(".")))].filter(Boolean).join(", ");
    return problemResponse(new ProblemError("validation", fields ? `Invalid fields: ${fields}` : undefined), instance);
  }
  // Phase 8: unexpected errors go through the REDACTING logger — a raw
  // DrizzleQueryError embeds the SQL text and parameters (emails, tokens).
  // Only the error name + redacted message are kept; never params/stacks.
  const err = e as { name?: string; message?: string; cause?: { code?: string } };
  log.error(`unhandled ${instance}`, { name: err?.name ?? "Error", message: String(err?.message ?? "").split("\n")[0]?.slice(0, 300), code: err?.cause?.code ?? null });
  return problemResponse(safeInternalError(), instance);
}

/** Wraps a mutating handler: same-origin check + JSON body parse. */
export function mutation<T>(req: Request, fn: (body: unknown) => Promise<T>, parse?: (b: unknown) => unknown): Promise<Response> {
  return (async () => {
    try {
      assertSameOrigin(req);
      let body: unknown = undefined;
      if (parse) {
        try { body = await req.json(); } catch { throw new ProblemError("validation", "A JSON body is required."); }
        body = parse(body);
      }
      return Response.json(await fn(body));
    } catch (e) {
      return toProblem(e, req.url);
    }
  })();
}

export { assertSameOrigin };
