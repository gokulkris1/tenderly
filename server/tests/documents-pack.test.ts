import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import { extractDocumentText } from "../src/documents.js";
import { citedPeople, createSubmissionPack, createSynopsisDeck, submissionBlockers } from "../src/pack.js";
import { certificateStatus } from "../src/serializers.js";
import type { CompanyProfile, EvidenceRecord, PersonRecord, RequiredCertificate, TenderAnalysis, TenderRecord } from "../src/types.js";

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

test("an expired certificate blocks the final pack and the blocker names the expiry", () => {
  const certificate: RequiredCertificate = {
    name: "Tax clearance certificate", issuingBody: "Revenue", mandatory: true,
    evidence: { sourceDocument: "ITT.pdf", quote: "A current tax clearance certificate is required.", confidence: "HIGH" },
  };
  const lapsed: EvidenceRecord = {
    id: "ev-tax", accountId: "a", kind: "tax-clearance", name: "Tax clearance certificate",
    content: "", tags: [], verified: true, expiresOn: "2020-06-30",
  };

  const status = certificateStatus([certificate], [lapsed])[0];
  assert.equal(status.satisfied, false, "a lapsed certificate must not satisfy a mandatory requirement");
  assert.equal(status.expiredBy, "Tax clearance certificate");
  assert.equal(status.expiredOn, "2020-06-30");
  assert.equal(status.satisfiedBy, undefined, "satisfiedBy and expiredBy must never both be set");

  // "missing" sent the user hunting for a document already uploaded.
  const current: EvidenceRecord = { ...lapsed, id: "ev-tax-2", expiresOn: "2099-01-01" };
  const satisfied = certificateStatus([certificate], [current])[0];
  assert.equal(satisfied.satisfied, true);
  assert.equal(satisfied.expiredBy, undefined);
});

test("TLY-236: the final pack is blocked by an unresolved [INPUT NEEDED] placeholder", async () => {
  // Everything else about this bid is in order: the answer is marked ready by a
  // human, and it is the only required question. The placeholder is the one
  // thing wrong with it, and it used to be checked only by the advisory
  // red-team endpoint — so the final ZIP was handed over with the words
  // "[INPUT NEEDED: 2025 audited turnover]" inside the buyer's own document.
  const withGap = {
    id: "a", tenderId: "t1", questionId: "q1", status: "ready", evidence: [],
    response: "We will deliver to the stated schedule. [INPUT NEEDED: 2025 audited turnover]",
  };
  const attested = { ...tender, metadata: { attestation: undefined } } as TenderRecord;

  const blockers = submissionBlockers(attested, analysis, [withGap], []);
  const gap = blockers.find((b) => b.includes("[INPUT NEEDED]"));
  assert.ok(gap, `expected an INPUT NEEDED blocker, got: ${JSON.stringify(blockers)}`);
  assert.match(gap, /Methodology/);
  assert.match(gap, /2025 audited turnover/, "the blocker must name the missing fact, not just that one exists");

  // And the pack itself must refuse, not merely report.
  const pack = await createSubmissionPack({
    tender: attested, analysis, answers: [withGap], documents: [], company,
    people: [], evidence: [], draft: false,
  });
  assert.equal(pack.buffer, null, "a pack carrying a placeholder must not be produced");
  assert.ok(pack.blockers.some((b) => b.includes("[INPUT NEEDED]")));

  // The draft pack is still available: that is how the bidder sees what is left.
  const draft = await createSubmissionPack({
    tender: attested, analysis, answers: [withGap], documents: [], company,
    people: [], evidence: [], draft: true,
  });
  assert.ok(draft.buffer, "the draft pack must still be downloadable");
});

test("TLY-236: the final pack is blocked by an answer over the buyer's word limit", () => {
  // maxWords is 700 on q1. Buyers commonly stop reading at the limit or mark
  // the answer to zero, so over-limit is a formality failure, not a style note.
  const tooLong = {
    id: "a", tenderId: "t1", questionId: "q1", status: "ready", evidence: [],
    response: Array.from({ length: 701 }, (_, i) => `word${i}`).join(" "),
  };
  const blockers = submissionBlockers(tender, analysis, [tooLong], []);
  const over = blockers.find((b) => b.includes("exceeds"));
  assert.ok(over, `expected a word-limit blocker, got: ${JSON.stringify(blockers)}`);
  assert.match(over, /701 words exceeds the 700-word limit/);

  // Exactly at the limit is allowed — the limit is inclusive.
  const atLimit = { ...tooLong, response: Array.from({ length: 700 }, (_, i) => `word${i}`).join(" ") };
  assert.equal(submissionBlockers(tender, analysis, [atLimit], []).some((b) => b.includes("exceeds")), false);

  // A question with no stated limit is never blocked for length.
  const unlimited = { ...analysis, questions: [{ ...analysis.questions[0], maxWords: 0 }] };
  assert.equal(submissionBlockers(tender, unlimited, [tooLong], []).some((b) => b.includes("exceeds")), false);
});

test("TLY-236: an answered optional question is checked too", () => {
  // The response document carries optional answers as well, so a placeholder in
  // one reaches the buyer exactly the same way.
  const optional = {
    ...analysis,
    questions: [{ ...analysis.questions[0], id: "q2", title: "Social value", required: false, maxWords: 0 }],
  };
  const answer = {
    id: "b", tenderId: "t1", questionId: "q2", status: "ready", evidence: [],
    response: "Our approach. [INPUT NEEDED: community partner name]",
  };
  const blockers = submissionBlockers(tender, optional, [answer], []);
  assert.ok(blockers.some((b) => b.includes("Social value") && b.includes("[INPUT NEEDED]")));

  // An unanswered optional question is not a blocker.
  assert.equal(submissionBlockers(tender, optional, [], []).some((b) => b.includes("Social value")), false);
});

test("TLY-239: the pack carries only the CVs this bid names", async () => {
  const person = (id: string, name: string, over: Partial<PersonRecord> = {}): PersonRecord =>
    ({ id, accountId: "a1", name, title: "Consultant", cvText: `${name} experience`, skills: ["delivery"], ...over });

  const roster = [
    person("p1", "Assigned One"), person("p2", "Assigned Two"), person("p3", "Assigned Three"),
    person("p4", "Uninvolved Colleague"),
    person("p5", "Former Employee", { archivedAt: "2025-02-01T00:00:00.000Z" }),
  ];

  // Three roles filled. p4 has nothing to do with this tender, and p5 left.
  const assigned = { ...tender, metadata: { roleAssignments: { "project-manager": "p1", "lead-engineer": "p2", "qa-lead": "p3" } } } as TenderRecord;
  const cited = citedPeople(assigned, roster);
  assert.deepEqual(cited.map((p) => p.name), ["Assigned One", "Assigned Two", "Assigned Three"],
    "an uninvolved colleague's CV must never reach a buyer");

  // An assigned person who has since been archived is still part of the bid.
  const withFormer = { ...tender, metadata: { roleAssignments: { "project-manager": "p1", "qa-lead": "p5" } } } as TenderRecord;
  assert.deepEqual(citedPeople(withFormer, roster).map((p) => p.name), ["Assigned One", "Former Employee"]);

  // No assignments means no CVs, not every CV.
  assert.deepEqual(citedPeople({ ...tender, metadata: {} } as TenderRecord, roster), []);

  // The same person on two roles appears once.
  const doubled = { ...tender, metadata: { roleAssignments: { a: "p1", b: "p1" } } } as TenderRecord;
  assert.equal(citedPeople(doubled, roster).length, 1);

  // And an assignment naming somebody no longer on the account is skipped
  // rather than throwing while the pack is being built.
  const stale = { ...tender, metadata: { roleAssignments: { a: "gone" } } } as TenderRecord;
  assert.deepEqual(citedPeople(stale, roster), []);

  // The pack itself, not just the helper: the whole roster goes in, and only
  // the named CVs must come out.
  const pack = await createSubmissionPack({
    tender: withFormer, analysis, answers: [], documents: [], company,
    people: roster, evidence: [], draft: true,
  });
  assert.ok(pack.buffer);
  const zip = await (await import("jszip")).default.loadAsync(pack.buffer!);
  const cvs = Object.keys(zip.files).filter((name) => name.includes("_CV_"));
  assert.equal(cvs.length, 2, `expected two CVs, got ${JSON.stringify(cvs)}`);
  assert.ok(cvs.some((n) => n.includes("Assigned One")), JSON.stringify(cvs));
  assert.ok(cvs.some((n) => n.includes("Former Employee")), JSON.stringify(cvs));
  assert.equal(cvs.some((n) => n.includes("Uninvolved")), false,
    "an uninvolved colleague's CV reached the buyer");
  assert.equal(cvs.some((n) => n.includes("Assigned Two")), false);
});

test("TLY-239: the response document covers only the lots being bid", async () => {
  const fourLots: TenderAnalysis = {
    ...analysis,
    lots: [{ id: "Lot 1", title: "One" }, { id: "Lot 2", title: "Two" }, { id: "Lot 3", title: "Three" }],
    questions: [
      { ...analysis.questions[0], id: "q-all", title: "Whole tender question", lotId: "" },
      { ...analysis.questions[0], id: "q-1", title: "Lot one question", lotId: "Lot 1" },
      { ...analysis.questions[0], id: "q-2", title: "Lot two question", lotId: "Lot 2" },
      { ...analysis.questions[0], id: "q-3", title: "Lot three question", lotId: "Lot 3" },
    ],
  } as TenderAnalysis;

  const onLotTwo = { ...tender, metadata: { selectedLots: ["Lot 2"] } } as TenderRecord;
  const answers = [
    { id: "x", tenderId: "t1", questionId: "q-all", response: "Whole tender answer.", status: "ready", evidence: [] },
    { id: "y", tenderId: "t1", questionId: "q-2", response: "Lot two answer.", status: "ready", evidence: [] },
  ];

  const pack = await createSubmissionPack({
    tender: onLotTwo, analysis: fourLots, answers, documents: [], company,
    people: [], evidence: [], draft: true,
  });
  assert.ok(pack.buffer);

  // The pack is a ZIP whose response document is a .docx — itself a ZIP — so the
  // question text lives in the inner archive's word/document.xml.
  const JSZipLib = (await import("jszip")).default;
  const zip = await JSZipLib.loadAsync(pack.buffer!);
  const responseName = Object.keys(zip.files).find((n) => n.includes("Tender_Response"))!;
  const docx = await JSZipLib.loadAsync(await zip.file(responseName)!.async("nodebuffer"));
  const xml = await docx.file("word/document.xml")!.async("string");

  assert.match(xml, /Whole tender question/);
  assert.match(xml, /Lot two question/);
  assert.doesNotMatch(xml, /Lot one question/, "another lot's question must not reach the buyer");
  assert.doesNotMatch(xml, /Lot three question/);
  assert.doesNotMatch(xml, /RESPONSE REQUIRED/, "no unanswered out-of-scope question should remain");
});
