import type { ProvenanceClass, ProvenanceEntry } from "./types.js";

/**
 * How a response section came to exist.
 *
 * The classes are ordered by how much of the text a machine produced:
 * `human` (none), `ai-assisted` (generated then edited by a person), and
 * `ai-generated` (as the model wrote it). A buyer asking the question deserves
 * the honest answer, so the class is derived from the ledger rather than set by
 * whoever happens to save last.
 */

/**
 * The class to record when a person saves an answer by hand.
 *
 * Editing text a model produced does not erase that it was produced by a model,
 * so any prior AI entry makes the result `ai-assisted`. An answer with no AI
 * history is simply `human`.
 */
export function classForHumanEdit(history: ProvenanceEntry[]): ProvenanceClass {
  return history.some((entry) => entry.class !== "human") ? "ai-assisted" : "human";
}

/**
 * The badge shown against an answer: the class of its most recent entry, or
 * undefined when nothing has been recorded — an answer with no ledger makes no
 * claim about itself.
 */
export function badgeFor(history: ProvenanceEntry[]): ProvenanceEntry | undefined {
  if (history.length === 0) return undefined;
  return [...history].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[history.length - 1];
}

/** Counts by class, for the pre-pack attestation and the provenance summary. */
export function summarise(entries: ProvenanceEntry[]) {
  const byAnswer = new Map<string, ProvenanceEntry[]>();
  for (const entry of entries) {
    const list = byAnswer.get(entry.answerId) ?? [];
    list.push(entry);
    byAnswer.set(entry.answerId, list);
  }
  const counts: Record<ProvenanceClass, number> = { "ai-generated": 0, "ai-assisted": 0, human: 0 };
  const aiGenerated: string[] = [];
  for (const [answerId, history] of byAnswer) {
    const badge = badgeFor(history);
    if (!badge) continue;
    counts[badge.class] += 1;
    if (badge.class === "ai-generated") aiGenerated.push(answerId);
  }
  return { counts, aiGenerated };
}
