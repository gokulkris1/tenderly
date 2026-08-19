#!/usr/bin/env node
/**
 * Opens the pull request for a story branch, with the story's acceptance criteria
 * as a tick-box checklist in the body — the section 9 working agreement, automated.
 *
 *   node scripts/github/open-pr.mjs                       # current branch
 *   node scripts/github/open-pr.mjs --branch TLY-20-foo --base main
 *   node scripts/github/open-pr.mjs --title "TLY-0: bootstrap" --no-jira
 *
 * The Jira key comes from the branch name. Title and body are built from the Jira
 * story so they cannot drift from the ticket. Idempotent: an existing open PR for
 * the branch is reported and updated rather than duplicated.
 *
 * Needs GITHUB_TOKEN (repo scope) and, unless --no-jira, the JIRA_* variables.
 */
import { execSync } from "node:child_process";

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => { const i = argv.indexOf(f); return i === -1 ? undefined : argv[i + 1]; };

const TOKEN = process.env.GITHUB_TOKEN;
const REPO = process.env.GITHUB_REPO ?? "gokulkris1/tenderly";
if (!TOKEN) { console.error("GITHUB_TOKEN is required."); process.exit(2); }

const branch = val("--branch") ?? execSync("git branch --show-current").toString().trim();
const base = val("--base") ?? "main";
const draft = has("--draft");
const noJira = has("--no-jira");
const key = (val("--key") ?? branch.match(/TLY-\d+/)?.[0]) ?? null;

async function gh(path, init = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let body; try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!res.ok) { const e = new Error(`${res.status} ${init.method ?? "GET"} ${path} — ${body.message ?? text.slice(0, 200)}`); e.status = res.status; e.body = body; throw e; }
  return body;
}

/** Flattens an ADF list item back to plain text for the checklist. */
const flatten = (node) => {
  if (node.text) return node.text;
  return (node.content ?? []).map(flatten).join("");
};

let title = val("--title");
let acLines = [];
let storyUrl = null;

if (key && !noJira) {
  const { getIssue, extractAcceptanceCriteria, SITE } = await import("../jira/client.mjs");
  try {
    const issue = await getIssue(key, "summary,description");
    title ??= `${key}: ${issue.fields.summary}`;
    storyUrl = `https://${SITE}/browse/${key}`;
    const list = extractAcceptanceCriteria(issue.fields.description);
    acLines = (list?.content ?? []).map((li) => flatten(li).trim());
  } catch (e) {
    console.warn(`! could not read ${key} from Jira (${e.message}) — falling back to a plain PR body`);
  }
}

// A branch with no matching Jira story (the bootstrap branch, a spike) still
// deserves a PR — fall back to its latest commit subject.
if (!title) {
  const subject = execSync(`git log -1 --format=%s ${branch}`).toString().trim();
  title = subject || `${branch}: changes`;
  console.warn(`! no Jira story for this branch — titling the PR from its latest commit`);
}

const bodyParts = [];
if (storyUrl) bodyParts.push(`Story: [${key}](${storyUrl})`);
if (acLines.length) {
  bodyParts.push("", "## Acceptance criteria", "", "Every box must be ticked before this merges.", "");
  for (const line of acLines) bodyParts.push(`- [ ] ${line}`);
}
bodyParts.push("", "---", "", "Merging moves the story to **In Test**, not Done. The linked Test ticket closes it once the e2e suite passes against staging.");
const body = bodyParts.join("\n");

// Idempotency: reuse an open PR for this head branch.
const owner = REPO.split("/")[0];
const existing = await gh(`/repos/${REPO}/pulls?head=${owner}:${branch}&state=open`);
let pr;
if (existing.length) {
  pr = existing[0];
  await gh(`/repos/${REPO}/pulls/${pr.number}`, { method: "PATCH", body: JSON.stringify({ title, body }) });
  console.log(`= PR #${pr.number} already open for ${branch} — title and body refreshed`);
} else {
  pr = await gh(`/repos/${REPO}/pulls`, { method: "POST", body: JSON.stringify({ title, head: branch, base, body, draft }) });
  console.log(`+ opened PR #${pr.number}: ${title}`);
}
console.log(`  ${pr.html_url}`);
if (acLines.length) console.log(`  ${acLines.length} acceptance criteria in the checklist`);

// The story is now proposed for merge.
if (key && !noJira) {
  const { transitionTo } = await import("../jira/client.mjs");
  try { await transitionTo(key, "In Review"); } catch (e) { console.warn(`! ${key}: ${e.message}`); }
}
