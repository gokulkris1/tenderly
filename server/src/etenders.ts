import * as cheerio from "cheerio";
import type { PublicTender } from "./types.js";

const ETENDERS_HOSTS = new Set(["www.etenders.gov.ie", "etenders.gov.ie"]);
const ALLOWED_PROCUREMENT_HOSTS = ETENDERS_HOSTS;
const START_URL = "https://www.etenders.gov.ie/epps/quickSearchAction.do?searchType=cftFTS";
const USER_AGENT = "TenderlyBidAssistant/0.1 (+public tender discovery; low-rate crawler)";
const MAX_HTML_BYTES = 6 * 1024 * 1024;
const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;

export function assertSafeProcurementUrl(input: string) {
  let url: URL;
  try { url = new URL(input); } catch { throw new Error("Enter a valid eTenders URL"); }
  if (url.protocol !== "https:") throw new Error("Only HTTPS procurement links are accepted");
  if (!ALLOWED_PROCUREMENT_HOSTS.has(url.hostname.toLowerCase())) throw new Error("Tender import is restricted to official etenders.gov.ie links");
  if (url.username || url.password) throw new Error("Credential-bearing URLs are not accepted");
  return url;
}

async function fetchBuffer(url: string, maxBytes: number) {
  assertSafeProcurementUrl(url);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 18_000);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml,application/pdf,application/octet-stream;q=0.8,*/*;q=0.5" },
    });
    if (!response.ok) throw new Error(`eTenders returned HTTP ${response.status}`);
    const finalUrl = assertSafeProcurementUrl(response.url || url);
    if (!ALLOWED_PROCUREMENT_HOSTS.has(finalUrl.hostname.toLowerCase())) throw new Error("Unexpected redirect while importing tender");
    const length = Number(response.headers.get("content-length") || 0);
    if (length && length > maxBytes) throw new Error("Remote file is too large for automatic import");
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > maxBytes) throw new Error("Remote file is too large for automatic import");
    return { bytes, headers: response.headers, url: finalUrl.toString(), contentType: response.headers.get("content-type") ?? "" };
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchHtml(url: string) {
  const result = await fetchBuffer(url, MAX_HTML_BYTES);
  return { html: result.bytes.toString("utf8"), url: result.url };
}

function clean(value: string) {
  return value.replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function safeAbsoluteHref(href: string | undefined, base: string) {
  if (!href || /^javascript:/i.test(href)) return "";
  try {
    const url = new URL(href, base);
    if (!ETENDERS_HOSTS.has(url.hostname.toLowerCase()) || url.protocol !== "https:") return "";
    return url.toString();
  } catch { return ""; }
}

/** The listing publishes "dd/mm/yyyy hh:mm:ss". Returns null when it publishes nothing readable. */
function publishedAt(value: string): number | null {
  const match = String(value ?? "").match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if (!match) return null;
  const time = Date.UTC(Number(match[3]), Number(match[2]) - 1, Number(match[1]));
  return Number.isNaN(time) ? null : time;
}

export function parseSearchHtml(html: string, baseUrl = START_URL): { items: PublicTender[]; nextUrl: string } {
  const $ = cheerio.load(html);
  const items: PublicTender[] = [];
  $("table tr").each((_index, row) => {
    const cells = $(row).find("td");
    if (cells.length < 9) return;
    const externalId = clean($(cells[2]).text());
    if (!/^\d{5,}$/.test(externalId)) return;
    const titleCell = $(cells[1]);
    const title = clean(titleCell.text());
    if (!title) return;
    const link = safeAbsoluteHref(titleCell.find("a").first().attr("href"), baseUrl);
    items.push({
      externalId,
      title,
      authority: clean($(cells[3]).text()),
      description: clean($(cells[4]).text()),
      published: clean($(cells[5]).text()),
      deadline: clean($(cells[6]).text()),
      procedure: clean($(cells[7]).text()),
      status: clean($(cells[8]).text()),
      estimatedValue: cells.length > 11 ? clean($(cells[11]).text()) : "",
      sourceUrl: link || `https://www.etenders.gov.ie/epps/cft/prepareViewCfTWS.do?resourceId=${encodeURIComponent(externalId)}`,
    });
  });

  // eTenders renders "Next" as a <button> carrying an href attribute, driven by
  // an inline onclick — not as a link. Scanning only anchors found nothing, so
  // paging silently stopped after page one and the run saw ten notices out of
  // twenty-one thousand. Both shapes are accepted now, and a disabled control
  // is ignored so the last page reports no next rather than looping on itself.
  let nextUrl = "";
  $("a, button").each((_index, node) => {
    if (nextUrl) return;
    const element = $(node);
    if (element.attr("disabled") !== undefined) return;
    const label = clean(element.text()).toLowerCase();
    const title = clean(element.attr("title") || "").toLowerCase();
    const rel = clean(element.attr("rel") || "").toLowerCase();
    const id = clean(element.attr("id") || "").toLowerCase();
    if (label === "next" || label === ">" || title === "next" || rel === "next" || id === "nextnav") {
      nextUrl = safeAbsoluteHref(element.attr("href"), baseUrl);
    }
  });
  return { items, nextUrl };
}

/**
 * How far back a run reads before it stops paging.
 *
 * eTenders holds 21,695 notices across 2,170 pages, so "read everything" is not
 * a strategy. The listing is ordered newest first, so a run that stops once it
 * reaches notices older than it cares about reads a few pages on an ordinary
 * day and still cannot miss one — where a fixed page count silently truncates
 * the moment a busy day publishes more than it allows for.
 */
const DEFAULT_SINCE_DAYS = 3;

export async function discoverETenders(
  query = "",
  options: { maxPages?: number; delayMs?: number; sinceDays?: number } = {},
) {
  // The backstop is generous rather than tight: it exists to stop a runaway
  // crawl, not to decide how much gets read. The date is what decides that.
  const maxPages = Math.max(1, Math.min(options.maxPages ?? Number(process.env.ETENDERS_MAX_PAGES || 40), 200));
  const delayMs = Math.max(200, Number(options.delayMs ?? process.env.ETENDERS_REQUEST_DELAY_MS ?? 850));
  const sinceDays = Math.max(1, options.sinceDays ?? Number(process.env.ETENDERS_SINCE_DAYS || DEFAULT_SINCE_DAYS));
  const cutoff = Date.now() - sinceDays * 86_400_000;

  const discovered = new Map<string, PublicTender>();
  let url = START_URL;
  let reachedCutoff = false;
  for (let page = 0; page < maxPages && url && !reachedCutoff; page += 1) {
    const { html, url: fetchedUrl } = await fetchHtml(url);
    const parsed = parseSearchHtml(html, fetchedUrl);
    parsed.items.forEach((item) => discovered.set(item.externalId, item));
    // A page whose every notice predates the cutoff is the end of what this run
    // wants. A page with no readable dates is not evidence of anything, so it
    // does not stop the crawl.
    const dates = parsed.items.map((item) => publishedAt(item.published)).filter((value): value is number => value !== null);
    if (dates.length && dates.every((value) => value < cutoff)) reachedCutoff = true;
    url = parsed.nextUrl;
    if (url && !reachedCutoff && page + 1 < maxPages) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  const needle = query.trim().toLowerCase();
  const items = [...discovered.values()];
  if (!needle) return items;
  return items.filter((item) => `${item.title} ${item.authority} ${item.description} ${item.procedure}`.toLowerCase().includes(needle));
}

function extractResourceId(url: URL, html = "") {
  const direct = url.searchParams.get("resourceId") || url.searchParams.get("resourceID") || url.searchParams.get("id");
  if (direct && /^\d{5,}$/.test(direct)) return direct;
  const match = html.match(/(?:resourceId|resourceID)[=:'"\s]+(\d{5,})/i);
  if (match) return match[1];
  throw new Error("Could not identify the eTenders resource ID from this link");
}

const FIELD_LABELS = [
  "Name of Contracting Authority", "Publish on behalf of", "Title", "CfT CA Unique ID", "Evaluation Mechanism", "Description", "Procurement Type", "Directive", "Procedure", "CfT Involves", "Framework agreement Timeframe", "CPV Codes", "Contact Point", "Award per Item", "Inclusion of e-Auctions", "NUTS codes", "Estimated value (EUR)", "Awarded (CAN) value", "Above or Below threshold", "Time-limit for receipt of tenders or requests to participate", "Deadline for dispatching invitations", "End of clarification period", "Tenders Opening Date", "Allow suppliers to make an online Expression Of Interest", "Contract awarded in Lots", "Contract duration in months or years, including any options and renewals", "Validity of Tender in days or months", "EU funding", "Multiple tenders will be accepted", "Date of Publication/Invitation", "TED links for published notices", "Language of publication", "Number of openers",
];

function extractStructuredFields(html: string) {
  const $ = cheerio.load(html);
  $("script,style,noscript").remove();
  const text = $("body").text().replace(/\r/g, "").replace(/\u00a0/g, " ");
  const compact = text.replace(/[ \t]+/g, " ").replace(/\n\s*/g, "\n");
  const result: Record<string, string> = {};
  for (let index = 0; index < FIELD_LABELS.length; index += 1) {
    const label = FIELD_LABELS[index];
    const start = compact.toLowerCase().indexOf(`${label.toLowerCase()}:`);
    if (start < 0) continue;
    const valueStart = start + label.length + 1;
    let end = compact.length;
    for (const candidate of FIELD_LABELS) {
      const candidateIndex = compact.toLowerCase().indexOf(`${candidate.toLowerCase()}:`, valueStart);
      if (candidateIndex >= 0 && candidateIndex < end) end = candidateIndex;
    }
    result[label] = clean(compact.slice(valueStart, end)).slice(0, 10_000);
  }
  return { fields: result, sourceText: clean($("body").text()).slice(0, 150_000) };
}

export type ImportedETender = PublicTender & { metadata: Record<string, unknown>; sourceText: string; resourceId: string };

/**
 * Turns one notice-detail page into a tender, with no network involved.
 *
 * Separated from importETender so the extraction contract can be pinned against
 * a recorded fixture: a portal redesign used to change the result silently —
 * imports kept succeeding with every field empty.
 */
export function parseNoticeDetailHtml(html: string, resourceId: string): ImportedETender {
  const detailUrl = `https://www.etenders.gov.ie/epps/cft/prepareViewCfTWS.do?resourceId=${encodeURIComponent(resourceId)}`;
  const { fields, sourceText } = extractStructuredFields(html);
  const title = fields.Title || clean(cheerio.load(html)("h2").first().text()).replace(/^CfT:\s*/i, "") || `eTenders ${resourceId}`;
  return {
    resourceId,
    externalId: resourceId,
    title,
    authority: fields["Name of Contracting Authority"] || "",
    description: fields.Description || "",
    published: fields["Date of Publication/Invitation"] || "",
    deadline: fields["Time-limit for receipt of tenders or requests to participate"] || "",
    procedure: fields.Procedure || "",
    status: "Tender Submission",
    estimatedValue: fields["Estimated value (EUR)"] || "",
    sourceUrl: detailUrl,
    metadata: { ...fields, resourceId },
    sourceText,
  };
}

/** How many of the known labels a detail page must yield to count as parsed. */
export const MINIMUM_DETAIL_FIELDS = 15;

/** Every label the detail parser knows how to find, for coverage assertions. */
export const KNOWN_FIELD_LABELS: readonly string[] = FIELD_LABELS;

export async function importETender(inputUrl: string): Promise<ImportedETender> {
  const safeUrl = assertSafeProcurementUrl(inputUrl);
  if (!ETENDERS_HOSTS.has(safeUrl.hostname.toLowerCase())) throw new Error("For automatic document import, paste an etenders.gov.ie opportunity link");
  const initial = await fetchHtml(safeUrl.toString());
  const resourceId = extractResourceId(safeUrl, initial.html);
  const detailUrl = `https://www.etenders.gov.ie/epps/cft/prepareViewCfTWS.do?resourceId=${encodeURIComponent(resourceId)}`;
  const detail = safeUrl.pathname.includes("prepareViewCfTWS.do") ? initial : await fetchHtml(detailUrl);
  return parseNoticeDetailHtml(detail.html, resourceId);
}

/**
 * One notice's detail page, which is the only place its CPV is published.
 *
 * The search listing carries no CPV at all — measured against live eTenders,
 * zero of ten sampled notices had one — so the nightly run has to come here to
 * find out what a tender is actually for. Lighter than importETender: no URL to
 * validate because the resource id came from our own parser, and no documents
 * fetched, because at ingest time nobody has decided to bid yet.
 */
export async function fetchNoticeDetail(resourceId: string): Promise<ImportedETender> {
  const id = String(resourceId).trim();
  if (!/^\d{5,}$/.test(id)) throw new Error(`Not an eTenders resource id: ${id}`);
  const detailUrl = `https://www.etenders.gov.ie/epps/cft/prepareViewCfTWS.do?resourceId=${encodeURIComponent(id)}`;
  const { html } = await fetchHtml(detailUrl);
  return parseNoticeDetailHtml(html, id);
}

/** The CPV a detail page publishes, or null when it publishes none. */
export function cpvFromDetail(detail: Pick<ImportedETender, "metadata">) {
  const raw = detail.metadata?.["CPV Codes"];
  return raw ? String(raw) : null;
}

export type RemoteTenderDocument = { filename: string; url: string; description: string; bytes?: Buffer; mimeType?: string; warning?: string };

export function parseDocumentListHtml(html: string, baseUrl: string, resourceId: string) {
  const $ = cheerio.load(html);
  const docs: RemoteTenderDocument[] = [];
  $("table tr").each((_index, row) => {
    const cells = $(row).find("td");
    if (cells.length < 3) return;
    const fileCell = $(cells[2]);
    const anchor = fileCell.find("a").first();
    const href = safeAbsoluteHref(anchor.attr("href"), baseUrl);
    const filename = sanitizeFilename(clean(anchor.text() || fileCell.text()));
    if (!href || !filename) return;
    docs.push({ filename, url: href, description: cells.length > 3 ? clean($(cells[3]).text()) : "" });
  });
  const deduped = new Map(docs.map((doc) => [`${doc.filename}:${doc.url}`, doc]));
  return [...deduped.values()].slice(0, 20).map((doc) => ({ ...doc, description: doc.description || `eTenders ${resourceId}` }));
}

function sanitizeFilename(input: string) {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what must be stripped from a downloaded filename
  return input.replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").replace(/\s+/g, " ").trim().slice(0, 180);
}

function filenameFromDisposition(disposition: string | null, fallback: string) {
  if (!disposition) return fallback;
  const utf = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (utf) { try { return sanitizeFilename(decodeURIComponent(utf)); } catch { return fallback; } }
  const basic = disposition.match(/filename="?([^";]+)"?/i)?.[1];
  return basic ? sanitizeFilename(basic) : fallback;
}

export async function fetchPublicTenderDocuments(resourceId: string) {
  const listUrl = `https://www.etenders.gov.ie/epps/cft/listContractDocuments.do?resourceId=${encodeURIComponent(resourceId)}`;
  const { html, url } = await fetchHtml(listUrl);
  const listed = parseDocumentListHtml(html, url, resourceId);
  const results: RemoteTenderDocument[] = [];
  for (const doc of listed) {
    try {
      const file = await fetchBuffer(doc.url, MAX_DOCUMENT_BYTES);
      if (/text\/html/i.test(file.contentType) && !/\.html?$/i.test(doc.filename)) {
        results.push({ ...doc, warning: "Document requires portal access; upload it manually" });
        continue;
      }
      results.push({
        ...doc,
        filename: filenameFromDisposition(file.headers.get("content-disposition"), doc.filename),
        bytes: file.bytes,
        mimeType: file.contentType.split(";")[0] || "application/octet-stream",
      });
    } catch (error) {
      results.push({ ...doc, warning: error instanceof Error ? error.message : "Could not download public document" });
    }
  }
  return results;
}

