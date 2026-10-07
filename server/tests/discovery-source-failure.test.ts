import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { reasonOf } from "../src/jobs.js";

/**
 * TLY-213. A source that could not be read looked exactly like a quiet morning.
 *
 * runDiscoveryJob settles both sources with Promise.allSettled and then took
 * `status === "fulfilled" ? value : []`, discarding the rejection reason. So the
 * run recorded `parsed: 0`, raised an alarm saying the count was below the
 * floor, and left no trace of what had actually gone wrong.
 *
 * This is not hypothetical. On 2026-10-05 the 04:00 run read nothing from
 * eTenders, finished in 8.8 seconds where a normal run takes minutes, exited 1,
 * and logged no cause at all.
 */

test("TLY-213: a rejection reason survives as something a person can act on", () => {
  assert.equal(reasonOf(new Error("fetch failed")), "fetch failed");
  assert.equal(reasonOf(new TypeError()), "TypeError", "an error with no message still names itself");
  assert.equal(reasonOf("HTTP 503 from www.etenders.gov.ie"), "HTTP 503 from www.etenders.gov.ie");

  // The one answer that must never be produced is a blank, because a blank
  // reason is what the old code effectively recorded.
  assert.equal(reasonOf(undefined), "no reason given");
  assert.equal(reasonOf(null), "no reason given");
  assert.equal(reasonOf(""), "no reason given");
  assert.equal(reasonOf("   "), "no reason given");
});

test("TLY-213: the run records the cause against the source that failed", () => {
  const jobs = readFileSync(path.resolve(process.cwd(), "src/jobs.ts"), "utf8");

  assert.match(jobs, /etenders\.status === "rejected"/, "an eTenders rejection must be noticed");
  assert.match(jobs, /ted\.status === "rejected"/, "a TED rejection must be noticed");
  assert.match(jobs, /the source could not be read/,
    "the alarm must say the fetch failed, not merely that the count was low");
  assert.match(jobs, /event: "source-unreadable"/, "and it must be greppable in the logs");

  // Persisted with the run rather than only logged, so it outlives log
  // retention and reaches /health.
  const block = jobs.slice(jobs.indexOf("const sourceAlarms"), jobs.indexOf("const opportunities"));
  assert.match(block, /alarms: sourceAlarms/,
    "the failure must be stored on the ingestion run, not just written to stdout");
});
