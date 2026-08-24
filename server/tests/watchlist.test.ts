import assert from "node:assert/strict";
import test from "node:test";
import bcrypt from "bcryptjs";
import { signToken } from "../src/auth.js";
import { createUser, initializeDatabase, listWatchlist } from "../src/db.js";
import type { WatchlistItem } from "@tenderly/shared";

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

const a = await makeAccount("watch-a");
const b = await makeAccount("watch-b");

const inDays = (days: number) => {
  const date = new Date(Date.now() + days * 86_400_000);
  return `${String(date.getUTCDate()).padStart(2, "0")}/${String(date.getUTCMonth() + 1).padStart(2, "0")}/${date.getUTCFullYear()}`;
};

const watch = (account: typeof a, notice: Record<string, string>) =>
  fetch(`${base}/api/watchlist`, { method: "POST", headers: account.headers, body: JSON.stringify(notice) });
const list = (account: typeof a) =>
  fetch(`${base}/api/watchlist`, { headers: account.headers }).then((r) => r.json() as Promise<{ items: WatchlistItem[] }>);
const unwatch = (account: typeof a, externalId: string) =>
  fetch(`${base}/api/watchlist/${encodeURIComponent(externalId)}`, { method: "DELETE", headers: account.headers });

test("TLY-39 AC1: a watched notice is listed with its deadline and days remaining", async () => {
  const response = await watch(a, {
    externalId: "8796200", title: "Deep Energy Retrofit 2", authority: "Dublin City Council",
    deadline: inDays(10), sourceUrl: "https://www.etenders.gov.ie/epps/cft/x?resourceId=8796200",
  });
  assert.equal(response.status, 201);

  const { items } = await list(a);
  const item = items.find((entry) => entry.externalId === "8796200");
  assert.equal(item?.title, "Deep Energy Retrofit 2");
  assert.equal(item?.deadline, inDays(10));
  assert.ok((item?.daysRemaining ?? 0) >= 9 && (item?.daysRemaining ?? 0) <= 10);
  assert.equal(item?.closed, false);
});

test("TLY-39 AC2: the watched set is readable, so the star can show its state", async () => {
  const { items } = await list(a);
  assert.ok(items.some((entry) => entry.externalId === "8796200"),
    "the star state is derived from this list, so the two cannot disagree");
});

test("TLY-39 AC4: a passed deadline is Closed and says so instead of a negative number", async () => {
  await watch(a, {
    externalId: "8796201", title: "Closed opportunity", authority: "HSE",
    deadline: inDays(-3), sourceUrl: "https://www.etenders.gov.ie/x",
  });
  const { items } = await list(a);
  const item = items.find((entry) => entry.externalId === "8796201");
  assert.equal(item?.closed, true);
  assert.equal(item?.daysRemaining, null, "a negative count would be nonsense on screen");
  assert.equal(items[items.length - 1].externalId, "8796201", "closed items fall to the bottom");
});

test("TLY-39: the live list is ordered by how soon each closes", async () => {
  await watch(a, { externalId: "8796202", title: "Closes sooner", authority: "OPW", deadline: inDays(2), sourceUrl: "https://www.etenders.gov.ie/x" });
  const { items } = await list(a);
  const live = items.filter((entry) => !entry.closed).map((entry) => entry.externalId);
  assert.equal(live[0], "8796202", "the nearest deadline is what needs attention first");
});

test("TLY-39 AC5: unwatching removes it", async () => {
  assert.equal((await unwatch(a, "8796202")).status, 200);
  const { items } = await list(a);
  assert.ok(!items.some((entry) => entry.externalId === "8796202"));
  assert.equal((await unwatch(a, "8796202")).status, 404, "removing it twice is not a silent success");
});

test("TLY-39: watching the same notice twice is the same intent, not an error", async () => {
  await watch(a, { externalId: "8796203", title: "First title", authority: "OPW", deadline: inDays(5), sourceUrl: "https://www.etenders.gov.ie/x" });
  const second = await watch(a, { externalId: "8796203", title: "Corrected title", authority: "OPW", deadline: inDays(5), sourceUrl: "https://www.etenders.gov.ie/x" });
  assert.equal(second.status, 201);

  const entries = await listWatchlist(a.id);
  const matching = entries.filter((entry) => entry.externalId === "8796203");
  assert.equal(matching.length, 1, "one notice, one row");
  assert.equal(matching[0].title, "Corrected title", "the later details win");
});

test("TLY-39: one account never sees another's watchlist", async () => {
  await watch(b, { externalId: "b-only", title: "Account B notice", authority: "HSE", deadline: inDays(4), sourceUrl: "https://www.etenders.gov.ie/x" });
  const { items } = await list(a);
  assert.ok(!items.some((entry) => entry.externalId === "b-only"));
  assert.equal((await unwatch(a, "b-only")).status, 404, "and cannot remove one");

  const { items: mine } = await list(b);
  assert.equal(mine.length, 1);
});

test("TLY-39: the watchlist is not readable without a token", async () => {
  assert.equal((await fetch(`${base}/api/watchlist`)).status, 401);
});
