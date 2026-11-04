import "./helpers/env.js";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { signToken } from "../src/auth.js";
import {
  addMembership, createUser, getTender, initializeDatabase, listTenderBoards,
  saveDocument, updateTenderWorkflow, upsertTender,
} from "../src/db.js";
import { changeWorkflow, tenderWorkflow, workflowPatchSchema } from "../src/tender-workflow.js";
import { deadlineInstant } from "../src/pressure.js";
import { cpvFamilyMatch, decideIngest } from "../src/ingest.js";
import { serializeTender } from "../src/serializers.js";
import type { TenderStage } from "@tenderly/shared";

await initializeDatabase();
const { app } = await import("../src/index.js");
const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const address = server.address();
assert.ok(address && typeof address === "object");
const base = `http://127.0.0.1:${address.port}`;
after(() => server.close());

const owner = await createUser(`tracker-${crypto.randomUUID()}@example.test`, "not-a-login-hash", "Tracker Ltd");
const stranger = await createUser(`other-${crypto.randomUUID()}@example.test`, "not-a-login-hash", "Other Ltd");
const viewer = await createUser(`viewer-${crypto.randomUUID()}@example.test`, "not-a-login-hash", "Reader Ltd");
await addMembership(owner.organisationId, viewer.id, "viewer");
const token = signToken({ id: owner.id, organisationId: owner.organisationId, email: owner.email });
const otherToken = signToken({ id: stranger.id, organisationId: stranger.organisationId, email: stranger.email });
const viewerToken = signToken({ id: viewer.id, organisationId: owner.organisationId, email: viewer.email, role: "viewer" });
const notice = {
  source: "etenders", externalId: "tracker-123456", title: "Application development",
  authority: "Example buyer", procedure: "Open", deadline: "26/03/2030 17:00",
  published: "01/01/2026", estimatedValue: "200,000.00", description: "Develop and support applications.",
  sourceUrl: "https://www.etenders.gov.ie/epps/cft/prepareViewCfTWS.do?resourceId=123456",
  status: "IMPORTED", metadata: { "CPV Codes": "72212000", noticeFields: { Description: "Develop applications.", "Custom field": "Published detail" } },
};
const tender = await upsertTender(owner.organisationId, notice);
const request = (path: string, method = "GET", body?: unknown, auth = token) => fetch(base + path, {
  method, headers: { authorization: `Bearer ${auth}`, "content-type": "application/json" },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

test("new tenders default to New; no automatic Review or result", () => {
  assert.deepEqual(tenderWorkflow(undefined), { stage: "NEW", outcome: "PENDING", priority: "MEDIUM", assignee: "", history: [] });
  assert.equal(serializeTender(tender).workflow?.stage, "NEW");
});

test("all tender lifecycle stages are reachable and append attributed history", () => {
  let workflow = tenderWorkflow(undefined);
  for (const stage of ["REVIEW", "CONSIDER", "APPLICATION", "DONE", "IGNORE", "NEW"] as TenderStage[]) {
    const previous = workflow;
    workflow = changeWorkflow(workflow, { stage }, "owner@example.test");
    assert.equal(workflow.stage, stage);
    assert.equal(workflow.history.length, previous.history.length + 1);
    assert.equal(workflow.history.at(-1)?.actor, "owner@example.test");
    assert.deepEqual(workflow.history.slice(0, -1), previous.history);
  }
});

test("Won and Not won close the tender; reopening clears the old result", () => {
  for (const outcome of ["WON", "NOT_WON"] as const) {
    const done = changeWorkflow(tenderWorkflow(undefined), { outcome }, "owner");
    assert.equal(done.stage, "DONE");
    assert.equal(done.outcome, outcome);
    const reopened = changeWorkflow(done, { stage: "REVIEW" }, "owner");
    assert.equal(reopened.outcome, "PENDING");
    assert.equal(reopened.stage, "REVIEW");
  }
});

test("workflow schema rejects unknown fields, enum values, empty patches and oversized notes", () => {
  for (const patch of [{}, { stage: "OTHER" }, { outcome: "YES" }, { priority: "URGENT" }, { history: [] }, { comment: " " }, { comment: "x".repeat(4001) }]) {
    assert.equal(workflowPatchSchema.safeParse(patch).success, false, JSON.stringify(patch).slice(0, 100));
  }
  assert.deepEqual(workflowPatchSchema.parse({ assignee: " Owner ", comment: " Reviewed " }), { assignee: "Owner", comment: "Reviewed" });
});

test("no-op updates do not manufacture activity", () => {
  const current = tenderWorkflow(undefined);
  assert.deepEqual(changeWorkflow(current, { stage: "NEW" }, "owner").history, []);
});

test("workflow API persists stage, owner, priority and comment across GETs", async () => {
  const response = await request(`/api/tenders/${tender.id}/workflow`, "PATCH", { stage: "APPLICATION", priority: "HIGH", assignee: "Bid lead", comment: "Prepare application" });
  assert.equal(response.status, 200);
  const loaded = await request(`/api/tenders/${tender.id}`);
  const body = await loaded.json();
  assert.equal(body.tender.workflow.stage, "APPLICATION");
  assert.equal(body.tender.workflow.assignee, "Bid lead");
  assert.equal(body.tender.workflow.priority, "HIGH");
  assert.match(body.tender.workflow.history.at(-1).message, /Prepare application/);
  assert.equal(body.tender.noticeFields["Custom field"], "Published detail");
});

test("reimport updates source facts without resetting workflow or history", async () => {
  const before = await getTender(owner.organisationId, tender.id);
  const workflow = structuredClone(before?.metadata.workflow);
  const refreshed = await upsertTender(owner.organisationId, { ...notice, deadline: "27/03/2030 17:00", description: "Updated scope", metadata: { ...notice.metadata, workflow: tenderWorkflow(undefined) } });
  assert.equal(refreshed.id, tender.id);
  assert.equal(refreshed.description, "Updated scope");
  assert.deepEqual(refreshed.metadata.workflow, workflow);
  assert.equal(serializeTender(refreshed).deadline, "27/03/2030 17:00");
  assert.equal(serializeTender(refreshed).sourceDescription, "Updated scope");
  const changes = serializeTender(refreshed).sourceChanges ?? [];
  assert.ok(changes.some((change) => change.field === "deadline" && change.from === notice.deadline));
  assert.ok(changes.some((change) => change.field === "description" && change.to === "Updated scope"));
});

test("cross-tenant workflow, refresh and attachment requests reveal no tender data", async () => {
  for (const [path, method, body] of [
    [`/api/tenders/${tender.id}/workflow`, "PATCH", { stage: "REVIEW" }],
    [`/api/tenders/${tender.id}/refresh`, "POST", {}],
    [`/api/tenders/${tender.id}/documents/missing/file`, "GET", undefined],
  ] as const) {
    const response = await request(path, method, body, otherToken);
    assert.equal(response.status, 404, path);
    assert.doesNotMatch(await response.text(), /Application development|Updated scope/);
  }
});

test("viewer can read but cannot change workflow, boards, refresh or sync", async () => {
  assert.equal((await request(`/api/tenders/${tender.id}`, "GET", undefined, viewerToken)).status, 200);
  for (const [path, method, body] of [
    [`/api/tenders/${tender.id}/workflow`, "PATCH", { stage: "IGNORE" }],
    ["/api/tender-boards", "POST", { name: "Blocked", cpvCodes: ["72000000"] }],
    [`/api/tenders/${tender.id}/refresh`, "POST", {}],
    ["/api/tenders/sync", "POST", {}],
  ] as const) assert.equal((await request(path, method, body, viewerToken)).status, 403, path);
});

test("workspace attachments are listed and downloaded only by their tenant", async () => {
  const document = await saveDocument({ tenderId: tender.id, filename: "Published RFT.txt", mimeType: "text/plain", role: "source", sourceUrl: notice.sourceUrl, bytes: Buffer.from("Published contract terms"), extractedText: "Published contract terms", extractionStatus: "EXTRACTED" });
  const loaded = await request(`/api/tenders/${tender.id}`).then((res) => res.json());
  assert.ok(loaded.tender.attachments.some((item: { id: string }) => item.id === document.id));
  const path = `/api/tenders/${tender.id}/documents/${document.id}/file`;
  const response = await request(path);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "Published contract terms");
  assert.equal((await request(path, "GET", undefined, otherToken)).status, 404);
});

test("CPV boards have a persistent IT default and validate every CPV", async () => {
  const first = await listTenderBoards(owner.organisationId);
  assert.deepEqual(first[0].cpvCodes, ["72000000"]);
  assert.deepEqual(await listTenderBoards(owner.organisationId), first);
  for (const cpvCodes of [[], ["123"], ["00000000"], ["99999999"]]) {
    assert.equal((await request("/api/tender-boards", "POST", { name: "Invalid", cpvCodes })).status, 400);
  }
  const created = await request("/api/tender-boards", "POST", { name: "Software", cpvCodes: ["72200000", "72200000", "72500000"] });
  assert.equal(created.status, 201);
  const { board } = await created.json();
  assert.deepEqual(board.cpvCodes, ["72200000", "72500000"]);
  assert.equal((await request("/api/tender-boards", "POST", { name: "Software", cpvCodes: ["72200000"] })).status, 409);
  assert.equal((await request(`/api/tender-boards/${board.id}`, "DELETE", undefined, otherToken)).status, 404);
  assert.equal((await request(`/api/tender-boards/${board.id}`, "DELETE")).status, 200);
  assert.ok(await getTender(owner.organisationId, tender.id), "removing a board must keep the tender");
  assert.equal((await request(`/api/tender-boards/${first[0].id}`, "DELETE")).status, 409);
});

test("workflow API refuses invalid patches without changing the saved record", async () => {
  const before = structuredClone((await getTender(owner.organisationId, tender.id))?.metadata.workflow);
  assert.equal((await request(`/api/tenders/${tender.id}/workflow`, "PATCH", { stage: "INVALID" })).status, 400);
  assert.deepEqual((await getTender(owner.organisationId, tender.id))?.metadata.workflow, before);
  assert.equal(await updateTenderWorkflow(stranger.organisationId, tender.id, { stage: "IGNORE" }, "stranger"), null);
});

test("TED source notices can be opened as New tenders without running qualification", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    if (String(input).startsWith("https://api.ted.europa.eu/")) {
      return Response.json({ notices: [{ "publication-number": "123-2030", "notice-title": { eng: "TED application services" }, "buyer-name": { eng: ["Example buyer"] }, "classification-cpv": ["72212000"], "deadline-receipt-request": ["2030-01-01T12:00:00Z"] }] });
    }
    return original(input, init);
  }) as typeof fetch;
  try {
    const response = await request("/api/tenders/import", "POST", { url: "https://ted.europa.eu/en/notice/123-2030/pdf" });
    assert.equal(response.status, 201);
    const { tender: imported } = await response.json();
    assert.equal(imported.title, "TED application services");
    assert.equal(imported.workflow.stage, "NEW");
    assert.equal(imported.match, 0);
    assert.equal(imported.cpv.code, "72212000");
  } finally { globalThis.fetch = original; }
});

test("secondary CPV codes match the whole IT family without any score threshold", () => {
  assert.equal(cpvFamilyMatch("Main 79400000; additional 72212000", ["72000000"]), "72000000");
  assert.equal(decideIngest({ deadline: "01/01/2030", noticeCpv: "79400000, 72212000", profileCpvCodes: ["72000000"], score: 0, threshold: 100 }).ingest, true);
});

test("closing times, summer time and Java-format portal dates do not drop open tenders", () => {
  assert.equal(deadlineInstant("26/03/2026 17:00")?.toISOString(), "2026-03-26T17:00:00.000Z");
  assert.equal(deadlineInstant("26/08/2026 17:00")?.toISOString(), "2026-08-26T16:00:00.000Z");
  assert.equal(deadlineInstant("Tue Nov 03 15:18:45 GMT 2026")?.toISOString(), "2026-11-03T15:18:45.000Z");
  const args = { deadline: "26/03/2026 17:00", noticeCpv: "72000000", profileCpvCodes: ["72000000"], score: 0, threshold: 100 };
  assert.equal(decideIngest({ ...args, now: new Date("2026-03-26T12:00:00Z") }).ingest, true);
  assert.equal(decideIngest({ ...args, now: new Date("2026-03-26T17:00:00Z") }).ingest, false);
  assert.equal(decideIngest({ ...args, deadline: "26/03/2026", now: new Date("2026-03-26T20:00:00Z") }).ingest, true);
  assert.equal(deadlineInstant("31/02/2026 17:00"), null);
});
