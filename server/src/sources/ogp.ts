import { createHash } from "node:crypto";

/**
 * The OGP quarterly open dataset: every published Irish public competition since
 * 2013, with awarded values and suppliers. Reference data for Go/No-Go
 * intelligence (TLY-48), never a live discovery feed.
 *
 * Licensed CC-BY-4.0. The attribution is stored on every row so the data cannot
 * be displayed without it.
 */

export const OGP_DATASET_URL =
  "https://assets.gov.ie/static/documents/c41c3a86/Public_Procurement_Opendata_Dataset.csv";

export const AWARD_DATA_ATTRIBUTION =
  "Contains public sector information licensed under CC-BY-4.0, Office of Government Procurement (data.gov.ie)";

export type AwardRecord = {
  externalId: string;
  authority: string;
  title: string;
  cpv: string;
  cpvDescription: string;
  procedure: string;
  publishedOn: string | null;
  awardedOn: string | null;
  awardedValue: number | null;
  estimatedValue: number | null;
  suppliers: string;
  bidsReceived: number | null;
  smeBidsReceived: number | null;
};

/** The dataset writes empty cells as the literal string NULL, not as blanks. */
export function cell(value: string | undefined): string {
  const trimmed = (value ?? "").trim();
  return trimmed === "NULL" || trimmed === "" ? "" : trimmed;
}

/** Irish dates are dd/mm/yyyy. Returns ISO, or null when absent or impossible. */
export function parseIrishDate(value: string | undefined): string | null {
  const raw = cell(value);
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(raw);
  if (!m) return null;
  const day = Number(m[1]), month = Number(m[2]), year = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  // Rejects 31/02/2024: the Date rolls into March, so the day no longer matches.
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

export function parseMoney(value: string | undefined): number | null {
  const raw = cell(value).replace(/[^0-9.-]/g, "");
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function parseCount(value: string | undefined): number | null {
  const raw = cell(value).replace(/[^0-9-]/g, "");
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** CPV here is 8 digits; anything else cannot be used for matching. */
export function normaliseCpv(value: string | undefined): string {
  const digits = cell(value).replace(/[^0-9]/g, "");
  return /^\d{8}$/.test(digits) ? digits : "";
}

/**
 * A minimal RFC-4180 splitter. The file quotes fields containing commas — the
 * additional-CPV column arrives as "2,282,100,079,..." — so a naive split on
 * comma corrupts every column after it.
 */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { out.push(field); field = ""; }
    else field += ch;
  }
  out.push(field);
  return out;
}

export const EXPECTED_HEADERS = [
  "Tender ID", "Contracting Authority", "Tender Name", "Notice Published Date",
  "Main Cpv Code", "Awarded Value", "Awarded Suppliers",
];

/** A header without the columns we rely on means a different file. */
export function assertHeaders(header: string[]) {
  const seen = new Set(header.map((h) => h.replace(/^﻿/, "").trim()));
  const missing = EXPECTED_HEADERS.filter((h) => !seen.has(h));
  if (missing.length) {
    throw new Error(`Unexpected OGP CSV header - missing column(s): ${missing.join(", ")}`);
  }
}

export function rowToAward(header: string[], values: string[]): AwardRecord | null {
  const at = (name: string) => {
    const index = header.findIndex((h) => h.replace(/^﻿/, "").trim() === name);
    return index === -1 ? undefined : values[index];
  };
  const externalId = cell(at("Tender ID"));
  const authority = cell(at("Contracting Authority"));
  if (!externalId || !authority) return null;
  return {
    externalId,
    authority,
    title: cell(at("Tender Name")),
    cpv: normaliseCpv(at("Main Cpv Code")),
    cpvDescription: cell(at("Main Cpv Code Description")),
    procedure: cell(at("Procedure")),
    publishedOn: parseIrishDate(at("Notice Published Date")),
    awardedOn: parseIrishDate(at("Award Published")),
    awardedValue: parseMoney(at("Awarded Value")),
    estimatedValue: parseMoney(at("Notice Estimated Value")),
    suppliers: cell(at("Awarded Suppliers")),
    bidsReceived: parseCount(at("No of Bids Received")),
    smeBidsReceived: parseCount(at("No of SMEs Bids Received")),
  };
}

/** Stable id, so re-importing the same row updates rather than duplicates. */
export function awardId(externalId: string) {
  const hex = createHash("sha256").update(`ogp:${externalId}`).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
