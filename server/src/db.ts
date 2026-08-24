import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { needsMigration, remapLegacyAnalysis } from "./analysis-schema.js";
import { allCpvCodes, cpvAncestors, normaliseCpv } from "./cpv.js";
import { canonicalKey } from "./dedupe.js";
import type { IngestionRun } from "./ingestion-health.js";
import type { AnswerVersion } from "./versions.js";
import type { MockEvaluation } from "./evaluation.js";

/** One stored analysis, so an amendment can be compared with what preceded it. */
export type AnalysisVersionRecord = {
  id: string;
  tenderId: string;
  analysis: TenderAnalysis;
  promptVersion: string;
  schemaVersion: string;
  actor: string;
  createdAt: string;
};
import type { PackQuestion } from "./types.js";
import type { Affirmation, DeclarationAnswer } from "./declarations.js";
import type {
  AuditEntry,
  BidAnswer,
  BidDecisionRecord,
  Clarification,
  CompanyProfile,
  DiscoveryPreferences,
  EvidenceRecord,
  PersonFact,
  PersonRecord,
  ProvenanceEntry,
  PublicTender,
  SavedSearch,
  SavedSearchFilter,
  StoredDocument,
  TenderAnalysis,
  TenderRecord,
  UsageEvent,
  UsageTotals,
  WatchlistEntry,
} from "./types.js";

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL?.trim();
export const persistentDatabase = Boolean(databaseUrl);

const pool = databaseUrl
  ? new Pool({
      connectionString: databaseUrl,
      ssl: databaseUrl.includes("localhost") ? undefined : { rejectUnauthorized: false },
      max: 5,
    })
  : null;

type UserRow = { id: string; email: string; passwordHash: string };
type NotificationRow = { id: string; accountId: string; externalId: string; title: string; sourceUrl: string; matchScore: number; payload: Record<string, unknown>; read: boolean; createdAt: string };

const memory = {
  users: new Map<string, UserRow>(),
  companies: new Map<string, CompanyProfile>(),
  tenders: new Map<string, TenderRecord>(),
  documents: new Map<string, StoredDocument>(),
  answers: new Map<string, BidAnswer>(),
  preferences: new Map<string, DiscoveryPreferences>(),
  awards: new Map<string, Record<string, unknown>>(),
  evidence: new Map<string, EvidenceRecord>(),
  people: new Map<string, PersonRecord>(),
  notifications: new Map<string, NotificationRow>(),
  provenance: [] as ProvenanceEntry[],
  usage: [] as UsageEvent[],
  audit: [] as AuditEntry[],
  bidDecisions: [] as BidDecisionRecord[],
  watchlist: [] as WatchlistEntry[],
  personFacts: [] as PersonFact[],
  answerVersions: [] as AnswerVersion[],
  mockEvaluations: [] as MockEvaluation[],
  packQuestions: [] as PackQuestion[],
  clarifications: [] as Clarification[],
  analysisVersions: [] as AnalysisVersionRecord[],
  savedSearches: [] as SavedSearch[],
  ingestionRuns: [] as IngestionRun[],
  declarations: new Map<string, DeclarationAnswer[]>(),
  affirmations: new Map<string, Affirmation>(),
};

/**
 * Arbitrary but fixed key for the migration advisory lock. Any process running
 * migrations against this database uses the same one.
 */
const MIGRATION_LOCK_KEY = 4207701;

export async function initializeDatabase() {
  if (!pool) return;
  // Every migration, in filename order. Each is written to be idempotent, so a
  // restart re-applies them harmlessly — and CI applies the same set with psql.
  const dir = path.resolve(process.cwd(), "migrations");
  const files = (await readdir(dir)).filter((name) => name.endsWith(".sql")).sort();

  // CREATE ... IF NOT EXISTS is not atomic: two processes can both see the
  // object missing and both try to create it, and the loser gets a unique
  // violation on a system catalogue. Test files run concurrently and every one
  // of them initialises, so serialise the whole set behind an advisory lock.
  const client = await pool.connect();
  try {
    await client.query("SELECT pg_advisory_lock($1)", [MIGRATION_LOCK_KEY]);
    for (const file of files) {
      await client.query(await readFile(path.join(dir, file), "utf8"));
    }
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]).catch(() => {});
    client.release();
  }
}

/**
 * Loads the published CPV list into the lookup table.
 *
 * Idempotent and cheap to re-run: the list changes only when the Commission
 * amends the regulation, so a matching row count means there is nothing to do.
 */
export async function seedCpvCodes() {
  if (!pool) return { seeded: 0 };
  const entries = allCpvCodes();
  const existing = await pool.query("SELECT count(*)::int AS count FROM cpv_codes");
  if (existing.rows[0].count === entries.length) return { seeded: 0 };

  // One statement per batch rather than per code: 9,454 round trips would make
  // every cold start noticeably slower.
  const size = 500;
  for (let start = 0; start < entries.length; start += size) {
    const batch = entries.slice(start, start + size);
    const values: unknown[] = [];
    const rows = batch.map((entry, index) => {
      const base = index * 5;
      values.push(entry.code, entry.checkDigit, entry.description, cpvAncestors(entry.code)[0]?.code ?? null, entry.level);
      return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5})`;
    });
    await pool.query(
      `INSERT INTO cpv_codes(code,check_digit,description,parent_code,level) VALUES ${rows.join(",")}
       ON CONFLICT(code) DO UPDATE SET description=EXCLUDED.description,parent_code=EXCLUDED.parent_code,level=EXCLUDED.level`,
      values,
    );
  }
  return { seeded: entries.length };
}

/**
 * Sets the canonical code on tenders imported before this column existed.
 *
 * A notice whose raw value carries no readable code keeps a null, and is left
 * alone on later runs — there is nothing to find and re-reading it every start
 * would be wasted work.
 */
export async function backfillTenderCpv() {
  if (!pool) return { updated: 0 };
  const rows = await pool.query("SELECT id, metadata FROM tenders WHERE cpv_normalised IS NULL");
  let updated = 0;
  for (const row of rows.rows) {
    const code = rawCpvOf(row.metadata ?? {});
    if (!code) continue;
    await pool.query("UPDATE tenders SET cpv_normalised=$2 WHERE id=$1", [row.id, code]);
    updated += 1;
  }
  return { updated };
}

export async function closeDatabase() {
  await pool?.end();
}

export async function createUser(email: string, passwordHash: string, companyName: string) {
  const normalized = email.trim().toLowerCase();
  const id = randomUUID();
  if (!pool) {
    if ([...memory.users.values()].some((user) => user.email === normalized)) throw new Error("EMAIL_EXISTS");
    memory.users.set(id, { id, email: normalized, passwordHash });
    memory.companies.set(id, defaultCompany(companyName));
    return { id, email: normalized };
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)", [id, normalized, passwordHash]);
    await client.query(
      "INSERT INTO companies(id,account_id,name) VALUES($1,$2,$3)",
      [randomUUID(), id, companyName.trim()],
    );
    await client.query("COMMIT");
    return { id, email: normalized };
  } catch (error) {
    await client.query("ROLLBACK");
    if ((error as { code?: string }).code === "23505") throw new Error("EMAIL_EXISTS");
    throw error;
  } finally {
    client.release();
  }
}

export async function findUserByEmail(email: string) {
  const normalized = email.trim().toLowerCase();
  if (!pool) return [...memory.users.values()].find((user) => user.email === normalized) ?? null;
  const result = await pool.query<{ id: string; email: string; password_hash: string }>("SELECT id,email,password_hash FROM users WHERE email=$1", [normalized]);
  const row = result.rows[0];
  return row ? { id: row.id, email: row.email, passwordHash: row.password_hash } : null;
}

export async function getUserById(id: string) {
  if (!pool) return memory.users.get(id) ?? null;
  const result = await pool.query<{ id: string; email: string }>("SELECT id,email FROM users WHERE id=$1", [id]);
  return result.rows[0] ?? null;
}

function defaultCompany(name: string): CompanyProfile {
  return { name, registration: "", turnover: "", employees: "", services: "", cpv: "", certifications: "", insurance: "" };
}

export async function getCompany(accountId: string): Promise<CompanyProfile> {
  if (!pool) return memory.companies.get(accountId) ?? defaultCompany("");
  const result = await pool.query("SELECT * FROM companies WHERE account_id=$1", [accountId]);
  const row = result.rows[0];
  if (!row) return defaultCompany("");
  return {
    ...row.profile_json,
    name: row.name,
    registration: row.registration,
    turnover: row.turnover,
    employees: row.employees,
    services: row.services,
    cpv: row.cpv,
    certifications: row.certifications,
    insurance: row.insurance,
  };
}

export async function updateCompany(accountId: string, company: CompanyProfile) {
  const safe = { ...defaultCompany(company.name || ""), ...company };
  if (!pool) {
    memory.companies.set(accountId, safe);
    return safe;
  }
  const profileJson = { ...safe };
  for (const key of ["name", "registration", "turnover", "employees", "services", "cpv", "certifications", "insurance"]) delete profileJson[key];
  await pool.query(
    `UPDATE companies SET name=$2,registration=$3,turnover=$4,employees=$5,services=$6,cpv=$7,certifications=$8,insurance=$9,profile_json=$10,updated_at=now() WHERE account_id=$1`,
    [accountId, safe.name, safe.registration, safe.turnover, safe.employees, safe.services, safe.cpv, safe.certifications, safe.insurance, JSON.stringify(profileJson)],
  );
  return safe;
}

export async function listAllCompanies() {
  if (!pool) return [...memory.companies.entries()].map(([accountId, company]) => ({ accountId, company }));
  const result = await pool.query("SELECT account_id,name,registration,turnover,employees,services,cpv,certifications,insurance,profile_json FROM companies");
  return result.rows.map((row) => ({ accountId: row.account_id as string, company: { ...row.profile_json, name: row.name, registration: row.registration, turnover: row.turnover, employees: row.employees, services: row.services, cpv: row.cpv, certifications: row.certifications, insurance: row.insurance } as CompanyProfile }));
}

export async function upsertTender(accountId: string, tender: Omit<TenderRecord, "id" | "accountId" | "analysis"> & { id?: string; analysis?: TenderAnalysis | null }) {
  const identity = canonicalKey(tender as unknown as PublicTender & { metadata?: Record<string, unknown> });

  if (!pool) {
    const sameSource = [...memory.tenders.values()].find((item) => item.accountId === accountId && item.source === tender.source && item.externalId === tender.externalId);
    // The same opportunity from the other portal is not a new opportunity.
    const twin = sameSource ?? [...memory.tenders.values()].find((item) => item.accountId === accountId && item.canonicalKey === identity.key);
    const record: TenderRecord = {
      ...(twin ?? {}), ...tender,
      id: twin?.id ?? tender.id ?? randomUUID(),
      accountId,
      analysis: tender.analysis ?? twin?.analysis ?? null,
      cpvNormalised: rawCpvOf(tender.metadata) ?? twin?.cpvNormalised,
      canonicalKey: identity.key,
      // A twin keeps its own source and body: the record already worked on wins.
      ...(twin && !sameSource ? { source: twin.source, externalId: twin.externalId, sourceUrl: twin.sourceUrl, title: twin.title, description: twin.description || tender.description, estimatedValue: twin.estimatedValue || tender.estimatedValue } : {}),
    };
    memory.tenders.set(record.id, record);
    return record;
  }
  // A notice already imported from the other portal is the same opportunity.
  // Updating that row rather than inserting a second keeps its bid record, its
  // documents and its saved answers attached — orphaning them would lose work.
  const twin = await pool.query(
    `SELECT * FROM tenders WHERE account_id=$1 AND canonical_key=$2 AND NOT (source=$3 AND external_id IS NOT DISTINCT FROM $4) LIMIT 1`,
    [accountId, identity.key, tender.source, tender.externalId || null],
  );
  if (twin.rows[0]) {
    const existing = mapTenderRow(twin.rows[0]);
    const alternates = [
      ...((existing.metadata.alternateSources ?? []) as { label: string; url: string; externalId: string }[]),
      { label: tender.source, url: tender.sourceUrl, externalId: tender.externalId },
    ].filter((entry, index, all) => all.findIndex((other) => other.url === entry.url) === index);
    const updated = await pool.query(
      `UPDATE tenders SET metadata=$2, cpv_normalised=COALESCE(tenders.cpv_normalised,$3), updated_at=now() WHERE id=$1 RETURNING *`,
      [existing.id, JSON.stringify({ ...existing.metadata, ...tender.metadata, alternateSources: alternates, mergeReason: identity.reason }), rawCpvOf(tender.metadata)],
    );
    return mapTenderRow(updated.rows[0]);
  }

  const id = tender.id ?? randomUUID();
  const result = await pool.query(
    `INSERT INTO tenders(id,account_id,source,external_id,source_url,title,authority,description,procedure,deadline,published,estimated_value,status,metadata,analysis,cpv_normalised,canonical_key)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'IMPORTED',$13,$14,$15,$16)
     ON CONFLICT(account_id,source,external_id) DO UPDATE SET source_url=EXCLUDED.source_url,title=EXCLUDED.title,authority=EXCLUDED.authority,description=EXCLUDED.description,procedure=EXCLUDED.procedure,deadline=EXCLUDED.deadline,published=EXCLUDED.published,estimated_value=EXCLUDED.estimated_value,metadata=EXCLUDED.metadata,analysis=COALESCE(EXCLUDED.analysis,tenders.analysis),cpv_normalised=EXCLUDED.cpv_normalised,canonical_key=EXCLUDED.canonical_key,updated_at=now()
     RETURNING *`,
    [id, accountId, tender.source, tender.externalId || null, tender.sourceUrl, tender.title, tender.authority, tender.description, tender.procedure, tender.deadline, tender.published, tender.estimatedValue, JSON.stringify(tender.metadata), tender.analysis ? JSON.stringify(tender.analysis) : null, rawCpvOf(tender.metadata), identity.key],
  );
  return mapTenderRow(result.rows[0]);
}

export async function getTender(accountId: string, tenderId: string): Promise<TenderRecord | null> {
  if (!pool) {
    const tender = memory.tenders.get(tenderId);
    return tender?.accountId === accountId ? tender : null;
  }
  const result = await pool.query("SELECT * FROM tenders WHERE id=$1 AND account_id=$2", [tenderId, accountId]);
  return result.rows[0] ? mapTenderRow(result.rows[0]) : null;
}

export async function listTenders(accountId: string): Promise<TenderRecord[]> {
  if (!pool) return [...memory.tenders.values()].filter((item) => item.accountId === accountId);
  const result = await pool.query("SELECT * FROM tenders WHERE account_id=$1 ORDER BY updated_at DESC", [accountId]);
  return result.rows.map(mapTenderRow);
}

export async function saveTenderAnalysis(accountId: string, tenderId: string, analysis: TenderAnalysis) {
  const tender = await getTender(accountId, tenderId);
  if (!tender) throw new Error("TENDER_NOT_FOUND");
  if (!pool) {
    const updated = { ...tender, analysis };
    memory.tenders.set(tenderId, updated);
    return updated;
  }
  const result = await pool.query("UPDATE tenders SET analysis=$3,status='ANALYSED',updated_at=now() WHERE id=$1 AND account_id=$2 RETURNING *", [tenderId, accountId, JSON.stringify(analysis)]);
  return mapTenderRow(result.rows[0]);
}

export async function updateTenderMetadata(accountId: string, tenderId: string, patch: Record<string, unknown>) {
  const tender = await getTender(accountId, tenderId);
  if (!tender) throw new Error("TENDER_NOT_FOUND");
  const metadata = { ...tender.metadata, ...patch };
  if (!pool) {
    const updated = { ...tender, metadata };
    memory.tenders.set(tenderId, updated);
    return updated;
  }
  const result = await pool.query("UPDATE tenders SET metadata=$3,updated_at=now() WHERE id=$1 AND account_id=$2 RETURNING *", [tenderId, accountId, JSON.stringify(metadata)]);
  return mapTenderRow(result.rows[0]);
}

/**
 * The canonical code for a notice, read from whichever metadata field the
 * source happens to use. Null when the notice carries no readable code — which
 * is common and is not an error.
 */
function rawCpvOf(metadata: Record<string, unknown>) {
  const candidates = ["CPV Codes", "cpv", "CPV", "classification-cpv"];
  for (const key of candidates) {
    const value = metadata[key];
    if (typeof value !== "string" && !Array.isArray(value)) continue;
    const normalised = normaliseCpv(Array.isArray(value) ? String(value[0] ?? "") : value);
    if (normalised) return normalised.code;
  }
  return null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- TODO(TLY-26): pg returns untyped rows; row typing lands with the strict-TypeScript story.
function mapTenderRow(row: Record<string, any>): TenderRecord {
  return {
    id: row.id,
    accountId: row.account_id,
    source: row.source,
    externalId: row.external_id ?? "",
    sourceUrl: row.source_url,
    title: row.title,
    authority: row.authority,
    description: row.description,
    procedure: row.procedure,
    deadline: row.deadline,
    published: row.published,
    status: row.status,
    estimatedValue: row.estimated_value,
    metadata: row.metadata ?? {},
    analysis: row.analysis ?? null,
    cpvNormalised: row.cpv_normalised ?? undefined,
    canonicalKey: row.canonical_key ?? undefined,
  } as TenderRecord;
}

export async function saveDocument(document: Omit<StoredDocument, "id">) {
  const id = randomUUID();
  const record: StoredDocument = { ...document, id };
  if (!pool) {
    const duplicate = [...memory.documents.values()].find((item) => item.tenderId === record.tenderId && item.filename === record.filename && item.role === record.role);
    if (duplicate) memory.documents.delete(duplicate.id);
    memory.documents.set(id, record);
    return record;
  }
  await pool.query("DELETE FROM tender_documents WHERE tender_id=$1 AND filename=$2 AND role=$3", [record.tenderId, record.filename, record.role]);
  await pool.query(
    "INSERT INTO tender_documents(id,tender_id,filename,mime_type,role,source_url,bytes,extracted_text,extraction_status) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [id, record.tenderId, record.filename, record.mimeType, record.role, record.sourceUrl ?? null, record.bytes ?? null, record.extractedText, record.extractionStatus],
  );
  return record;
}

export async function listDocuments(tenderId: string) {
  if (!pool) return [...memory.documents.values()].filter((item) => item.tenderId === tenderId);
  const result = await pool.query("SELECT * FROM tender_documents WHERE tender_id=$1 ORDER BY created_at", [tenderId]);
  return result.rows.map((row) => ({ id: row.id, tenderId: row.tender_id, filename: row.filename, mimeType: row.mime_type, role: row.role, sourceUrl: row.source_url ?? undefined, bytes: row.bytes ?? undefined, extractedText: row.extracted_text, extractionStatus: row.extraction_status } as StoredDocument));
}

export async function saveAnswer(tenderId: string, questionId: string, response: string, status: string, evidence: string[] = []) {
  if (!pool) {
    const key = `${tenderId}:${questionId}`;
    const existing = memory.answers.get(key);
    const answer: BidAnswer = { id: existing?.id ?? randomUUID(), tenderId, questionId, response, status, evidence };
    memory.answers.set(key, answer);
    return answer;
  }
  const result = await pool.query(
    `INSERT INTO bid_answers(id,tender_id,question_id,response,status,evidence_json) VALUES($1,$2,$3,$4,$5,$6)
     ON CONFLICT(tender_id,question_id) DO UPDATE SET response=EXCLUDED.response,status=EXCLUDED.status,evidence_json=EXCLUDED.evidence_json,updated_at=now() RETURNING *`,
    [randomUUID(), tenderId, questionId, response, status, JSON.stringify(evidence)],
  );
  const row = result.rows[0];
  return { id: row.id, tenderId: row.tender_id, questionId: row.question_id, response: row.response, status: row.status, evidence: row.evidence_json ?? [] } as BidAnswer;
}

export async function listAnswers(tenderId: string) {
  if (!pool) return [...memory.answers.values()].filter((item) => item.tenderId === tenderId);
  const result = await pool.query("SELECT * FROM bid_answers WHERE tender_id=$1 ORDER BY updated_at", [tenderId]);
  return result.rows.map((row) => ({ id: row.id, tenderId: row.tender_id, questionId: row.question_id, response: row.response, status: row.status, evidence: row.evidence_json ?? [] } as BidAnswer));
}

/**
 * Appends one entry to an answer's provenance ledger.
 *
 * There is deliberately no update or delete counterpart: the ledger is
 * append-only in the schema too, so a caller that tries to rewrite it gets a
 * database error rather than a quiet success.
 */
export async function recordProvenance(input: Omit<ProvenanceEntry, "id" | "createdAt">) {
  const entry: ProvenanceEntry = { ...input, id: randomUUID(), createdAt: new Date().toISOString() };
  if (!pool) { memory.provenance.push(entry); return entry; }
  const result = await pool.query(
    `INSERT INTO answer_provenance(id,answer_id,section,class,model,prompt_version,evidence_ids,actor)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING created_at`,
    [entry.id, entry.answerId, entry.section, entry.class, entry.model ?? null, entry.promptVersion ?? null,
     JSON.stringify(entry.evidenceIds), entry.actor],
  );
  return { ...entry, createdAt: new Date(result.rows[0].created_at).toISOString() };
}

const toProvenance = (row: Record<string, unknown>): ProvenanceEntry => ({
  id: String(row.id), answerId: String(row.answer_id), section: String(row.section),
  class: row.class as ProvenanceEntry["class"],
  model: (row.model as string | null) ?? undefined,
  promptVersion: (row.prompt_version as string | null) ?? undefined,
  evidenceIds: (row.evidence_ids as string[] | null) ?? [],
  actor: String(row.actor), createdAt: new Date(row.created_at as string).toISOString(),
});

/** One answer's ledger, oldest first. */
export async function listProvenance(answerId: string) {
  if (!pool) return memory.provenance.filter((entry) => entry.answerId === answerId).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const result = await pool.query("SELECT * FROM answer_provenance WHERE answer_id=$1 ORDER BY created_at, id", [answerId]);
  return result.rows.map(toProvenance);
}

/** Every ledger entry for a tender, for the attestation and the pack summary. */
export async function tenderProvenance(tenderId: string) {
  if (!pool) {
    const answerIds = new Set([...memory.answers.values()].filter((a) => a.tenderId === tenderId).map((a) => a.id));
    return memory.provenance.filter((entry) => answerIds.has(entry.answerId)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  const result = await pool.query(
    `SELECT p.* FROM answer_provenance p JOIN bid_answers a ON a.id = p.answer_id
     WHERE a.tender_id=$1 ORDER BY p.created_at, p.id`, [tenderId]);
  return result.rows.map(toProvenance);
}

/**
 * Records one metered model call.
 *
 * Metering must never block or fail the user's request, so every caller wraps
 * this in a catch and logs. A row that is lost costs us billing accuracy; a
 * request that fails because metering did costs the user their work.
 */
export async function recordUsage(input: Omit<UsageEvent, "id" | "createdAt">) {
  const event: UsageEvent = { ...input, id: randomUUID(), createdAt: new Date().toISOString() };
  if (!pool) { memory.usage.push(event); return event; }
  await pool.query(
    `INSERT INTO usage_events(id,account_id,kind,model,input_tokens,output_tokens,request_id,tender_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
    [event.id, event.accountId, event.kind, event.model, event.inputTokens, event.outputTokens,
     event.requestId ?? null, event.tenderId ?? null],
  );
  return event;
}

const monthStart = (now = new Date()) => new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

/** One account's model usage this calendar month. Never crosses accounts. */
export async function monthlyUsage(accountId: string): Promise<UsageTotals> {
  const since = monthStart();
  const month = since.toISOString().slice(0, 7);
  const rows = pool
    ? (await pool.query(
        `SELECT kind, count(*)::int AS actions, coalesce(sum(input_tokens),0)::int AS input_tokens,
                coalesce(sum(output_tokens),0)::int AS output_tokens
         FROM usage_events WHERE account_id=$1 AND created_at >= $2 GROUP BY kind ORDER BY kind`,
        [accountId, since.toISOString()],
      )).rows
    : Object.values(memory.usage
        .filter((event) => event.accountId === accountId && event.createdAt >= since.toISOString())
        .reduce((acc, event) => {
          const row = acc[event.kind] ?? { kind: event.kind, actions: 0, input_tokens: 0, output_tokens: 0 };
          row.actions += 1; row.input_tokens += event.inputTokens; row.output_tokens += event.outputTokens;
          acc[event.kind] = row;
          return acc;
        }, {} as Record<string, { kind: string; actions: number; input_tokens: number; output_tokens: number }>))
        .sort((a, b) => a.kind.localeCompare(b.kind));

  const byKind = rows.map((row) => ({
    kind: String(row.kind), actions: Number(row.actions),
    inputTokens: Number(row.input_tokens), outputTokens: Number(row.output_tokens),
  }));
  return {
    month,
    actions: byKind.reduce((sum, row) => sum + row.actions, 0),
    inputTokens: byKind.reduce((sum, row) => sum + row.inputTokens, 0),
    outputTokens: byKind.reduce((sum, row) => sum + row.outputTokens, 0),
    byKind,
  };
}

/** Every metered call for one account, newest first. */
export async function listUsage(accountId: string) {
  if (!pool) return memory.usage.filter((event) => event.accountId === accountId);
  const result = await pool.query("SELECT * FROM usage_events WHERE account_id=$1 ORDER BY created_at DESC", [accountId]);
  return result.rows.map((row) => ({
    id: row.id, accountId: row.account_id, kind: row.kind, model: row.model,
    inputTokens: row.input_tokens, outputTokens: row.output_tokens,
    requestId: row.request_id ?? undefined, tenderId: row.tender_id ?? undefined,
    createdAt: new Date(row.created_at).toISOString(),
  } as UsageEvent));
}

/**
 * Appends one entry to the audit log.
 *
 * There is deliberately no update or delete counterpart, and the table refuses
 * UPDATE at the database level: a record that can be rewritten is not a record.
 */
export async function recordAudit(input: Omit<AuditEntry, "id" | "createdAt">) {
  const entry: AuditEntry = { ...input, id: randomUUID(), createdAt: new Date().toISOString() };
  if (!pool) { memory.audit.push(entry); return entry; }
  await pool.query(
    `INSERT INTO audit_log(id,account_id,actor,action,subject_type,subject_id,subject_label,metadata,request_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [entry.id, entry.accountId, entry.actor, entry.action, entry.subjectType, entry.subjectId,
     entry.subjectLabel, JSON.stringify(entry.metadata), entry.requestId ?? null],
  );
  return entry;
}

/**
 * One account's audit entries, newest first, optionally narrowed by action and
 * by how far back to look. Never returns another account's rows.
 */
export async function listAudit(accountId: string, filter: { action?: string; since?: Date; limit?: number } = {}) {
  const limit = Math.min(Math.max(filter.limit ?? 200, 1), 500);
  if (!pool) {
    return memory.audit
      .filter((entry) => entry.accountId === accountId)
      .filter((entry) => !filter.action || entry.action === filter.action)
      .filter((entry) => !filter.since || entry.createdAt >= filter.since.toISOString())
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
  }
  const clauses = ["account_id=$1"];
  const values: unknown[] = [accountId];
  if (filter.action) { values.push(filter.action); clauses.push(`action=$${values.length}`); }
  if (filter.since) { values.push(filter.since.toISOString()); clauses.push(`created_at >= $${values.length}`); }
  values.push(limit);
  const result = await pool.query(
    `SELECT * FROM audit_log WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT $${values.length}`,
    values,
  );
  return result.rows.map((row) => ({
    id: row.id, accountId: row.account_id, actor: row.actor, action: row.action,
    subjectType: row.subject_type, subjectId: row.subject_id, subjectLabel: row.subject_label,
    metadata: row.metadata ?? {}, requestId: row.request_id ?? undefined,
    createdAt: new Date(row.created_at).toISOString(),
  } as AuditEntry));
}

/**
 * Records the company's decision. Append-only by construction: changing your
 * mind adds an entry, it does not overwrite the earlier one — the history is
 * the point.
 */
export async function recordBidDecision(input: Omit<BidDecisionRecord, "id" | "createdAt">) {
  const record: BidDecisionRecord = { ...input, id: randomUUID(), createdAt: new Date().toISOString() };
  if (!pool) { memory.bidDecisions.push(record); return record; }
  await pool.query(
    `INSERT INTO bid_decisions(id,tender_id,decision,reason,decided_by,recommendation_at_the_time)
     VALUES($1,$2,$3,$4,$5,$6)`,
    [record.id, record.tenderId, record.decision, record.reason, record.decidedBy, record.recommendationAtTheTime],
  );
  return record;
}

/** The decision history for one tender, newest first. */
export async function listBidDecisions(tenderId: string) {
  if (!pool) {
    return memory.bidDecisions.filter((entry) => entry.tenderId === tenderId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  const result = await pool.query("SELECT * FROM bid_decisions WHERE tender_id=$1 ORDER BY created_at DESC, id", [tenderId]);
  return result.rows.map((row) => ({
    id: row.id, tenderId: row.tender_id, decision: row.decision, reason: row.reason,
    decidedBy: row.decided_by, recommendationAtTheTime: row.recommendation_at_the_time,
    createdAt: new Date(row.created_at).toISOString(),
  } as BidDecisionRecord));
}

/**
 * Adds a notice to the watchlist, or updates the note on one already there.
 * Watching the same notice twice is not an error — it is the same intent.
 */
export async function addToWatchlist(accountId: string, input: Omit<WatchlistEntry, "id" | "accountId" | "createdAt">) {
  const entry: WatchlistEntry = { ...input, id: randomUUID(), accountId, createdAt: new Date().toISOString() };
  if (!pool) {
    const existing = memory.watchlist.find((item) => item.accountId === accountId && item.externalId === input.externalId);
    if (existing) { Object.assign(existing, input); return existing; }
    memory.watchlist.push(entry);
    return entry;
  }
  const result = await pool.query(
    `INSERT INTO watchlist(id,account_id,external_id,title,authority,deadline,source_url,note)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT(account_id,external_id) DO UPDATE SET title=EXCLUDED.title,authority=EXCLUDED.authority,
       deadline=EXCLUDED.deadline,source_url=EXCLUDED.source_url,note=EXCLUDED.note
     RETURNING *`,
    [entry.id, accountId, entry.externalId, entry.title, entry.authority, entry.deadline, entry.sourceUrl, entry.note],
  );
  return toWatchlistEntry(result.rows[0]);
}

const toWatchlistEntry = (row: Record<string, unknown>): WatchlistEntry => ({
  id: String(row.id), accountId: String(row.account_id), externalId: String(row.external_id),
  title: String(row.title), authority: String(row.authority), deadline: String(row.deadline),
  sourceUrl: String(row.source_url), note: String(row.note),
  createdAt: new Date(row.created_at as string).toISOString(),
});

/** Everything this account is watching, newest first. */
export async function listWatchlist(accountId: string) {
  if (!pool) {
    return memory.watchlist.filter((entry) => entry.accountId === accountId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  const result = await pool.query("SELECT * FROM watchlist WHERE account_id=$1 ORDER BY created_at DESC", [accountId]);
  return result.rows.map(toWatchlistEntry);
}

/** Removes a watched notice. Returns false when it was not there to remove. */
export async function removeFromWatchlist(accountId: string, externalId: string) {
  if (!pool) {
    const before = memory.watchlist.length;
    memory.watchlist = memory.watchlist.filter((entry) => !(entry.accountId === accountId && entry.externalId === externalId));
    return memory.watchlist.length < before;
  }
  const result = await pool.query("DELETE FROM watchlist WHERE account_id=$1 AND external_id=$2", [accountId, externalId]);
  return (result.rowCount ?? 0) > 0;
}

const toSavedSearch = (row: Record<string, unknown>): SavedSearch => ({
  id: String(row.id), accountId: String(row.account_id), name: String(row.name),
  filter: (row.filter_json ?? {}) as SavedSearchFilter,
  createdAt: new Date(row.created_at as string).toISOString(),
});

/**
 * Saves a named search. Throws NAME_TAKEN rather than silently overwriting:
 * a name is how a person picks a search, so two of them is a bug not a choice.
 */
export async function createSavedSearch(accountId: string, name: string, filter: SavedSearchFilter) {
  const trimmed = name.trim();
  if (!pool) {
    if (memory.savedSearches.some((entry) => entry.accountId === accountId && entry.name.toLowerCase() === trimmed.toLowerCase())) {
      throw new Error("NAME_TAKEN");
    }
    const entry: SavedSearch = { id: randomUUID(), accountId, name: trimmed, filter, createdAt: new Date().toISOString() };
    memory.savedSearches.push(entry);
    return entry;
  }
  try {
    const result = await pool.query(
      "INSERT INTO saved_searches(id,account_id,name,filter_json) VALUES($1,$2,$3,$4) RETURNING *",
      [randomUUID(), accountId, trimmed, JSON.stringify(filter)],
    );
    return toSavedSearch(result.rows[0]);
  } catch (error) {
    if ((error as { code?: string }).code === "23505") throw new Error("NAME_TAKEN");
    throw error;
  }
}

export async function listSavedSearches(accountId: string) {
  if (!pool) {
    return memory.savedSearches.filter((entry) => entry.accountId === accountId)
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  const result = await pool.query("SELECT * FROM saved_searches WHERE account_id=$1 ORDER BY name", [accountId]);
  return result.rows.map(toSavedSearch);
}

/**
 * Anything that is not a uuid cannot be a row id.
 *
 * Postgres raises 22P02 for a malformed uuid rather than returning no rows, so
 * without this a stale or hand-edited identifier surfaced as a 500 instead of
 * the 404 the caller expects.
 */
const isUuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

export async function getSavedSearch(accountId: string, id: string) {
  if (!isUuid(id)) return null;
  if (!pool) return memory.savedSearches.find((entry) => entry.accountId === accountId && entry.id === id) ?? null;
  const result = await pool.query("SELECT * FROM saved_searches WHERE account_id=$1 AND id=$2", [accountId, id]);
  return result.rows[0] ? toSavedSearch(result.rows[0]) : null;
}

/** Returns false when there was nothing to delete, rather than a quiet success. */
export async function deleteSavedSearch(accountId: string, id: string) {
  if (!isUuid(id)) return false;
  if (!pool) {
    const before = memory.savedSearches.length;
    memory.savedSearches = memory.savedSearches.filter((entry) => !(entry.accountId === accountId && entry.id === id));
    return memory.savedSearches.length < before;
  }
  const result = await pool.query("DELETE FROM saved_searches WHERE account_id=$1 AND id=$2", [accountId, id]);
  return (result.rowCount ?? 0) > 0;
}

const toIngestionRun = (row: Record<string, unknown>): IngestionRun => ({
  id: String(row.id), source: String(row.source),
  noticesSeen: Number(row.notices_seen), noticesParsed: Number(row.notices_parsed),
  fieldCoverage: (row.field_coverage ?? {}) as Record<string, number>,
  alarms: (row.alarms ?? []) as string[],
  createdAt: new Date(row.created_at as string).toISOString(),
});

/** Records what one source yielded on one run, alarms included. */
export async function recordIngestionRun(input: Omit<IngestionRun, "id" | "createdAt">) {
  const run: IngestionRun = { ...input, id: randomUUID(), createdAt: new Date().toISOString() };
  if (!pool) { memory.ingestionRuns.push(run); return run; }
  await pool.query(
    `INSERT INTO ingestion_runs(id,source,notices_seen,notices_parsed,field_coverage,alarms)
     VALUES($1,$2,$3,$4,$5,$6)`,
    [run.id, run.source, run.noticesSeen, run.noticesParsed, JSON.stringify(run.fieldCoverage), JSON.stringify(run.alarms)],
  );
  return run;
}

/** Parsed counts from this source's recent runs, newest first. */
export async function recentIngestionYields(source: string, limit = 10) {
  if (!pool) {
    return memory.ingestionRuns.filter((run) => run.source === source)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit)
      .map((run) => run.noticesParsed);
  }
  const result = await pool.query(
    "SELECT notices_parsed FROM ingestion_runs WHERE source=$1 ORDER BY created_at DESC LIMIT $2",
    [source, limit],
  );
  return result.rows.map((row) => Number(row.notices_parsed));
}

/** The most recent run for each source, for /health. */
export async function latestIngestionRuns(): Promise<IngestionRun[]> {
  if (!pool) {
    const bySource = new Map<string, IngestionRun>();
    for (const run of [...memory.ingestionRuns].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
      bySource.set(run.source, run);
    }
    return [...bySource.values()];
  }
  const result = await pool.query(
    `SELECT DISTINCT ON (source) * FROM ingestion_runs ORDER BY source, created_at DESC`,
  );
  return result.rows.map(toIngestionRun);
}

const toEvidence = (row: Record<string, unknown>): EvidenceRecord => ({
  id: String(row.id), accountId: String(row.account_id), kind: String(row.kind), name: String(row.name),
  content: String(row.content ?? ""), tags: (row.tags ?? []) as string[], verified: Boolean(row.verified),
  filename: (row.filename as string | null) ?? undefined,
  contentType: (row.content_type as string | null) ?? undefined,
  sizeBytes: row.size_bytes === null || row.size_bytes === undefined ? undefined : Number(row.size_bytes),
  issuingBody: (row.issuing_body as string | null) ?? undefined,
  issuedOn: (row.issued_on as string | null) ?? undefined,
  expiresOn: (row.expires_on as string | null) ?? undefined,
});

/**
 * Adds a vault item. `bytes` is the original file when one was uploaded; a
 * text-only item is still a valid item and simply has none.
 */
/** This account's answers to the ESPD declarations. */
export async function listDeclarationAnswers(accountId: string): Promise<DeclarationAnswer[]> {
  if (!pool) return memory.declarations.get(accountId) ?? [];
  const result = await pool.query("SELECT declaration_id, answer, notes FROM declarations WHERE account_id=$1", [accountId]);
  return result.rows.map((row) => ({
    declarationId: String(row.declaration_id),
    answer: (row.answer as "yes" | "no" | null) ?? null,
    notes: String(row.notes ?? ""),
  }));
}

/** Saves the answers as a set: partial edits are how a set drifts out of step. */
export async function saveDeclarationAnswers(accountId: string, answers: DeclarationAnswer[]) {
  if (!pool) { memory.declarations.set(accountId, answers); return answers; }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const answer of answers) {
      await client.query(
        `INSERT INTO declarations(account_id,declaration_id,answer,notes) VALUES($1,$2,$3,$4)
         ON CONFLICT(account_id,declaration_id) DO UPDATE SET answer=EXCLUDED.answer, notes=EXCLUDED.notes`,
        [accountId, answer.declarationId, answer.answer, answer.notes],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return answers;
}

/** The most recent affirmation of the whole set, or null if never affirmed. */
export async function latestAffirmation(accountId: string): Promise<Affirmation | null> {
  if (!pool) return memory.affirmations.get(accountId) ?? null;
  const result = await pool.query(
    "SELECT affirmed_by, created_at FROM declaration_affirmations WHERE account_id=$1 ORDER BY created_at DESC LIMIT 1",
    [accountId],
  );
  const row = result.rows[0];
  return row ? { affirmedBy: String(row.affirmed_by), at: new Date(row.created_at).toISOString() } : null;
}

/** Records an affirmation. Re-affirming adds an entry rather than replacing one. */
export async function recordAffirmation(accountId: string, affirmedBy: string): Promise<Affirmation> {
  const affirmation: Affirmation = { affirmedBy, at: new Date().toISOString() };
  if (!pool) { memory.affirmations.set(accountId, affirmation); return affirmation; }
  await pool.query(
    "INSERT INTO declaration_affirmations(id,account_id,affirmed_by) VALUES($1,$2,$3)",
    [randomUUID(), accountId, affirmedBy],
  );
  return affirmation;
}

const toPersonFact = (row: Record<string, unknown>): PersonFact => ({
  id: String(row.id), personId: String(row.person_id), type: row.record_type as PersonFact["type"],
  value: String(row.value), detail: String(row.detail ?? ""), period: String(row.period ?? ""),
  quote: String(row.quote ?? ""), confidence: row.confidence as PersonFact["confidence"],
  confirmed: Boolean(row.confirmed), createdAt: new Date(row.created_at as string).toISOString(),
});

/**
 * Replaces the parsed records for a person.
 *
 * Confirmed records survive a re-parse: a person corrected them by hand, and
 * throwing that away because a CV was re-uploaded would lose real work.
 */
export async function replacePersonFacts(personId: string, facts: Omit<PersonFact, "id" | "personId" | "createdAt" | "confirmed">[]) {
  if (!pool) {
    const confirmed = memory.personFacts.filter((fact) => fact.personId === personId && fact.confirmed);
    memory.personFacts = memory.personFacts.filter((fact) => fact.personId !== personId);
    memory.personFacts.push(...confirmed);
    for (const fact of facts) {
      const duplicate = confirmed.some((existing) => existing.type === fact.type && existing.value.toLowerCase() === fact.value.toLowerCase());
      if (duplicate) continue;
      memory.personFacts.push({ ...fact, id: randomUUID(), personId, confirmed: false, createdAt: new Date().toISOString() });
    }
    return memory.personFacts.filter((fact) => fact.personId === personId);
  }
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM person_records WHERE person_id=$1 AND confirmed = false", [personId]);
    const existing = await client.query("SELECT record_type, lower(value) AS value FROM person_records WHERE person_id=$1", [personId]);
    const held = new Set(existing.rows.map((row) => `${row.record_type}:${row.value}`));
    for (const fact of facts) {
      if (held.has(`${fact.type}:${fact.value.toLowerCase()}`)) continue;
      await client.query(
        `INSERT INTO person_records(id,person_id,record_type,value,detail,period,quote,confidence)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [randomUUID(), personId, fact.type, fact.value, fact.detail, fact.period, fact.quote, fact.confidence],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return listPersonFacts(personId);
}

/** Every parsed record across an account's people, for the skills matrix. */
export async function listAccountPersonFacts(accountId: string): Promise<PersonFact[]> {
  if (!pool) {
    const ids = new Set([...memory.people.values()].filter((person) => person.accountId === accountId).map((person) => person.id));
    return memory.personFacts.filter((fact) => ids.has(fact.personId));
  }
  const result = await pool.query(
    `SELECT r.* FROM person_records r JOIN people p ON p.id = r.person_id
      WHERE p.account_id=$1 ORDER BY r.record_type, r.value`,
    [accountId],
  );
  return result.rows.map(toPersonFact);
}

export async function listPersonFacts(personId: string): Promise<PersonFact[]> {
  if (!pool) return memory.personFacts.filter((fact) => fact.personId === personId);
  const result = await pool.query("SELECT * FROM person_records WHERE person_id=$1 ORDER BY record_type, value", [personId]);
  return result.rows.map(toPersonFact);
}

/**
 * Confirms or corrects one parsed record. Returns null when the record does not
 * belong to this account, so a cross-tenant edit is a 404 rather than a change.
 */
export async function updatePersonFact(accountId: string, factId: string, patch: { value?: string; detail?: string; confirmed?: boolean }) {
  if (!isUuid(factId)) return null;
  if (!pool) {
    const fact = memory.personFacts.find((entry) => entry.id === factId);
    if (!fact) return null;
    const person = memory.people.get(fact.personId);
    if (!person || person.accountId !== accountId) return null;
    Object.assign(fact, patch);
    return fact;
  }
  const result = await pool.query(
    `UPDATE person_records SET value=COALESCE($3,value), detail=COALESCE($4,detail), confirmed=COALESCE($5,confirmed)
      WHERE id=$1 AND person_id IN (SELECT id FROM people WHERE account_id=$2) RETURNING *`,
    [factId, accountId, patch.value ?? null, patch.detail ?? null, patch.confirmed ?? null],
  );
  return result.rows[0] ? toPersonFact(result.rows[0]) : null;
}

/**
 * Confirms every parsed record for one person at once.
 *
 * Ownership is checked before anything is read back. The UPDATE was already
 * account-scoped, but returning listPersonFacts(personId) afterwards was not —
 * so another account got the records handed to it even though it changed none
 * of them. A scoped write with an unscoped read is still a leak.
 */
export async function confirmAllPersonFacts(accountId: string, personId: string) {
  if (!isUuid(personId)) return [];
  if (!pool) {
    const person = memory.people.get(personId);
    if (!person || person.accountId !== accountId) return [];
    for (const fact of memory.personFacts) if (fact.personId === personId) fact.confirmed = true;
    return memory.personFacts.filter((fact) => fact.personId === personId);
  }
  const owned = await pool.query("SELECT 1 FROM people WHERE id=$1 AND account_id=$2", [personId, accountId]);
  if (owned.rowCount === 0) return [];
  await pool.query("UPDATE person_records SET confirmed = true WHERE person_id=$1", [personId]);
  return listPersonFacts(personId);
}

/**
 * Applies the retention policy.
 *
 * Deletion is by cut-off date per class, in one transaction, and the tenders it
 * removes are named in the result — a job that says "removed 14 things" is not
 * something anyone can check.
 *
 * `dryRun` counts without deleting, so the policy can be inspected against real
 * data before it is ever allowed to remove any.
 */
export async function applyRetention(policy: { id: string; label: string; cutoff: Date }[], options: { dryRun?: boolean } = {}) {
  const dryRun = options.dryRun ?? false;
  const removed: { id: string; label: string; count: number; cutoff: string }[] = [];
  const removedTenders: { id: string; title: string }[] = [];
  if (!pool) return { removed, removedTenders, dryRun };

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const entry of policy) {
      const iso = entry.cutoff.toISOString();
      let count = 0;

      if (entry.id === "closed-tenders") {
        // A tender is closed once its deadline has passed. Documents, answers
        // and provenance go with it through ON DELETE CASCADE.
        const doomed = await client.query(
          `SELECT id, title FROM tenders
            WHERE updated_at < $1
              AND status <> 'SUBMITTED'`,
          [iso],
        );
        removedTenders.push(...doomed.rows.map((row) => ({ id: String(row.id), title: String(row.title) })));
        count = doomed.rowCount ?? 0;
        if (!dryRun && count > 0) {
          await client.query("DELETE FROM tenders WHERE id = ANY($1::uuid[])", [doomed.rows.map((row) => row.id)]);
        }
      } else {
        const table = {
          "usage-events": "usage_events",
          "ingestion-runs": "ingestion_runs",
          notifications: "notifications",
          "audit-log": "audit_log",
        }[entry.id];
        if (!table) continue;
        const counted = await client.query(`SELECT count(*)::int AS n FROM ${table} WHERE created_at < $1`, [iso]);
        count = counted.rows[0]?.n ?? 0;
        if (!dryRun && count > 0) {
          await client.query(`DELETE FROM ${table} WHERE created_at < $1`, [iso]);
        }
      }
      removed.push({ id: entry.id, label: entry.label, count, cutoff: iso });
    }
    await client.query(dryRun ? "ROLLBACK" : "COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  return { removed, removedTenders, dryRun };
}

const toAnswerVersion = (row: Record<string, unknown>): AnswerVersion => ({
  id: String(row.id), answerId: String(row.answer_id), response: String(row.response ?? ""),
  status: String(row.status ?? "draft"),
  provenanceClass: row.provenance_class as AnswerVersion["provenanceClass"],
  actor: String(row.actor ?? ""),
  restoredFrom: (row.restored_from as string | null) ?? undefined,
  createdAt: new Date(row.created_at as string).toISOString(),
});

/**
 * Records one saved state of an answer.
 *
 * Called on every save, including a restore — the point is that no state is
 * ever lost, so there is no path that skips this.
 */
export async function recordAnswerVersion(input: Omit<AnswerVersion, "id" | "createdAt">) {
  const version: AnswerVersion = { ...input, id: randomUUID(), createdAt: new Date().toISOString() };
  if (!pool) { memory.answerVersions.push(version); return version; }
  await pool.query(
    `INSERT INTO answer_versions(id,answer_id,response,status,provenance_class,actor,restored_from)
     VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [version.id, version.answerId, version.response, version.status, version.provenanceClass, version.actor, version.restoredFrom ?? null],
  );
  return version;
}

/** One answer's versions, oldest first. */
export async function listAnswerVersions(answerId: string) {
  if (!pool) {
    return memory.answerVersions.filter((version) => version.answerId === answerId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  const result = await pool.query("SELECT * FROM answer_versions WHERE answer_id=$1 ORDER BY created_at, id", [answerId]);
  return result.rows.map(toAnswerVersion);
}

/** One version, scoped to the account that owns its tender. */
export async function getAnswerVersion(accountId: string, versionId: string) {
  if (!isUuid(versionId)) return null;
  if (!pool) {
    const version = memory.answerVersions.find((entry) => entry.id === versionId);
    if (!version) return null;
    const answer = [...memory.answers.values()].find((entry) => entry.id === version.answerId);
    const tender = answer ? memory.tenders.get(answer.tenderId) : undefined;
    return tender?.accountId === accountId ? version : null;
  }
  const result = await pool.query(
    `SELECT v.* FROM answer_versions v
       JOIN bid_answers a ON a.id = v.answer_id
       JOIN tenders t ON t.id = a.tender_id
      WHERE v.id=$1 AND t.account_id=$2`,
    [versionId, accountId],
  );
  return result.rows[0] ? toAnswerVersion(result.rows[0]) : null;
}

const toMockEvaluation = (row: Record<string, unknown>): MockEvaluation => ({
  id: String(row.id), tenderId: String(row.tender_id),
  criteria: (row.criteria ?? []) as MockEvaluation["criteria"],
  total: Number(row.total), notice: "", actor: String(row.actor ?? ""),
  createdAt: new Date(row.created_at as string).toISOString(),
});

/** Records one mock evaluation. Runs accumulate: the movement is the point. */
export async function recordMockEvaluation(input: Omit<MockEvaluation, "id" | "createdAt" | "notice">) {
  const record: MockEvaluation = { ...input, notice: "", id: randomUUID(), createdAt: new Date().toISOString() };
  if (!pool) { memory.mockEvaluations.push(record); return record; }
  await pool.query(
    "INSERT INTO mock_evaluations(id,tender_id,criteria,total,actor) VALUES($1,$2,$3,$4,$5)",
    [record.id, record.tenderId, JSON.stringify(record.criteria), record.total, record.actor],
  );
  return record;
}

/** One tender's evaluation runs, newest first. */
export async function listMockEvaluations(tenderId: string) {
  if (!pool) {
    // Two runs can land in the same millisecond, so insertion order breaks the
    // tie: reverse first, then sort stably, and the later run stays first.
    return memory.mockEvaluations.filter((entry) => entry.tenderId === tenderId)
      .reverse()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  const result = await pool.query("SELECT * FROM mock_evaluations WHERE tender_id=$1 ORDER BY created_at DESC", [tenderId]);
  return result.rows.map(toMockEvaluation);
}

const toPackQuestion = (row: Record<string, unknown>): PackQuestion => ({
  id: String(row.id), tenderId: String(row.tender_id), question: String(row.question),
  answer: String(row.answer ?? ""), citations: (row.citations ?? []) as PackQuestion["citations"],
  actor: String(row.actor ?? ""), createdAt: new Date(row.created_at as string).toISOString(),
});

/** Records one question asked of the pack, with the answer it produced. */
export async function recordPackQuestion(input: Omit<PackQuestion, "id" | "createdAt">) {
  const record: PackQuestion = { ...input, id: randomUUID(), createdAt: new Date().toISOString() };
  if (!pool) { memory.packQuestions.push(record); return record; }
  await pool.query(
    "INSERT INTO pack_questions(id,tender_id,question,answer,citations,actor) VALUES($1,$2,$3,$4,$5,$6)",
    [record.id, record.tenderId, record.question, record.answer, JSON.stringify(record.citations), record.actor],
  );
  return record;
}

/** Everything asked of this pack, newest first. */
export async function listPackQuestions(tenderId: string) {
  if (!pool) {
    return memory.packQuestions.filter((entry) => entry.tenderId === tenderId)
      .reverse()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  const result = await pool.query("SELECT * FROM pack_questions WHERE tender_id=$1 ORDER BY created_at DESC", [tenderId]);
  return result.rows.map(toPackQuestion);
}

const toAnalysisVersion = (row: Record<string, unknown>): AnalysisVersionRecord => ({
  id: String(row.id), tenderId: String(row.tender_id), analysis: row.analysis as TenderAnalysis,
  promptVersion: String(row.prompt_version ?? ""), schemaVersion: String(row.schema_version ?? ""),
  actor: String(row.actor ?? ""), createdAt: new Date(row.created_at as string).toISOString(),
});

/** Keeps the analysis that was just produced, alongside the current pointer. */
export async function recordAnalysisVersion(input: Omit<AnalysisVersionRecord, "id" | "createdAt">) {
  const record: AnalysisVersionRecord = { ...input, id: randomUUID(), createdAt: new Date().toISOString() };
  if (!pool) { memory.analysisVersions.push(record); return record; }
  await pool.query(
    "INSERT INTO analysis_versions(id,tender_id,analysis,prompt_version,schema_version,actor) VALUES($1,$2,$3,$4,$5,$6)",
    [record.id, record.tenderId, JSON.stringify(record.analysis), record.promptVersion, record.schemaVersion, record.actor],
  );
  return record;
}

/** One tender's analyses, newest first. */
export async function listAnalysisVersions(tenderId: string) {
  if (!pool) {
    return memory.analysisVersions.filter((entry) => entry.tenderId === tenderId)
      .slice().reverse()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  const result = await pool.query("SELECT * FROM analysis_versions WHERE tender_id=$1 ORDER BY created_at DESC", [tenderId]);
  return result.rows.map(toAnalysisVersion);
}

/** One stored analysis, scoped to the account that owns its tender. */
export async function getAnalysisVersion(accountId: string, versionId: string) {
  if (!isUuid(versionId)) return null;
  if (!pool) {
    const version = memory.analysisVersions.find((entry) => entry.id === versionId);
    if (!version) return null;
    return memory.tenders.get(version.tenderId)?.accountId === accountId ? version : null;
  }
  const result = await pool.query(
    `SELECT v.* FROM analysis_versions v JOIN tenders t ON t.id = v.tender_id
      WHERE v.id=$1 AND t.account_id=$2`,
    [versionId, accountId],
  );
  return result.rows[0] ? toAnalysisVersion(result.rows[0]) : null;
}

const toClarification = (row: Record<string, unknown>): Clarification => ({
  id: String(row.id), tenderId: String(row.tender_id), question: String(row.question),
  askedOn: String(row.asked_on ?? ""), askedBy: String(row.asked_by ?? ""),
  response: String(row.response ?? ""), respondedOn: String(row.responded_on ?? ""),
  createdAt: new Date(row.created_at as string).toISOString(),
});

export async function recordClarification(input: Omit<Clarification, "id" | "createdAt">) {
  const record: Clarification = { ...input, id: randomUUID(), createdAt: new Date().toISOString() };
  if (!pool) { memory.clarifications.push(record); return record; }
  await pool.query(
    "INSERT INTO clarifications(id,tender_id,question,asked_on,asked_by,response,responded_on) VALUES($1,$2,$3,$4,$5,$6,$7)",
    [record.id, record.tenderId, record.question, record.askedOn, record.askedBy, record.response, record.respondedOn],
  );
  return record;
}

/** Records the buyer's answer. Returns null when it is not this account's. */
export async function answerClarification(accountId: string, clarificationId: string, response: string, respondedOn: string) {
  if (!isUuid(clarificationId)) return null;
  if (!pool) {
    const record = memory.clarifications.find((entry) => entry.id === clarificationId);
    if (!record) return null;
    if (memory.tenders.get(record.tenderId)?.accountId !== accountId) return null;
    record.response = response;
    record.respondedOn = respondedOn;
    return record;
  }
  const result = await pool.query(
    `UPDATE clarifications SET response=$3, responded_on=$4
      WHERE id=$1 AND tender_id IN (SELECT id FROM tenders WHERE account_id=$2) RETURNING *`,
    [clarificationId, accountId, response, respondedOn],
  );
  return result.rows[0] ? toClarification(result.rows[0]) : null;
}

export async function listClarifications(tenderId: string) {
  if (!pool) {
    return memory.clarifications.filter((entry) => entry.tenderId === tenderId)
      .slice().reverse()
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  const result = await pool.query("SELECT * FROM clarifications WHERE tender_id=$1 ORDER BY created_at DESC", [tenderId]);
  return result.rows.map(toClarification);
}

export async function addEvidence(
  accountId: string,
  input: Omit<EvidenceRecord, "id" | "accountId">,
  bytes?: Buffer,
) {
  const record: EvidenceRecord = { ...input, id: randomUUID(), accountId };
  if (!pool) {
    memory.evidence.set(record.id, record);
    if (bytes) memoryEvidenceFiles.set(record.id, bytes);
    return record;
  }
  await pool.query(
    `INSERT INTO evidence_library(id,account_id,kind,name,content,tags,verified,bytes,content_type,filename,size_bytes,issuing_body,issued_on,expires_on)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [record.id, accountId, record.kind, record.name, record.content, JSON.stringify(record.tags), record.verified,
     bytes ?? null, record.contentType ?? null, record.filename ?? null, record.sizeBytes ?? null,
     record.issuingBody ?? null, record.issuedOn ?? null, record.expiresOn ?? null],
  );
  return record;
}

/** In-memory mode keeps files beside the rows; Postgres keeps them in the row. */
const memoryEvidenceFiles = new Map<string, Buffer>();

/**
 * The original file for one vault item, scoped to its account.
 *
 * Returns null both when the item does not exist and when it belongs to someone
 * else: a cross-tenant request must not be able to tell the difference.
 */
export async function evidenceFile(accountId: string, evidenceId: string) {
  if (!pool) {
    const record = memory.evidence.get(evidenceId);
    if (!record || record.accountId !== accountId) return null;
    const bytes = memoryEvidenceFiles.get(evidenceId);
    return bytes ? { record, bytes } : null;
  }
  const result = await pool.query("SELECT * FROM evidence_library WHERE id=$1 AND account_id=$2", [evidenceId, accountId]);
  const row = result.rows[0];
  if (!row?.bytes) return null;
  return { record: toEvidence(row), bytes: row.bytes as Buffer };
}

export async function listEvidence(accountId: string) {
  if (!pool) return [...memory.evidence.values()].filter((item) => item.accountId === accountId);
  // The file bytes are deliberately not selected: a list of twenty certificates
  // would otherwise pull tens of megabytes through for a screen that shows names.
  const result = await pool.query(
    `SELECT id, account_id, kind, name, content, tags, verified, content_type, filename, size_bytes,
            issuing_body, issued_on, expires_on
       FROM evidence_library WHERE account_id=$1 ORDER BY updated_at DESC`,
    [accountId],
  );
  return result.rows.map(toEvidence);
}

export async function setEvidenceVerified(accountId: string, evidenceId: string, verified: boolean) {
  if (!pool) {
    const item = memory.evidence.get(evidenceId);
    if (!item || item.accountId !== accountId) return null;
    const updated = { ...item, verified };
    memory.evidence.set(evidenceId, updated);
    return updated;
  }
  const result = await pool.query(
    "UPDATE evidence_library SET verified=$3,updated_at=now() WHERE id=$1 AND account_id=$2 RETURNING *",
    [evidenceId, accountId, verified],
  );
  const row = result.rows[0];
  return row ? { id: row.id, accountId: row.account_id, kind: row.kind, name: row.name, content: row.content, tags: row.tags ?? [], verified: row.verified } as EvidenceRecord : null;
}

export async function addPerson(accountId: string, input: Omit<PersonRecord, "id" | "accountId">) {
  const record: PersonRecord = { ...input, id: randomUUID(), accountId };
  if (!pool) { memory.people.set(record.id, record); return record; }
  await pool.query("INSERT INTO people(id,account_id,name,title,cv_text,skills,email,phone) VALUES($1,$2,$3,$4,$5,$6,$7,$8)", [record.id, accountId, record.name, record.title, record.cvText, JSON.stringify(record.skills), record.email ?? null, record.phone ?? null]);
  return record;
}

const toPerson = (row: Record<string, unknown>): PersonRecord => ({
  id: String(row.id), accountId: String(row.account_id), name: String(row.name), title: String(row.title ?? ""),
  cvText: String(row.cv_text ?? ""), skills: (row.skills ?? []) as string[],
  email: (row.email as string | null) ?? undefined,
  phone: (row.phone as string | null) ?? undefined,
  archivedAt: row.archived_at ? new Date(row.archived_at as string).toISOString() : undefined,
});

/**
 * The people on this account.
 *
 * Archived people are included by default because the screens that list them
 * need to show them as archived; matching filters them out explicitly, which
 * keeps the exclusion visible at the point where it matters.
 */
export async function listPeople(accountId: string, options: { includeArchived?: boolean } = {}) {
  const includeArchived = options.includeArchived ?? true;
  if (!pool) {
    return [...memory.people.values()]
      .filter((item) => item.accountId === accountId)
      .filter((item) => includeArchived || !item.archivedAt);
  }
  const result = await pool.query(
    `SELECT * FROM people WHERE account_id=$1 ${includeArchived ? "" : "AND archived_at IS NULL"} ORDER BY updated_at DESC`,
    [accountId],
  );
  return result.rows.map(toPerson);
}

/** People available for role matching: never the archived ones. */
export const listActivePeople = (accountId: string) => listPeople(accountId, { includeArchived: false });

/** Edits the fields a person's record carries. Returns null when not theirs. */
export async function updatePerson(
  accountId: string,
  personId: string,
  patch: { name?: string; title?: string; email?: string; phone?: string },
) {
  if (!isUuid(personId)) return null;
  if (!pool) {
    const record = memory.people.get(personId);
    if (!record || record.accountId !== accountId) return null;
    Object.assign(record, patch);
    return record;
  }
  const result = await pool.query(
    `UPDATE people SET name=COALESCE($3,name), title=COALESCE($4,title), email=COALESCE($5,email),
            phone=COALESCE($6,phone), updated_at=now()
      WHERE id=$1 AND account_id=$2 RETURNING *`,
    [personId, accountId, patch.name ?? null, patch.title ?? null, patch.email ?? null, patch.phone ?? null],
  );
  return result.rows[0] ? toPerson(result.rows[0]) : null;
}

/**
 * Archives or reinstates a person. Never deletes: a submitted bid named them,
 * and the record of what the buyer received must stay intact.
 */
export async function setPersonArchived(accountId: string, personId: string, archived: boolean) {
  if (!isUuid(personId)) return null;
  if (!pool) {
    const record = memory.people.get(personId);
    if (!record || record.accountId !== accountId) return null;
    record.archivedAt = archived ? new Date().toISOString() : undefined;
    return record;
  }
  const result = await pool.query(
    "UPDATE people SET archived_at=$3, updated_at=now() WHERE id=$1 AND account_id=$2 RETURNING *",
    [personId, accountId, archived ? new Date().toISOString() : null],
  );
  return result.rows[0] ? toPerson(result.rows[0]) : null;
}

export async function saveNotification(accountId: string, externalId: string, title: string, sourceUrl: string, matchScore: number, payload: Record<string, unknown>) {
  const key = `${accountId}:${externalId}`;
  if (!pool) {
    const existing = memory.notifications.get(key);
    if (existing) return existing;
    const record: NotificationRow = { id: randomUUID(), accountId, externalId, title, sourceUrl, matchScore, payload, read: false, createdAt: new Date().toISOString() };
    memory.notifications.set(key, record);
    return record;
  }
  const result = await pool.query(
    `INSERT INTO notifications(id,account_id,external_id,title,source_url,match_score,payload) VALUES($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT(account_id,external_id) DO UPDATE SET match_score=EXCLUDED.match_score,payload=EXCLUDED.payload RETURNING *`,
    [randomUUID(), accountId, externalId, title, sourceUrl, matchScore, JSON.stringify(payload)],
  );
  const row = result.rows[0];
  return { id: row.id, accountId: row.account_id, externalId: row.external_id, title: row.title, sourceUrl: row.source_url, matchScore: row.match_score, payload: row.payload, read: row.read, createdAt: row.created_at } as NotificationRow;
}

export async function listNotifications(accountId: string) {
  if (!pool) return [...memory.notifications.values()].filter((item) => item.accountId === accountId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const result = await pool.query("SELECT * FROM notifications WHERE account_id=$1 ORDER BY created_at DESC LIMIT 100", [accountId]);
  return result.rows.map((row) => ({ id: row.id, accountId: row.account_id, externalId: row.external_id, title: row.title, sourceUrl: row.source_url, matchScore: row.match_score, payload: row.payload, read: row.read, createdAt: row.created_at } as NotificationRow));
}

/**
 * One-off data migration for TLY-40.
 *
 * Analyses written before schema version 2 carry question and checklist ids the
 * model invented, and `bid_answers` plus `metadata.checklistOverrides` are keyed
 * on them. Re-keying both together preserves work a human already reviewed;
 * without it the first re-analysis silently orphans every saved answer.
 *
 * Idempotent: a tender already on the current version is skipped.
 */
export async function migrateAnalysisSchema(): Promise<{ tenders: number; answers: number; overrides: number }> {
  const counts = { tenders: 0, answers: 0, overrides: 0 };

  const remapOne = (record: TenderRecord, answers: BidAnswer[]) => {
    if (!record.analysis || !needsMigration(record.analysis)) return null;
    const { analysis, questionIdMap, checklistIdMap } = remapLegacyAnalysis(record.analysis);
    const overrides = (record.metadata.checklistOverrides ?? {}) as Record<string, string>;
    const nextOverrides: Record<string, string> = {};
    for (const [oldId, value] of Object.entries(overrides)) {
      const mapped = checklistIdMap.get(oldId) ?? oldId;
      nextOverrides[mapped] = value;
      if (mapped !== oldId) counts.overrides++;
    }
    const answerUpdates = answers
      .map((answer) => ({ answer, next: questionIdMap.get(answer.questionId) }))
      .filter((entry): entry is { answer: BidAnswer; next: string } => Boolean(entry.next) && entry.next !== entry.answer.questionId);
    return { analysis, nextOverrides, answerUpdates };
  };

  if (!pool) {
    for (const record of memory.tenders.values()) {
      const answers = [...memory.answers.values()].filter((answer) => answer.tenderId === record.id);
      const result = remapOne(record, answers);
      if (!result) continue;
      record.analysis = result.analysis;
      record.metadata = { ...record.metadata, checklistOverrides: result.nextOverrides };
      for (const { answer, next } of result.answerUpdates) {
        memory.answers.delete(`${answer.tenderId}:${answer.questionId}`);
        answer.questionId = next;
        memory.answers.set(`${answer.tenderId}:${next}`, answer);
        counts.answers++;
      }
      counts.tenders++;
    }
    return counts;
  }

  const tenders = await pool.query("SELECT * FROM tenders WHERE analysis IS NOT NULL");
  for (const row of tenders.rows) {
    const record = mapTenderRow(row);
    const answerRows = await pool.query("SELECT * FROM bid_answers WHERE tender_id=$1", [record.id]);
    const answers = answerRows.rows.map((answerRow) => ({
      id: answerRow.id, tenderId: answerRow.tender_id, questionId: answerRow.question_id,
      response: answerRow.response, status: answerRow.status, evidence: answerRow.evidence_json ?? [],
    } as BidAnswer));
    const result = remapOne(record, answers);
    if (!result) continue;
    await pool.query(
      "UPDATE tenders SET analysis=$2, metadata=$3, updated_at=now() WHERE id=$1",
      [record.id, JSON.stringify(result.analysis), JSON.stringify({ ...record.metadata, checklistOverrides: result.nextOverrides })],
    );
    for (const { answer, next } of result.answerUpdates) {
      await pool.query("UPDATE bid_answers SET question_id=$2 WHERE id=$1", [answer.id, next]);
      counts.answers++;
    }
    counts.tenders++;
  }
  return counts;
}

const EMPTY_PREFERENCES: DiscoveryPreferences = { sectors: [], keywords: [], cpvCodes: [], valueMin: null, valueMax: null };

export async function getPreferences(accountId: string): Promise<DiscoveryPreferences> {
  if (!pool) return memory.preferences.get(accountId) ?? { ...EMPTY_PREFERENCES };
  const result = await pool.query("SELECT * FROM discovery_preferences WHERE account_id=$1", [accountId]);
  const row = result.rows[0];
  if (!row) return { ...EMPTY_PREFERENCES };
  return {
    sectors: row.sectors ?? [],
    keywords: row.keywords ?? [],
    cpvCodes: row.cpv_codes ?? [],
    valueMin: row.value_min === null ? null : Number(row.value_min),
    valueMax: row.value_max === null ? null : Number(row.value_max),
  };
}

export async function savePreferences(accountId: string, preferences: DiscoveryPreferences): Promise<DiscoveryPreferences> {
  if (!pool) {
    memory.preferences.set(accountId, preferences);
    return preferences;
  }
  await pool.query(
    `INSERT INTO discovery_preferences(account_id,sectors,keywords,cpv_codes,value_min,value_max,updated_at)
     VALUES($1,$2,$3,$4,$5,$6,now())
     ON CONFLICT (account_id) DO UPDATE SET sectors=$2, keywords=$3, cpv_codes=$4, value_min=$5, value_max=$6, updated_at=now()`,
    [accountId, JSON.stringify(preferences.sectors), JSON.stringify(preferences.keywords), JSON.stringify(preferences.cpvCodes), preferences.valueMin, preferences.valueMax],
  );
  return preferences;
}

/**
 * Award history is shared reference data, not tenant-scoped — see
 * migrations/003_award_history.sql. Upserts on (source, external_id) so a
 * re-import of the same quarterly file updates rather than duplicates.
 */
/**
 * Award history is shared reference data, not tenant-scoped — see
 * migrations/003_award_history.sql. Upserts on (source, external_id) so a
 * re-import of the same quarterly file updates rather than duplicates.
 *
 * Rows are written in one multi-row statement per batch. One INSERT per row
 * against a hosted database turns a 200,000-row quarterly file into hours of
 * round trips.
 */
export async function saveAwards(records: import("./sources/ogp.js").AwardRecord[]): Promise<{ inserted: number; updated: number }> {
  const counts = { inserted: 0, updated: 0 };
  if (records.length === 0) return counts;
  const { awardId, AWARD_DATA_ATTRIBUTION } = await import("./sources/ogp.js");

  if (!pool) {
    for (const r of records) {
      const key = `ogp:${r.externalId}`;
      if (memory.awards.has(key)) counts.updated++; else counts.inserted++;
      memory.awards.set(key, { ...r, id: awardId(r.externalId), source: "ogp", licenceNote: AWARD_DATA_ATTRIBUTION });
    }
    return counts;
  }

  const COLUMNS = 16;
  const values: unknown[] = [];
  const tuples: string[] = [];
  records.forEach((r, index) => {
    const base = index * COLUMNS;
    tuples.push(`($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10},$${base + 11},$${base + 12},$${base + 13},$${base + 14},$${base + 15},$${base + 16})`);
    values.push(
      awardId(r.externalId), "ogp", r.externalId, r.authority, r.title, r.cpv, r.cpvDescription,
      r.procedure, r.publishedOn, r.awardedOn, r.awardedValue, r.estimatedValue, r.suppliers,
      r.bidsReceived, r.smeBidsReceived, AWARD_DATA_ATTRIBUTION,
    );
  });

  const result = await pool.query(
    `INSERT INTO award_history(id,source,external_id,authority,title,cpv,cpv_description,procedure,published_on,awarded_on,awarded_value,estimated_value,suppliers,bids_received,sme_bids_received,licence_note)
     VALUES ${tuples.join(",")}
     ON CONFLICT (source, external_id) DO UPDATE SET
       authority=EXCLUDED.authority, title=EXCLUDED.title, cpv=EXCLUDED.cpv,
       cpv_description=EXCLUDED.cpv_description, procedure=EXCLUDED.procedure,
       published_on=EXCLUDED.published_on, awarded_on=EXCLUDED.awarded_on,
       awarded_value=EXCLUDED.awarded_value, estimated_value=EXCLUDED.estimated_value,
       suppliers=EXCLUDED.suppliers, bids_received=EXCLUDED.bids_received,
       sme_bids_received=EXCLUDED.sme_bids_received
     RETURNING (xmax = 0) AS inserted`,
    values,
  );
  for (const row of result.rows) { if (row.inserted) counts.inserted++; else counts.updated++; }
  return counts;
}

export async function countAwards(): Promise<number> {
  if (!pool) return memory.awards.size;
  const result = await pool.query("SELECT count(*)::int AS n FROM award_history");
  return result.rows[0]?.n ?? 0;
}

export type AwardIntelligence = {
  awards: number;
  medianValue: number | null;
  minValue: number | null;
  maxValue: number | null;
  topSuppliers: { supplier: string; awards: number }[];
  relatedCpv: boolean;
  licenceNote: string;
};

/**
 * What this authority has awarded under this CPV. Every figure is a count or a
 * statistic over stored rows — never a model's narration — and an empty sample
 * returns zero awards rather than a reassuring guess.
 *
 * Falls back to the CPV division (first two digits) when the exact code has no
 * history, flagged as related so the caller can say which it is.
 */
export async function awardIntelligence(authority: string, cpv: string, years = 5): Promise<AwardIntelligence> {
  const { AWARD_DATA_ATTRIBUTION } = await import("./sources/ogp.js");
  const empty: AwardIntelligence = { awards: 0, medianValue: null, minValue: null, maxValue: null, topSuppliers: [], relatedCpv: false, licenceNote: AWARD_DATA_ATTRIBUTION };
  if (!authority.trim()) return empty;

  if (!pool) {
    const rows = [...memory.awards.values()] as Record<string, unknown>[];
    const match = (row: Record<string, unknown>, prefix: string) =>
      String(row.authority ?? "").toLowerCase() === authority.toLowerCase() &&
      String(row.cpv ?? "").startsWith(prefix);
    let hits = rows.filter((r) => match(r, cpv));
    let related = false;
    if (hits.length === 0 && cpv.length >= 2) {
      hits = rows.filter((r) => match(r, cpv.slice(0, 2)));
      related = hits.length > 0;
    }
    if (hits.length === 0) return empty;
    const values = hits.map((r) => Number(r.awardedValue)).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
    const counts = new Map<string, number>();
    for (const r of hits) {
      const supplier = String(r.suppliers ?? "").trim();
      if (supplier) counts.set(supplier, (counts.get(supplier) ?? 0) + 1);
    }
    return {
      awards: hits.length,
      medianValue: values.length ? values[Math.floor(values.length / 2)] : null,
      minValue: values.length ? values[0] : null,
      maxValue: values.length ? values[values.length - 1] : null,
      topSuppliers: [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([supplier, awards]) => ({ supplier, awards })),
      relatedCpv: related,
      licenceNote: AWARD_DATA_ATTRIBUTION,
    };
  }

  const run = (prefix: string) => pool!.query(
    `SELECT count(*)::int AS awards,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY awarded_value) AS median_value,
            min(awarded_value) AS min_value, max(awarded_value) AS max_value
       FROM award_history
      WHERE lower(authority) = lower($1) AND cpv LIKE $2`,
    [authority, prefix + "%"],
  );

  let prefix = cpv;
  let stats = await run(prefix);
  let related = false;
  if ((stats.rows[0]?.awards ?? 0) === 0 && cpv.length >= 2) {
    prefix = cpv.slice(0, 2);
    stats = await run(prefix);
    related = (stats.rows[0]?.awards ?? 0) > 0;
  }
  const row = stats.rows[0];
  if (!row || row.awards === 0) return empty;

  const suppliers = await pool.query(
    `SELECT suppliers AS supplier, count(*)::int AS awards
       FROM award_history
      WHERE lower(authority) = lower($1) AND cpv LIKE $2 AND suppliers <> ''
      GROUP BY suppliers ORDER BY awards DESC, supplier ASC LIMIT 3`,
    [authority, prefix + "%"],
  );

  return {
    awards: row.awards,
    medianValue: row.median_value === null ? null : Number(row.median_value),
    minValue: row.min_value === null ? null : Number(row.min_value),
    maxValue: row.max_value === null ? null : Number(row.max_value),
    topSuppliers: suppliers.rows.map((r) => ({ supplier: r.supplier, awards: r.awards })),
    relatedCpv: related,
    licenceNote: AWARD_DATA_ATTRIBUTION,
  };
}

/** How many of this authority's awards name the company itself. */
/**
 * Authorities this company has won work from before, lower-cased for matching.
 *
 * Used only as a scoring signal, so an empty result is a normal answer rather
 * than a failure: most companies have no award history in the dataset.
 */
export async function knownBuyersFor(companyName: string): Promise<string[]> {
  const name = companyName.trim();
  if (!name) return [];
  if (!pool) {
    return [...new Set([...memory.awards.values()]
      .filter((entry) => String((entry as Record<string, unknown>).suppliers ?? "").toLowerCase().includes(name.toLowerCase()))
      .map((entry) => String((entry as Record<string, unknown>).authority ?? "").toLowerCase())
      .filter(Boolean))];
  }
  const result = await pool.query(
    "SELECT DISTINCT lower(authority) AS authority FROM award_history WHERE lower(suppliers) LIKE lower($1)",
    ["%" + name + "%"],
  );
  return result.rows.map((row) => String(row.authority)).filter(Boolean);
}

export async function companyWonBefore(authority: string, companyName: string): Promise<number> {
  const name = companyName.trim();
  if (!name || !authority.trim()) return 0;
  if (!pool) {
    return [...memory.awards.values()].filter((entry) => {
      const row = entry as Record<string, unknown>;
      return String(row.authority ?? "").toLowerCase() === authority.toLowerCase() &&
        String(row.suppliers ?? "").toLowerCase().includes(name.toLowerCase());
    }).length;
  }
  const result = await pool.query(
    `SELECT count(*)::int AS n FROM award_history
      WHERE lower(authority) = lower($1) AND lower(suppliers) LIKE lower($2)`,
    [authority, "%" + name + "%"],
  );
  return result.rows[0]?.n ?? 0;
}
