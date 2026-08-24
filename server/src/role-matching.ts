import type { PersonFact, PersonRecord, RequiredRole } from "./types.js";

/**
 * Which of our people can fill a role the tender requires, and why.
 *
 * The analysis already extracts required roles, and the model already guessed
 * at a match. With structured people records the match becomes checkable: each
 * candidate is proposed with the specific facts that satisfied the requirement,
 * and an unfilled role becomes a named gap rather than a silent blank.
 *
 * Only confirmed records count. An unconfirmed certification is a claim the
 * model read off a CV, and putting a person in front of a buyer on the strength
 * of that is exactly the failure this product exists to avoid.
 */

export type MatchedFact = {
  /** What the requirement asked for. */
  requirement: string;
  /** The record that satisfied it, in the person's own words. */
  evidence: string;
  kind: PersonFact["type"];
};

export type RoleCandidate = {
  personId: string;
  name: string;
  matched: MatchedFact[];
};

export type RoleMatch = {
  role: string;
  quantity: number;
  /** Best first, by how many requirements they actually satisfy. */
  candidates: RoleCandidate[];
  /** Named requirements nothing in the team satisfies. */
  gaps: string[];
  /** Set when a record would have matched but has not been confirmed. */
  unconfirmedEvidence: boolean;
  /** The person the user has assigned, when they have chosen. */
  assignedPersonId?: string;
};

/** Years of experience a requirement asks for, or null when it asks for none. */
export function requiredYears(text: string): number | null {
  const match = /(\d{1,2})\s*\+?\s*(?:years|yrs)/i.exec(text);
  return match ? Number(match[1]) : null;
}

/**
 * Years a person can evidence, from the date ranges on their experience records.
 *
 * Ranges are summed rather than spanned: two years at one employer and three at
 * another is five years of experience, and an open range ("2019–present") runs
 * to now.
 */
export function evidencedYears(facts: PersonFact[], now = new Date()): number {
  let total = 0;
  for (const fact of facts) {
    if (fact.type !== "experience" || !fact.confirmed) continue;
    const years = [...fact.period.matchAll(/(19|20)\d{2}/g)].map((match) => Number(match[0]));
    if (years.length >= 2) total += Math.max(0, years[years.length - 1] - years[0]);
    else if (years.length === 1 && /present|current|now|–\s*$|-\s*$/i.test(fact.period)) {
      total += Math.max(0, now.getUTCFullYear() - years[0]);
    }
  }
  return total;
}

/** Loose containment, so "ISO 27001" matches "ISO 27001 Lead Auditor". */
function mentions(haystack: string, needle: string) {
  const clean = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const a = clean(haystack);
  const b = clean(needle);
  return Boolean(a) && Boolean(b) && (a.includes(b) || b.includes(a));
}

/**
 * The distinct requirements a role states: its qualifications, its title and
 * its minimum experience, each as its own thing to satisfy.
 */
function requirementsOf(role: RequiredRole): { text: string; kind: PersonFact["type"] }[] {
  const requirements: { text: string; kind: PersonFact["type"] }[] = [];
  for (const qualification of role.qualifications.split(/[,;]|\band\b/i)) {
    const text = qualification.trim();
    if (text.length > 2) requirements.push({ text, kind: "certification" });
  }
  if (role.role.trim()) requirements.push({ text: role.role.trim(), kind: "role" });
  return requirements;
}

/**
 * Matches every required role against the team.
 *
 * A person is a candidate only if they satisfy at least one stated requirement;
 * being on the team is not evidence of anything.
 */
export function matchRoles(args: {
  roles: RequiredRole[];
  people: (PersonRecord & { archivedAt?: string })[];
  facts: PersonFact[];
  /** personId chosen by the user, keyed by role name. */
  assignments?: Record<string, string>;
  now?: Date;
}): RoleMatch[] {
  const active = args.people.filter((person) => !person.archivedAt);
  const byPerson = new Map<string, PersonFact[]>();
  for (const fact of args.facts) byPerson.set(fact.personId, [...(byPerson.get(fact.personId) ?? []), fact]);

  return args.roles.map((role) => {
    const requirements = requirementsOf(role);
    const years = requiredYears(role.minimumExperience);
    const satisfied = new Set<string>();
    let unconfirmedEvidence = false;

    const candidates: RoleCandidate[] = [];
    for (const person of active) {
      const facts = byPerson.get(person.id) ?? [];
      const matched: MatchedFact[] = [];

      for (const requirement of requirements) {
        const hit = facts.find((fact) =>
          (fact.type === requirement.kind || fact.type === "skill") && mentions(fact.value, requirement.text));
        if (!hit) continue;
        if (!hit.confirmed) {
          // A record that would have matched but nobody has checked.
          unconfirmedEvidence = true;
          continue;
        }
        matched.push({ requirement: requirement.text, evidence: hit.value, kind: hit.type });
        satisfied.add(requirement.text);
      }

      if (years !== null) {
        const held = evidencedYears(facts, args.now);
        if (held >= years) {
          matched.push({ requirement: role.minimumExperience, evidence: `${held} years experience`, kind: "experience" });
          satisfied.add(role.minimumExperience);
        }
      }

      if (matched.length > 0) candidates.push({ personId: person.id, name: person.name, matched });
    }

    candidates.sort((a, b) => b.matched.length - a.matched.length || a.name.localeCompare(b.name));

    const gaps = [
      ...requirements.map((requirement) => requirement.text),
      ...(years !== null ? [role.minimumExperience] : []),
    ].filter((requirement) => !satisfied.has(requirement))
      .map((requirement) => `No team member holds: ${requirement}`);

    return {
      role: role.role,
      quantity: role.quantity,
      candidates,
      gaps,
      unconfirmedEvidence,
      assignedPersonId: args.assignments?.[role.role],
    };
  });
}

/**
 * Roles the tender makes mandatory that nobody can fill.
 *
 * These become pack blockers: submitting a bid that names nobody for a role the
 * buyer requires is a bid that will be rejected on the formality.
 */
export function roleBlockers(matches: RoleMatch[], roles: RequiredRole[]) {
  const mandatory = new Map(roles.map((role) => [role.role, role.cvRequired]));
  return matches
    .filter((match) => mandatory.get(match.role) && match.candidates.length === 0)
    .map((match) => `No team member can fill the required role: ${match.role}`);
}
