import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import bcrypt from "bcryptjs";
import { signToken } from "../src/auth.js";
import {
  createUser,
  createUserWithoutOrganisation,
  addMembership,
  getPreferences,
  getPortalConnection,
  initializeDatabase,
  listClarifications,
  listDiscoveryDismissals,
  listTenderBoards,
  recordClarification,
  saveAwards,
  saveNotification,
  savePreferences,
  upsertTender,
} from "../src/db.js";
import { computeMarketStats, cpvDivisionLabel, listBuyers } from "../src/market.js";
import { accountCountries, marketsWatched, visibleNotices } from "../src/jobs.js";
import { decryptPortalPassword, encryptPortalPassword } from "../src/portal.js";
import {
  PortalError, listPortalMessages, portalLogin, sendPortalMessage,
} from "../src/sources/etenders-account.js";
import { cpvCountryQuery, irishCpvQuery, noticeMarkets, noticeToPublicTender, searchAllTed } from "../src/sources/ted.js";
import type { PortalConnection } from "@tenderly/shared";

process.env.JWT_SECRET ||= "test-secret-that-is-at-least-32-characters";
process.env.TENDERLY_NO_LISTEN = "1";
await initializeDatabase();
const { app } = await import("../src/index.js");
const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const address = server.address();
const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
server.unref();

let userCounter = 0;
async function makeUser(company = `Superset Ltd ${++userCounter}`) {
  const email = `superset-${Date.now()}-${userCounter}-${Math.random().toString(36).slice(2)}@example.test`;
  const user = await createUser(email, await bcrypt.hash("x", 4), company);
  const token = "Bearer " + signToken({ id: user.id, organisationId: user.organisationId, email });
  const headers = { authorization: token, "content-type": "application/json" };
  return { user, email, accountId: user.organisationId, headers };
}

let tenderCounter = 0;
async function makeTender(accountId: string, over: Record<string, unknown> = {}) {
  tenderCounter += 1;
  return upsertTender(accountId, {
    source: "etenders", externalId: `superset-${Date.now()}-${tenderCounter}`,
    title: `Superset tender ${tenderCounter}`, authority: "Dublin City Council",
    procedure: "Open", deadline: "", estimatedValue: "", description: "",
    sourceUrl: "https://www.etenders.gov.ie/epps/cft/prepareViewCfTWS.do?resourceId=999",
    published: "", status: "IMPORTED", metadata: {},
    ...(over as Record<string, unknown>),
  } as Parameters<typeof upsertTender>[1]);
}

// A fixed "now" for the market math: every deadline below is relative to it.
const NOW = new Date("2026-11-04T09:00:00.000Z");
const inDays = (days: number) => new Date(NOW.getTime() + days * 86_400_000).toISOString();

// ---------------------------------------------------------------------------
// Competitors (empty state first: the award store is process-wide in memory
// mode, so the no-dataset assertion must run before any test loads awards)
// ---------------------------------------------------------------------------

test("competitors answer an honest empty state until the OGP dataset is loaded", async () => {
  const { headers } = await makeUser("Competitors Empty Ltd");
  const response = await fetch(`${base}/api/market/competitors`, { headers });
  assert.equal(response.status, 200);
  const body = await response.json() as { items: unknown[]; note?: string };
  assert.deepEqual(body.items, []);
  assert.match(body.note ?? "", /OGP award dataset/);
});

// ---------------------------------------------------------------------------
// Buyers
// ---------------------------------------------------------------------------

test("buyers aggregate tracked tenders and award history per workspace", async () => {
  const { accountId, headers } = await makeUser("Buyers Aggregates Ltd");
  await makeTender(accountId, { authority: "Dublin City Council" });
  await makeTender(accountId, {
    authority: "Dublin City Council",
    metadata: { workflow: { stage: "DONE", outcome: "PENDING", assignee: "", priority: "MEDIUM", history: [] } },
  });
  await makeTender(accountId, { authority: "Office of Government Procurement" });
  await saveAwards([
    { externalId: "awd-1", authority: "Dublin City Council", title: "IT support", cpv: "72000000", cpvDescription: "IT services", procedure: "Open", publishedOn: null, awardedOn: "2025-05-01", awardedValue: 100000, estimatedValue: null, suppliers: "AlphaBid Ltd", bidsReceived: null, smeBidsReceived: null },
    { externalId: "awd-2", authority: "Dublin City Council", title: "Hosting", cpv: "72000000", cpvDescription: "IT services", procedure: "Open", publishedOn: null, awardedOn: "2024-03-01", awardedValue: 50000, estimatedValue: null, suppliers: "BetaWorks", bidsReceived: null, smeBidsReceived: null },
  ]);

  const response = await fetch(`${base}/api/buyers`, { headers });
  assert.equal(response.status, 200);
  const { items } = await response.json() as { items: { name: string; activeTenders: number; trackedTenders: number; awards: number; awardedValue: string | null }[] };
  const dublin = items.find((item) => item.name === "Dublin City Council");
  assert.ok(dublin, "the buyer appears");
  assert.equal(dublin.trackedTenders, 2);
  assert.equal(dublin.activeTenders, 1, "the DONE tender is not active");
  assert.equal(dublin.awards, 2);
  assert.ok(dublin.awardedValue?.includes("150,000"), `awarded value sums real rows: ${dublin.awardedValue}`);
  const ogp = items.find((item) => item.name === "Office of Government Procurement");
  assert.equal(ogp?.awards, 0);
  assert.equal(ogp?.awardedValue, null);
});

test("buyers are tenant-scoped: another workspace sees none of it", async () => {
  const one = await makeUser("Buyers One Ltd");
  const two = await makeUser("Buyers Two Ltd");
  await makeTender(one.accountId, { authority: "Alpha Confidential Council" });

  const listResponse = await fetch(`${base}/api/buyers`, { headers: two.headers });
  const { items } = await listResponse.json() as { items: { name: string }[] };
  assert.equal(items.some((item) => /alpha confidential/i.test(item.name)), false);

  const profile = await fetch(`${base}/api/buyers/${encodeURIComponent("Alpha Confidential Council")}`, { headers: two.headers });
  // The buyer profile answers 200 only when award history knows the buyer —
  // shared reference data. Its tenders list must still be the caller's own.
  if (profile.status === 200) {
    const body = await profile.json() as { tenders: unknown[] };
    assert.equal(body.tenders.length, 0, "no tender of account A may appear");
  } else {
    assert.equal(profile.status, 404);
  }
});

test("an unknown buyer is a 404, and a known buyer profiles its tenders", async () => {
  const { accountId, headers } = await makeUser("Buyer Profile Ltd");
  const tender = await makeTender(accountId, { authority: "Kildare County Council", title: "Portal replatform" });

  const missing = await fetch(`${base}/api/buyers/${encodeURIComponent("Nobody Publishing")}`, { headers });
  assert.equal(missing.status, 404);

  const response = await fetch(`${base}/api/buyers/${encodeURIComponent("Kildare County Council")}`, { headers });
  assert.equal(response.status, 200);
  const body = await response.json() as { name: string; tenders: { id: string; title: string }[]; intelligence: unknown };
  assert.equal(body.name, "Kildare County Council");
  assert.deepEqual(body.tenders.map((item) => item.title), ["Portal replatform"]);
  assert.ok(body.tenders[0].id === tender.id);
  assert.ok(body.intelligence && typeof body.intelligence === "object", "award intelligence serialises as-is");
});

test("buyer names arrive URL-encoded and decode before lookup", async () => {
  const { accountId, headers } = await makeUser("Buyer Encoding Ltd");
  await makeTender(accountId, { authority: "Údarás na Gaeltachta & Co" });
  const response = await fetch(`${base}/api/buyers/${encodeURIComponent("Údarás na Gaeltachta & Co")}`, { headers });
  assert.equal(response.status, 200);
});

// ---------------------------------------------------------------------------
// Market stats
// ---------------------------------------------------------------------------

test("market stats count stored work, with the EUR 200k band inclusive below", async () => {
  const { accountId } = await makeUser("Market Math Ltd");
  // closing in 5 days, value exactly at the boundary → under
  await makeTender(accountId, { deadline: inDays(5), estimatedValue: "200,000", published: "2026-11-02T08:00:00Z", metadata: { "CPV Codes": "72000000" } });
  // closing in 10 days, just past the boundary → over
  await makeTender(accountId, { deadline: inDays(10), estimatedValue: "200,001", published: "2026-10-01T08:00:00Z", metadata: { "CPV Codes": "72221000" } });
  // closing in 20 days, no value stated → unknown
  await makeTender(accountId, { deadline: inDays(20), published: "2026-11-03T08:00:00Z" });
  // already closed → not active anywhere
  await makeTender(accountId, { deadline: inDays(-2), estimatedValue: "100" });
  // ignored → out of the picture entirely
  await makeTender(accountId, { deadline: inDays(6), metadata: { workflow: { stage: "IGNORE", outcome: "PENDING", assignee: "", priority: "MEDIUM", history: [] } } });
  // discovery state: a notification for a notice nobody tracked yet
  await saveNotification(accountId, "555001-2026", "TED notice", "https://ted.europa.eu/en/notice/555001-2026/pdf", 60, {
    externalId: "555001-2026", title: "TED notice", authority: "TED Buyer",
    deadline: inDays(10), published: "2026-11-01T00:00:00Z", description: "CPV 48000000", estimatedValue: "90,000",
  });
  // and one that is already tracked: counted once, as the tender
  const tracked = await makeTender(accountId, { deadline: inDays(3), estimatedValue: "10,000", published: "2026-11-04T06:00:00Z" });
  await saveNotification(accountId, tracked.externalId, tracked.title, tracked.sourceUrl, 80, {
    externalId: tracked.externalId, title: tracked.title, authority: tracked.authority,
    deadline: inDays(3), published: "2026-11-04T06:00:00Z", description: "", estimatedValue: "10,000",
  });

  const stats = await computeMarketStats(accountId, NOW);
  assert.equal(stats.active, 5, "4 open tenders + 1 untracked notification; closed, ignored and duplicate excluded");
  assert.equal(stats.newThisWeek, 4, "three recently published tenders and the notification; the duplicate counts once");
  assert.deepEqual(stats.closingSoon, { in7: 2, in14: 4, in30: 5 });
  assert.deepEqual(stats.valueBands, { under: 3, over: 1, unknown: 1 }, "200,000 counts under; 200,001 over; unstated unknown");
  assert.deepEqual(stats.sources, { etenders: 4, ted: 1 });
  const itDivision = stats.byDivision.find((entry) => entry.code === "72");
  assert.equal(itDivision?.count, 2);
  assert.match(itDivision?.label ?? "", /IT services/i);
  assert.ok(stats.byDivision.some((entry) => entry.code === "48"));
  assert.equal(stats.topBuyers[0]?.name, "Dublin City Council");
  assert.equal(stats.generatedAt, NOW.toISOString());
});

test("market stats are empty — honestly — for a fresh workspace", async () => {
  const { accountId } = await makeUser("Market Empty Ltd");
  const stats = await computeMarketStats(accountId, NOW);
  assert.equal(stats.active, 0);
  assert.deepEqual(stats.closingSoon, { in7: 0, in14: 0, in30: 0 });
  assert.deepEqual(stats.byDivision, []);
  assert.deepEqual(stats.topBuyers, []);
});

test("market stats serve over HTTP and stay tenant-scoped", async () => {
  const one = await makeUser("Stats One Ltd");
  const two = await makeUser("Stats Two Ltd");
  await makeTender(one.accountId, { deadline: inDays(5), title: "alpha confidential stats tender" });
  const response = await fetch(`${base}/api/market/stats`, { headers: two.headers });
  assert.equal(response.status, 200);
  const stats = await response.json() as { active: number };
  assert.equal(stats.active, 0, "another workspace's tenders are not my market");
  const ownResponse = await fetch(`${base}/api/market/stats`, { headers: one.headers });
  assert.equal((await ownResponse.json() as { active: number }).active, 1);
});

test("CPV division labels come from the official list, with a plain fallback", () => {
  assert.match(cpvDivisionLabel("72"), /IT services/i);
  assert.match(cpvDivisionLabel("45"), /[Cc]onstruction/);
  assert.equal(cpvDivisionLabel("99"), "CPV division 99");
});

// ---------------------------------------------------------------------------
// Competitors
// ---------------------------------------------------------------------------

test("competitors rank suppliers by wins in the workspace's CPV families", async () => {
  const { accountId, headers } = await makeUser("Competitors Ltd");
  // A family no other test in this file touches, so the shared award store
  // cannot leak into the ranking.
  await savePreferences(accountId, { sectors: [], keywords: [], cpvCodes: ["48000000"], valueMin: null, valueMax: null, countries: ["IRL"] });
  await saveAwards([
    { externalId: "c-1", authority: "North County Council", title: "Software", cpv: "48000000", cpvDescription: "", procedure: "", publishedOn: null, awardedOn: "2025-01-10", awardedValue: 80000, estimatedValue: null, suppliers: "SoftWin Ltd", bidsReceived: null, smeBidsReceived: null },
    { externalId: "c-2", authority: "South County Council", title: "Hosting", cpv: "48200000", cpvDescription: "", procedure: "", publishedOn: null, awardedOn: "2025-06-10", awardedValue: 120000, estimatedValue: null, suppliers: "SoftWin Ltd", bidsReceived: null, smeBidsReceived: null },
    { externalId: "c-3", authority: "North County Council", title: "Advisory", cpv: "48100000", cpvDescription: "", procedure: "", publishedOn: null, awardedOn: "2024-11-01", awardedValue: 40000, estimatedValue: null, suppliers: "PackageHouse", bidsReceived: null, smeBidsReceived: null },
    { externalId: "c-4", authority: "North County Council", title: "Build a road", cpv: "45200000", cpvDescription: "", procedure: "", publishedOn: null, awardedOn: "2025-02-01", awardedValue: 900000, estimatedValue: null, suppliers: "RoadBuilders Ireland", bidsReceived: null, smeBidsReceived: null },
  ]);

  const response = await fetch(`${base}/api/market/competitors`, { headers });
  const { items } = await response.json() as { items: { supplier: string; wins: number; totalValue: string | null; lastWin: string | null; buyers: string[] }[] };
  const softwin = items.find((item) => item.supplier === "SoftWin Ltd");
  const packagehouse = items.find((item) => item.supplier === "PackageHouse");
  assert.ok(softwin && packagehouse, "suppliers in the watched CPV family (48, incl. its division neighbours)");
  assert.equal(items.some((item) => item.supplier === "RoadBuilders Ireland"), false, "outside the family");
  assert.equal(softwin.wins, 2);
  assert.equal(softwin.lastWin, "2025-06-10");
  assert.ok(softwin.buyers.includes("South County Council"));
  assert.ok(Number(softwin.totalValue) === 200000, `total value is a sum: ${softwin.totalValue}`);
  assert.equal(packagehouse.wins, 1);
  assert.ok(items.indexOf(softwin) < items.indexOf(packagehouse), "ranked by wins");
});

// ---------------------------------------------------------------------------
// Discovery dismissals
// ---------------------------------------------------------------------------

test("dismiss and restore round-trip per account", async () => {
  const one = await makeUser("Dismiss One Ltd");
  const two = await makeUser("Dismiss Two Ltd");
  const dismiss = (headers: Record<string, string>, method: string) =>
    fetch(`${base}/api/tenders/discover/dismiss`, { method, headers, body: JSON.stringify({ externalId: "248591", source: "eTenders" }) });

  assert.equal((await dismiss(one.headers, "POST")).status, 204);
  assert.deepEqual((await listDiscoveryDismissals(one.accountId)).map((entry) => `${entry.source}:${entry.externalId}`), ["etenders:248591"]);
  assert.deepEqual(await listDiscoveryDismissals(two.accountId), [], "another workspace dismisses its own notices");

  assert.equal((await dismiss(two.headers, "DELETE")).status, 204, "restoring a notice never dismissed is still a 204");
  assert.equal((await dismiss(one.headers, "DELETE")).status, 204);
  assert.deepEqual(await listDiscoveryDismissals(one.accountId), []);
});

test("a dismissed or out-of-market notice is excluded from the visible list", () => {
  const items = [
    { externalId: "1", markets: ["IRL"] },
    { externalId: "2", markets: ["IRL"] },
    { externalId: "3", markets: ["DEU"] },
    { externalId: "4" },
  ];
  const visible = visibleNotices(items, {
    dismissals: [{ externalId: "2", source: "etenders" }],
    sourceOf: () => "etenders",
    countries: ["IRL"],
  });
  assert.deepEqual(visible.map((item) => item.externalId), ["1", "4"],
    "the dismissed notice and the German-only notice are hidden; unlabelled stays");
});

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------

test("the CSV export is quoted properly, tenant-scoped, and viewer-readable", async () => {
  const { user, accountId, headers, email } = await makeUser("Export Ltd");
  await makeTender(accountId, {
    title: 'Big "quoted", tender', authority: "Export Authority",
    deadline: "26/03/2027", estimatedValue: "€250,000",
    metadata: { "CPV Codes": "72000000" },
  });
  await makeTender(accountId, {
    title: "Won work", metadata: { workflow: { stage: "DONE", outcome: "WON", assignee: "", priority: "MEDIUM", history: [] } },
  });
  const other = await makeUser("Export Other Ltd");
  await makeTender(other.accountId, { title: "other-tenant-tender-xyz" });

  const response = await fetch(`${base}/api/tenders/export.csv`, { headers });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/csv/);
  assert.match(response.headers.get("content-disposition") ?? "", /attachment; filename="tenderly-tenders\.csv"/);
  const text = await response.text();
  const lines = text.trim().split("\n");
  assert.equal(lines[0], '"id","title","authority","cpv","value","deadline","stage","outcome","sourceUrl"');
  assert.equal(lines.length, 3, "two tenders, one header");
  assert.ok(text.includes('"Big ""quoted"", tender"'), "embedded quotes double and the comma stays inside the cell");
  assert.ok(text.includes('"72000000"'));
  assert.ok(text.includes('"DONE","WON"'), "stage and outcome come from the workflow");
  assert.ok(!text.includes("other-tenant-tender-xyz"), "no other tenant's row");

  // A viewer on the same workspace may export: reads are theirs too.
  const viewer = await createUserWithoutOrganisation(`viewer-${Date.now()}@example.test`, await bcrypt.hash("x", 4));
  await addMembership(accountId, viewer.id, "viewer", user.id);
  const viewerHeaders = { authorization: "Bearer " + signToken({ id: viewer.id, organisationId: accountId, email: viewer.email }) };
  const viewerResponse = await fetch(`${base}/api/tenders/export.csv`, { headers: viewerHeaders });
  assert.equal(viewerResponse.status, 200, "a viewer may export the board they can read");
  assert.ok((await viewerResponse.text()).includes("Export Authority"));

  // But a viewer may not dismiss: that changes the workspace.
  const dismissResponse = await fetch(`${base}/api/tenders/discover/dismiss`, {
    method: "POST", headers: { ...viewerHeaders, "content-type": "application/json" },
    body: JSON.stringify({ externalId: "1", source: "etenders" }),
  });
  assert.equal(dismissResponse.status, 403);
  void email;
});

// ---------------------------------------------------------------------------
// Portal connection
// ---------------------------------------------------------------------------

test("without TENDERLY_PORTAL_KEY the feature is disabled, never half-on", async () => {
  const saved = process.env.TENDERLY_PORTAL_KEY;
  delete process.env.TENDERLY_PORTAL_KEY;
  try {
    const { headers } = await makeUser("Portal Disabled Ltd");
    const get = await fetch(`${base}/api/portal/connection`, { headers });
    const state = await get.json() as PortalConnection;
    assert.equal(state.status, "disabled");
    assert.equal(state.connected, false);

    const put = await fetch(`${base}/api/portal/connection`, {
      method: "PUT", headers, body: JSON.stringify({ email: "user@example.test", password: "secret-password-1" }),
    });
    assert.equal(put.status, 503);
    assert.match((await put.json() as { error: string }).error, /not enabled/);
    assert.equal(await getPortalConnection((await makeUser("Portal Disabled 2 Ltd")).accountId), null);
  } finally {
    if (saved === undefined) delete process.env.TENDERLY_PORTAL_KEY; else process.env.TENDERLY_PORTAL_KEY = saved;
  }
});

test("with the key, credentials encrypt at rest and never come back out", async () => {
  const saved = process.env.TENDERLY_PORTAL_KEY;
  process.env.TENDERLY_PORTAL_KEY = "test-portal-key-0123456789abcdef";
  try {
    const { accountId, headers } = await makeUser("Portal Connected Ltd");
    const password = "correct horse battery staple";
    const put = await fetch(`${base}/api/portal/connection`, {
      method: "PUT", headers, body: JSON.stringify({ email: "Bid.Team@Example.test", password }),
    });
    assert.equal(put.status, 200);
    const state = await put.json() as PortalConnection;
    assert.equal(state.connected, true);
    assert.equal(state.status, "untested", "saving proves nothing about whether the credentials work");
    assert.ok(state.email?.includes("***"), "the email is masked");
    assert.ok(!JSON.stringify(state).includes(password), "the password is never returned");

    const get = await fetch(`${base}/api/portal/connection`, { headers });
    const fetched = (await get.json()) as PortalConnection;
    // Field-wise: the middleware appends a per-request id, which differs by design.
    assert.equal(fetched.connected, state.connected);
    assert.equal(fetched.email, state.email);
    assert.equal(fetched.status, state.status);
    assert.equal(fetched.verifiedAt, state.verifiedAt);
    assert.equal(fetched.lastSyncAt, state.lastSyncAt);
    assert.equal(fetched.error, state.error);

    const stored = await getPortalConnection(accountId);
    assert.ok(stored, "the connection row exists");
    assert.ok(!stored.passwordEncrypted.includes(password), "the stored column is ciphertext");
    assert.equal(decryptPortalPassword(stored.passwordEncrypted), password, "and it decrypts under the key");

    const del = await fetch(`${base}/api/portal/connection`, { method: "DELETE", headers });
    assert.equal(del.status, 204);
    assert.equal(await getPortalConnection(accountId), null);
  } finally {
    if (saved === undefined) delete process.env.TENDERLY_PORTAL_KEY; else process.env.TENDERLY_PORTAL_KEY = saved;
  }
});

test("the AES-256-GCM envelope round-trips and refuses tampering", () => {
  const saved = process.env.TENDERLY_PORTAL_KEY;
  process.env.TENDERLY_PORTAL_KEY = "round-trip-key";
  try {
    const envelope = encryptPortalPassword("p@ssword with spaces & síneadh fada");
    assert.match(envelope, /^v1\./);
    assert.equal(decryptPortalPassword(envelope), "p@ssword with spaces & síneadh fada");
    const tampered = `${envelope.slice(0, -4)}AAAA`;
    assert.throws(() => decryptPortalPassword(tampered));
    process.env.TENDERLY_PORTAL_KEY = "a-different-key";
    assert.throws(() => decryptPortalPassword(envelope), "a different key must not open it");
  } finally {
    if (saved === undefined) delete process.env.TENDERLY_PORTAL_KEY; else process.env.TENDERLY_PORTAL_KEY = saved;
  }
});

test("encrypting without a key is a hard failure, not a silent plaintext store", () => {
  const saved = process.env.TENDERLY_PORTAL_KEY;
  delete process.env.TENDERLY_PORTAL_KEY;
  try {
    assert.throws(() => encryptPortalPassword("anything"), /PORTAL_DISABLED/);
  } finally {
    if (saved === undefined) delete process.env.TENDERLY_PORTAL_KEY; else process.env.TENDERLY_PORTAL_KEY = saved;
  }
});

// ---------------------------------------------------------------------------
// Portal client (fixture-only: this never touches the live portal)
// ---------------------------------------------------------------------------

const portalFixture = (name: string) =>
  readFileSync(path.resolve(process.cwd(), "tests/fixtures/portal", name), "utf8");

function portalFetch(pages: { loginResult?: "ok" | "failed"; workspace?: string; messages?: string; sendResult?: string }) {
  const calls: { url: string; method: string; body?: string }[] = [];
  const fetchImpl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? String(init.body) : undefined });
    if (url.endsWith("/epps/home.do")) return new Response(portalFixture("login.html"));
    if (url.includes("/epps/loginAction.do")) {
      if (pages.loginResult === "failed") return new Response(portalFixture("login-failed.html"));
      return new Response("<html><body><h1>Welcome to eTenders</h1></body></html>", {
        headers: { "set-cookie": "JSESSIONID=fixture-session; Path=/epps; Secure" },
      });
    }
    if (url.includes("prepareViewCfTWS.do")) return new Response(portalFixture(pages.workspace ?? "workspace.html"));
    if (url.includes("viewCfTMessaging.do")) return new Response(portalFixture(pages.messages ?? "messages.html"));
    if (url.includes("sendMessage.do")) return new Response(portalFixture(pages.sendResult ?? "message-sent.html"));
    throw new Error(`fixture has no page for ${url}`);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

test("portal client: sign-in succeeds and returns a session cookie", async () => {
  const { fetchImpl, calls } = portalFetch({});
  const session = await portalLogin({ email: "bidder@example.test", password: "pw" }, { fetchImpl });
  assert.ok(session.cookies.includes("JSESSIONID=fixture-session"));
  const loginCall = calls.find((call) => call.url.includes("loginAction"));
  assert.ok(loginCall?.body?.includes("username=bidder%40example.test"), "the discovered form fields are posted");
  assert.ok(loginCall?.body?.includes("org.apache.struts.taglib.html.TOKEN=abc123token"), "hidden fields ride along");
});

test("portal client: a refused sign-in is PORTAL_AUTH_FAILED", async () => {
  const { fetchImpl } = portalFetch({ loginResult: "failed" });
  await assert.rejects(
    portalLogin({ email: "bidder@example.test", password: "wrong" }, { fetchImpl }),
    (error: unknown) => error instanceof PortalError && error.code === "PORTAL_AUTH_FAILED",
  );
});

test("portal client: a redesigned login page is PORTAL_LAYOUT_CHANGED", async () => {
  const redesigning = (async () => new Response(portalFixture("redesign.html"))) as typeof fetch;
  await assert.rejects(
    portalLogin({ email: "bidder@example.test", password: "pw" }, { fetchImpl: redesigning }),
    (error: unknown) => error instanceof PortalError && error.code === "PORTAL_LAYOUT_CHANGED",
  );
});

test("portal client: the messaging exchange parses with ids and directions", async () => {
  const { fetchImpl } = portalFetch({});
  const session = await portalLogin({ email: "bidder@example.test", password: "pw" }, { fetchImpl });
  const messages = await listPortalMessages(session, "248591", { fetchImpl });
  assert.equal(messages.length, 2);
  assert.deepEqual(
    messages.map((entry) => [entry.messageId, entry.direction, entry.subject]),
    [["77120", "in", "Extension of closing date"], ["77002", "out", "Question about lot structure"]],
  );
  assert.equal(messages[0].sentOn, "12/10/2026 09:41");
});

test("portal client: a workspace with no messaging link is a layout failure, not an empty inbox", async () => {
  const { fetchImpl } = portalFetch({ workspace: "redesign.html" });
  const session = await portalLogin({ email: "bidder@example.test", password: "pw" }, { fetchImpl });
  await assert.rejects(
    listPortalMessages(session, "248591", { fetchImpl }),
    (error: unknown) => error instanceof PortalError && error.code === "PORTAL_LAYOUT_CHANGED",
  );
});

test("portal client: a confirmed send returns the portal's message id", async () => {
  const { fetchImpl, calls } = portalFetch({});
  const session = await portalLogin({ email: "bidder@example.test", password: "pw" }, { fetchImpl });
  const sent = await sendPortalMessage(session, "248591", { subject: "Clarification on insurance threshold", body: "Is €6.5m required?" }, { fetchImpl });
  assert.equal(sent.messageId, "77210");
  const send = calls.find((call) => call.url.includes("sendMessage"));
  assert.equal(send?.method, "POST");
  assert.ok(send?.body?.includes("resourceId=248591"), "the portal's own CfT reference goes back untouched");
  assert.ok(send?.body?.includes("messageText="));
});

test("portal client: an unconfirmed send is a failure, never a fabricated success", async () => {
  const { fetchImpl } = portalFetch({ sendResult: "redesign.html" });
  const session = await portalLogin({ email: "bidder@example.test", password: "pw" }, { fetchImpl });
  await assert.rejects(
    sendPortalMessage(session, "248591", { subject: "S", body: "B" }, { fetchImpl }),
    (error: unknown) => error instanceof PortalError,
  );
});

// ---------------------------------------------------------------------------
// Clarification send/sync fallbacks
// ---------------------------------------------------------------------------

test("send without a connection is a 503 carrying the official deep link", async () => {
  const saved = process.env.TENDERLY_PORTAL_KEY;
  process.env.TENDERLY_PORTAL_KEY = "send-test-key";
  try {
    const { accountId, headers } = await makeUser("Clar Send Ltd");
    const tender = await makeTender(accountId, { externalId: "248591" });
    const response = await fetch(`${base}/api/tenders/${tender.id}/clarifications/send`, {
      method: "POST", headers, body: JSON.stringify({ subject: "Insurance", question: "Is €6.5m required?" }),
    });
    assert.equal(response.status, 503);
    const body = await response.json() as { error: string; portalUrl: string };
    assert.equal(body.portalUrl, "https://www.etenders.gov.ie/epps/cft/prepareViewCfTWS.do?resourceId=248591");
    assert.equal((await listClarifications(tender.id)).length, 0, "nothing is recorded as sent when nothing was sent");
  } finally {
    if (saved === undefined) delete process.env.TENDERLY_PORTAL_KEY; else process.env.TENDERLY_PORTAL_KEY = saved;
  }
});

test("sync without a connection answers synced 0 with a warning, not invented messages", async () => {
  const { accountId, headers } = await makeUser("Clar Sync Ltd");
  const tender = await makeTender(accountId, { externalId: "248591" });
  await recordClarification({
    tenderId: tender.id, question: "Recorded by hand", askedOn: "2026-10-30", askedBy: "me@example.test",
    response: "", respondedOn: "", origin: "manual",
  });
  const response = await fetch(`${base}/api/tenders/${tender.id}/clarifications/sync`, { method: "POST", headers, body: "{}" });
  assert.equal(response.status, 200);
  const body = await response.json() as { items: { question: string }[]; synced: number; warning?: string };
  assert.equal(body.synced, 0);
  assert.ok(body.warning);
  assert.deepEqual(body.items.map((item) => item.question), ["Recorded by hand"]);
});

test("clarifications carry the portal fields through both directions", async () => {
  const { accountId } = await makeUser("Clar Fields Ltd");
  const tender = await makeTender(accountId, {});
  await recordClarification({
    tenderId: tender.id, question: "Is the site visit mandatory?", subject: "Site visit",
    askedOn: "2026-10-01", askedBy: "me@example.test", response: "", respondedOn: "",
    direction: "out", origin: "portal", portalMessageId: "77002",
  });
  const [entry] = await listClarifications(tender.id);
  assert.equal(entry.subject, "Site visit");
  assert.equal(entry.direction, "out");
  assert.equal(entry.origin, "portal");
  assert.equal(entry.portalMessageId, "77002");
  // and a bare manual record defaults sensibly
  await recordClarification({
    tenderId: tender.id, question: "plain", askedOn: "2026-10-02", askedBy: "me@example.test", response: "", respondedOn: "",
  });
  const plain = (await listClarifications(tender.id)).find((item) => item.question === "plain");
  assert.equal(plain?.origin, "manual");
  assert.equal(plain?.direction, "out");
  assert.equal(plain?.portalMessageId, null);
});

// ---------------------------------------------------------------------------
// TED multi-market
// ---------------------------------------------------------------------------

test("cpvCountryQuery ORs markets; irishCpvQuery stays the Ireland wrapper", () => {
  assert.equal(
    cpvCountryQuery(["72000000", "71300000"], ["IRL", "DEU"]),
    "(classification-cpv=72* OR classification-cpv=713*) AND (place-of-performance=IRL OR place-of-performance=DEU)",
  );
  assert.equal(cpvCountryQuery(["72000000"], []), "(classification-cpv=72*) AND (place-of-performance=IRL)", "empty means Ireland, as before");
  assert.equal(irishCpvQuery(["72000000"]), cpvCountryQuery(["72000000"], ["IRL"]));
  assert.throws(() => cpvCountryQuery(["72000000"], ["IRELAND"]), /Invalid TED country/);
  assert.throws(() => cpvCountryQuery(["72000000"], ['IRL") OR (1=1 --']), /Invalid TED country/, "no query smuggling");
});

test("TED markets come from place-of-performance, falling back to Ireland", () => {
  assert.deepEqual(noticeMarkets({ "place-of-performance": ["irl", "deu"] }), ["IRL", "DEU"]);
  assert.deepEqual(noticeMarkets({ "place-of-performance": "FRA" }), ["FRA"]);
  assert.deepEqual(noticeMarkets({}), ["IRL"]);
  const mapped = noticeToPublicTender({
    "publication-number": "123456-2026", "notice-title": { eng: "Cross-border IT" },
    "buyer-name": { eng: ["A Buyer"] }, "place-of-performance": ["DEU", "IRL"],
  });
  assert.deepEqual(mapped?.markets, ["DEU", "IRL"]);
});

test("searchAllTed builds a multi-country query when asked", async () => {
  const bodies: string[] = [];
  const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
    bodies.push(String(init?.body ?? ""));
    return Response.json({ notices: [] });
  }) as typeof fetch;
  await searchAllTed({ countries: ["IRL", "FRA"], fetchImpl });
  const query = JSON.parse(bodies[0]).query as string;
  assert.ok(query.includes("place-of-performance=IRL OR place-of-performance=FRA"), query);
  assert.ok(query.includes("deadline-receipt-request>="), "the rolling deadline floor stays");
});

test("markets gate matching: only watched markets are ingested", () => {
  assert.equal(marketsWatched({ markets: ["DEU"] }, ["IRL"]), false);
  assert.equal(marketsWatched({ markets: ["DEU", "IRL"] }, ["IRL"]), true);
  assert.equal(marketsWatched({}, ["IRL"]), true, "no market data never hides a notice");
  assert.deepEqual(accountCountries({ countries: ["IRL"] }, [{ countries: undefined }, { countries: ["FRA"] }]), ["IRL", "FRA"]);
  assert.deepEqual(accountCountries({ countries: ["IRL"] }, []), ["IRL"]);
});

// ---------------------------------------------------------------------------
// Preferences and boards: countries
// ---------------------------------------------------------------------------

test("preferences default to Ireland and normalise codes", async () => {
  const { accountId, headers } = await makeUser("Prefs Defaults Ltd");
  assert.deepEqual((await getPreferences(accountId)).countries, ["IRL"]);

  await savePreferences(accountId, { sectors: [], keywords: [], cpvCodes: [], valueMin: null, valueMax: null, countries: ["deu", "irl", "deu"] });
  assert.deepEqual((await getPreferences(accountId)).countries, ["DEU", "IRL"], "upper-cased and deduplicated");

  // A client that never sends countries must not wipe the stored ones.
  const put = await fetch(`${base}/api/preferences`, {
    method: "PUT", headers,
    body: JSON.stringify({ sectors: [], keywords: [], cpvCodes: [], valueMin: null, valueMax: null }),
  });
  assert.equal(put.status, 200);
  const { preferences } = await put.json() as { preferences: { countries: string[] } };
  assert.deepEqual(preferences.countries, ["DEU", "IRL"]);

  const get = await fetch(`${base}/api/preferences`, { headers });
  assert.deepEqual(((await get.json()) as { preferences: { countries: string[] } }).preferences.countries, ["DEU", "IRL"]);
});

test("boards carry their own markets, omitted means workspace-wide", async () => {
  const { accountId, headers } = await makeUser("Board Countries Ltd");
  const created = await fetch(`${base}/api/tender-boards`, {
    method: "POST", headers,
    body: JSON.stringify({ name: "DACH", cpvCodes: ["72000000"], countries: ["deu", "aut"] }),
  });
  assert.equal(created.status, 201);
  const { board } = await created.json() as { board: { countries?: string[] } };
  assert.deepEqual(board.countries, ["DEU", "AUT"]);

  const boards = await listTenderBoards(accountId);
  const dach = boards.find((entry) => entry.name === "DACH");
  assert.deepEqual(dach?.countries, ["DEU", "AUT"]);
  const defaultBoard = boards.find((entry) => entry.name === "IT services");
  assert.equal(defaultBoard?.countries, undefined, "no board list means the workspace countries apply");
});

// ---------------------------------------------------------------------------
// Serialisation: markets and the messaging deep link
// ---------------------------------------------------------------------------

test("serialised tenders carry markets; eTenders tenders carry the messaging link", async () => {
  const { accountId, headers } = await makeUser("Serial Markets Ltd");
  const etenders = await makeTender(accountId, { externalId: "248591" });
  const ted = await makeTender(accountId, {
    source: "ted", sourceUrl: "https://ted.europa.eu/en/notice/123456-2026/pdf",
    metadata: { markets: ["FRA", "DEU"] },
  });
  const tedFallback = await makeTender(accountId, { source: "ted", sourceUrl: "https://ted.europa.eu/en/notice/123457-2026/pdf" });

  const one = await fetch(`${base}/api/tenders/${etenders.id}`, { headers });
  const first = (await one.json() as { tender: { messagingUrl?: string; markets?: string[] } }).tender;
  assert.equal(first.messagingUrl, "https://www.etenders.gov.ie/epps/cft/prepareViewCfTWS.do?resourceId=248591");
  assert.deepEqual(first.markets, ["IRL"]);

  const two = await fetch(`${base}/api/tenders/${ted.id}`, { headers });
  const second = (await two.json() as { tender: { messagingUrl?: string; markets?: string[] } }).tender;
  assert.equal(second.messagingUrl, undefined, "TED has no eTenders messaging page");
  assert.deepEqual(second.markets, ["FRA", "DEU"]);

  const three = await fetch(`${base}/api/tenders/${tedFallback.id}`, { headers });
  const third = (await three.json() as { tender: { markets?: string[] } }).tender;
  assert.deepEqual(third.markets, ["IRL"], "a TED notice with no recorded market stays Ireland");
});

test("listBuyers formats the awarded value or says nothing", async () => {
  const { accountId } = await makeUser("Buyer Values Ltd");
  await makeTender(accountId, { authority: "Valueless Council" });
  await saveAwards([
    { externalId: "v-1", authority: "Valueless Council", title: "Unpriced", cpv: "72000000", cpvDescription: "", procedure: "", publishedOn: null, awardedOn: "2025-01-01", awardedValue: null, estimatedValue: null, suppliers: "Someone", bidsReceived: null, smeBidsReceived: null },
  ]);
  const buyers = await listBuyers(accountId);
  const entry = buyers.find((buyer) => buyer.name === "Valueless Council");
  assert.equal(entry?.awards, 1);
  assert.equal(entry?.awardedValue, null, "an unpriced award is a count, not an invented euro figure");
});
