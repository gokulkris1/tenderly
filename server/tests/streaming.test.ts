import "./helpers/env.js";
import assert from "node:assert/strict";
import test from "node:test";
import bcrypt from "bcryptjs";
import { signToken } from "../src/auth.js";
import { createUser, initializeDatabase, listAnswers, saveAnswer, saveTenderAnalysis, upsertTender } from "../src/db.js";
import { SSE_HEADERS, partialJsonString, sseEvent } from "../src/streaming.js";
import { streamAndSaveAnswer, type Streamer } from "../src/drafting.js";
import { draftContext } from "../src/drafting.js";
import { withStableIds } from "../src/analysis-schema.js";
import type { TenderAnalysis, TenderRecord } from "../src/types.js";

await initializeDatabase();
const { app } = await import("../src/index.js");
const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const address = server.address();
const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
server.unref();

const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const source = { sourceDocument: "ITT.pdf", quote: "Describe your approach.", confidence: "HIGH" as const };

const analysis = (): TenderAnalysis => withStableIds({
  headline: "x", executiveSummary: "x", bidType: "OPEN_CONTRACT", access: "OPEN_TO_QUALIFIED_BIDDERS",
  eligibility: "REVIEW", fitScore: 60, decision: "REVIEW", partnerNeeded: false, partnerGaps: [],
  deadline: "26/03/2027", clarificationDeadline: "", contractValue: "", duration: "", lots: [],
  fatalGates: [], evaluationCriteria: [],
  questions: [{ id: "seed", title: "Methodology", prompt: "Describe your methodology.", weight: 60, maxWords: 500, required: true, evidenceNeeded: [], lotId: "", source }],
  roles: [], clarificationQuestions: [], risks: [], submissionMethod: "eTenders",
  formalities: [], requiredCertificates: [],
  aiUsePolicy: { state: "not-stated", evidence: { sourceDocument: "", quote: "", confidence: "LOW" } },
  submissionChecklist: [], synopsisSlides: [],
});

const email = `stream-${unique()}@example.test`;
const user = await createUser(email, await bcrypt.hash("x", 4), "Streaming Ltd");
const headers = {
  authorization: `Bearer ${signToken({ id: user.id, organisationId: user.organisationId, email, role: "owner" })}`,
  "content-type": "application/json",
};

async function tenderReady(label: string) {
  const tender = await upsertTender(user.organisationId, {
    source: "seed", externalId: `stream-${label}-${unique()}`, title: `Streaming tender ${label}`,
    authority: "Authority", procedure: "Open", deadline: "26/03/2027", estimatedValue: "",
    description: "", sourceUrl: "https://www.etenders.gov.ie/x", published: "", status: "ANALYSED", metadata: {},
  });
  const stored = analysis();
  await saveTenderAnalysis(user.organisationId, tender.id, stored);
  return { record: { ...tender, analysis: stored } as TenderRecord, question: stored.questions[0] };
}

// --- reading prose out of half-arrived JSON ---------------------------------

test("TLY-68: the answer is readable while its JSON is still arriving", () => {
  assert.equal(partialJsonString('{"answer":"Our appro', "answer"), "Our appro");
  assert.equal(partialJsonString('{"answer":"Our approach."', "answer"), "Our approach.");
  assert.equal(partialJsonString('{"answer":"Our approach.","missingInputs":[]}', "answer"), "Our approach.");
});

test("TLY-68: a field that has not started arriving reads as absent, not as empty", () => {
  assert.equal(partialJsonString('{"missing', "answer"), null);
  assert.equal(partialJsonString('{"answer"', "answer"), null);
  assert.equal(partialJsonString('{"answer":', "answer"), null);
  assert.equal(partialJsonString('{"answer": ', "answer"), null);
  assert.equal(partialJsonString('{"answer": "', "answer"), "");
});

test("TLY-68: escapes are decoded, and half an escape is not shown as gibberish", () => {
  assert.equal(partialJsonString('{"answer":"First line\\nSecond', "answer"), "First line\nSecond");
  assert.equal(partialJsonString('{"answer":"She said \\"yes\\" to', "answer"), 'She said "yes" to');
  assert.equal(partialJsonString('{"answer":"A path C:\\\\Users', "answer"), "A path C:\\Users");
  // A trailing backslash is the start of an escape whose second half has not
  // arrived; showing it would put a stray slash on the screen.
  assert.equal(partialJsonString('{"answer":"Nearly there\\', "answer"), "Nearly there");
  assert.equal(partialJsonString('{"answer":"Half a code point \\u00', "answer"), "Half a code point ");
  assert.equal(partialJsonString('{"answer":"Euro \\u20ac now', "answer"), "Euro \u20ac now");
});

test("TLY-68: a quote inside an earlier field does not end the answer early", () => {
  const json = '{"status":"NEEDS_INPUT","answer":"Text with \\"quotes\\" in it';
  assert.equal(partialJsonString(json, "answer"), 'Text with "quotes" in it');
});

test("TLY-68: events carry newline-bearing prose without ending early", () => {
  const event = sseEvent("text", { answer: "Line one\nLine two" });
  assert.equal(event.split("\n").filter((line) => line.startsWith("data: ")).length, 1,
    "a raw newline in the payload would end the event halfway through the answer");
  assert.ok(event.endsWith("\n\n"));
  assert.equal(JSON.parse(event.split("data: ")[1].trim()).answer, "Line one\nLine two");
});

test("TLY-68: the stream is not buffered into a single response by a proxy", () => {
  assert.equal(SSE_HEADERS["x-accel-buffering"], "no");
  assert.match(SSE_HEADERS["content-type"], /text\/event-stream/);
});

// --- what gets saved, and when ---------------------------------------------

/** Stands in for the model: emits the answer in pieces, then returns the draft. */
const fakeStream = (answer: string, over: Record<string, unknown> = {}): Streamer => async ({ onText }) => {
  for (let index = 1; index <= answer.length; index += 7) onText(answer.slice(0, index));
  onText(answer);
  return {
    status: "DRAFTED", answer, missingInputs: [], evidenceUsed: [], claimsToVerify: [], citations: [],
    ...over,
  } as Awaited<ReturnType<Streamer>>;
};

test("TLY-68 AC1 and AC3: the text grows, and the completed draft is what gets saved", async () => {
  const { record, question } = await tenderReady("complete");
  const context = await draftContext(user.organisationId, record.id);
  const seen: string[] = [];

  const { saved } = await streamAndSaveAnswer({
    tender: record, question, context, actor: email,
    onText: (answerSoFar) => seen.push(answerSoFar),
    streamer: fakeStream("Our delivery methodology is staged and measured."),
  });

  assert.ok(seen.length > 1, "the point of streaming is that it arrives in pieces");
  assert.ok(seen.every((text, index) => index === 0 || text.startsWith(seen[index - 1])),
    "each event carries the answer so far, so a dropped one is harmless");
  assert.equal(seen.at(-1), "Our delivery methodology is staged and measured.");

  const [stored] = await listAnswers(record.id);
  assert.equal(stored.response, "Our delivery methodology is staged and measured.");
  assert.equal(stored.status, "draft");
  assert.equal(saved.id, stored.id);
});

test("TLY-68 AC2: a stopped stream saves nothing and leaves the previous answer alone", async () => {
  const { record, question } = await tenderReady("stopped");
  await saveAnswer(record.id, question.id, "What the person had written.", "draft", []);
  const context = await draftContext(user.organisationId, record.id);

  const controller = new AbortController();
  const stopMidway: Streamer = async ({ onText, signal }) => {
    onText("Our delivery met");
    controller.abort();
    if (signal?.aborted) throw new Error("STOPPED");
    return { status: "DRAFTED", answer: "never returned", missingInputs: [], evidenceUsed: [], claimsToVerify: [], citations: [] } as Awaited<ReturnType<Streamer>>;
  };

  await assert.rejects(streamAndSaveAnswer({
    tender: record, question, context, actor: email, signal: controller.signal,
    onText: () => {}, streamer: stopMidway,
  }));

  const [stored] = await listAnswers(record.id);
  assert.equal(stored.response, "What the person had written.",
    "half a draft is not a draft, and it must not replace what somebody wrote");
});

test("TLY-68 AC2: a stream that finishes after the stop still saves nothing", async () => {
  const { record, question } = await tenderReady("late");
  await saveAnswer(record.id, question.id, "The earlier answer.", "draft", []);
  const context = await draftContext(user.organisationId, record.id);

  // The last fragment wins the race and the streamer returns normally; the
  // abort still has to be honoured before anything is written.
  const controller = new AbortController();
  const finishesAnyway: Streamer = async ({ onText }) => {
    onText("A complete-looking draft.");
    controller.abort();
    return { status: "DRAFTED", answer: "A complete-looking draft.", missingInputs: [], evidenceUsed: [], claimsToVerify: [], citations: [] } as Awaited<ReturnType<Streamer>>;
  };

  await assert.rejects(streamAndSaveAnswer({
    tender: record, question, context, actor: email, signal: controller.signal,
    onText: () => {}, streamer: finishesAnyway,
  }), /STOPPED/);
  assert.equal((await listAnswers(record.id))[0].response, "The earlier answer.");
});

test("TLY-68 AC5: a draft the schema rejects saves nothing", async () => {
  const { record, question } = await tenderReady("invalid");
  await saveAnswer(record.id, question.id, "The earlier answer.", "draft", []);
  const context = await draftContext(user.organisationId, record.id);

  const rejected: Streamer = async () => {
    throw new Error("AI drafting did not match the expected shape: answer Required");
  };

  await assert.rejects(streamAndSaveAnswer({
    tender: record, question, context, actor: email, onText: () => {}, streamer: rejected,
  }), /did not match the expected shape/);
  assert.equal((await listAnswers(record.id))[0].response, "The earlier answer.");
});

test("TLY-68: a streamed draft with unmet evidence is saved needs-input with its markers", async () => {
  const { record, question } = await tenderReady("gaps");
  const context = await draftContext(user.organisationId, record.id);

  await streamAndSaveAnswer({
    tender: record, question, context, actor: email, onText: () => {},
    streamer: fakeStream("We have delivered similar work.", { missingInputs: ["three reference contracts"] }),
  });

  const [stored] = await listAnswers(record.id);
  assert.equal(stored.status, "needs-input");
  assert.match(stored.response, /\[INPUT NEEDED: three reference contracts\]/,
    "a streamed draft is held to the same rule as any other");
});

// --- the route -------------------------------------------------------------

/** Reads a server-sent event stream into a list of [event, data] pairs. */
async function readEvents(response: Response) {
  const text = await response.text();
  return text.split("\n\n").filter(Boolean).map((chunk) => {
    const event = chunk.match(/^event: (.+)$/m)?.[1] ?? "";
    const data = chunk.match(/^data: (.+)$/m)?.[1] ?? "{}";
    return [event, JSON.parse(data)] as [string, Record<string, unknown>];
  });
}

test("TLY-68 AC4 and AC5: a failed draft names the question and saves nothing", async (t) => {
  if (process.env.ANTHROPIC_API_KEY) {
    t.skip("this asserts the unconfigured-model path; a key is present, and the test will not spend one");
    return;
  }
  const { record, question } = await tenderReady("route-error");
  await saveAnswer(record.id, question.id, "The earlier answer.", "draft", []);

  const response = await fetch(`${base}/api/tenders/${record.id}/answers/${question.id}/draft-stream`, {
    method: "POST", headers, body: "{}",
  });
  assert.equal(response.status, 200, "the failure arrives as an event, not as a status: the response already started");
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);

  const events = await readEvents(response);
  const failure = events.find(([event]) => event === "error");
  assert.ok(failure, "a stream that just ends tells the user nothing");
  assert.equal(failure[1].questionId, question.id);
  assert.equal(failure[1].title, "Methodology", "'drafting failed' does not say which answer to write by hand");

  assert.equal((await listAnswers(record.id))[0].response, "The earlier answer.");
});

test("TLY-68: streaming refuses the same things the plain draft route refuses", async () => {
  const { record } = await tenderReady("guards");
  const missing = await fetch(`${base}/api/tenders/${record.id}/answers/not-a-question/draft-stream`, {
    method: "POST", headers, body: "{}",
  });
  assert.equal(missing.status, 404);

  const unanalysed = await upsertTender(user.organisationId, {
    source: "seed", externalId: `stream-raw-${unique()}`, title: `Unanalysed ${unique()}`, authority: "Authority",
    procedure: "Open", deadline: "26/03/2027", estimatedValue: "", description: "",
    sourceUrl: "https://www.etenders.gov.ie/x", published: "", status: "IMPORTED", metadata: {},
  });
  const noAnalysis = await fetch(`${base}/api/tenders/${unanalysed.id}/answers/seed/draft-stream`, {
    method: "POST", headers, body: "{}",
  });
  assert.equal(noAnalysis.status, 409);
});

test("TLY-68: another account cannot stream a draft on this tender", async () => {
  const { record, question } = await tenderReady("tenant");
  const otherEmail = `other-${unique()}@example.test`;
  const other = await createUser(otherEmail, await bcrypt.hash("x", 4), "Other Ltd");
  const otherHeaders = {
    authorization: `Bearer ${signToken({ id: other.id, organisationId: other.organisationId, email: otherEmail, role: "owner" })}`,
    "content-type": "application/json",
  };

  const response = await fetch(`${base}/api/tenders/${record.id}/answers/${question.id}/draft-stream`, {
    method: "POST", headers: otherHeaders, body: "{}",
  });
  assert.equal(response.status, 404);
});
