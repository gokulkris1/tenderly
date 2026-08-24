import assert from "node:assert/strict";
import test from "node:test";
import bcrypt from "bcryptjs";
import { signToken } from "../src/auth.js";
import { createUser, initializeDatabase, listClarifications, listDocuments, upsertTender } from "../src/db.js";
import type { Clarification } from "../src/types.js";

process.env.JWT_SECRET ||= "test-secret-that-is-at-least-32-characters";
process.env.TENDERLY_NO_LISTEN = "1";
await initializeDatabase();
const { app } = await import("../src/index.js");
const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const address = server.address();
const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
server.unref();

const email = `clar-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;
const user = await createUser(email, await bcrypt.hash("x", 4), "Clarifying Ltd");
const headers = { authorization: `Bearer ${signToken({ id: user.id, organisationId: user.organisationId, email })}`, "content-type": "application/json" };

let counter = 0;
async function makeTender() {
  counter += 1;
  const tender = await upsertTender(user.organisationId, {
    source: "seed", externalId: `clar-${Date.now()}-${counter}`, title: `Clarified tender ${counter}`,
    authority: "Authority", procedure: "Open", deadline: "26/03/2027", estimatedValue: "",
    description: "", sourceUrl: "https://www.etenders.gov.ie/x", published: "", status: "ANALYSED", metadata: {},
  });
  return tender.id;
}

const ask = (tenderId: string, question: string, askedOn = "2026-08-24") =>
  fetch(`${base}/api/tenders/${tenderId}/clarifications`, { method: "POST", headers, body: JSON.stringify({ question, askedOn }) });

const answer = (tenderId: string, clarificationId: string, response: string, respondedOn = "2026-08-26") =>
  fetch(`${base}/api/tenders/${tenderId}/clarifications/${clarificationId}`, { method: "PUT", headers, body: JSON.stringify({ response, respondedOn }) });

const list = (tenderId: string) =>
  fetch(`${base}/api/tenders/${tenderId}/clarifications`, { headers })
    .then((r) => r.json() as Promise<{ items: (Clarification & { status: string })[]; open: number }>);

test("TLY-81 AC1: a recorded question is listed as Open", async () => {
  const tenderId = await makeTender();
  assert.equal((await ask(tenderId, "Is the site visit mandatory?")).status, 201);

  const { items } = await list(tenderId);
  assert.equal(items.length, 1);
  assert.equal(items[0].question, "Is the site visit mandatory?");
  assert.equal(items[0].status, "Open");
  assert.equal(items[0].askedOn, "2026-08-24");
  assert.equal(items[0].askedBy, email);
});

test("TLY-81 AC2: recording the buyer's answer flips it to Answered, keeping both texts", async () => {
  const tenderId = await makeTender();
  const { clarification } = await (await ask(tenderId, "Is the site visit mandatory?")).json() as { clarification: Clarification };

  const response = await answer(tenderId, clarification.id, "Attendance is mandatory");
  assert.equal(response.status, 200);

  const { items } = await list(tenderId);
  assert.equal(items[0].status, "Answered");
  assert.equal(items[0].question, "Is the site visit mandatory?", "the question is still there");
  assert.equal(items[0].response, "Attendance is mandatory");
  assert.equal(items[0].respondedOn, "2026-08-26");
});

test("TLY-81 AC3: answering suggests a re-analysis", async () => {
  const tenderId = await makeTender();
  const { clarification } = await (await ask(tenderId, "Has the deadline moved?")).json() as { clarification: Clarification };
  const body = await (await answer(tenderId, clarification.id, "The deadline is now 26 March")).json() as { reanalyseSuggested: boolean };
  assert.equal(body.reanalyseSuggested, true, "a changed requirement should be re-read, not assumed");
});

test("TLY-81 AC4: the buyer's answer joins the pack so drafting can cite it", async () => {
  const tenderId = await makeTender();
  const { clarification } = await (await ask(tenderId, "Is site attendance required?")).json() as { clarification: Clarification };
  await answer(tenderId, clarification.id, "Attendance at the site visit is mandatory for all tenderers");

  const documents = await listDocuments(tenderId);
  const added = documents.find((document) => document.filename.startsWith("Clarification"));
  assert.ok(added, "a clarification that changes a requirement is part of the pack in every sense that matters");
  assert.match(added.extractedText, /Attendance at the site visit is mandatory/);
  assert.match(added.extractedText, /Is site attendance required\?/, "the question gives the answer its context");
  assert.equal(added.role, "source");
});

test("TLY-81 AC5: an empty question is refused with the message the form shows", async () => {
  const tenderId = await makeTender();
  const response = await ask(tenderId, "   ");
  assert.equal(response.status, 400);
  assert.equal((await response.json() as { error: string }).error, "Question text is required");
  assert.deepEqual(await listClarifications(tenderId), [], "and nothing is created");
});

test("TLY-81 AC6: the open count excludes the answered ones", async () => {
  const tenderId = await makeTender();
  await ask(tenderId, "First open question");
  await ask(tenderId, "Second open question");
  const { clarification } = await (await ask(tenderId, "Third question")).json() as { clarification: Clarification };
  await answer(tenderId, clarification.id, "Answered by the buyer");

  const { items, open } = await list(tenderId);
  assert.equal(items.length, 3);
  assert.equal(open, 2);
});

test("TLY-81: an empty response is refused rather than marking it answered", async () => {
  const tenderId = await makeTender();
  const { clarification } = await (await ask(tenderId, "A question")).json() as { clarification: Clarification };
  const response = await answer(tenderId, clarification.id, "   ");
  assert.equal(response.status, 400);

  const { items } = await list(tenderId);
  assert.equal(items[0].status, "Open", "a blank answer is not an answer");
});

test("TLY-81: clarifications do not cross accounts", async () => {
  const tenderId = await makeTender();
  const { clarification } = await (await ask(tenderId, "Confidential question")).json() as { clarification: Clarification };

  const otherEmail = `other-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;
  const other = await createUser(otherEmail, await bcrypt.hash("x", 4), "Other Ltd");
  const otherHeaders = { authorization: `Bearer ${signToken({ id: other.id, organisationId: other.organisationId, email: otherEmail })}`, "content-type": "application/json" };

  assert.equal((await fetch(`${base}/api/tenders/${tenderId}/clarifications`, { headers: otherHeaders })).status, 404);
  const stolen = await fetch(`${base}/api/tenders/${tenderId}/clarifications/${clarification.id}`, {
    method: "PUT", headers: otherHeaders, body: JSON.stringify({ response: "stolen" }),
  });
  assert.equal(stolen.status, 404);

  const { items } = await list(tenderId);
  assert.equal(items[0].response, "", "and nothing was written");
});
