import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import { extractDocumentText } from "../src/documents.js";
import { createSubmissionPack, createSynopsisDeck, submissionBlockers } from "../src/pack.js";
import type { CompanyProfile, TenderAnalysis, TenderRecord } from "../src/types.js";

const evidence = { sourceDocument: "RFT.docx", quote: "The competition is open to suitably qualified tenderers.", confidence: "HIGH" as const };
const analysis: TenderAnalysis = {
  headline: "Strong fit", executiveSummary: "Open consultancy opportunity with a strong delivery fit.", bidType: "OPEN_CONTRACT", access: "OPEN_TO_QUALIFIED_BIDDERS", eligibility: "PASS", fitScore: 84, decision: "GO", partnerNeeded: false, partnerGaps: [], deadline: "27/08/2026 12:00", clarificationDeadline: "20/08/2026 12:00", contractValue: "€49,000", duration: "12 months", lots: [],
  fatalGates: [{ id: "access", requirement: "Competition access", bidderEvidence: "Open procedure", status: "PASS", action: "None", evidence }],
  evaluationCriteria: [{ name: "Methodology", weight: 60, rawWeight: "60%", minimumScore: 0, strategy: "Answer with delivery controls", confidence: "HIGH", evidence }],
  questions: [{ id: "q1", title: "Methodology", prompt: "Describe your methodology", weight: 60, maxWords: 700, required: true, evidenceNeeded: ["Delivery case study"], source: evidence }],
  roles: [], clarificationQuestions: [], risks: [], submissionMethod: "eTenders ZIP upload", formalities: [], requiredCertificates: [], submissionChecklist: [], synopsisSlides: [{ title: "The opportunity", bullets: ["Open competition", "€49,000", "Closes 27 August"] }, { title: "Can we bid?", bullets: ["Access gate passed", "Strong capability fit"] }],
};
const tender: TenderRecord = { id: "t1", accountId: "a1", source: "etenders", externalId: "8796138", title: "PMP Training", authority: "Buyer", description: "Training", published: "6 Aug", deadline: "27 Aug", procedure: "Open", status: "Tender Submission", estimatedValue: "49,000", sourceUrl: "https://www.etenders.gov.ie/", metadata: {}, analysis };
const company: CompanyProfile = { name: "Example Consulting Ltd", registration: "123", turnover: "€1m", employees: "5", services: "Programme delivery", cpv: "", certifications: "PMP", insurance: "PI €2m" };

test("extracts plain-text source material", async () => {
  const result = await extractDocumentText("RFT.txt", Buffer.from("Mandatory requirement: professional indemnity insurance."));
  assert.equal(result[0].status, "EXTRACTED");
  assert.match(result[0].text, /professional indemnity/);
});

test("extracts bounded XLSX source material", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Pricing");
  sheet.addRow(["Role", "Daily rate"]);
  sheet.addRow(["Programme Manager", 950]);
  const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
  const result = await extractDocumentText("pricing.xlsx", bytes);
  assert.equal(result[0].status, "EXTRACTED");
  assert.match(result[0].text, /Programme Manager/);
  assert.match(result[0].text, /950/);
});

test("final pack is blocked until required answers are human-ready", async () => {
  const draftAnswer = { id: "a", tenderId: "t1", questionId: "q1", response: "Draft response", status: "draft", evidence: [] };
  const blockers = submissionBlockers(tender, analysis, [draftAnswer], []);
  assert.ok(blockers.some((item) => item.includes("Required response not ready")));
  const finalPack = await createSubmissionPack({ tender, analysis, answers: [draftAnswer], documents: [], company, people: [], evidence: [], draft: false });
  assert.equal(finalPack.buffer, null);
  const draftPack = await createSubmissionPack({ tender, analysis, answers: [draftAnswer], documents: [], company, people: [], evidence: [], draft: true });
  assert.ok(draftPack.buffer && draftPack.buffer.subarray(0, 2).toString() === "PK");
});

test("generates a real PPTX synopsis deck", async () => {
  const deck = await createSynopsisDeck(tender, analysis, company);
  assert.ok(deck.length > 10_000);
  assert.equal(deck.subarray(0, 2).toString(), "PK");
});
