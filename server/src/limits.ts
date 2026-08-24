import rateLimit, { type Options } from "express-rate-limit";
import type { Response } from "express";
import type { AuthenticatedRequest } from "./auth.js";

/**
 * Per-account limits on the expensive endpoints.
 *
 * Import crawls an external portal, analysis and drafting call a paid model,
 * and pack and deck generate files. Only /api/auth/* was limited, so any
 * authenticated user could call these in a loop — running up the model bill and
 * hammering eTenders from our address.
 *
 * These are keyed by account, not by IP: two colleagues behind one office NAT
 * are two customers, and one account moving to a phone is still one account.
 * The per-IP auth limiter stays as it is — it protects a route with no account.
 *
 * The numbers are sized to real use with headroom. Drafting in particular must
 * not fire during a batch run over every question in a tender, so its per-minute
 * allowance is several times the largest realistic question count.
 */

const minute = 60_000;
const hour = 60 * minute;

/** Whole seconds until the window resets, floored at 1 so it is never "0 seconds". */
function retryAfterSeconds(res: Response) {
  const reset = (res as Response & { getHeader(name: string): unknown }).getHeader("RateLimit-Reset");
  const seconds = Number(reset);
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : 60;
}

function describe(seconds: number) {
  if (seconds < 60) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

/**
 * One limiter. The refusal always states when the action can be retried, in
 * both the header a client reads and the sentence a person reads.
 */
function accountLimiter(args: { windowMs: number; limit: number; action: string }): ReturnType<typeof rateLimit> {
  const options: Partial<Options> = {
    windowMs: args.windowMs,
    limit: args.limit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    // Unauthenticated requests never reach these routes, but if one did it must
    // not share a bucket with every other anonymous caller.
    keyGenerator: (req) => (req as AuthenticatedRequest).auth?.accountId ?? `anon:${req.ip}`,
    handler: (_req, res) => {
      const seconds = retryAfterSeconds(res);
      res.setHeader("Retry-After", String(seconds));
      res.status(429).json({
        error: `Too many ${args.action} requests. Try again in ${describe(seconds)}.`,
        retryAfterSeconds: seconds,
      });
    },
  };
  return rateLimit(options);
}

/**
 * Analysis is the most expensive single call: a full tender pack through a
 * large model. Ten a minute is far beyond deliberate use and well short of a
 * loop; the hourly ceiling catches a slow loop the per-minute one would miss.
 */
export const analysisLimiter = accountLimiter({ windowMs: minute, limit: 10, action: "analysis" });
export const analysisHourlyLimiter = accountLimiter({ windowMs: hour, limit: 60, action: "analysis" });

/**
 * Drafting runs once per scored question, and a batch run over a whole tender
 * is normal use. 60 a minute leaves room for the largest realistic pack without
 * ever firing during legitimate work.
 */
export const draftLimiter = accountLimiter({ windowMs: minute, limit: 60, action: "drafting" });
export const draftHourlyLimiter = accountLimiter({ windowMs: hour, limit: 400, action: "drafting" });

/** Import crawls eTenders, so this limit protects their service as much as ours. */
export const importLimiter = accountLimiter({ windowMs: hour, limit: 60, action: "import" });

/** Pack and deck generation build files; a handful a minute is generous. */
export const packLimiter = accountLimiter({ windowMs: minute, limit: 20, action: "pack generation" });
