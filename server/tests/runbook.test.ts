import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";
import bcrypt from "bcryptjs";
import { signToken } from "../src/auth.js";
import { addEvidence, createUser, initializeDatabase, saveAnswer, saveTenderAnalysis, upsertTender } from "../src/db.js";
import { NAMING_UNKNOWN, buildRunbook, runbookText } from "../src/runbook.js";
import { createSubmissionPack } from "../src/pack.js";
import { withStableIds } from "../src/analysis-schema.js";
import type { TenderAnalysis, TenderRecord } from "../src/types.js";

const source = { sourceDocument: "ITT.pdf", quote: "Each document shall be uploaded separately.", confidence: "HIGH" as const };

const analysis = (over: Partial<TenderAnalysis> = {}): TenderAnalysis => withStableIds({
  headline: "x", executiveSummary: "x", bidType: "OPEN_CONTRACT", access: "OPEN_TO_QUALIFIED_BIDDERS",
  eligibility: "PASS", fitScore: 70, decision: "GO", partnerNeeded: false, partnerGaps: [],
  deadline: "26/03/2026 12:00", clarificationDeadline: "", contractValue: "", duration: "", lots: [],
  fatalGates: [], evaluationCriteria: [], questions: [], roles: [],
  clarificationQuestions: [], risks: [],
  submissionMethod: "eTenders portal",
  formalities: [
    { rule: "Each document shall be uploaded separately in PDF format", appliesTo: "all documents", evidence: source },
    { rule: "Pricing shall be submitted on the buyer's template only", appliesTo: "pricing", evidence: { ...source, quote: "Pricing shall be submitted on the template provided." } },
  ],
  requiredCertificates: [],
  aiUsePolicy: { state: "not-stated", evidence: { sourceDocument: "", quote: "", confidence: "LOW" } },
  submissionChecklist: [
    { id: "response", label: "Tender response document", required: true, kind: "RESPONSE", status: "READY", source },
    { id: "pricing", label: "Completed pricing schedule", required: true, kind: "PRICING", status: "READY", source },
    { id: "declaration", label: "Signed declaration", required: true, kind: "SIGNATURE", status: "READY", source },
  ],
  synopsisSlides: [],
  ...over,
});

const record = (stored: TenderAnalysis | null, metadata: Record<string, unknown> = {}) => ({
  id: "t", accountId: "a", source: "seed", externalId: "X", title: "Runbook tender", authority: "A",
  procedure: "Open", deadline: "26/03/2026 12:00", estimatedValue: "", description: "",
  sourceUrl: "https://www.etenders.gov.ie/x", published: "", status: "ANALYSED", metadata, analysis: stored,
}) as unknown as TenderRecord;

process.env.JWT_SECRET ||= "test-secret-that-is-at-least-32-characters";
process.env.TENDERLY_NO_LISTEN = "1";
await initializeDatabase();
const { app } = await import("../src/index.js");
const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const address = server.address();
const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
server.unref();

const email = `runbook-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;
const user = await createUser(email, await bcrypt.hash("x", 4), "Runbook Ltd");
const headers = { authorization: `Bearer ${signToken({ id: user.id, organisationId: user.organisationId, email })}`, "content-type": "application/json" };

test("TLY-82 AC1: every required document is its own upload step, in the pack's order", () => {
  const runbook = buildRunbook(record(analysis()), analysis());
  const uploads = runbook.steps.filter((step) => step.text.startsWith("Upload:"));
  assert.deepEqual(uploads.map((step) => step.text), [
    "Upload: Tender response document",
    "Upload: Completed pricing schedule",
    "Upload: Signed declaration",
  ]);
  assert.ok(uploads.every((step) => step.source), "each cites the sentence it came from");
});

test("TLY-82 AC3: the channel and deadline are stated up front", () => {
  const runbook = buildRunbook(record(analysis()), analysis());
  assert.equal(runbook.channel, "eTenders portal");
  assert.equal(runbook.deadline, "26/03/2026 12:00");
  assert.match(runbookText(record(analysis()), runbook), /Channel: eTenders portal/);
});

test("TLY-82: every formality is its own step rather than being summarised away", () => {
  const runbook = buildRunbook(record(analysis()), analysis());
  assert.ok(runbook.steps.some((step) => step.text.includes("Pricing shall be submitted on the buyer's template")),
    "bids fail on formalities, so none of them is collapsed into another");
});

test("TLY-82 AC5: with no formalities the steps are generic and say what is missing", () => {
  const bare = analysis({ formalities: [], submissionChecklist: [] });
  const runbook = buildRunbook(record(bare), bare);

  assert.equal(runbook.generic, true);
  const naming = runbook.steps.find((step) => step.text.includes("naming convention"));
  assert.match(naming?.text ?? "", /\[INPUT NEEDED: file naming rules\]/,
    "a made-up naming rule followed confidently is worse than an obvious gap");
  assert.ok(runbook.steps.some((step) => step.text.includes("Upload the response document")));
});

test("TLY-82: an unstated channel or deadline says so rather than guessing", () => {
  const bare = analysis({ formalities: [], submissionChecklist: [], submissionMethod: "", deadline: "" });
  const runbook = buildRunbook(
    { ...record(bare), deadline: "" } as TenderRecord,
    bare,
  );
  assert.equal(runbook.channel, "[INPUT NEEDED: submission channel]");
  assert.equal(runbook.deadline, "[INPUT NEEDED: submission deadline]");
});

test("TLY-82 AC2: ticks persist and are counted", async () => {
  const tender = await upsertTender(user.organisationId, {
    source: "seed", externalId: `runbook-${Date.now()}`, title: "Ticked tender", authority: "Authority",
    procedure: "Open", deadline: "26/03/2026 12:00", estimatedValue: "", description: "",
    sourceUrl: "https://www.etenders.gov.ie/x", published: "", status: "ANALYSED", metadata: {},
  });
  await saveTenderAnalysis(user.organisationId, tender.id, analysis());

  const before = await fetch(`${base}/api/tenders/${tender.id}/runbook`, { headers })
    .then((r) => r.json() as Promise<{ runbook: { steps: { id: string; done: boolean }[] }; completed: number; total: number }>);
  assert.equal(before.completed, 0);
  assert.ok(before.total > 3);

  const target = before.runbook.steps[0].id;
  const ticked = await fetch(`${base}/api/tenders/${tender.id}/runbook/${target}`, {
    method: "POST", headers, body: JSON.stringify({ done: true }),
  });
  assert.equal(ticked.status, 200);

  const after = await fetch(`${base}/api/tenders/${tender.id}/runbook`, { headers })
    .then((r) => r.json() as Promise<{ runbook: { steps: { id: string; done: boolean }[] }; completed: number }>);
  assert.equal(after.completed, 1, "the tick survives a reload");
  assert.equal(after.runbook.steps.find((step) => step.id === target)?.done, true);
});

test("TLY-82: a step that is not in the runbook cannot be ticked", async () => {
  const tender = await upsertTender(user.organisationId, {
    source: "seed", externalId: `runbook-bad-${Date.now()}`, title: "Bad step tender", authority: "Authority",
    procedure: "Open", deadline: "26/03/2026", estimatedValue: "", description: "",
    sourceUrl: "https://www.etenders.gov.ie/x", published: "", status: "ANALYSED", metadata: {},
  });
  await saveTenderAnalysis(user.organisationId, tender.id, analysis());

  const response = await fetch(`${base}/api/tenders/${tender.id}/runbook/step-invented`, {
    method: "POST", headers, body: JSON.stringify({ done: true }),
  });
  assert.equal(response.status, 404);
});

test("TLY-82 AC4: the final ZIP carries the runbook, listing the same steps", async () => {
  const stored = analysis();
  const tender = await upsertTender(user.organisationId, {
    source: "seed", externalId: `runbook-zip-${Date.now()}`, title: "Packed tender", authority: "Authority",
    procedure: "Open", deadline: "26/03/2026 12:00", estimatedValue: "", description: "",
    sourceUrl: "https://www.etenders.gov.ie/x", published: "", status: "ANALYSED", metadata: {},
  });
  await saveTenderAnalysis(user.organisationId, tender.id, stored);
  await addEvidence(user.organisationId, { kind: "Case study", name: "Reference", content: "x", tags: [], verified: true });
  await saveAnswer(tender.id, "seed", "An answer.", "ready", []);

  const result = await createSubmissionPack({
    tender: record(stored), analysis: stored, answers: [], documents: [],
    company: { name: "Acme", registration: "", turnover: "", employees: "", services: "", cpv: "", certifications: "", insurance: "" },
    people: [], evidence: [], draft: true,
  });
  assert.ok(result.buffer);

  const zip = await JSZip.loadAsync(result.buffer);
  const runbookFile = zip.file("DRAFT_Submission_Runbook.txt");
  assert.ok(runbookFile, "whoever opens this ZIP is the person who has to do the uploading");
  const text = await runbookFile.async("string");
  assert.match(text, /Channel: eTenders portal/);
  assert.match(text, /Upload: Completed pricing schedule/);
  assert.match(text, /Tenderly does not submit on your behalf/);
});

test("TLY-82: step ids are stable, so a tick survives regenerating the runbook", () => {
  const first = buildRunbook(record(analysis()), analysis()).steps.map((step) => step.id);
  const second = buildRunbook(record(analysis()), analysis()).steps.map((step) => step.id);
  assert.deepEqual(first, second);
});
