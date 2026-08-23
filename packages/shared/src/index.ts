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
  state: GateState;
  /** What the bidder can show for this requirement, or why nothing was found. */
  bidder: string;
  requirement: string;
  /** Document name and quoted passage the requirement was read from. */
  source: string;
};

export type BidQuestion = {
  id: string;
  title: string;
  weight: number;
  maxWords: number;
  required?: boolean;
  status: AnswerStatus;
  prompt: string;
  answer: string;
  evidence: string[];
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
  /** Award criteria with weightings, empty when the pack states none. */
  awardCriteria?: AwardCriterion[];
  /** Set when the stated weightings do not add up, e.g. "Stated weightings sum to 90%". */
  awardCriteriaWarning?: string;
  /** Submission rules extracted from the pack: naming, limits, channel, signatures. */
  formalities?: Formality[];
  /** Certificates the tender requires, each with whether the company evidences it. */
  requiredCertificates?: RequiredCertificateStatus[];
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

/** Why a notice is in the list — shown so a user can correct their profile. */
export type MatchReason = {
  sector: string;
  label: string;
  keyword: string;
};
