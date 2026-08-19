/**
 * Sector presets — the "easy lever" for discovery.
 *
 * eTenders makes a bidder pick CPV codes from a 9,000-entry classification, which
 * is the single biggest reason people give up on it. A preset is a plain-English
 * sector that expands to the keywords used to filter the notice list and the CPV
 * codes used once a tender is imported.
 *
 * CPV codes and their wording are taken from the official CPV 2008 classification
 * (division 72 IT services, division 48 software packages). They are not guessed:
 * a wrong code silently hides real opportunities.
 */
export type SectorPreset = {
  slug: string;
  label: string;
  description: string;
  /** Terms specific enough to mean IT on their own ("software testing", "devops"). */
  keywords: string[];
  /**
   * Terms that only mean IT in an IT context. "Testing" alone matches radon
   * testing and water testing; "development" alone matches property development.
   * These count only when the notice also carries a technology term.
   */
  contextKeywords: string[];
  /** Applied after import, where the detail page exposes CPV. */
  cpvCodes: { code: string; label: string }[];
};

/**
 * What makes a notice technology work. Deliberately broad — it only ever widens
 * a contextual keyword, never matches on its own.
 */
const IT_CONTEXT = [
  "software", "system", "systems", "ict", "information technology", "digital",
  "application", "applications", "platform", "technology", "website", "web",
  "online", "portal", "data", "cyber", "network", "cloud", "api", "computer",
];

/** Whole-word match: "uat" must not match "valuation", "it" must not match "with". */
function containsTerm(haystack: string, term: string) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(haystack);
}

const hasItContext = (haystack: string) => IT_CONTEXT.some((term) => containsTerm(haystack, term));

export const SECTOR_PRESETS: SectorPreset[] = [
  {
    slug: "software-development",
    label: "Software development and delivery",
    description: "Building, integrating and delivering software: custom development, platforms, APIs, web and mobile.",
    keywords: [
      "software", "software development", "custom software", "bespoke software",
      "application development", "web development", "website", "web portal",
      "mobile app", "mobile application", "api", "devops", "digital platform",
      "digital service", "digital services", "e-services", "software solution",
      "systems integration", "system implementation", "low-code", "saas",
    ],
    contextKeywords: ["development", "developer", "platform", "integration", "agile", "implementation", "digital"],
    cpvCodes: [
      { code: "72200000", label: "Software programming and consultancy services" },
      { code: "72230000", label: "Custom software development services" },
      { code: "72240000", label: "Systems analysis and programming services" },
      { code: "72210000", label: "Programming services of packaged software products" },
      { code: "48000000", label: "Software package and information systems" },
    ],
  },
  {
    slug: "software-testing",
    label: "Software testing and QA",
    description: "Independent test services: functional and non-functional testing, QA, audit, accessibility and penetration testing.",
    keywords: [
      "software testing", "test automation", "automated testing", "penetration test",
      "penetration testing", "pen test", "quality assurance", "user acceptance testing",
      "uat", "load testing", "performance testing", "accessibility audit",
      "accessibility testing", "security testing", "test management", "qa services",
    ],
    contextKeywords: ["testing", "test services", "assurance", "audit"],
    cpvCodes: [
      { code: "72800000", label: "Computer audit and testing services" },
      { code: "72820000", label: "Computer testing services" },
      { code: "72810000", label: "Computer audit services" },
    ],
  },
  {
    slug: "it-support",
    label: "IT support and managed services",
    description: "Running and supporting systems: service desk, maintenance, managed and support services.",
    keywords: [
      "it support", "ict support", "service desk", "helpdesk", "help desk",
      "managed it", "managed ict", "end user computing", "software licensing",
      "software maintenance", "system maintenance", "software licences", "software licenses",
    ],
    contextKeywords: ["support services", "managed service", "managed services", "maintenance", "licensing"],
    cpvCodes: [
      { code: "72250000", label: "System and support services" },
      { code: "72600000", label: "Computer support and consultancy services" },
      { code: "72260000", label: "Software-related services" },
    ],
  },
  {
    slug: "data-analytics",
    label: "Data and analytics",
    description: "Data platforms, migration, reporting, business intelligence and analytics.",
    keywords: [
      "business intelligence", "data warehouse", "data platform", "data migration",
      "data analytics", "analytics", "master data", "power bi", "data visualisation",
      "data management system",
    ],
    contextKeywords: ["data", "reporting", "dashboard"],
    cpvCodes: [{ code: "72300000", label: "Data services" }],
  },
  {
    slug: "cloud-infrastructure",
    label: "Cloud and infrastructure",
    description: "Hosting, cloud migration, networks and technical infrastructure consultancy.",
    keywords: [
      "cloud", "cloud migration", "azure", "aws", "data centre", "data center",
      "web hosting", "virtualisation", "network infrastructure", "server infrastructure",
    ],
    contextKeywords: ["infrastructure", "network", "connectivity", "hosting"],
    cpvCodes: [
      { code: "72400000", label: "Internet services" },
      { code: "72220000", label: "Systems and technical consultancy services" },
    ],
  },
];

export const presetBySlug = (slug: string) => SECTOR_PRESETS.find((preset) => preset.slug === slug);

/** Every keyword a profile matches on: its presets' keywords plus its own. */
export function profileKeywords(sectors: string[], keywords: string[]) {
  const fromPresets = sectors.flatMap((slug) => {
    const preset = presetBySlug(slug);
    return preset ? [...preset.keywords, ...preset.contextKeywords] : [];
  });
  return [...new Set([...fromPresets, ...keywords].map((word) => word.trim().toLowerCase()).filter(Boolean))];
}

/** Every CPV code a profile covers: its presets' codes plus any entered by hand. */
export function profileCpvCodes(sectors: string[], cpvCodes: string[]) {
  const fromPresets = sectors.flatMap((slug) => presetBySlug(slug)?.cpvCodes.map((entry) => entry.code) ?? []);
  return [...new Set([...fromPresets, ...cpvCodes].map((code) => code.trim()).filter(Boolean))];
}

/**
 * Which presets a notice matches, and on which keyword. Returned to the UI so a
 * user can see why something is in their list — and correct the profile when it
 * is wrong, rather than distrusting the whole feed.
 */
export function matchNotice(text: string, sectors: string[], keywords: string[]) {
  const haystack = text.toLowerCase();
  const inItContext = hasItContext(haystack);
  const reasons: { sector: string; label: string; keyword: string }[] = [];
  for (const slug of sectors) {
    const preset = presetBySlug(slug);
    if (!preset) continue;
    const strong = preset.keywords.find((keyword) => containsTerm(haystack, keyword));
    if (strong) { reasons.push({ sector: preset.slug, label: preset.label, keyword: strong }); continue; }
    // A generic term only counts when the notice is plainly about technology.
    if (!inItContext) continue;
    const contextual = preset.contextKeywords.find((keyword) => containsTerm(haystack, keyword));
    if (contextual) reasons.push({ sector: preset.slug, label: preset.label, keyword: contextual });
  }
  for (const keyword of keywords) {
    const needle = keyword.trim().toLowerCase();
    if (needle && containsTerm(haystack, needle)) reasons.push({ sector: "keyword", label: "Your keyword", keyword: needle });
  }
  return reasons;
}
