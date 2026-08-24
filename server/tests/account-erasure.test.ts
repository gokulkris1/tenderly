import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";
import bcrypt from "bcryptjs";
import { signToken } from "../src/auth.js";
import {
  addEvidence, addPerson, cancelAccountDeletion, createUser, deleteAccount, dueDeletions,
  findUserByEmail, initializeDatabase, listAnswers, listAudit, listEvidence, listPeople,
  listTenders, pendingDeletion,
  replacePersonFacts, requestAccountDeletion, saveAnswer, upsertTender,
} from "../src/db.js";
import { CONFIRMATION_PHRASE, GRACE_DAYS, confirmsDeletion, daysRemaining } from "../src/account-erasure.js";
import { buildAccountExport } from "../src/account-export.js";

process.env.JWT_SECRET ||= "test-secret-that-is-at-least-32-characters";
process.env.TENDERLY_NO_LISTEN = "1";
await initializeDatabase();
const { app } = await import("../src/index.js");
const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const address = server.address();
const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
server.unref();

const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;

/** An account with something in every drawer the export is supposed to open. */
async function populatedAccount(label: string) {
  const email = `${label}-${unique()}@example.test`;
  const user = await createUser(email, await bcrypt.hash("x", 4), `${label} Ltd`);
  const headers = { authorization: `Bearer ${signToken({ id: user.id, email })}`, "content-type": "application/json" };

  const tender = await upsertTender(user.id, {
    source: "seed", externalId: `erasure-${unique()}`, title: `${label} tender`, authority: "Authority",
    procedure: "Open", deadline: "26/03/2027", estimatedValue: "", description: "",
    sourceUrl: "https://www.etenders.gov.ie/x", published: "", status: "ANALYSED", metadata: {},
  });
  await saveAnswer(tender.id, "seed", `${label} wrote this answer.`, "ready", []);

  const evidence = await addEvidence(user.id, {
    kind: "Tax clearance", name: "Tax clearance certificate", content: "Valid to 2027.", tags: [], verified: true,
    filename: "tax clearance.pdf", contentType: "application/pdf", sizeBytes: 12,
  }, Buffer.from("%PDF-1.4 tax"));

  const person = await addPerson(user.id, {
    name: "Aoife Byrne", title: "Project Manager", cvText: "Fifteen years delivering public sector projects.", skills: ["PMP"],
  });
  await replacePersonFacts(person.id, [
    {
      type: "certification", value: "PMP", detail: "Project Management Institute",
      period: "2019", quote: "PMP, Project Management Institute, 2019.", confidence: "HIGH",
    },
  ]);

  return { user, email, headers, tenderId: tender.id, evidenceId: evidence.id, personId: person.id };
}

const openExport = async (buffer: Buffer) => JSZip.loadAsync(buffer);

test("TLY-97 AC1: the archive holds a JSON file per data type plus the original vault files", async () => {
  const account = await populatedAccount("export");
  const archive = await buildAccountExport(account.user.id);
  const zip = await openExport(archive.buffer);

  for (const name of ["account.json", "tenders.json", "people.json", "evidence.json", "declarations.json", "activity.json"]) {
    assert.ok(zip.file(name), `${name} is missing, so that data type is simply absent from the answer`);
  }

  const tenders = JSON.parse(await zip.file("tenders.json")!.async("string")) as { title: string; answers: { response: string }[] }[];
  assert.equal(tenders.length, 1);
  assert.match(tenders[0].title, /export tender/);
  assert.match(tenders[0].answers[0].response, /wrote this answer/);

  const vault = zip.file("vault/tax clearance.pdf");
  assert.ok(vault, "a vault of PDFs exported as JSON strings is not an export of the vault");
  assert.equal(await vault.async("string"), "%PDF-1.4 tax");
});

test("TLY-97 AC2: the people file carries the CV text and the structured records", async () => {
  const account = await populatedAccount("people");
  const zip = await openExport((await buildAccountExport(account.user.id)).buffer);

  const people = JSON.parse(await zip.file("people.json")!.async("string")) as
    { name: string; cvText: string; records: { value: string }[] }[];
  const aoife = people.find((person) => person.name === "Aoife Byrne");
  assert.ok(aoife);
  assert.match(aoife.cvText, /Fifteen years delivering public sector projects/);
  assert.deepEqual(aoife.records.map((record) => record.value), ["PMP"]);
});

test("TLY-97: the archive holds this account's data and nobody else's", async () => {
  const mine = await populatedAccount("mine");
  const theirs = await populatedAccount("theirs");

  const zip = await openExport((await buildAccountExport(mine.user.id)).buffer);
  const text = await zip.file("tenders.json")!.async("string");
  assert.match(text, /mine tender/);
  assert.ok(!text.includes("theirs tender"), "an export that leaks is worse than no export");
  assert.ok(!(await zip.file("people.json")!.async("string")).includes(theirs.user.id));
});

test("TLY-97 AC1: the owner can download the archive over the API", async () => {
  const account = await populatedAccount("download");
  const response = await fetch(`${base}/api/account/export`, { headers: account.headers });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/zip");
  assert.match(response.headers.get("content-disposition") ?? "", /attachment; filename="tenderly-export-.*\.zip"/);
  const zip = await openExport(Buffer.from(await response.arrayBuffer()));
  assert.ok(zip.file("account.json"));
});

test("TLY-97 AC3: an editor gets 403 for both the export and the deletion, and neither starts", async () => {
  const account = await populatedAccount("editor");
  // A collaborator holds a token for the same account under their own address.
  const editor = {
    authorization: `Bearer ${signToken({ id: account.user.id, email: `editor-${unique()}@example.test` })}`,
    "content-type": "application/json",
  };

  const exported = await fetch(`${base}/api/account/export`, { headers: editor });
  assert.equal(exported.status, 403);
  assert.match((await exported.json() as { error: string }).error, /owner/);

  const deletion = await fetch(`${base}/api/account/deletion`, {
    method: "POST", headers: editor, body: JSON.stringify({ confirmation: CONFIRMATION_PHRASE }),
  });
  assert.equal(deletion.status, 403);
  assert.equal(await pendingDeletion(account.user.id), null, "and nothing was scheduled");
});

test("TLY-97 AC4: the confirmation phrase has to be typed, or nothing is scheduled", async () => {
  const account = await populatedAccount("confirm");

  const wrong = await fetch(`${base}/api/account/deletion`, {
    method: "POST", headers: account.headers, body: JSON.stringify({ confirmation: "yes" }),
  });
  assert.equal(wrong.status, 400);
  assert.match((await wrong.json() as { error: string }).error, new RegExp(CONFIRMATION_PHRASE));
  assert.equal(await pendingDeletion(account.user.id), null);

  assert.equal(confirmsDeletion("  delete my account  "), true, "padding and case are the user's typing, not their intent");
  assert.equal(confirmsDeletion("delete account"), false);
});

test("TLY-97 AC4: a confirmed request schedules a deletion and changes nothing yet", async () => {
  const account = await populatedAccount("scheduled");
  const response = await fetch(`${base}/api/account/deletion`, {
    method: "POST", headers: account.headers, body: JSON.stringify({ confirmation: CONFIRMATION_PHRASE }),
  });

  assert.equal(response.status, 202);
  const body = await response.json() as { scheduledFor: string; daysRemaining: number };
  assert.equal(body.daysRemaining, GRACE_DAYS);

  // The point of a grace period is that the account still works during it.
  assert.equal((await listTenders(account.user.id)).length, 1);
  assert.equal((await fetch(`${base}/api/account/deletion`, { headers: account.headers })).status, 200);
  assert.ok(await findUserByEmail(account.email));

  const due = await dueDeletions();
  assert.ok(!due.some((entry) => entry.accountId === account.user.id), "it is not due for another week");
});

test("TLY-97 AC5: cancelling inside the grace period leaves everything present", async () => {
  const account = await populatedAccount("cancelled");
  await fetch(`${base}/api/account/deletion`, {
    method: "POST", headers: account.headers, body: JSON.stringify({ confirmation: CONFIRMATION_PHRASE }),
  });

  const cancelled = await fetch(`${base}/api/account/deletion`, { method: "DELETE", headers: account.headers });
  assert.equal(cancelled.status, 200);

  const state = await (await fetch(`${base}/api/account/deletion`, { headers: account.headers })).json() as { pending: unknown };
  assert.equal(state.pending, null);
  assert.equal((await listTenders(account.user.id)).length, 1);
  assert.equal((await listEvidence(account.user.id)).length, 1);
  assert.equal((await listPeople(account.user.id)).length, 1);
  assert.ok(await findUserByEmail(account.email), "and they can still sign in");

  assert.ok(!(await dueDeletions()).some((entry) => entry.accountId === account.user.id));
});

test("TLY-97: cancelling when nothing is pending says so rather than reporting success", async () => {
  const account = await populatedAccount("nothing-pending");
  const response = await fetch(`${base}/api/account/deletion`, { method: "DELETE", headers: account.headers });
  assert.equal(response.status, 404);
});

test("TLY-97 AC4 and AC6: the due deletion removes this account and only this account", async () => {
  const doomed = await populatedAccount("doomed");
  const bystander = await populatedAccount("bystander");

  // Requested with no grace period, which is what the job sees once one expires.
  const request = await requestAccountDeletion(doomed.user.id, doomed.email, 0);
  assert.ok((await dueDeletions()).some((entry) => entry.accountId === doomed.user.id));

  assert.equal(await deleteAccount(doomed.user.id, request.requestedBy, request.requestedAt), true);

  assert.equal(await findUserByEmail(doomed.email), null, "signing in with that account fails");
  assert.deepEqual(await listTenders(doomed.user.id), []);
  assert.deepEqual(await listEvidence(doomed.user.id), []);
  assert.deepEqual(await listPeople(doomed.user.id, { includeArchived: true }), []);
  assert.deepEqual(await listAnswers(doomed.tenderId), [], "the answers went with the tender");
  assert.deepEqual(await listAudit(doomed.user.id, {}), [], "and so did the account's own log");

  assert.ok(await findUserByEmail(bystander.email), "another organisation is not collateral");
  assert.equal((await listTenders(bystander.user.id)).length, 1);
  assert.equal((await listEvidence(bystander.user.id)).length, 1);
});

test("TLY-97: a second request replaces the first rather than stacking two deadlines", async () => {
  const account = await populatedAccount("restated");
  await requestAccountDeletion(account.user.id, account.email, GRACE_DAYS);
  const second = await requestAccountDeletion(account.user.id, account.email, 30);

  const pending = await pendingDeletion(account.user.id);
  assert.equal(pending?.id, second.id, "two pending deletions would mean two different answers to when");
  assert.equal(await cancelAccountDeletion(account.user.id), true);
  assert.equal(await cancelAccountDeletion(account.user.id), false, "and one cancel clears it");
});

test("TLY-97: the countdown never runs negative", () => {
  assert.equal(daysRemaining(new Date(Date.now() - 86_400_000).toISOString()), 0);
  assert.equal(daysRemaining("not a date"), 0);
});
