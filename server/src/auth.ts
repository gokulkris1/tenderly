import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";
import type { MembershipRole } from "./db.js";

const configuredSecret = process.env.JWT_SECRET?.trim();
const secret = configuredSecret || "tenderly-development-only-secret-change-me";

if (process.env.NODE_ENV === "production" && (!configuredSecret || configuredSecret.length < 32)) {
  throw new Error("JWT_SECRET must be set to at least 32 characters in production");
}

/**
 * Who is asking, and for which organisation.
 *
 * `accountId` is the tenant — the organisation that owns the rows — and is what
 * every scoped query filters on. `userId` is the person, which is what the
 * audit log and task ownership want. They were the same value until TLY-86 and
 * conflating them again is how a colleague's action gets recorded as somebody
 * else's.
 */
export type AuthenticatedRequest = Request & {
  auth?: { accountId: string; userId: string; email: string; role: MembershipRole };
};

export function signToken(user: { id: string; organisationId: string; email: string; role?: MembershipRole }) {
  return jwt.sign(
    { sub: user.id, org: user.organisationId, role: user.role ?? "owner", email: user.email },
    secret,
    { expiresIn: "12h", issuer: "tenderly-api", audience: "tenderly-web" },
  );
}

export function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) return res.status(401).json({ error: "Sign in required" });
  try {
    const payload = jwt.verify(header.slice(7), secret, { issuer: "tenderly-api", audience: "tenderly-web" }) as jwt.JwtPayload;
    if (!payload.sub || typeof payload.email !== "string") return res.status(401).json({ error: "Invalid session" });
    // A token minted before organisations existed names a user where the tenant
    // should be. Guessing which organisation it meant is exactly the mistake
    // that hands one company another's bids, so it is refused and the person
    // signs in again — the cost is one sign-in, once.
    if (typeof payload.org !== "string" || !payload.org) {
      return res.status(401).json({ error: "Session expired or invalid" });
    }
    req.auth = {
      accountId: payload.org,
      userId: String(payload.sub),
      email: payload.email,
      role: (payload.role as MembershipRole) ?? "viewer",
    };
    next();
  } catch {
    return res.status(401).json({ error: "Session expired or invalid" });
  }
}

/** The organisation whose data this request may touch. */
export function accountId(req: AuthenticatedRequest) {
  if (!req.auth?.accountId) throw new Error("AUTH_REQUIRED");
  return req.auth.accountId;
}

/** The person making the request, as opposed to the organisation they act for. */
export function userId(req: AuthenticatedRequest) {
  if (!req.auth?.userId) throw new Error("AUTH_REQUIRED");
  return req.auth.userId;
}

/** The acting user's email: the actor on ledger entries and acknowledgements. */
export function actorEmail(req: AuthenticatedRequest) {
  if (!req.auth?.email) throw new Error("AUTH_REQUIRED");
  return req.auth.email;
}
