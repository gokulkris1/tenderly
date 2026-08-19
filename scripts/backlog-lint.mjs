#!/usr/bin/env node
// Validates backlog/backlog.json against the rules in the master build prompt (section 4)
// and regenerates backlog/backlog.csv as the human-readable mirror.
// Usage: node scripts/backlog-lint.mjs [--no-csv]

import { readFileSync, writeFileSync } from "node:fs";

const SRC = "backlog/backlog.json";
const CSV = "backlog/backlog.csv";

const AREAS = ["area:web", "area:api", "area:ai", "area:infra", "area:data"];
const PRIORITIES = ["Highest", "High", "Medium", "Low"];
const POINTS = [1, 2, 3, 5];
const TYPES = ["Story", "Spike"];
// Section 4: every scenario must be executable by a human with no access to the code.
const BANNED = ["works", "correctly", "properly", "as expected", "handles"];

const errors = [];
const warnings = [];
const fail = (where, msg) => errors.push(`${where}: ${msg}`);
const warn = (where, msg) => warnings.push(`${where}: ${msg}`);

const backlog = JSON.parse(readFileSync(SRC, "utf8"));
const { epics, stories } = backlog;
const slugs = new Set(epics.map((e) => e.slug));
const ids = new Set(stories.map((s) => s.id));

if (epics.length !== 13) fail("epics", `expected 13 epics, found ${epics.length}`);

for (const epic of epics) {
  const at = `epic ${epic.slug}`;
  if (!epic.summary || !epic.description) fail(at, "summary and description are required");
  if (!epic.description?.includes("**Context**") || !epic.description?.includes("**Notes**"))
    fail(at, "description needs **Context** and **Notes** sections");
  if (!PRIORITIES.includes(epic.priority)) fail(at, `priority ${epic.priority} is not valid`);
}

const seenSummaries = new Map();
for (const s of stories) {
  const at = `${s.id}`;
  if (!s.id) fail("story", `missing id: ${s.summary}`);
  if (seenSummaries.has(s.summary)) fail(at, `duplicate summary, also on ${seenSummaries.get(s.summary)}`);
  seenSummaries.set(s.summary, s.id);

  if (!TYPES.includes(s.type)) fail(at, `type ${s.type} is not Story or Spike`);
  if (!slugs.has(s.epic)) fail(at, `epic slug ${s.epic} does not exist`);
  if (!PRIORITIES.includes(s.priority)) fail(at, `priority ${s.priority} is not valid`);
  if (!POINTS.includes(s.points)) fail(at, `points ${s.points} is not 1, 2, 3 or 5`);
  if (typeof s.sprint1 !== "boolean") fail(at, "sprint1 must be a boolean");

  // labels: epic slug plus exactly one area label
  const areas = (s.labels ?? []).filter((l) => AREAS.includes(l));
  if (!s.labels?.includes(s.epic)) fail(at, "labels must include the epic slug");
  if (areas.length !== 1) fail(at, `labels must carry exactly one area:* label, found ${areas.length}`);

  // description: Context + Notes, and never a restatement of the AC
  if (!s.description?.includes("**Context**") || !s.description?.includes("**Notes**"))
    fail(at, "description needs **Context** and **Notes** sections");
  if (/\bGiven\b.*\bWhen\b.*\bThen\b/s.test(s.description ?? ""))
    fail(at, "description restates acceptance criteria — AC is a separate structured field");

  // dependencies must resolve
  for (const dep of s.dependsOn ?? []) if (!ids.has(dep)) fail(at, `dependsOn ${dep} does not exist`);

  // acceptance criteria contract
  const ac = s.acceptanceCriteria ?? [];
  if (ac.length < 3 || ac.length > 7) fail(at, `${ac.length} scenarios — must be 3 to 7`);
  ac.forEach((c, i) => {
    const where = `${at} ${c.id ?? "AC?"}`;
    if (c.id !== `AC${i + 1}`) fail(where, `id should be AC${i + 1}`);
    const t = c.text ?? "";
    if (s.type === "Story") {
      if (!/\bGiven\b/.test(t) || !/\bWhen\b/.test(t) || !/\bThen\b/.test(t))
        fail(where, "must be phrased Given … When … Then …");
    }
    for (const w of BANNED) {
      const re = new RegExp(`\\b${w.replace(" ", "\\s+")}\\b`, "i");
      if (re.test(t)) fail(where, `banned vague wording "${w}"`);
    }
    if (t.length < 80) warn(where, "very short — check it names screen/endpoint, action and observable result");
  });

  // a story with only happy paths is under-specified
  if (s.type === "Story" && ac.length && !ac.some((c) => /\b(not|no |non-zero|refus\w*|disabl\w*|absent|empty|fail\w*|error|mismatch|403|404|409|429|401|400|unchanged|expired|invalid)\b/i.test(c.text)))
    warn(at, "no obvious negative or edge scenario");
}

const sprint1 = stories.filter((s) => s.sprint1);
if (sprint1.length < 8 || sprint1.length > 10)
  fail("sprint1", `${sprint1.length} stories marked sprint1 — must be 8 to 10`);
for (const s of sprint1)
  for (const dep of s.dependsOn ?? [])
    if (!stories.find((x) => x.id === dep)?.sprint1)
      warn(`${s.id}`, `sprint1 story depends on ${dep}, which is not in sprint 1`);

// ---- CSV mirror -------------------------------------------------------------
if (!process.argv.includes("--no-csv")) {
  const q = (v) => `"${String(v ?? "").replaceAll('"', '""')}"`;
  const rows = [
    ["id", "type", "epic", "summary", "priority", "points", "sprint1", "labels", "dependsOn", "acCount", "acceptanceCriteria", "description"],
    ...stories.map((s) => [
      s.id, s.type, s.epic, s.summary, s.priority, s.points, s.sprint1 ? "yes" : "no",
      (s.labels ?? []).join(" "), (s.dependsOn ?? []).join(" "), (s.acceptanceCriteria ?? []).length,
      (s.acceptanceCriteria ?? []).map((c) => `${c.id} — ${c.text}`).join("\n"),
      s.description,
    ]),
  ];
  writeFileSync(CSV, rows.map((r) => r.map(q).join(",")).join("\n") + "\n");
}

// ---- report -----------------------------------------------------------------
const byEpic = new Map(epics.map((e) => [e.slug, []]));
for (const s of stories) byEpic.get(s.epic).push(s);
console.log(`Epics: ${epics.length}   Stories: ${stories.length}   Spikes: ${stories.filter((s) => s.type === "Spike").length}   Points: ${stories.reduce((n, s) => n + s.points, 0)}`);
for (const [slug, list] of byEpic)
  console.log(`  ${slug.padEnd(24)} ${String(list.length).padStart(2)} items  ${String(list.reduce((n, s) => n + s.points, 0)).padStart(3)} pts  sprint1: ${list.filter((s) => s.sprint1).length}`);
console.log(`\nSprint 1 (${sprint1.length}): ${sprint1.reduce((n, s) => n + s.points, 0)} points`);
for (const s of sprint1) console.log(`  ${s.id.padEnd(7)} ${String(s.points).padStart(2)}pts  ${s.summary}`);
if (warnings.length) console.log(`\nWarnings (${warnings.length}):\n` + warnings.map((w) => "  " + w).join("\n"));
if (errors.length) { console.error(`\nFAILED — ${errors.length} error(s):\n` + errors.map((e) => "  " + e).join("\n")); process.exit(1); }
console.log("\nBacklog valid.");
