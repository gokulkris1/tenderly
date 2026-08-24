import assert from "node:assert/strict";
import test from "node:test";
import bcrypt from "bcryptjs";
import { signToken } from "../src/auth.js";
import { addEvidence, createUser, evidenceFile, initializeDatabase, listEvidence } from "../src/db.js";

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
  return { id: user.organisationId, email, token: signToken({ id: user.id, organisationId: user.organisationId, email }) };
}

const a = await makeAccount("vault-a");
const b = await makeAccount("vault-b");

// A minimal but genuine PDF, so the bytes that come back can be compared.
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n", "utf8");

async function upload(account: typeof a, over: Record<string, string> = {}, bytes = PDF) {
  const form = new FormData();
  form.set("file", new Blob([bytes], { type: "application/pdf" }), over.filename ?? "tax-clearance.pdf");
  form.set("kind", over.kind ?? "Tax clearance");
  form.set("name", over.name ?? "Tax clearance certificate");
  if (over.expiresOn !== undefined) form.set("expiresOn", over.expiresOn);
  if (over.issuingBody !== undefined) form.set("issuingBody", over.issuingBody);
  return fetch(`${base}/api/evidence/upload`, {
    method: "POST", headers: { authorization: `Bearer ${account.token}` }, body: form,
  });
}

test("TLY-53 AC1: an uploaded certificate keeps its kind, expiry and size", async () => {
  const response = await upload(a, { expiresOn: "31/12/2026", issuingBody: "Revenue" });
  assert.equal(response.status, 201);

  const items = await listEvidence(a.id);
  const item = items.find((entry) => entry.name === "Tax clearance certificate");
  assert.equal(item?.kind, "Tax clearance");
  assert.equal(item?.expiresOn, "31/12/2026");
  assert.equal(item?.issuingBody, "Revenue");
  assert.equal(item?.filename, "tax-clearance.pdf");
  assert.equal(item?.sizeBytes, PDF.length);
  assert.equal(item?.contentType, "application/pdf");
});

test("TLY-53 AC2: the original file comes back byte for byte", async () => {
  const items = await listEvidence(a.id);
  const item = items.find((entry) => entry.filename === "tax-clearance.pdf");
  assert.ok(item);

  const response = await fetch(`${base}/api/evidence/${item.id}/file`, { headers: { authorization: `Bearer ${a.token}` } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/pdf");
  assert.match(response.headers.get("content-disposition") ?? "", /tax-clearance\.pdf/);

  const returned = Buffer.from(await response.arrayBuffer());
  assert.ok(returned.equals(PDF), "the text extraction is a derivative; the file itself is what a buyer needs");
});

test("TLY-53 AC4: text-only evidence from before this change still reads, with no file", async () => {
  const legacy = await addEvidence(a.id, {
    kind: "Case study", name: "Legacy case study", content: "Delivered on time.", tags: [], verified: true,
  });
  const items = await listEvidence(a.id);
  const found = items.find((entry) => entry.id === legacy.id);
  assert.equal(found?.content, "Delivered on time.");
  assert.equal(found?.filename, undefined, "no file, so the UI shows no download control");

  const response = await fetch(`${base}/api/evidence/${legacy.id}/file`, { headers: { authorization: `Bearer ${a.token}` } });
  assert.equal(response.status, 404, "and asking for one is an honest 404");
});

test("TLY-53 AC5: another account cannot download the file, or learn that it exists", async () => {
  const items = await listEvidence(a.id);
  const item = items.find((entry) => entry.filename === "tax-clearance.pdf");
  assert.ok(item);

  const response = await fetch(`${base}/api/evidence/${item.id}/file`, { headers: { authorization: `Bearer ${b.token}` } });
  assert.equal(response.status, 404, "the same answer as a file that does not exist, by design");
  assert.equal(await evidenceFile(b.id, item.id), null);

  const missing = await fetch(`${base}/api/evidence/00000000-0000-0000-0000-000000000000/file`, {
    headers: { authorization: `Bearer ${b.token}` },
  });
  assert.equal(missing.status, response.status, "a probe cannot tell the two apart");
});

test("TLY-53 AC3: an oversized upload is refused with the limit named, and nothing is stored", async () => {
  const before = (await listEvidence(a.id)).length;
  const oversized = Buffer.alloc(30 * 1024 * 1024, 0x20);
  const response = await upload(a, { filename: "huge.pdf", name: "Huge file" }, oversized);

  assert.equal(response.status, 400);
  const body = await response.json() as { error: string };
  assert.match(body.error, /25 MB/, "the message names the maximum rather than just refusing");
  assert.equal((await listEvidence(a.id)).length, before, "no partial item is created");
});

test("TLY-53: the file bytes are not dragged into every list request", async () => {
  const items = await listEvidence(a.id);
  // listEvidence deliberately does not select the bytes column; the metadata is
  // enough for the screen, and twenty certificates would otherwise be tens of MB.
  assert.ok(items.every((item) => !("bytes" in item)));
  const withFile = items.find((item) => item.filename === "tax-clearance.pdf");
  assert.equal(withFile?.sizeBytes, PDF.length, "but the size is still known");
});

test("TLY-53: a file is not downloadable without a token", async () => {
  const items = await listEvidence(a.id);
  const item = items.find((entry) => entry.filename === "tax-clearance.pdf");
  assert.equal((await fetch(`${base}/api/evidence/${item!.id}/file`)).status, 401);
});
