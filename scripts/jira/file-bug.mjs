#!/usr/bin/env node
/**
 * Files a Bug from the command line, for defects found outside the e2e run —
 * a CI flake, a review finding, a defect spotted while building something else.
 *
 * Idempotent by summary: re-running with the same --summary comments on the
 * existing open Bug instead of stacking duplicates.
 *
 *   node scripts/jira/file-bug.mjs --summary "..." --detail "..." [--blocks TLY-48]
 */
import { PROJECT, activeSprint, agile, comment, findBoard, jira, link } from "./client.mjs";

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
};

const summary = arg("summary");
const detail = arg("detail") ?? "";
const blocks = arg("blocks");
if (!summary) {
  console.error("usage: file-bug.mjs --summary \"...\" [--detail \"...\"] [--blocks TLY-48]");
  process.exit(2);
}

const paragraphs = detail.split(/\n{2,}/).filter(Boolean).map((text) => ({
  type: "paragraph", content: [{ type: "text", text }],
}));

// A quoted summary would break the JQL, so match on the distinctive words.
const needle = summary.replace(/["\\]/g, " ");
const found = await jira(`/search/jql?jql=${encodeURIComponent(
  `project = ${PROJECT} AND issuetype = Bug AND statusCategory != Done AND summary ~ "${needle}"`,
)}&fields=summary&maxResults=5`);
const existing = (found.issues ?? []).find((issue) => issue.fields.summary === summary);
if (existing) {
  console.log(`= ${existing.key} already open for this defect — commenting instead of filing another`);
  await comment(existing.key, detail || "Seen again.");
  process.exit(0);
}

const bug = await jira("/issue", {
  method: "POST",
  body: JSON.stringify({
    fields: {
      project: { key: PROJECT },
      issuetype: { name: "Bug" },
      summary,
      description: { type: "doc", version: 1, content: paragraphs.length ? paragraphs : [{ type: "paragraph", content: [{ type: "text", text: summary }] }] },
      labels: ["automated"],
    },
  }),
});
console.log(`+ filed ${bug.key}: ${summary}`);

if (blocks) {
  await link(bug.key, blocks, "Blocks");
  console.log(`  linked ${bug.key} blocks ${blocks}`);
}

// A bug that blocks the sprint belongs in the sprint.
const board = await findBoard();
const sprint = board ? await activeSprint(board.id) : null;
if (sprint) {
  await agile(`/sprint/${sprint.id}/issue`, { method: "POST", body: JSON.stringify({ issues: [bug.key] }) });
  console.log(`  added to sprint ${sprint.name}`);
}
