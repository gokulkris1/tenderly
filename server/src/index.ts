import "dotenv/config";
import express, { type Request, type Response } from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import multer from "multer";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { accountId, actorEmail, requireAuth, signToken, type AuthenticatedRequest } from "./auth.js";
import { aiConfigured, aiModel, analyseTender, critiqueBidAnswer, draftBidAnswer } from "./ai.js";
import { badgeFor, classForHumanEdit } from "./provenance.js";
import { DRAFTING_PROMPT_VERSION } from "./prompts/index.js";
import { SECTOR_PRESETS, matchNotice, profileCpvCodes, profileKeywords } from "./sectors.js";
import { searchTed } from "./sources/ted.js";
import { combineSourceText, extractDocumentText } from "./documents.js";
import { discoverETenders, fetchPublicTenderDocuments, importETender, scoreTenderPreview } from "./etenders.js";
import {
  addEvidence,
  addPerson,
  awardIntelligence,
  companyWonBefore,
  createUser,
  findUserByEmail,
  getCompany,
  getPreferences,
  getTender,
  getUserById,
  initializeDatabase,
  listAnswers,
  listAudit,
  listDocuments,
  listEvidence,
  listNotifications,
  listPeople,
  listProvenance,
  listTenders,
  migrateAnalysisSchema,
  monthlyUsage,
  persistentDatabase,
  recordProvenance,
  saveAnswer,
  saveDocument,
  savePreferences,
  saveTenderAnalysis,
  setEvidenceVerified,
  tenderProvenance,
  updateCompany,
  updateTenderMetadata,
  upsertTender,
} from "./db.js";
import { AUDIT_ACTIONS, audit } from "./audit.js";
import { analysisHourlyLimiter, analysisLimiter, draftHourlyLimiter, draftLimiter, importLimiter, packLimiter } from "./limits.js";
import { runDiscoveryJob } from "./jobs.js";
import { createSubmissionPack, createSynopsisDeck, packFilename, submissionBlockers } from "./pack.js";
import { attestationValid, contentVersion, provenanceSummary, type Attestation } from "./attestation.js";
import { serializePublicTender, serializeTender } from "./serializers.js";
import type { CompanyProfile, TenderRecord } from "./types.js";

const app = express();
const port = Number(process.env.PORT || 8787);
const allowedOrigins = (process.env.CORS_ORIGINS || "http://localhost:4173,http://localhost:5173,https://tenderly.netlify.app").split(",").map((value) => value.trim()).filter(Boolean);

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(helmet());
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error("Origin not allowed"));
  },
  exposedHeaders: ["Content-Disposition"],
}));
app.use(express.json({ limit: "2mb" }));

const authLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 30, standardHeaders: "draft-8", legacyHeaders: false });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 1 } });

const credentialsSchema = z.object({ email: z.string().email().max(254), password: z.string().min(10).max(128), companyName: z.string().trim().min(2).max(200).optional() });
const preferencesSchema = z.object({
  sectors: z.array(z.string().max(60)).max(20).default([]),
  keywords: z.array(z.string().max(60)).max(50).default([]),
  cpvCodes: z.array(z.string().regex(/^[0-9]{8}$/, "A CPV code is 8 digits")).max(50).default([]),
  valueMin: z.number().int().min(0).nullable().default(null),
  valueMax: z.number().int().min(0).nullable().default(null),
});

const companySchema = z.object({
  name: z.string().trim().min(1).max(300), registration: z.string().max(300).default(""), turnover: z.string().max(500).default(""), employees: z.string().max(500).default(""), services: z.string().max(20_000).default(""), cpv: z.string().max(5000).default(""), certifications: z.string().max(10_000).default(""), insurance: z.string().max(10_000).default(""),
});

function safeError(error: unknown) {
  if (error instanceof z.ZodError) return { status: 400, message: error.issues[0]?.message || "Invalid request" };
  if (error instanceof multer.MulterError) return { status: 400, message: error.code === "LIMIT_FILE_SIZE" ? "File exceeds the 25 MB upload limit" : error.message };
  const message = error instanceof Error ? error.message : "Unexpected error";
  if (["TENDER_NOT_FOUND", "AUTH_REQUIRED"].includes(message)) return { status: message === "TENDER_NOT_FOUND" ? 404 : 401, message: message === "TENDER_NOT_FOUND" ? "Tender not found" : "Sign in required" };
  return { status: 500, message: process.env.NODE_ENV === "production" ? "The request could not be completed" : message };
}

function routeParam(value: string | string[]) {
  return Array.isArray(value) ? value[0] : value;
}

async function tenderWithAnswers(account: string, tender: TenderRecord) {
  // Evidence decides whether a required certificate is satisfied.
  const [answers, evidence, provenance, company] = await Promise.all([
    listAnswers(tender.id), listEvidence(account), tenderProvenance(tender.id), getCompany(account),
  ]);
  const serialized = serializeTender(tender, answers, evidence, provenance);

  // Historical awards for this buyer and CPV (TLY-48). Intelligence must never
  // break the page: if the query fails, the tender still renders without it.
  try {
    const cpv = String(tender.metadata["CPV Codes"] ?? company.cpv ?? "").replace(/[^0-9]/g, "").slice(0, 8);
    const intelligence = await awardIntelligence(tender.authority, cpv);
    if (intelligence.awards > 0) {
      const companyAwards = await companyWonBefore(tender.authority, company.name);
      serialized.awardIntelligence = { ...intelligence, companyAwards };
    } else {
      serialized.awardIntelligence = intelligence;
    }
  } catch {
    // leave it absent
  }
  return serialized;
}

async function analyseSavedTender(account: string, tenderId: string) {
  const tender = await getTender(account, tenderId);
  if (!tender) throw new Error("TENDER_NOT_FOUND");
  const company = await getCompany(account);
  const documents = await listDocuments(tender.id);
  const noticeText = String(tender.metadata.sourceText ?? tender.description ?? "");
  const sources = combineSourceText(noticeText, documents.map((document) => ({ filename: document.filename, extractedText: document.extractedText })));
  const [people, evidence] = await Promise.all([listPeople(account), listEvidence(account)]);
  const analysis = await analyseTender(tender, company, sources, { people, evidence });
  return saveTenderAnalysis(account, tender.id, analysis);
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "tenderly-api", database: persistentDatabase ? "configured" : "memory", ai: aiConfigured() ? "configured" : "not-configured", aiModel: aiModel(), time: new Date().toISOString() });
});

app.post("/api/auth/register", authLimiter, async (req, res) => {
  try {
    const input = credentialsSchema.extend({ companyName: z.string().trim().min(2).max(200) }).parse(req.body);
    const passwordHash = await bcrypt.hash(input.password, 12);
    const user = await createUser(input.email, passwordHash, input.companyName);
    res.status(201).json({ token: signToken(user), user: { id: user.id, email: user.email } });
  } catch (error) {
    if (error instanceof Error && error.message === "EMAIL_EXISTS") return res.status(409).json({ error: "An account with that email already exists" });
    const mapped = safeError(error); res.status(mapped.status).json({ error: mapped.message });
  }
});

app.post("/api/auth/login", authLimiter, async (req, res) => {
  try {
    const input = credentialsSchema.pick({ email: true, password: true }).parse(req.body);
    const user = await findUserByEmail(input.email);
    if (!user || !(await bcrypt.compare(input.password, user.passwordHash))) return res.status(401).json({ error: "Email or password is incorrect" });
    res.json({ token: signToken(user), user: { id: user.id, email: user.email } });
  } catch (error) { const mapped = safeError(error); res.status(mapped.status).json({ error: mapped.message }); }
});

app.post("/api/jobs/discover", async (req: Request, res: Response) => {
  const supplied = req.headers.authorization?.replace(/^Bearer\s+/i, "") || "";
  if (!process.env.CRON_SECRET || supplied !== process.env.CRON_SECRET) return res.status(401).json({ error: "Invalid cron secret" });
  try { res.json({ ok: true, ...(await runDiscoveryJob()) }); } catch (error) { const mapped = safeError(error); res.status(mapped.status).json({ error: mapped.message }); }
});

app.use("/api", requireAuth);

app.get("/api/me", async (req: AuthenticatedRequest, res) => {
  try {
    const user = await getUserById(accountId(req));
    if (!user) return res.status(404).json({ error: "Account not found" });
    res.json({ user, company: await getCompany(accountId(req)) });
  } catch (error) { const mapped = safeError(error); res.status(mapped.status).json({ error: mapped.message }); }
});

app.get("/api/company", async (req: AuthenticatedRequest, res) => {
  try { res.json({ company: await getCompany(accountId(req)) }); } catch (error) { const mapped = safeError(error); res.status(mapped.status).json({ error: mapped.message }); }
});

app.put("/api/company", async (req: AuthenticatedRequest, res) => {
  try { const company = companySchema.parse(req.body) as CompanyProfile; res.json({ company: await updateCompany(accountId(req), company) }); } catch (error) { const mapped = safeError(error); res.status(mapped.status).json({ error: mapped.message }); }
});


// The sector presets a user picks from. Static, so the UI never hard-codes them.
app.get("/api/sectors", async (_req: AuthenticatedRequest, res) => {
  res.json({ items: SECTOR_PRESETS.map((preset) => ({ slug: preset.slug, label: preset.label, description: preset.description, cpvCodes: preset.cpvCodes })) });
});

app.get("/api/preferences", async (req: AuthenticatedRequest, res) => {
  try { res.json({ preferences: await getPreferences(accountId(req)) }); }
  catch (error) { const mapped = safeError(error); res.status(mapped.status).json({ error: mapped.message }); }
});

app.put("/api/preferences", async (req: AuthenticatedRequest, res) => {
  try {
    const parsed = preferencesSchema.parse(req.body);
    if (parsed.valueMin !== null && parsed.valueMax !== null && parsed.valueMax <= parsed.valueMin) {
      return res.status(400).json({ error: "Upper value must be greater than lower value" });
    }
    res.json({ preferences: await savePreferences(accountId(req), parsed) });
  } catch (error) { const mapped = safeError(error); res.status(mapped.status).json({ error: mapped.message }); }
});

app.get("/api/tenders/discover", async (req: AuthenticatedRequest, res) => {
  try {
    const account = accountId(req);
    const [company, preferences] = await Promise.all([getCompany(account), getPreferences(account)]);
    const query = z.string().max(200).catch("").parse(req.query.query);
    // Two sources, so a portal redesign no longer takes discovery down entirely.
    // TED failing must not cost the user their eTenders results, hence allSettled.
    const [crawled, ted] = await Promise.allSettled([discoverETenders(query), searchTed({ limit: 40 })]);
    const sourceWarnings: string[] = [];
    if (crawled.status === "rejected") sourceWarnings.push("eTenders is unavailable — showing TED results only");
    if (ted.status === "rejected") sourceWarnings.push("TED is unavailable — showing eTenders results only");
    if (crawled.status === "rejected" && ted.status === "rejected") throw crawled.reason;
    const tedResult = ted.status === "fulfilled" ? ted.value : { items: [], warnings: [] };
    sourceWarnings.push(...tedResult.warnings.slice(0, 3));
    const sourceOf = new Map<string, "eTenders" | "TED">();
    const crawledItems = crawled.status === "fulfilled" ? crawled.value : [];
    for (const item of crawledItems) sourceOf.set(item.externalId, "eTenders");
    for (const item of tedResult.items) if (!sourceOf.has(item.externalId)) sourceOf.set(item.externalId, "TED");
    const items = [...crawledItems, ...tedResult.items.filter((item) => sourceOf.get(item.externalId) === "TED")];
    const profileText = `${company.services} ${company.cpv} ${company.certifications}`;

    // The eTenders listing carries no CPV, so the list is filtered on sector
    // keywords against title and description. CPV codes on the profile are
    // applied once a tender is imported and its detail page is read.
    const keywords = profileKeywords(preferences.sectors, preferences.keywords);
    const filtered = keywords.length === 0
      ? items.map((item) => ({ item, reasons: [] as ReturnType<typeof matchNotice> }))
      : items
          .map((item) => ({ item, reasons: matchNotice(`${item.title} ${item.description}`, preferences.sectors, preferences.keywords) }))
          .filter((entry) => entry.reasons.length > 0);

    const withinBand = filtered.filter(({ item }) => {
      if (preferences.valueMin === null && preferences.valueMax === null) return true;
      const digits = (item.estimatedValue || "").replace(/[^0-9]/g, "");
      if (!digits) return true; // an unstated value is not a reason to hide an opportunity
      const value = Number(digits);
      if (preferences.valueMin !== null && value < preferences.valueMin) return false;
      if (preferences.valueMax !== null && value > preferences.valueMax) return false;
      return true;
    });

    const serialised = withinBand
      .map(({ item, reasons }) => ({
        ...serializePublicTender(item, scoreTenderPreview(item, profileText)),
        matchedBy: reasons,
        noticeSource: sourceOf.get(item.externalId) ?? "eTenders",
      }))
      .sort((a, b) => b.match - a.match)
      .slice(0, 50);
    res.json({
      items: serialised,
      source: "eTenders public current opportunities and TED",
      warnings: sourceWarnings,
      filtered: keywords.length > 0,
      profileCpvCodes: profileCpvCodes(preferences.sectors, preferences.cpvCodes),
      checkedAt: new Date().toISOString(),
    });
  } catch (error) { const mapped = safeError(error); res.status(mapped.status === 500 ? 502 : mapped.status).json({ error: mapped.message }); }
});

app.get("/api/tenders", async (req: AuthenticatedRequest, res) => {
  try {
    const account = accountId(req);
    const tenders = await listTenders(account);
    const items = await Promise.all(tenders.map((tender) => tenderWithAnswers(account, tender)));
    res.json({ items });
  } catch (error) { const mapped = safeError(error); res.status(mapped.status).json({ error: mapped.message }); }
});

app.post("/api/tenders/import", importLimiter, async (req: AuthenticatedRequest, res) => {
  try {
    const account = accountId(req);
    const { url } = z.object({ url: z.string().url().max(2000) }).parse(req.body);
    const imported = await importETender(url);
    let tender = await upsertTender(account, {
      source: "etenders", externalId: imported.externalId, sourceUrl: imported.sourceUrl, title: imported.title, authority: imported.authority,
      description: imported.description, published: imported.published, deadline: imported.deadline, procedure: imported.procedure, status: imported.status,
      estimatedValue: imported.estimatedValue, metadata: { ...imported.metadata, sourceText: imported.sourceText },
    });
    const warnings: string[] = [];
    try {
      const remoteDocs = await fetchPublicTenderDocuments(imported.resourceId);
      for (const remote of remoteDocs) {
        if (!remote.bytes) { if (remote.warning) warnings.push(`${remote.filename}: ${remote.warning}`); continue; }
        const extracted = await extractDocumentText(remote.filename, remote.bytes);
        const text = extracted.map((entry) => `[${entry.filename}]\n${entry.text}`).join("\n\n");
        extracted.filter((entry) => entry.warning).forEach((entry) => warnings.push(`${entry.filename}: ${entry.warning}`));
        await saveDocument({ tenderId: tender.id, filename: remote.filename, mimeType: remote.mimeType || "application/octet-stream", role: "source", sourceUrl: remote.url, bytes: remote.bytes, extractedText: text, extractionStatus: extracted.some((entry) => entry.status === "FAILED") ? "PARTIAL" : "EXTRACTED" });
      }
    } catch (error) {
      warnings.push(`Automatic tender-document download: ${error instanceof Error ? error.message : "not available"}`);
    }
    if (warnings.length) tender = await updateTenderMetadata(account, tender.id, { documentWarnings: warnings });
    let analysisError = "";
    try { tender = await analyseSavedTender(account, tender.id); } catch (error) { analysisError = error instanceof Error ? error.message : "Analysis did not complete"; }
    res.status(201).json({ tender: await tenderWithAnswers(account, tender), warnings, analysisError });
  } catch (error) { const mapped = safeError(error); res.status(mapped.status === 500 ? 502 : mapped.status).json({ error: mapped.message }); }
});

app.get("/api/tenders/:id", async (req: AuthenticatedRequest, res) => {
  try {
    const tender = await getTender(accountId(req), routeParam(req.params.id));
    if (!tender) return res.status(404).json({ error: "Tender not found" });
    res.json({ tender: await tenderWithAnswers(accountId(req), tender), documents: (await listDocuments(tender.id)).map(({ bytes, ...document }) => document) });
  } catch (error) { const mapped = safeError(error); res.status(mapped.status).json({ error: mapped.message }); }
});

app.post("/api/tenders/:id/documents", upload.single("file"), async (req: AuthenticatedRequest, res) => {
  try {
    const account = accountId(req);
    const tender = await getTender(account, routeParam(req.params.id));
    if (!tender) return res.status(404).json({ error: "Tender not found" });
    if (!req.file) return res.status(400).json({ error: "Choose a file to upload" });
    const role = z.enum(["source", "submission", "evidence"]).catch("source").parse(req.body.role);
    const extracted = await extractDocumentText(req.file.originalname, req.file.buffer);
    const text = extracted.map((entry) => `[${entry.filename}]\n${entry.text}`).join("\n\n");
    const saved = await saveDocument({ tenderId: tender.id, filename: req.file.originalname, mimeType: req.file.mimetype, role, bytes: req.file.buffer, extractedText: text, extractionStatus: extracted.some((entry) => entry.status === "FAILED") ? "PARTIAL" : "EXTRACTED" });
    await audit(req, {
      action: AUDIT_ACTIONS.documentUploaded, subjectType: "document", subjectId: saved.id,
      // The name and the size, never the contents or the extracted text.
      subjectLabel: saved.filename, metadata: { role, bytes: req.file.size },
    });
    res.status(201).json({ document: { ...saved, bytes: undefined }, extraction: extracted.map(({ text, ...entry }) => ({ ...entry, characters: text.length })) });
  } catch (error) { const mapped = safeError(error); res.status(mapped.status).json({ error: mapped.message }); }
});

app.post("/api/tenders/:id/analyse", analysisLimiter, analysisHourlyLimiter, async (req: AuthenticatedRequest, res) => {
  try {
    const account = accountId(req);
    const tender = await analyseSavedTender(account, routeParam(req.params.id));
    res.json({ tender: await tenderWithAnswers(account, tender) });
  } catch (error) { const mapped = safeError(error); res.status(mapped.status).json({ error: mapped.message }); }
});

app.post("/api/tenders/:id/answers/:questionId/draft", draftLimiter, draftHourlyLimiter, async (req: AuthenticatedRequest, res) => {
  try {
    const account = accountId(req);
    const tender = await getTender(account, routeParam(req.params.id));
    if (!tender) return res.status(404).json({ error: "Tender not found" });
    if (!tender.analysis) return res.status(409).json({ error: "Run tender analysis before drafting responses" });
    // Enforced here, not merely hidden in the UI: a valid token calling this
    // route directly must be refused, and nothing may be created first.
    if (noAiMode(tender)) return res.status(409).json({ error: NO_AI_REFUSAL });
    const questionId = routeParam(req.params.questionId);
    const question = tender.analysis.questions.find((item) => item.id === questionId);
    if (!question) return res.status(404).json({ error: "Scored question not found" });
    const [company, evidence, people, answers] = await Promise.all([getCompany(account), listEvidence(account), listPeople(account), listAnswers(tender.id)]);
    const draft = await draftBidAnswer({ tender, company, question, evidence, people, existingAnswers: answers });
    const saved = await saveAnswer(tender.id, question.id, draft.answer, draft.missingInputs.length ? "needs-input" : "draft", draft.evidenceUsed);
    // The ledger records that a model wrote this text, and which one.
    await recordProvenance({
      answerId: saved.id, section: "body", class: "ai-generated",
      model: aiModel(), promptVersion: DRAFTING_PROMPT_VERSION,
      evidenceIds: draft.evidenceUsed, actor: actorEmail(req),
    });
    res.json(draft);
  } catch (error) { const mapped = safeError(error); res.status(mapped.status).json({ error: mapped.message }); }
});

app.put("/api/tenders/:id/answers/:questionId", async (req: AuthenticatedRequest, res) => {
  try {
    const account = accountId(req);
    const tender = await getTender(account, routeParam(req.params.id));
    if (!tender?.analysis) return res.status(404).json({ error: "Tender analysis not found" });
    const questionId = routeParam(req.params.questionId);
    if (!tender.analysis.questions.some((question) => question.id === questionId)) return res.status(404).json({ error: "Scored question not found" });
    const input = z.object({ response: z.string().max(120_000), status: z.enum(["draft", "ready", "needs-input"]).default("draft") }).parse(req.body);
    const answer = await saveAnswer(tender.id, questionId, input.response, input.status);
    if (input.status === "ready") {
      const title = tender.analysis.questions.find((question) => question.id === questionId)?.title ?? questionId;
      await audit(req, { action: AUDIT_ACTIONS.answerMarkedReady, subjectType: "answer", subjectId: answer.id, subjectLabel: title });
    }
    // Editing text a model produced does not erase that a model produced it.
    const history = await listProvenance(answer.id);
    await recordProvenance({
      answerId: answer.id, section: "body", class: classForHumanEdit(history),
      evidenceIds: answer.evidence, actor: actorEmail(req),
    });
    res.json({ answer });
  } catch (error) { const mapped = safeError(error); res.status(mapped.status).json({ error: mapped.message }); }
});

/**
 * The full ledger for one answer, oldest first. There is no counterpart that
 * writes here: entries are only ever appended as a side effect of drafting or
 * saving, and the table itself refuses updates.
 */
app.get("/api/tenders/:id/answers/:questionId/provenance", async (req: AuthenticatedRequest, res) => {
  try {
    const account = accountId(req);
    const tender = await getTender(account, routeParam(req.params.id));
    if (!tender) return res.status(404).json({ error: "Tender not found" });
    const questionId = routeParam(req.params.questionId);
    const answers = await listAnswers(tender.id);
    const answer = answers.find((item) => item.questionId === questionId);
    if (!answer) return res.status(404).json({ error: "No saved answer for this question" });
    res.json({ entries: await listProvenance(answer.id) });
  } catch (error) { const mapped = safeError(error); res.status(mapped.status).json({ error: mapped.message }); }
});

app.post("/api/tenders/:id/checklist/:itemId", async (req: AuthenticatedRequest, res) => {
  try {
    const account = accountId(req);
    const tender = await getTender(account, routeParam(req.params.id));
    if (!tender?.analysis) return res.status(404).json({ error: "Tender analysis not found" });
    const itemId = routeParam(req.params.itemId);
    if (!tender.analysis.submissionChecklist.some((item) => item.id === itemId)) return res.status(404).json({ error: "Checklist item not found" });
    const { status } = z.object({ status: z.enum(["READY", "ACTION", "VERIFY"]) }).parse(req.body);
    const overrides = { ...((tender.metadata.checklistOverrides ?? {}) as Record<string, string>), [itemId]: status };
    await updateTenderMetadata(account, tender.id, { checklistOverrides: overrides });
    res.json({ itemId, status });
  } catch (error) { const mapped = safeError(error); res.status(mapped.status).json({ error: mapped.message }); }
});

/**
 * What the attester is being asked to stand behind, and whether the statement
 * they may already have made still applies to the current content.
 */
app.get("/api/tenders/:id/attestation", async (req: AuthenticatedRequest, res) => {
  try {
    const account = accountId(req);
    const tender = await getTender(account, routeParam(req.params.id));
    if (!tender) return res.status(404).json({ error: "Tender not found" });
    const [answers, provenance, documents, evidence] = await Promise.all([
      listAnswers(tender.id), tenderProvenance(tender.id), listDocuments(tender.id), listEvidence(account),
    ]);
    const attestation = tender.metadata.attestation as Attestation | undefined;
    const valid = attestationValid(attestation, answers);
    res.json({
      summary: provenanceSummary(tender.analysis, answers, provenance),
      attestation: attestation ?? null,
      // An attestation that no longer matches the content is reported as
      // invalidated rather than quietly dropped: the user needs to know why.
      invalidated: Boolean(attestation) && !valid,
      blockers: tender.analysis ? submissionBlockers(tender, tender.analysis, answers, documents, evidence) : ["Run tender analysis first"],
    });
  } catch (error) { const mapped = safeError(error); res.status(mapped.status).json({ error: mapped.message }); }
});

/**
 * Records that a named person has reviewed this exact content. Refused while
 * any other blocker stands — attesting to a pack that is not ready would make
 * the statement meaningless.
 */
app.post("/api/tenders/:id/attestation", async (req: AuthenticatedRequest, res) => {
  try {
    const account = accountId(req);
    const tender = await getTender(account, routeParam(req.params.id));
    if (!tender?.analysis) return res.status(404).json({ error: "Tender analysis not found" });
    const { confirmed } = z.object({ confirmed: z.literal(true) }).parse(req.body);
    void confirmed;
    const [answers, documents, evidence] = await Promise.all([listAnswers(tender.id), listDocuments(tender.id), listEvidence(account)]);
    const remaining = submissionBlockers(tender, tender.analysis, answers, documents, evidence)
      .filter((blocker) => blocker !== "Attestation not recorded");
    if (remaining.length) return res.status(409).json({ error: "Resolve the remaining blockers before attesting", blockers: remaining });

    const attestation: Attestation = { actor: actorEmail(req), at: new Date().toISOString(), contentVersion: contentVersion(answers) };
    await updateTenderMetadata(account, tender.id, { attestation });
    await audit(req, { action: AUDIT_ACTIONS.attestationRecorded, subjectType: "tender", subjectId: tender.id, subjectLabel: tender.title });
    res.json({ attestation });
  } catch (error) { const mapped = safeError(error); res.status(mapped.status).json({ error: mapped.message }); }
});

/** True when this tender is in no-AI mode. Stored on the tender, not the account. */
function noAiMode(tender: { metadata: Record<string, unknown> }) {
  return tender.metadata.noAiMode === true;
}

const NO_AI_REFUSAL = "No-AI mode is enabled for this tender: generation is disabled";

/**
 * Turns no-AI mode on or off for one tender.
 *
 * Enabling it does not rewrite anything that already exists. Answers a model
 * drafted keep their ai-generated provenance, and the response names them so
 * the user can decide what to do about them rather than discovering it later.
 */
app.put("/api/tenders/:id/no-ai-mode", async (req: AuthenticatedRequest, res) => {
  try {
    const account = accountId(req);
    const tender = await getTender(account, routeParam(req.params.id));
    if (!tender) return res.status(404).json({ error: "Tender not found" });
    const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    await updateTenderMetadata(account, tender.id, { noAiMode: enabled });

    const answers = await listAnswers(tender.id);
    const provenance = await tenderProvenance(tender.id);
    const byAnswer = new Map<string, typeof provenance>();
    for (const item of provenance) byAnswer.set(item.answerId, [...(byAnswer.get(item.answerId) ?? []), item]);
    const titleFor = (questionId: string) =>
      tender.analysis?.questions.find((question) => question.id === questionId)?.title ?? questionId;
    const generated = enabled
      ? answers.filter((answer) => badgeFor(byAnswer.get(answer.id) ?? [])?.class !== "human" && (byAnswer.get(answer.id) ?? []).length > 0)
        .map((answer) => titleFor(answer.questionId))
      : [];
    await audit(req, {
      action: enabled ? AUDIT_ACTIONS.noAiModeEnabled : AUDIT_ACTIONS.noAiModeDisabled,
      subjectType: "tender", subjectId: tender.id, subjectLabel: tender.title,
    });
    res.json({ noAiMode: enabled, aiWrittenAnswers: generated });
  } catch (error) { const mapped = safeError(error); res.status(mapped.status).json({ error: mapped.message }); }
});

/**
 * Critiques an answer the user wrote. Available in no-AI mode: judging text is
 * assistance, writing it is generation, and only the latter is disabled.
 */
app.post("/api/tenders/:id/answers/:questionId/critique", async (req: AuthenticatedRequest, res) => {
  try {
    const account = accountId(req);
    const tender = await getTender(account, routeParam(req.params.id));
    if (!tender?.analysis) return res.status(404).json({ error: "Tender analysis not found" });
    const questionId = routeParam(req.params.questionId);
    const question = tender.analysis.questions.find((item) => item.id === questionId);
    if (!question) return res.status(404).json({ error: "Scored question not found" });
    const answers = await listAnswers(tender.id);
    const answer = answers.find((item) => item.questionId === questionId);
    if (!answer?.response.trim()) return res.status(409).json({ error: "Write an answer before asking for a critique" });
    const critique = await critiqueBidAnswer({ tender, question, answer: answer.response, evidence: await listEvidence(account) });
    res.json(critique);
  } catch (error) { const mapped = safeError(error); res.status(mapped.status).json({ error: mapped.message }); }
});

/**
 * Records that a person has seen the AI-use flag. Dismissing it does not change
 * what the pack says — the state and its quote stay exactly as extracted — it
 * only records who decided to proceed and when.
 */
app.post("/api/tenders/:id/ai-policy/acknowledge", async (req: AuthenticatedRequest, res) => {
  try {
    const account = accountId(req);
    const tender = await getTender(account, routeParam(req.params.id));
    if (!tender?.analysis) return res.status(404).json({ error: "Tender analysis not found" });
    const { action } = z.object({ action: z.enum(["confirmed", "dismissed"]) }).parse(req.body);
    const acknowledgement = { action, actor: actorEmail(req), at: new Date().toISOString() };
    await updateTenderMetadata(account, tender.id, { aiPolicyAcknowledgement: acknowledgement });
    await audit(req, {
      action: AUDIT_ACTIONS.aiPolicyAcknowledged, subjectType: "tender", subjectId: tender.id,
      subjectLabel: tender.title, metadata: { decision: action },
    });
    res.json({ acknowledgement });
  } catch (error) { const mapped = safeError(error); res.status(mapped.status).json({ error: mapped.message }); }
});

/**
 * This account's audit entries, newest first. Filterable by action and by how
 * many days back to look, which is what a diligence question actually asks.
 */
app.get("/api/audit", async (req: AuthenticatedRequest, res) => {
  try {
    const query = z.object({
      action: z.string().max(64).optional(),
      days: z.coerce.number().int().min(1).max(365).optional(),
      limit: z.coerce.number().int().min(1).max(500).optional(),
    }).parse(req.query);
    const since = query.days ? new Date(Date.now() - query.days * 86_400_000) : undefined;
    res.json({ entries: await listAudit(accountId(req), { action: query.action, since, limit: query.limit }) });
  } catch (error) { const mapped = safeError(error); res.status(mapped.status).json({ error: mapped.message }); }
});

/** This account's model usage for the current calendar month. */
app.get("/api/usage", async (req: AuthenticatedRequest, res) => {
  try {
    res.json({ usage: await monthlyUsage(accountId(req)) });
  } catch (error) { const mapped = safeError(error); res.status(mapped.status).json({ error: mapped.message }); }
});

app.get("/api/tenders/:id/red-team", async (req: AuthenticatedRequest, res) => {
  try {
    const account = accountId(req);
    const tender = await getTender(account, routeParam(req.params.id));
    if (!tender) return res.status(404).json({ error: "Tender not found" });
    if (!tender.analysis) return res.status(409).json({ error: "Analyse the tender first" });
    const [answers, documents] = await Promise.all([listAnswers(tender.id), listDocuments(tender.id)]);
    const issues = submissionBlockers(tender, tender.analysis, answers, documents, await listEvidence(account)).map((message) => ({ severity: "BLOCKER", message }));
    for (const question of tender.analysis.questions) {
      const answer = answers.find((item) => item.questionId === question.id);
      const words = answer?.response.trim() ? answer.response.trim().split(/\s+/).length : 0;
      if (question.maxWords > 0 && words > question.maxWords) issues.push({ severity: "BLOCKER", message: `${question.title}: ${words} words exceeds the ${question.maxWords}-word limit` });
      if (answer?.response.includes("[INPUT NEEDED:")) issues.push({ severity: "BLOCKER", message: `${question.title}: unresolved INPUT NEEDED placeholder` });
    }
    res.json({ ready: !issues.length, issues });
  } catch (error) { const mapped = safeError(error); res.status(mapped.status).json({ error: mapped.message }); }
});

app.get("/api/tenders/:id/deck", packLimiter, async (req: AuthenticatedRequest, res) => {
  try {
    const account = accountId(req);
    const tender = await getTender(account, routeParam(req.params.id));
    if (!tender) return res.status(404).json({ error: "Tender not found" });
    if (!tender.analysis) return res.status(409).json({ error: "Analyse the tender before generating a synopsis deck" });
    const deck = await createSynopsisDeck(tender, tender.analysis, await getCompany(account));
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.presentationml.presentation");
    res.setHeader("Content-Disposition", `attachment; filename="Tenderly_${tender.externalId || "Bid"}_Synopsis.pptx"`);
    res.send(deck);
  } catch (error) { const mapped = safeError(error); res.status(mapped.status).json({ error: mapped.message }); }
});

app.get("/api/tenders/:id/pack", packLimiter, async (req: AuthenticatedRequest, res) => {
  try {
    const account = accountId(req);
    const tender = await getTender(account, routeParam(req.params.id));
    if (!tender) return res.status(404).json({ error: "Tender not found" });
    if (!tender.analysis) return res.status(409).json({ error: "Analyse the tender before building a pack" });
    const draft = String(req.query.draft).toLowerCase() === "true";
    const [answers, documents, company, people, evidence] = await Promise.all([listAnswers(tender.id), listDocuments(tender.id), getCompany(account), listPeople(account), listEvidence(account)]);
    const result = await createSubmissionPack({ tender, analysis: tender.analysis, answers, documents, company, people, evidence, provenance: await tenderProvenance(tender.id), draft });
    if (!result.buffer) return res.status(409).json({ error: "Final submission pack is blocked", blockers: result.blockers });
    await audit(req, {
      action: draft ? AUDIT_ACTIONS.packDraftDownloaded : AUDIT_ACTIONS.packFinalDownloaded,
      subjectType: "tender", subjectId: tender.id, subjectLabel: tender.title,
      metadata: { bytes: result.buffer.length },
    });
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${packFilename(tender, draft)}"`);
    res.send(result.buffer);
  } catch (error) { const mapped = safeError(error); res.status(mapped.status).json({ error: mapped.message }); }
});

app.get("/api/evidence", async (req: AuthenticatedRequest, res) => {
  try { res.json({ items: await listEvidence(accountId(req)) }); } catch (error) { const mapped = safeError(error); res.status(mapped.status).json({ error: mapped.message }); }
});

app.post("/api/evidence", async (req: AuthenticatedRequest, res) => {
  try {
    const input = z.object({ kind: z.string().min(1).max(100), name: z.string().min(1).max(300), content: z.string().max(120_000), tags: z.array(z.string().max(100)).max(30).default([]), verified: z.boolean().default(false) }).parse(req.body);
    res.status(201).json({ item: await addEvidence(accountId(req), input) });
  } catch (error) { const mapped = safeError(error); res.status(mapped.status).json({ error: mapped.message }); }
});

app.post("/api/evidence/upload", upload.single("file"), async (req: AuthenticatedRequest, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Choose an evidence file" });
    const extracted = await extractDocumentText(req.file.originalname, req.file.buffer);
    const content = extracted.map((entry) => entry.text).filter(Boolean).join("\n\n");
    if (!content) return res.status(422).json({ error: "Tenderly could not extract text from this evidence file" });
    const item = await addEvidence(accountId(req), {
      kind: String(req.body.kind || "Document").slice(0, 100),
      name: String(req.body.name || req.file.originalname).slice(0, 300),
      content,
      tags: String(req.body.tags || "").split(",").map((value) => value.trim()).filter(Boolean).slice(0, 30),
      verified: String(req.body.verified).toLowerCase() === "true",
    });
    res.status(201).json({ item, extractionWarnings: extracted.filter((entry) => entry.warning).map((entry) => entry.warning) });
  } catch (error) { const mapped = safeError(error); res.status(mapped.status).json({ error: mapped.message }); }
});

app.put("/api/evidence/:id/verification", async (req: AuthenticatedRequest, res) => {
  try {
    const { verified } = z.object({ verified: z.boolean() }).parse(req.body);
    const item = await setEvidenceVerified(accountId(req), routeParam(req.params.id), verified);
    if (!item) return res.status(404).json({ error: "Evidence item not found" });
    await audit(req, {
      action: verified ? AUDIT_ACTIONS.evidenceVerified : AUDIT_ACTIONS.evidenceUnverified,
      subjectType: "evidence", subjectId: item.id, subjectLabel: item.name,
    });
    res.json({ item });
  } catch (error) { const mapped = safeError(error); res.status(mapped.status).json({ error: mapped.message }); }
});

app.get("/api/people", async (req: AuthenticatedRequest, res) => {
  try { res.json({ items: await listPeople(accountId(req)) }); } catch (error) { const mapped = safeError(error); res.status(mapped.status).json({ error: mapped.message }); }
});

app.post("/api/people", async (req: AuthenticatedRequest, res) => {
  try {
    const input = z.object({ name: z.string().min(1).max(300), title: z.string().max(300).default(""), cvText: z.string().max(200_000).default(""), skills: z.array(z.string().max(200)).max(100).default([]) }).parse(req.body);
    res.status(201).json({ person: await addPerson(accountId(req), input) });
  } catch (error) { const mapped = safeError(error); res.status(mapped.status).json({ error: mapped.message }); }
});

app.post("/api/people/upload", upload.single("file"), async (req: AuthenticatedRequest, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Choose a CV file" });
    const extracted = await extractDocumentText(req.file.originalname, req.file.buffer);
    const cvText = extracted.map((entry) => entry.text).filter(Boolean).join("\n\n");
    if (!cvText) return res.status(422).json({ error: "Tenderly could not extract text from this CV" });
    const fallbackName = req.file.originalname.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ");
    const person = await addPerson(accountId(req), { name: String(req.body.name || fallbackName).slice(0, 300), title: String(req.body.title || "").slice(0, 300), cvText, skills: [] });
    res.status(201).json({ person, extractionWarnings: extracted.filter((entry) => entry.warning).map((entry) => entry.warning) });
  } catch (error) { const mapped = safeError(error); res.status(mapped.status).json({ error: mapped.message }); }
});

app.get("/api/notifications", async (req: AuthenticatedRequest, res) => {
  try { res.json({ items: await listNotifications(accountId(req)) }); } catch (error) { const mapped = safeError(error); res.status(mapped.status).json({ error: mapped.message }); }
});

app.use((error: unknown, _req: Request, res: Response, _next: unknown) => {
  const mapped = safeError(error);
  res.status(mapped.status).json({ error: mapped.message });
});

/**
 * Exported so tests can mount the real app on an ephemeral port. Importing this
 * module must not start a server or touch the database, which is what
 * TENDERLY_NO_LISTEN guards — see server/tests/tenant-isolation.test.ts.
 */
export { app };

if (process.env.TENDERLY_NO_LISTEN !== "1") {
  await initializeDatabase();
  // Re-key analyses written before stable question ids existed (TLY-40). Idempotent.
  const migrated = await migrateAnalysisSchema();
  if (migrated.tenders) console.log(`analysis schema migration · tenders=${migrated.tenders} answers=${migrated.answers} checklistOverrides=${migrated.overrides}`);
  app.listen(port, "0.0.0.0", () => {
    console.log(`Tenderly API listening on port ${port} · database=${persistentDatabase ? "postgres" : "memory"} · ai=${aiConfigured() ? "configured" : "not-configured"}`);
  });
}
