import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
import { signToken } from "../src/auth.js";
import { addEvidence, createUser, initializeDatabase, listAudit, recordAudit, saveTenderAnalysis, upsertTender } from "../src/db.js";
import { withStableIds } from "../src/analysis-schema.js";
import type { AuditEntry, TenderAnalysis } from "../src/types.js";

const source = { sourceDocument: "ITT.pdf", quote: "Describe your methodology.", confidence: "HIGH" as const };
const analysis = (): TenderAnalysis => withStableIds({
  headline: "x", executiveSummary: "x", bidType: "OPEN_CONTRACT", access: "OPEN_TO_QUALIFIED_BIDDERS",
  eligibility: "PASS", fitScore: 70, decision: "GO", partnerNeeded: false, partnerGaps: [],
  deadline: "26/03/2026", clarificationDeadline: "", contractValue: "", duration: "", lots: [],
  fatalGates: [], evaluationCriteria: [],
  questions: [{ id: "seed", title: "Methodology", prompt: "Describe it.", weight: 40, maxWords: 500, required: true, evidenceNeeded: [], source }],
  roles: [], clarificationQuestions: [], risks: [], submissionMethod: "eTenders",
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

async function makeAccount(label: string) {
  const email = `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;
  const user = await createUser(email, await bcrypt.hash("x", 4), `${label} Ltd`);
  const tender = await upsertTender(user.id, {
    source: "seed", externalId: `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    title: `${label} tender`, authority: "Authority", procedure: "Open", deadline: "26/03/2026",
    estimatedValue: "", description: "", sourceUrl: "https://www.etenders.gov.ie/x", published: "",
    status: "ANALYSED", metadata: {},
  });
  const stored = analysis();
  await saveTenderAnalysis(user.id, tender.id, stored);
  return {
    id: user.id, email, token: signToken({ id: user.id, email }),
    tenderId: tender.id, questionId: stored.questions[0].id,
  };
}

const a = await makeAccount("audit-a");
const b = await makeAccount("audit-b");
const headers = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });
const log = (token: string, query = "") => fetch(`${base}/api/audit${query}`, { headers: headers(token) })
  .then((r) => r.json() as Promise<{ entries: AuditEntry[] }>);

test("TLY-79 AC1: verifying evidence records the action, the item, the actor and a time", async () => {
  const item = await addEvidence(a.id, { kind: "Certificate", name: "ISO 27001 certificate", content: "secret body", tags: [], verified: false });
  const response = await fetch(`${base}/api/evidence/${item.id}/verification`, {
    method: "PUT", headers: headers(a.token), body: JSON.stringify({ verified: true }),
  });
  assert.equal(response.status, 200);

  const { entries } = await log(a.token);
  const entry = entries.find((row) => row.action === "evidence.verified");
  assert.ok(entry, "the action is recorded");
  assert.equal(entry.subjectLabel, "ISO 27001 certificate");
  assert.equal(entry.actor, a.email);
  assert.ok(Date.parse(entry.createdAt) > 0);
});

test("TLY-79 AC6: an entry names the item and never carries its contents", async () => {
  const { entries } = await log(a.token);
  const serialized = JSON.stringify(entries);
  assert.match(serialized, /ISO 27001 certificate/, "the name is recorded");
  assert.doesNotMatch(serialized, /secret body/, "the content is not");
});

test("TLY-79 AC1: marking an answer ready records it under its question title", async () => {
  const response = await fetch(`${base}/api/tenders/${a.tenderId}/answers/${a.questionId}`, {
    method: "PUT", headers: headers(a.token), body: JSON.stringify({ response: "Our approach.", status: "ready" }),
  });
  assert.equal(response.status, 200);
  const { entries } = await log(a.token);
  const entry = entries.find((row) => row.action === "answer.marked_ready");
  assert.equal(entry?.subjectLabel, "Methodology");
});

test("TLY-79 AC2: downloading the final pack is recorded against that tender", async () => {
  await fetch(`${base}/api/tenders/${a.tenderId}/attestation`, { method: "POST", headers: headers(a.token), body: JSON.stringify({ confirmed: true }) });
  const pack = await fetch(`${base}/api/tenders/${a.tenderId}/pack`, { headers: headers(a.token) });
  assert.equal(pack.status, 200);

  const { entries } = await log(a.token);
  const entry = entries.find((row) => row.action === "pack.final.downloaded");
  assert.ok(entry, "the download is recorded");
  assert.equal(entry.subjectId, a.tenderId);
  assert.equal(entry.subjectLabel, "audit-a tender");
});

test("TLY-79 AC3: the log filters by action and by period", async () => {
  const filtered = await log(a.token, "?action=answer.marked_ready&days=7");
  assert.ok(filtered.entries.length > 0);
  assert.ok(filtered.entries.every((entry) => entry.action === "answer.marked_ready"),
    "only the requested action is listed");

  // An entry older than the window is excluded.
  await recordAudit({
    accountId: a.id, actor: a.email, action: "answer.marked_ready", subjectType: "answer",
    subjectId: "ancient", subjectLabel: "Old answer", metadata: {},
  });
  const rows = await listAudit(a.id, { action: "answer.marked_ready", since: new Date(Date.now() + 60_000) });
  assert.equal(rows.length, 0, "nothing falls inside a window that has not started");
});

test("TLY-79 AC5: one account never sees another account's entries", async () => {
  await recordAudit({
    accountId: b.id, actor: b.email, action: "evidence.verified", subjectType: "evidence",
    subjectId: "b-item", subjectLabel: "Account B certificate", metadata: {},
  });
  const { entries } = await log(a.token);
  assert.ok(entries.every((entry) => entry.actor === a.email));
  assert.ok(!JSON.stringify(entries).includes("Account B certificate"));

  const mine = await log(b.token);
  assert.equal(mine.entries.length, 1);
});

test("TLY-79 AC4: there is no route that changes an entry, and the write is refused", async () => {
  const before = await log(a.token);
  const target = before.entries[0];

  for (const method of ["PUT", "PATCH", "DELETE"]) {
    const response = await fetch(`${base}/api/audit`, { method, headers: headers(a.token), body: method === "DELETE" ? undefined : "{}" });
    assert.ok(response.status >= 400, `${method} /api/audit must be refused, got ${response.status}`);
  }
  const after = await log(a.token);
  assert.deepEqual(after.entries[0], target, "the entry is unchanged");

  // The database refuses too, not only the absent route.
  const migration = readFileSync(path.resolve(process.cwd(), "migrations/006_audit_log.sql"), "utf8");
  assert.match(migration, /BEFORE UPDATE ON audit_log/);
  assert.match(migration, /RAISE EXCEPTION 'audit_log is append-only'/);
});

test("TLY-79: an audit failure never fails the action that was already taken", () => {
  const helper = readFileSync(path.resolve(process.cwd(), "src/audit.ts"), "utf8");
  assert.match(helper, /try \{/);
  assert.match(helper, /catch \(error\)/);
  assert.match(helper, /console\.error/);
  assert.doesNotMatch(helper, /throw /, "the helper must never rethrow: the action already happened");
});

test("TLY-79: the log is not readable without a token", async () => {
  assert.equal((await fetch(`${base}/api/audit`)).status, 401);
});
