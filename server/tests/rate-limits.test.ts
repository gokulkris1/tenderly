import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
import { signToken } from "../src/auth.js";
import { createUser, initializeDatabase, saveTenderAnalysis, upsertTender } from "../src/db.js";
import { withStableIds } from "../src/analysis-schema.js";
import type { TenderAnalysis } from "../src/types.js";

const source = { sourceDocument: "ITT.pdf", quote: "Describe your methodology.", confidence: "HIGH" as const };
const analysis = (): TenderAnalysis => withStableIds({
  headline: "x", executiveSummary: "x", bidType: "OPEN_CONTRACT", access: "OPEN_TO_QUALIFIED_BIDDERS",
  eligibility: "REVIEW", fitScore: 50, decision: "REVIEW", partnerNeeded: false, partnerGaps: [],
  deadline: "26/03/2026", clarificationDeadline: "", contractValue: "", duration: "", lots: [],
  fatalGates: [], evaluationCriteria: [],
  questions: Array.from({ length: 12 }, (_, index) => ({
    id: `seed-${index}`, title: `Question ${index + 1}`, prompt: "Describe it.",
    weight: 5, maxWords: 400, required: true, evidenceNeeded: [], source,
  })),
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
  return { id: user.id, token: signToken({ id: user.id, email }), tenderId: tender.id, questions: stored.questions };
}

const headers = (token: string) => ({ authorization: `Bearer ${token}`, "content-type": "application/json" });
const analyse = (account: { token: string; tenderId: string }) =>
  fetch(`${base}/api/tenders/${account.tenderId}/analyse`, { method: "POST", headers: headers(account.token), body: "{}" });

test("TLY-99 AC1 and AC2: excess analyses are refused with Retry-After and a message saying when", async () => {
  const account = await makeAccount("limit-a");
  // The configured per-minute allowance is 10; the eleventh must be refused.
  const responses = [];
  for (let i = 0; i < 11; i += 1) responses.push(await analyse(account));

  const refused = responses.filter((response) => response.status === 429);
  assert.equal(refused.length, 1, "exactly the calls beyond the limit are refused");

  const response = refused[0];
  const retryAfter = Number(response.headers.get("retry-after"));
  assert.ok(retryAfter > 0, "the refusal carries a Retry-After header a client can act on");

  const body = await response.json() as { error: string; retryAfterSeconds: number };
  assert.match(body.error, /Try again in \d+ (second|minute)s?\./,
    "the message states how long, not merely that the limit was hit");
  assert.equal(body.retryAfterSeconds, retryAfter);
});

test("TLY-99 AC3: one account reaching its limit does not affect another", async () => {
  const a = await makeAccount("limit-b");
  for (let i = 0; i < 11; i += 1) await analyse(a);
  assert.equal((await analyse(a)).status, 429, "account A is limited");

  const b = await makeAccount("limit-c");
  assert.notEqual((await analyse(b)).status, 429, "account B is unaffected");
});

test("TLY-99 AC4: a batch draft over 12 questions never trips the limit", async () => {
  const account = await makeAccount("limit-d");
  const statuses: number[] = [];
  for (const question of account.questions) {
    const response = await fetch(`${base}/api/tenders/${account.tenderId}/answers/${question.id}/draft`, {
      method: "POST", headers: headers(account.token), body: "{}",
    });
    statuses.push(response.status);
  }
  assert.equal(statuses.length, 12);
  assert.ok(!statuses.includes(429), `no request in a normal batch run may be refused, got ${statuses.join(",")}`);
});

test("TLY-99 AC5: the import limit is hourly, so a per-minute burst is not what is being caught", () => {
  // Asserting the shape of the configuration rather than waiting an hour: the
  // window is what decides whether "wait and retry" is a reasonable instruction.
  const limits = readFileSync(path.resolve(process.cwd(), "src/limits.ts"), "utf8");
  const importLine = limits.split("\n").find((line) => line.includes("export const importLimiter"));
  assert.ok(importLine?.includes("windowMs: hour"), "import is limited per hour");
  const analysisLine = limits.split("\n").find((line) => line.includes("export const analysisLimiter"));
  assert.ok(analysisLine?.includes("windowMs: minute"), "analysis is limited per minute as well as per hour");
});

test("TLY-99: limits are keyed by account, not by IP", () => {
  const limits = readFileSync(path.resolve(process.cwd(), "src/limits.ts"), "utf8");
  assert.match(limits, /keyGenerator: \(req\) => \(req as AuthenticatedRequest\)\.auth\?\.accountId/,
    "two colleagues behind one office NAT are two customers");
});

test("TLY-99: every expensive endpoint carries a limiter", () => {
  const index = readFileSync(path.resolve(process.cwd(), "src/index.ts"), "utf8");
  const expected: [string, string][] = [
    ['app.post("/api/tenders/import"', "importLimiter"],
    ['app.post("/api/tenders/:id/analyse"', "analysisLimiter"],
    ['app.post("/api/tenders/:id/answers/:questionId/draft"', "draftLimiter"],
    ['app.get("/api/tenders/:id/pack"', "packLimiter"],
    ['app.get("/api/tenders/:id/deck"', "packLimiter"],
  ];
  for (const [route, limiter] of expected) {
    const line = index.split("\n").find((item) => item.startsWith(route));
    assert.ok(line, `route ${route} not found`);
    assert.ok(line.includes(limiter), `${route} must be limited by ${limiter}`);
  }
});
