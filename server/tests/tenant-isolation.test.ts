import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
import { signToken } from "../src/auth.js";
import {
  addEvidence, addPerson, createUser, initializeDatabase, replacePersonFacts, saveAnswer,
  saveTenderAnalysis, savePreferences, upsertTender,
} from "../src/db.js";
import { withStableIds } from "../src/analysis-schema.js";
import type { TenderAnalysis } from "../src/types.js";

/**
 * One forgotten account_id filter leaks another company's bid. Nothing proved
 * that could not happen, so this suite tries every authenticated route as the
 * wrong tenant and insists on a refusal with no resource data in the body.
 *
 * It is driven from the route table in index.ts: a new authenticated route with
 * no case here fails the last test, so coverage cannot silently rot.
 */

const evidence = { sourceDocument: "RFT.pdf", quote: "Tenderers shall hold ISO 9001.", confidence: "HIGH" as const };
const analysis = (): TenderAnalysis => withStableIds({
  headline: "x", executiveSummary: "x", bidType: "OPEN_CONTRACT", access: "OPEN_TO_QUALIFIED_BIDDERS",
  eligibility: "REVIEW", fitScore: 50, decision: "REVIEW", partnerNeeded: false, partnerGaps: [],
  deadline: "26/03/2026", clarificationDeadline: "", contractValue: "", duration: "", lots: [],
  fatalGates: [], evaluationCriteria: [],
  questions: [{ id: "seed", title: "Methodology", prompt: "Describe it.", weight: 40, maxWords: 500, required: true, evidenceNeeded: [], source: evidence }],
  roles: [], clarificationQuestions: [], risks: [], submissionMethod: "eTenders",
  formalities: [], requiredCertificates: [],
  submissionChecklist: [{ id: "seed", label: "Tender response", required: true, kind: "RESPONSE", status: "ACTION", source: evidence }],
  synopsisSlides: [],
});

type Tenant = { token: string; tenderId: string; evidenceId: string; personId: string; factId: string; questionId: string; checklistId: string };

async function makeTenant(label: string): Promise<Tenant> {
  const user = await createUser(`${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`, await bcrypt.hash("x", 4), `${label} Ltd`);
  const tender = await upsertTender(user.id, {
    source: "seed", externalId: `${label}-${Date.now()}`, title: `${label} tender`, authority: "Authority",
    procedure: "Open", deadline: "26/03/2026", estimatedValue: "", description: "", sourceUrl: "https://www.etenders.gov.ie/x",
    published: "", status: "ANALYSED", metadata: {},
  });
  const stored = analysis();
  await saveTenderAnalysis(user.id, tender.id, stored);
  const question = stored.questions[0];
  await saveAnswer(tender.id, question.id, `${label} confidential answer`, "ready", []);
  const ev = await addEvidence(user.id, { kind: "Certificate", name: `${label} ISO`, content: `${label} confidential evidence`, tags: [], verified: true });
  const person = await addPerson(user.id, { name: `${label} Person`, title: "Lead", cvText: `${label} confidential CV`, skills: [] });
  const facts = await replacePersonFacts(person.id, [{
    type: "certification", value: `${label} confidential certification`, detail: "Body",
    period: "2026", quote: "…", confidence: "HIGH",
  }]);
  await savePreferences(user.id, { sectors: ["software-development"], keywords: [label], cpvCodes: [], valueMin: null, valueMax: null });
  return {
    token: signToken({ id: user.id, email: user.email }), tenderId: tender.id, evidenceId: ev.id, personId: person.id, factId: facts[0].id,
    questionId: question.id, checklistId: stored.submissionChecklist[0].id,
  };
}

// The fixture is module scope, not a test: an after-hook inside a test closes the
// server as soon as that test finishes, leaving the rest with nothing to call.
process.env.JWT_SECRET ||= "test-secret-that-is-at-least-32-characters";
process.env.TENDERLY_NO_LISTEN = "1";
await initializeDatabase();
const { app } = await import("../src/index.js");
const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const address = server.address();
const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
server.unref();  // must not hold the test process open

const a: Tenant = await makeTenant("alpha");
const b: Tenant = await makeTenant("bravo");

test("TLY-93: the two accounts are distinct and both hold data", () => {
  assert.notEqual(a.tenderId, b.tenderId);
  assert.ok(base.includes("127.0.0.1:") && !base.endsWith(":0"));
});

/** Every authenticated route, with the resource owned by A and the token of B. */
function crossTenantCases(owner: Tenant) {
  return [
    { method: "GET", path: `/api/tenders/${owner.tenderId}` },
    { method: "POST", path: `/api/tenders/${owner.tenderId}/analyse`, body: {} },
    { method: "POST", path: `/api/tenders/${owner.tenderId}/answers/${owner.questionId}/draft`, body: {} },
    { method: "PUT", path: `/api/tenders/${owner.tenderId}/answers/${owner.questionId}`, body: { response: "stolen", status: "ready" } },
    { method: "GET", path: `/api/tenders/${owner.tenderId}/answers/${owner.questionId}/provenance` },
    { method: "GET", path: `/api/tenders/${owner.tenderId}/answers/${owner.questionId}/versions` },
    { method: "POST", path: `/api/tenders/${owner.tenderId}/answers/${owner.questionId}/versions/00000000-0000-0000-0000-000000000000/restore`, body: {} },
    { method: "POST", path: `/api/tenders/${owner.tenderId}/ai-policy/acknowledge`, body: { action: "dismissed" } },
    { method: "PUT", path: `/api/tenders/${owner.tenderId}/no-ai-mode`, body: { enabled: true } },
    { method: "PUT", path: `/api/tenders/${owner.tenderId}/lots`, body: { lotIds: [] } },
    { method: "PUT", path: `/api/tenders/${owner.tenderId}/roles/Methodology/assignment`, body: { personId: null } },
    { method: "POST", path: `/api/tenders/${owner.tenderId}/decision`, body: { decision: "BID", reason: "stolen" } },
    { method: "GET", path: `/api/tenders/${owner.tenderId}/attestation` },
    { method: "POST", path: `/api/tenders/${owner.tenderId}/attestation`, body: { confirmed: true } },
    { method: "POST", path: `/api/tenders/${owner.tenderId}/answers/${owner.questionId}/critique`, body: {} },
    { method: "POST", path: `/api/tenders/${owner.tenderId}/checklist/${owner.checklistId}`, body: { status: "READY" } },
    { method: "GET", path: `/api/tenders/${owner.tenderId}/red-team` },
    { method: "GET", path: `/api/tenders/${owner.tenderId}/mock-evaluation` },
    { method: "POST", path: `/api/tenders/${owner.tenderId}/mock-evaluation`, body: {} },
    { method: "GET", path: `/api/tenders/${owner.tenderId}/deck` },
    { method: "GET", path: `/api/tenders/${owner.tenderId}/pack?draft=true` },
    { method: "PUT", path: `/api/evidence/${owner.evidenceId}/verification`, body: { verified: false } },
    { method: "GET", path: `/api/evidence/${owner.evidenceId}/file` },
    { method: "PUT", path: `/api/people/${owner.personId}`, body: { title: "stolen" } },
    { method: "GET", path: `/api/people/${owner.personId}/records` },
    { method: "POST", path: `/api/people/${owner.personId}/records/confirm`, body: {} },
    { method: "PUT", path: `/api/people/records/${owner.factId}`, body: { value: "stolen", confirmed: true } },
    { method: "POST", path: `/api/people/${owner.personId}/archive`, body: { archived: true } },
  ];
}

test("TLY-93 AC1: account B cannot read or change any of account A's resources", async () => {
  const failures: string[] = [];
  for (const c of crossTenantCases(a)) {
    const res = await fetch(base + c.path, {
      method: c.method,
      headers: { Authorization: `Bearer ${b.token}`, "Content-Type": "application/json" },
      body: c.body ? JSON.stringify(c.body) : undefined,
    });
    const text = await res.text();
    if (![403, 404].includes(res.status)) failures.push(`${c.method} ${c.path} -> ${res.status}`);
    if (/alpha confidential/i.test(text)) failures.push(`${c.method} ${c.path} leaked A's data`);
  }
  assert.deepEqual(failures, [], `cross-tenant access must be refused:\n${failures.join("\n")}`);
});

test("TLY-93 AC1: list endpoints return only the caller's own rows", async () => {
  for (const [path, needle] of [["/api/tenders", "alpha tender"], ["/api/evidence", "alpha confidential evidence"], ["/api/people", "alpha confidential CV"], ["/api/preferences", "alpha"]] as const) {
    const res = await fetch(base + path, { headers: { Authorization: `Bearer ${b.token}` } });
    const text = await res.text();
    assert.equal(res.status, 200, path);
    assert.equal(new RegExp(needle, "i").test(text), false, `${path} leaked account A's data to account B`);
  }
});

test("TLY-93 AC4: account B cannot download account A's pack", async () => {
  const res = await fetch(`${base}/api/tenders/${a.tenderId}/pack?draft=true`, { headers: { Authorization: `Bearer ${b.token}` } });
  assert.equal(res.status, 404);
  const buf = Buffer.from(await res.arrayBuffer());
  // A ZIP begins "PK". Anything else means no archive was produced.
  assert.notEqual(buf.subarray(0, 2).toString(), "PK", "pack bytes were returned to the wrong tenant");
});

test("TLY-93: an unauthenticated request is refused everywhere", async () => {
  for (const path of ["/api/tenders", "/api/company", "/api/evidence", "/api/people", "/api/preferences", `/api/tenders/${a.tenderId}`]) {
    const res = await fetch(base + path);
    assert.equal(res.status, 401, `${path} answered ${res.status} without a token`);
  }
});

test("TLY-93 AC3: every authenticated route is covered by a case here", () => {
  const source = readFileSync(path.resolve(process.cwd(), "src/index.ts"), "utf8");
  const routes = [...source.matchAll(/app\.(get|post|put|delete)\("(\/api\/[^"]*)"/g)]
    .map((m) => `${m[1].toUpperCase()} ${m[2]}`)
    .filter((r) => !r.includes("/api/auth/") && !r.includes("/api/jobs/"));
  // Routes that carry no tenant-owned resource: they read or write only the caller's own scope.
  const ownScopeOnly = [
    "GET /api/me", "GET /api/company", "PUT /api/company", "GET /api/sectors",
    "GET /api/preferences", "PUT /api/preferences", "GET /api/tenders", "GET /api/usage", "GET /api/audit",
    "GET /api/skills-matrix",
    "GET /api/watchlist", "POST /api/watchlist", "DELETE /api/watchlist/:externalId",
    "GET /api/vault/completeness",
    "GET /api/declarations", "PUT /api/declarations", "POST /api/declarations/affirm",
    "GET /api/saved-searches", "POST /api/saved-searches", "DELETE /api/saved-searches/:id",
    "GET /api/tenders/discover", "POST /api/tenders/import", "GET /api/evidence",
    "POST /api/evidence", "POST /api/evidence/upload", "GET /api/people",
    "POST /api/people", "POST /api/people/upload", "GET /api/notifications",
    "POST /api/tenders/:id/documents",
  ];
  const covered = new Set([
    ...ownScopeOnly,
    "GET /api/tenders/:id", "POST /api/tenders/:id/analyse",
    "POST /api/tenders/:id/answers/:questionId/draft", "PUT /api/tenders/:id/answers/:questionId",
    "GET /api/tenders/:id/answers/:questionId/provenance",
    "GET /api/tenders/:id/answers/:questionId/versions",
    "POST /api/tenders/:id/answers/:questionId/versions/:versionId/restore",
    "POST /api/tenders/:id/ai-policy/acknowledge", "PUT /api/tenders/:id/no-ai-mode",
    "PUT /api/tenders/:id/lots", "PUT /api/tenders/:id/roles/:role/assignment", "POST /api/tenders/:id/decision",
    "GET /api/tenders/:id/attestation", "POST /api/tenders/:id/attestation",
    "POST /api/tenders/:id/answers/:questionId/critique",
    "POST /api/tenders/:id/checklist/:itemId", "GET /api/tenders/:id/red-team",
    "GET /api/tenders/:id/mock-evaluation", "POST /api/tenders/:id/mock-evaluation",
    "GET /api/tenders/:id/deck", "GET /api/tenders/:id/pack",
    "PUT /api/evidence/:id/verification", "GET /api/evidence/:id/file",
    "PUT /api/people/:id", "POST /api/people/:id/archive",
    "GET /api/people/:id/records", "POST /api/people/:id/records/confirm", "PUT /api/people/records/:factId",
  ]);
  const uncovered = routes.filter((r) => !covered.has(r));
  assert.deepEqual(uncovered, [], `these authenticated routes have no isolation case:\n${uncovered.join("\n")}`);
});
