#!/usr/bin/env node
/**
 * Configures the GitHub repository so the delivery pipeline can run:
 * repository secrets, the staging and production environments, branch protection
 * on `main` requiring the `ci-pr` check, and repo-level auto-merge.
 *
 *   set -a; . ~/.tenderly/secrets.env; set +a
 *   node scripts/github/configure-repo.mjs [--dry-run]
 *
 * Needs GITHUB_TOKEN with `repo` scope (and `admin:repo_hooks` for protection).
 * Secret values are read from the environment and encrypted locally with libsodium
 * before they leave this machine — they are never logged.
 *
 * libsodium is not a repository dependency (the root package.json arrives with
 * TLY-19). Install it anywhere and point NODE_PATH at it:
 *   npm install --prefix ~/.tenderly/tools libsodium-wrappers
 */
import { createRequire } from "node:module";

const argv = process.argv.slice(2);
const DRY = argv.includes("--dry-run");

const TOKEN = process.env.GITHUB_TOKEN;
const REPO = process.env.GITHUB_REPO ?? "gokulkris1/tenderly";
if (!TOKEN) { console.error("GITHUB_TOKEN is required."); process.exit(2); }

// ---- libsodium, resolved from NODE_PATH or a sibling install
const require_ = createRequire(import.meta.url);
let sodium;
for (const p of [
  "libsodium-wrappers",
  `${process.env.HOME}/.tenderly/tools/node_modules/libsodium-wrappers`,
]) {
  try { sodium = require_(p); break; } catch { /* try the next */ }
}
if (!sodium) {
  console.error("libsodium-wrappers not found. Run:\n  npm install --prefix ~/.tenderly/tools libsodium-wrappers");
  process.exit(2);
}
await sodium.ready;

// ---- GitHub client
async function gh(path, init = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let body; try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`${res.status} ${init.method ?? "GET"} ${path} — ${body.message ?? text.slice(0, 200)}`);
    err.status = res.status; err.body = body;
    throw err;
  }
  return body;
}

console.log(`Repository ${REPO}${DRY ? "   [DRY RUN]" : ""}\n`);

// ---- secrets
const SECRET_NAMES = [
  "JIRA_SITE", "JIRA_EMAIL", "JIRA_API_TOKEN", "JIRA_PROJECT",
  "STAGING_URL", "STAGING_WEB_URL", "STAGING_DATABASE_URL", "PRODUCTION_URL",
  "RENDER_DEPLOY_HOOK_STAGING", "NETLIFY_BUILD_HOOK_STAGING",
  "RENDER_DEPLOY_HOOK_PRODUCTION", "NETLIFY_BUILD_HOOK_PRODUCTION",
  "JIRA_AUTOMATION_WEBHOOK",
];

console.log("Secrets:");
const key = DRY ? null : await gh(`/repos/${REPO}/actions/secrets/public-key`);
for (const name of SECRET_NAMES) {
  const value = process.env[name];
  if (!value) { console.log(`  - ${name.padEnd(30)} not set locally, skipped`); continue; }
  if (DRY) { console.log(`  + ${name.padEnd(30)} would set (${value.length} chars)`); continue; }
  const encrypted = sodium.to_base64(
    sodium.crypto_box_seal(sodium.from_string(value), sodium.from_base64(key.key, sodium.base64_variants.ORIGINAL)),
    sodium.base64_variants.ORIGINAL,
  );
  await gh(`/repos/${REPO}/actions/secrets/${name}`, {
    method: "PUT",
    body: JSON.stringify({ encrypted_value: encrypted, key_id: key.key_id }),
  });
  console.log(`  + ${name.padEnd(30)} set`);
}

// ---- environments
console.log("\nEnvironments:");
for (const env of ["staging", "production"]) {
  if (DRY) { console.log(`  + ${env} would be created`); continue; }
  // Environment protection rules (required reviewers, wait timers) need GitHub
  // Pro/Team on a private repo. Create the environment either way and say so.
  // production waits for a named human; staging does not. Protection rules are
  // refused on private repos outside Pro/Team, so this degrades rather than aborts.
  const body = { deployment_branch_policy: null };
  if (env === "production") {
    const me = await gh("/user");
    body.reviewers = [{ type: "User", id: me.id }];
    body.prevent_self_review = false;
  }
  try {
    await gh(`/repos/${REPO}/environments/${env}`, { method: "PUT", body: JSON.stringify(body) });
    console.log(`  + ${env} created${env === "production" ? " with a required reviewer" : ""}`);
  } catch (e) {
    if (e.status === 422) { console.warn(`  ! ${env}: ${e.body?.message ?? e.message}`); continue; }
    throw e;
  }
}
if (!DRY) {
  const prod = await gh(`/repos/${REPO}/environments/production`).catch(() => null);
  const reviewers = prod?.protection_rules?.find((r) => r.type === "required_reviewers")?.reviewers ?? [];
  if (reviewers.length) console.log(`  approval gate active: ${reviewers.length} required reviewer(s) on production`);
  else console.log("  ! production has no required reviewer. Protection rules need GitHub Pro/Team on a\n    private repo; until then the manual workflow_dispatch on prod.yml is the only gate.");
}

// ---- auto-merge
console.log("\nRepository settings:");
if (DRY) console.log("  + would enable auto-merge and delete-branch-on-merge");
else {
  await gh(`/repos/${REPO}`, { method: "PATCH", body: JSON.stringify({ allow_auto_merge: true, delete_branch_on_merge: true }) });
  console.log("  + auto-merge and delete-branch-on-merge enabled");
}

// ---- branch protection
console.log("\nBranch protection on main:");
const protection = {
  required_status_checks: { strict: true, contexts: ["ci-pr", "pr-conventions"] },
  // Admins included. With this false, an owner token merges straight past a
  // required check that has not finished — which happened once on TLY-66 and is
  // precisely the "merged but unverified" failure this pipeline exists to stop.
  enforce_admins: true,
  required_pull_request_reviews: null, // solo repo: the required check is the gate
  restrictions: null,
  allow_force_pushes: false,
  allow_deletions: false,
};
if (DRY) console.log(`  + would require ${protection.required_status_checks.contexts.join(", ")}`);
else {
  try {
    await gh(`/repos/${REPO}/branches/main/protection`, { method: "PUT", body: JSON.stringify(protection) });
    console.log(`  + main requires ${protection.required_status_checks.contexts.join(", ")}, force-push and deletion blocked, admins included`);
  } catch (e) {
    console.error(`  x ${e.message}`);
    if (e.status === 403) console.error("    (branch protection needs a token with admin rights on the repo)");
  }
}

console.log("\nDone.");
