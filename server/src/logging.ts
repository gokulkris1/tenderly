import { randomUUID } from "node:crypto";
import type { NextFunction, Response } from "express";
import type { AuthenticatedRequest } from "./auth.js";

/**
 * One JSON line per event, with the identifier a user can quote.
 *
 * The server logged with `console` and `safeError` deliberately erases context
 * in production, so a customer saying "it failed this morning" could not be
 * traced to a request at all. A request id closes that gap: it appears in the
 * log line, in a response header and in the error body the user sees.
 *
 * Nothing sensitive is ever logged. Not request bodies, not tokens, not
 * document contents — a log that carries a tender's text or a bidder's password
 * is a second copy of the thing we are supposed to be protecting.
 */

export type LogLevel = "info" | "warn" | "error";

/** Field names whose value is never written, wherever they appear. */
const REDACTED = new Set([
  "password", "token", "authorization", "apikey", "api_key", "secret",
  "passwordhash", "cvtext", "content", "sourcetext", "extractedtext", "bytes", "answer", "response",
]);

/**
 * Strips anything that must not be logged.
 *
 * Redaction is by field name rather than by value, because a value-based filter
 * can only remove what it already knows — and the point is to be safe about
 * fields nobody thought about.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[deep]";
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((entry) => redact(entry, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = REDACTED.has(key.toLowerCase()) ? "[redacted]" : redact(item, depth + 1);
    }
    return out;
  }
  if (typeof value === "string") return value.length > 500 ? `${value.slice(0, 500)}…` : value;
  return value;
}

export type LogFields = Record<string, unknown> & { message?: string };

/** Writes one JSON line. Everything the server logs goes through here. */
export function log(level: LogLevel, fields: LogFields) {
  const line = JSON.stringify({
    time: new Date().toISOString(),
    level,
    ...(redact(fields) as Record<string, unknown>),
  });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

/** The header a user can quote back, and the one support searches on. */
export const REQUEST_ID_HEADER = "x-request-id";

/**
 * Assigns a request id, echoes it, and logs one line per completed request.
 *
 * The id is taken from an inbound header when a proxy already set one, so a
 * trace does not break at our edge.
 */
export function requestLogging(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const inbound = req.headers[REQUEST_ID_HEADER];
  const requestId = (typeof inbound === "string" && inbound.length <= 200 && inbound) || randomUUID();
  (req as AuthenticatedRequest & { requestId?: string }).requestId = requestId;
  res.setHeader(REQUEST_ID_HEADER, requestId);

  // Any response carrying an `error` gets the id attached, wherever it was
  // written. Doing it here rather than at ~100 call sites means a route added
  // tomorrow is covered too, and none of them can forget.
  const sendJson = res.json.bind(res);
  res.json = ((body: unknown) => {
    if (body && typeof body === "object" && !Array.isArray(body) && "error" in body && !("requestId" in body)) {
      return sendJson({ ...(body as Record<string, unknown>), requestId });
    }
    return sendJson(body);
  }) as Response["json"];

  const started = process.hrtime.bigint();
  res.on("finish", () => {
    const durationMs = Number(process.hrtime.bigint() - started) / 1_000_000;
    log(res.statusCode >= 500 ? "error" : "info", {
      requestId,
      // The route pattern, not the populated path: a tender id in every log
      // line makes the lines impossible to group, and is a customer identifier.
      route: `${req.method} ${req.route?.path ?? req.path}`,
      status: res.statusCode,
      durationMs: Math.round(durationMs),
      accountId: req.auth?.accountId,
    });
  });
  next();
}

/** The request id for this request, for an error body or a downstream call. */
export function requestId(req: AuthenticatedRequest) {
  return (req as AuthenticatedRequest & { requestId?: string }).requestId ?? "";
}
