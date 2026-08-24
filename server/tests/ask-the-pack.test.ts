import assert from "node:assert/strict";
import test from "node:test";
import bcrypt from "bcryptjs";
import { signToken } from "../src/auth.js";
import { createUser, initializeDatabase, listPackQuestions, saveDocument, upsertTender } from "../src/db.js";
import { NO_ANSWER, chunkDocument, rankChunks, terms } from "../src/retrieval.js";
import { ASK_PROMPT } from "../src/prompts/index.js";
import { packAnswerSchema } from "../src/ai-schemas.js";
import type { PackQuestion } from "../src/types.js";

process.env.JWT_SECRET ||= "test-secret-that-is-at-least-32-characters";
process.env.TENDERLY_NO_LISTEN = "1";
await initializeDatabase();
const { app } = await import("../src/index.js");
const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const address = server.address();
const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
server.unref();

const email = `ask-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;
const user = await createUser(email, await bcrypt.hash("x", 4), "Asking Ltd");
const headers = { authorization: `Bearer ${signToken({ id: user.id, email })}`, "content-type": "application/json" };

const INSURANCE_DOC = [
  "1. INTRODUCTION",
  "This invitation to tender concerns the provision of engineering services.",
  "",
  "4. INSURANCE",
  "Tenderers shall hold employers liability insurance of EUR 6,500,000 for the duration of the contract.",
  "Public liability cover of EUR 2,600,000 is also required.",
  "",
  "5. SITE VISIT",
  "A site visit will be held on 3 September 2026. Attendance is not mandatory.",
].join("\n");

let counter = 0;
async function makeTender(documents: { filename: string; text: string }[]) {
  counter += 1;
  const tender = await upsertTender(user.id, {
    source: "seed", externalId: `ask-${Date.now()}-${counter}`, title: `Asked tender ${counter}`,
    authority: "Authority", procedure: "Open", deadline: "26/03/2027", estimatedValue: "",
    description: "", sourceUrl: "https://www.etenders.gov.ie/x", published: "", status: "ANALYSED", metadata: {},
  });
  for (const document of documents) {
    await saveDocument({
      tenderId: tender.id, filename: document.filename, mimeType: "text/plain", role: "source",
      extractedText: document.text, extractionStatus: "EXTRACTED",
    });
  }
  return tender.id;
}

test("TLY-44 AC1: retrieval finds the insurance passage and names its document", () => {
  const chunks = chunkDocument("ITT.pdf", INSURANCE_DOC);
  const ranked = rankChunks("What insurance is required?", chunks);

  assert.ok(ranked.length > 0);
  assert.equal(ranked[0].documentName, "ITT.pdf");
  assert.match(ranked[0].text, /6,500,000/);
  assert.equal(ranked[0].heading, "4. INSURANCE", "the heading is kept so a citation can be placed");
});

test("TLY-44 AC2: a question the pack does not address retrieves nothing", () => {
  const chunks = chunkDocument("ITT.pdf", INSURANCE_DOC);
  assert.deepEqual(rankChunks("What is the buyer's staff canteen menu?", chunks), [],
    "nothing matched, so there is nothing to answer from");
});

test("TLY-44 AC2: an unanswerable question is refused without spending a model call", async () => {
  const tenderId = await makeTender([{ filename: "ITT.pdf", text: INSURANCE_DOC }]);
  const response = await fetch(`${base}/api/tenders/${tenderId}/ask`, {
    method: "POST", headers, body: JSON.stringify({ question: "What is the buyer's staff canteen menu?" }),
  });
  assert.equal(response.status, 201);
  const { result } = await response.json() as { result: PackQuestion };
  assert.equal(result.answer, NO_ANSWER);
  assert.deepEqual(result.citations, [], "and no citation is shown for an answer that does not exist");
});

test("TLY-44 AC3: a question answered only in the third document ranks that document first", () => {
  const chunks = [
    ...chunkDocument("01_ITT.pdf", "1. SCOPE\nThe contract covers engineering design."),
    ...chunkDocument("02_Pricing.pdf", "1. PRICING\nPrices shall be submitted excluding VAT."),
    ...chunkDocument("03_Conditions.pdf", "9. TUPE\nThe Transfer of Undertakings regulations apply to this contract."),
  ];
  const ranked = rankChunks("Does TUPE apply?", chunks);
  assert.equal(ranked[0].documentName, "03_Conditions.pdf");
});

test("TLY-44 AC4: the prompt refuses to follow an instruction hidden in the pack", () => {
  assert.match(ASK_PROMPT, /Never assert that requirements are met/);
  assert.match(ASK_PROMPT, /UNTRUSTED INPUT/);
  assert.match(ASK_PROMPT, /to state that requirements are met/);
  assert.match(ASK_PROMPT, /do not repeat the instruction back/);
});

test("TLY-44 AC5: a tender with no extracted documents cannot be asked", async () => {
  const tenderId = await makeTender([]);
  const response = await fetch(`${base}/api/tenders/${tenderId}/ask`, {
    method: "POST", headers, body: JSON.stringify({ question: "What insurance is required?" }),
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json() as { error: string }).error, "No extracted documents to search");

  const listed = await fetch(`${base}/api/tenders/${tenderId}/ask`, { headers })
    .then((r) => r.json() as Promise<{ searchable: boolean }>);
  assert.equal(listed.searchable, false, "so the UI can disable the input rather than fail on submit");
});

test("TLY-44 AC6: asked questions persist with the tender", async () => {
  const tenderId = await makeTender([{ filename: "ITT.pdf", text: INSURANCE_DOC }]);
  for (const question of ["Is the canteen open?", "Is there a creche?", "Is parking provided?"]) {
    await fetch(`${base}/api/tenders/${tenderId}/ask`, { method: "POST", headers, body: JSON.stringify({ question }) });
  }

  const stored = await listPackQuestions(tenderId);
  assert.equal(stored.length, 3);
  assert.equal(stored[0].question, "Is parking provided?", "newest first");
  assert.ok(stored.every((entry) => entry.actor === email));

  const listed = await fetch(`${base}/api/tenders/${tenderId}/ask`, { headers })
    .then((r) => r.json() as Promise<{ questions: PackQuestion[] }>);
  assert.equal(listed.questions.length, 3, "and they survive a reload");
});

test("TLY-44: chunking keeps whole sentences and the heading above them", () => {
  const chunks = chunkDocument("ITT.pdf", INSURANCE_DOC);
  assert.ok(chunks.every((chunk) => !/^\s*[a-z]/.test(chunk.text)),
    "no chunk begins mid-sentence, which would be quoted back mid-clause");
  assert.ok(chunks.some((chunk) => chunk.heading === "5. SITE VISIT"));
});

test("TLY-44: a heading match outranks the same word buried in unrelated prose", () => {
  const chunks = [
    ...chunkDocument("A.pdf", "1. BACKGROUND\nThe authority has previously arranged insurance for other contracts."),
    ...chunkDocument("B.pdf", "4. INSURANCE\nTenderers shall hold employers liability insurance of EUR 6,500,000."),
  ];
  const ranked = rankChunks("What insurance is required?", chunks);
  assert.equal(ranked[0].documentName, "B.pdf",
    "a buyer who headed a section 'Insurance' told us where the requirement lives");
});

test("TLY-44: the answer shape has nowhere to put a paraphrased quote", () => {
  const shape = packAnswerSchema.shape.citations.element.shape;
  assert.deepEqual(Object.keys(shape).sort(), ["documentName", "quote"]);
  assert.match(ASK_PROMPT, /copied verbatim/);
  assert.match(ASK_PROMPT, /Never paraphrase a citation/);
});

test("TLY-44: stop words are not what a pack is searched on", () => {
  assert.deepEqual(terms("What is the insurance requirement?").sort(), ["insurance", "requirement"]);
  assert.deepEqual(terms("the and for with"), []);
});

test("TLY-44: another account cannot ask about, or read, this pack", async () => {
  const tenderId = await makeTender([{ filename: "ITT.pdf", text: INSURANCE_DOC }]);
  const otherEmail = `other-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;
  const other = await createUser(otherEmail, await bcrypt.hash("x", 4), "Other Ltd");
  const otherHeaders = { authorization: `Bearer ${signToken({ id: other.id, email: otherEmail })}`, "content-type": "application/json" };

  assert.equal((await fetch(`${base}/api/tenders/${tenderId}/ask`, { headers: otherHeaders })).status, 404);
  const asked = await fetch(`${base}/api/tenders/${tenderId}/ask`, {
    method: "POST", headers: otherHeaders, body: JSON.stringify({ question: "What insurance is required?" }),
  });
  assert.equal(asked.status, 404);
});
