import "./helpers/env.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { cpvSearchUrl, discoverETenders } from "../src/etenders.js";
import { searchAllTed } from "../src/sources/ted.js";
import { createUser, getTender, initializeDatabase, listTenders, updateTenderWorkflow, upsertTender } from "../src/db.js";
import { runDiscoveryJob } from "../src/jobs.js";

const row = (id: number) => `<tr><td>1</td><td><a href="/epps/cft/prepareViewCfTWS.do?resourceId=${id}">Software ${id}</a></td><td>${id}</td><td>Buyer ${id}</td><td><img title="Develop accessible software"></td><td>Tue Jan 01 10:00:00 GMT 2019</td><td>01/01/2030 17:00</td><td>Open</td><td>Tender Submission</td><td></td><td></td><td>200,000</td></tr>`;
const detail = (id: string) => `<dl><dt>Title:</dt><dd>Software ${id}</dd><dt>Name of Contracting Authority:</dt><dd>Buyer ${id}</dd><dt>Description:</dt><dd>Develop accessible software ${id}</dd><dt>CPV Codes:</dt><dd>79400000, 72212000</dd><dt>Time-limit for receipt of tenders or requests to participate:</dt><dd>01/01/2030 17:00</dd><dt>Estimated value (EUR):</dt><dd>200,000</dd><dt>Contact Point:</dt><dd>procurement@example.test</dd></dl>`;
const rawNotice = (id: number, type = "cn-standard") => ({ "publication-number": `${id}-2030`, "notice-title": { eng: `Software ${id}` }, "notice-type": type, "classification-cpv": ["72212000"], "deadline-receipt-request": ["2030-01-01T12:00:00Z"] });

test("CPV search expands children and requests open tender submissions", () => {
  const url = new URL(cpvSearchUrl(["72000000"]));
  assert.equal(url.searchParams.get("status"), "cft.status.tender.submission");
  assert.ok(url.searchParams.get("cpvLabels")?.split(",").includes("72212000"));
});

test("TED pagination uses raw page size even when most notices are excluded", async () => {
  const pages: number[] = [];
  const result = await searchAllTed({ fetchImpl: (async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    pages.push(body.page);
    assert.match(body.query, /deadline-receipt-request>=\d{8}/);
    return Response.json({ notices: body.page === 1 ? Array.from({ length: 100 }, (_, n) => rawNotice(n, "can-standard")) : [rawNotice(100)] });
  }) as typeof fetch });
  assert.deepEqual(pages, [1, 2]);
  assert.deepEqual(result.items.map((item) => item.externalId), ["100-2030"]);
  assert.deepEqual(result.warnings, []);
});

test("TED does not stop at an invalid record and detects repeated pages", async () => {
  let page = 0;
  const result = await searchAllTed({ fetchImpl: (async () => Response.json({
    notices: ++page === 1 ? [...Array.from({ length: 99 }, (_, n) => rawNotice(n)), {}] : [rawNotice(100)],
  })) as typeof fetch });
  assert.equal(result.items.length, 100);
  assert.ok(result.warnings.some((warning) => warning.includes("no publication number")));
  const repeated = Array.from({ length: 100 }, (_, n) => rawNotice(n));
  await assert.rejects(searchAllTed({ fetchImpl: (async () => Response.json({ notices: repeated })) as typeof fetch }), /repeated/);
});

test("eTenders traverses every page and retains older publications with future deadlines", async () => {
  const original = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input) => {
    const url = new URL(String(input));
    urls.push(url.toString());
    const second = url.searchParams.has("page");
    const next = new URL(url);
    next.searchParams.set("page", "2");
    return new Response(`<table>${row(second ? 100002 : 100001)}</table>${second ? "" : `<button title="Next" href="${next}">Next</button>`}`);
  }) as typeof fetch;
  try {
    const result = await discoverETenders("", { delayMs: 200 });
    assert.equal(result.length, 2);
    assert.equal(result[0].description, "Develop accessible software");
    assert.ok(urls.length >= 2);
    assert.equal(urls.filter((url) => new URL(url).searchParams.has("page")).length, urls.length / 2);
    await assert.rejects(discoverETenders("", { maxPages: 1 }), /exceeded 1 pages/);
  } finally { globalThis.fetch = original; }
});

test("discovery ingests more than sixty zero-score CPV matches, refreshes tracked CFTs and preserves work", async () => {
  await initializeDatabase();
  const user = await createUser(`discovery-${crypto.randomUUID()}@example.test`, "not-a-login-hash", "Tracker company");
  const tracked = await upsertTender(user.organisationId, { source: "etenders", externalId: "999999", title: "Previous title", authority: "Buyer", description: "", sourceUrl: "https://www.etenders.gov.ie/epps/cft/prepareViewCfTWS.do?resourceId=999999", deadline: "01/01/2030", published: "", procedure: "Open", estimatedValue: "", status: "ANALYSED", metadata: {} });
  await updateTenderWorkflow(user.organisationId, tracked.id, { stage: "APPLICATION", comment: "Keep my application" }, user.email);
  const original = globalThis.fetch;
  const oldDelay = process.env.ETENDERS_REQUEST_DELAY_MS;
  process.env.ETENDERS_REQUEST_DELAY_MS = "200";
  const refreshed = new Set<string>();
  globalThis.fetch = (async (input) => {
    const url = new URL(String(input));
    if (url.hostname === "api.ted.europa.eu") return Response.json({ notices: [] });
    if (url.pathname.includes("viewCFTSAction")) return new Response(`<table>${Array.from({ length: 65 }, (_, n) => row(100000 + n)).join("")}</table>`);
    const id = url.searchParams.get("resourceId");
    assert.ok(id, "unexpected external request");
    refreshed.add(id);
    return new Response(detail(id));
  }) as typeof fetch;
  try {
    const result = await runDiscoveryJob(user.organisationId);
    assert.equal(result.enriched, 66);
    assert.equal(result.enrichmentDeferred, 0);
    assert.equal(result.tendersIngested, 66);
    assert.equal((await listTenders(user.organisationId)).length, 66);
    assert.equal(refreshed.size, 66);
    const stored = await getTender(user.organisationId, tracked.id);
    assert.equal(stored?.title, "Software 999999");
    assert.equal((stored?.metadata.workflow as { stage: string }).stage, "APPLICATION");
    assert.equal((stored?.metadata.workflow as { history: unknown[] }).history.length, 1);
    assert.deepEqual(stored?.metadata.contactEmails, ["procurement@example.test"]);
  } finally {
    globalThis.fetch = original;
    if (oldDelay === undefined) delete process.env.ETENDERS_REQUEST_DELAY_MS;
    else process.env.ETENDERS_REQUEST_DELAY_MS = oldDelay;
  }
});
