import assert from "node:assert/strict";
import test from "node:test";
import { allAmounts, certificateGate, compareThreshold, parseAmount, reconcileGates, rollUpEligibility } from "../src/eligibility.js";
import type { CompanyProfile, EligibilityGate, EvidenceRecord, RequiredCertificate } from "../src/types.js";

const evidence = { sourceDocument: "ITT.pdf", quote: "Minimum annual turnover of EUR 2,000,000.", confidence: "HIGH" as const };

const company = (over: Partial<CompanyProfile> = {}): CompanyProfile => ({
  name: "Acme", registration: "IE1", turnover: "€3.4m", employees: "22", services: "Software",
  cpv: "72000000", certifications: "", insurance: "€6.5m professional indemnity", ...over,
});

const gate = (over: Partial<EligibilityGate> = {}): EligibilityGate => ({
  id: "turnover", requirement: "Minimum annual turnover", bidderEvidence: "Looks fine",
  status: "PASS", action: "", evidence, ...over,
});

const record = (over: Partial<EvidenceRecord> = {}): EvidenceRecord =>
  ({ id: "e1", accountId: "a", name: "ISO 27001 certificate", kind: "certification", verified: true, ...over }) as EvidenceRecord;

test("TLY-46 AC1: money is read from the shapes tenders actually use", () => {
  assert.equal(parseAmount("EUR 2,000,000"), 2_000_000);
  assert.equal(parseAmount("€2m"), 2_000_000);
  assert.equal(parseAmount("2.5 million"), 2_500_000);
  assert.equal(parseAmount("500k"), 500_000);
  assert.equal(parseAmount("no figure stated"), null, "an unreadable requirement must not become zero");
  assert.equal(parseAmount(""), null);
  assert.equal(parseAmount(undefined), null);
});

test("TLY-46 AC2: a turnover above the threshold passes and one below fails, with the numbers shown", () => {
  const pass = compareThreshold({ id: "turnover", requirement: "Minimum annual turnover",
    requirementText: "Minimum annual turnover of EUR 2,000,000", heldText: "€3.4m", heldLabel: "annual turnover", evidence });
  assert.equal(pass.status, "PASS");
  assert.equal(pass.required, 2_000_000);
  assert.equal(pass.held, 3_400_000);
  assert.equal(pass.action, "", "a passing gate asks the user for nothing");

  const fail = compareThreshold({ id: "turnover", requirement: "Minimum annual turnover",
    requirementText: "Minimum annual turnover of EUR 2,000,000", heldText: "€900,000", heldLabel: "annual turnover", evidence });
  assert.equal(fail.status, "FAIL");
  assert.match(fail.action, /partner/i, "a failing threshold must name the way out");
});

test("TLY-46 AC3: a missing or unreadable fact is REVIEW, never FAIL and never PASS", () => {
  const noProfile = compareThreshold({ id: "turnover", requirement: "Minimum annual turnover",
    requirementText: "Minimum annual turnover of EUR 2,000,000", heldText: "", heldLabel: "annual turnover", evidence });
  assert.equal(noProfile.status, "REVIEW");
  assert.match(noProfile.action, /Record your annual turnover/);

  const noThreshold = compareThreshold({ id: "turnover", requirement: "Minimum annual turnover",
    requirementText: "Bidders must be of adequate financial standing", heldText: "€3.4m", heldLabel: "annual turnover", evidence });
  assert.equal(noThreshold.status, "REVIEW", "no readable threshold cannot be a green tick");
});

test("TLY-46 AC4: conflicting figures are surfaced as a conflict, not silently resolved", () => {
  assert.deepEqual(allAmounts("€3.4m in 2023, €1.2m in 2022"), [3_400_000, 1_200_000]);
  const conflicted = compareThreshold({ id: "turnover", requirement: "Minimum annual turnover",
    requirementText: "Minimum annual turnover of EUR 2,000,000", heldText: "€3.4m in 2023, €1.2m in 2022",
    heldLabel: "annual turnover", evidence });
  assert.equal(conflicted.status, "REVIEW");
  assert.match(conflicted.bidderEvidence, /Conflicting evidence/);
});

test("TLY-46 AC5: only verified evidence satisfies a certificate gate", () => {
  const certificate: RequiredCertificate = { name: "ISO 27001", issuingBody: "NSAI", mandatory: true, evidence };
  assert.equal(certificateGate(certificate, [record()]).status, "PASS");

  const unverified = certificateGate(certificate, [record({ verified: false })]);
  assert.equal(unverified.status, "REVIEW");
  assert.match(unverified.action, /Verify/);

  const missing = certificateGate(certificate, []);
  assert.equal(missing.status, "REVIEW");
  assert.match(missing.bidderEvidence, /No verified evidence/);
});

test("TLY-46 AC6: the model's optimistic verdict is overruled by the arithmetic", () => {
  const { gates, recomputed } = reconcileGates({
    gates: [gate({ status: "PASS", bidderEvidence: "Turnover looks sufficient" })],
    company: company({ turnover: "€900,000" }),
    requiredCertificates: [], evidence: [],
  });
  assert.equal(gates[0].status, "FAIL");
  assert.equal(recomputed.length, 1);
  assert.match(recomputed[0], /PASS -> FAIL/);
});

test("TLY-46 AC7: a mandatory certificate the model omitted is added as a gate", () => {
  const { gates } = reconcileGates({
    gates: [], company: company(),
    requiredCertificates: [{ name: "Tax Clearance Certificate", issuingBody: "Revenue", mandatory: true, evidence }],
    evidence: [],
  });
  assert.equal(gates.length, 1);
  assert.equal(gates[0].requirement, "Tax Clearance Certificate");
  assert.equal(gates[0].status, "REVIEW");
});

test("TLY-46 AC8: eligibility follows the worst gate and an unchecked tender is REVIEW", () => {
  assert.equal(rollUpEligibility([]), "REVIEW");
  assert.equal(rollUpEligibility([gate({ status: "PASS" })]), "PASS");
  assert.equal(rollUpEligibility([gate({ status: "PASS" }), gate({ status: "REVIEW" })]), "REVIEW");
  assert.equal(rollUpEligibility([gate({ status: "REVIEW" }), gate({ status: "FAIL" })]), "FAIL");
  assert.equal(rollUpEligibility([gate({ status: "NOT_APPLICABLE" })]), "REVIEW", "ignoring N/A leaves nothing checked");
});

test("TLY-46 AC9: a gate we cannot decide keeps the model's own wording", () => {
  const original = gate({ id: "site-visit", requirement: "Attend the mandatory site visit",
    status: "REVIEW", bidderEvidence: "No attendance recorded",
    evidence: { sourceDocument: "ITT.pdf", quote: "Attendance is mandatory.", confidence: "HIGH" } });
  const { gates, recomputed } = reconcileGates({ gates: [original], company: company(), requiredCertificates: [], evidence: [] });
  assert.deepEqual(gates[0], original);
  assert.equal(recomputed.length, 0);
});
