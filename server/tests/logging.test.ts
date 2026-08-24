import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
import { signToken } from "../src/auth.js";
import { createUser, initializeDatabase } from "../src/db.js";
import { REQUEST_ID_HEADER, log, redact } from "../src/logging.js";

process.env.JWT_SECRET ||= "test-secret-that-is-at-least-32-characters";
process.env.TENDERLY_NO_LISTEN = "1";
await initializeDatabase();
const { app } = await import("../src/index.js");
const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const address = server.address();
const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
server.unref();

const email = `log-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;
const user = await createUser(email, await bcrypt.hash("correct-horse-battery", 4), "Logging Ltd");
const token = signToken({ id: user.id, organisationId: user.organisationId, email });

/** Captures whatever the logger writes while `run` executes. */
async function captureLogs(run: () => Promise<void>) {
  const lines: string[] = [];
  const originals = { log: console.log, warn: console.warn, error: console.error };
  const capture = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  console.log = capture; console.warn = capture; console.error = capture;
  try {
    await run();
  } finally {
    console.log = originals.log; console.warn = originals.warn; console.error = originals.error;
  }
  return lines;
}

test("TLY-94 AC1: a request writes one JSON line with route, status, duration and ids", async () => {
  let response: Response | undefined;
  const lines = await captureLogs(async () => {
    response = await fetch(`${base}/api/tenders`, { headers: { authorization: `Bearer ${token}` } });
    // The line is written on 'finish', which can land just after the fetch resolves.
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.equal(response?.status, 200);

  const entry = lines.map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .find((parsed) => parsed?.route?.includes("/api/tenders"));
  assert.ok(entry, `no JSON log line for the request; got: ${lines.join(" | ").slice(0, 300)}`);
  assert.equal(entry.status, 200);
  assert.equal(typeof entry.durationMs, "number");
  assert.equal(entry.accountId, user.organisationId);
  assert.ok(entry.requestId, "the line carries the id a user can quote");
  assert.ok(Date.parse(entry.time) > 0);
});

test("TLY-94 AC2: the response carries the same request id as the log line", async () => {
  let header = "";
  const lines = await captureLogs(async () => {
    const response = await fetch(`${base}/api/tenders`, { headers: { authorization: `Bearer ${token}` } });
    header = response.headers.get(REQUEST_ID_HEADER) ?? "";
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  assert.ok(header, "the id is echoed in a header");

  const entry = lines.map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .find((parsed) => parsed?.requestId === header);
  assert.ok(entry, "the header and the log line are the same id, or support cannot join them");
});

test("TLY-94: an inbound request id is honoured, so a trace does not break at our edge", async () => {
  const response = await fetch(`${base}/api/tenders`, {
    headers: { authorization: `Bearer ${token}`, [REQUEST_ID_HEADER]: "upstream-trace-42" },
  });
  assert.equal(response.headers.get(REQUEST_ID_HEADER), "upstream-trace-42");
});

test("TLY-94 AC3: an error body carries the request id and nothing internal", async () => {
  const response = await fetch(`${base}/api/tenders/00000000-0000-0000-0000-000000000000`, {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 404);
  const body = await response.json() as { error: string; requestId?: string; stack?: string };
  assert.equal(body.requestId, response.headers.get(REQUEST_ID_HEADER));
  assert.equal(body.stack, undefined, "no stack trace reaches the caller");
  assert.ok(!JSON.stringify(body).includes("at "), "and no frame leaks through the message");
});

test("TLY-94 AC4: a password and a token never reach the log", async () => {
  const password = "correct-horse-battery";
  let issued = "";
  const lines = await captureLogs(async () => {
    const response = await fetch(`${base}/api/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    issued = ((await response.json()) as { token?: string }).token ?? "";
    await new Promise((resolve) => setTimeout(resolve, 20));
  });

  const output = lines.join("\n");
  assert.ok(!output.includes(password), "the submitted password must not appear anywhere in the log");
  assert.ok(issued.length > 0, "the login issued a token");
  assert.ok(!output.includes(issued), "and neither may the issued token");
});

test("TLY-94: redaction is by field name, so a field nobody thought about is still safe", () => {
  const redacted = redact({
    email: "someone@example.test",
    password: "hunter2",
    token: "eyJhbGciOi",
    nested: { apiKey: "sk-live-123", cvText: "a whole CV", keep: "visible" },
    answer: "the drafted response text",
  }) as Record<string, unknown>;

  assert.equal(redacted.email, "someone@example.test", "identifiers stay: they are what support searches on");
  assert.equal(redacted.password, "[redacted]");
  assert.equal(redacted.token, "[redacted]");
  assert.equal(redacted.answer, "[redacted]", "a drafted answer is the customer's work, not our telemetry");
  const nested = redacted.nested as Record<string, unknown>;
  assert.equal(nested.apiKey, "[redacted]");
  assert.equal(nested.cvText, "[redacted]");
  assert.equal(nested.keep, "visible");
});

test("TLY-94: a long string is truncated rather than dumped whole", () => {
  const redacted = redact({ note: "x".repeat(5000) }) as { note: string };
  assert.ok(redacted.note.length < 600, "a log line is not a place to store a document");
  assert.ok(redacted.note.endsWith("…"));
});

test("TLY-94: every line is valid JSON on one line", async () => {
  const lines = await captureLogs(async () => {
    log("info", { message: "a test line", nested: { value: 1 } });
    log("warn", { message: "a warning" });
    log("error", { message: "a failure" });
  });
  assert.equal(lines.length, 3);
  for (const line of lines) {
    assert.equal(line.includes("\n"), false, "one event, one line, or log tooling cannot split them");
    const parsed = JSON.parse(line);
    assert.ok(["info", "warn", "error"].includes(parsed.level));
    assert.ok(Date.parse(parsed.time) > 0);
  }
});

test("TLY-94 AC5: the discovery job emits the same shape", () => {
  const job = readFileSync(path.resolve(process.cwd(), "src/job.ts"), "utf8");
  assert.match(job, /import \{ log \} from "\.\/logging\.js"/, "the job uses the same logger, not console");
  assert.match(job, /job: "discovery"/);
  assert.match(job, /outcome:/);
  assert.match(job, /durationMs:/);
  assert.doesNotMatch(job, /console\.(log|error)\(/, "no second log format in a second place");
});
