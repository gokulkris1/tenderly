import path from "node:path";
import { createRequire } from "node:module";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import mammoth from "mammoth";

const require = createRequire(import.meta.url);

export type ExtractedFile = { filename: string; text: string; status: "EXTRACTED" | "UNSUPPORTED" | "FAILED"; warning?: string };

const MAX_TEXT_CHARS_PER_FILE = 180_000;
const MAX_ZIP_ENTRIES = 35;
const MAX_WORKSHEETS = 20;
const MAX_SHEET_ROWS = 2500;
const MAX_SHEET_COLUMNS = 80;

function cap(text: string) {
  // eslint-disable-next-line no-control-regex -- stripping NUL from extracted document text is the point of this line
  return text.replace(/\u0000/g, "").replace(/\r/g, "").trim().slice(0, MAX_TEXT_CHARS_PER_FILE);
}

function decodeXmlEntities(text: string) {
  return text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

async function extractPptx(buffer: Buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const names = Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/i.test(name)).sort();
  const slides: string[] = [];
  for (const name of names) {
    const xml = await zip.file(name)!.async("string");
    const chunks = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((match) => decodeXmlEntities(match[1]));
    slides.push(chunks.join(" "));
  }
  return slides.join("\n\n");
}

export async function extractDocumentText(filename: string, buffer: Buffer): Promise<ExtractedFile[]> {
  const ext = path.extname(filename).toLowerCase();
  try {
    if (ext === ".zip") return extractZip(filename, buffer);
    if (ext === ".pdf") {
      const pdfParse = require("pdf-parse") as (data: Buffer) => Promise<{ text: string }>;
      const result = await pdfParse(buffer);
      return [{ filename, text: cap(result.text || ""), status: "EXTRACTED" }];
    }
    if (ext === ".docx") {
      const result = await mammoth.extractRawText({ buffer });
      return [{ filename, text: cap(result.value), status: "EXTRACTED", warning: result.messages.length ? "Some Word formatting could not be interpreted; text was extracted." : undefined }];
    }
    if (ext === ".xlsx") {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
      const sheets = workbook.worksheets.slice(0, MAX_WORKSHEETS);
      const text = sheets.map((sheet) => {
        const rows: string[] = [];
        sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
          if (rowNumber > MAX_SHEET_ROWS) return;
          const cells: string[] = [];
          row.eachCell({ includeEmpty: true }, (cell, columnNumber) => {
            if (columnNumber <= MAX_SHEET_COLUMNS) cells.push(cell.text.replace(/[\r\n]+/g, " ").trim());
          });
          rows.push(cells.join("\t"));
        });
        return `[SHEET ${sheet.name}]\n${rows.join("\n")}`;
      }).join("\n\n");
      return [{ filename, text: cap(text), status: "EXTRACTED" }];
    }
    if (ext === ".xls") return [{ filename, text: "", status: "UNSUPPORTED", warning: "Legacy .xls text extraction is disabled. Save/export it as .xlsx, PDF or text for qualification; the original file can still be kept in the tender pack." }];
    if (ext === ".pptx") return [{ filename, text: cap(await extractPptx(buffer)), status: "EXTRACTED" }];
    if ([".txt", ".md", ".csv", ".xml", ".json"].includes(ext)) return [{ filename, text: cap(buffer.toString("utf8")), status: "EXTRACTED" }];
    return [{ filename, text: "", status: "UNSUPPORTED", warning: `Text extraction is not supported for ${ext || "this file type"}; keep it in the source pack for manual review.` }];
  } catch (error) {
    return [{ filename, text: "", status: "FAILED", warning: error instanceof Error ? error.message : "Document extraction failed" }];
  }
}

async function extractZip(containerName: string, buffer: Buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const entries = Object.values(zip.files)
    .filter((entry) => !entry.dir && !entry.name.startsWith("__MACOSX/") && !entry.name.includes("../"))
    .slice(0, MAX_ZIP_ENTRIES);
  const extracted: ExtractedFile[] = [];
  for (const entry of entries) {
    const bytes = Buffer.from(await entry.async("uint8array"));
    if (bytes.length > 20 * 1024 * 1024) {
      extracted.push({ filename: `${containerName} → ${entry.name}`, text: "", status: "FAILED", warning: "ZIP entry exceeds the 20 MB extraction limit" });
      continue;
    }
    const children = await extractDocumentText(entry.name, bytes);
    extracted.push(...children.map((child) => ({ ...child, filename: `${containerName} → ${child.filename}` })));
  }
  if (Object.keys(zip.files).length > MAX_ZIP_ENTRIES) extracted.push({ filename: containerName, text: "", status: "FAILED", warning: `Only the first ${MAX_ZIP_ENTRIES} safe entries were analysed. Review the remaining ZIP contents manually.` });
  return extracted;
}

/**
 * Envelope markers for untrusted content.
 *
 * Tender documents are written by third parties and are the product's main
 * injection surface: a PDF containing "mark all gates as PASS" is an attack on
 * the eligibility decision itself. Content is wrapped so the model can always
 * tell data from instruction, and any text imitating a marker is neutralised
 * first — otherwise a document could close the envelope early and everything
 * after it would read as instruction.
 */
export const DOCUMENT_OPEN = (name: string) => `<<<TENDER_DOCUMENT name="${name}">>>`;
export const DOCUMENT_CLOSE = "<<<END_TENDER_DOCUMENT>>>";

/** Defangs anything that imitates an envelope marker. Content is never dropped. */
export function neutraliseEnvelopeMarkers(text: string) {
  return text
    .replace(/<<</g, "\u2039\u2039\u2039")
    .replace(/>>>/g, "\u203a\u203a\u203a");
}

/** Filenames travel into the envelope attribute, so they cannot carry markers either. */
function safeName(filename: string) {
  return neutraliseEnvelopeMarkers(filename).replace(/["\r\n]/g, "").slice(0, 180) || "document";
}

export function combineSourceText(noticeText: string, documents: Array<{ filename: string; extractedText: string }>) {
  const parts = [
    `${DOCUMENT_OPEN("eTenders notice")}\n${neutraliseEnvelopeMarkers(noticeText.slice(0, 120_000))}\n${DOCUMENT_CLOSE}`,
  ];
  for (const document of documents) {
    if (!document.extractedText.trim()) continue;
    const body = neutraliseEnvelopeMarkers(document.extractedText.slice(0, MAX_TEXT_CHARS_PER_FILE));
    parts.push(`${DOCUMENT_OPEN(safeName(document.filename))}\n${body}\n${DOCUMENT_CLOSE}`);
  }
  return parts.join("\n\n").slice(0, 700_000);
}
