import JSZip from "jszip";
import {
  evidenceFile, getCompany, getUserById, listAnswers, listAudit, listBidDecisions, listBidTasks,
  listClarifications, listDeclarationAnswers, listDocuments, listEvidence, listAccountPersonFacts,
  listPeople, listProvenance, listSavedSearches, listTenders, listUsage, listWatchlist,
} from "./db.js";
import type { PersonFact, PersonRecord } from "./types.js";

/**
 * Everything this organisation's account holds, as a file they can keep.
 *
 * A subject access request is answered badly by a screenshot and well by a
 * machine-readable archive, so each data type is its own JSON file and the
 * original uploaded documents travel as themselves rather than as base64 inside
 * a field. What comes out is what a person can hand to their own lawyer, load
 * into another system, or simply read.
 */

/** Filenames are user-visible; a certificate called "Tax / 2026" cannot be one. */
function safeName(value: string, fallback: string) {
  const cleaned = value.replace(/[^A-Za-z0-9._ -]+/g, "-").replace(/\s+/g, " ").trim();
  return cleaned.slice(0, 120) || fallback;
}

/**
 * One person, with the CV text and the parsed records kept side by side.
 *
 * The parsed facts are what the product asserts about this person; the CV text
 * is what they actually wrote. Exporting one without the other would hide half
 * of what is held about them.
 */
function personEntry(person: PersonRecord, facts: PersonFact[]) {
  return { ...person, records: facts.filter((fact) => fact.personId === person.id) };
}

export type ExportResult = { buffer: Buffer; filename: string; files: string[] };

/**
 * Builds the export archive for one account.
 *
 * Every read here is account-scoped. Nothing in the archive is fetched by a
 * query that could reach another organisation's row.
 */
export async function buildAccountExport(accountId: string, generatedAt = new Date()): Promise<ExportResult> {
  const zip = new JSZip();
  const [user, company, tenders, evidence, people, facts, declarations, watchlist, searches, usage, audit] =
    await Promise.all([
      getUserById(accountId), getCompany(accountId), listTenders(accountId), listEvidence(accountId),
      listPeople(accountId, { includeArchived: true }), listAccountPersonFacts(accountId),
      listDeclarationAnswers(accountId), listWatchlist(accountId), listSavedSearches(accountId),
      listUsage(accountId), listAudit(accountId, { limit: 10_000 }),
    ]);

  zip.file("account.json", JSON.stringify({
    generatedAt: generatedAt.toISOString(),
    account: user ? { id: user.id, email: user.email } : null,
    company,
  }, null, 2));

  // Tenders carry their documents, answers, provenance and the working record
  // around them; splitting those into parallel files keyed by id would make the
  // archive correct and unreadable.
  const tenderFiles = [];
  for (const tender of tenders) {
    const [documents, answers, decisions, clarifications, tasks] = await Promise.all([
      listDocuments(tender.id), listAnswers(tender.id), listBidDecisions(tender.id),
      listClarifications(tender.id), listBidTasks(tender.id),
    ]);
    const provenance = await Promise.all(answers.map(async (answer) => ({
      answerId: answer.id, entries: await listProvenance(answer.id),
    })));
    tenderFiles.push({ ...tender, documents, answers, provenance, decisions, clarifications, tasks });
  }
  zip.file("tenders.json", JSON.stringify(tenderFiles, null, 2));

  zip.file("people.json", JSON.stringify(people.map((person) => personEntry(person, facts)), null, 2));
  zip.file("evidence.json", JSON.stringify(evidence, null, 2));
  zip.file("declarations.json", JSON.stringify(declarations, null, 2));
  zip.file("watchlist.json", JSON.stringify({ watchlist, savedSearches: searches }, null, 2));
  zip.file("activity.json", JSON.stringify({ usage, audit }, null, 2));

  // The original files, under their own names. A vault of PDFs exported as
  // JSON strings is not an export of the vault.
  const used = new Set<string>();
  for (const item of evidence) {
    if (!item.filename) continue;
    const stored = await evidenceFile(accountId, item.id);
    if (!stored) continue;
    let name = safeName(item.filename, `${item.id}.bin`);
    // Two certificates both uploaded as "certificate.pdf" are two files, not one.
    if (used.has(name)) name = `${item.id.slice(0, 8)}-${name}`;
    used.add(name);
    zip.file(`vault/${name}`, stored.bytes);
  }

  const buffer = await zip.generateAsync({ type: "nodebuffer" });
  const stamp = generatedAt.toISOString().slice(0, 10);
  const label = safeName(company.name || "account", "account").replace(/\s+/g, "-");
  return {
    buffer,
    filename: `tenderly-export-${label}-${stamp}.zip`,
    files: Object.keys(zip.files).filter((name) => !zip.files[name].dir),
  };
}
