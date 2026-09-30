import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { auditRetainedLongest, cutoffFor, retentionPolicy, summarise, SYSTEM_ORGANISATION_ID } from "../src/retention.js";

const NOW = new Date(Date.UTC(2026, 7, 24));

test("TLY-98 AC1 and AC2: the cut-off is the period before now, per class", () => {
  const policy = retentionPolicy();
  const tenders = policy.find((entry) => entry.id === "closed-tenders")!;
  assert.equal(tenders.months, 24);

  const cutoff = cutoffFor(tenders, new Date(NOW));
  assert.equal(cutoff.toISOString().slice(0, 10), "2024-08-24");

  // A tender last touched 25 months ago is past the cut-off; one at 12 is not.
  const twentyFive = new Date(Date.UTC(2024, 6, 24));
  const twelve = new Date(Date.UTC(2025, 7, 24));
  assert.ok(twentyFive < cutoff, "25 months old is removable");
  assert.ok(twelve > cutoff, "12 months old is untouched");
});

test("TLY-98: the audit log is retained longest, and that is checkable", () => {
  assert.equal(auditRetainedLongest(), true,
    "the record of what happened to the data has to outlive the data");

  const broken = [
    { id: "audit-log", label: "Audit log", months: 6, measuredFrom: "the recorded action" },
    { id: "closed-tenders", label: "Closed tenders", months: 24, measuredFrom: "the deadline" },
  ];
  assert.equal(auditRetainedLongest(broken), false, "and a policy that inverts it is detectable");
});

test("TLY-98: every period is overridable, so a stricter obligation is not blocked", () => {
  const before = retentionPolicy().find((entry) => entry.id === "closed-tenders")!.months;
  process.env.RETENTION_CLOSED_TENDERS_MONTHS = "6";
  try {
    assert.equal(retentionPolicy().find((entry) => entry.id === "closed-tenders")!.months, 6);
  } finally {
    delete process.env.RETENTION_CLOSED_TENDERS_MONTHS;
  }
  assert.equal(retentionPolicy().find((entry) => entry.id === "closed-tenders")!.months, before);
});

test("TLY-98: a nonsensical override falls back rather than deleting everything", () => {
  for (const bad of ["0", "-3", "not a number", ""]) {
    process.env.RETENTION_AUDIT_MONTHS = bad;
    try {
      assert.equal(retentionPolicy().find((entry) => entry.id === "audit-log")!.months, 84,
        `"${bad}" must not become a retention period`);
    } finally {
      delete process.env.RETENTION_AUDIT_MONTHS;
    }
  }
});

test("TLY-98 AC3: the summary reports every class, including the zeroes", () => {
  const summary = summarise({
    ranAt: NOW.toISOString(), dryRun: false, removedTenders: [], retained: [],
    removed: [
      { id: "closed-tenders", label: "Closed tenders", count: 3, cutoff: NOW.toISOString() },
      { id: "usage-events", label: "Usage", count: 0, cutoff: NOW.toISOString() },
    ],
  });
  assert.match(summary, /closed-tenders=3/);
  assert.match(summary, /usage-events=0/, "a class that removed nothing is still reported");
  assert.match(summary, /^removed /);

  const dry = summarise({
    ranAt: NOW.toISOString(), dryRun: true, removedTenders: [], retained: [],
    removed: [{ id: "closed-tenders", label: "Closed tenders", count: 3, cutoff: NOW.toISOString() }],
  });
  assert.match(dry, /^would remove /, "a dry run never claims to have removed anything");
});

test("TLY-98 AC5: a dry run exists and names what it would remove", () => {
  const job = readFileSync(path.resolve(process.cwd(), "src/retention-job.ts"), "utf8");
  assert.match(job, /--dry-run/);
  assert.match(job, /removedTenders/, "the job names the tenders rather than only counting them");
  assert.match(job, /if \(!dryRun\)/, "and a dry run writes no audit entry either");

  const db = readFileSync(path.resolve(process.cwd(), "src/db.ts"), "utf8");
  const fn = db.slice(db.indexOf("export async function applyRetention"), db.indexOf("export async function addEvidence"));
  assert.match(fn, /dryRun \? "ROLLBACK" : "COMMIT"/,
    "a dry run counts inside a transaction it rolls back, so it cannot delete by accident");
});

test("TLY-98: a submitted tender is never removed by retention", () => {
  const db = readFileSync(path.resolve(process.cwd(), "src/db.ts"), "utf8");
  const fn = db.slice(db.indexOf("export async function applyRetention"), db.indexOf("export async function addEvidence"));
  assert.match(fn, /status <> 'SUBMITTED'/,
    "what a company sent to a buyer is its own record of its submission");
});

test("TLY-98 AC4: the published page names every sub-processor with purpose and location", () => {
  const page = readFileSync(path.resolve(process.cwd(), "../docs/DATA_PROCESSING.md"), "utf8");

  for (const processor of ["Anthropic", "Neon", "Render", "Netlify", "Stripe", "Sentry"]) {
    assert.ok(page.includes(processor), `${processor} is not listed`);
  }
  assert.match(page, /\| Anthropic \|.*\| United States \| In use \|/, "with its location and status");
  assert.match(page, /Not yet in use/, "and one that is not in use says so rather than pretending");
  assert.match(page, /does not use them to train/);
  assert.match(page, /Last reviewed:/);
});

test("TLY-98: the published retention table matches the code", () => {
  const page = readFileSync(path.resolve(process.cwd(), "../docs/DATA_PROCESSING.md"), "utf8");
  for (const entry of retentionPolicy()) {
    const variable = {
      "closed-tenders": "RETENTION_CLOSED_TENDERS_MONTHS",
      "usage-events": "RETENTION_USAGE_MONTHS",
      "ingestion-runs": "RETENTION_INGESTION_MONTHS",
      notifications: "RETENTION_NOTIFICATIONS_MONTHS",
      "audit-log": "RETENTION_AUDIT_MONTHS",
    }[entry.id]!;
    assert.ok(page.includes(variable), `${variable} is not documented`);
    assert.ok(page.includes(`${entry.months} months`), `the ${entry.id} period is not on the page`);
  }
});

test("TLY-245: the summary reports tenders kept back for review", () => {
  const summary = summarise({
    ranAt: NOW.toISOString(), dryRun: false, removedTenders: [],
    removed: [{ id: "closed-tenders", label: "Closed tenders", count: 0, cutoff: NOW.toISOString() }],
    retained: [
      { id: "t1", title: "Framework bid", reason: "has an answer provenance ledger" },
      { id: "t2", title: "Unreadable deadline", reason: "deadline could not be read, so it cannot be shown to be past" },
    ],
  });
  assert.match(summary, /retained 2 for review/,
    "a run that keeps rows back is asking a person to decide, and must say so");
});

test("TLY-245: the retention job fails the run when it cannot record a deletion", () => {
  const job = readFileSync(path.resolve(process.cwd(), "src/retention-job.ts"), "utf8");
  // The audit write used to be `.catch()`ed into a log line, so the job could
  // delete customer data, leave no record that it had, and still exit 0.
  assert.doesNotMatch(job, /recordAudit\([\s\S]*?\)\.catch\(/,
    "a failed audit write must not be swallowed");
  assert.match(job, /process\.exitCode = 1/, "a failed audit write must fail the run");
  assert.match(job, /SYSTEM_ORGANISATION_ID/,
    "the reserved organisation is seeded by migration 028 and must be referenced by name");
  assert.match(job, /tenders: result\.removedTenders/,
    "the audit entry must name the tenders, not count them — the rows are gone afterwards");
});

test("TLY-245: migration 028 seeds the organisation the job audits under", () => {
  const sql = readFileSync(path.resolve(process.cwd(), "migrations/028_system_organisation.sql"), "utf8");
  assert.match(sql, /INSERT INTO organisations/);
  assert.match(sql, /00000000-0000-0000-0000-000000000000/);
  assert.match(sql, /ON CONFLICT \(id\) DO NOTHING/, "the migration must be safe to re-run");
  assert.equal(SYSTEM_ORGANISATION_ID, "00000000-0000-0000-0000-000000000000");
});

test("TLY-245: retention never cascades away a provenance ledger or a bid decision", () => {
  // Asserted against the source, as TLY-98's submitted-tender test above does,
  // because applyRetention needs a real Postgres to exercise. The behavioural
  // test belongs in the integration suite that does not exist yet — see
  // TLY-287 for the missing test:integration script.
  const db = readFileSync(path.resolve(process.cwd(), "src/db.ts"), "utf8");
  const fn = db.slice(db.indexOf("export async function applyRetention"), db.indexOf("export async function addEvidence"));

  assert.match(fn, /answer_provenance/,
    "answers, answer_versions and answer_provenance cascade from tenders, and migration 004 leaves DELETE alone by design");
  assert.match(fn, /bid_decisions/, "a recorded judgement is evidence somebody made it");
  assert.match(fn, /has_provenance/);
  assert.match(fn, /retained\.push/, "a tender kept back must be reported, not silently skipped");

  // The policy states it is measured from the submission deadline, and the
  // query measured updated_at — so a live framework bid nobody had opened for
  // two years was deleted while a long-closed tender touched yesterday was kept.
  assert.match(fn, /parseDeadline/, "the cutoff must be compared against the deadline the policy names");
  assert.match(fn, /deadline could not be read/,
    "an unreadable deadline must never be treated as long past");
});
