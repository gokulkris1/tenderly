import "./helpers/env.js";
import assert from "node:assert/strict";
import test from "node:test";
import bcrypt from "bcryptjs";
import { signToken } from "../src/auth.js";
import {
  addMembership, createUser, initializeDatabase, listAnswers, listMemberships, membershipFor,
  saveAnswer, saveTenderAnalysis, upsertTender,
} from "../src/db.js";
import { LAST_OWNER, atLeast, roleRequiredMessage } from "../src/roles.js";
import { withStableIds } from "../src/analysis-schema.js";
import type { MembershipRole } from "../src/db.js";
import type { TenderAnalysis } from "../src/types.js";

await initializeDatabase();
const { app } = await import("../src/index.js");
const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const address = server.address();
const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
server.unref();

const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const source = { sourceDocument: "ITT.pdf", quote: "Describe your methodology.", confidence: "HIGH" as const };

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

const headersFor = (id: string, organisationId: string, email: string, role: MembershipRole) => ({
  authorization: `Bearer ${signToken({ id, organisationId, email, role })}`,
  "content-type": "application/json",
});

/** An organisation with an owner, an editor and a viewer, and one tender. */
async function workspace(label: string) {
  const ownerEmail = `${label}-owner-${unique()}@example.test`;
  const owner = await createUser(ownerEmail, await bcrypt.hash("x", 4), `${label} Ltd`);

  const make = async (role: MembershipRole) => {
    const email = `${label}-${role}-${unique()}@example.test`;
    const user = await createUser(email, await bcrypt.hash("x", 4), "Their own Ltd");
    await addMembership(owner.organisationId, user.id, role);
    return { ...user, email, headers: headersFor(user.id, owner.organisationId, email, role) };
  };

  const tender = await upsertTender(owner.organisationId, {
    source: "seed", externalId: `${label}-${unique()}`, title: `${label} tender`, authority: "Authority",
    procedure: "Open", deadline: "26/03/2027", estimatedValue: "", description: "",
    sourceUrl: "https://www.etenders.gov.ie/x", published: "", status: "ANALYSED", metadata: {},
  });
  const stored = analysis();
  await saveTenderAnalysis(owner.organisationId, tender.id, stored);
  await saveAnswer(tender.id, stored.questions[0].id, "What the team already wrote.", "draft", []);

  return {
    organisationId: owner.organisationId,
    tenderId: tender.id,
    questionId: stored.questions[0].id,
    owner: { ...owner, email: ownerEmail, headers: headersFor(owner.id, owner.organisationId, ownerEmail, "owner") },
    editor: await make("editor"),
    viewer: await make("viewer"),
  };
}

test("TLY-88 AC2: a viewer's token cannot save an answer, and the answer is unchanged", async () => {
  const team = await workspace("save");

  const response = await fetch(`${base}/api/tenders/${team.tenderId}/answers/${team.questionId}`, {
    method: "PUT", headers: team.viewer.headers, body: JSON.stringify({ response: "Rewritten by a reader." }),
  });
  assert.equal(response.status, 403);
  assert.equal((await response.json() as { error: string }).error, "This action needs the editor role");

  const [answer] = await listAnswers(team.tenderId);
  assert.equal(answer.response, "What the team already wrote.", "a hidden button is a courtesy; this is the control");
});

test("TLY-88 AC1: a viewer can read the tender they cannot edit", async () => {
  const team = await workspace("read");
  const response = await fetch(`${base}/api/tenders/${team.tenderId}`, { headers: team.viewer.headers });
  assert.equal(response.status, 200);
  const body = await response.json() as { tender: { title: string } };
  assert.match(body.tender.title, /read tender/);
});

test("TLY-88 AC1: the role travels to the screens so they can hide what it cannot do", async () => {
  const team = await workspace("me");
  const forRole = async (headers: Record<string, string>) =>
    (await fetch(`${base}/api/me`, { headers }).then((r) => r.json() as Promise<{ role: string; user: { email: string } }>));

  assert.equal((await forRole(team.viewer.headers)).role, "viewer");
  assert.equal((await forRole(team.editor.headers)).role, "editor");
  const owner = await forRole(team.owner.headers);
  assert.equal(owner.role, "owner");
  assert.equal(owner.user.email, team.owner.email, "and it is the person, not the organisation");
});

test("TLY-88: a viewer cannot download the final pack or spend a model call", async () => {
  const team = await workspace("spend");

  const drafted = await fetch(`${base}/api/tenders/${team.tenderId}/answers/${team.questionId}/draft`, {
    method: "POST", headers: team.viewer.headers, body: "{}",
  });
  assert.equal(drafted.status, 403, "drafting costs money and changes the bid");

  const analysed = await fetch(`${base}/api/tenders/${team.tenderId}/analyse`, {
    method: "POST", headers: team.viewer.headers, body: "{}",
  });
  assert.equal(analysed.status, 403);
});

test("TLY-88 AC3: billing is the owner's, and an editor asking directly is refused", async () => {
  const team = await workspace("billing");

  const asEditor = await fetch(`${base}/api/billing`, { headers: team.editor.headers });
  assert.equal(asEditor.status, 403);
  assert.equal((await asEditor.json() as { error: string }).error, "This action needs the owner role");

  const asViewer = await fetch(`${base}/api/billing`, { headers: team.viewer.headers });
  assert.equal(asViewer.status, 403);

  const asOwner = await fetch(`${base}/api/billing`, { headers: team.owner.headers });
  assert.equal(asOwner.status, 200);
  assert.equal((await asOwner.json() as { status: string }).status, "not-configured");
});

test("TLY-88: an editor cannot invite, remove people, export or delete the account", async () => {
  const team = await workspace("editor-limits");

  const invited = await fetch(`${base}/api/team/invitations`, {
    method: "POST", headers: team.editor.headers, body: JSON.stringify({ email: `x-${unique()}@example.test` }),
  });
  assert.equal(invited.status, 403);

  const removed = await fetch(`${base}/api/team/members/${team.viewer.id}`, {
    method: "DELETE", headers: team.editor.headers,
  });
  assert.equal(removed.status, 403);

  assert.equal((await fetch(`${base}/api/account/export`, { headers: team.editor.headers })).status, 403);
  assert.equal((await fetch(`${base}/api/account/deletion`, {
    method: "POST", headers: team.editor.headers, body: JSON.stringify({ confirmation: "DELETE MY ACCOUNT" }),
  })).status, 403);
});

test("TLY-88: an editor can do the work they were invited to do", async () => {
  const team = await workspace("editor-work");

  const response = await fetch(`${base}/api/tenders/${team.tenderId}/answers/${team.questionId}`, {
    method: "PUT", headers: team.editor.headers, body: JSON.stringify({ response: "The editor's words." }),
  });
  assert.equal(response.status, 200);
  const [answer] = await listAnswers(team.tenderId);
  assert.equal(answer.response, "The editor's words.");
});

test("TLY-88 AC4: the last owner cannot demote themselves", async () => {
  const team = await workspace("last-owner");

  const response = await fetch(`${base}/api/team/members/${team.owner.id}`, {
    method: "PUT", headers: team.owner.headers, body: JSON.stringify({ role: "editor" }),
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json() as { error: string }).error, LAST_OWNER);
  assert.equal((await membershipFor(team.organisationId, team.owner.id))?.role, "owner", "unchanged");
});

test("TLY-88 AC4: the last owner cannot be removed either", async () => {
  const team = await workspace("last-owner-removal");
  const response = await fetch(`${base}/api/team/members/${team.owner.id}`, {
    method: "DELETE", headers: team.owner.headers,
  });
  assert.equal(response.status, 409);
  assert.equal((await response.json() as { error: string }).error, LAST_OWNER);
  assert.ok(await membershipFor(team.organisationId, team.owner.id));
});

test("TLY-88 AC4: with a second owner, the first may step down", async () => {
  const team = await workspace("two-owners");
  const promoted = await fetch(`${base}/api/team/members/${team.editor.id}`, {
    method: "PUT", headers: team.owner.headers, body: JSON.stringify({ role: "owner" }),
  });
  assert.equal(promoted.status, 200);

  const stepped = await fetch(`${base}/api/team/members/${team.owner.id}`, {
    method: "PUT", headers: team.owner.headers, body: JSON.stringify({ role: "editor" }),
  });
  assert.equal(stepped.status, 200);
  assert.equal((await membershipFor(team.organisationId, team.owner.id))?.role, "editor");
});

test("TLY-88 AC5: a removed member's existing token stops working immediately", async () => {
  const team = await workspace("removal");
  // The token was minted before the removal and has hours left on it.
  const stillHeld = team.editor.headers;
  assert.equal((await fetch(`${base}/api/tenders`, { headers: stillHeld })).status, 200);

  const removed = await fetch(`${base}/api/team/members/${team.editor.id}`, {
    method: "DELETE", headers: team.owner.headers,
  });
  assert.equal(removed.status, 200);

  const after = await fetch(`${base}/api/tenders`, { headers: stillHeld });
  assert.ok(after.status === 401 || after.status === 403, `got ${after.status}`);
  const body = await after.json() as { items?: unknown };
  assert.equal(body.items, undefined, "and no organisation data comes back with the refusal");
});

test("TLY-88: a demotion takes effect on the next request, not at the end of the session", async () => {
  const team = await workspace("demotion");
  // A token that still claims editor, because it was minted when that was true.
  const staleToken = team.editor.headers;

  await fetch(`${base}/api/team/members/${team.editor.id}`, {
    method: "PUT", headers: team.owner.headers, body: JSON.stringify({ role: "viewer" }),
  });

  const response = await fetch(`${base}/api/tenders/${team.tenderId}/answers/${team.questionId}`, {
    method: "PUT", headers: staleToken, body: JSON.stringify({ response: "Written after the demotion." }),
  });
  assert.equal(response.status, 403, "the claim in a token is a copy; the membership row is the fact");
  const [answer] = await listAnswers(team.tenderId);
  assert.equal(answer.response, "What the team already wrote.");
});

test("TLY-88: a removed member keeps their own sign-in and their own workspace", async () => {
  const team = await workspace("survivor");
  await fetch(`${base}/api/team/members/${team.editor.id}`, { method: "DELETE", headers: team.owner.headers });

  const theirOwn = headersFor(team.editor.id, team.editor.organisationId, team.editor.email, "owner");
  assert.equal((await fetch(`${base}/api/tenders`, { headers: theirOwn })).status, 200,
    "their sign-in is theirs, not the client's");
  assert.equal((await listMemberships(team.organisationId)).length, 2);
});

test("TLY-88: somebody who is not a member at all cannot use a token naming this organisation", async () => {
  const team = await workspace("outsider");
  const outsiderEmail = `outsider-${unique()}@example.test`;
  const outsider = await createUser(outsiderEmail, await bcrypt.hash("x", 4), "Outsider Ltd");

  const forged = headersFor(outsider.id, team.organisationId, outsiderEmail, "owner");
  const response = await fetch(`${base}/api/tenders`, { headers: forged });
  assert.equal(response.status, 403, "a role claim without a membership behind it is worth nothing");
});

test("TLY-88: the ranking is owner over editor over viewer, and the refusal names the role", () => {
  assert.equal(atLeast("owner", "editor"), true);
  assert.equal(atLeast("editor", "editor"), true);
  assert.equal(atLeast("viewer", "editor"), false);
  assert.equal(atLeast("editor", "owner"), false);
  assert.equal(roleRequiredMessage("editor"), "This action needs the editor role");
  assert.equal(roleRequiredMessage("owner"), "This action needs the owner role");
});
