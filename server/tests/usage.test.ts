import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
import { signToken } from "../src/auth.js";
import { createUser, initializeDatabase, listUsage, monthlyUsage, recordUsage, upsertTender } from "../src/db.js";

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
    status: "IMPORTED", metadata: {},
  });
  return { id: user.id, email, token: signToken({ id: user.id, email }), tenderId: tender.id };
}

const a = await makeAccount("usage-a");
const b = await makeAccount("usage-b");

test("TLY-69 AC1 and AC3: a metered call records its kind, tender and non-zero token counts", async () => {
  await recordUsage({ accountId: a.id, kind: "analysis", model: "claude-fable-5", inputTokens: 12_400, outputTokens: 3_100, requestId: "msg_1", tenderId: a.tenderId });
  await recordUsage({ accountId: a.id, kind: "draft", model: "claude-fable-5", inputTokens: 4_000, outputTokens: 1_200, requestId: "msg_2", tenderId: a.tenderId });

  const rows = await listUsage(a.id);
  assert.equal(rows.length, 2);
  const draft = rows.find((row) => row.kind === "draft");
  assert.ok(draft, "the drafting call is recorded under its own kind");
  assert.equal(draft.tenderId, a.tenderId, "a draft names the tender it belongs to");
  assert.ok(draft.inputTokens > 0 && draft.outputTokens > 0);
});

test("TLY-69 AC2: the month's totals and action count reach the API", async () => {
  const response = await fetch(`${base}/api/usage`, { headers: { authorization: `Bearer ${a.token}` } });
  assert.equal(response.status, 200);
  const { usage } = await response.json() as { usage: import("@tenderly/shared").UsageTotals };
  assert.equal(usage.actions, 2);
  assert.equal(usage.inputTokens, 16_400);
  assert.equal(usage.outputTokens, 4_300);
  assert.match(usage.month, /^\d{4}-\d{2}$/);
  assert.deepEqual(usage.byKind.map((row) => row.kind).sort(), ["analysis", "draft"]);
});

test("TLY-69 AC5: one account's panel never counts another account's calls", async () => {
  await recordUsage({ accountId: b.id, kind: "analysis", model: "claude-fable-5", inputTokens: 99_000, outputTokens: 99_000, tenderId: b.tenderId });

  const totals = await monthlyUsage(a.id);
  assert.equal(totals.actions, 2, "account B's call must not appear in account A's totals");
  assert.equal(totals.inputTokens, 16_400);

  const response = await fetch(`${base}/api/usage`, { headers: { authorization: `Bearer ${b.token}` } });
  const { usage } = await response.json() as { usage: import("@tenderly/shared").UsageTotals };
  assert.equal(usage.actions, 1);
});

test("TLY-69: usage is not readable without a token", async () => {
  assert.equal((await fetch(`${base}/api/usage`)).status, 401);
});

test("TLY-69 AC4: metering failure is caught and logged, never surfaced to the caller", () => {
  // The wrapper is the only place a model call is made, and the only place a
  // usage row is written — so this contract is a property of one function.
  const ai = readFileSync(path.resolve(process.cwd(), "src/ai.ts"), "utf8");
  const wrapper = ai.slice(ai.indexOf("async function callModel"), ai.indexOf("function sourceFallback"));
  assert.match(wrapper, /try \{/, "the metering write is wrapped");
  assert.match(wrapper, /catch \(error\)/);
  assert.match(wrapper, /console\.error/, "a lost row is logged rather than silently dropped");
  // The response is returned outside the catch, so a metering failure cannot
  // change what the caller gets back.
  assert.match(wrapper, /return response;\n\}/);
});

test("TLY-69 AC4: every model call goes through the metered wrapper", () => {
  const ai = readFileSync(path.resolve(process.cwd(), "src/ai.ts"), "utf8");
  const direct = [...ai.matchAll(/client!?\.messages\.create\(/g)];
  assert.equal(direct.length, 1, "exactly one call site may reach the SDK, and it is the wrapper");
  const wrapperStart = ai.indexOf("async function callModel");
  assert.ok(direct[0].index! > wrapperStart && direct[0].index! < ai.indexOf("function sourceFallback"),
    "the single SDK call must live inside callModel, so no future capability can skip the meter");
});

test("TLY-69 AC6: the deterministic fallback makes no model call, so nothing is metered", async (t) => {
  const { analyseTender, aiConfigured } = await import("../src/ai.js");
  // The fallback only runs when no key is configured. Rather than assert the
  // developer's environment — and rather than spend a real API call proving a
  // point about the path that avoids one — skip and say why.
  if (aiConfigured()) {
    t.skip("ANTHROPIC_API_KEY is set, so the deterministic fallback cannot be exercised here");
    return;
  }

  // A fresh account, so the assertion is about this call and nothing else.
  const fresh = await makeAccount("usage-fallback");
  assert.equal((await listUsage(fresh.id)).length, 0);

  const record = { id: fresh.tenderId, accountId: fresh.id, source: "seed", externalId: "x", title: "T", authority: "A",
    procedure: "Open", deadline: "", estimatedValue: "", description: "", sourceUrl: "https://www.etenders.gov.ie/x",
    published: "", status: "IMPORTED", metadata: {}, analysis: null };
  const company = { name: "Acme", registration: "", turnover: "", employees: "", services: "", cpv: "", certifications: "", insurance: "" };
  const analysis = await analyseTender(record, company, "");
  assert.equal(analysis.eligibility, "REVIEW", "the fallback still refuses to assert eligibility");
  assert.equal((await listUsage(fresh.id)).length, 0, "no model ran, so no usage may be recorded");
});
