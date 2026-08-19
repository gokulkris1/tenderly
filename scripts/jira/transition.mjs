#!/usr/bin/env node
/**
 * Moves every Jira issue mentioned in a piece of text to a target status.
 * Used by .github/workflows/jira-sync.yml for the branch/PR lifecycle.
 *
 *   node scripts/jira/transition.mjs --from-text "TLY-19-commit-source" --to "In Progress"
 *   node scripts/jira/transition.mjs --keys TLY-19,TLY-20 --to "In Test"
 *
 * No keys in the text is a no-op, not a failure: not every branch is story work.
 */
import { parseKeys, transitionTo } from "./client.mjs";

const argv = process.argv.slice(2);
const val = (f) => { const i = argv.indexOf(f); return i === -1 ? undefined : argv[i + 1]; };

const to = val("--to");
if (!to) { console.error("--to <status> is required"); process.exit(2); }

const keys = val("--keys") ? parseKeys(val("--keys")) : parseKeys(val("--from-text") ?? "");
if (!keys.length) { console.log("No TLY keys found — nothing to transition."); process.exit(0); }

console.log(`Transitioning ${keys.join(", ")} -> ${to}`);
let failed = 0;
for (const key of keys) {
  try { await transitionTo(key, to); }
  catch (e) { failed++; console.error(`  x ${key}: ${e.message}`); }
}
// A missing or renamed issue should be visible but must not break the developer's PR.
if (failed) console.warn(`${failed} issue(s) could not be transitioned.`);
