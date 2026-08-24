import assert from "node:assert/strict";
import test from "node:test";
import { skillKey, skillMatrix, skillMatrixCsv } from "../src/skills.js";
import type { PersonFact, PersonRecord } from "../src/types.js";

const person = (id: string, name: string, over: Partial<PersonRecord> = {}): PersonRecord & { archivedAt?: string } =>
  ({ id, accountId: "a", name, title: "", cvText: "", skills: [], ...over });

const skill = (personId: string, value: string, confirmed = true): PersonFact => ({
  id: `${personId}-${value}`, personId, type: "skill", value, detail: "", period: "",
  quote: `…${value}…`, confidence: "HIGH", confirmed, createdAt: "2026-08-24T00:00:00.000Z",
});

const team = () => [
  person("p1", "Aoife Byrne"), person("p2", "Cormac Walsh"),
  person("p3", "Niamh Kelly"), person("p4", "Sean Murphy"),
];

test("TLY-60 AC1: people are rows, distinct skills are columns", () => {
  const matrix = skillMatrix({
    people: team(),
    facts: [
      skill("p1", "Energy auditing"), skill("p1", "Project management"),
      skill("p2", "Project management"), skill("p3", "BIM modelling"),
      skill("p4", "Project management"),
    ],
  });

  assert.equal(matrix.people.length, 4);
  assert.deepEqual(matrix.columns.map((column) => column.skill).sort(),
    ["BIM modelling", "Energy auditing", "Project management"]);

  const aoife = matrix.people.find((row) => row.name === "Aoife Byrne");
  assert.ok(aoife?.skills.includes("Energy auditing"));
  assert.ok(aoife?.skills.includes("Project management"));
  assert.ok(!aoife?.skills.includes("BIM modelling"));
});

test("TLY-60 AC2: two spellings of one skill are one column", () => {
  const matrix = skillMatrix({
    people: [person("p1", "Aoife"), person("p2", "Cormac")],
    facts: [skill("p1", "Energy auditing"), skill("p2", "Energy audit")],
  });

  assert.equal(matrix.columns.length, 1, "one skill, one column");
  assert.equal(matrix.columns[0].holders, 2);
  assert.equal(matrix.columns[0].singlePointOfDependency, false);
  assert.equal(skillKey("Energy auditing"), skillKey("Energy audit"));
  assert.equal(skillKey("Energy Audits"), skillKey("energy auditing"));
  assert.notEqual(skillKey("Energy auditing"), skillKey("Project management"));
});

test("TLY-60 AC3: filtering by skill lists only the people who hold it", () => {
  const matrix = skillMatrix({
    people: team(),
    facts: [skill("p1", "Energy auditing"), skill("p2", "Project management"), skill("p3", "Energy audit")],
    filterSkill: "Energy auditing",
  });

  assert.deepEqual(matrix.people.map((row) => row.name).sort(), ["Aoife Byrne", "Niamh Kelly"]);
  assert.equal(matrix.columns.length, 1, "and only that skill's column");
});

test("TLY-60 AC4: a skill only one person holds is flagged", () => {
  const matrix = skillMatrix({
    people: [person("p1", "Aoife"), person("p2", "Cormac")],
    facts: [skill("p1", "BIM modelling"), skill("p1", "Project management"), skill("p2", "Project management")],
  });

  const bim = matrix.columns.find((column) => column.skill === "BIM modelling");
  assert.equal(bim?.singlePointOfDependency, true, "the team is one person deep here");
  const pm = matrix.columns.find((column) => column.skill === "Project management");
  assert.equal(pm?.singlePointOfDependency, false);
});

test("TLY-60 AC5: the CSV header matches the grid, name first", () => {
  const matrix = skillMatrix({
    people: [person("p1", "Aoife Byrne"), person("p2", "Cormac Walsh")],
    facts: [skill("p1", "Energy auditing"), skill("p2", "Project management")],
  });
  const csv = skillMatrixCsv(matrix);
  const [header, ...rows] = csv.split("\n");

  assert.equal(header, `"Person","Energy auditing","Project management"`);
  assert.equal(rows.length, 2);
  assert.equal(rows[0], `"Aoife Byrne","Yes",""`);
  assert.equal(rows[1], `"Cormac Walsh","","Yes"`);
});

test("TLY-60: a skill containing a comma or a quote does not break the CSV", () => {
  const matrix = skillMatrix({
    people: [person("p1", "Aoife")],
    facts: [skill("p1", 'Design, build and "operate"')],
  });
  const csv = skillMatrixCsv(matrix);
  assert.match(csv, /"Design, build and ""operate"""/);
  assert.equal(csv.split("\n").length, 2, "one header and one row, not split by the comma");
});

test("TLY-60 AC6: an empty matrix says so rather than drawing a blank grid", () => {
  const empty = skillMatrix({ people: team(), facts: [] });
  assert.equal(empty.note, "No confirmed skills yet");
  assert.deepEqual(empty.columns, []);
  assert.deepEqual(empty.people, []);

  const unconfirmedOnly = skillMatrix({
    people: team(),
    facts: [skill("p1", "Energy auditing", false)],
  });
  assert.equal(unconfirmedOnly.note, "No confirmed skills yet",
    "a suggestion is not a skill: staffing a bid off one is how you name someone who cannot do the work");
});

test("TLY-60: an archived person is not an answer to 'who can we put on this'", () => {
  const matrix = skillMatrix({
    people: [person("p1", "Aoife"), person("p2", "Departed", { archivedAt: "2026-01-01T00:00:00.000Z" } as Partial<PersonRecord>)],
    facts: [skill("p1", "Energy auditing"), skill("p2", "Energy auditing"), skill("p2", "BIM modelling")],
  });

  assert.deepEqual(matrix.people.map((row) => row.name), ["Aoife"]);
  assert.equal(matrix.columns.length, 1, "a skill only the departed person held is not a team skill");
  assert.equal(matrix.columns[0].holders, 1);
});

test("TLY-60: non-skill records never reach the grid", () => {
  const certification: PersonFact = {
    id: "c1", personId: "p1", type: "certification", value: "Chartered Engineer", detail: "",
    period: "", quote: "…", confidence: "HIGH", confirmed: true, createdAt: "2026-08-24T00:00:00.000Z",
  };
  const matrix = skillMatrix({ people: [person("p1", "Aoife")], facts: [certification, skill("p1", "Energy auditing")] });
  assert.deepEqual(matrix.columns.map((column) => column.skill), ["Energy auditing"]);
});
