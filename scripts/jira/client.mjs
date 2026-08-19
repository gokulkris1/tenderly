// Shared Jira Cloud REST v3 / Agile v1 helper for the delivery automation.
// Credentials come from the environment only — never from a file in the repo.

export const SITE = process.env.JIRA_SITE ?? "ingenietech.atlassian.net";
export const PROJECT = process.env.JIRA_PROJECT ?? "TLY";
const EMAIL = process.env.JIRA_EMAIL;
const TOKEN = process.env.JIRA_API_TOKEN;

export const ACCEPTANCE_HEADING = "Acceptance Criteria";

if (!EMAIL || !TOKEN) {
  console.error("JIRA_EMAIL and JIRA_API_TOKEN must be set.");
  process.exit(2);
}

const authHeader = "Basic " + Buffer.from(`${EMAIL}:${TOKEN}`).toString("base64");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(base, path, init = {}, attempt = 0) {
  const res = await fetch(`https://${SITE}${base}${path}`, {
    ...init,
    headers: { Authorization: authHeader, "Content-Type": "application/json", Accept: "application/json", ...(init.headers ?? {}) },
  });
  if (res.status === 429 && attempt < 3) {
    const wait = Number(res.headers.get("retry-after") ?? 2) * 1000 * (attempt + 1);
    await sleep(wait);
    return call(base, path, init, attempt + 1);
  }
  const text = await res.text();
  let body; try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!res.ok) {
    const msg = body?.errorMessages?.join("; ") || JSON.stringify(body?.errors ?? body).slice(0, 400);
    const err = new Error(`${res.status} ${base}${path} — ${msg}`);
    err.status = res.status; err.body = body;
    throw err;
  }
  return body;
}

export const jira = (path, init) => call("/rest/api/3", path, init);
export const agile = (path, init) => call("/rest/agile/1.0", path, init);

/** Every TLY key mentioned in a branch name, PR title or commit range, de-duplicated. */
export const parseKeys = (text) => [...new Set((text ?? "").match(/TLY-\d+/g) ?? [])];

export const getIssue = (key, fields = "summary,status,issuetype,issuelinks,description,labels") =>
  jira(`/issue/${key}?fields=${fields}`);

/** Moves an issue to a named status. Idempotent: already-there is a no-op, not an error. */
export async function transitionTo(key, statusName) {
  const issue = await getIssue(key, "summary,status");
  const current = issue.fields.status.name;
  if (current === statusName) {
    console.log(`  = ${key} already ${statusName}`);
    return { moved: false, from: current };
  }
  const { transitions } = await jira(`/issue/${key}/transitions`);
  const t = transitions.find((x) => x.to?.name === statusName);
  if (!t) {
    console.warn(`  ! ${key} has no transition ${current} -> ${statusName} (available: ${transitions.map((x) => x.to?.name).join(", ") || "none"})`);
    return { moved: false, from: current, unavailable: true };
  }
  await jira(`/issue/${key}/transitions`, { method: "POST", body: JSON.stringify({ transition: { id: t.id } }) });
  console.log(`  > ${key} ${current} -> ${statusName}`);
  return { moved: true, from: current };
}

export async function comment(key, text) {
  await jira(`/issue/${key}/comment`, {
    method: "POST",
    body: JSON.stringify({ body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text }] }] } }),
  });
}

export async function link(inwardKey, outwardKey, typeName) {
  await jira("/issueLink", {
    method: "POST",
    body: JSON.stringify({ type: { name: typeName }, inwardIssue: { key: inwardKey }, outwardIssue: { key: outwardKey } }),
  });
}

/**
 * Pulls the "Acceptance Criteria" ordered list out of a Story's ADF description.
 * This is the manual test script the Test ticket carries, so the heading text is
 * load-bearing — see docs/AUTOMATION.md.
 */
export function extractAcceptanceCriteria(description) {
  const content = description?.content ?? [];
  const i = content.findIndex(
    (b) => b.type === "heading" && b.content?.some((t) => t.text?.trim() === ACCEPTANCE_HEADING),
  );
  if (i === -1) return null;
  const list = content.slice(i + 1).find((b) => b.type === "orderedList" || b.type === "bulletList");
  return list ?? null;
}

/** The scrum board for the project, or null if the project has no board with sprints. */
export async function findBoard() {
  const { values } = await agile(`/board?projectKeyOrId=${PROJECT}`);
  return values?.find((b) => b.type === "scrum") ?? values?.[0] ?? null;
}

export async function activeSprint(boardId) {
  const { values } = await agile(`/board/${boardId}/sprint?state=active`);
  return values?.[0] ?? null;
}

export { sleep };
