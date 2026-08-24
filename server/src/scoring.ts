import { cpvAncestors, extractCpvCode } from "./cpv.js";
import { presetBySlug } from "./sectors.js";
import type { CompanyProfile, DiscoveryPreferences, PublicTender } from "./types.js";

/**
 * Why a notice scored what it scored.
 *
 * The old score was a bare number from keyword token overlap: a user could not
 * tell why a notice scored 62, so they could neither trust it nor tune their
 * profile against it. Scoring is now a set of named contributions computed from
 * the preference profile and the company record.
 *
 * This is deliberately not an AI judgement. It is cheap, deterministic and
 * explainable, and the same inputs always give the same number — which is what
 * makes "remove that keyword and the score drops by exactly six" true.
 */

export type ScoreContribution = {
  /** Stable identifier for the kind of match, for filtering and tests. */
  kind: "cpv-exact" | "cpv-ancestor" | "sector" | "keyword" | "value-band" | "buyer-known";
  /** What a person reads: "CPV 71314000 matches your profile exactly". */
  label: string;
  points: number;
  /** The profile fact that matched, so the user knows what to change. */
  matched: string;
};

export type ScoreBreakdown = {
  total: number;
  contributions: ScoreContribution[];
  /** Shown instead of an empty list, so a zero is never unexplained. */
  note?: string;
};

/**
 * Weights, in one place so they can be read as a policy rather than reverse
 * engineered from arithmetic.
 *
 * An exact CPV match is the strongest single signal a public notice carries, so
 * it outweighs everything else. An ancestor match is real but weaker: the buyer
 * is in your field, not necessarily buying your thing. Keywords are the user's
 * own words and are trusted accordingly; value band and buyer history are
 * supporting evidence rather than reasons on their own.
 */
const WEIGHTS = {
  cpvExact: 45,
  cpvAncestor: 22,
  sector: 18,
  keyword: 12,
  valueBand: 8,
  buyerKnown: 10,
} as const;

/** The score is a percentage, and nothing may push it past a certainty we do not have. */
const CEILING = 95;

/** Matches a whole word, so "IT" does not match "with". */
function containsTerm(haystack: string, term: string) {
  if (!term) return false;
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`, "i").test(haystack);
}

/**
 * The euro figure in a value string.
 *
 * Thousands separators go first: "250,000.00" is a quarter of a million, and
 * splitting on the comma would read it as 250 — an error that would silently
 * push every large contract out of the user's stated range.
 */
export function parseContractValue(text: string | undefined | null) {
  if (!text) return null;
  const withoutSeparators = String(text).replace(/(\d),(?=\d{3}\b)/g, "$1");
  const figures = [...withoutSeparators.matchAll(/\d+(?:\.\d+)?/g)].map((match) => Number(match[0])).filter(Number.isFinite);
  return figures.length ? Math.max(...figures) : null;
}

/**
 * Scores one notice against one company's profile.
 *
 * Every contribution names the profile fact behind it. A notice matching
 * nothing scores zero with a note saying so, rather than a bare zero the user
 * cannot act on.
 */
export function scoreNotice(args: {
  tender: PublicTender & { cpvNormalised?: string };
  preferences: DiscoveryPreferences;
  company: CompanyProfile;
  /** Authorities this company has won from before, lower-cased. */
  knownBuyers?: string[];
}): ScoreBreakdown {
  const contributions: ScoreContribution[] = [];
  const haystack = `${args.tender.title} ${args.tender.description}`;

  const noticeCode = args.tender.cpvNormalised
    ?? extractCpvCode(String((args.tender as { metadata?: Record<string, unknown> }).metadata?.["CPV Codes"] ?? ""))
    ?? extractCpvCode(args.tender.description);

  // Profile codes come from the preferences, falling back to the company record
  // for an account that never opened the discovery settings.
  const profileCodes = [
    ...args.preferences.cpvCodes,
    ...args.preferences.sectors.flatMap((slug) => presetBySlug(slug)?.cpvCodes.map((entry) => entry.code) ?? []),
    ...String(args.company.cpv ?? "").split(/[^0-9]+/).filter((value) => value.length === 8),
  ].map((code) => extractCpvCode(code)).filter((code): code is string => Boolean(code));
  const uniqueProfileCodes = [...new Set(profileCodes)];

  if (noticeCode && uniqueProfileCodes.includes(noticeCode)) {
    contributions.push({
      kind: "cpv-exact", points: WEIGHTS.cpvExact,
      label: `CPV ${noticeCode} matches your profile exactly`, matched: noticeCode,
    });
  } else if (noticeCode) {
    // The notice sits under a code the company registered, or the company's
    // code sits under the notice's: either way the buyer is in your field.
    const noticeChain = cpvAncestors(noticeCode).map((entry) => entry.code);
    const related = uniqueProfileCodes.find((code) =>
      noticeChain.includes(code) || cpvAncestors(code).map((entry) => entry.code).includes(noticeCode));
    if (related) {
      contributions.push({
        kind: "cpv-ancestor", points: WEIGHTS.cpvAncestor,
        label: `CPV ${noticeCode} is related to your ${related}`, matched: related,
      });
    }
  }

  for (const slug of args.preferences.sectors) {
    const preset = presetBySlug(slug);
    if (!preset) continue;
    const hit = preset.keywords.find((keyword) => containsTerm(haystack, keyword));
    if (!hit) continue;
    contributions.push({
      kind: "sector", points: WEIGHTS.sector,
      label: `Matches your ${preset.label} sector`, matched: hit,
    });
    break;  // One sector contribution: a notice is not twice as relevant for matching two.
  }

  for (const keyword of args.preferences.keywords) {
    const needle = keyword.trim();
    if (!needle || !containsTerm(haystack, needle)) continue;
    contributions.push({
      kind: "keyword", points: WEIGHTS.keyword,
      label: `Your keyword "${needle}" appears in the notice`, matched: needle,
    });
  }

  const value = parseContractValue(args.tender.estimatedValue);
  const { valueMin, valueMax } = args.preferences;
  if (value !== null && (valueMin !== null || valueMax !== null)) {
    const aboveFloor = valueMin === null || value >= valueMin;
    const belowCeiling = valueMax === null || value <= valueMax;
    if (aboveFloor && belowCeiling) {
      contributions.push({
        kind: "value-band", points: WEIGHTS.valueBand,
        label: "Contract value is inside the range you set", matched: args.tender.estimatedValue,
      });
    }
  }

  const authority = args.tender.authority?.toLowerCase().trim();
  if (authority && (args.knownBuyers ?? []).includes(authority)) {
    contributions.push({
      kind: "buyer-known", points: WEIGHTS.buyerKnown,
      label: `You have won work from ${args.tender.authority} before`, matched: args.tender.authority,
    });
  }

  const total = Math.min(CEILING, contributions.reduce((sum, item) => sum + item.points, 0));
  return contributions.length
    ? { total, contributions }
    : { total: 0, contributions: [], note: "No profile facts matched" };
}
