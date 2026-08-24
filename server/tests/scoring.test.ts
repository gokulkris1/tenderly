import assert from "node:assert/strict";
import test from "node:test";
import { parseContractValue, scoreNotice } from "../src/scoring.js";
import { serializePublicTender } from "../src/serializers.js";
import type { CompanyProfile, DiscoveryPreferences, PublicTender } from "../src/types.js";

const notice = (over: Partial<PublicTender> & { cpvNormalised?: string } = {}) => ({
  externalId: "1", title: "Deep retrofit programme management", authority: "Dublin City Council",
  description: "Energy services for a public building retrofit", published: "", deadline: "",
  procedure: "Open", status: "", estimatedValue: "250,000.00",
  sourceUrl: "https://www.etenders.gov.ie/x", ...over,
});

const preferences = (over: Partial<DiscoveryPreferences> = {}): DiscoveryPreferences => ({
  sectors: [], keywords: ["retrofit"], cpvCodes: ["71314000"], valueMin: null, valueMax: null, ...over,
});

const company = (over: Partial<CompanyProfile> = {}): CompanyProfile => ({
  name: "Acme Engineering", registration: "IE1", turnover: "€3.4m", employees: "22",
  services: "Energy retrofit", cpv: "", certifications: "", insurance: "", ...over,
});

test("TLY-36 AC1: an exact CPV match and a keyword match are named, and they sum to the total", () => {
  const breakdown = scoreNotice({ tender: notice({ cpvNormalised: "71314000" }), preferences: preferences(), company: company() });
  const kinds = breakdown.contributions.map((item) => item.kind);
  assert.ok(kinds.includes("cpv-exact"), "the exact CPV match is named");
  assert.ok(kinds.includes("keyword"), "the keyword match is named");

  const summed = breakdown.contributions.reduce((total, item) => total + item.points, 0);
  assert.equal(breakdown.total, summed, "the displayed total is the sum of what is shown");

  const keyword = breakdown.contributions.find((item) => item.kind === "keyword");
  assert.equal(keyword?.matched, "retrofit", "the contribution names the profile fact behind it");
});

test("TLY-36 AC2: an ancestor CPV match scores fewer points than an exact one", () => {
  const exact = scoreNotice({ tender: notice({ cpvNormalised: "71314000" }), preferences: preferences(), company: company() });
  const ancestor = scoreNotice({ tender: notice({ cpvNormalised: "71300000" }), preferences: preferences(), company: company() });

  const exactPoints = exact.contributions.find((item) => item.kind === "cpv-exact")?.points ?? 0;
  const ancestorPoints = ancestor.contributions.find((item) => item.kind === "cpv-ancestor")?.points ?? 0;
  assert.ok(ancestorPoints > 0, "a related code is a real signal");
  assert.ok(ancestorPoints < exactPoints, "but a weaker one than the buyer asking for exactly your code");
  assert.ok(ancestor.total < exact.total);
});

test("TLY-36 AC3: a notice matching nothing scores zero and says so", () => {
  const breakdown = scoreNotice({
    tender: notice({ title: "Supply of school catering", description: "Hot meals", cpvNormalised: "55524000" }),
    preferences: preferences(), company: company(),
  });
  assert.equal(breakdown.total, 0);
  assert.deepEqual(breakdown.contributions, []);
  assert.equal(breakdown.note, "No profile facts matched", "a zero is never left unexplained");
});

test("TLY-36 AC5: removing a keyword drops the total by exactly that contribution", () => {
  const withKeyword = scoreNotice({ tender: notice({ cpvNormalised: "71314000" }), preferences: preferences(), company: company() });
  const contribution = withKeyword.contributions.find((item) => item.kind === "keyword");
  assert.ok(contribution);

  const without = scoreNotice({
    tender: notice({ cpvNormalised: "71314000" }),
    preferences: preferences({ keywords: [] }), company: company(),
  });
  assert.ok(!without.contributions.some((item) => item.kind === "keyword"), "the contribution is gone");
  assert.equal(without.total, withKeyword.total - contribution.points, "and the total dropped by exactly its points");
});

test("TLY-36 AC4: every scored notice reaches the wire with its breakdown", () => {
  const breakdown = scoreNotice({ tender: notice({ cpvNormalised: "71314000" }), preferences: preferences(), company: company() });
  const wire = serializePublicTender(notice(), breakdown);
  assert.equal(wire.match, breakdown.total);
  assert.deepEqual(wire.scoreBreakdown, breakdown, "the number and its reasons travel together");

  const zero = serializePublicTender(notice(), scoreNotice({
    tender: notice({ title: "Catering", description: "Meals" }), preferences: preferences(), company: company(),
  }));
  assert.equal(zero.match, 0);
  assert.equal(zero.scoreBreakdown?.note, "No profile facts matched", "a zero still carries an explanation");
});

test("TLY-36: the value band contributes only when the notice falls inside it", () => {
  const inside = scoreNotice({
    tender: notice({ estimatedValue: "250,000.00" }),
    preferences: preferences({ valueMin: 100_000, valueMax: 500_000 }), company: company(),
  });
  assert.ok(inside.contributions.some((item) => item.kind === "value-band"));

  const outside = scoreNotice({
    tender: notice({ estimatedValue: "12,000.00" }),
    preferences: preferences({ valueMin: 100_000, valueMax: 500_000 }), company: company(),
  });
  assert.ok(!outside.contributions.some((item) => item.kind === "value-band"));

  const noBand = scoreNotice({ tender: notice(), preferences: preferences(), company: company() });
  assert.ok(!noBand.contributions.some((item) => item.kind === "value-band"),
    "a user who set no range gets no points for one");
});

test("TLY-36: a buyer this company has won from before is a named contribution", () => {
  const known = scoreNotice({
    tender: notice(), preferences: preferences(), company: company(),
    knownBuyers: ["dublin city council"],
  });
  const entry = known.contributions.find((item) => item.kind === "buyer-known");
  assert.match(entry?.label ?? "", /won work from Dublin City Council before/);

  const unknown = scoreNotice({ tender: notice(), preferences: preferences(), company: company(), knownBuyers: [] });
  assert.ok(!unknown.contributions.some((item) => item.kind === "buyer-known"));
});

test("TLY-36: scoring is deterministic and never claims a certainty we do not have", () => {
  const args = { tender: notice({ cpvNormalised: "71314000" }), preferences: preferences({ sectors: [], keywords: ["retrofit", "energy", "programme"] }), company: company(), knownBuyers: ["dublin city council"] };
  const first = scoreNotice(args);
  const second = scoreNotice(args);
  assert.deepEqual(first, second, "the same inputs always give the same number");
  assert.ok(first.total <= 95, "the score never reads as certainty");
});

test("TLY-36: one sector contributes once, however many of its terms appear", () => {
  const breakdown = scoreNotice({
    tender: notice({ title: "Software development and software testing services", description: "Custom software development" }),
    preferences: preferences({ sectors: ["software-development"], keywords: [], cpvCodes: [] }),
    company: company(),
  });
  const sectors = breakdown.contributions.filter((item) => item.kind === "sector");
  assert.ok(sectors.length <= 1, "a notice is not twice as relevant for repeating a sector's words");
});

test("TLY-36: a contract value is parsed, not digit-stripped", () => {
  // Stripping punctuation turned "250,000.00" into 25,000,000 — a hundredfold
  // overstatement that hid every real contract above a user's stated ceiling.
  assert.equal(parseContractValue("250,000.00"), 250_000);
  assert.equal(parseContractValue("€1,250,000"), 1_250_000);
  assert.equal(parseContractValue("49,000.00"), 49_000);
  assert.equal(parseContractValue("12000"), 12_000);
  assert.equal(parseContractValue("Not stated"), null);
  assert.equal(parseContractValue(""), null);
  assert.equal(parseContractValue(undefined), null);
});
