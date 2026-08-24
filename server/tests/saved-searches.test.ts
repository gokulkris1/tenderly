import assert from "node:assert/strict";
import test from "node:test";
import bcrypt from "bcryptjs";
import { signToken } from "../src/auth.js";
import { createSavedSearch, createUser, getSavedSearch, initializeDatabase, listSavedSearches } from "../src/db.js";
import type { SavedSearch, SavedSearchFilter } from "../src/types.js";

process.env.JWT_SECRET ||= "test-secret-that-is-at-least-32-characters";
process.env.TENDERLY_NO_LISTEN = "1";
await initializeDatabase();
const { app } = await import("../src/index.js");
const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const address = server.address();
const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
server.unref();

async function makeAccount(label: string) {
  const email = `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`;
  const user = await createUser(email, await bcrypt.hash("x", 4), `${label} Ltd`);
  return { id: user.organisationId, email, headers: { authorization: `Bearer ${signToken({ id: user.id, organisationId: user.organisationId, email })}`, "content-type": "application/json" } };
}

const a = await makeAccount("search-a");
const b = await makeAccount("search-b");

const filter = (over: Partial<SavedSearchFilter> = {}): SavedSearchFilter =>
  ({ buyer: "Health Service Executive", sectors: [], keywords: [], cpvCodes: ["71314000"], valueMin: null, valueMax: null, ...over });

const save = (account: typeof a, name: string, body = filter()) =>
  fetch(`${base}/api/saved-searches`, { method: "POST", headers: account.headers, body: JSON.stringify({ name, filter: body }) });
const list = (account: typeof a) =>
  fetch(`${base}/api/saved-searches`, { headers: account.headers }).then((r) => r.json() as Promise<{ items: SavedSearch[] }>);
const remove = (account: typeof a, id: string) =>
  fetch(`${base}/api/saved-searches/${id}`, { method: "DELETE", headers: account.headers });

test("TLY-38 AC1: a saved search persists with its buyer and CPV filter", async () => {
  const response = await save(a, "HSE energy");
  assert.equal(response.status, 201);

  const { items } = await list(a);
  const search = items.find((entry) => entry.name === "HSE energy");
  assert.ok(search, "it appears in the selector after a reload");
  assert.equal(search.filter.buyer, "Health Service Executive");
  assert.deepEqual(search.filter.cpvCodes, ["71314000"]);
});

test("TLY-38 AC4: a duplicate name is refused and no second entry is created", async () => {
  const duplicate = await save(a, "HSE energy");
  assert.equal(duplicate.status, 409);
  assert.equal((await duplicate.json() as { error: string }).error,
    "A saved search with that name already exists");

  const entries = await listSavedSearches(a.id);
  assert.equal(entries.filter((entry) => entry.name === "HSE energy").length, 1,
    "a name is how a person picks a search, so two of them is a bug");
});

test("TLY-38 AC5: deleting removes it, and deleting it twice is not a silent success", async () => {
  const { search } = await (await save(a, "Temporary slice")).json() as { search: SavedSearch };
  assert.equal((await remove(a, search.id)).status, 200);

  const { items } = await list(a);
  assert.ok(!items.some((entry) => entry.id === search.id));
  assert.equal((await remove(a, search.id)).status, 404);
});

test("TLY-38 AC3: an unknown search id is refused rather than silently ignored", async () => {
  const unknown = await fetch(`${base}/api/tenders/discover?search=00000000-0000-0000-0000-000000000000`, { headers: a.headers });
  assert.equal(unknown.status, 404, "a stale selection must not quietly return the profile view");

  const malformed = await fetch(`${base}/api/tenders/discover?search=not-a-uuid`, { headers: a.headers });
  assert.equal(malformed.status, 404, "and a hand-edited one is a 404, not a server error");
});

test("TLY-38 AC2 and AC3: a saved search replaces the profile's filter fields, not the matching logic", async () => {
  const saved = await createSavedSearch(a.id, "Cork IT", filter({ buyer: "Cork", cpvCodes: ["72000000"], keywords: ["support"] }));
  const loaded = await getSavedSearch(a.id, saved.id);
  assert.deepEqual(loaded?.filter.cpvCodes, ["72000000"]);
  assert.deepEqual(loaded?.filter.keywords, ["support"]);
  assert.equal(loaded?.filter.buyer, "Cork");

  // A malformed id is not a row id. Postgres raises on a bad uuid rather than
  // returning no rows, so this used to surface as a 500 instead of a 404.
  assert.equal(await getSavedSearch(a.id, "not-a-real-id"), null);
  assert.equal(await getSavedSearch(a.id, "00000000-0000-0000-0000-000000000000"), null);
});

test("TLY-38: one account's searches are invisible to another", async () => {
  await save(b, "Account B slice");
  const { items } = await list(a);
  assert.ok(!items.some((entry) => entry.name === "Account B slice"));

  const { items: mine } = await list(b);
  assert.equal(mine.length, 1);

  const [target] = await listSavedSearches(b.id);
  assert.equal((await remove(a, target.id)).status, 404, "and cannot be deleted across the boundary");
});

test("TLY-38: the same name is available to a different account", async () => {
  assert.equal((await save(b, "HSE energy")).status, 201,
    "uniqueness is per account, not global");
});

test("TLY-38: a malformed CPV code is rejected before it reaches a filter", async () => {
  const response = await save(a, "Bad codes", filter({ cpvCodes: ["71314"] as string[] }));
  assert.equal(response.status, 400);
});

test("TLY-38: saved searches are not readable without a token", async () => {
  assert.equal((await fetch(`${base}/api/saved-searches`)).status, 401);
});
