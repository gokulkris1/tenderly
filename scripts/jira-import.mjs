#!/usr/bin/env node
/**
 * Imports backlog/backlog.json into Jira Cloud (project TLY).
 *
 * Master build prompt section 5:
 *  - Jira Cloud REST v3; descriptions are Atlassian Document Format, not markdown.
 *  - Epics first, map slug -> key, then Stories in batches with `parent` set to the epic key.
 *  - Acceptance criteria render under a heading reading exactly "Acceptance Criteria".
 *    That heading text is load-bearing: sprint-start automation copies everything under it
 *    into the auto-created Test ticket as its manual test script. Never vary the wording.
 *  - Idempotent: --dry-run, and a JQL check for an existing open issue with an identical
 *    summary before creating anything.
 *  - Writes backlog/created-issues.csv (key, type, summary, epic).
 *
 * Never creates Test or Bug issues — Jira automation owns those.
 *
 * Env: JIRA_SITE (default ingenietech.atlassian.net), JIRA_EMAIL, JIRA_API_TOKEN, JIRA_PROJECT (default TLY)
 * Usage:
 *   node scripts/jira-import.mjs --dry-run          # render and report, no network writes
 *   node scripts/jira-import.mjs --preflight        # check credentials, project, fields
 *   node scripts/jira-import.mjs                    # create for real
 *   node scripts/jira-import.mjs --only E1-01,E8-01 # subset
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const ACCEPTANCE_HEADING = "Acceptance Criteria"; // load-bearing — see header
const BOOTSTRAP_LABEL = "tly-bootstrap";
const BATCH = 50;
const DESCRIPTION_LIMIT = 32000;

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => { const i = argv.indexOf(f); return i === -1 ? undefined : argv[i + 1]; };

const DRY = has("--dry-run");
const PREFLIGHT = has("--preflight");
const ONLY = val("--only")?.split(",").map((s) => s.trim()).filter(Boolean);
const EPICS_ONLY = has("--epics-only");

const SITE = process.env.JIRA_SITE ?? "ingenietech.atlassian.net";
const PROJECT = process.env.JIRA_PROJECT ?? "TLY";
const EMAIL = process.env.JIRA_EMAIL;
const TOKEN = process.env.JIRA_API_TOKEN;
const BASE = `https://${SITE}/rest/api/3`;

const backlog = JSON.parse(readFileSync("backlog/backlog.json", "utf8"));

// ---------------------------------------------------------------- markdown -> ADF
// Supports what the backlog actually uses: paragraphs, **bold**, `code`, "- " bullets,
// and "## " headings. Anything else passes through as plain paragraph text.

const inline = (text) => {
  const nodes = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0, m;
  const push = (t, marks) => { if (t) nodes.push(marks ? { type: "text", text: t, marks } : { type: "text", text: t }); };
  while ((m = re.exec(text))) {
    push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("**")) push(tok.slice(2, -2), [{ type: "strong" }]);
    else push(tok.slice(1, -1), [{ type: "code" }]);
    last = m.index + tok.length;
  }
  push(text.slice(last));
  return nodes.length ? nodes : [{ type: "text", text: " " }]; // ADF rejects empty content
};

const mdToAdf = (md) => {
  const out = [];
  const lines = (md ?? "").split("\n");
  let para = [], bullets = [];
  const flushPara = () => { if (para.length) { out.push({ type: "paragraph", content: inline(para.join(" ")) }); para = []; } };
  const flushBullets = () => {
    if (bullets.length) {
      out.push({ type: "bulletList", content: bullets.map((b) => ({ type: "listItem", content: [{ type: "paragraph", content: inline(b) }] })) });
      bullets = [];
    }
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) { flushPara(); flushBullets(); continue; }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) { flushPara(); flushBullets(); out.push({ type: "heading", attrs: { level: Math.min(6, heading[1].length + 1) }, content: inline(heading[2]) }); continue; }
    const bullet = /^[-*]\s+(.*)$/.exec(line);
    if (bullet) { flushPara(); bullets.push(bullet[1]); continue; }
    flushBullets();
    para.push(line.trim());
  }
  flushPara(); flushBullets();
  return out.length ? out : [{ type: "paragraph", content: [{ type: "text", text: " " }] }];
};

const buildDescription = (item) => {
  const content = mdToAdf(item.description);
  if (item.acceptanceCriteria?.length) {
    content.push({ type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: ACCEPTANCE_HEADING }] });
    content.push({
      type: "orderedList",
      content: item.acceptanceCriteria.map((ac) => ({
        type: "listItem",
        content: [{ type: "paragraph", content: inline(`${ac.id} — ${ac.text}`) }],
      })),
    });
  }
  return { type: "doc", version: 1, content };
};

// ---------------------------------------------------------------- Jira client
const auth = () => "Basic " + Buffer.from(`${EMAIL}:${TOKEN}`).toString("base64");

async function jira(path, init = {}) {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { Authorization: auth(), "Content-Type": "application/json", Accept: "application/json", ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let body; try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!res.ok) {
    const msg = body?.errorMessages?.join("; ") || JSON.stringify(body?.errors ?? body).slice(0, 400);
    const err = new Error(`${res.status} ${path} — ${msg}`);
    err.status = res.status; err.body = body;
    throw err;
  }
  return body;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Retry once on 429 honouring Retry-After.
async function jiraRetry(path, init, attempt = 0) {
  try { return await jira(path, init); }
  catch (e) {
    if (e.status === 429 && attempt < 3) { await sleep(2000 * (attempt + 1)); return jiraRetry(path, init, attempt + 1); }
    throw e;
  }
}

// ---------------------------------------------------------------- preflight
async function preflight() {
  const me = await jira("/myself");
  const project = await jira(`/project/${PROJECT}`);
  const types = (project.issueTypes ?? []).map((t) => t.name);
  const fields = await jira("/field");
  const acField = fields.find((f) => f.name?.toLowerCase() === "acceptance criteria");
  const pointsField = fields.find((f) => ["story points", "story point estimate"].includes(f.name?.toLowerCase()));
  const epicLink = fields.find((f) => f.name === "Epic Link");
  return {
    user: me.emailAddress ?? me.displayName,
    project: `${project.key} — ${project.name}`,
    style: project.style ?? "unknown",
    issueTypes: types,
    missingTypes: ["Epic", "Story"].filter((t) => !types.includes(t)),
    acceptanceField: acField ? `${acField.name} (${acField.id})` : null,
    pointsField: pointsField ? `${pointsField.name} (${pointsField.id})` : null,
    epicLinkField: epicLink?.id ?? null,
  };
}

// ---------------------------------------------------------------- idempotency
const escapeJql = (s) => s.replaceAll("\\", "\\\\").replaceAll('"', '\\"');

async function findExisting(summary) {
  // `~` is a text match, so compare exactly on the client before treating it as a duplicate.
  const jql = `project = ${PROJECT} AND statusCategory != Done AND summary ~ "${escapeJql(summary)}"`;
  const res = await jiraRetry(`/search/jql?jql=${encodeURIComponent(jql)}&fields=summary&maxResults=50`, { method: "GET" });
  return (res.issues ?? []).find((i) => i.fields.summary === summary) ?? null;
}

// ---------------------------------------------------------------- create
function payloadFor(item, { isEpic, epicKey, ctx }) {
  const fields = {
    project: { key: PROJECT },
    issuetype: { name: isEpic ? "Epic" : "Story" }, // Spikes are Stories labelled `spike`
    summary: item.summary,
    description: buildDescription(item),
    labels: [...new Set([...(item.labels ?? []), BOOTSTRAP_LABEL, ...(item.type === "Spike" ? ["spike"] : [])])],
  };
  if (ctx?.supportsPriority !== false && item.priority) fields.priority = { name: item.priority };
  if (!isEpic && epicKey) {
    if (ctx?.epicLinkField) fields[ctx.epicLinkField] = epicKey; // classic project
    else fields.parent = { key: epicKey };                        // team-managed project
  }
  if (!isEpic && ctx?.pointsFieldId && item.points) fields[ctx.pointsFieldId] = item.points;
  if (!isEpic && ctx?.acFieldId && item.acceptanceCriteria?.length)
    fields[ctx.acFieldId] = item.acceptanceCriteria.map((ac) => `${ac.id} — ${ac.text}`).join("\n");
  return { fields };
}

async function createIssue(item, opts) {
  try {
    return await jiraRetry("/issue", { method: "POST", body: JSON.stringify(payloadFor(item, opts)) });
  } catch (e) {
    // Team-managed projects often omit priority / points from the create screen. Retry without them.
    const bad = Object.keys(e.body?.errors ?? {});
    if (bad.length && bad.every((f) => ["priority", opts.ctx?.pointsFieldId, opts.ctx?.acFieldId].includes(f))) {
      console.warn(`    ! ${item.id ?? item.slug}: dropping unsupported fields (${bad.join(", ")}) and retrying`);
      const p = payloadFor(item, opts);
      for (const f of bad) delete p.fields[f];
      if (bad.includes("priority")) opts.ctx.supportsPriority = false;
      return jiraRetry("/issue", { method: "POST", body: JSON.stringify(p) });
    }
    throw e;
  }
}

// ---------------------------------------------------------------- main
const report = { created: [], skipped: [], failed: [] };

async function main() {
  const stories = (ONLY ? backlog.stories.filter((s) => ONLY.includes(s.id)) : backlog.stories);
  const epicSlugs = new Set(stories.map((s) => s.epic));
  const epics = backlog.epics.filter((e) => !ONLY || epicSlugs.has(e.slug));

  console.log(`Site ${SITE}   Project ${PROJECT}   Mode ${DRY ? "DRY RUN" : PREFLIGHT ? "PREFLIGHT" : "CREATE"}`);
  console.log(`Epics ${epics.length}   Stories ${EPICS_ONLY ? 0 : stories.length}   (Test and Bug issues are never created here)\n`);

  const ctx = { supportsPriority: true };
  const credentialed = Boolean(EMAIL && TOKEN);

  if (!credentialed && !DRY) {
    console.error("JIRA_EMAIL and JIRA_API_TOKEN are required for a real run. Use --dry-run to render offline.");
    process.exit(2);
  }

  if (credentialed) {
    const pf = await preflight();
    console.log("Preflight:");
    console.log(`  user            ${pf.user}`);
    console.log(`  project         ${pf.project}  (${pf.style})`);
    console.log(`  issue types     ${pf.issueTypes.join(", ")}`);
    console.log(`  epic link       ${pf.epicLinkField ? pf.epicLinkField + " (classic)" : "parent field (team-managed)"}`);
    console.log(`  AC custom field ${pf.acceptanceField ?? "none — heading in description is the contract"}`);
    console.log(`  points field    ${pf.pointsField ?? "none"}`);
    if (pf.missingTypes.length) { console.error(`\n  MISSING issue types: ${pf.missingTypes.join(", ")} — create them before importing.`); process.exit(3); }
    ctx.epicLinkField = pf.epicLinkField;
    ctx.acFieldId = pf.acceptanceField?.match(/\((.*)\)/)?.[1];
    ctx.pointsFieldId = pf.pointsField?.match(/\((.*)\)/)?.[1];
    console.log("");
  } else {
    console.log("No credentials in the environment — rendering offline. Duplicate checks are skipped.\n");
  }

  if (PREFLIGHT) return;

  const printId = val("--print-adf");
  if (printId) {
    const item = backlog.stories.find((s) => s.id === printId) ?? backlog.epics.find((e) => e.slug === printId);
    if (!item) { console.error(`No story or epic named ${printId}`); process.exit(4); }
    console.log(JSON.stringify({ fields: payloadFor(item, { isEpic: !item.id, epicKey: "TLY-1", ctx }).fields }, null, 2));
    return;
  }

  // ---- epics first, so stories can be parented
  const slugToKey = new Map();
  console.log(`Epics (${epics.length}):`);
  for (const epic of epics) {
    const existing = credentialed ? await findExisting(epic.summary) : null;
    if (existing) {
      slugToKey.set(epic.slug, existing.key);
      report.skipped.push({ key: existing.key, type: "Epic", summary: epic.summary, epic: epic.slug });
      console.log(`  = ${existing.key.padEnd(9)} ${epic.summary}  (exists, skipped)`);
      continue;
    }
    if (DRY) { slugToKey.set(epic.slug, `TLY-E?${epic.slug}`); console.log(`  + ${"(new)".padEnd(9)} ${epic.summary}`); continue; }
    try {
      const res = await createIssue(epic, { isEpic: true, ctx });
      slugToKey.set(epic.slug, res.key);
      report.created.push({ key: res.key, type: "Epic", summary: epic.summary, epic: epic.slug });
      console.log(`  + ${res.key.padEnd(9)} ${epic.summary}`);
      await sleep(150);
    } catch (e) {
      report.failed.push({ id: epic.slug, summary: epic.summary, error: e.message });
      console.error(`  x ${epic.slug}: ${e.message}`);
    }
  }

  // ---- stories in batches
  if (!EPICS_ONLY) {
    console.log(`\nStories (${stories.length}), batches of ${BATCH}:`);
    for (let b = 0; b < stories.length; b += BATCH) {
      const batch = stories.slice(b, b + BATCH);
      console.log(`\n  Batch ${b / BATCH + 1} — ${batch.length} issues`);
      for (const story of batch) {
        const epicKey = slugToKey.get(story.epic);
        const existing = credentialed ? await findExisting(story.summary) : null;
        if (existing) {
          report.skipped.push({ key: existing.key, type: story.type, summary: story.summary, epic: story.epic });
          console.log(`    = ${existing.key.padEnd(9)} ${story.id.padEnd(7)} ${story.summary}  (exists, skipped)`);
          continue;
        }
        if (DRY) {
          const doc = buildDescription(story);
          const size = JSON.stringify(doc).length;
          if (size > DESCRIPTION_LIMIT) report.failed.push({ id: story.id, summary: story.summary, error: `description ${size} bytes exceeds limit` });
          console.log(`    + ${"(new)".padEnd(9)} ${story.id.padEnd(7)} ${story.summary}  [${story.type}, ${story.priority}, ${story.points}pt, epic ${epicKey ?? "MISSING"}, ${story.acceptanceCriteria.length} AC, ${size}B]`);
          continue;
        }
        try {
          const res = await createIssue(story, { isEpic: false, epicKey, ctx });
          report.created.push({ key: res.key, type: story.type, summary: story.summary, epic: story.epic });
          console.log(`    + ${res.key.padEnd(9)} ${story.id.padEnd(7)} ${story.summary}`);
          await sleep(150);
        } catch (e) {
          report.failed.push({ id: story.id, summary: story.summary, error: e.message });
          console.error(`    x ${story.id}: ${e.message}`);
        }
      }
      if (!DRY && b + BATCH < stories.length) await sleep(1000); // be polite between batches
    }
  }

  // ---- output
  if (!DRY) {
    mkdirSync("backlog", { recursive: true });
    const rows = [["key", "type", "summary", "epic"], ...[...report.created, ...report.skipped].map((r) => [r.key, r.type, r.summary, r.epic])];
    writeFileSync("backlog/created-issues.csv", rows.map((r) => r.map((v) => `"${String(v).replaceAll('"', '""')}"`).join(",")).join("\n") + "\n");
  }

  console.log(`\nCreated ${report.created.length}   Skipped (already present) ${report.skipped.length}   Failed ${report.failed.length}`);
  if (report.failed.length) {
    console.error("\nFailures:");
    for (const f of report.failed) console.error(`  ${f.id}: ${f.error}`);
    process.exit(1);
  }
  if (!DRY) console.log("Wrote backlog/created-issues.csv");
}

main().catch((e) => { console.error(e.message); process.exit(1); });
