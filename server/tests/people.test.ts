import assert from "node:assert/strict";
import test from "node:test";
import bcrypt from "bcryptjs";
import { signToken } from "../src/auth.js";
import { addPerson, createUser, initializeDatabase, listActivePeople, listPeople, saveTenderAnalysis, setPersonArchived, updatePerson, upsertTender } from "../src/db.js";
import { withStableIds } from "../src/analysis-schema.js";
import type { PersonRecord, TenderAnalysis } from "../src/types.js";

const evidence = { sourceDocument: "ITT.pdf", quote: "A project manager is required.", confidence: "HIGH" as const };
const analysisProposing = (name: string): TenderAnalysis => withStableIds({
  headline: "x", executiveSummary: "x", bidType: "OPEN_CONTRACT", access: "OPEN_TO_QUALIFIED_BIDDERS",
  eligibility: "REVIEW", fitScore: 60, decision: "REVIEW", partnerNeeded: false, partnerGaps: [],
  deadline: "26/03/2027", clarificationDeadline: "", contractValue: "", duration: "", lots: [],
  fatalGates: [], evaluationCriteria: [], questions: [],
  roles: [{
    role: "Project Manager", quantity: 1, minimumExperience: "5 years", qualifications: "",
    cvRequired: true, bidderMatch: `${name} — 8 years experience`, status: "PASS", action: "", evidence,
  }],
  clarificationQuestions: [], risks: [], submissionMethod: "eTenders",
  formalities: [], requiredCertificates: [], submissionChecklist: [], synopsisSlides: [],
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

async function makeAccount(label: string) {
  const email = `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;
  const user = await createUser(email, await bcrypt.hash("x", 4), `${label} Ltd`);
  return { id: user.id, email, headers: { authorization: `Bearer ${signToken({ id: user.id, email })}`, "content-type": "application/json" } };
}

const person = (over: Partial<PersonRecord> = {}) => ({
  name: "Aoife Byrne", title: "Senior Engineer", cvText: "Chartered engineer.", skills: ["energy"], ...over,
});

const a = await makeAccount("people-a");
const b = await makeAccount("people-b");

test("TLY-63 AC1: a person's title can be corrected", async () => {
  const created = await addPerson(a.id, person());
  const response = await fetch(`${base}/api/people/${created.id}`, {
    method: "PUT", headers: a.headers, body: JSON.stringify({ title: "Principal Engineer" }),
  });
  assert.equal(response.status, 200);

  const reloaded = (await listPeople(a.id)).find((entry) => entry.id === created.id);
  assert.equal(reloaded?.title, "Principal Engineer");
  assert.equal(reloaded?.name, "Aoife Byrne", "an unset field is left alone rather than blanked");
});

test("TLY-63 AC2: archiving names the live tenders that propose them", async () => {
  const created = await addPerson(a.id, person({ name: "Cormac Walsh" }));
  const tender = await upsertTender(a.id, {
    source: "seed", externalId: `people-${Date.now()}`, title: "Live tender proposing Cormac",
    authority: "Authority", procedure: "Open", deadline: "26/03/2027", estimatedValue: "",
    description: "", sourceUrl: "https://www.etenders.gov.ie/x", published: "", status: "ANALYSED", metadata: {},
  });
  await saveTenderAnalysis(a.id, tender.id, analysisProposing("Cormac Walsh"));

  const response = await fetch(`${base}/api/people/${created.id}/archive`, {
    method: "POST", headers: a.headers, body: JSON.stringify({ archived: true }),
  });
  assert.equal(response.status, 200);
  const body = await response.json() as { affectedTenders: { id: string; title: string }[] };
  assert.ok(body.affectedTenders.some((entry) => entry.id === tender.id),
    "the confirmation is about consequences, not a generic are-you-sure");
});

test("TLY-63 AC3: an archived person is not offered for role matching", async () => {
  const active = await listActivePeople(a.id);
  assert.ok(!active.some((entry) => entry.name === "Cormac Walsh"), "they have left; they cannot be fielded");
  assert.ok(active.some((entry) => entry.name === "Aoife Byrne"), "everyone else is still available");
});

test("TLY-63 AC4: an archived person is still visible, marked as archived", async () => {
  const everyone = await listPeople(a.id);
  const archived = everyone.find((entry) => entry.name === "Cormac Walsh");
  assert.ok(archived, "the record is not destroyed: a submitted bid named them");
  assert.ok(archived.archivedAt, "and it says plainly that they are archived");
});

test("TLY-63: archiving is reversible", async () => {
  const everyone = await listPeople(a.id);
  const archived = everyone.find((entry) => entry.name === "Cormac Walsh")!;
  const response = await fetch(`${base}/api/people/${archived.id}/archive`, {
    method: "POST", headers: a.headers, body: JSON.stringify({ archived: false }),
  });
  assert.equal(response.status, 200);

  const reinstated = (await listPeople(a.id)).find((entry) => entry.id === archived.id);
  assert.equal(reinstated?.archivedAt, undefined);
  assert.ok((await listActivePeople(a.id)).some((entry) => entry.id === archived.id));
});

test("TLY-63: nobody can edit or archive another account's people", async () => {
  const created = await addPerson(a.id, person({ name: "Private Person" }));

  const edit = await fetch(`${base}/api/people/${created.id}`, {
    method: "PUT", headers: b.headers, body: JSON.stringify({ title: "Stolen" }),
  });
  assert.equal(edit.status, 404);

  const archive = await fetch(`${base}/api/people/${created.id}/archive`, {
    method: "POST", headers: b.headers, body: JSON.stringify({ archived: true }),
  });
  assert.equal(archive.status, 404);

  const untouched = (await listPeople(a.id)).find((entry) => entry.id === created.id);
  assert.equal(untouched?.title, "Senior Engineer");
  assert.equal(untouched?.archivedAt, undefined);
});

test("TLY-63: a malformed person id is a 404, not a server error", async () => {
  assert.equal(await updatePerson(a.id, "not-a-uuid", { title: "x" }), null);
  assert.equal(await setPersonArchived(a.id, "not-a-uuid", true), null);
  const response = await fetch(`${base}/api/people/not-a-uuid`, {
    method: "PUT", headers: a.headers, body: JSON.stringify({ title: "x" }),
  });
  assert.equal(response.status, 404);
});
