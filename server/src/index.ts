import "dotenv/config";
import express, { type Request, type Response } from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import multer from "multer";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { accountId, requireAuth, signToken, type AuthenticatedRequest } from "./auth.js";
import { aiConfigured, analyseTender, draftBidAnswer } from "./ai.js";
import { combineSourceText, extractDocumentText } from "./documents.js";
import { discoverETenders, fetchPublicTenderDocuments, importETender, scoreTenderPreview } from "./etenders.js";
import {
  addEvidence, addPerson, createUser, findUserByEmail, getCompany, getTender, getUserById, initializeDatabase, migrateAnalysisSchema,
  listAnswers, listDocuments, listEvidence, listNotifications, listPeople, listTenders, persistentDatabase, saveAnswer,
  saveDocument, saveTenderAnalysis, setEvidenceVerified, updateCompany, updateTenderMetadata, upsertTender,
} from "./db.js";
import { runDiscoveryJob } from "./jobs.js";
import { createSubmissionPack, createSynopsisDeck, packFilename, submissionBlockers } from "./pack.js";
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
  return serializeTender(tender, await listAnswers(tender.id));
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
  res.json({ ok: true, service: "tenderly-api", database: persistentDatabase ? "configured" : "memory", ai: aiConfigured() ? "configured" : "not-configured", time: new Date().toISOString() });
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

app.get("/api/tenders/discover", async (req: AuthenticatedRequest, res) => {
  try {
    const company = await getCompany(accountId(req));
    const query = z.string().max(200).catch("").parse(req.query.query);
    const items = await discoverETenders(query);
    const profileText = `${company.services} ${company.cpv} ${company.certifications}`;
    const serialised = items.map((item) => serializePublicTender(item, scoreTenderPreview(item, profileText))).sort((a, b) => b.match - a.match).slice(0, 50);
    res.json({ items: serialised, source: "eTenders public current opportunities", checkedAt: new Date().toISOString() });
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

app.post("/api/tenders/import", async (req: AuthenticatedRequest, res) => {
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
    res.status(201).json({ document: { ...saved, bytes: undefined }, extraction: extracted.map(({ text, ...entry }) => ({ ...entry, characters: text.length })) });
  } catch (error) { const mapped = safeError(error); res.status(mapped.status).json({ error: mapped.message }); }
});

app.post("/api/tenders/:id/analyse", async (req: AuthenticatedRequest, res) => {
  try {
    const account = accountId(req);
    const tender = await analyseSavedTender(account, routeParam(req.params.id));
    res.json({ tender: await tenderWithAnswers(account, tender) });
  } catch (error) { const mapped = safeError(error); res.status(mapped.status).json({ error: mapped.message }); }
});

app.post("/api/tenders/:id/answers/:questionId/draft", async (req: AuthenticatedRequest, res) => {
  try {
    const account = accountId(req);
    const tender = await getTender(account, routeParam(req.params.id));
    if (!tender?.analysis) return res.status(409).json({ error: "Run tender analysis before drafting responses" });
    const questionId = routeParam(req.params.questionId);
    const question = tender.analysis.questions.find((item) => item.id === questionId);
    if (!question) return res.status(404).json({ error: "Scored question not found" });
    const [company, evidence, people, answers] = await Promise.all([getCompany(account), listEvidence(account), listPeople(account), listAnswers(tender.id)]);
    const draft = await draftBidAnswer({ tender, company, question, evidence, people, existingAnswers: answers });
    await saveAnswer(tender.id, question.id, draft.answer, draft.missingInputs.length ? "needs-input" : "draft", draft.evidenceUsed);
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
    res.json({ answer });
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

app.get("/api/tenders/:id/red-team", async (req: AuthenticatedRequest, res) => {
  try {
    const account = accountId(req);
    const tender = await getTender(account, routeParam(req.params.id));
    if (!tender?.analysis) return res.status(409).json({ error: "Analyse the tender first" });
    const [answers, documents] = await Promise.all([listAnswers(tender.id), listDocuments(tender.id)]);
    const issues = submissionBlockers(tender, tender.analysis, answers, documents).map((message) => ({ severity: "BLOCKER", message }));
    for (const question of tender.analysis.questions) {
      const answer = answers.find((item) => item.questionId === question.id);
      const words = answer?.response.trim() ? answer.response.trim().split(/\s+/).length : 0;
      if (question.maxWords > 0 && words > question.maxWords) issues.push({ severity: "BLOCKER", message: `${question.title}: ${words} words exceeds the ${question.maxWords}-word limit` });
      if (answer?.response.includes("[INPUT NEEDED:")) issues.push({ severity: "BLOCKER", message: `${question.title}: unresolved INPUT NEEDED placeholder` });
    }
    res.json({ ready: !issues.length, issues });
  } catch (error) { const mapped = safeError(error); res.status(mapped.status).json({ error: mapped.message }); }
});

app.get("/api/tenders/:id/deck", async (req: AuthenticatedRequest, res) => {
  try {
    const account = accountId(req);
    const tender = await getTender(account, routeParam(req.params.id));
    if (!tender?.analysis) return res.status(409).json({ error: "Analyse the tender before generating a synopsis deck" });
    const deck = await createSynopsisDeck(tender, tender.analysis, await getCompany(account));
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.presentationml.presentation");
    res.setHeader("Content-Disposition", `attachment; filename="Tenderly_${tender.externalId || "Bid"}_Synopsis.pptx"`);
    res.send(deck);
  } catch (error) { const mapped = safeError(error); res.status(mapped.status).json({ error: mapped.message }); }
});

app.get("/api/tenders/:id/pack", async (req: AuthenticatedRequest, res) => {
  try {
    const account = accountId(req);
    const tender = await getTender(account, routeParam(req.params.id));
    if (!tender?.analysis) return res.status(409).json({ error: "Analyse the tender before building a pack" });
    const draft = String(req.query.draft).toLowerCase() === "true";
    const [answers, documents, company, people, evidence] = await Promise.all([listAnswers(tender.id), listDocuments(tender.id), getCompany(account), listPeople(account), listEvidence(account)]);
    const result = await createSubmissionPack({ tender, analysis: tender.analysis, answers, documents, company, people, evidence, draft });
    if (!result.buffer) return res.status(409).json({ error: "Final submission pack is blocked", blockers: result.blockers });
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

await initializeDatabase();
// Re-key analyses written before stable question ids existed (TLY-40). Idempotent.
const migrated = await migrateAnalysisSchema();
if (migrated.tenders) console.log(`analysis schema migration · tenders=${migrated.tenders} answers=${migrated.answers} checklistOverrides=${migrated.overrides}`);
app.listen(port, "0.0.0.0", () => {
  console.log(`Tenderly API listening on port ${port} · database=${persistentDatabase ? "postgres" : "memory"} · ai=${aiConfigured() ? "configured" : "not-configured"}`);
});
