import type { PersonFact, PersonRecord } from "./types.js";

/**
 * The team as a grid: people down one axis, skills across the other.
 *
 * A bid manager uses it to answer "who can we put on this" without reading five
 * CVs, and to see where the team is one person deep.
 *
 * Only confirmed skills appear. An unconfirmed record is a suggestion the model
 * made, and staffing a bid off a suggestion is how a company ends up naming
 * someone who cannot do the work.
 */

export type SkillColumn = {
  /** The canonical label shown as the column heading. */
  skill: string;
  /** How many people hold it. */
  holders: number;
  /** True when exactly one person holds it. */
  singlePointOfDependency: boolean;
};

export type SkillMatrix = {
  people: { id: string; name: string; skills: string[] }[];
  columns: SkillColumn[];
  /** Set when there is nothing to draw, so the UI shows a sentence not a grid. */
  note?: string;
};

/**
 * Reduces a skill to a comparison key.
 *
 * "Energy auditing" and "Energy audit" are the same column. Rather than a
 * controlled vocabulary nobody maintains, this strips the endings that make one
 * spelling of a skill differ from another and compares what is left — which
 * handles the real variation in CVs without a list to keep up to date.
 */
export function skillKey(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word
      .replace(/(ing|ed|ers|er|s)$/u, "")
      .replace(/(it|at)$/u, "$1e"))
    .join(" ")
    .trim();
}

/** The clearest spelling of a skill among the variants seen: the longest. */
function canonicalLabel(variants: string[]) {
  return [...variants].sort((a, b) => b.length - a.length || a.localeCompare(b))[0];
}

/**
 * Builds the matrix from confirmed skill records.
 *
 * Archived people are excluded: the grid answers "who can we put on this", and
 * someone who has left is not an answer to that.
 */
export function skillMatrix(args: {
  // archivedAt is read structurally rather than required, so this compiles
  // whether or not the archiving story (TLY-63) has landed yet.
  people: (PersonRecord & { archivedAt?: string })[];
  facts: PersonFact[];
  /** Show only people holding this skill, matched on its key. */
  filterSkill?: string;
}): SkillMatrix {
  const active = args.people.filter((person) => !person.archivedAt);
  const activeIds = new Set(active.map((person) => person.id));
  const confirmed = args.facts.filter((fact) =>
    fact.type === "skill" && fact.confirmed && activeIds.has(fact.personId) && fact.value.trim().length > 0);

  if (confirmed.length === 0) {
    return { people: [], columns: [], note: "No confirmed skills yet" };
  }

  // key -> every spelling seen, and who holds it.
  const variants = new Map<string, string[]>();
  const holders = new Map<string, Set<string>>();
  for (const fact of confirmed) {
    const key = skillKey(fact.value);
    if (!key) continue;
    variants.set(key, [...(variants.get(key) ?? []), fact.value.trim()]);
    holders.set(key, (holders.get(key) ?? new Set()).add(fact.personId));
  }

  const filterKey = args.filterSkill ? skillKey(args.filterSkill) : "";
  const keys = [...variants.keys()]
    .filter((key) => !filterKey || key === filterKey)
    .sort((a, b) => canonicalLabel(variants.get(a)!).localeCompare(canonicalLabel(variants.get(b)!)));

  const columns: SkillColumn[] = keys.map((key) => ({
    skill: canonicalLabel(variants.get(key)!),
    holders: holders.get(key)!.size,
    singlePointOfDependency: holders.get(key)!.size === 1,
  }));

  const rows = active
    .map((person) => ({
      id: person.id,
      name: person.name,
      skills: keys.filter((key) => holders.get(key)!.has(person.id)).map((key) => canonicalLabel(variants.get(key)!)),
    }))
    // A filtered matrix lists only the people who hold the skill asked about.
    .filter((row) => (filterKey ? row.skills.length > 0 : true));

  if (columns.length === 0) return { people: [], columns: [], note: "No confirmed skills yet" };
  return { people: rows, columns };
}

/**
 * The matrix as CSV: person name first, then one column per skill.
 *
 * Values are quoted and embedded quotes doubled, so a skill containing a comma
 * does not silently split a row.
 */
export function skillMatrixCsv(matrix: SkillMatrix) {
  const escape = (value: string) => `"${value.replace(/"/g, '""')}"`;
  const header = ["Person", ...matrix.columns.map((column) => column.skill)].map(escape).join(",");
  const rows = matrix.people.map((person) =>
    [person.name, ...matrix.columns.map((column) => (person.skills.includes(column.skill) ? "Yes" : ""))]
      .map(escape).join(","));
  return [header, ...rows].join("\n");
}
