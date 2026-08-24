export type GateStatus = "PASS" | "REVIEW" | "FAIL" | "NOT_APPLICABLE";
export type BidDecision = "GO" | "PARTNER" | "REVIEW" | "NO_GO";

export type SourceEvidence = {
  sourceDocument: string;
  quote: string;
  confidence: "HIGH" | "MEDIUM" | "LOW";
};

export type EligibilityGate = {
  id: string;
  requirement: string;
  bidderEvidence: string;
  status: GateStatus;
  action: string;
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
  lots: string[];
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

export type PersonRecord = {
  id: string;
  accountId: string;
  name: string;
  title: string;
  cvText: string;
  skills: string[];
};

export type EvidenceRecord = {
  id: string;
  accountId: string;
  kind: string;
  name: string;
  content: string;
  tags: string[];
  verified: boolean;
};

/** What a company wants to see in Discover. Sector presets expand to the rest. */
export type DiscoveryPreferences = {
  sectors: string[];
  keywords: string[];
  cpvCodes: string[];
  valueMin: number | null;
  valueMax: number | null;
};
