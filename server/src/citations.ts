import { isExpired } from "./vault.js";
import type { EvidenceRecord } from "./types.js";

/**
 * Which vault items a drafted answer is allowed to cite.
 *
 * A citation has to point at something a buyer could be shown. Two things
 * therefore disqualify an item: nobody verified it, and it has expired. An
 * expired certificate is not weaker evidence — it is evidence of the opposite,
 * and citing it would put a lapsed credential in front of an evaluator.
 *
 * Excluding an item is not silent. The reason is returned, so the drafting
 * payload can tell the model that a document exists but cannot be used, and the
 * answer says [INPUT NEEDED: …] instead of making an uncited claim.
 */

export type CitableEvidence = {
  /** Stable identifier the answer's citation records. */
  id: string;
  name: string;
  kind: string;
  /** The extracted text the model may quote from. */
  content: string;
  /** True when an original file exists, so the citation can be opened. */
  hasFile: boolean;
  expiresOn?: string;
};

export type ExcludedEvidence = {
  id: string;
  name: string;
  reason: "unverified" | "expired";
};

export function partitionEvidence(evidence: EvidenceRecord[], now = new Date()): {
  citable: CitableEvidence[];
  excluded: ExcludedEvidence[];
} {
  const citable: CitableEvidence[] = [];
  const excluded: ExcludedEvidence[] = [];

  for (const item of evidence) {
    if (!item.verified) {
      excluded.push({ id: item.id, name: item.name, reason: "unverified" });
      continue;
    }
    if (isExpired(item.expiresOn, new Date(now))) {
      excluded.push({ id: item.id, name: item.name, reason: "expired" });
      continue;
    }
    citable.push({
      id: item.id,
      name: item.name,
      kind: item.kind,
      content: item.content,
      hasFile: Boolean(item.filename),
      expiresOn: item.expiresOn,
    });
  }
  return { citable, excluded };
}

/**
 * What the model is told about the items it may not use.
 *
 * Naming them matters: "you hold an ISO 9001 certificate but it expired in
 * March" is what produces a useful [INPUT NEEDED], where silence produces a
 * confident answer with nothing behind it.
 */
export function exclusionNotes(excluded: ExcludedEvidence[]) {
  return excluded.map((item) => ({
    name: item.name,
    note: item.reason === "expired"
      ? "Held but expired — cannot be cited, and any claim resting on it needs [INPUT NEEDED: current version]"
      : "Held but not verified — cannot be cited until a person verifies it",
  }));
}

/**
 * Resolves the names the model returned in evidenceUsed back to vault items.
 *
 * The model answers with names because that is what it was shown; the citation
 * has to carry the identifier so the UI can open the actual document. A name
 * that matches nothing citable is dropped rather than recorded as a citation
 * pointing nowhere.
 */
export function resolveCitations(evidenceUsed: string[], citable: CitableEvidence[]) {
  const byName = new Map(citable.map((item) => [item.name.toLowerCase().trim(), item]));
  const resolved: { id: string; name: string; hasFile: boolean }[] = [];
  for (const used of evidenceUsed) {
    const item = byName.get(used.toLowerCase().trim())
      ?? citable.find((candidate) => candidate.name.toLowerCase().includes(used.toLowerCase().trim()));
    if (!item) continue;
    if (resolved.some((entry) => entry.id === item.id)) continue;
    resolved.push({ id: item.id, name: item.name, hasFile: item.hasFile });
  }
  return resolved;
}
