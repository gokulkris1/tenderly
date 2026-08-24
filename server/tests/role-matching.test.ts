import assert from "node:assert/strict";
import test from "node:test";
import { evidencedYears, matchRoles, requiredYears, roleBlockers } from "../src/role-matching.js";
import type { PersonFact, PersonRecord, RequiredRole } from "../src/types.js";

const evidence = { sourceDocument: "ITT.pdf", quote: "A project manager is required.", confidence: "HIGH" as const };

const role = (over: Partial<RequiredRole> = {}): RequiredRole => ({
  role: "Project Manager", quantity: 1, minimumExperience: "5 years experience",
  qualifications: "", cvRequired: true, bidderMatch: "", status: "REVIEW", action: "", evidence, ...over,
});

const person = (id: string, name: string, over: Partial<PersonRecord> = {}): PersonRecord & { archivedAt?: string } =>
  ({ id, accountId: "a", name, title: "", cvText: "", skills: [], ...over });

const fact = (personId: string, type: PersonFact["type"], value: string, over: Partial<PersonFact> = {}): PersonFact => ({
  id: `${personId}-${value}`, personId, type, value, detail: "", period: "",
  quote: `…${value}…`, confidence: "HIGH", confirmed: true,
  createdAt: "2026-08-24T00:00:00.000Z", ...over,
});

const NOW = new Date(Date.UTC(2026, 7, 24));

test("TLY-61 AC1: a person with enough experience is proposed, with the matched fact shown", () => {
  const [match] = matchRoles({
    roles: [role()],
    people: [person("p1", "Aoife Byrne")],
    facts: [
      fact("p1", "role", "Project Manager"),
      fact("p1", "experience", "Project Manager", { period: "2018–2026" }),
    ],
    now: NOW,
  });

  assert.equal(match.candidates.length, 1);
  assert.equal(match.candidates[0].name, "Aoife Byrne");
  const years = match.candidates[0].matched.find((entry) => entry.kind === "experience");
  assert.equal(years?.evidence, "8 years experience", "the number a buyer would read, not a verdict");
  assert.deepEqual(match.gaps, []);
});

test("TLY-61 AC2: a certification nobody holds is a named gap", () => {
  const [match] = matchRoles({
    roles: [role({ role: "Energy Auditor", qualifications: "Chartered Energy Auditor", minimumExperience: "" })],
    people: [person("p1", "Aoife Byrne")],
    facts: [fact("p1", "certification", "Chartered Engineer")],
    now: NOW,
  });

  assert.ok(match.gaps.includes("No team member holds: Chartered Energy Auditor"));
  assert.equal(match.candidates.length, 0, "holding a different certification is not a partial match");
});

test("TLY-61 AC3: a mandatory role nobody can fill blocks the pack", () => {
  const roles = [role({ role: "Chartered Energy Auditor", qualifications: "Chartered Energy Auditor", cvRequired: true })];
  const matches = matchRoles({ roles, people: [person("p1", "Aoife")], facts: [], now: NOW });

  const blockers = roleBlockers(matches, roles);
  assert.deepEqual(blockers, ["No team member can fill the required role: Chartered Energy Auditor"]);

  // A role the tender does not make mandatory is a gap, not a blocker.
  const optional = [role({ role: "Nice To Have", qualifications: "Something", cvRequired: false })];
  assert.deepEqual(roleBlockers(matchRoles({ roles: optional, people: [], facts: [], now: NOW }), optional), []);
});

test("TLY-61 AC4: two candidates are ordered by how much they actually satisfy", () => {
  const [match] = matchRoles({
    roles: [role({ qualifications: "PRINCE2" })],
    people: [person("p1", "Weaker Match"), person("p2", "Stronger Match")],
    facts: [
      fact("p1", "role", "Project Manager"),
      fact("p2", "role", "Project Manager"),
      fact("p2", "certification", "PRINCE2 Practitioner"),
      fact("p2", "experience", "Project Manager", { period: "2015–2026" }),
    ],
    now: NOW,
  });

  assert.deepEqual(match.candidates.map((candidate) => candidate.name), ["Stronger Match", "Weaker Match"]);
  assert.ok(match.candidates[0].matched.length > match.candidates[1].matched.length);
});

test("TLY-61 AC5: an unconfirmed record does not satisfy a role, and says so", () => {
  const [match] = matchRoles({
    roles: [role({ role: "Energy Auditor", qualifications: "Chartered Energy Auditor", minimumExperience: "" })],
    people: [person("p1", "Aoife Byrne")],
    facts: [fact("p1", "certification", "Chartered Energy Auditor", { confirmed: false })],
    now: NOW,
  });

  assert.equal(match.candidates.length, 0,
    "putting a person in front of a buyer on an unchecked claim is the failure this exists to avoid");
  assert.equal(match.unconfirmedEvidence, true, "but the user is told there is something to review");
  assert.ok(match.gaps.some((gap) => gap.includes("Chartered Energy Auditor")));
});

test("TLY-61: the user's assignment is carried, so a re-analysis cannot change who is named", () => {
  const [match] = matchRoles({
    roles: [role()],
    people: [person("p1", "Aoife"), person("p2", "Cormac")],
    facts: [fact("p1", "role", "Project Manager"), fact("p2", "role", "Project Manager")],
    assignments: { "Project Manager": "p2" },
    now: NOW,
  });
  assert.equal(match.assignedPersonId, "p2");
});

test("TLY-61: an archived person is never proposed", () => {
  const [match] = matchRoles({
    roles: [role()],
    people: [person("p1", "Departed", { archivedAt: "2026-01-01T00:00:00.000Z" } as Partial<PersonRecord>)],
    facts: [fact("p1", "role", "Project Manager"), fact("p1", "experience", "Project Manager", { period: "2010–2026" })],
    now: NOW,
  });
  assert.equal(match.candidates.length, 0);
});

test("TLY-61: years are read from the CV's own ranges, and summed across employers", () => {
  assert.equal(requiredYears("5 years experience"), 5);
  assert.equal(requiredYears("minimum 10 yrs"), 10);
  assert.equal(requiredYears("relevant experience"), null, "no figure stated means no figure to check");

  const facts = [
    fact("p1", "experience", "Engineer", { period: "2014–2016" }),
    fact("p1", "experience", "Senior Engineer", { period: "2016-2019" }),
  ];
  assert.equal(evidencedYears(facts, NOW), 5, "two years plus three");

  const open = [fact("p1", "experience", "Lead", { period: "2020–present" })];
  assert.equal(evidencedYears(open, NOW), 6);

  const unconfirmed = [fact("p1", "experience", "Lead", { period: "2010–2026", confirmed: false })];
  assert.equal(evidencedYears(unconfirmed, NOW), 0, "unconfirmed experience counts for nothing");
});

test("TLY-61: a role stating no requirements produces no false candidates", () => {
  const [match] = matchRoles({
    roles: [role({ role: "", qualifications: "", minimumExperience: "" })],
    people: [person("p1", "Aoife")],
    facts: [fact("p1", "skill", "Anything at all")],
    now: NOW,
  });
  assert.equal(match.candidates.length, 0, "being on the team is not evidence of anything");
  assert.deepEqual(match.gaps, []);
});
