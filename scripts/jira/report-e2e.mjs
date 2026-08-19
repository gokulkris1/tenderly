#!/usr/bin/env node
/**
 * Reports a CI test-tier result back into Jira.
 *
 *   pass -> every Test ticket verifying the named Stories moves to Done, and a
 *           Story whose Tests are all Done moves to Done with them.
 *   fail -> a Bug is filed against each Story, linked and dropped into the active
 *           sprint, and the Test stays open so the Story cannot reach Done.
 *
 *   node scripts/jira/report-e2e.mjs --keys TLY-19,TLY-20 --result pass --tier e2e --run-url https://...
 *
 * Idempotent: re-running a failed report does not stack up duplicate Bugs.
 */
import { jira, getIssue, transitionTo, comment, link, parseKeys, findBoard, activeSprint, agile, PROJECT } from "./client.mjs";

const argv = process.argv.slice(2);
const val = (f) => { const i = argv.indexOf(f); return i === -1 ? undefined : argv[i + 1]; };

const keys = parseKeys(val("--keys") ?? "");
const result = val("--result");
const tier = val("--tier") ?? "e2e";
const runUrl = val("--run-url") ?? "";

if (!keys.length) { console.log("No TLY keys supplied — nothing to report."); process.exit(0); }
if (!["pass", "fail", "skipped"].includes(result)) { console.error("--result must be pass, fail or skipped"); process.exit(2); }

console.log(`Reporting ${tier} ${result} for ${keys.join(", ")}`);

/** Test tickets linked to a Story through the Verifies link type. */
async function testsFor(storyKey) {
  const issue = await getIssue(storyKey, "summary,issuelinks,issuetype");
  const linked = (issue.fields.issuelinks ?? [])
    .map((l) => l.inwardIssue ?? l.outwardIssue)
    .filter(Boolean);
  const tests = [];
  for (const l of linked) {
    const full = await getIssue(l.key, "summary,status,issuetype");
    if (full.fields.issuetype.name === "Test") tests.push(full);
  }
  return { issue, tests };
}

async function openBugFor(storyKey) {
  const jql = `project = ${PROJECT} AND issuetype = Bug AND statusCategory != Done AND text ~ "${storyKey}"`;
  const res = await jira(`/search/jql?jql=${encodeURIComponent(jql)}&fields=summary&maxResults=20`);
  return (res.issues ?? [])[0] ?? null;
}

let exitCode = 0;

for (const key of keys) {
  try {
    const { issue, tests } = await testsFor(key);
    if (issue.fields.issuetype.name !== "Story") { console.log(`  - ${key} is a ${issue.fields.issuetype.name}, skipping`); continue; }

    // The suite did not run. Say so on the Story and leave it In Test — an
    // unrun suite is not evidence of anything.
    if (result === "skipped") {
      console.log(`  ~ ${key}: ${tier} did not run — leaving it In Test`);
      await comment(key, `${tier} did not run for this merge, so this story is unverified and stays In Test. CI run: ${runUrl}`);
      continue;
    }

    if (result === "pass") {
      for (const t of tests) await transitionTo(t.key, "Done");
      if (tests.length) {
        await transitionTo(key, "Done");
      } else {
        console.warn(`  ! ${key} has no linked Test ticket — leaving it In Test rather than closing it unverified`);
        await comment(key, `${tier} passed (${runUrl}) but no Test ticket is linked to this Story, so it has not been closed automatically.`);
      }
      continue;
    }

    // fail
    const existing = await openBugFor(key);
    if (existing) {
      console.log(`  = ${key} already has open Bug ${existing.key} — adding a comment instead of filing another`);
      await comment(existing.key, `${tier} failed again: ${runUrl}`);
      exitCode = 1;
      continue;
    }

    const bug = await jira("/issue", {
      method: "POST",
      body: JSON.stringify({
        fields: {
          project: { key: PROJECT },
          issuetype: { name: "Bug" },
          summary: `${tier} failure on ${key}: ${issue.fields.summary}`.slice(0, 250),
          labels: ["ci-failure", `tier-${tier}`],
          description: {
            type: "doc", version: 1,
            content: [
              { type: "paragraph", content: [{ type: "text", text: `The ${tier} suite failed for ${key} — ${issue.fields.summary}.` }] },
              { type: "paragraph", content: [{ type: "text", text: `CI run: ${runUrl}` }] },
              { type: "paragraph", content: [{ type: "text", text: `Fix on a branch named for this Bug, then dispatch the e2e-rerun workflow with issueKeys=${key} to unblock the Test ticket.` }] },
            ],
          },
        },
      }),
    });
    console.log(`  + filed ${bug.key} against ${key}`);
    await link(key, bug.key, "Blocks");

    const board = await findBoard();
    const sprint = board ? await activeSprint(board.id) : null;
    if (sprint) {
      await agile(`/sprint/${sprint.id}/issue`, { method: "POST", body: JSON.stringify({ issues: [bug.key] }) });
      console.log(`    added ${bug.key} to sprint "${sprint.name}"`);
    }
    for (const t of tests) await comment(t.key, `${tier} failed — ${bug.key} filed. Test stays open until the fix passes. ${runUrl}`);
    exitCode = 1;
  } catch (e) {
    console.error(`  x ${key}: ${e.message}`);
    exitCode = 1;
  }
}

process.exit(exitCode);
