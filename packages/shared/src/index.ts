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
