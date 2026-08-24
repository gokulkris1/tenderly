#!/usr/bin/env node
/**
 * Arms auto-merge (squash) on a pull request.
 *
 *   node scripts/github/auto-merge.mjs 71
 *
 * The REST API has no auto-merge endpoint, so this is the GraphQL mutation.
 * Auto-merge waits for the required checks rather than merging now, which is
 * the point: it is the same gate a human would wait for, without the waiting.
 */
const number = Number(process.argv[2]);
if (!Number.isInteger(number)) { console.error("usage: auto-merge.mjs <pr-number>"); process.exit(2); }

const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
if (!token) { console.error("GITHUB_TOKEN must be set."); process.exit(2); }

const [owner, repo] = (process.env.GITHUB_REPOSITORY || "gokulkris1/tenderly").split("/");

async function graphql(query, variables) {
  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { authorization: `bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const body = await response.json();
  if (body.errors) throw new Error(body.errors.map((error) => error.message).join("; "));
  return body.data;
}

const found = await graphql(
  `query($owner:String!,$repo:String!,$number:Int!){
     repository(owner:$owner,name:$repo){ pullRequest(number:$number){ id autoMergeRequest { enabledAt } } } }`,
  { owner, repo, number },
);
const pull = found.repository.pullRequest;
if (pull.autoMergeRequest) { console.log(`= PR #${number} already has auto-merge armed`); process.exit(0); }

await graphql(
  `mutation($id:ID!){ enablePullRequestAutoMerge(input:{pullRequestId:$id,mergeMethod:SQUASH}){ clientMutationId } }`,
  { id: pull.id },
);
console.log(`+ auto-merge armed on PR #${number}`);
