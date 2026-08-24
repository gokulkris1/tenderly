import type { NextFunction, Response } from "express";
import type { AuthenticatedRequest } from "./auth.js";
import { membershipFor, type MembershipRole } from "./db.js";

/**
 * What each role may do, enforced on the server.
 *
 * A hidden button is a courtesy, not a control: anybody can read the JavaScript
 * and call the endpoint. So the rule lives here, in middleware that every
 * mutating route passes through, rather than in each handler where one of them
 * will eventually be written without it.
 */

const RANK: Record<MembershipRole, number> = { viewer: 0, editor: 1, owner: 2 };

export function atLeast(role: MembershipRole, required: MembershipRole) {
  return RANK[role] >= RANK[required];
}

/** The refusal, naming the role the caller would need. */
export function roleRequiredMessage(required: MembershipRole) {
  return `This action needs the ${required} role`;
}

export const LAST_OWNER = "An organisation must have at least one owner";

/**
 * Confirms the caller still belongs to the organisation their token names, and
 * replaces the token's role claim with the row's.
 *
 * The claim is a twelve-hour-old copy. Somebody removed from a team, or demoted
 * to viewer, must lose that access on their next request and not at the end of
 * their session — so the membership is read on every request. It is one indexed
 * lookup, and it is the difference between "you no longer have access" being
 * true and being eventually true.
 */
export async function attachMembership(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  if (!req.auth) return res.status(401).json({ error: "Sign in required" });
  try {
    const membership = await membershipFor(req.auth.accountId, req.auth.userId);
    if (!membership) return res.status(403).json({ error: "You no longer have access to this workspace" });
    req.auth.role = membership.role;
    next();
  } catch {
    return res.status(500).json({ error: "Could not check your access" });
  }
}

/** Refuses a caller below the required role. */
export function requireRole(required: MembershipRole) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.auth) return res.status(401).json({ error: "Sign in required" });
    if (!atLeast(req.auth.role, required)) {
      return res.status(403).json({ error: roleRequiredMessage(required) });
    }
    next();
  };
}

/**
 * Every request that changes something needs at least the editor role.
 *
 * Applied to the method rather than to a list of paths, so a route added
 * tomorrow is covered by default and a viewer-writable one has to be an
 * explicit, visible exception rather than an omission.
 */
export function requireEditorForWrites(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
  return requireRole("editor")(req, res, next);
}
