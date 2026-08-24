import assert from "node:assert/strict";
import test from "node:test";
import bcrypt from "bcryptjs";
import { signToken } from "../src/auth.js";
import { createUser, getTender, initializeDatabase, saveTenderAnalysis, upsertTender } from "../src/db.js";
import { withStableIds } from "../src/analysis-schema.js";
import { inScope, selectedLots, serializeTender } from "../src/serializers.js";
import { submissionBlockers } from "../src/pack.js";
import { tenderAnalysisSchema } from "../src/ai-schemas.js";
import { ANALYSIS_PROMPT } from "../src/prompts/index.js";
import type { TenderAnalysis, TenderRecord } from "../src/types.js";

const evidence = { sourceDocument: "ITT.pdf", quote: "The contract is divided into three lots.", confidence: "HIGH" as const };
const lot = (id: string, title: string, value: string) =>
  ({ id, title, scope: `Scope for ${title}`, estimatedValue: value, evidence });

const gate = (id: string, status: "PASS" | "FAIL" | "REVIEW", lotId: string) =>
  ({ id, requirement: `Requirement ${id}`, bidderEvidence: "Recorded", status, action: "", lotId, evidence });

const question = (id: string, lotId: string) =>
  ({ id, title: `Question ${id}`, prompt: "Describe it.", weight: 20, maxWords: 400, required: true, evidenceNeeded: [], lotId, source: evidence });

const analysis = (over: Partial<TenderAnalysis> = {}): TenderAnalysis => withStableIds({
  headline: "x", executiveSummary: "x", bidType: "OPEN_CONTRACT", access: "OPEN_TO_QUALIFIED_BIDDERS",
  eligibility: "REVIEW", fitScore: 50, decision: "REVIEW", partnerNeeded: false, partnerGaps: [],
  deadline: "26/03/2026", clarificationDeadline: "", contractValue: "", duration: "",
  lots: [lot("Lot 1", "Dublin region", "EUR 400,000"), lot("Lot 2", "Cork region", "EUR 250,000"), lot("Lot 3", "Galway region", "[INPUT NEEDED: lot value]")],
  fatalGates: [gate("whole", "PASS", ""), gate("lot1", "FAIL", "Lot 1"), gate("lot2", "PASS", "Lot 2")],
  evaluationCriteria: [],
  questions: [question("q-whole", ""), question("q-lot1", "Lot 1"), question("q-lot2", "Lot 2")],
  roles: [], clarificationQuestions: [], risks: [], submissionMethod: "eTenders",
  formalities: [], requiredCertificates: [],
  aiUsePolicy: { state: "not-stated", evidence: { sourceDocument: "", quote: "", confidence: "LOW" } },
  submissionChecklist: [], synopsisSlides: [],
  ...over,
});

const record = (stored: TenderAnalysis, metadata: Record<string, unknown> = {}) => ({
  id: "t", accountId: "a", source: "etenders", externalId: "X", title: "T", authority: "A",
  procedure: "Open", deadline: "", estimatedValue: "", description: "", sourceUrl: "https://www.etenders.gov.ie/x",
  published: "", status: "ANALYSED", metadata, analysis: stored,
}) as unknown as TenderRecord;

test("TLY-41 AC1: every lot reaches the Qualify stage with its title, scope and value", () => {
  const wire = serializeTender(record(analysis()), []);
  assert.equal(wire.lots?.length, 3);
  assert.deepEqual(wire.lots?.map((entry) => entry.id), ["Lot 1", "Lot 2", "Lot 3"]);
  assert.equal(wire.lots?.[0].title, "Dublin region");
  assert.equal(wire.lots?.[0].scope, "Scope for Dublin region");
  assert.equal(wire.lots?.[0].estimatedValue, "EUR 400,000");
  assert.equal(wire.lots?.[0].quote, "The contract is divided into three lots.");
});

test("TLY-41 AC5: a lot with no stated value says so and no figure is invented", () => {
  const wire = serializeTender(record(analysis()), []);
  assert.equal(wire.lots?.[2].estimatedValue, "[INPUT NEEDED: lot value]");
});

test("TLY-41 AC2: selecting one lot narrows the questions to that lot and the whole tender", () => {
  const wire = serializeTender(record(analysis(), { selectedLots: ["Lot 2"] }), []);
  assert.equal(wire.questions.length, 2, "the Lot 2 question and the whole-tender question");
  assert.ok(wire.questions.every((entry) => entry.lotId === undefined || entry.lotId === "Lot 2"));
});

test("TLY-41 AC3: a gate failing on a lot the user is not bidding does not block the pack", () => {
  const stored = analysis();
  const withoutSelection = submissionBlockers(record(stored), stored, [], []);
  assert.ok(withoutSelection.some((entry) => entry.includes("Requirement lot1")),
    "with nothing selected the whole pack is in scope, so the failing gate counts");

  const lotTwoOnly = submissionBlockers(record(stored, { selectedLots: ["Lot 2"] }), stored, [], []);
  assert.ok(!lotTwoOnly.some((entry) => entry.includes("Requirement lot1")),
    "failing a lot you are not bidding is not a reason to block your pack");
  assert.ok(!lotTwoOnly.some((entry) => entry.includes("Requirement lot2")), "the Lot 2 gate passes");
});

test("TLY-41 AC4: an undivided tender carries no lots and renders as before", () => {
  const wire = serializeTender(record(analysis({ lots: [], fatalGates: [gate("whole", "PASS", "")], questions: [question("q-whole", "")] })), []);
  assert.deepEqual(wire.lots, [], "no lots means no selector");
  assert.equal(wire.gates.length, 1);
  assert.equal(wire.questions.length, 1);
});

test("TLY-41 AC6: the selection is stored on the tender, so it survives a reload", async () => {
  await initializeDatabase();
  const email = `lots-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;
  const user = await createUser(email, await bcrypt.hash("x", 4), "Lots Ltd");
  process.env.JWT_SECRET ||= "test-secret-that-is-at-least-32-characters";
  signToken({ id: user.id, email });

  const tender = await upsertTender(user.id, {
    source: "seed", externalId: `lots-${Date.now()}`, title: "Divided tender", authority: "Authority",
    procedure: "Open", deadline: "26/03/2026", estimatedValue: "", description: "",
    sourceUrl: "https://www.etenders.gov.ie/x", published: "", status: "ANALYSED",
    metadata: { selectedLots: ["Lot 2"] },
  });
  await saveTenderAnalysis(user.id, tender.id, analysis());

  const reloaded = await getTender(user.id, tender.id);
  assert.deepEqual(selectedLots(reloaded!), ["Lot 2"], "the choice is a property of the tender, not of the session");
  assert.equal(serializeTender(reloaded!, []).selectedLots?.[0], "Lot 2");
});

test("TLY-41: an item with no lot is always in scope, and no selection means everything", () => {
  assert.equal(inScope(undefined, ["Lot 2"]), true, "a whole-tender item is never scoped away");
  assert.equal(inScope("", ["Lot 2"]), true);
  assert.equal(inScope("Lot 1", []), true, "no selection means the whole tender");
  assert.equal(inScope("Lot 1", ["Lot 2"]), false);
  assert.equal(inScope("Lot 2", ["Lot 1", "Lot 2"]), true);
});

test("TLY-41: a legacy analysis whose lots were bare strings still renders", () => {
  const legacy = withStableIds({ ...analysis(), lots: ["Lot A", "Lot B"] as unknown as TenderAnalysis["lots"] });
  assert.equal(legacy.lots.length, 2);
  assert.equal(legacy.lots[0].id, "Lot A");
  assert.equal(legacy.lots[0].estimatedValue, "[INPUT NEEDED: lot value]",
    "the pack did say the tender was divided; losing that is worse than an incomplete row");
});

test("TLY-41: the model must return structured lots, and the prompt forbids inventing a value", () => {
  const shape = tenderAnalysisSchema.shape.lots;
  const valid = shape.safeParse([{ id: "Lot 1", title: "Dublin", scope: "Region", estimatedValue: "EUR 1", evidence: { sourceDocument: "ITT.pdf", quote: "q", confidence: "HIGH" } }]);
  assert.ok(valid.success);
  assert.equal(shape.safeParse(["Lot 1"]).success, false, "a bare string is no longer a lot");

  assert.match(ANALYSIS_PROMPT, /LOTS/);
  assert.match(ANALYSIS_PROMPT, /\[INPUT NEEDED: lot value\]/);
  assert.match(ANALYSIS_PROMPT, /Never derive it by dividing a total/);
  assert.match(ANALYSIS_PROMPT, /Do not invent a single "Lot 1" for an undivided tender/);
});
