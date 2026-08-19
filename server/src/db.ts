import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { needsMigration, remapLegacyAnalysis } from "./analysis-schema.js";
import type {
  DiscoveryPreferences, BidAnswer, CompanyProfile, EvidenceRecord, PersonRecord, StoredDocument, TenderAnalysis, TenderRecord } from "./types.js";

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
  evidence: new Map<string, EvidenceRecord>(),
  people: new Map<string, PersonRecord>(),
  notifications: new Map<string, NotificationRow>(),
};

export async function initializeDatabase() {
  if (!pool) return;
  // Every migration, in filename order. Each is written to be idempotent, so a
  // restart re-applies them harmlessly — and CI applies the same set with psql.
  const dir = path.resolve(process.cwd(), "migrations");
  const files = (await readdir(dir)).filter((name) => name.endsWith(".sql")).sort();
  for (const file of files) {
    await pool.query(await readFile(path.join(dir, file), "utf8"));
  }
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
  if (!pool) {
    const existing = [...memory.tenders.values()].find((item) => item.accountId === accountId && item.source === tender.source && item.externalId === tender.externalId);
    const record: TenderRecord = { ...tender, id: existing?.id ?? tender.id ?? randomUUID(), accountId, analysis: tender.analysis ?? existing?.analysis ?? null };
    memory.tenders.set(record.id, record);
    return record;
  }
  const id = tender.id ?? randomUUID();
  const result = await pool.query(
    `INSERT INTO tenders(id,account_id,source,external_id,source_url,title,authority,description,procedure,deadline,published,estimated_value,status,metadata,analysis)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'IMPORTED',$13,$14)
     ON CONFLICT(account_id,source,external_id) DO UPDATE SET source_url=EXCLUDED.source_url,title=EXCLUDED.title,authority=EXCLUDED.authority,description=EXCLUDED.description,procedure=EXCLUDED.procedure,deadline=EXCLUDED.deadline,published=EXCLUDED.published,estimated_value=EXCLUDED.estimated_value,metadata=EXCLUDED.metadata,analysis=COALESCE(EXCLUDED.analysis,tenders.analysis),updated_at=now()
     RETURNING *`,
    [id, accountId, tender.source, tender.externalId || null, tender.sourceUrl, tender.title, tender.authority, tender.description, tender.procedure, tender.deadline, tender.published, tender.estimatedValue, JSON.stringify(tender.metadata), tender.analysis ? JSON.stringify(tender.analysis) : null],
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
