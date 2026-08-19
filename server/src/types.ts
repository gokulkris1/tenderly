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
  weight: number;
  minimumScore: number;
  strategy: string;
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
