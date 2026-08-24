import type { ProvenanceClass } from "./types.js";

/**
 * Every saved state of an answer, and how to compare two of them.
 *
 * Answers were overwritten in place, so a reviewer who rewrote a section could
 * not compare it with the drafted original, and an accidental overwrite of an
 * approved answer was unrecoverable the moment the page was saved.
 *
 * Restoring writes a new version rather than rewinding. History that can be
 * rewritten is not history, and the provenance ledger it sits beside is
 * append-only for the same reason.
 */

export type AnswerVersion = {
  id: string;
  answerId: string;
  response: string;
  status: string;
  /** The class this text was saved under, not the class of the restoring. */
  provenanceClass: ProvenanceClass;
  actor: string;
  /** Set when this version was produced by restoring an earlier one. */
  restoredFrom?: string;
  /**
   * The steering instruction that produced this version, when one did.
   *
   * "Shorten to 150 words" is why this version differs from the one before it,
   * and a history showing four timestamps and no reasons is one nobody reads.
   */
  steering?: string;
  createdAt: string;
};

export type DiffSegment = {
  kind: "same" | "added" | "removed";
  text: string;
};

/** Words, keeping the whitespace attached so a rebuild is faithful. */
function tokenise(text: string) {
  return text.match(/\S+\s*/g) ?? [];
}

/**
 * A word-level diff between two versions.
 *
 * Longest-common-subsequence rather than line-based: bid answers are prose, and
 * a line diff of a reflowed paragraph reports the whole thing as changed, which
 * tells a reviewer nothing.
 */
export function diffVersions(before: string, after: string): DiffSegment[] {
  const a = tokenise(before);
  const b = tokenise(after);

  // Standard LCS table. Answers are capped at a few thousand words, so the
  // quadratic table is comfortably small.
  const lengths: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lengths[i][j] = a[i] === b[j] ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }

  const segments: DiffSegment[] = [];
  const push = (kind: DiffSegment["kind"], text: string) => {
    const last = segments[segments.length - 1];
    if (last && last.kind === kind) last.text += text;
    else segments.push({ kind, text });
  };

  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { push("same", a[i]); i += 1; j += 1; }
    else if (lengths[i + 1][j] >= lengths[i][j + 1]) { push("removed", a[i]); i += 1; }
    else { push("added", b[j]); j += 1; }
  }
  while (i < a.length) { push("removed", a[i]); i += 1; }
  while (j < b.length) { push("added", b[j]); j += 1; }

  return segments;
}

/** Whether anything actually changed between two versions. */
export function hasChanges(segments: DiffSegment[]) {
  return segments.some((segment) => segment.kind !== "same");
}
