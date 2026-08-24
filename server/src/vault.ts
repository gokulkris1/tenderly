import type { EvidenceRecord } from "./types.js";

/**
 * How ready this company is to be asked for its paperwork.
 *
 * A company could not tell how ready it was to bid until a tender rejected it.
 * These are the document kinds Irish public tenders routinely demand, so the
 * gap between what the vault holds and what a buyer will ask for becomes a
 * number a user can act on before the deadline pressure starts.
 */

export type StandardKind = {
  /** Stable identifier, used for matching and for the wire. */
  id: string;
  label: string;
  /** Words that identify this kind in an item's name or kind field. */
  match: string[];
  /** Certificates expire; a policy statement does not. */
  expires: boolean;
};

export const STANDARD_KINDS: StandardKind[] = [
  { id: "tax-clearance", label: "Tax clearance certificate", match: ["tax clearance", "tax certificate"], expires: true },
  { id: "employers-liability", label: "Employers liability insurance", match: ["employers liability", "employer liability"], expires: true },
  { id: "public-liability", label: "Public liability insurance", match: ["public liability"], expires: true },
  { id: "professional-indemnity", label: "Professional indemnity insurance", match: ["professional indemnity"], expires: true },
  { id: "financial-statements", label: "Latest financial statements", match: ["financial statement", "annual accounts", "audited accounts"], expires: false },
  { id: "health-and-safety", label: "Health and safety statement", match: ["health and safety", "safety statement"], expires: false },
  { id: "quality-certification", label: "Quality certification", match: ["iso 9001", "quality certification", "quality management"], expires: true },
  { id: "insurance-schedule", label: "Insurance schedule", match: ["insurance schedule"], expires: true },
  { id: "espd", label: "ESPD declarations", match: ["espd", "self-declaration", "self declaration"], expires: false },
];

export type KindState = {
  id: string;
  label: string;
  /** "complete" counts; the rest are the reasons it does not. */
  status: "complete" | "expired" | "unverified" | "missing";
  /** The vault item that matched, when one did. */
  itemName?: string;
  expiresOn?: string;
};

export type VaultCompleteness = {
  complete: number;
  total: number;
  kinds: KindState[];
  missing: string[];
  expired: string[];
  awaitingVerification: string[];
};

/**
 * A date that has already passed. Unparseable and absent both count as "no
 * expiry known", which is not the same as expired — inventing an expiry would
 * mark a perfectly good certificate as lapsed.
 */
export function isExpired(value: string | undefined | null, now = new Date()) {
  const text = String(value ?? "").trim();
  if (!text) return false;
  const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(text);
  const irish = /(\d{1,2})[/.](\d{1,2})[/.](\d{4})/.exec(text);
  const date = iso
    ? new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])))
    : irish
      ? new Date(Date.UTC(Number(irish[3]), Number(irish[2]) - 1, Number(irish[1])))
      : null;
  if (!date || Number.isNaN(date.getTime())) return false;
  return date.getTime() < now.setHours(0, 0, 0, 0);
}

function matches(item: EvidenceRecord, kind: StandardKind) {
  const haystack = `${item.kind} ${item.name}`.toLowerCase();
  return kind.match.some((term) => haystack.includes(term));
}

/**
 * Measures the vault against the standard kinds.
 *
 * A kind counts only when it is present, in date and verified. The three ways
 * of falling short are reported separately, because "you have it but nobody
 * checked it" and "you never uploaded it" are different jobs for the user.
 */
export function vaultCompleteness(evidence: EvidenceRecord[], now = new Date()): VaultCompleteness {
  const kinds: KindState[] = STANDARD_KINDS.map((kind) => {
    const candidates = evidence.filter((item) => matches(item, kind));
    if (candidates.length === 0) return { id: kind.id, label: kind.label, status: "missing" };

    // Prefer an item that already counts, so one lapsed copy does not mask a
    // current one the company also holds.
    const usable = candidates.find((item) => item.verified && !isExpired(item.expiresOn, new Date(now)));
    if (usable) {
      return { id: kind.id, label: kind.label, status: "complete", itemName: usable.name, expiresOn: usable.expiresOn };
    }
    const expired = candidates.find((item) => isExpired(item.expiresOn, new Date(now)));
    if (expired) {
      return { id: kind.id, label: kind.label, status: "expired", itemName: expired.name, expiresOn: expired.expiresOn };
    }
    const unverified = candidates[0];
    return { id: kind.id, label: kind.label, status: "unverified", itemName: unverified.name, expiresOn: unverified.expiresOn };
  });

  return {
    complete: kinds.filter((kind) => kind.status === "complete").length,
    total: STANDARD_KINDS.length,
    kinds,
    missing: kinds.filter((kind) => kind.status === "missing").map((kind) => kind.label),
    expired: kinds.filter((kind) => kind.status === "expired").map((kind) => kind.label),
    awaitingVerification: kinds.filter((kind) => kind.status === "unverified").map((kind) => kind.label),
  };
}
