import { getUserById } from "./db.js";

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

export type AccountRole = "owner" | "editor";

/**
 * The acting user's role on this account.
 *
 * Today an account has exactly one sign-in — the address it was registered
 * with — so anyone else holding a token for it is an invited collaborator and
 * not the owner. When invitations land (TLY-88) this reads the membership row
 * instead; every caller already asks the question the right way round, so the
 * routes below do not change when it does.
 */
export async function roleFor(accountId: string, email: string): Promise<AccountRole> {
  const user = await getUserById(accountId);
  const registered = String(user?.email ?? "").trim().toLowerCase();
  return registered && registered === email.trim().toLowerCase() ? "owner" : "editor";
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
