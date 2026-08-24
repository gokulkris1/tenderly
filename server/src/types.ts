export type GateStatus = "PASS" | "REVIEW" | "FAIL" | "NOT_APPLICABLE";
export type BidDecision = "GO" | "PARTNER" | "REVIEW" | "NO_GO";

export type SourceEvidence = {
  sourceDocument: string;
  quote: string;
  confidence: "HIGH" | "MEDIUM" | "LOW";
};

/**
 * One lot of a divided tender.
 *
 * Irish framework and multi-region tenders are routinely split into lots with
 * distinct scope, value and eligibility. Flattening them into one set of gates
 * told a bidder who qualifies for lot 2 only that they fail the whole tender.
 */
export type TenderLot = {
  /** The pack's own identifier: "Lot 1", "Lot 2A". */
  id: string;
  title: string;
  scope: string;
  /** "[INPUT NEEDED: lot value]" when the pack states none. Never invented. */
  estimatedValue: string;
  evidence: SourceEvidence;
};

export type EligibilityGate = {
  id: string;
  requirement: string;
  bidderEvidence: string;
  status: GateStatus;
  action: string;
  /** The lot this applies to. Absent means it applies to the whole tender. */
  lotId?: string;
  evidence: SourceEvidence;
};

export type EvaluationCriterion = {
  name: string;
  /** Normalised to a percentage of the total award. 0 when unstated. */
  weight: number;
  /** The weighting as the pack expresses it, kept verbatim. */
  rawWeight: string;
  minimumScore: number;
  strategy: string;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  evidence: SourceEvidence;
};

export type AnalysisQuestion = {
  id: string;
  title: string;
  prompt: string;
  weight: number;
  maxWords: number;
  required: boolean;
  evidenceNeeded: string[];
  /** The lot this question belongs to. Absent means the whole tender. */
  lotId?: string;
  source: SourceEvidence;
};

export type RequiredRole = {
  role: string;
  quantity: number;
  minimumExperience: string;
  qualifications: string;
  cvRequired: boolean;
  bidderMatch: string;
  status: "PASS" | "REVIEW" | "FAIL";
  action: string;
  evidence: SourceEvidence;
};

/** A rule the buyer imposes on the submission itself: naming, limits, channel. */
export type SubmissionFormality = {
  rule: string;
  /** What the rule governs: "quality response", "all documents", "pricing". */
  appliesTo: string;
  evidence: SourceEvidence;
};

/** A certificate the tender requires the bidder to hold. */
export type RequiredCertificate = {
  name: string;
  issuingBody: string;
  /** True only when the pack makes it a condition of participation. */
  mandatory: boolean;
  evidence: SourceEvidence;
};

/**
 * What the pack says about using AI to produce the response. `not-stated` is
 * deliberately distinct from `unrestricted`: silence is not permission.
 */
export type AiUsePolicy = {
  state: "prohibited" | "disclosure-required" | "unrestricted" | "not-stated";
  evidence: SourceEvidence;
};

export type SubmissionChecklistItem = {
  id: string;
  label: string;
  required: boolean;
  kind: "RESPONSE" | "BUYER_TEMPLATE" | "SIGNATURE" | "PRICING" | "CV" | "OTHER";
  status: "READY" | "ACTION" | "VERIFY";
  source: SourceEvidence;
};

export type TenderAnalysis = {
  /** Shape version of this payload — see server/src/analysis-schema.ts. */
  schemaVersion?: string;
  /** Which versioned system prompt produced this analysis. */
  promptVersion?: string;
  headline: string;
  executiveSummary: string;
  bidType: "OPEN_CONTRACT" | "FRAMEWORK_ESTABLISHMENT" | "FRAMEWORK_MINI_COMPETITION" | "DPS" | "RESTRICTED" | "NEGOTIATED" | "UNKNOWN";
  access: "OPEN_TO_QUALIFIED_BIDDERS" | "FRAMEWORK_MEMBERS_ONLY" | "INVITED_ONLY" | "UNKNOWN";
  eligibility: "PASS" | "FAIL" | "REVIEW";
  fitScore: number;
  decision: BidDecision;
  partnerNeeded: boolean;
  partnerGaps: string[];
  deadline: string;
  clarificationDeadline: string;
  contractValue: string;
  duration: string;
  lots: TenderLot[];
  fatalGates: EligibilityGate[];
  evaluationCriteria: EvaluationCriterion[];
  questions: AnalysisQuestion[];
  roles: RequiredRole[];
  clarificationQuestions: string[];
  risks: string[];
  submissionMethod: string;
  formalities: SubmissionFormality[];
  requiredCertificates: RequiredCertificate[];
  aiUsePolicy?: AiUsePolicy;
  submissionChecklist: SubmissionChecklistItem[];
  synopsisSlides: Array<{ title: string; bullets: string[] }>;
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
  [key: string]: unknown;
};

export type PublicTender = {
  externalId: string;
  title: string;
  authority: string;
  description: string;
  published: string;
  deadline: string;
  procedure: string;
  status: string;
  estimatedValue: string;
  sourceUrl: string;
};

export type TenderRecord = PublicTender & {
  id: string;
  accountId: string;
  source: string;
  /** Canonical eight-digit CPV, absent when the notice carries no readable code. */
  cpvNormalised?: string;
  /** Cross-portal identity: two rows sharing this are one opportunity. */
  canonicalKey?: string;
  metadata: Record<string, unknown>;
  analysis: TenderAnalysis | null;
};

export type StoredDocument = {
  id: string;
  tenderId: string;
  filename: string;
  mimeType: string;
  role: "source" | "submission" | "evidence";
  sourceUrl?: string;
  bytes?: Buffer;
  extractedText: string;
  extractionStatus: string;
};

export type BidAnswer = {
  id: string;
  tenderId: string;
  questionId: string;
  response: string;
  status: string;
  evidence: string[];
};

/** How much of a response section a machine produced. See src/provenance.ts. */
export type ProvenanceClass = "ai-generated" | "ai-assisted" | "human";

/** One append-only ledger entry against a saved answer. */
export type ProvenanceEntry = {
  id: string;
  answerId: string;
  /** Which part of the answer this covers. Whole-answer entries use "body". */
  section: string;
  class: ProvenanceClass;
  /** Absent for human entries — nothing generated the text. */
  model?: string;
  promptVersion?: string;
  evidenceIds: string[];
  /** The email of the account that caused the entry. */
  actor: string;
  createdAt: string;
};

/**
 * A named slice of Discover.
 *
 * The same fields the preference profile uses, plus a buyer filter — so no new
 * matching logic is introduced, only a different set of inputs to it.
 */
export type SavedSearchFilter = {
  buyer: string;
  sectors: string[];
  keywords: string[];
  cpvCodes: string[];
  valueMin: number | null;
  valueMax: number | null;
};

export type SavedSearch = {
  id: string;
  accountId: string;
  name: string;
  filter: SavedSearchFilter;
  createdAt: string;
};

/**
 * A notice someone is keeping an eye on without committing to a bid.
 *
 * Deliberately not a tender: nothing is imported and no analysis is run, so
 * watching something costs nothing.
 */
export type WatchlistEntry = {
  id: string;
  accountId: string;
  externalId: string;
  title: string;
  authority: string;
  deadline: string;
  sourceUrl: string;
  note: string;
  createdAt: string;
};

/**
 * What the company chose to do about a tender.
 *
 * The recommendation is advice; this is the decision. Recorded with who made it
 * and what the recommendation said at the time, so a later re-analysis cannot
 * rewrite what they were actually looking at.
 */
export type BidDecisionRecord = {
  id: string;
  tenderId: string;
  decision: "BID" | "NO_BID";
  /** Mandatory when the choice goes against the recommendation. */
  reason: string;
  decidedBy: string;
  recommendationAtTheTime: string;
  createdAt: string;
};

/**
 * One recorded action that changes what eventually leaves the company.
 *
 * Entries never contain document contents or secrets — only what was acted on,
 * by whom, and when. See src/audit.ts.
 */
export type AuditEntry = {
  id: string;
  accountId: string;
  actor: string;
  /** Dotted action name: "evidence.verified", "pack.final.downloaded". */
  action: string;
  subjectType: string;
  subjectId: string;
  /** A label a person can recognise: a file name, an answer title. */
  subjectLabel: string;
  metadata: Record<string, unknown>;
  requestId?: string;
  createdAt: string;
};

/** One metered model call. See src/usage.ts. */
export type UsageEvent = {
  id: string;
  accountId: string;
  kind: "analysis" | "draft" | "critique";
  model: string;
  inputTokens: number;
  outputTokens: number;
  requestId?: string;
  tenderId?: string;
  createdAt: string;
};

/** An account's model usage over one calendar month. */
export type UsageTotals = {
  month: string;
  actions: number;
  inputTokens: number;
  outputTokens: number;
  byKind: { kind: string; actions: number; inputTokens: number; outputTokens: number }[];
};

export type PersonRecord = {
  id: string;
  accountId: string;
  name: string;
  title: string;
  cvText: string;
  skills: string[];
  email?: string;
  phone?: string;
  /**
   * When they were archived. An archived person is excluded from role matching
   * but still shown on the bids that cited them — rewriting those would make
   * the company's own submissions disagree with what the buyer received.
   */
  archivedAt?: string;
};

/**
 * One fact read from a CV.
 *
 * Unconfirmed until a person accepts it: a parsed claim about a named
 * individual is a suggestion, not a fact, and it is that individual's
 * credibility on the line in front of a buyer.
 */
export type PersonFact = {
  id: string;
  personId: string;
  type: "skill" | "role" | "certification" | "experience";
  value: string;
  /** Issuing body for a certification, employer for an experience entry. */
  detail: string;
  /** Year or date range exactly as the CV writes it. */
  period: string;
  /** The line in the CV this was read from. */
  quote: string;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  confirmed: boolean;
  createdAt: string;
};

export type EvidenceRecord = {
  id: string;
  accountId: string;
  kind: string;
  name: string;
  content: string;
  tags: string[];
  verified: boolean;
  /** The original file, when one was uploaded. Text-only rows have none. */
  filename?: string;
  contentType?: string;
  sizeBytes?: number;
  /** Who issued the document, as the buyer would ask it. */
  issuingBody?: string;
  issuedOn?: string;
  expiresOn?: string;
};

/** What a company wants to see in Discover. Sector presets expand to the rest. */
export type DiscoveryPreferences = {
  sectors: string[];
  keywords: string[];
  cpvCodes: string[];
  valueMin: number | null;
  valueMax: number | null;
};
