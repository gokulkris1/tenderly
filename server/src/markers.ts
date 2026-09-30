/**
 * The `[INPUT NEEDED: …]` placeholder.
 *
 * This is the product's central promise made visible: where a fact is not known,
 * the answer says so in the buyer's own document rather than inventing a figure.
 * Because it is a promise, its exact shape is a contract — the drafting prompt
 * asks for it, the refine path must carry it forward, the answer status depends
 * on it, and the final pack must refuse to ship it.
 *
 * It lives in its own module because that list of callers spans the model layer,
 * the data layer and the pack builder, and the regex had already been written
 * out three separate times. One of those copies was a bare `includes()` in a
 * route, which is how the check came to exist in the advisory red-team endpoint
 * and nowhere near the gate that actually blocks a submission.
 *
 * Deliberately dependency-free, so anything can import it without dragging the
 * database or the model client along.
 */

/** Matches a placeholder and captures the subject it names. */
const MARKER = /\[INPUT NEEDED:\s*([^\]]+)\]/gi;

/** Writes a placeholder for a fact nobody has supplied. */
export function marker(subject: string) {
  return `[INPUT NEEDED: ${subject}]`;
}

/** The `[INPUT NEEDED: …]` subjects named in a piece of prose. */
export function markersIn(text: string) {
  // A fresh matcher each call: a module-level /g regex carries lastIndex
  // between calls and silently skips matches on the second one.
  return [...String(text ?? "").matchAll(new RegExp(MARKER))].map((match) => match[1].trim());
}

/** True when the prose still carries an unresolved placeholder. */
export function hasMarker(text: string) {
  return markersIn(text).length > 0;
}
