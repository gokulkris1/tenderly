import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Inviting a colleague.
 *
 * The link is the credential: whoever holds it becomes a member of somebody's
 * bid workspace. So the token is long, random, single-use, time-limited, and
 * stored only as a hash — the plain token exists in exactly one place, the
 * email that was sent.
 */

/** Seven days. Long enough for a holiday, short enough that a stale inbox is not a way in. */
export const INVITATION_DAYS = 7;

export type InvitationProblem =
  | "already-accepted"
  | "expired"
  | "revoked"
  | "unknown";

/**
 * What the invited person is told, and nothing more.
 *
 * A link that never existed and a link that was revoked get the same words on
 * purpose: an outsider guessing tokens learns nothing from the difference.
 */
export const INVITATION_MESSAGES: Record<InvitationProblem, string> = {
  "already-accepted": "This invitation has already been accepted",
  expired: "This invitation has expired",
  revoked: "This invitation is no longer valid",
  unknown: "This invitation is no longer valid",
};

export const ALREADY_A_MEMBER = "That person is already a member";

/** A fresh token and the hash to store beside it. */
export function newInvitationToken() {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashInvitationToken(token) };
}

export function hashInvitationToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

/** Constant-time comparison, so a token cannot be recovered a byte at a time. */
export function tokenHashMatches(a: string, b: string) {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

export function invitationExpiry(now = new Date()) {
  return new Date(now.getTime() + INVITATION_DAYS * 86_400_000);
}

/**
 * Whether this invitation can still be used, and why not when it cannot.
 *
 * Accepted is checked before expired: somebody who used their link on day two
 * and comes back on day nine should be told it was accepted, not that it
 * lapsed, because the first is true and actionable and the second is not.
 */
export function invitationProblem(
  invitation: { acceptedAt?: string; revokedAt?: string; expiresAt: string } | null,
  now = new Date(),
): InvitationProblem | null {
  if (!invitation) return "unknown";
  if (invitation.acceptedAt) return "already-accepted";
  if (invitation.revokedAt) return "revoked";
  if (new Date(invitation.expiresAt).getTime() <= now.getTime()) return "expired";
  return null;
}

/** The link that goes in the email. */
export function invitationLink(token: string, appUrl = process.env.APP_URL) {
  const base = (appUrl || "https://gettenderly.netlify.app").replace(/\/+$/, "");
  return `${base}/invite/${token}`;
}

const ROLE_PHRASE: Record<string, string> = {
  owner: "an owner", editor: "an editor", viewer: "a viewer",
};

/** The email itself, in the plainest words that still say what to do. */
export function invitationEmail(input: { organisation: string; invitedBy: string; role: string; link: string }) {
  const subject = `${input.organisation} has invited you to Tenderly`;
  const text = [
    `${input.invitedBy} has invited you to join ${input.organisation} on Tenderly as ${
      ROLE_PHRASE[input.role] ?? `a ${input.role}`}.`,
    "",
    "Open this link to set your password and join:",
    input.link,
    "",
    `The link works once and expires in ${INVITATION_DAYS} days.`,
    "If you were not expecting this, ignore it — nothing happens until you open the link.",
  ].join("\n");
  return { subject, text };
}
