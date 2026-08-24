import { membershipFor } from "./db.js";

/**
 * Who may export or erase an organisation's account, and on what terms.
 *
 * Export and deletion are the two operations that move or destroy everything at
 * once, so they are the two that are not merely "signed in" operations. They are
 * the owner's, they require the owner to type a phrase rather than click a
 * button, and the deletion waits before it happens.
 */

/**
 * How long a scheduled deletion waits before it runs.
 *
 * Long enough that a person who clicked in anger, or whose colleague clicked
 * without telling them, has a working week to notice.
 */
export const GRACE_DAYS = 7;

/** The phrase the owner must type. Deliberately not "yes" and not the org name. */
export const CONFIRMATION_PHRASE = "DELETE MY ACCOUNT";

/**
 * Whether this person owns this organisation.
 *
 * Read from the membership row rather than from the token's role claim: a token
 * minted before somebody was demoted would otherwise still carry `owner` for
 * the rest of its twelve hours, and these are the two operations where that
 * matters most.
 */
export async function isOwner(accountId: string, actingUserId: string) {
  const membership = await membershipFor(accountId, actingUserId);
  return membership?.role === "owner";
}

/** True when the typed text is the confirmation phrase. Case and padding are forgiven; wording is not. */
export function confirmsDeletion(typed: unknown) {
  return typeof typed === "string" && typed.trim().toUpperCase() === CONFIRMATION_PHRASE;
}

/** When a deletion requested now would run. */
export function scheduledFor(now = new Date()) {
  return new Date(now.getTime() + GRACE_DAYS * 86_400_000);
}

/** Whole days left before a scheduled deletion runs; never negative. */
export function daysRemaining(scheduled: string, now = new Date()) {
  const due = new Date(scheduled).getTime();
  if (Number.isNaN(due)) return 0;
  return Math.max(0, Math.ceil((due - now.getTime()) / 86_400_000));
}
