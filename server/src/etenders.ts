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

  let nextUrl = "";
  $("a").each((_index, node) => {
    if (nextUrl) return;
    const label = clean($(node).text()).toLowerCase();
    const title = clean($(node).attr("title") || "").toLowerCase();
    const rel = clean($(node).attr("rel") || "").toLowerCase();
    if (label === "next" || label === ">" || title.includes("next") || rel === "next") {
      nextUrl = safeAbsoluteHref($(node).attr("href"), baseUrl);
    }
  });
  return { items, nextUrl };
}

export async function discoverETenders(query = "", options: { maxPages?: number; delayMs?: number } = {}) {
  const maxPages = Math.max(1, Math.min(options.maxPages ?? Number(process.env.ETENDERS_MAX_PAGES || 2), 8));
  const delayMs = Math.max(200, Number(options.delayMs ?? process.env.ETENDERS_REQUEST_DELAY_MS ?? 850));
  const discovered = new Map<string, PublicTender>();
  let url = START_URL;
  for (let page = 0; page < maxPages && url; page += 1) {
    const { html, url: fetchedUrl } = await fetchHtml(url);
    const parsed = parseSearchHtml(html, fetchedUrl);
    parsed.items.forEach((item) => discovered.set(item.externalId, item));
    url = parsed.nextUrl;
    if (url && page + 1 < maxPages) await new Promise((resolve) => setTimeout(resolve, delayMs));
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

export async function importETender(inputUrl: string): Promise<ImportedETender> {
  const safeUrl = assertSafeProcurementUrl(inputUrl);
  if (!ETENDERS_HOSTS.has(safeUrl.hostname.toLowerCase())) throw new Error("For automatic document import, paste an etenders.gov.ie opportunity link");
  const initial = await fetchHtml(safeUrl.toString());
  const resourceId = extractResourceId(safeUrl, initial.html);
  const detailUrl = `https://www.etenders.gov.ie/epps/cft/prepareViewCfTWS.do?resourceId=${encodeURIComponent(resourceId)}`;
  const detail = safeUrl.pathname.includes("prepareViewCfTWS.do") ? initial : await fetchHtml(detailUrl);
  const { fields, sourceText } = extractStructuredFields(detail.html);
  const title = fields.Title || clean(cheerio.load(detail.html)("h2").first().text()).replace(/^CfT:\s*/i, "") || `eTenders ${resourceId}`;
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

export function scoreTenderPreview(tender: PublicTender, companyText: string) {
  const stop = new Set(["and", "the", "for", "with", "from", "that", "this", "services", "service", "delivery", "company", "limited"]);
  const tokens = (value: string) => new Set(value.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length >= 4 && !stop.has(word)));
  const bidder = tokens(companyText);
  if (!bidder.size) return 0;
  const opportunity = tokens(`${tender.title} ${tender.description}`);
  let matches = 0;
  for (const token of opportunity) if (bidder.has(token)) matches += 1;
  const raw = Math.round((matches / Math.max(4, Math.min(opportunity.size, 18))) * 100);
  return Math.max(0, Math.min(95, raw + (matches >= 2 ? 25 : matches ? 12 : 0)));
}
