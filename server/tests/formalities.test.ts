import assert from "node:assert/strict";
import test from "node:test";
import { certificateStatus, serializeTender } from "../src/serializers.js";
import { submissionBlockers } from "../src/pack.js";
import { withStableIds } from "../src/analysis-schema.js";
import { ANALYSIS_PROMPT } from "../src/prompts/index.js";
import type { EvidenceRecord, TenderAnalysis, TenderRecord } from "../src/types.js";

const ev = { sourceDocument: "ITT.pdf", quote: "Tenderers shall hold a current Tax Clearance Certificate.", confidence: "HIGH" as const };
const taxCert = { name: "Tax Clearance Certificate", issuingBody: "Revenue", mandatory: true, evidence: ev };
const insurance = { name: "Employers Liability Insurance", issuingBody: "", mandatory: true, evidence: ev };

const base = { id: "t", accountId: "a", source: "etenders", externalId: "X", title: "T", authority: "A",
  procedure: "Open", deadline: "", estimatedValue: "", description: "", sourceUrl: "https://www.etenders.gov.ie/x",
  published: "", status: "ANALYSED", metadata: {} } as unknown as TenderRecord;

const analysis = (certs = [taxCert], formalities: TenderAnalysis["formalities"] = []): TenderAnalysis => withStableIds({
  headline: "x", executiveSummary: "x", bidType: "OPEN_CONTRACT", access: "OPEN_TO_QUALIFIED_BIDDERS",
  eligibility: "PASS", fitScore: 70, decision: "GO", partnerNeeded: false, partnerGaps: [],
  deadline: "", clarificationDeadline: "", contractValue: "", duration: "", lots: [], fatalGates: [],
  evaluationCriteria: [], questions: [], roles: [], clarificationQuestions: [], risks: [],
  submissionMethod: "eTenders", formalities, requiredCertificates: certs, submissionChecklist: [],
  synopsisSlides: [],
});

const evidenceItem = (name: string, verified: boolean): EvidenceRecord =>
  ({ id: name, accountId: "a", kind: "Certificate", name, content: "", tags: [], verified }) as EvidenceRecord;

test("TLY-43 AC1: required certificates reach the wire with their source quote", () => {
  const wire = serializeTender({ ...base, analysis: analysis([taxCert, insurance]) } as TenderRecord, [], []);
  assert.equal(wire.requiredCertificates?.length, 2);
  assert.equal(wire.requiredCertificates?.[0].name, "Tax Clearance Certificate");
  assert.equal(wire.requiredCertificates?.[0].issuingBody, "Revenue");
  assert.match(wire.requiredCertificates?.[0].quote ?? "", /Tax Clearance/);
});

test("TLY-43 AC2: submission rules are listed separately, each quoted", () => {
  const formalities = [
    { rule: "Maximum 10 pages", appliesTo: "quality response", evidence: { ...ev, quote: "The quality submission shall not exceed 10 pages." } },
    { rule: "Name each file <Tenderer>_<DocumentType>.pdf", appliesTo: "all documents", evidence: ev },
  ];
  const wire = serializeTender({ ...base, analysis: analysis([taxCert], formalities) } as TenderRecord, [], []);
  assert.equal(wire.formalities?.length, 2);
  assert.equal(wire.formalities?.[0].rule, "Maximum 10 pages");
  assert.equal(wire.formalities?.[0].appliesTo, "quality response");
  assert.match(wire.formalities?.[0].quote ?? "", /10 pages/);
});

test("TLY-43 AC5: a certificate with verified evidence is satisfied and cites it", () => {
  const wire = serializeTender({ ...base, analysis: analysis() } as TenderRecord, [], [evidenceItem("Tax Clearance Certificate 2026", true)]);
  const cert = wire.requiredCertificates?.[0];
  assert.equal(cert?.satisfied, true);
  assert.equal(cert?.satisfiedBy, "Tax Clearance Certificate 2026");
});

test("TLY-43: unverified evidence never satisfies a requirement", () => {
  const wire = serializeTender({ ...base, analysis: analysis() } as TenderRecord, [], [evidenceItem("Tax Clearance Certificate 2026", false)]);
  assert.equal(wire.requiredCertificates?.[0].satisfied, false);
});

test("TLY-43 AC3: a missing mandatory certificate blocks the final pack, naming it", () => {
  const blockers = submissionBlockers({ ...base, metadata: {} } as TenderRecord, analysis(), [], [], []);
  assert.ok(blockers.some((b) => /Tax Clearance Certificate — missing/.test(b)), blockers.join(" | "));
});

test("TLY-43 AC5: evidencing the certificate clears that blocker", () => {
  const blockers = submissionBlockers({ ...base, metadata: {} } as TenderRecord, analysis(), [], [], [evidenceItem("Tax Clearance Certificate 2026", true)]);
  assert.equal(blockers.some((b) => /Tax Clearance/.test(b)), false, blockers.join(" | "));
});

test("TLY-43: a certificate the pack only requests does not block the pack", () => {
  const requested = { ...taxCert, mandatory: false };
  const blockers = submissionBlockers({ ...base, metadata: {} } as TenderRecord, analysis([requested]), [], [], []);
  assert.equal(blockers.some((b) => /Tax Clearance/.test(b)), false);
});

test("TLY-43 AC4: nothing is invented when the pack states no rules", () => {
  const wire = serializeTender({ ...base, analysis: analysis([], []) } as TenderRecord, [], []);
  assert.deepEqual(wire.formalities, []);
  assert.deepEqual(wire.requiredCertificates, []);
  assert.match(ANALYSIS_PROMPT, /do not supply a default/i);
});

test("TLY-43: matching is conservative — an unrelated certificate does not satisfy", () => {
  const status = certificateStatus([taxCert], [evidenceItem("Public Liability Insurance schedule", true)]);
  assert.equal(status[0].satisfied, false);
});
