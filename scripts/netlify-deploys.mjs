#!/usr/bin/env node
/**
 * Turns Netlify builds on or off for the site, without editing the repo.
 *
 * netlify.toml skips every build unless TENDERLY_NETLIFY_DEPLOYS=on, because
 * each pull request was producing a deploy preview and the account ran into a
 * build-credit block. This flips that switch.
 *
 *   node scripts/netlify-deploys.mjs on      # allow builds
 *   node scripts/netlify-deploys.mjs off     # skip builds (the default)
 *   node scripts/netlify-deploys.mjs status
 *
 * Needs NETLIFY_AUTH_TOKEN. The site is NETLIFY_SITE_NAME, default gettenderly.
 */

const token = process.env.NETLIFY_AUTH_TOKEN?.trim();
const siteName = process.env.NETLIFY_SITE_NAME?.trim() || "gettenderly";
const KEY = "TENDERLY_NETLIFY_DEPLOYS";

if (!token) {
  console.error("NETLIFY_AUTH_TOKEN is required.");
  process.exit(2);
}

const action = (process.argv[2] ?? "status").toLowerCase();
if (!["on", "off", "status"].includes(action)) {
  console.error("usage: netlify-deploys.mjs [on|off|status]");
  process.exit(2);
}

const api = async (path, init = {}) => {
  const response = await fetch(`https://api.netlify.com/api/v1${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init.headers },
  });
  if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${response.status} ${(await response.text()).slice(0, 200)}`);
  return response.status === 204 ? null : response.json();
};

const sites = await api("/sites");
const site = sites.find((entry) => entry.name === siteName);
if (!site) {
  console.error(`No Netlify site named "${siteName}". Sites: ${sites.map((entry) => entry.name).join(", ")}`);
  process.exit(1);
}

const accountId = site.account_slug ?? site.account_id;
const variables = await api(`/accounts/${accountId}/env?site_id=${site.id}`);
const current = variables.find((entry) => entry.key === KEY);
const currentValue = current?.values?.[0]?.value ?? "(unset)";

if (action === "status") {
  console.log(`${siteName}: ${KEY}=${currentValue} — builds are ${currentValue === "on" ? "ON" : "OFF"}`);
  process.exit(0);
}

// No `scopes`: the free plan rejects scoped variables outright, and the
// default scope covers builds, which is the only place this is read.
const body = JSON.stringify([{ key: KEY, values: [{ context: "all", value: action }] }]);
// PUT replaces the variable outright. PATCH is per-context and rejects "all",
// which is the only context the free plan allows in the first place.
if (current) {
  await api(`/accounts/${accountId}/env/${KEY}?site_id=${site.id}`, {
    method: "PUT",
    body: JSON.stringify({ key: KEY, values: [{ context: "all", value: action }] }),
  });
} else {
  await api(`/accounts/${accountId}/env?site_id=${site.id}`, { method: "POST", body });
}
console.log(`${siteName}: ${KEY}=${action} — builds are now ${action === "on" ? "ON" : "OFF"}`);
