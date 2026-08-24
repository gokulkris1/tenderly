import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { needsMigration, remapLegacyAnalysis } from "./analysis-schema.js";
import { allCpvCodes, cpvAncestors, normaliseCpv } from "./cpv.js";
import { canonicalKey } from "./dedupe.js";
import type {
  AuditEntry,
  BidAnswer,
  CompanyProfile,
  DiscoveryPreferences,
  EvidenceRecord,
  PersonRecord,
  ProvenanceEntry,
  PublicTender,
  StoredDocument,
  TenderAnalysis,
  TenderRecord,
  UsageEvent,
  UsageTotals,
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

export async function addEvidence(accountId: string, input: Omit<EvidenceRecord, "id" | "accountId">) {
  const record: EvidenceRecord = { ...input, id: randomUUID(), accountId };
  if (!pool) { memory.evidence.set(record.id, record); return record; }
  await pool.query("INSERT INTO evidence_library(id,account_id,kind,name,content,tags,verified) VALUES($1,$2,$3,$4,$5,$6,$7)", [record.id, accountId, record.kind, record.name, record.content, JSON.stringify(record.tags), record.verified]);
  return record;
}

export async function listEvidence(accountId: string) {
  if (!pool) return [...memory.evidence.values()].filter((item) => item.accountId === accountId);
  const result = await pool.query("SELECT * FROM evidence_library WHERE account_id=$1 ORDER BY updated_at DESC", [accountId]);
  return result.rows.map((row) => ({ id: row.id, accountId: row.account_id, kind: row.kind, name: row.name, content: row.content, tags: row.tags ?? [], verified: row.verified } as EvidenceRecord));
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
  await pool.query("INSERT INTO people(id,account_id,name,title,cv_text,skills) VALUES($1,$2,$3,$4,$5,$6)", [record.id, accountId, record.name, record.title, record.cvText, JSON.stringify(record.skills)]);
  return record;
}

export async function listPeople(accountId: string) {
  if (!pool) return [...memory.people.values()].filter((item) => item.accountId === accountId);
  const result = await pool.query("SELECT * FROM people WHERE account_id=$1 ORDER BY updated_at DESC", [accountId]);
  return result.rows.map((row) => ({ id: row.id, accountId: row.account_id, name: row.name, title: row.title, cvText: row.cv_text, skills: row.skills ?? [] } as PersonRecord));
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
