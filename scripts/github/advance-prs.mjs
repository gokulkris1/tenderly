#!/usr/bin/env node
/**
 * Advances every open PR that CI has passed but that main has moved past.
 *
 * Branch protection requires branches to be up to date before merging, which is
 * the guarantee that each PR is tested against the exact main it lands on. The
 * cost is that every merge leaves the other PRs BEHIND, and auto-merge will not
 * advance them itself — so without this they sit green and unmergeable.
 *
 * Uses the update-branch endpoint rather than local git: nothing is checked out,
 * so it is safe to run while work is in progress in the working tree. PRs are
 * squash-merged, so the merge commit this creates never reaches main.
 *
 * A PR whose branch genuinely conflicts (DIRTY) is reported, not touched — that
 * needs a person to decide how the two changes combine.
 *
 *   node scripts/github/advance-prs.mjs [--once]
 */

const token = process.env.GITHUB_TOKEN?.trim();
const repo = process.env.GITHUB_REPO?.trim() || "gokulkris1/tenderly";
if (!token) {
  console.error("GITHUB_TOKEN is required.");
  process.exit(2);
}

const api = async (path, init = {}) => {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      ...init.headers,
    },
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${init.method ?? "GET"} ${path} -> ${response.status} ${body.slice(0, 200)}`);
  }
  return response.status === 204 ? null : response.json();
};

const graphql = async (query, variables) => {
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const body = await response.json();
  if (body.errors) throw new Error(JSON.stringify(body.errors).slice(0, 300));
  return body.data;
};

const [owner, name] = repo.split("/");

/** mergeStateStatus is only exposed through GraphQL, so the listing goes there. */
async function openPulls() {
  const data = await graphql(`
    query($owner: String!, $name: String!) {
      repository(owner: $owner, name: $name) {
        pullRequests(states: OPEN, first: 50, orderBy: { field: CREATED_AT, direction: ASC }) {
          nodes { number title mergeStateStatus headRefName autoMergeRequest { enabledAt } }
        }
      }
    }`, { owner, name });
  return data.repository.pullRequests.nodes;
}

const pulls = await openPulls();
if (pulls.length === 0) {
  console.log("no open pull requests");
  process.exit(0);
}

for (const pull of pulls) {
  const label = `PR#${pull.number} ${pull.headRefName}`;
  switch (pull.mergeStateStatus) {
    case "BEHIND":
      try {
        await api(`/repos/${repo}/pulls/${pull.number}/update-branch`, { method: "PUT", body: "{}" });
        console.log(`^ ${label} advanced to main`);
      } catch (error) {
        console.log(`! ${label} could not be advanced: ${error.message}`);
      }
      break;
    case "DIRTY":
      console.log(`x ${label} conflicts with main — needs a person`);
      break;
    case "BLOCKED":
      console.log(`. ${label} waiting on checks or review`);
      break;
    case "CLEAN":
    case "HAS_HOOKS":
      console.log(`= ${label} ready${pull.autoMergeRequest ? " (auto-merge armed)" : " — auto-merge NOT armed"}`);
      break;
    default:
      console.log(`? ${label} ${pull.mergeStateStatus}`);
  }
}
