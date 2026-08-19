#!/usr/bin/env node
/**
 * Creates a sprint, fills it, gives every Story a linked Test ticket carrying its
 * acceptance criteria verbatim as the manual test script, and starts it.
 *
 *   node scripts/jira/start-sprint.mjs --name "Sprint 1" --sprint1 --days 14 [--dry-run]
 *   node scripts/jira/start-sprint.mjs --name "Sprint 2" --keys TLY-30,TLY-31 --days 14
 *
 * Idempotent: a Story that already has a linked Test ticket does not get a second one,
 * and an existing sprint of the same name is reused rather than duplicated.
 */
import { readFileSync } from "node:fs";
import { jira, agile, getIssue, extractAcceptanceCriteria, findBoard, parseKeys, PROJECT } from "./client.mjs";

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => { const i = argv.indexOf(f); return i === -1 ? undefined : argv[i + 1]; };

const DRY = has("--dry-run");
const name = val("--name");
const days = Number(val("--days") ?? 14);
if (!name) { console.error("--name <sprint name> is required"); process.exit(2); }
// Jira rejects sprint names of 30 characters or more — fail here, not mid-run.
if (name.length >= 30) { console.error(`--name must be under 30 characters (got ${name.length}: "${name}")`); process.exit(2); }

// ---- which issues go in the sprint
let keys = parseKeys(val("--keys") ?? "");
if (has("--sprint1")) {
  const backlog = JSON.parse(readFileSync("backlog/backlog.json", "utf8"));
  const csv = readFileSync("backlog/created-issues.csv", "utf8").split("\n").slice(1).filter(Boolean);
  const bySummary = new Map(csv.map((line) => {
    const cols = line.match(/"((?:[^"]|"")*)"/g).map((c) => c.slice(1, -1).replaceAll('""', '"'));
    return [cols[2], cols[0]];
  }));
  const wanted = backlog.stories.filter((s) => s.sprint1);
  keys = wanted.map((s) => bySummary.get(s.summary)).filter(Boolean);
  const missing = wanted.filter((s) => !bySummary.get(s.summary));
  if (missing.length) console.warn(`! ${missing.length} sprint-1 stories have no Jira key yet: ${missing.map((s) => s.id).join(", ")}`);
}
if (!keys.length) { console.error("No issues selected — pass --keys or --sprint1"); process.exit(2); }

console.log(`Sprint "${name}" — ${keys.length} stories, ${days} days${DRY ? "  [DRY RUN]" : ""}`);
console.log(`  ${keys.join(", ")}\n`);

const board = await findBoard();
if (!board) { console.error(`No board found for project ${PROJECT}. Enable the Backlog/Sprints feature on the project first.`); process.exit(3); }
console.log(`Board: ${board.id} ${board.name} (${board.type})`);
// Team-managed boards report type "simple" and still support sprints — probe instead of guessing.
const sprintProbe = await agile(`/board/${board.id}/sprint?maxResults=1`).catch(() => null);
if (!sprintProbe) { console.error(`Board ${board.id} does not expose sprints. Enable the Backlog/Sprints feature on the project.`); process.exit(3); }

// ---- sprint (reuse one of the same name if it exists)
const existingSprints = await agile(`/board/${board.id}/sprint?state=future,active`).catch(() => ({ values: [] }));
let sprint = has("--use-active")
  ? (existingSprints.values ?? []).find((s) => s.state === "active")
  : (existingSprints.values ?? []).find((s) => s.name === name);

// Reusing the active sprint but under the name we were asked for.
if (sprint && has("--use-active") && sprint.name !== name && !DRY) {
  await agile(`/sprint/${sprint.id}`, { method: "POST", body: JSON.stringify({ name }) });
  console.log(`Renamed active sprint ${sprint.id} "${sprint.name}" -> "${name}"`);
  sprint.name = name;
}

const startDate = new Date();
const endDate = new Date(startDate.getTime() + days * 86400000);

if (sprint) {
  console.log(`Reusing existing sprint ${sprint.id} "${sprint.name}" (${sprint.state})`);
} else if (DRY) {
  console.log(`Would create sprint "${name}" on board ${board.id}`);
  sprint = { id: "(dry-run)", state: "future" };
} else {
  sprint = await agile("/sprint", {
    method: "POST",
    body: JSON.stringify({ name, originBoardId: board.id, startDate: startDate.toISOString(), endDate: endDate.toISOString(), goal: "See the sprint stories' acceptance criteria." }),
  });
  console.log(`Created sprint ${sprint.id} "${sprint.name}"`);
}

// ---- a Test ticket per Story, carrying the AC as its manual script
console.log("\nTest tickets:");
const testKeys = [];
for (const key of keys) {
  const story = await getIssue(key, "summary,description,issuelinks,issuetype,labels");
  if (story.fields.issuetype.name !== "Story") { console.log(`  - ${key} is a ${story.fields.issuetype.name}, skipped`); continue; }

  const linked = (story.fields.issuelinks ?? []).map((l) => l.inwardIssue ?? l.outwardIssue).filter(Boolean);
  let already = null;
  for (const l of linked) {
    const full = await getIssue(l.key, "issuetype,summary");
    if (full.fields.issuetype.name === "Test") { already = full; break; }
  }
  if (already) { console.log(`  = ${key} already verified by ${already.key}`); testKeys.push(already.key); continue; }

  const ac = extractAcceptanceCriteria(story.fields.description);
  if (!ac) console.warn(`  ! ${key} has no "Acceptance Criteria" section — Test ticket will carry no script`);

  const content = [
    { type: "paragraph", content: [{ type: "text", text: `Manual test script for ${key} — ${story.fields.summary}.` }] },
    { type: "paragraph", content: [{ type: "text", text: "Execute each scenario verbatim against staging. Where automated coverage exists, the CI e2e run closes this ticket instead." }] },
    { type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: "Acceptance Criteria" }] },
  ];
  if (ac) content.push(ac);

  if (DRY) { console.log(`  + would create Test for ${key} (${ac?.content?.length ?? 0} scenarios)`); continue; }

  const test = await jira("/issue", {
    method: "POST",
    body: JSON.stringify({
      fields: {
        project: { key: PROJECT },
        issuetype: { name: "Test" },
        summary: `Test: ${story.fields.summary}`.slice(0, 250),
        labels: ["test-ticket", ...(story.fields.labels ?? []).filter((l) => l.startsWith("area:"))],
        description: { type: "doc", version: 1, content },
      },
    }),
  });
  // Test verifies Story; Story is verified by Test.
  await jira("/issueLink", {
    method: "POST",
    body: JSON.stringify({ type: { name: "Verifies" }, outwardIssue: { key: test.key }, inwardIssue: { key } }),
  });
  console.log(`  + ${test.key} verifies ${key} (${ac?.content?.length ?? 0} scenarios)`);
  testKeys.push(test.key);
}

// ---- fill and start
if (DRY) { console.log("\nDry run — sprint not filled or started."); process.exit(0); }

const all = [...keys, ...testKeys];
await agile(`/sprint/${sprint.id}/issue`, { method: "POST", body: JSON.stringify({ issues: all }) });
console.log(`\nAdded ${all.length} issues to sprint ${sprint.id}`);

if (sprint.state !== "active") {
  await agile(`/sprint/${sprint.id}`, {
    method: "POST",
    body: JSON.stringify({ state: "active", startDate: startDate.toISOString(), endDate: endDate.toISOString() }),
  });
  console.log(`Started sprint "${name}" — ends ${endDate.toISOString().slice(0, 10)}`);
} else {
  console.log("Sprint already active.");
}
