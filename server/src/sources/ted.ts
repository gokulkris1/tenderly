import type { PublicTender } from "../types.js";

/**
 * TED — Tenders Electronic Daily. Above-threshold Irish notices.
 *
 * The Search API needs no credential (verified in TLY-27): a key is only
 * required for endpoints that manipulate unpublished notices, which we never
 * touch. This is the second discovery source, so a redesign of the eTenders HTML
 * no longer takes discovery down entirely.
 */

export const TED_SEARCH_URL = "https://api.ted.europa.eu/v3/notices/search";

/** Irish notices under the IT-services division. */
export const IRISH_IT_QUERY = "(classification-cpv=72*) AND (place-of-performance=IRL)";

/** ISO 3166-1 alpha-3, the form TED's place-of-performance filter takes. */
function assertCountry(code: string) {
  const normalised = String(code).trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(normalised)) throw new Error(`Invalid TED country: ${code}`);
  return normalised;
}

/**
 * CPV prefixes in a set of markets. Any number of countries: the
 * place-of-performance filter ORs them, so a workspace watching Ireland and
 * Germany sees notices performed in either.
 */
export function cpvCountryQuery(codes: string[], countries: string[] = ["IRL"]) {
  const prefixes = [...new Set(codes.map((code) => {
    if (!/^\d{8}$/.test(code)) throw new Error(`Invalid TED CPV: ${code}`);
    return code.replace(/0+$/, "");
  }))];
  const markets = [...new Set((countries.length ? countries : ["IRL"]).map(assertCountry))];
  return `(${prefixes.map((prefix) => `classification-cpv=${prefix}*`).join(" OR ")}) AND (${markets.map((code) => `place-of-performance=${code}`).join(" OR ")})`;
}

/** Ireland-only form, kept as the wrapper existing callers and tests use. */
export function irishCpvQuery(codes: string[]) {
  return cpvCountryQuery(codes, ["IRL"]);
}

const FIELDS = [
  "publication-number", "notice-title", "buyer-name", "deadline-receipt-request",
  "classification-cpv", "publication-date", "procedure-type", "notice-type",
  "place-of-performance",
];

/**
 * TED returns language-keyed objects, and inconsistently: notice-title maps a
 * language to a string, buyer-name maps it to an array of strings. Treating
 * either as a plain string stores "[object Object]".
 */
export function pickLanguage(value: unknown, preferred = "eng"): string {
  if (typeof value === "string") return value.trim();
  if (Array.isArray(value)) return String(value[0] ?? "").trim();
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const chosen = record[preferred] ?? Object.values(record)[0];
    return pickLanguage(chosen, preferred);
  }
  return "";
}

/** CPV arrives as an array; the first entry is the main classification. */
export function mainCpv(value: unknown): string {
  const first = Array.isArray(value) ? value[0] : value;
  const digits = String(first ?? "").replace(/[^0-9]/g, "");
  return /^\d{8}$/.test(digits) ? digits : "";
}

export type TedNotice = Record<string, unknown>;

/**
 * The markets a TED notice is performed in, from its place-of-performance.
 *
 * Values arrive as ISO alpha-3 codes, a single string or an array of them.
 * A notice that names none is Ireland's as far as this deployment's default
 * query is concerned — that fallback is what keeps notices found by the old
 * Ireland-only query correctly labelled.
 */
export function noticeMarkets(notice: TedNotice): string[] {
  const raw = notice["place-of-performance"];
  const values = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw];
  const codes = [...new Set(values
    .flatMap((value) => pickLanguage(value).split(/[^A-Za-z]+/))
    .map((code) => code.toUpperCase())
    .filter((code) => /^[A-Z]{3}$/.test(code)))];
  return codes.length ? codes : ["IRL"];
}

export function noticeToPublicTender(notice: TedNotice): PublicTender | null {
  const externalId = pickLanguage(notice["publication-number"]);
  const title = pickLanguage(notice["notice-title"]);
  if (!externalId || !title) return null;
  const cpv = mainCpv(notice["classification-cpv"]);
  return {
    externalId,
    title,
    authority: pickLanguage(notice["buyer-name"]) || "Contracting authority",
    // The listing carries no description; the CPV is the closest honest summary,
    // and an empty string beats an invented one.
    description: cpv ? `CPV ${(Array.isArray(notice["classification-cpv"]) ? notice["classification-cpv"] : [cpv]).map(String).join(", ")}` : "",
    published: pickLanguage(notice["publication-date"]),
    deadline: pickLanguage(notice["deadline-receipt-request"]),
    procedure: pickLanguage(notice["procedure-type"]),
    status: "Published",
    estimatedValue: "",
    sourceUrl: `https://ted.europa.eu/en/notice/${encodeURIComponent(externalId)}/pdf`,
    markets: noticeMarkets(notice),
  };
}

export type TedFetchResult = {
  items: PublicTender[];
  received?: number;
  pageKey?: string;
  /** Notices that arrived but could not be mapped, and why. Never thrown. */
  warnings: string[];
};

export function mapNotices(notices: TedNotice[]): TedFetchResult {
  const items: PublicTender[] = [];
  const warnings: string[] = [];
  for (const notice of notices) {
    const mapped = noticeToPublicTender(notice);
    if (!mapped) {
      warnings.push("skipped a notice with no publication number or title");
      continue;
    }
    // A missing CPV is worth recording but is no reason to drop a real notice.
    if (!mainCpv(notice["classification-cpv"])) {
      warnings.push(`${mapped.externalId}: no usable CPV code`);
    }
    items.push(mapped);
  }
  return { items, warnings };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Searches TED. Honours 429 by waiting the interval the service asks for rather
 * than hammering it — this is a public service we do not own.
 */
export async function searchTed(options: {
  query?: string;
  limit?: number;
  page?: number;
  fetchImpl?: typeof fetch;
  maxRetries?: number;
  opportunitiesOnly?: boolean;
} = {}): Promise<TedFetchResult> {
  const doFetch = options.fetchImpl ?? fetch;
  const body = JSON.stringify({
    query: options.query ?? IRISH_IT_QUERY,
    fields: FIELDS,
    limit: Math.min(options.limit ?? 20, 100),
    page: options.page ?? 1,
  });

  const maxRetries = options.maxRetries ?? 2;
  for (let attempt = 0; ; attempt++) {
    const response = await doFetch(TED_SEARCH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body,
      signal: AbortSignal.timeout(20_000),
    });

    if (response.status === 429) {
      if (attempt >= maxRetries) {
        return { items: [], warnings: [`TED rate limit reached after ${attempt + 1} attempts; giving up this run`] };
      }

      const retryAfter = Number(response.headers.get("retry-after") ?? 2);
      await sleep(Math.max(1, retryAfter) * 1000);
      continue;
    }

    if (!response.ok) {
      return { items: [], warnings: [`TED search failed: HTTP ${response.status}`] };
    }

    const payload = (await response.json()) as { notices?: TedNotice[] };
    const notices = payload.notices ?? [];
    const result = mapNotices(options.opportunitiesOnly
      ? notices.filter((notice) => !/^(can-|veat|ex-ante|compl-|subco-)/i.test(pickLanguage(notice["notice-type"])))
      : notices);
    result.received = notices.length;
    result.pageKey = JSON.stringify(notices.map((notice) => notice["publication-number"] ?? notice));
    if (attempt > 0) result.warnings.push(`TED search succeeded after ${attempt} retry(ies)`);
    return result;
  }
}

/** Read the complete result set, not just the first forty notices. */
export async function searchAllTed(options: Parameters<typeof searchTed>[0] & { countries?: string[] } = {}): Promise<TedFetchResult> {
  const items = new Map<string, PublicTender>();
  const warnings: string[] = [];
  const pages = new Set<string>();
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
  // `countries` builds the default IT query for those markets; an explicit
  // query is taken as-is, so callers encoding their own markets keep control.
  const base = options.query
    ?? (options.countries ? `(classification-cpv=72*) AND (${options.countries.map(assertCountry).map((code) => `place-of-performance=${code}`).join(" OR ")})` : IRISH_IT_QUERY);
  const query = `(${base}) AND (deadline-receipt-request>=${date})`;
  for (let page = 1; page <= 1000; page += 1) {
    const result = await searchTed({ ...options, query, opportunitiesOnly: true, limit: 100, page });
    warnings.push(...result.warnings);
    if (result.pageKey && pages.has(result.pageKey)) throw new Error("TED repeated a results page; discovery is incomplete");
    if (result.pageKey) pages.add(result.pageKey);
    result.items.forEach((item) => items.set(item.externalId, item));
    if ((result.received ?? result.items.length) < 100) return { items: [...items.values()], warnings };
  }
  throw new Error("TED exceeded 1000 pages; discovery is incomplete");
}
