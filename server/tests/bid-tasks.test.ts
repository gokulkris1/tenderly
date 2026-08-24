import assert from "node:assert/strict";
import test from "node:test";
import bcrypt from "bcryptjs";
import { signToken } from "../src/auth.js";
import { addEvidence, createUser, initializeDatabase, listBidTasks, listTasksForOwner, saveTenderAnalysis, syncBlockerTasks, upsertBidTask, upsertTender } from "../src/db.js";
import { withStableIds } from "../src/analysis-schema.js";
import type { BidTask, TenderAnalysis } from "../src/types.js";

const source = { sourceDocument: "ITT.pdf", quote: "Tax clearance is required.", confidence: "HIGH" as const };
const analysis = (): TenderAnalysis => withStableIds({
  headline: "x", executiveSummary: "x", bidType: "OPEN_CONTRACT", access: "OPEN_TO_QUALIFIED_BIDDERS",
  eligibility: "REVIEW", fitScore: 60, decision: "REVIEW", partnerNeeded: false, partnerGaps: [],
  deadline: "26/03/2027", clarificationDeadline: "", contractValue: "", duration: "", lots: [],
  fatalGates: [], evaluationCriteria: [], questions: [], roles: [],
  clarificationQuestions: [], risks: [], submissionMethod: "eTenders",
  formalities: [],
  requiredCertificates: [{ name: "Tax clearance certificate", issuingBody: "Revenue", mandatory: true, evidence: source }],
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

const email = `tasks-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;
const user = await createUser(email, await bcrypt.hash("x", 4), "Tasking Ltd");
const headers = { authorization: `Bearer ${signToken({ id: user.id, organisationId: user.organisationId, email })}`, "content-type": "application/json" };

let counter = 0;
async function makeTender() {
  counter += 1;
  const tender = await upsertTender(user.organisationId, {
    source: "seed", externalId: `task-${Date.now()}-${counter}`, title: `Tasked tender ${counter}`,
    authority: "Authority", procedure: "Open", deadline: "26/03/2027", estimatedValue: "",
    description: "", sourceUrl: "https://www.etenders.gov.ie/x", published: "", status: "ANALYSED", metadata: {},
  });
  await saveTenderAnalysis(user.organisationId, tender.id, analysis());
  return tender.id;
}

const tasksFor = (tenderId: string) =>
  fetch(`${base}/api/tenders/${tenderId}/tasks`, { headers })
    .then((r) => r.json() as Promise<{ tasks: (BidTask & { overdue: boolean })[] }>);

test("TLY-84 AC1: a blocker becomes a task without anyone transcribing it", async () => {
  const tenderId = await makeTender();
  const { tasks } = await tasksFor(tenderId);

  const certificate = tasks.find((task) => task.title.includes("Tax clearance certificate"));
  assert.ok(certificate, "the missing mandatory certificate is a blocker, so it is work");
  assert.equal(certificate.origin, "blocker");
  assert.equal(certificate.completedAt, undefined);
});

test("TLY-84: reading the tasks twice does not create a second copy", async () => {
  const tenderId = await makeTender();
  await tasksFor(tenderId);
  await tasksFor(tenderId);

  const stored = await listBidTasks(tenderId);
  const titles = stored.map((task) => task.title);
  assert.equal(new Set(titles).size, titles.length, "blocker tasks are keyed on the blocker's own text");
});

test("TLY-84 AC2: an owner and a due date survive a reload", async () => {
  const tenderId = await makeTender();
  const { tasks } = await tasksFor(tenderId);
  const target = tasks[0];

  const response = await fetch(`${base}/api/tenders/${tenderId}/tasks/${target.id}`, {
    method: "PUT", headers, body: JSON.stringify({ owner: "colleague@example.test", dueOn: "2026-03-12" }),
  });
  assert.equal(response.status, 200);

  const { tasks: reloaded } = await tasksFor(tenderId);
  const updated = reloaded.find((task) => task.id === target.id);
  assert.equal(updated?.owner, "colleague@example.test");
  assert.equal(updated?.dueOn, "2026-03-12");
});

test("TLY-84 AC3: resolving the blocker completes its task", async () => {
  const tenderId = await makeTender();
  const before = await tasksFor(tenderId);
  const certificate = before.tasks.find((task) => task.title.includes("Tax clearance certificate"))!;
  assert.equal(certificate.completedAt, undefined);

  // Uploading and verifying the certificate is what clears the blocker.
  await addEvidence(user.organisationId, {
    kind: "Tax clearance", name: "Tax clearance certificate", content: "Valid to 2027.", tags: [], verified: true,
  });

  const after = await tasksFor(tenderId);
  const completed = after.tasks.find((task) => task.id === certificate.id);
  assert.ok(completed?.completedAt, "the blocker list is the truth; the task follows it");
});

test("TLY-84: a blocker task cannot be ticked by hand", async () => {
  const tenderId = await makeTender();
  const { tasks } = await tasksFor(tenderId);
  const blocker = tasks.find((task) => task.origin === "blocker")!;

  const response = await fetch(`${base}/api/tenders/${tenderId}/tasks/${blocker.id}`, {
    method: "PUT", headers, body: JSON.stringify({ completed: true }),
  });
  assert.equal(response.status, 409, "a tick and a blocker disagreeing about the same fact helps nobody");
  assert.match((await response.json() as { error: string }).error, /completes when its blocker is resolved/);
});

test("TLY-84 AC4: a hand-added task appears in the owner's list with its tender", async () => {
  const tenderId = await makeTender();
  const created = await fetch(`${base}/api/tenders/${tenderId}/tasks`, {
    method: "POST", headers, body: JSON.stringify({ title: "Draft the method statement", owner: email, dueOn: "2026-03-12" }),
  });
  assert.equal(created.status, 201);

  const mine = await fetch(`${base}/api/my-tasks`, { headers })
    .then((r) => r.json() as Promise<{ tasks: (BidTask & { tenderTitle: string; overdue: boolean })[] }>);
  const task = mine.tasks.find((entry) => entry.title === "Draft the method statement");
  assert.ok(task);
  assert.match(task.tenderTitle, /Tasked tender/, "so a person knows which bid it belongs to");
  assert.equal(task.dueOn, "2026-03-12");
});

test("TLY-84 AC5: a past due date is flagged overdue, and completing it clears the flag", async () => {
  const tenderId = await makeTender();
  const created = await (await fetch(`${base}/api/tenders/${tenderId}/tasks`, {
    method: "POST", headers, body: JSON.stringify({ title: "Overdue work", owner: email, dueOn: "2020-01-01" }),
  })).json() as { task: BidTask };

  const { tasks } = await tasksFor(tenderId);
  assert.equal(tasks.find((task) => task.id === created.task.id)?.overdue, true);

  await fetch(`${base}/api/tenders/${tenderId}/tasks/${created.task.id}`, {
    method: "PUT", headers, body: JSON.stringify({ completed: true }),
  });
  const { tasks: after } = await tasksFor(tenderId);
  const done = after.find((task) => task.id === created.task.id);
  assert.ok(done?.completedAt);
  assert.equal(done?.overdue, false, "a completed task is not overdue, whatever its date said");
});

test("TLY-84: a task with no due date is never overdue", async () => {
  const tenderId = await makeTender();
  await fetch(`${base}/api/tenders/${tenderId}/tasks`, {
    method: "POST", headers, body: JSON.stringify({ title: "Undated work", owner: email }),
  });
  const { tasks } = await tasksFor(tenderId);
  assert.equal(tasks.find((task) => task.title === "Undated work")?.overdue, false);
});

test("TLY-84: a blocker that comes back reopens its task", async () => {
  const tenderId = await makeTender();
  const task = await upsertBidTask({ tenderId, title: "A blocker", origin: "blocker", owner: "", dueOn: "" });

  await syncBlockerTasks(tenderId, []);
  assert.ok((await listBidTasks(tenderId)).find((entry) => entry.id === task.id)?.completedAt, "cleared");

  await syncBlockerTasks(tenderId, ["A blocker"]);
  assert.equal((await listBidTasks(tenderId)).find((entry) => entry.id === task.id)?.completedAt, undefined,
    "the blocker is back, so the work is back");
});

test("TLY-84: tasks do not cross accounts", async () => {
  const tenderId = await makeTender();
  const otherEmail = `other-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;
  const other = await createUser(otherEmail, await bcrypt.hash("x", 4), "Other Ltd");
  const otherHeaders = { authorization: `Bearer ${signToken({ id: other.id, organisationId: other.organisationId, email: otherEmail })}`, "content-type": "application/json" };

  assert.equal((await fetch(`${base}/api/tenders/${tenderId}/tasks`, { headers: otherHeaders })).status, 404);
  assert.deepEqual(await listTasksForOwner(other.organisationId, email), [], "and their own list stays empty");
});
