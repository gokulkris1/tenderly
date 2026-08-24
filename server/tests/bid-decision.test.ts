import assert from "node:assert/strict";
import test from "node:test";
import bcrypt from "bcryptjs";
import { signToken } from "../src/auth.js";
import { createUser, initializeDatabase, listBidDecisions, saveTenderAnalysis, upsertTender } from "../src/db.js";
import { withStableIds } from "../src/analysis-schema.js";
import type { GateStatus, TenderAnalysis } from "../src/types.js";

const evidence = { sourceDocument: "ITT.pdf", quote: "Tenderers shall hold tax clearance.", confidence: "HIGH" as const };
const gate = (id: string, status: GateStatus) =>
  ({ id, requirement: `Requirement ${id}`, bidderEvidence: "", status, action: "", lotId: "", evidence });

const analysis = (gates: ReturnType<typeof gate>[], fitScore = 80): TenderAnalysis => withStableIds({
  headline: "x", executiveSummary: "x", bidType: "OPEN_CONTRACT", access: "OPEN_TO_QUALIFIED_BIDDERS",
  eligibility: "REVIEW", fitScore, decision: "REVIEW", partnerNeeded: false, partnerGaps: [],
  deadline: "26/03/2027", clarificationDeadline: "", contractValue: "", duration: "", lots: [],
  fatalGates: gates, evaluationCriteria: [], questions: [], roles: [],
  clarificationQuestions: [], risks: [], submissionMethod: "eTenders",
  formalities: [], requiredCertificates: [],
  aiUsePolicy: { state: "not-stated", evidence: { sourceDocument: "", quote: "", confidence: "LOW" } },
  submissionChecklist: [], synopsisSlides: [],
});

process.env.JWT_SECRET ||= "test-secret-that-is-at-least-32-characters";
process.env.TENDERLY_NO_LISTEN = "1";
await initializeDatabase();
const { app } = await import("../src/index.js");
const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const address = server.address();
const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
server.unref();

const email = `decision-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;
const user = await createUser(email, await bcrypt.hash("x", 4), "Deciding Ltd");
const token = signToken({ id: user.id, email });
const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

// Each tender needs a distinct title: buyer, title and deadline are the
// cross-portal identity (TLY-32), so fixtures sharing all three are correctly
// treated as one opportunity and merged.
let fixtureCount = 0;
async function tenderWith(gates: ReturnType<typeof gate>[], fitScore = 80) {
  fixtureCount += 1;
  const tender = await upsertTender(user.id, {
    source: "seed", externalId: `dec-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    title: `Decision tender ${fixtureCount}`, authority: "Authority", procedure: "Open", deadline: "26/03/2027",
    estimatedValue: "", description: "", sourceUrl: "https://www.etenders.gov.ie/x", published: "",
    status: "ANALYSED", metadata: {},
  });
  await saveTenderAnalysis(user.id, tender.id, analysis(gates, fitScore));
  return tender;
}

const record = (tenderId: string, decision: "BID" | "NO_BID", reason: string) =>
  fetch(`${base}/api/tenders/${tenderId}/decision`, { method: "POST", headers, body: JSON.stringify({ decision, reason }) });

const load = (tenderId: string) => fetch(`${base}/api/tenders/${tenderId}`, { headers })
  .then((r) => r.json() as Promise<{ tender: import("@tenderly/shared").Tender }>);

test("TLY-50 AC1: a decision is stored with its reason and the person who made it", async () => {
  const tender = await tenderWith([gate("tax", "PASS")]);
  const response = await record(tender.id, "BID", "Strong incumbent position");
  assert.equal(response.status, 201);

  const { tender: wire } = await load(tender.id);
  const latest = wire.bidDecisions?.[0];
  assert.equal(latest?.decision, "BID");
  assert.equal(latest?.reason, "Strong incumbent position");
  assert.equal(latest?.decidedBy, email);
});

test("TLY-50 AC2: bidding against a recommendation without a reason is refused", async () => {
  // A failing gate that no partner can close is a No-Go.
  const tender = await tenderWith([gate("turnover", "FAIL")]);
  const { tender: before } = await load(tender.id);
  assert.equal(before.recommendation?.decision, "NO_GO");

  const refused = await record(tender.id, "BID", "   ");
  assert.equal(refused.status, 400);
  assert.equal((await refused.json() as { error: string }).error,
    "A reason is required when overriding the recommendation");
  assert.equal((await listBidDecisions(tender.id)).length, 0, "nothing is saved");

  const accepted = await record(tender.id, "BID", "The client has confirmed a partner will cover turnover");
  assert.equal(accepted.status, 201, "the same choice is allowed once it is explained");
});

test("TLY-50: agreeing with the recommendation needs no reason", async () => {
  const tender = await tenderWith([gate("tax", "PASS")]);
  const { tender: wire } = await load(tender.id);
  assert.equal(wire.recommendation?.decision, "GO");
  assert.equal((await record(tender.id, "BID", "")).status, 201);
});

test("TLY-50 AC4: changing your mind adds an entry rather than replacing one", async () => {
  const tender = await tenderWith([gate("tax", "PASS")]);
  await record(tender.id, "BID", "Worth a look");
  await record(tender.id, "NO_BID", "The delivery team is committed elsewhere");

  const { tender: wire } = await load(tender.id);
  assert.equal(wire.bidDecisions?.length, 2, "the history is the point");
  assert.deepEqual(wire.bidDecisions?.map((entry) => entry.decision), ["NO_BID", "BID"]);
  assert.ok(wire.bidDecisions?.every((entry) => Date.parse(entry.createdAt) > 0));
});

test("TLY-50 AC5: the recommendation is frozen as it stood when the decision was made", async () => {
  const tender = await tenderWith([gate("iso", "REVIEW")]);
  const { tender: before } = await load(tender.id);
  assert.equal(before.recommendation?.decision, "REVIEW");
  await record(tender.id, "BID", "We will resolve the ISO gate this week");

  // The tender is re-analysed and the gate now passes.
  await saveTenderAnalysis(user.id, tender.id, analysis([gate("iso", "PASS")]));
  const { tender: after } = await load(tender.id);
  assert.equal(after.recommendation?.decision, "GO", "the live recommendation moves");
  assert.equal(after.bidDecisions?.[0].recommendationAtTheTime, "REVIEW",
    "but the record of what they were looking at does not");
});

test("TLY-50 AC3: a tender with no decision recorded says so on the wire", async () => {
  const tender = await tenderWith([gate("tax", "PASS")]);
  const { tender: wire } = await load(tender.id);
  assert.deepEqual(wire.bidDecisions, [], "the Respond stage prompts on an empty list");
});

test("TLY-50: a decision cannot be recorded against another account's tender", async () => {
  const tender = await tenderWith([gate("tax", "PASS")]);
  const otherEmail = `other-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;
  const other = await createUser(otherEmail, await bcrypt.hash("x", 4), "Other Ltd");
  const response = await fetch(`${base}/api/tenders/${tender.id}/decision`, {
    method: "POST",
    headers: { authorization: `Bearer ${signToken({ id: other.id, email: otherEmail })}`, "content-type": "application/json" },
    body: JSON.stringify({ decision: "BID", reason: "not mine" }),
  });
  assert.equal(response.status, 404);
});
