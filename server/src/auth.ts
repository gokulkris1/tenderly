import type { NextFunction, Request, Response } from "express";
import jwt from "jsonwebtoken";

const configuredSecret = process.env.JWT_SECRET?.trim();
const secret = configuredSecret || "tenderly-development-only-secret-change-me";

if (process.env.NODE_ENV === "production" && (!configuredSecret || configuredSecret.length < 32)) {
  throw new Error("JWT_SECRET must be set to at least 32 characters in production");
}

export type AuthenticatedRequest = Request & { auth?: { accountId: string; email: string } };

export function signToken(user: { id: string; email: string }) {
  return jwt.sign({ sub: user.id, email: user.email }, secret, { expiresIn: "12h", issuer: "tenderly-api", audience: "tenderly-web" });
}

export function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Bearer ")) return res.status(401).json({ error: "Sign in required" });
  try {
    const payload = jwt.verify(header.slice(7), secret, { issuer: "tenderly-api", audience: "tenderly-web" }) as jwt.JwtPayload;
    if (!payload.sub || typeof payload.email !== "string") return res.status(401).json({ error: "Invalid session" });
    req.auth = { accountId: payload.sub, email: payload.email };
    next();
  } catch {
    return res.status(401).json({ error: "Session expired or invalid" });
  }
}

export function accountId(req: AuthenticatedRequest) {
  if (!req.auth?.accountId) throw new Error("AUTH_REQUIRED");
  return req.auth.accountId;
}
