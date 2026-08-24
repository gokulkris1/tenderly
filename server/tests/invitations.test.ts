import "./helpers/env.js";
import assert from "node:assert/strict";
import test from "node:test";
import bcrypt from "bcryptjs";
import { signToken } from "../src/auth.js";
import {
  addMembership, createInvitation, createUser, initializeDatabase, invitationByTokenHash,
  listInvitations, listMemberships, upsertTender,
} from "../src/db.js";
import {
  ALREADY_A_MEMBER, INVITATION_MESSAGES, hashInvitationToken, invitationEmail, invitationLink,
  invitationProblem, newInvitationToken,
} from "../src/invitations.js";
import { captureEmail } from "../src/mail.js";

await initializeDatabase();
const { app } = await import("../src/index.js");
const server = app.listen(0);
await new Promise((resolve) => server.once("listening", resolve));
const address = server.address();
const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
server.unref();

const unique = () => `${Date.now()}-${Math.random().toString(36).slice(2)}`;

async function owner(label: string, tenders = 1) {
  const email = `${label}-${unique()}@example.test`;
  const user = await createUser(email, await bcrypt.hash("x", 4), `${label} Ltd`);
  for (let i = 0; i < tenders; i += 1) {
    await upsertTender(user.organisationId, {
      source: "seed", externalId: `${label}-${unique()}-${i}`, title: `${label} tender ${i}`,
      authority: "Authority", procedure: "Open", deadline: "26/03/2027", estimatedValue: "",
      description: "", sourceUrl: "https://www.etenders.gov.ie/x", published: "", status: "ANALYSED", metadata: {},
    });
  }
  return {
    ...user, email,
    headers: {
      authorization: `Bearer ${signToken({ id: user.id, organisationId: user.organisationId, email, role: "owner" })}`,
      "content-type": "application/json",
    },
  };
}

type InviteResponse = {
  invitation: { id: string; email: string; role: string; expiresAt: string };
  delivered: boolean;
  link?: string;
};

const invite = (host: Awaited<ReturnType<typeof owner>>, email: string, role = "editor") =>
  fetch(`${base}/api/team/invitations`, { method: "POST", headers: host.headers, body: JSON.stringify({ email, role }) });

const tokenOf = (link: string) => link.split("/invite/")[1];

test("TLY-87 AC1: an invitation is listed as Pending and an email goes to that address", async () => {
  const host = await owner("inviter");
  const colleague = `colleague-${unique()}@example.test`;
  const mail = captureEmail();
  try {
    const response = await invite(host, colleague);
    assert.equal(response.status, 201);
    const body = await response.json() as InviteResponse;
    assert.equal(body.invitation.email, colleague);
    assert.equal(body.invitation.role, "editor");

    const sent = mail.sent.find((email) => email.to === colleague);
    assert.ok(sent, "an invitation nobody receives is not an invitation");
    assert.match(sent.subject, /has invited you to Tenderly/);
    assert.match(sent.text, /\/invite\//, "the link is the whole message");

    const team = await fetch(`${base}/api/team/members`, { headers: host.headers })
      .then((r) => r.json() as Promise<{ invitations: { email: string; role: string }[]; members: unknown[] }>);
    assert.equal(team.invitations.length, 1);
    assert.equal(team.invitations[0].email, colleague);
    assert.equal(team.members.length, 1, "and they are not a member until they accept");
  } finally { mail.stop(); }
});

test("TLY-87 AC2: opening the link and setting a password joins the organisation", async () => {
  const host = await owner("joinable", 2);
  const colleague = `joiner-${unique()}@example.test`;
  const created = await (await invite(host, colleague)).json() as InviteResponse;
  assert.ok(created.link, "email is not configured yet, so the owner gets the link to pass on");

  const accepted = await fetch(`${base}/api/invitations/${tokenOf(created.link)}/accept`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "a decent passphrase" }),
  });
  assert.equal(accepted.status, 201);
  const { token } = await accepted.json() as { token: string };

  const listed = await fetch(`${base}/api/tenders`, { headers: { authorization: `Bearer ${token}` } })
    .then((r) => r.json() as Promise<{ items: unknown[] }>);
  assert.equal(listed.items.length, 2, "they see the organisation's bids, which is what they were invited for");

  const team = await fetch(`${base}/api/team/members`, { headers: host.headers })
    .then((r) => r.json() as Promise<{ members: { email: string; role: string }[]; invitations: unknown[] }>);
  assert.equal(team.members.length, 2);
  assert.equal(team.members.find((member) => member.email === colleague)?.role, "editor");
  assert.equal(team.invitations.length, 0, "and the pending invitation is gone");
});

test("TLY-87 AC2: they can sign in afterwards with the password they set", async () => {
  const host = await owner("signinable");
  const colleague = `signin-${unique()}@example.test`;
  const created = await (await invite(host, colleague)).json() as InviteResponse;
  await fetch(`${base}/api/invitations/${tokenOf(created.link!)}/accept`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "a decent passphrase" }),
  });

  const signIn = await fetch(`${base}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: colleague, password: "a decent passphrase" }),
  });
  assert.equal(signIn.status, 200);
});

test("TLY-87 AC3: a used link says so, and creates no second membership", async () => {
  const host = await owner("reused");
  const colleague = `reuse-${unique()}@example.test`;
  const created = await (await invite(host, colleague)).json() as InviteResponse;
  const token = tokenOf(created.link!);
  const accept = () => fetch(`${base}/api/invitations/${token}/accept`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "a decent passphrase" }),
  });

  assert.equal((await accept()).status, 201);
  const second = await accept();
  assert.equal(second.status, 410);
  assert.equal((await second.json() as { error: string }).error, "This invitation has already been accepted");

  assert.equal((await listMemberships(host.organisationId)).length, 2, "still two people, not three");
});

test("TLY-87 AC4: an invitation created eight days ago has expired", async () => {
  const host = await owner("expired");
  const { token, tokenHash } = newInvitationToken();
  const eightDaysAgo = new Date(Date.now() - 8 * 86_400_000);
  await createInvitation({
    organisationId: host.organisationId, email: `lapsed-${unique()}@example.test`, role: "editor",
    tokenHash, invitedBy: host.email, expiresAt: new Date(eightDaysAgo.getTime() + 7 * 86_400_000).toISOString(),
  });

  const looked = await fetch(`${base}/api/invitations/${token}`);
  assert.equal(looked.status, 410);
  assert.equal((await looked.json() as { error: string }).error, "This invitation has expired");

  const accepted = await fetch(`${base}/api/invitations/${token}/accept`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "a decent passphrase" }),
  });
  assert.equal(accepted.status, 410);
  assert.equal((await listMemberships(host.organisationId)).length, 1, "and nobody joined");
});

test("TLY-87 AC5: a revoked invitation is no longer valid", async () => {
  const host = await owner("revoked");
  const colleague = `revoke-${unique()}@example.test`;
  const created = await (await invite(host, colleague)).json() as InviteResponse;

  const revoked = await fetch(`${base}/api/team/invitations/${created.invitation.id}`, {
    method: "DELETE", headers: host.headers,
  });
  assert.equal(revoked.status, 200);

  const opened = await fetch(`${base}/api/invitations/${tokenOf(created.link!)}`);
  assert.equal(opened.status, 410);
  assert.equal((await opened.json() as { error: string }).error, "This invitation is no longer valid");
  assert.equal((await listMemberships(host.organisationId)).length, 1);
});

test("TLY-87 AC6: inviting somebody who is already a member is refused", async () => {
  const host = await owner("already");
  const colleagueEmail = `member-${unique()}@example.test`;
  const colleague = await createUser(colleagueEmail, await bcrypt.hash("x", 4), "Their Ltd");
  await addMembership(host.organisationId, colleague.id, "editor");

  const response = await invite(host, colleagueEmail);
  assert.equal(response.status, 409);
  assert.equal((await response.json() as { error: string }).error, ALREADY_A_MEMBER);
  assert.deepEqual(await listInvitations(host.organisationId), [], "and no invitation was created");
});

test("TLY-87: an unknown token says the same thing as a revoked one", async () => {
  const response = await fetch(`${base}/api/invitations/${newInvitationToken().token}`);
  assert.equal(response.status, 410);
  assert.equal((await response.json() as { error: string }).error, "This invitation is no longer valid",
    "telling a token-guesser which of their guesses named a real invitation is a gift");
});

test("TLY-87: the token is never stored, only its hash", async () => {
  const host = await owner("hashed");
  const created = await (await invite(host, `hash-${unique()}@example.test`)).json() as InviteResponse;
  const token = tokenOf(created.link!);

  const [stored] = await listInvitations(host.organisationId);
  assert.notEqual(stored.tokenHash, token);
  assert.equal(stored.tokenHash, hashInvitationToken(token));
  assert.ok(await invitationByTokenHash(hashInvitationToken(token)));
  assert.ok(token.length >= 40, "a guessable link is a way into somebody's bids");
});

test("TLY-87: an existing account joins without its password being reset", async () => {
  const host = await owner("existing");
  const colleagueEmail = `existing-${unique()}@example.test`;
  await createUser(colleagueEmail, await bcrypt.hash("their own password", 4), "Their own Ltd");

  const created = await (await invite(host, colleagueEmail)).json() as InviteResponse;
  const accepted = await fetch(`${base}/api/invitations/${tokenOf(created.link!)}/accept`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "an attacker's choice" }),
  });
  assert.equal(accepted.status, 201);
  assert.equal((await accepted.json() as { hadAccount: boolean }).hadAccount, true);

  // The password in the request was ignored: an invitation link must not be a
  // way to take over an account that already exists.
  const withOldPassword = await fetch(`${base}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: colleagueEmail, password: "their own password" }),
  });
  assert.equal(withOldPassword.status, 200);
  const withNewPassword = await fetch(`${base}/api/auth/login`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: colleagueEmail, password: "an attacker's choice" }),
  });
  assert.equal(withNewPassword.status, 401);
});

test("TLY-87: a new sign-in needs a password worth having", async () => {
  const host = await owner("weak");
  const created = await (await invite(host, `weak-${unique()}@example.test`)).json() as InviteResponse;
  const response = await fetch(`${base}/api/invitations/${tokenOf(created.link!)}/accept`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: "short" }),
  });
  assert.equal(response.status, 400);

  // And the invitation is still usable — a rejected password must not burn it.
  const retry = await fetch(`${base}/api/invitations/${tokenOf(created.link!)}/accept`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "a decent passphrase" }),
  });
  assert.equal(retry.status, 201);
});

test("TLY-87: an editor cannot invite, and cannot withdraw somebody else's invitation", async () => {
  const host = await owner("editor-limits");
  const colleagueEmail = `editor-${unique()}@example.test`;
  const colleague = await createUser(colleagueEmail, await bcrypt.hash("x", 4), "Their Ltd");
  await addMembership(host.organisationId, colleague.id, "editor");
  const editorHeaders = {
    authorization: `Bearer ${signToken({
      id: colleague.id, organisationId: host.organisationId, email: colleagueEmail, role: "editor",
    })}`,
    "content-type": "application/json",
  };

  const attempted = await fetch(`${base}/api/team/invitations`, {
    method: "POST", headers: editorHeaders, body: JSON.stringify({ email: `x-${unique()}@example.test` }),
  });
  assert.equal(attempted.status, 403);
  assert.deepEqual(await listInvitations(host.organisationId), []);

  const created = await (await invite(host, `pending-${unique()}@example.test`)).json() as InviteResponse;
  const withdrawn = await fetch(`${base}/api/team/invitations/${created.invitation.id}`, {
    method: "DELETE", headers: editorHeaders,
  });
  assert.equal(withdrawn.status, 403);
});

test("TLY-87: an invitation cannot be withdrawn from another organisation", async () => {
  const host = await owner("victim");
  const stranger = await owner("stranger");
  const created = await (await invite(host, `target-${unique()}@example.test`)).json() as InviteResponse;

  const response = await fetch(`${base}/api/team/invitations/${created.invitation.id}`, {
    method: "DELETE", headers: stranger.headers,
  });
  assert.equal(response.status, 404);

  const opened = await fetch(`${base}/api/invitations/${tokenOf(created.link!)}`);
  assert.equal(opened.status, 200, "and the invitation still works");
});

test("TLY-87: two live invitations to the same address are refused", async () => {
  const host = await owner("duplicate");
  const colleague = `dup-${unique()}@example.test`;
  assert.equal((await invite(host, colleague)).status, 201);
  const second = await invite(host, colleague);
  assert.equal(second.status, 409);
  assert.match((await second.json() as { error: string }).error, /already has an invitation waiting/);
});

test("TLY-87: the states an invitation can be in are named, not inferred", () => {
  const live = { expiresAt: new Date(Date.now() + 86_400_000).toISOString() };
  assert.equal(invitationProblem(live), null);
  assert.equal(invitationProblem(null), "unknown");
  assert.equal(invitationProblem({ ...live, revokedAt: new Date().toISOString() }), "revoked");
  assert.equal(invitationProblem({ ...live, expiresAt: new Date(Date.now() - 1).toISOString() }), "expired");
  // Accepted beats expired: "you already used this" is true and useful; "it
  // lapsed" is neither.
  assert.equal(invitationProblem({
    expiresAt: new Date(Date.now() - 86_400_000).toISOString(), acceptedAt: new Date().toISOString(),
  }), "already-accepted");
  assert.equal(INVITATION_MESSAGES.unknown, INVITATION_MESSAGES.revoked);
});

test("TLY-87: the email says who invited them, to what, and what the link does", () => {
  const link = invitationLink("a-token", "https://gettenderly.netlify.app/");
  assert.equal(link, "https://gettenderly.netlify.app/invite/a-token");

  const { subject, text } = invitationEmail({
    organisation: "Byrne Civils Ltd", invitedBy: "aoife@example.test", role: "editor", link,
  });
  assert.equal(subject, "Byrne Civils Ltd has invited you to Tenderly");
  assert.match(text, /aoife@example.test has invited you to join Byrne Civils Ltd/);
  assert.match(text, /as an editor/);
  assert.match(text, /works once and expires in 7 days/);
  assert.ok(text.includes(link));
});
