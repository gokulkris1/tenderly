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

const FIELDS = [
  "publication-number", "notice-title", "buyer-name", "deadline-receipt-request",
  "classification-cpv", "publication-date", "procedure-type", "notice-type",
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
    description: cpv ? `CPV ${cpv}` : "",
    published: pickLanguage(notice["publication-date"]),
    deadline: pickLanguage(notice["deadline-receipt-request"]),
    procedure: pickLanguage(notice["procedure-type"]),
    status: "Published",
    estimatedValue: "",
    sourceUrl: `https://ted.europa.eu/en/notice/${encodeURIComponent(externalId)}/pdf`,
  };
}

export type TedFetchResult = {
  items: PublicTender[];
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
    const result = mapNotices(payload.notices ?? []);
    if (attempt > 0) result.warnings.push(`TED search succeeded after ${attempt} retry(ies)`);
    return result;
  }
}
