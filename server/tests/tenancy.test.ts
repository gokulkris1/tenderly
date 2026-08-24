import { JWT_SECRET } from "./helpers/env.js";
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { signToken } from "../src/auth.js";
import {
  addEvidence, addMembership, createUser, deleteAccount, findUserByEmail, initializeDatabase,
  listEvidence, listMemberships, listTenders, membershipFor, membershipsForUser, upsertTender,
} from "../src/db.js";
import { persistentDatabase } from "../src/db.js";

await initializeDatabase();
const { app } = await import("../src/index.js");
const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const address = server.address();
const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
server.unref();

const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const secret = JWT_SECRET;

async function account(label: string, tenders = 0, evidence = 0) {
  const email = `${label}-${unique()}@example.test`;
  const user = await createUser(email, await bcrypt.hash("correct horse battery staple", 4), `${label} Ltd`);
  for (let i = 0; i < tenders; i += 1) {
    await upsertTender(user.organisationId, {
      source: "seed", externalId: `${label}-${unique()}-${i}`, title: `${label} tender ${i}`, authority: "Authority",
      procedure: "Open", deadline: "26/03/2027", estimatedValue: "", description: "",
      sourceUrl: "https://www.etenders.gov.ie/x", published: "", status: "ANALYSED", metadata: {},
    });
  }
  for (let i = 0; i < evidence; i += 1) {
    await addEvidence(user.organisationId, {
      kind: "Certificate", name: `${label} certificate ${i}`, content: "x", tags: [], verified: true,
    });
  }
  return { ...user, email };
}

test("TLY-86: registering creates an organisation, and the person is its owner", async () => {
  const user = await account("registrant");

  assert.notEqual(user.organisationId, user.id, "the tenant is not the person");
  const memberships = await membershipsForUser(user.id);
  assert.equal(memberships.length, 1);
  assert.equal(memberships[0].organisationId, user.organisationId);
  assert.equal(memberships[0].role, "owner");
});

test("TLY-86 AC1: an account's tenders and evidence are all still there after signing in", async () => {
  const user = await account("continuity", 2, 5);

  const signIn = await fetch(`${base}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: user.email, password: "correct horse battery staple" }),
  });
  assert.equal(signIn.status, 200);
  const { token } = await signIn.json() as { token: string };

  const listed = await fetch(`${base}/api/tenders`, { headers: { authorization: `Bearer ${token}` } })
    .then((r) => r.json() as Promise<{ items: unknown[] }>);
  assert.equal(listed.items.length, 2, "the migration is not allowed to lose a bid in progress");
  assert.equal((await listEvidence(user.organisationId)).length, 5);

  const claims = jwt.decode(token) as { sub: string; org: string; role: string };
  assert.equal(claims.org, user.organisationId, "the token names the tenant, not the person");
  assert.equal(claims.sub, user.id);
  assert.equal(claims.role, "owner");
});

test("TLY-86 AC2: every user has exactly one owner membership", async () => {
  const user = await account("owner-count");
  const memberships = await listMemberships(user.organisationId);
  assert.equal(memberships.length, 1);
  assert.equal(memberships.filter((entry) => entry.role === "owner").length, 1);
  assert.ok(memberships[0].acceptedAt, "a backfilled member is not waiting on an invitation they never got");
});

test("TLY-86 AC3: a token issued before the migration is refused, not guessed at", async () => {
  const user = await account("legacy-token", 1);
  // The old shape: the user id in `sub`, no organisation claim at all.
  const legacy = jwt.sign({ sub: user.id, email: user.email }, secret,
    { expiresIn: "12h", issuer: "tenderly-api", audience: "tenderly-web" });

  const response = await fetch(`${base}/api/tenders`, { headers: { authorization: `Bearer ${legacy}` } });
  assert.equal(response.status, 401, "guessing which organisation it meant is how one company reads another's bids");
  const body = await response.json() as { items?: unknown; error: string };
  assert.equal(body.items, undefined, "and no data comes back with the refusal");
});

test("TLY-86 AC3: a token naming a user id as the organisation reaches nothing", async () => {
  const user = await account("wrong-claim", 1);
  const wrong = jwt.sign({ sub: user.id, org: user.id, role: "owner", email: user.email }, secret,
    { expiresIn: "12h", issuer: "tenderly-api", audience: "tenderly-web" });

  const response = await fetch(`${base}/api/tenders`, { headers: { authorization: `Bearer ${wrong}` } });
  // Since TLY-88 the membership is checked on every request, so a claim naming
  // an organisation the caller has no place in is refused outright rather than
  // answered with an empty list.
  assert.equal(response.status, 403);
  assert.equal((await response.json() as { items?: unknown }).items, undefined);
});

test("TLY-86: two people in one organisation see the same bids", async () => {
  const owner = await account("shared", 2);
  const colleagueEmail = `colleague-${unique()}@example.test`;
  const colleague = await createUser(colleagueEmail, await bcrypt.hash("x", 4), "Their own Ltd");
  await addMembership(owner.organisationId, colleague.id, "editor");

  const token = signToken({
    id: colleague.id, organisationId: owner.organisationId, email: colleagueEmail, role: "editor",
  });
  const listed = await fetch(`${base}/api/tenders`, { headers: { authorization: `Bearer ${token}` } })
    .then((r) => r.json() as Promise<{ items: { title: string }[] }>);

  assert.equal(listed.items.length, 2, "this is the whole point of the change");
  assert.ok(listed.items.every((tender) => tender.title.startsWith("shared")));
  // And their own organisation is untouched by the arrangement.
  assert.deepEqual(await listTenders(colleague.organisationId), []);
});

test("TLY-86: a membership in another organisation does not grant access to it", async () => {
  const a = await account("org-a", 1);
  const b = await account("org-b", 1);
  const token = signToken({ id: a.id, organisationId: a.organisationId, email: a.email });

  assert.equal(await membershipFor(b.organisationId, a.id), null);
  const listed = await fetch(`${base}/api/tenders`, { headers: { authorization: `Bearer ${token}` } })
    .then((r) => r.json() as Promise<{ items: { title: string }[] }>);
  assert.ok(listed.items.every((tender) => tender.title.startsWith("org-a")));
});

test("TLY-86: deleting an organisation takes its sole member's sign-in, but not a shared one", async () => {
  const doomed = await account("doomed-org", 1);
  const elsewhere = await account("elsewhere", 1);
  // Somebody who works on both: their sign-in belongs to them, not to one client.
  await addMembership(doomed.organisationId, elsewhere.id, "editor");

  await deleteAccount(doomed.organisationId, doomed.email, new Date().toISOString());

  assert.equal(await findUserByEmail(doomed.email), null, "the account holder is gone");
  assert.deepEqual(await listTenders(doomed.organisationId), []);
  const survivor = await findUserByEmail(elsewhere.email);
  assert.ok(survivor, "and the contractor still has their own workspace");
  assert.equal(survivor.organisationId, elsewhere.organisationId);
  assert.equal((await listTenders(elsewhere.organisationId)).length, 1);
});

test("TLY-86: a sign-in with no organisation left is refused rather than given an empty session", async () => {
  const user = await account("stranded");
  await deleteAccount(user.organisationId, user.email, new Date().toISOString());

  const response = await fetch(`${base}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: user.email, password: "correct horse battery staple" }),
  });
  assert.ok(response.status === 401 || response.status === 403, `got ${response.status}`);
});

test("TLY-86 AC2: the backfill gives an organisation and an owner membership to a user that has neither", async (t) => {
  if (!persistentDatabase) {
    t.skip("the backfill is SQL against Postgres; the in-memory store has no migration to run");
    return;
  }
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  try {
    // A user in the pre-migration shape: no organisation, no membership.
    const legacy = (await pool.query(
      "INSERT INTO users(id,email,password_hash) VALUES(gen_random_uuid(),$1,'x') RETURNING id",
      [`legacy-${unique()}@example.test`])).rows[0].id as string;

    const backfill = readFileSync(path.resolve(process.cwd(), "migrations/024_organisations.sql"), "utf8");
    const inserts = backfill.slice(backfill.indexOf("INSERT INTO organisations"));
    await pool.query(inserts);
    // Idempotent: running it twice must not produce a second membership.
    await pool.query(inserts);

    const organisation = await pool.query("SELECT id FROM organisations WHERE id=$1", [legacy]);
    assert.equal(organisation.rowCount, 1, "the organisation takes the user's own uuid, so account_id still resolves");

    const memberships = await pool.query("SELECT role, accepted_at FROM memberships WHERE user_id=$1", [legacy]);
    assert.equal(memberships.rowCount, 1);
    assert.equal(memberships.rows[0].role, "owner");
    assert.ok(memberships.rows[0].accepted_at);
  } finally {
    await pool.end();
  }
});

test("TLY-86 AC5: the rollback covers exactly the tables the migration repointed", () => {
  const tablesIn = (file: string) => {
    const source = readFileSync(path.resolve(process.cwd(), file), "utf8");
    const marker = "scoped text[] := ARRAY[";
    const block = source.slice(source.indexOf(marker) + marker.length);
    return [...block.slice(0, block.indexOf("]")).matchAll(/'([a-z_]+)'/g)].map((match) => match[1]).sort();
  };

  const repointed = tablesIn("migrations/025_repoint_tenancy.sql");
  assert.equal(repointed.length, 13, "thirteen tables hold account_id with a foreign key; deletion_log holds it without one");
  assert.deepEqual(tablesIn("migrations/rollback/025_repoint_tenancy_down.sql"), repointed,
    "a table repointed forward and forgotten backward is a rollback that leaves the schema in a state nobody designed");
});
