import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";
import { exclusionNotes, partitionEvidence, resolveCitations } from "../src/citations.js";
import { DRAFTING_PROMPT } from "../src/prompts/index.js";
import { serializeTender } from "../src/serializers.js";
import { createSubmissionPack } from "../src/pack.js";
import { withStableIds } from "../src/analysis-schema.js";
import type { BidAnswer, EvidenceRecord, TenderAnalysis, TenderRecord } from "../src/types.js";

const NOW = new Date(Date.UTC(2026, 7, 24));

const item = (over: Partial<EvidenceRecord>): EvidenceRecord => ({
  id: over.id ?? Math.random().toString(36).slice(2), accountId: "a", kind: "Certificate",
  name: "ISO 9001 certificate", content: "Certified to ISO 9001:2015 until 2027.",
  tags: [], verified: true, filename: "iso-9001.pdf", ...over,
});

const source = { sourceDocument: "ITT.pdf", quote: "Describe your quality management system.", confidence: "HIGH" as const };
const analysis = (): TenderAnalysis => withStableIds({
  headline: "x", executiveSummary: "x", bidType: "OPEN_CONTRACT", access: "OPEN_TO_QUALIFIED_BIDDERS",
  eligibility: "PASS", fitScore: 70, decision: "GO", partnerNeeded: false, partnerGaps: [],
  deadline: "26/03/2027", clarificationDeadline: "", contractValue: "", duration: "", lots: [],
  fatalGates: [], evaluationCriteria: [],
  questions: [{ id: "q", title: "Quality management", prompt: "Describe your quality management system.", weight: 40, maxWords: 500, required: true, evidenceNeeded: [], lotId: "", source }],
  roles: [], clarificationQuestions: [], risks: [], submissionMethod: "eTenders",
  formalities: [], requiredCertificates: [],
  aiUsePolicy: { state: "not-stated", evidence: { sourceDocument: "", quote: "", confidence: "LOW" } },
  submissionChecklist: [], synopsisSlides: [],
});

test("TLY-58 AC1: a verified, in-date vault document is citable with its text", () => {
  const { citable, excluded } = partitionEvidence([item({ expiresOn: "31/12/2027" })], new Date(NOW));
  assert.equal(citable.length, 1);
  assert.equal(citable[0].name, "ISO 9001 certificate");
  assert.equal(citable[0].hasFile, true, "so the citation can be opened");
  assert.match(citable[0].content, /ISO 9001/);
  assert.deepEqual(excluded, []);
});

test("TLY-58 AC3: an expired document is excluded, and the model is told why", () => {
  const { citable, excluded } = partitionEvidence([item({ expiresOn: "31/12/2024" })], new Date(NOW));
  assert.deepEqual(citable, [], "an expired certificate is evidence of the opposite");
  assert.equal(excluded[0].reason, "expired");

  const notes = exclusionNotes(excluded);
  assert.match(notes[0].note, /expired/);
  assert.match(notes[0].note, /INPUT NEEDED/, "naming it is what produces a useful placeholder");
});

test("TLY-58 AC4: an unverified document is excluded, and named as unverified", () => {
  const { citable, excluded } = partitionEvidence([item({ verified: false })], new Date(NOW));
  assert.deepEqual(citable, []);
  assert.equal(excluded[0].reason, "unverified");
  assert.match(exclusionNotes(excluded)[0].note, /not verified/);
});

test("TLY-58: the drafting prompt forbids citing what cannot be used", () => {
  assert.match(DRAFTING_PROMPT, /evidenceHeldButUnusable must NOT be cited/);
  assert.match(DRAFTING_PROMPT, /\[INPUT NEEDED/);
});

test("TLY-58 AC2: a citation resolves to an identifier, not just a name", () => {
  const iso = item({ id: "iso-id", name: "ISO 9001 certificate" });
  const insurance = item({ id: "ins-id", name: "Public liability certificate", filename: undefined });
  const { citable } = partitionEvidence([iso, insurance], new Date(NOW));

  const resolved = resolveCitations(["ISO 9001 certificate", "Public liability certificate"], citable);
  assert.deepEqual(resolved.map((entry) => entry.id), ["iso-id", "ins-id"]);
  assert.equal(resolved[0].hasFile, true, "this one opens");
  assert.equal(resolved[1].hasFile, false, "this one has no file to open, and says so");
});

test("TLY-58: a name matching nothing citable is dropped, not recorded as a dangling citation", () => {
  const { citable } = partitionEvidence([item({ id: "iso-id" })], new Date(NOW));
  const resolved = resolveCitations(["A document we do not hold", "ISO 9001 certificate", "ISO 9001 certificate"], citable);
  assert.deepEqual(resolved.map((entry) => entry.id), ["iso-id"], "unknown dropped, duplicate collapsed");
});

test("TLY-58 AC2: the wire carries the citation so the UI can open it", () => {
  const evidence = [item({ id: "iso-id" })];
  const answers: BidAnswer[] = [{ id: "a1", tenderId: "t", questionId: analysis().questions[0].id, response: "We are certified.", status: "draft", evidence: ["iso-id"] }];
  const record = {
    id: "t", accountId: "a", source: "seed", externalId: "X", title: "T", authority: "A",
    procedure: "Open", deadline: "", estimatedValue: "", description: "", sourceUrl: "https://www.etenders.gov.ie/x",
    published: "", status: "ANALYSED", metadata: {}, analysis: analysis(),
  } as unknown as TenderRecord;

  const wire = serializeTender(record, answers, evidence);
  const question = wire.questions[0];
  assert.deepEqual(question.citations, [{ id: "iso-id", name: "ISO 9001 certificate", hasFile: true }]);
});

test("TLY-58: a citation whose document was deleted stops appearing rather than pointing at a ghost", () => {
  const answers: BidAnswer[] = [{ id: "a1", tenderId: "t", questionId: analysis().questions[0].id, response: "x", status: "draft", evidence: ["deleted-id"] }];
  const record = {
    id: "t", accountId: "a", source: "seed", externalId: "X", title: "T", authority: "A",
    procedure: "Open", deadline: "", estimatedValue: "", description: "", sourceUrl: "https://www.etenders.gov.ie/x",
    published: "", status: "ANALYSED", metadata: {}, analysis: analysis(),
  } as unknown as TenderRecord;

  const wire = serializeTender(record, answers, []);
  assert.deepEqual(wire.questions[0].citations, []);
});

test("TLY-58 AC5: the draft pack's evidence register lists both cited documents", async () => {
  const evidence = [
    item({ id: "iso-id", name: "ISO 9001 certificate" }),
    item({ id: "ins-id", name: "Public liability certificate" }),
  ];
  const answers: BidAnswer[] = [
    { id: "a1", tenderId: "t", questionId: analysis().questions[0].id, response: "We are certified.", status: "ready", evidence: ["iso-id", "ins-id"] },
  ];
  const record = {
    id: "t", accountId: "a", source: "seed", externalId: "X", title: "Quality tender", authority: "A",
    procedure: "Open", deadline: "", estimatedValue: "", description: "", sourceUrl: "https://www.etenders.gov.ie/x",
    published: "", status: "ANALYSED", metadata: {}, analysis: analysis(),
  } as unknown as TenderRecord;

  const company = { name: "Acme", registration: "", turnover: "", employees: "", services: "", cpv: "", certifications: "", insurance: "" };
  const result = await createSubmissionPack({
    tender: record, analysis: analysis(), answers, documents: [], company, people: [], evidence, draft: true,
  });
  assert.ok(result.buffer);

  const zip = await JSZip.loadAsync(result.buffer);
  const register = zip.file("_Tenderly_Internal/Evidence_Register.docx");
  assert.ok(register, "the draft pack carries an evidence register");
  // A .docx is itself a zip, so the text lives in word/document.xml.
  const document = await JSZip.loadAsync(await register.async("nodebuffer"));
  const xml = await document.file("word/document.xml")!.async("string");
  assert.ok(xml.includes("ISO 9001 certificate"), "the first cited document is named");
  assert.ok(xml.includes("Public liability certificate"), "and so is the second");
  assert.ok(xml.includes("Cited by 1 answer"), "and the register says what rests on it");
});
