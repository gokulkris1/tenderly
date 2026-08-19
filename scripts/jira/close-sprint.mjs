#!/usr/bin/env node
/**
 * Closes the active sprint once every issue in it is Done, and reports what is
 * still open when it is not. Run on a schedule or by hand.
 *
 *   node scripts/jira/close-sprint.mjs [--force] [--dry-run]
 */
import { agile, findBoard, activeSprint, PROJECT } from "./client.mjs";

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);

const board = await findBoard();
if (!board) { console.error(`No board for ${PROJECT}`); process.exit(3); }
const sprint = await activeSprint(board.id);
if (!sprint) { console.log("No active sprint."); process.exit(0); }

const { issues } = await agile(`/sprint/${sprint.id}/issue?fields=summary,status,issuetype&maxResults=200`);
const open = issues.filter((i) => i.fields.status.statusCategory.key !== "done");

console.log(`Sprint "${sprint.name}" — ${issues.length} issues, ${open.length} not Done`);
for (const i of open) console.log(`  ${i.key.padEnd(9)} ${i.fields.status.name.padEnd(12)} ${i.fields.summary}`);

if (open.length && !has("--force")) { console.log("\nSprint stays open."); process.exit(0); }
if (has("--dry-run")) { console.log("\nDry run — not closing."); process.exit(0); }

await agile(`/sprint/${sprint.id}`, { method: "POST", body: JSON.stringify({ state: "closed" }) });
console.log(`\nClosed sprint "${sprint.name}".`);
