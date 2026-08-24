import assert from "node:assert/strict";
import test from "node:test";
import bcrypt from "bcryptjs";
import { signToken } from "../src/auth.js";
import { createUser, initializeDatabase, latestAffirmation, listDeclarationAnswers, recordAffirmation, saveDeclarationAnswers } from "../src/db.js";
import {
  AFFIRMATION_VALID_MONTHS, DECLARATIONS, affirmationProblems, declarationEvidence, needsReaffirmation,
  type DeclarationAnswer,
} from "../src/declarations.js";

process.env.JWT_SECRET ||= "test-secret-that-is-at-least-32-characters";
process.env.TENDERLY_NO_LISTEN = "1";
await initializeDatabase();
const { app } = await import("../src/index.js");
const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const address = server.address();
const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
server.unref();

async function makeAccount(label: string) {
  const email = `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;
  const user = await createUser(email, await bcrypt.hash("x", 4), `${label} Ltd`);
  return { id: user.organisationId, email, headers: { authorization: `Bearer ${signToken({ id: user.id, organisationId: user.organisationId, email })}`, "content-type": "application/json" } };
}

/** Every declaration answered the way a clean company would answer it. */
const cleanAnswers = (): DeclarationAnswer[] => DECLARATIONS.map((declaration) => ({
  declarationId: declaration.id,
  answer: declaration.answerRequiringDetail === "yes" ? "no" : "yes",
  notes: "",
}));

test("TLY-57 AC1: the exclusion grounds are listed with somewhere to answer them", async () => {
  const account = await makeAccount("espd-a");
  const response = await fetch(`${base}/api/declarations`, { headers: account.headers });
  assert.equal(response.status, 200);

  const body = await response.json() as { declarations: typeof DECLARATIONS; needsReaffirmation: boolean };
  const partThree = body.declarations.filter((declaration) => declaration.part === "III");
  assert.ok(partThree.length >= 9, "ESPD Part III grounds for exclusion");
  assert.ok(body.declarations.some((declaration) => declaration.part === "IV"), "and Part IV selection criteria");
  assert.ok(partThree.every((declaration) => declaration.statement.length > 0 && declaration.heading.length > 0));
  assert.equal(body.needsReaffirmation, true, "never affirmed is not the same as affirmed long ago, but both need affirming");
});

test("TLY-57 AC2: affirming records the date and the person", async () => {
  const account = await makeAccount("espd-b");
  await fetch(`${base}/api/declarations`, {
    method: "PUT", headers: account.headers, body: JSON.stringify({ answers: cleanAnswers() }),
  });

  const response = await fetch(`${base}/api/declarations/affirm`, { method: "POST", headers: account.headers, body: "{}" });
  assert.equal(response.status, 201);
  const { affirmation } = await response.json() as { affirmation: { affirmedBy: string; at: string } };
  assert.equal(affirmation.affirmedBy, account.email);
  assert.ok(Date.parse(affirmation.at) > 0);

  const reloaded = await fetch(`${base}/api/declarations`, { headers: account.headers })
    .then((r) => r.json() as Promise<{ needsReaffirmation: boolean }>);
  assert.equal(reloaded.needsReaffirmation, false);
});

test("TLY-57 AC3: a Yes on an exclusion ground with no detail cannot be affirmed", async () => {
  const account = await makeAccount("espd-c");
  const answers = cleanAnswers().map((answer) =>
    answer.declarationId === "criminal-convictions" ? { ...answer, answer: "yes" as const, notes: "" } : answer);
  await fetch(`${base}/api/declarations`, { method: "PUT", headers: account.headers, body: JSON.stringify({ answers }) });

  const response = await fetch(`${base}/api/declarations/affirm`, { method: "POST", headers: account.headers, body: "{}" });
  assert.equal(response.status, 400);
  const body = await response.json() as { error: string; problems: { declarationId: string }[] };
  assert.equal(body.error, "Supporting details are required for this answer");
  assert.ok(body.problems.some((problem) => problem.declarationId === "criminal-convictions"));
  assert.equal(await latestAffirmation(account.id), null, "nothing is saved");

  // The same answer, explained, can be affirmed.
  const explained = answers.map((answer) =>
    answer.declarationId === "criminal-convictions"
      ? { ...answer, notes: "A 2019 conviction, spent, with remedial measures documented." }
      : answer);
  await fetch(`${base}/api/declarations`, { method: "PUT", headers: account.headers, body: JSON.stringify({ answers: explained }) });
  assert.equal((await fetch(`${base}/api/declarations/affirm`, { method: "POST", headers: account.headers, body: "{}" })).status, 201);
});

test("TLY-57: an unanswered declaration blocks affirmation too", () => {
  const partial = cleanAnswers().slice(0, 3);
  const problems = affirmationProblems(partial);
  assert.ok(problems.length >= DECLARATIONS.length - 3);
  assert.ok(problems.every((problem) => problem.problem.length > 0));
  assert.deepEqual(affirmationProblems(cleanAnswers()), [], "a complete clean set has no problems");
});

test("TLY-57 AC4: declarations affirmed over a year ago need re-affirmation", () => {
  const now = new Date(Date.UTC(2026, 7, 24));
  const thirteenMonthsAgo = new Date(Date.UTC(2025, 6, 24));
  assert.equal(needsReaffirmation({ affirmedBy: "a@example.test", at: thirteenMonthsAgo.toISOString() }, now), true);

  const sixMonthsAgo = new Date(Date.UTC(2026, 1, 24));
  assert.equal(needsReaffirmation({ affirmedBy: "a@example.test", at: sixMonthsAgo.toISOString() }, now), false);
  assert.equal(needsReaffirmation(null, now), true, "never affirmed needs affirming");
  assert.equal(AFFIRMATION_VALID_MONTHS, 12);
});

test("TLY-57 AC5: only an affirmed, in-date set is citable in a drafted answer", () => {
  const answers = cleanAnswers();
  const now = new Date(Date.UTC(2026, 7, 24));

  assert.equal(declarationEvidence({ answers, affirmation: null, now }), "",
    "an unaffirmed answer is a draft opinion, not a claim anyone made");

  const stale = { affirmedBy: "a@example.test", at: new Date(Date.UTC(2025, 0, 1)).toISOString() };
  assert.equal(declarationEvidence({ answers, affirmation: stale, now }), "",
    "and a lapsed affirmation is not a current claim either");

  const current = { affirmedBy: "signer@example.test", at: new Date(Date.UTC(2026, 5, 1)).toISOString() };
  const text = declarationEvidence({ answers, affirmation: current, now });
  assert.match(text, /affirmed by signer@example\.test/);
  assert.match(text, /ESPD Part III — Convictions: No/);
  assert.match(text, /ESPD Part IV — Insurance: Yes/);
});

test("TLY-57: answers persist as a set and belong to one account", async () => {
  const a = await makeAccount("espd-d");
  const b = await makeAccount("espd-e");
  await saveDeclarationAnswers(a.id, cleanAnswers());
  await recordAffirmation(a.id, a.email);

  assert.equal((await listDeclarationAnswers(a.id)).length, DECLARATIONS.length);
  assert.deepEqual(await listDeclarationAnswers(b.id), [], "account B sees none of it");
  assert.equal(await latestAffirmation(b.id), null);
});

test("TLY-57: an unknown declaration id is refused rather than stored", async () => {
  const account = await makeAccount("espd-f");
  const response = await fetch(`${base}/api/declarations`, {
    method: "PUT", headers: account.headers,
    body: JSON.stringify({ answers: [{ declarationId: "made-up", answer: "yes", notes: "" }] }),
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await listDeclarationAnswers(account.id), []);
});

test("TLY-57: declarations are not readable without a token", async () => {
  assert.equal((await fetch(`${base}/api/declarations`)).status, 401);
});
