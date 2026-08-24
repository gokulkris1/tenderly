import type { PublicTender } from "./types.js";

/**
 * One opportunity, one row — however many portals published it.
 *
 * Above-threshold Irish notices appear on both eTenders and TED. Without a
 * cross-source identity the Discover list showed the same opportunity twice,
 * and a user could open two bid records for one tender.
 *
 * The existing uniqueness is `(account_id, source, external_id)`, which is by
 * construction per-source. The canonical key is what makes two rows from
 * different portals recognisable as the same thing.
 */

export type MergeReason = "reference" | "heuristic";

export type AlternateSource = {
  /** "eTenders" or "TED". */
  label: string;
  url: string;
  externalId: string;
};

export type MergedNotice = PublicTender & {
  canonicalKey: string;
  mergeReason?: MergeReason;
  /** The other portals that published the same notice. Empty when unique. */
  alternateSources: AlternateSource[];
};

/**
 * An OJEU/TED reference in any of the forms the two portals use:
 * `2026/S 123-456789` on eTenders, `456789-2026` on TED.
 *
 * Both are reduced to the same digits so they compare equal. Returns null when
 * no reference is present, which is the normal case below threshold.
 */
export function normaliseOjeuReference(value: string | undefined | null): string | null {
  if (!value) return null;
  const text = String(value);

  // Classic OJEU: 2026/S 123-456789 — the notice number is the last group.
  const classic = /(\d{4})\/S\s*(\d{1,3})\s*-\s*(\d{4,7})/i.exec(text);
  if (classic) return `ojeu:${classic[3].padStart(6, "0")}-${classic[1]}`;

  // TED publication number: 456789-2026.
  const ted = /(?<!\d)(\d{4,7})-(\d{4})(?!\d)/.exec(text);
  if (ted && Number(ted[2]) >= 2000 && Number(ted[2]) <= 2100) {
    return `ojeu:${ted[1].padStart(6, "0")}-${ted[2]}`;
  }
  return null;
}

/** Collapses spacing, punctuation and case so two spellings of one title match. */
function flatten(value: string | undefined | null) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * A calendar date as `YYYYMMDD`, from either portal's spelling.
 *
 * eTenders writes `27/08/2026 12:00:00` and TED writes `2026-08-27`; reducing
 * both to their leading digits would give `27082026` and `20260827`, which
 * compare unequal and would leave every duplicate unmerged. Times are dropped
 * deliberately: the portals disagree about them routinely and a minute is not a
 * different competition.
 *
 * An unparseable value returns an empty string, which makes the triple weaker
 * rather than wrong — two notices with no readable deadline still need matching
 * buyer and title to merge.
 */
function flattenDate(value: string | undefined | null) {
  const text = String(value ?? "").trim();
  const iso = /(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (iso) return `${iso[1]}${iso[2]}${iso[3]}`;
  const irish = /(\d{1,2})[/.](\d{1,2})[/.](\d{4})/.exec(text);
  if (irish) return `${irish[3]}${irish[2].padStart(2, "0")}${irish[1].padStart(2, "0")}`;
  return "";
}

/**
 * The identity of an opportunity across portals.
 *
 * A shared OJEU reference is definitive. Without one, a normalised
 * (buyer, title, deadline) triple is the best available signal — deliberately
 * strict, because merging two genuinely different notices is a worse failure
 * than showing one twice.
 */
export function canonicalKey(notice: PublicTender & { metadata?: Record<string, unknown> }): { key: string; reason: MergeReason } {
  const candidates = [
    notice.externalId,
    String(notice.metadata?.["TED links for published notices"] ?? ""),
    String(notice.metadata?.["ojeuReference"] ?? ""),
    notice.sourceUrl,
  ];
  for (const candidate of candidates) {
    const reference = normaliseOjeuReference(candidate);
    if (reference) return { key: reference, reason: "reference" };
  }
  return {
    key: `heuristic:${flatten(notice.authority)}|${flatten(notice.title)}|${flattenDate(notice.deadline)}`,
    reason: "heuristic",
  };
}

/** How much a record actually tells you — used to pick which of two to keep. */
function richness(notice: PublicTender) {
  const fields = [notice.description, notice.estimatedValue, notice.procedure, notice.published, notice.deadline];
  return fields.filter((value) => String(value ?? "").trim().length > 0).length;
}

/**
 * Merges notices that are the same opportunity.
 *
 * The richer record wins — eTenders carries a description and a value where TED
 * carries little — and the other is kept as a linked alternate source rather
 * than discarded, so both portal links stay available to the user.
 *
 * Order is preserved: the first appearance of an opportunity keeps its place in
 * the list, so merging does not reshuffle a list the user is reading.
 */
export function mergeNotices(
  entries: { notice: PublicTender & { metadata?: Record<string, unknown> }; label: string }[],
): MergedNotice[] {
  const byKey = new Map<string, MergedNotice>();
  const order: string[] = [];

  for (const entry of entries) {
    const { key, reason } = canonicalKey(entry.notice);
    const alternate: AlternateSource = { label: entry.label, url: entry.notice.sourceUrl, externalId: entry.notice.externalId };
    const existing = byKey.get(key);

    if (!existing) {
      byKey.set(key, { ...entry.notice, canonicalKey: key, alternateSources: [alternate] });
      order.push(key);
      continue;
    }

    // Two portals for one opportunity: keep the richer body, keep both links,
    // and record why they were treated as the same thing.
    const winner = richness(entry.notice) > richness(existing) ? entry.notice : existing;
    byKey.set(key, {
      ...winner,
      canonicalKey: key,
      mergeReason: reason,
      alternateSources: [...existing.alternateSources, alternate],
    });
  }

  return order.map((key) => byKey.get(key)!);
}
