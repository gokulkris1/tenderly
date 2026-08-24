import { readFileSync } from "node:fs";
import path from "node:path";
import { splitCsvLine } from "./sources/ogp.js";

/**
 * CPV codes, normalised against the published CPV 2008 list.
 *
 * Codes reach us as free text from three sources in inconsistent forms:
 * `71314000-5`, `71314000`, or a description with no code at all. Preference
 * matching and award intelligence both need a canonical code plus its ancestor
 * chain, so that a company registered against a division still matches the
 * narrower children underneath it.
 *
 * The list is a committed data file rather than a fetch: CPV is a fixed
 * standard that changes only when the Commission amends the regulation.
 */

export type CpvCode = {
  /** Eight digits, leading zeros preserved. */
  code: string;
  /** The check digit that follows the hyphen in the official form. */
  checkDigit: string;
  description: string;
  /**
   * How specific the code is: 1 is a division (`45000000`), rising to 5 for the
   * most detailed categories. Derived from how many digits are significant.
   */
  level: number;
};

export type NormalisedCpv = CpvCode & {
  /** The string as it arrived, so an unrecognised value can still be shown. */
  raw: string;
  /** Existing broader codes, nearest first. Empty for a division. */
  ancestors: CpvCode[];
};

function loadCodes(): Map<string, CpvCode> {
  // Resolved from this module rather than the working directory: the server is
  // started from several places and the data must be found from all of them.
  const file = path.resolve(import.meta.dirname, "../data/cpv-2008.csv");
  const text = readFileSync(file, "utf8");
  const codes = new Map<string, CpvCode>();
  for (const line of text.split(/\r?\n/).slice(1)) {
    if (!line.trim()) continue;
    const [code, checkDigit, description] = splitCsvLine(line);
    if (!/^\d{8}$/.test(code ?? "")) continue;
    codes.set(code, { code, checkDigit: checkDigit ?? "", description: description ?? "", level: levelOf(code) });
  }
  return codes;
}

/**
 * Significant digits after the leading two decide the level: `45000000` is a
 * division, `45200000` a group, `45213000` a class, and so on.
 */
function levelOf(code: string) {
  const tail = code.slice(2).replace(/0+$/, "");
  return 1 + tail.length;
}

let cache: Map<string, CpvCode> | null = null;
function codes() {
  cache ??= loadCodes();
  return cache;
}

/** Every code in the published list, for seeding the lookup table. */
export function allCpvCodes(): CpvCode[] {
  return [...codes().values()];
}

/**
 * The eight-digit code inside a free-text value, or null when there is none.
 *
 * A description with no code, an empty cell and a malformed code all return
 * null. They are not errors — plenty of notices simply carry no CPV — so the
 * caller shows the raw string rather than failing the import.
 */
export function extractCpvCode(raw: string | undefined | null): string | null {
  if (!raw) return null;
  // Anchored on a digit boundary so a longer number is not silently truncated
  // to its first eight digits.
  const match = /(?<!\d)(\d{8})(?:-\d)?(?!\d)/.exec(String(raw));
  return match ? match[1] : null;
}

/**
 * Broader codes that actually exist in the published list, nearest first.
 *
 * The chain is built by zeroing one significant digit at a time and keeping
 * only the results the list contains: CPV is not uniformly populated, so a
 * blind prefix walk would invent codes that no notice can carry.
 */
export function cpvAncestors(code: string): CpvCode[] {
  const table = codes();
  const found: CpvCode[] = [];
  const significant = code.slice(2).replace(/0+$/, "");
  for (let keep = significant.length - 1; keep >= 0; keep -= 1) {
    const candidate = `${code.slice(0, 2)}${significant.slice(0, keep)}`.padEnd(8, "0");
    if (candidate === code) continue;
    const entry = table.get(candidate);
    if (entry) found.push(entry);
  }
  return found;
}

/**
 * Normalises a raw CPV value. Returns null when no code can be read, which the
 * caller reports as unrecognised rather than treating as a failure.
 */
export function normaliseCpv(raw: string | undefined | null): NormalisedCpv | null {
  const code = extractCpvCode(raw);
  if (!code) return null;
  const entry = codes().get(code);
  if (!entry) return null;
  return { ...entry, raw: String(raw), ancestors: cpvAncestors(code) };
}

/**
 * Every code at or below the given one, so a company registered against a
 * division matches the narrower children underneath it.
 */
export function cpvDescendants(code: string): CpvCode[] {
  const normalised = extractCpvCode(code);
  if (!normalised) return [];
  const prefix = normalised.slice(2).replace(/0+$/, "");
  const head = normalised.slice(0, 2);
  return allCpvCodes().filter((entry) => {
    if (entry.code === normalised) return false;
    if (!entry.code.startsWith(head)) return false;
    return entry.code.slice(2).replace(/0+$/, "").startsWith(prefix);
  });
}

/** How a normalised code is written for a person: `71314000 — Energy and related services`. */
export function cpvLabel(entry: Pick<CpvCode, "code" | "description">) {
  return `${entry.code} — ${entry.description}`;
}
