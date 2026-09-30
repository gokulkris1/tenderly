import assert from "node:assert/strict";
import test from "node:test";
import bcrypt from "bcryptjs";
import { createUser, getTender, initializeDatabase, updateTenderMetadata, upsertTender } from "../src/db.js";

/**
 * TLY-247. Re-importing a notice wiped every human decision on the bid.
 *
 * `metadata=EXCLUDED.metadata` replaced the whole jsonb, and that jsonb is where
 * the product keeps the attestation, the lot selection, the checklist overrides,
 * the no-AI flag, the role assignments and the runbook ticks. So refetching the
 * buyer's page — the obvious move when an addendum is published — silently
 * cleared all of it and then re-analysed and re-drafted against the blank.
 *
 * The no-AI case is the worst of them: the flag exists because the tender
 * prohibits AI-written content, and clearing it re-enables generation on exactly
 * the bid that forbids it.
 */

process.env.JWT_SECRET ||= "test-secret-that-is-at-least-32-characters";
process.env.TENDERLY_NO_LISTEN = "1";
await initializeDatabase();

const user = await createUser(
  `reimport-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
  await bcrypt.hash("x", 4), "Reimport Ltd");

let counter = 0;
const notice = (over: Record<string, unknown> = {}) => {
  counter += 1;
  return {
    source: "etenders", externalId: `re-${Date.now()}-${counter}`,
    title: "Legal case management system", authority: "Buyer", procedure: "Open",
    deadline: "19/10/2026 17:00", estimatedValue: "113,000", description: "First fetch",
    sourceUrl: "https://www.etenders.gov.ie/notice", published: "01/09/2026",
    status: "IMPORTED", metadata: { ingestReason: "cpv-family" },
    ...over,
  };
};

test("TLY-247 AC1: re-importing keeps the attestation, lot selection and no-AI mode", async () => {
  const first = await upsertTender(user.organisationId, notice());

  // The bid is worked on: a named person attests, lots are chosen, the tender
  // prohibits AI content, and checklist items are ticked.
  await updateTenderMetadata(user.organisationId, first.id, {
    attestation: { by: "Gokul Krishna", at: "2026-09-20T10:00:00.000Z", contentVersion: "abc123" },
    selectedLots: ["Lot 2"],
    noAiMode: true,
    aiPolicyAcknowledgement: { at: "2026-09-20T09:00:00.000Z", state: "prohibited" },
    checklistOverrides: { "item-3": "READY" },
    runbookTicks: ["step-1"],
    roleAssignments: { "project-manager": "person-7" },
  });

  // The buyer publishes an addendum, so the notice is fetched again.
  const again = await upsertTender(user.organisationId, notice({
    externalId: first.externalId, description: "Addendum 1 issued", metadata: { ingestReason: "manual-import" },
  }));
  assert.equal(again.id, first.id, "a re-import must update the same tender, not create a second");

  const stored = await getTender(user.organisationId, first.id);
  assert.ok(stored);
  assert.equal((stored.metadata.attestation as { by: string } | undefined)?.by, "Gokul Krishna",
    "the attestation must survive a re-import");
  assert.deepEqual(stored.metadata.selectedLots, ["Lot 2"]);
  assert.equal(stored.metadata.noAiMode, true,
    "clearing no-AI mode would re-enable generation on a tender that prohibits it");
  assert.deepEqual(stored.metadata.checklistOverrides, { "item-3": "READY" });
  assert.deepEqual(stored.metadata.runbookTicks, ["step-1"]);
  assert.deepEqual(stored.metadata.roleAssignments, { "project-manager": "person-7" });
  assert.ok(stored.metadata.aiPolicyAcknowledgement);
});

test("TLY-247 AC2: notice facts update while user-owned metadata is preserved", async () => {
  const first = await upsertTender(user.organisationId, notice({ estimatedValue: "113,000" }));
  await updateTenderMetadata(user.organisationId, first.id, { selectedLots: ["Lot 1"] });

  await upsertTender(user.organisationId, notice({
    externalId: first.externalId, title: "Legal case management system (revised)",
    estimatedValue: "128,000", description: "Scope widened",
  }));

  const stored = await getTender(user.organisationId, first.id);
  assert.equal(stored?.title, "Legal case management system (revised)", "notice facts must still update");
  assert.equal(stored?.estimatedValue, "128,000");
  assert.equal(stored?.description, "Scope widened");
  assert.deepEqual(stored?.metadata.selectedLots, ["Lot 1"], "and the lot selection must not");
  // A key the incoming notice does carry is still allowed to update.
  assert.equal(stored?.metadata.ingestReason, "cpv-family");
});

test("TLY-247: an incoming notice cannot overwrite a user-owned key by naming it", async () => {
  const first = await upsertTender(user.organisationId, notice());
  await updateTenderMetadata(user.organisationId, first.id, { noAiMode: true, selectedLots: ["Lot 4"] });

  // Even if a source or a future parser were to emit these names, the stored
  // human decision wins. updateTenderMetadata is the only route that may change them.
  await upsertTender(user.organisationId, notice({
    externalId: first.externalId,
    metadata: { ingestReason: "cpv-family", noAiMode: false, selectedLots: [] },
  }));

  const stored = await getTender(user.organisationId, first.id);
  assert.equal(stored?.metadata.noAiMode, true);
  assert.deepEqual(stored?.metadata.selectedLots, ["Lot 4"]);
});

test("TLY-247 AC3: a moved deadline is recorded and the decision is flagged", async () => {
  const first = await upsertTender(user.organisationId, notice({ deadline: "19/10/2026 17:00" }));

  await upsertTender(user.organisationId, notice({
    externalId: first.externalId, deadline: "26/10/2026 12:00",
  }));

  const stored = await getTender(user.organisationId, first.id);
  assert.equal(stored?.deadline, "26/10/2026 12:00");
  const amendments = stored?.metadata.amendments as { field: string; from: string; to: string }[] | undefined;
  assert.equal(amendments?.length, 1, "a moved deadline must leave a record");
  assert.equal(amendments?.[0].field, "deadline");
  assert.equal(amendments?.[0].from, "19/10/2026 17:00");
  assert.equal(amendments?.[0].to, "26/10/2026 12:00");
  assert.equal(stored?.metadata.decisionNeedsReconfirmation, true,
    "a decision to bid was taken against the old deadline");

  // An unchanged deadline is not an amendment.
  await upsertTender(user.organisationId, notice({ externalId: first.externalId, deadline: "26/10/2026 12:00" }));
  const unchanged = await getTender(user.organisationId, first.id);
  assert.equal((unchanged?.metadata.amendments as unknown[]).length, 1, "re-importing unchanged must add nothing");
});

test("TLY-247: a first import records no amendment", async () => {
  const fresh = await upsertTender(user.organisationId, notice());
  const stored = await getTender(user.organisationId, fresh.id);
  assert.equal(stored?.metadata.amendments, undefined, "there is nothing to amend on a first sighting");
  assert.equal(stored?.metadata.decisionNeedsReconfirmation, undefined);
});
