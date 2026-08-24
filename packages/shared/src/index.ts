/**
 * The wire contract between the Tenderly API and the web app.
 *
 * These types describe exactly what `server/src/serializers.ts` emits and what
 * the web app consumes. They are declarations only: every import of this package
 * is an `import type`, erased at compile time, so nothing here is bundled or
 * resolved at runtime.
 *
 * Change a type here and both sides fail to compile together — which is the point.
 */

/** A bid recommendation. One spelling, on the wire and in the domain (TLY-21). */
export type Decision = "GO" | "PARTNER" | "REVIEW" | "NO_GO";

/** Whether a requirement is met. Missing or conflicting evidence is `review` — never `pass`. */
export type GateState = "pass" | "review" | "fail";

/** The same judgement, in the upper-case form the analysis and pack gating use. */
export type EligibilityState = "PASS" | "REVIEW" | "FAIL";

/** Where a saved answer stands. `needs-input` means it carries `[INPUT NEEDED: …]` markers. */
export type AnswerStatus = "ready" | "draft" | "needs-input";

export type SubmissionItemKind =
  | "RESPONSE"
  | "BUYER_TEMPLATE"
  | "SIGNATURE"
  | "PRICING"
  | "CV"
  | "OTHER";

export type SubmissionItemStatus = "READY" | "ACTION" | "VERIFY";

export type Gate = {
  label: string;
  /** The lot this gate applies to. Absent means the whole tender. */
  lotId?: string;
  state: GateState;
  /** What the bidder can show for this requirement, or why nothing was found. */
  bidder: string;
  requirement: string;
  /** Document name and quoted passage the requirement was read from. */
  source: string;
};

/** How much of a response section a machine produced. */
export type ProvenanceClass = "ai-generated" | "ai-assisted" | "human";

/** One entry in an answer's append-only provenance ledger. */
export type ProvenanceEntry = {
  section: string;
  class: ProvenanceClass;
  model?: string;
  promptVersion?: string;
  evidenceIds: string[];
  actor: string;
  createdAt: string;
};

export type BidQuestion = {
  id: string;
  title: string;
  /** The lot this question belongs to. Absent means the whole tender. */
  lotId?: string;
  weight: number;
  maxWords: number;
  required?: boolean;
  status: AnswerStatus;
  prompt: string;
  answer: string;
  evidence: string[];
  /**
   * The badge shown against the answer: the class of its latest ledger entry.
   * Absent when nothing has been recorded — an answer with no ledger makes no
   * claim about how it was written.
   */
  provenance?: ProvenanceEntry;
};

export type BidRole = {
  role: string;
  quantity: number;
  experience: string;
  qualifications: string;
  cvRequired: boolean;
  bidderMatch: string;
  status: EligibilityState;
  action: string;
  source: string;
};

export type SubmissionItem = {
  id: string;
  label: string;
  required: boolean;
  kind: SubmissionItemKind;
  status: SubmissionItemStatus;
  source: string;
};

/** An answer whose question is no longer in the analysis. Never discarded. */
export type OrphanedAnswer = {
  questionId: string;
  response: string;
  status: string;
};

/** An award criterion as the buyer states it, normalised for comparison. */
export type AwardCriterion = {
  name: string;
  /** Percentage of the total award. 0 when the pack does not state one. */
  weight: number;
  /** The weighting verbatim from the pack: "600 points", "60%", or "". */
  rawWeight: string;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  /** Document name and the quoted sentence the weighting was read from. */
  source: string;
  quote: string;
};

/** A rule the buyer imposes on the submission itself. */
export type Formality = {
  rule: string;
  appliesTo: string;
  source: string;
  quote: string;
};

/** A certificate the tender requires, and whether the company can evidence it. */
export type RequiredCertificateStatus = {
  name: string;
  issuingBody: string;
  mandatory: boolean;
  /** True when a verified evidence item covers it. */
  satisfied: boolean;
  /** The evidence item cited, when satisfied. */
  satisfiedBy?: string;
  source: string;
  quote: string;
};

/**
 * What the pack says about producing the response with AI.
 *
 * `not-stated` is deliberately distinct from `unrestricted`: a pack that is
 * silent has not given permission, and the UI says so rather than assuming.
 */
export type AiUsePolicy = {
  state: "prohibited" | "disclosure-required" | "unrestricted" | "not-stated";
  source: string;
  quote: string;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  /** Set once a person has confirmed or dismissed the flag. */
  acknowledgement?: AiPolicyAcknowledgement;
};

/** Who confirmed or dismissed the AI-use flag, and when. */
export type AiPolicyAcknowledgement = {
  action: "confirmed" | "dismissed";
  actor: string;
  at: string;
};

/**
 * What this buyer has awarded under this CPV. Every figure is a fact from the
 * OGP dataset; an empty sample says so rather than guessing.
 */
export type AwardIntelligence = {
  awards: number;
  medianValue: number | null;
  minValue: number | null;
  maxValue: number | null;
  topSuppliers: { supplier: string; awards: number }[];
  /** True when the figures come from the CPV division, not the exact code. */
  relatedCpv: boolean;
  /** Set when the company itself appears among this authority's suppliers. */
  companyAwards?: number;
  /** CC-BY-4.0 attribution, shown wherever the figures are. */
  licenceNote: string;
};

/** A named person's statement that they reviewed this exact content. */
export type Attestation = {
  actor: string;
  at: string;
  contentVersion: string;
};

/** What the attester is being asked to stand behind. */
export type AttestationState = {
  summary: {
    counts: { "ai-generated": number; "ai-assisted": number; human: number };
    aiGeneratedSections: string[];
    /** Set when the pack prohibits AI content and a section was written by one. */
    conflict?: string;
  };
  attestation: Attestation | null;
  /** The attestation no longer matches the content, so the pack is blocked again. */
  invalidated: boolean;
  blockers: string[];
};

/**
 * A tender's CPV as it will be shown. An unrecognised value keeps its own
 * wording: a notice with a code we do not hold is still a notice.
 */
export type TenderCpv = {
  /** The raw string exactly as the source published it. */
  raw: string;
  /** Eight digits, absent when nothing recognisable could be read. */
  code?: string;
  description?: string;
  /** Broader codes that exist in the published list, nearest first. */
  ancestors?: { code: string; description: string }[];
  recognised: boolean;
};

/** One lot of a divided tender, as shown on the Qualify stage. */
export type Lot = {
  id: string;
  title: string;
  scope: string;
  /** "[INPUT NEEDED: lot value]" when the pack states none. */
  estimatedValue: string;
  source: string;
  quote: string;
};

export type SynopsisSlide = {
  title: string;
  bullets: string[];
};

export type Tender = {
  id: string;
  resourceId: string;
  title: string;
  authority: string;
  category: string;
  procedure: string;
  deadline: string;
  deadlineIso?: string;
  value: string;
  match: number;
  decision: Decision;
  access: string;
  summary: string;
  sourceUrl: string;
  published: string;
  framework: string;
  partnerNote?: string;
  gates: Gate[];
  questions: BidQuestion[];
  eligibility?: EligibilityState;
  roles?: BidRole[];
  submissionChecklist?: SubmissionItem[];
  risks?: string[];
  synopsisSlides?: SynopsisSlide[];
  /** Shape version of the stored analysis, absent on tenders never analysed. */
  schemaVersion?: string;
  /** Which versioned system prompt produced the analysis. Absent on the no-key fallback. */
  promptVersion?: string;
  /** The stored analysis predates the current shape; offer a re-analysis. */
  analysisOutdated?: boolean;
  /** Saved answers whose question the latest analysis no longer contains. */
  orphanedAnswers?: OrphanedAnswer[];
  /** Which sector presets or keywords put this notice in the Discover list. */
  matchedBy?: MatchReason[];
  /** Which feed the notice came from, so a user can tell TED from eTenders. */
  noticeSource?: "eTenders" | "TED";
  /** Lots the pack divides this tender into. Empty when it is undivided. */
  lots?: Lot[];
  /** Lot ids the user is bidding. Empty means the whole tender is in scope. */
  selectedLots?: string[];
  /** The tender's CPV, normalised where the code is one we hold. */
  cpv?: TenderCpv;
  /** Why this notice scored what it did. Present on every scored notice. */
  scoreBreakdown?: ScoreBreakdown;
  /**
   * Every portal that published this notice. More than one entry means the same
   * opportunity was found on both eTenders and TED and merged into one row.
   */
  alternateSources?: { label: string; url: string }[];
  /** How the merge was decided: a shared OJEU reference, or the fallback triple. */
  mergeReason?: "reference" | "heuristic";
  /** Historical awards by this buyer under this CPV. Absent until analysed. */
  awardIntelligence?: AwardIntelligence;
  /** Award criteria with weightings, empty when the pack states none. */
  awardCriteria?: AwardCriterion[];
  /** Set when the stated weightings do not add up, e.g. "Stated weightings sum to 90%". */
  awardCriteriaWarning?: string;
  /** Submission rules extracted from the pack: naming, limits, channel, signatures. */
  formalities?: Formality[];
  /** Certificates the tender requires, each with whether the company evidences it. */
  requiredCertificates?: RequiredCertificateStatus[];
  /** What the pack says about producing the response with AI. */
  aiUsePolicy?: AiUsePolicy;
  /**
   * Generation is disabled for this tender: no drafting, no refinement, no
   * template auto-fill. Analysis, checklists, gap analysis and critique remain.
   */
  noAiMode?: boolean;
};

export type EvidenceItem = {
  id: string;
  kind: string;
  name: string;
  content: string;
  tags: string[];
  /** Only verified evidence is ever sent to the model or cited in an answer. */
  verified: boolean;
};

export type PersonItem = {
  id: string;
  name: string;
  title: string;
  cvText: string;
  skills: string[];
};

export type NotificationItem = {
  id: string;
  title: string;
  sourceUrl: string;
  matchScore: number;
  createdAt?: string;
};

/**
 * One recorded action that changes what eventually leaves the company.
 * Entries never carry document contents or secrets.
 */
export type AuditEntry = {
  id: string;
  actor: string;
  /** Dotted action name: "evidence.verified", "pack.final.downloaded". */
  action: string;
  subjectType: string;
  subjectId: string;
  subjectLabel: string;
  metadata: Record<string, unknown>;
  createdAt: string;
};

/** An account's model usage for one calendar month. */
export type UsageTotals = {
  month: string;
  actions: number;
  inputTokens: number;
  outputTokens: number;
  byKind: { kind: string; actions: number; inputTokens: number; outputTokens: number }[];
};

export type CompanyProfile = {
  name: string;
  registration: string;
  turnover: string;
  employees: string;
  services: string;
  cpv: string;
  certifications: string;
  insurance: string;
};

/** A plain-English sector a user can tick, instead of hunting CPV codes. */
export type SectorPreset = {
  slug: string;
  label: string;
  description: string;
  cpvCodes: { code: string; label: string }[];
};

/** What a company wants to see in Discover. */
export type DiscoveryPreferences = {
  sectors: string[];
  keywords: string[];
  cpvCodes: string[];
  valueMin: number | null;
  valueMax: number | null;
};

/**
 * One reason a notice scored what it scored, with the profile fact behind it.
 * The contributions sum to the displayed total, so the number is checkable.
 */
export type ScoreContribution = {
  kind: "cpv-exact" | "cpv-ancestor" | "sector" | "keyword" | "value-band" | "buyer-known";
  label: string;
  points: number;
  matched: string;
};

/** The full explanation of a notice's score. */
export type ScoreBreakdown = {
  total: number;
  contributions: ScoreContribution[];
  /** Shown instead of an empty list, so a zero is never left unexplained. */
  note?: string;
};

/** Why a notice is in the list — shown so a user can correct their profile. */
export type MatchReason = {
  sector: string;
  label: string;
  keyword: string;
};
