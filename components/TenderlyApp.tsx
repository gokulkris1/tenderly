"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ApiError, createApiClient } from "../web/src/api/client";
import "./tenderly.css";

import type {
  AiUsePolicy,
  AnalysisChanges,
  AnswerVersion,
  AttestationState,
  AuditEntry,
  AwardCriterion,
  AwardIntelligence as AwardIntelligenceData,
  BidQuestion,
  BidTask,
  Clarification,
  CompanyProfile,
  DeadlinePressure,
  Decision,
  DeclarationAnswer,
  DeclarationState,
  DiffSegment,
  DiscoveryPreferences,
  EvidenceItem,
  Formality,
  Gate,
  GateState,
  Lot,
  MockEvaluation,
  NotificationItem,
  PackQuestion,
  PersonFact,
  PersonItem,
  Portfolio,
  PortfolioRow,
  ProvenanceClass,
  ProvenanceEntry,
  Recommendation,
  RequiredCertificateStatus,
  RoleMatch,
  Runbook,
  SavedSearch,
  SavedSearchFilter,
  ScoreBreakdown,
  SectorPreset,
  SkillMatrix,
  SubmissionItem,
  Tender,
  UsageTotals,
  VaultCompleteness,
  WatchlistItem,
} from "@tenderly/shared";

// Screen navigation is local to the app, not part of the wire contract.
type AppSection = "Discover" | "Watchlist" | "Portfolio" | "My bids" | "Evidence" | "Team" | "Company" | "Settings";
type BidStage = "Qualify" | "Synopsis" | "Respond" | "Assemble" | "Submit";

/** The URL is the source of truth for which screen is showing (TLY-23). */
const SECTION_PATHS: Record<AppSection, string> = {
  Discover: "/discover",
  "My bids": "/bids",
  Evidence: "/evidence",
  Team: "/team",
  Company: "/company",
  Watchlist: "/watchlist",
  Portfolio: "/portfolio",
  Settings: "/settings",
};
const stageSlug = (stage: BidStage) => stage.toLowerCase().replace(/\s+/g, "-");
const STAGES: BidStage[] = ["Qualify", "Synopsis", "Respond", "Assemble", "Submit"];

function readLocation(pathname: string): { section: AppSection; stage: BidStage; tenderId: string } {
  const parts = pathname.split("/").filter(Boolean);
  if (parts[0] === "bids") {
    const stage = STAGES.find((item) => stageSlug(item) === (parts[2] ?? "")) ?? "Qualify";
    return { section: "My bids", stage, tenderId: parts[1] ?? "" };
  }
  const entry = (Object.entries(SECTION_PATHS) as [AppSection, string][])
    .find(([, path]) => path === `/${parts[0] ?? ""}`);
  return { section: entry ? entry[0] : "Discover", stage: "Qualify", tenderId: "" };
}

// The CSS keys off hyphenated slugs; the wire enum is underscored.
const decisionSlug = (decision: Decision) => decision.toLowerCase().replace(/_/g, "-");

const API_BASE = process.env.VITE_API_URL ?? "";

// One client for the whole app. The token lives in component state, so it is read
// through a holder rather than captured — a screen must never see a stale token.
let currentToken = "";
const apiClient = createApiClient({ baseUrl: API_BASE, getToken: () => currentToken });

const demoTenders: Tender[] = [
  {
    id: "pmp-training",
    resourceId: "8796138",
    title: "RFQ for the Delivery of Project Management Professional Training (PMP)",
    authority: "BioPharmaChem Skillnet",
    category: "Professional services",
    procedure: "Open",
    deadline: "27 Aug · 12:00",
    deadlineIso: "2026-08-27T12:00:00+01:00",
    value: "€49,000",
    match: 86,
    decision: "GO",
    access: "Open to qualified bidders",
    summary:
      "Delivery of PMP preparation training up to three times per year in Ireland. The opportunity is open; no framework-membership restriction was identified in the notice.",
    sourceUrl: "https://www.etenders.gov.ie/epps/quickSearchAction.do?searchType=cftFTS",
    published: "6 Aug 2026",
    framework: "Direct contract",
    gates: [
      { label: "Competition access", state: "pass", bidder: "Open procedure", requirement: "Open tender submission", source: "eTenders notice · Procedure: Open" },
      { label: "Delivery location", state: "pass", bidder: "Ireland", requirement: "Republic of Ireland", source: "eTenders notice · Services shall be delivered within the Republic of Ireland" },
      { label: "PMP capability", state: "pass", bidder: "Programme / project delivery", requirement: "PMP preparation training", source: "eTenders notice · Delivery of Project Management Professional preparation Training" },
      { label: "Trainer credentials", state: "review", bidder: "CV evidence required", requirement: "Confirm named-trainer requirements", source: "Tender documents · not yet imported" },
    ],
    questions: [
      {
        id: "q1",
        title: "Approach to delivery and learner outcomes",
        weight: 35,
        maxWords: 900,
        status: "draft",
        prompt: "Describe the proposed methodology for delivering the PMP preparation programme and ensuring learner outcomes.",
        answer: "",
        evidence: ["Programme delivery methodology", "Training governance case study"],
      },
      {
        id: "q2",
        title: "Experience of proposed personnel",
        weight: 30,
        maxWords: 700,
        status: "needs-input",
        prompt: "Demonstrate the qualifications and relevant experience of the personnel proposed for delivery.",
        answer: "",
        evidence: ["Gokul Gurijala · Delivery CV", "Second trainer CV needed"],
      },
      {
        id: "q3",
        title: "Quality assurance and continuous improvement",
        weight: 15,
        maxWords: 500,
        status: "draft",
        prompt: "Explain the quality controls and improvement loop applied to the programme.",
        answer: "",
        evidence: ["QA governance model"],
      },
    ],
  },
  {
    id: "energy-audit",
    resourceId: "8788179",
    title: "Deep Energy Retrofit 2 — Stage 0 Energy Audit",
    authority: "Health Service Executive (HSE)",
    category: "Consulting",
    procedure: "Open",
    deadline: "11 Sep · 17:00",
    value: "Not stated",
    match: 61,
    decision: "PARTNER",
    access: "Open to qualified bidders",
    summary:
      "Specialist energy consulting services for Stage 0 audits across 30 healthcare facilities. Delivery capability is adjacent, but specialist energy-audit credentials appear material.",
    sourceUrl: "https://www.etenders.gov.ie/epps/quickSearchAction.do?searchType=cftFTS",
    published: "6 Aug 2026",
    framework: "Direct contract",
    partnerNote: "Partner with an SEAI / building-energy specialist before committing bid effort.",
    gates: [
      { label: "Competition access", state: "pass", bidder: "Open procedure", requirement: "Open tender submission", source: "eTenders notice · Procedure: Open" },
      { label: "Energy audit expertise", state: "review", bidder: "Gap in profile", requirement: "Specialist Stage 0 energy audit capability", source: "eTenders notice · specialist energy consulting services" },
      { label: "National delivery", state: "pass", bidder: "Ireland delivery", requirement: "30 healthcare sites", source: "eTenders notice · across 30 SEU healthcare facilities" },
    ],
    questions: [],
  },
  {
    id: "flood-risk",
    resourceId: "8799735",
    title: "Multi-Party Framework for Flood Risk Assessment Consultancy Services",
    authority: "Limerick City and County Council",
    category: "Engineering consultancy",
    procedure: "Open",
    deadline: "4 Sep · 12:00",
    value: "Not stated",
    match: 28,
    decision: "NO_GO",
    access: "Framework establishment — open competition",
    summary:
      "This is the competition to establish a multi-party framework, not a mini-competition restricted to existing members. Access is open, but the specialist flood-risk capability is outside the current company profile.",
    sourceUrl: "https://www.etenders.gov.ie/epps/quickSearchAction.do?searchType=cftFTS",
    published: "6 Aug 2026",
    framework: "Multi-party framework establishment",
    gates: [
      { label: "Competition access", state: "pass", bidder: "New entrants permitted", requirement: "Framework establishment", source: "eTenders notice · Establishment of a Multi-Party Framework" },
      { label: "Flood-risk expertise", state: "fail", bidder: "Not evidenced", requirement: "Strategic Flood Risk Assessment consultancy", source: "eTenders notice · preparation of Strategic Flood Risk Assessments" },
    ],
    questions: [],
  },
];

const initialCompany: CompanyProfile = {
  name: "Ingenie Technologies Ltd",
  registration: "",
  turnover: "",
  employees: "",
  services: "Programme delivery, technology consulting, QA & testing, IoT, telecoms, cloud delivery",
  cpv: "72224000, 72220000, 79421000",
  certifications: "PRINCE2, ISTQB, Scrum, Agentic AI",
  insurance: "Add PI / PL / EL policy limits",
};

const demoEvidence: EvidenceItem[] = [
  { id: "ev-1", kind: "Case study", name: "National telecom platform delivery", content: "Verified delivery reference for programme, migration and governance work.", tags: ["Telecom", "Programme", "Migration"], verified: true },
  { id: "ev-2", kind: "Method", name: "Programme governance & RAID model", content: "Reusable programme governance and RAID controls.", tags: ["Delivery", "Governance"], verified: true },
  { id: "ev-3", kind: "Policy", name: "Information security approach", content: "Draft reusable information-security evidence.", tags: ["Security", "GDPR"], verified: false },
];

const demoPeople: PersonItem[] = [
  { id: "person-1", name: "Gokul Gurijala", title: "Programme & Project Delivery", cvText: "20+ years across telecom, banking, IoT and SaaS delivery.", skills: ["Programme", "Telecom", "QA"] },
];

const demoNotifications: NotificationItem[] = [
  { id: "note-1", title: "PMP Training · 86% preview match", sourceUrl: demoTenders[0].sourceUrl, matchScore: 86 },
  { id: "note-2", title: "HSE energy-audit tender · partner review", sourceUrl: demoTenders[1].sourceUrl, matchScore: 61 },
];

const navItems: { label: AppSection; icon: string; badge?: string }[] = [
  { label: "Discover", icon: "⌕", badge: "12" },
  { label: "Watchlist", icon: "★" },
  { label: "Portfolio", icon: "▦" },
  { label: "My bids", icon: "▱", badge: "3" },
  { label: "Evidence", icon: "◇" },
  { label: "Team", icon: "◎" },
  { label: "Company", icon: "⌂" },
  { label: "Settings", icon: "⚙" },
];

const stages: BidStage[] = ["Qualify", "Synopsis", "Respond", "Assemble", "Submit"];

function scoreTone(score: number) {
  if (score >= 75) return "strong";
  if (score >= 50) return "medium";
  return "weak";
}

function decisionLabel(decision: Decision) {
  if (decision === "PARTNER") return "Partner & bid";
  if (decision === "NO_GO") return "No-go";
  if (decision === "REVIEW") return "Review";
  return "Go";
}

const aiPolicyCopy: Record<AiUsePolicy["state"], { label: string; tone: string; detail: string }> = {
  prohibited: { label: "AI-generated content prohibited", tone: "fail", detail: "Drafting this response with AI risks disqualification. Switch this tender to no-AI mode before writing." },
  "disclosure-required": { label: "Disclosure required", tone: "review", detail: "You may use AI, but the pack requires you to declare it. The provenance ledger records what to declare." },
  unrestricted: { label: "No restriction stated", tone: "pass", detail: "The pack explicitly permits AI assistance." },
  "not-stated": { label: "Not stated in the pack", tone: "review", detail: "The pack says nothing about AI. Silence is not permission — check with the buyer if it matters to you." },
};

/**
 * What the pack says about producing the response with AI.
 *
 * The panel never asserts a prohibition the pack did not make, and never reads
 * silence as permission: "not stated" is its own answer. Confirming or
 * dismissing records who decided to proceed, without changing what was found.
 */
/**
 * Which lots the user is bidding.
 *
 * Nothing is shown for an undivided tender: a selector with one entry would be
 * a decision the pack never asked for. Selecting lots scopes the gates, the
 * questions and the pack blockers to what the user is actually bidding.
 */
/**
 * Why Tenderly recommends what it does.
 *
 * The band comes from rules over facts on this same screen, so it is always
 * shown — even when the prose could not be written. The facts are listed
 * beneath the rationale so every claim in it can be checked against something.
 */
/**
 * The company's own decision.
 *
 * The recommendation is advice and this is the answer to it. Going against the
 * recommendation needs a reason — not to argue, but so the choice can be
 * understood later by someone who was not in the room. Changing your mind adds
 * an entry rather than replacing one: the history is the point.
 */
function BidDecisionPanel({ tender, onRecord, busy }: {
  tender: Tender; onRecord: (decision: "BID" | "NO_BID", reason: string) => void; busy: boolean;
}) {
  const [choice, setChoice] = useState<"BID" | "NO_BID">("BID");
  const [reason, setReason] = useState("");
  const history = tender.bidDecisions ?? [];
  const latest = history[0];
  const recommendation = tender.recommendation?.decision ?? tender.decision;
  const overriding = (choice === "BID" && (recommendation === "NO_GO" || recommendation === "REVIEW"))
    || (choice === "NO_BID" && recommendation === "GO");

  return (
    <section className="panel decision-panel" data-testid="bid-decision">
      <div className="panel-heading">
        <div><h2>Your decision</h2><p>Tenderly recommends; the company decides. Going against the recommendation needs a reason.</p></div>
        {latest && <span className={`decision-pill decision-${latest.decision === "BID" ? "go" : "no-go"}`}>Decision: {latest.decision === "BID" ? "Bid" : "No bid"}</span>}
      </div>

      {latest && (
        <p className="decision-current" data-testid="current-decision">
          <strong>{latest.decision === "BID" ? "Bid" : "No bid"}</strong>
          {latest.reason && <span> — {latest.reason}</span>}
          <small> {latest.decidedBy} · {new Date(latest.createdAt).toLocaleString()}</small>
        </p>
      )}

      <div className="decision-form">
        <div className="decision-choice">
          <label><input type="radio" name="bid-decision" checked={choice === "BID"} onChange={() => setChoice("BID")} /> Bid</label>
          <label><input type="radio" name="bid-decision" checked={choice === "NO_BID"} onChange={() => setChoice("NO_BID")} /> No bid</label>
        </div>
        <input
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          placeholder={overriding ? "Required: why go against the recommendation?" : "Reason (optional)"}
        />
        <button className="quiet-btn" onClick={() => onRecord(choice, reason)} disabled={busy || (overriding && !reason.trim())}>
          {busy ? "Saving…" : latest ? "Change decision" : "Record decision"}
        </button>
      </div>
      {overriding && !reason.trim() && <p className="decision-warning">A reason is required when overriding the recommendation</p>}

      {history.length > 1 && (
        <details className="decision-history" data-testid="decision-history">
          <summary>{history.length} decisions recorded</summary>
          <ul>
            {history.map((entry) => (
              <li key={entry.id}>
                <strong>{entry.decision === "BID" ? "Bid" : "No bid"}</strong>
                {entry.reason && <span>{entry.reason}</span>}
                <small>{entry.decidedBy} · {new Date(entry.createdAt).toLocaleString()} · recommended {entry.recommendationAtTheTime}</small>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

/**
 * Ask the tender pack a question.
 *
 * Every answer cites the document and the sentence it rests on, because a bid
 * manager will have to satisfy an evaluator that the figure is right. A pack
 * that does not address the question says so — an invented requirement is worse
 * than no answer, and a plausible one is worse still because nobody checks it.
 */
/**
 * What the buyer changed since the previous analysis.
 *
 * Answers to changed questions are flagged rather than invalidated, so this
 * panel is where a bid team finds out that the deadline moved or a requirement
 * was rewritten — the thing that used to happen silently.
 */
/**
 * Clarification exchanges with the buyer.
 *
 * These live in email today, so the analysis never learns about them and two
 * people ask the same question. Recording the buyer's answer adds it to the
 * pack, because a clarification that changes a requirement is part of the
 * tender in every sense that matters.
 */
function Clarifications({ items, open, onAsk, onAnswer, busy }: {
  items: Clarification[]; open: number;
  onAsk: (question: string) => void;
  onAnswer: (clarificationId: string, response: string) => void;
  busy: boolean;
}) {
  const [question, setQuestion] = useState("");
  const [answering, setAnswering] = useState("");
  const [response, setResponse] = useState("");

  return (
    <section className="panel clarifications" data-testid="clarifications">
      <div className="panel-heading">
        <div><h2>Clarifications</h2><p>Questions put to the buyer, and what they answered.</p></div>
        {open > 0 && <span className="clar-count" data-testid="open-clarifications">{open} open clarification{open === 1 ? "" : "s"}</span>}
      </div>

      <form className="ask-form" onSubmit={(event) => { event.preventDefault(); if (question.trim()) { onAsk(question.trim()); setQuestion(""); } }}>
        <input value={question} onChange={(event) => setQuestion(event.target.value)} placeholder="Is the site visit mandatory?" disabled={busy} />
        <button className="quiet-btn" disabled={busy || !question.trim()}>Record question</button>
      </form>

      {items.length > 0 && (
        <ul className="clar-list">
          {items.map((item) => (
            <li key={item.id} data-testid={`clarification-${item.id}`}>
              <div className="clar-head">
                <strong>{item.question}</strong>
                <span className={item.status === "Answered" ? "verified" : "review-state"}>{item.status}</span>
              </div>
              <small>Asked {item.askedOn} by {item.askedBy}</small>
              {item.response
                ? <blockquote>“{item.response}”<cite>Buyer response · {item.respondedOn}</cite></blockquote>
                : answering === item.id
                  ? (
                    <form className="ask-form" onSubmit={(event) => { event.preventDefault(); if (response.trim()) { onAnswer(item.id, response.trim()); setAnswering(""); setResponse(""); } }}>
                      <input value={response} onChange={(event) => setResponse(event.target.value)} placeholder="What the buyer answered" disabled={busy} />
                      <button className="quiet-btn" disabled={busy || !response.trim()}>Save</button>
                    </form>
                  )
                  : <button className="text-action" onClick={() => { setAnswering(item.id); setResponse(""); }}>Record the buyer's answer</button>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function WhatChanged({ state, onSelectVersion }: {
  state: AnalysisChanges | null; onSelectVersion: (versionId: string) => void;
}) {
  if (!state || state.versions.length === 0) return null;
  return (
    <section className="panel what-changed" data-testid="what-changed">
      <div className="panel-heading">
        <div><h2>What changed</h2><p>{state.changedAt ? `Since the analysis of ${new Date(state.changedAt).toLocaleString()}` : "Between analyses of this tender"}</p></div>
        {state.versions.length > 1 && (
          <select onChange={(event) => onSelectVersion(event.target.value)} defaultValue="">
            <option value="">Current analysis</option>
            {state.versions.filter((version) => !version.current).map((version) => (
              <option key={version.id} value={version.id}>{new Date(version.createdAt).toLocaleString()}</option>
            ))}
          </select>
        )}
      </div>

      {state.changes.length === 0
        ? <p className="changed-none" data-testid="no-changes">{state.note ?? "No changes since the previous analysis"}</p>
        : <ul className="changed-list">{state.changes.map((change) => <li key={change}>{change}</li>)}</ul>}
    </section>
  );
}

function AskThePack({ questions, searchable, onAsk, busy }: {
  questions: PackQuestion[]; searchable: boolean; onAsk: (question: string) => void; busy: boolean;
}) {
  const [question, setQuestion] = useState("");
  return (
    <section className="panel ask-panel" data-testid="ask-the-pack">
      <div className="panel-heading">
        <div><h2>Ask the pack</h2><p>Answers come from the uploaded documents, with the passage they came from.</p></div>
      </div>

      {!searchable
        ? <p className="ask-empty" data-testid="ask-unavailable">No extracted documents to search — upload the tender pack first.</p>
        : (
          <form
            className="ask-form"
            onSubmit={(event) => { event.preventDefault(); if (question.trim().length > 2) { onAsk(question.trim()); setQuestion(""); } }}
          >
            <input
              value={question}
              onChange={(event) => setQuestion(event.target.value)}
              placeholder="What insurance is required?"
              disabled={busy}
            />
            <button className="quiet-btn" disabled={busy || question.trim().length < 3}>{busy ? "Reading…" : "Ask"}</button>
          </form>
        )}

      {questions.length > 0 && (
        <ul className="ask-history">
          {questions.map((entry) => (
            <li key={entry.id} data-testid={`ask-${entry.id}`}>
              <strong>{entry.question}</strong>
              <p>{entry.answer}</p>
              {entry.citations.map((citation, index) => (
                <blockquote key={index}>“{citation.quote}”<cite>{citation.documentName}</cite></blockquote>
              ))}
              <small>{entry.actor} · {new Date(entry.createdAt).toLocaleString()}</small>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function RecommendationPanel({ recommendation }: { recommendation?: Recommendation }) {
  if (!recommendation) return null;
  return (
    <section className="panel recommendation-panel" data-testid="recommendation">
      <div className="panel-heading">
        <div><h2>Why this recommendation</h2><p>{recommendation.reason}</p></div>
        <span className={`decision-pill decision-${decisionSlug(recommendation.decision)}`}>{decisionLabel(recommendation.decision)}</span>
      </div>
      {recommendation.rationale
        ? <p className="recommendation-rationale">{recommendation.rationale}</p>
        : <p className="recommendation-note" data-testid="rationale-unavailable">{recommendation.note ?? "Rationale unavailable"}</p>}
      <ul className="recommendation-facts">
        {recommendation.facts.map((fact) => <li key={fact}>{fact}</li>)}
      </ul>
    </section>
  );
}

/**
 * How much room is left: working days, other bids closing the same week, and
 * open mandatory items. A deadline we could not read shows no band at all.
 */
function PressurePanel({ pressure }: { pressure?: DeadlinePressure }) {
  if (!pressure) return null;
  return (
    <section className="panel pressure-panel" data-testid="pressure">
      <div className="panel-heading">
        <div><h3>Deadline pressure</h3><p>Time, competing deadlines and unresolved work on this bid.</p></div>
        {pressure.band && <span className={`pressure-band ${pressure.band.toLowerCase()}`}>{pressure.band}</span>}
      </div>
      {pressure.note
        ? <p className="pressure-missing">{pressure.note}</p>
        : (
          <>
            <p className="pressure-days"><strong>{pressure.workingDaysRemaining}</strong> working days remaining</p>
            <p className="pressure-items">{pressure.unresolvedItems} unresolved mandatory item{pressure.unresolvedItems === 1 ? "" : "s"}</p>
            {pressure.competingBids.length > 0 && (
              <div className="pressure-competing">
                <strong>{pressure.competingBids.length} other bid{pressure.competingBids.length > 1 ? "s" : ""} close in the same week</strong>
                <ul>{pressure.competingBids.map((bid) => <li key={bid.id}>{bid.title} · {bid.deadline}</li>)}</ul>
              </div>
            )}
          </>
        )}
    </section>
  );
}

/**
 * Who can fill each role the tender requires, and what is missing.
 *
 * A candidate is shown with the facts that actually satisfied the requirement,
 * so the proposal can be checked rather than trusted. A role nobody can fill is
 * a named gap, because a silent blank is how a bid goes out short a role.
 */
function RoleMatches({ matches, onAssign, busy }: {
  matches: RoleMatch[]; onAssign: (role: string, personId: string | null) => void; busy: boolean;
}) {
  if (matches.length === 0) return null;
  return (
    <section className="panel role-matches" data-testid="role-matches">
      <div className="panel-heading"><div><h2>Required people</h2><p>Matched against confirmed CV records. Tenderly proposes; you choose who is named.</p></div></div>
      {matches.map((match) => (
        <div className="role-match" key={match.role} data-testid={`role-${match.role}`}>
          <p><strong>{match.quantity > 1 ? `${match.quantity}× ` : ""}{match.role}</strong></p>

          {match.candidates.length === 0
            ? <p className="role-gap">{match.gaps[0] ?? `No team member can fill: ${match.role}`}</p>
            : (
              <ul className="role-candidates">
                {match.candidates.map((candidate) => (
                  <li key={candidate.personId} className={match.assignedPersonId === candidate.personId ? "assigned" : ""}>
                    <div>
                      <strong>{candidate.name}</strong>
                      <small>{candidate.matched.map((entry) => entry.evidence).join(" · ")}</small>
                    </div>
                    <button
                      className="text-action"
                      disabled={busy}
                      onClick={() => onAssign(match.role, match.assignedPersonId === candidate.personId ? null : candidate.personId)}
                    >{match.assignedPersonId === candidate.personId ? "Assigned ✓" : "Assign"}</button>
                  </li>
                ))}
              </ul>
            )}

          {match.gaps.length > 0 && match.candidates.length > 0 && (
            <p className="role-gap">{match.gaps.join(" · ")}</p>
          )}
          {match.unconfirmedEvidence && (
            <p className="role-unconfirmed" data-testid={`role-unconfirmed-${match.role}`}>Unconfirmed evidence — review required</p>
          )}
        </div>
      ))}
    </section>
  );
}

function LotSelector({ lots, selected, onChange, busy }: {
  lots: Lot[]; selected: string[]; onChange: (lotIds: string[]) => void; busy: boolean;
}) {
  if (lots.length === 0) return null;
  const toggle = (id: string) => onChange(selected.includes(id) ? selected.filter((item) => item !== id) : [...selected, id]);
  return (
    <section className="panel lot-panel" data-testid="lot-selector">
      <div className="panel-heading">
        <div><h2>Lots</h2><p>This tender is divided. Pick the lots you are bidding — gates, questions and blockers follow your choice.</p></div>
        {selected.length > 0 && <button className="text-action" onClick={() => onChange([])} disabled={busy}>Show all lots</button>}
      </div>
      <div className="lot-grid">
        {lots.map((lot) => (
          <label key={lot.id} className={selected.includes(lot.id) ? "lot-card selected" : "lot-card"} data-testid={`lot-${lot.id}`}>
            <input type="checkbox" checked={selected.includes(lot.id)} onChange={() => toggle(lot.id)} disabled={busy} />
            <span>
              <strong>{lot.id}{lot.title && lot.title !== lot.id ? ` — ${lot.title}` : ""}</strong>
              {lot.scope && <small>{lot.scope}</small>}
              <em className={lot.estimatedValue.startsWith("[INPUT NEEDED") ? "lot-value missing" : "lot-value"}>{lot.estimatedValue}</em>
            </span>
          </label>
        ))}
      </div>
      {selected.length === 0 && <p className="lot-note">No lot selected — everything in the pack is in scope.</p>}
    </section>
  );
}

function AiUsePolicyPanel({ policy, onAcknowledge, busy }: { policy?: AiUsePolicy; onAcknowledge: (action: "confirmed" | "dismissed") => void; busy: boolean }) {
  if (!policy) return null;
  const copy = aiPolicyCopy[policy.state];
  const flagged = policy.state !== "unrestricted";
  return (
    <section className={`panel ai-policy-panel ${copy.tone}`} data-testid="ai-policy-panel">
      <div className="panel-heading">
        <div><h2>AI use policy</h2><p>{copy.detail}</p></div>
        <span className={`ai-policy-flag ${copy.tone}`}>{copy.label}</span>
      </div>
      {policy.quote
        ? <blockquote className="ai-policy-quote">“{policy.quote}”<cite>{policy.source || "Tender pack"} · confidence {policy.confidence}</cite></blockquote>
        : <p className="ai-policy-quote empty">No clause found in the supplied documents.</p>}
      {flagged && (
        policy.acknowledgement
          ? <p className="ai-policy-ack" data-testid="ai-policy-ack">{policy.acknowledgement.action === "confirmed" ? "Confirmed" : "Dismissed"} by {policy.acknowledgement.actor} on {new Date(policy.acknowledgement.at).toLocaleString()}</p>
          : <div className="ai-policy-actions"><button className="quiet-btn" onClick={() => onAcknowledge("confirmed")} disabled={busy}>Confirm</button><button className="text-action" onClick={() => onAcknowledge("dismissed")} disabled={busy}>Dismiss</button></div>
      )}
    </section>
  );
}

function AwardCriteria({ criteria, warning }: { criteria: AwardCriterion[]; warning?: string }) {
  return (
    <section className="panel gate-panel" data-testid="award-criteria">
      <div className="panel-heading">
        <div>
          <h3>Award criteria</h3>
          <p>Where the marks are. Weightings are shown as the pack states them — never rescaled to look tidy.</p>
        </div>
      </div>
      {criteria.length === 0 ? (
        <p className="input-needed" data-testid="award-criteria-missing">[INPUT NEEDED: award criteria]</p>
      ) : (
        <>
          {warning && <p className="criteria-warning" data-testid="award-criteria-warning">! {warning}</p>}
          <div className="criteria-rows">
            {criteria.map((criterion) => (
              <div key={criterion.name} className="criteria-row">
                <span className="criteria-bar"><i style={{ width: `${Math.min(100, criterion.weight)}%` }} /></span>
                <strong>{criterion.name}</strong>
                <b>{criterion.weight}%</b>
                {criterion.rawWeight && criterion.rawWeight !== `${criterion.weight}%` && <em>{criterion.rawWeight}</em>}
                <small className={`confidence ${criterion.confidence.toLowerCase()}`}>{criterion.confidence}</small>
                <small title={criterion.quote}>{criterion.source}{criterion.quote ? ` · “${criterion.quote.slice(0, 70)}”` : ""}</small>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function Formalities({ formalities, certificates }: { formalities: Formality[]; certificates: RequiredCertificateStatus[] }) {
  return (
    <section className="panel gate-panel" data-testid="formalities">
      <div className="panel-heading">
        <div>
          <h3>Formalities and certificates</h3>
          <p>Bids fail here more often than on quality. Every rule is quoted from the pack.</p>
        </div>
      </div>

      <h4 className="sub-head">Required certificates</h4>
      {certificates.length === 0 ? (
        <p className="input-needed">[INPUT NEEDED: required certificates]</p>
      ) : (
        <div className="cert-rows" data-testid="required-certificates">
          {certificates.map((certificate) => (
            <div key={certificate.name} className={certificate.satisfied ? "cert-row ok" : "cert-row gap"}>
              <span className="cert-mark">{certificate.satisfied ? "✓" : "!"}</span>
              <div>
                <strong>{certificate.name}</strong>
                <small>
                  {certificate.issuingBody ? `${certificate.issuingBody} · ` : ""}
                  {certificate.mandatory ? "Mandatory" : "Requested"}
                  {certificate.satisfied ? ` · evidenced by ${certificate.satisfiedBy}` : " · no verified evidence"}
                </small>
                <small title={certificate.quote}>{certificate.source}{certificate.quote ? ` · “${certificate.quote.slice(0, 66)}”` : ""}</small>
              </div>
            </div>
          ))}
        </div>
      )}

      <h4 className="sub-head">Submission rules</h4>
      {formalities.length === 0 ? (
        <p className="input-needed">[INPUT NEEDED: submission formalities]</p>
      ) : (
        <ul className="formality-list" data-testid="formality-list">
          {formalities.map((formality) => (
            <li key={`${formality.appliesTo}-${formality.rule}`}>
              <strong>{formality.rule}</strong>
              <small>{formality.appliesTo}{formality.quote ? ` · “${formality.quote.slice(0, 66)}”` : ""}</small>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const euro = (n: number | null) =>
  n === null ? "—" : new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(n);

/**
 * What this buyer has actually awarded. Facts from the OGP dataset, not the
 * model — and when there is no history it says so rather than reassuring.
 */
function AwardHistory({ data }: { data?: AwardIntelligenceData }) {
  if (!data) return null;
  return (
    <section className="panel gate-panel" data-testid="award-intelligence">
      <div className="panel-heading">
        <div>
          <h3>What this buyer has awarded</h3>
          <p>Past awards by this authority under this CPV. Figures are counts from published data, not estimates.</p>
        </div>
      </div>
      {data.awards === 0 ? (
        <p className="input-needed" data-testid="no-award-history">No award history for this buyer and CPV</p>
      ) : (
        <>
          {data.relatedCpv && <p className="criteria-warning">Based on the wider CPV division, not the exact code</p>}
          {data.awards < 5 && <p className="criteria-warning" data-testid="small-sample">Based on fewer than 5 awards</p>}
          <div className="award-stats">
            <span><strong>{data.awards}</strong><small>awards</small></span>
            <span><strong>{euro(data.medianValue)}</strong><small>median value</small></span>
            <span><strong>{euro(data.minValue)} – {euro(data.maxValue)}</strong><small>range</small></span>
          </div>
          {data.topSuppliers.length > 0 && (
            <ul className="supplier-list">
              {data.topSuppliers.map((s) => <li key={s.supplier}><strong>{s.supplier}</strong><small>{s.awards} award{s.awards > 1 ? "s" : ""}</small></li>)}
            </ul>
          )}
          {(data.companyAwards ?? 0) > 0 && (
            <p className="you-won" data-testid="company-appears">Your company appears in this history — {data.companyAwards} award{(data.companyAwards ?? 0) > 1 ? "s" : ""}</p>
          )}
        </>
      )}
      <small className="licence-note">{data.licenceNote}</small>
    </section>
  );
}

function GatePill({ state }: { state: GateState }) {
  return <span className={`gate-pill gate-${state}`}>{state === "pass" ? "✓ Pass" : state === "fail" ? "× Fail" : "! Review"}</span>;
}

function Logo() {
  return (
    <div className="brand-lockup" aria-label="Tenderly">
      <span className="brand-mark"><i /><i /><i /></span>
      <span className="brand-name">tenderly</span>
    </div>
  );
}

export default function TenderlyApp() {
  const navigate = useNavigate();
  const location = useLocation();
  const route = readLocation(location.pathname);
  const section = route.section;
  const stage = route.stage;
  const setSection = (next: AppSection) => navigate(SECTION_PATHS[next]);
  const openStage = (id: string, next: BidStage) => navigate(`/bids/${id}/${stageSlug(next)}`);
  const [fallbackId, setFallbackId] = useState(API_BASE ? "" : demoTenders[0].id);
  const selectedId = route.tenderId || fallbackId;
  const setStage = (next: BidStage) => openStage(selectedId, next);
  const setSelectedId = (id: string) => { setFallbackId(id); openStage(id, "Qualify"); };
  // A critique judges what the user wrote; it never carries replacement prose.
  const [critique, setCritique] = useState<AnswerCritique | null>(null);
  const [answerHistory, setAnswerHistory] = useState<AnswerHistory | null>(null);
  const [evaluation, setEvaluation] = useState<EvaluationState | null>(null);
  const [packQuestions, setPackQuestions] = useState<PackQuestion[]>([]);
  const [packSearchable, setPackSearchable] = useState(false);
  const [analysisChanges, setAnalysisChanges] = useState<AnalysisChanges | null>(null);
  const [clarifications, setClarifications] = useState<Clarification[]>([]);
  const [openClarifications, setOpenClarifications] = useState(0);
  const [tasks, setTasks] = useState<BidTask[]>([]);
  const [runbook, setRunbook] = useState<Runbook | null>(null);
  const [runbookCompleted, setRunbookCompleted] = useState(0);
  const [runbookTotal, setRunbookTotal] = useState(0);
  const [attestationState, setAttestationState] = useState<AttestationState | null>(null);
  const [tenders, setTenders] = useState<Tender[]>(API_BASE ? [] : demoTenders);
  const [discoveries, setDiscoveries] = useState<Tender[]>(API_BASE ? [] : demoTenders);
  const [query, setQuery] = useState("");
  const [showImport, setShowImport] = useState(false);
  const [importUrl, setImportUrl] = useState("");
  const [toast, setToast] = useState("");
  const [loading, setLoading] = useState("");
  const [company, setCompany] = useState(initialCompany);
  const [notificationOpen, setNotificationOpen] = useState(false);
  const [evidenceTab, setEvidenceTab] = useState<"Evidence" | "CVs">("Evidence");
  const [evidence, setEvidence] = useState<EvidenceItem[]>(API_BASE ? [] : demoEvidence);
  const [people, setPeople] = useState<PersonItem[]>(API_BASE ? [] : demoPeople);
  const [notifications, setNotifications] = useState<NotificationItem[]>(API_BASE ? [] : demoNotifications);
  const [token, setToken] = useState<string>("");
  const [authReady, setAuthReady] = useState(!API_BASE);
  // The authoritative blocker list the API returns when it refuses a final pack.
  const [blockers, setBlockers] = useState<string[]>([]);
  const [usage, setUsage] = useState<UsageTotals | null>(null);
  const [watchlist, setWatchlist] = useState<WatchlistItem[]>([]);
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [portfolioSort, setPortfolioSort] = useState<"deadline" | "recommendation" | "blockers">("deadline");
  const [personRecords, setPersonRecords] = useState<PersonFact[]>([]);
  const [recordsPersonId, setRecordsPersonId] = useState("");
  const [skillsMatrix, setSkillsMatrix] = useState<SkillMatrix | null>(null);
  const [skillFilter, setSkillFilter] = useState("");
  const [vaultReadiness, setVaultReadiness] = useState<VaultCompleteness | null>(null);
  const [declarations, setDeclarations] = useState<DeclarationState | null>(null);
  const [savedSearches, setSavedSearches] = useState<SavedSearch[]>([]);
  const [activeSearchId, setActiveSearchId] = useState("");
  const [activeSearchName, setActiveSearchName] = useState("");
  // The star state on Discover is derived from the watchlist, so the two can
  // never disagree about what is being watched.
  const watchedIds = useMemo(() => new Set(watchlist.map((item) => item.externalId)), [watchlist]);
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);
  const [auditFilter, setAuditFilter] = useState<{ action: string; days: number }>({ action: "", days: 30 });
  const auditAction = auditFilter.action;
  const auditDays = auditFilter.days;
  const [sectors, setSectors] = useState<SectorPreset[]>([]);
  const [preferences, setPreferences] = useState<DiscoveryPreferences>({ sectors: [], keywords: [], cpvCodes: [], valueMin: null, valueMax: null });

  const isDemo = !API_BASE;
  currentToken = token;
  const routedTender = route.tenderId ? tenders.find((item) => item.id === route.tenderId) : undefined;
  const selected = routedTender ?? (route.tenderId ? undefined : tenders.find((item) => item.id === selectedId) ?? tenders[0]);
  const tenderNotFound = Boolean(route.tenderId) && tenders.length > 0 && !routedTender;
  const companyInitials = company.name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "CO";
  const profileValues = [company.name, company.registration, company.turnover, company.employees, company.services, company.cpv, company.certifications, company.insurance];
  const profileCompleteness = Math.round((profileValues.filter((value) => value.trim()).length / profileValues.length) * 100);

  useEffect(() => {
    if (!API_BASE) return;
    const saved = window.localStorage.getItem("tenderly_token") ?? "";
    setToken(saved);
    setAuthReady(true);
  }, []);

  // Read on entering Settings rather than on every render: the figures move
  // only when the account makes an AI call.
  useEffect(() => {
    if (section !== "Settings" || isDemo || !API_BASE || !token) return;
    apiClient.usage().then(({ usage: totals }) => setUsage(totals)).catch(() => setUsage(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section, token]);

  // Re-read whenever the filter changes: the server does the filtering, so the
  // view always reflects the log rather than a stale slice of it.
  useEffect(() => {
    if (section !== "Settings" || isDemo || !API_BASE || !token) return;
    setLoading("audit");
    apiClient.audit({ action: auditFilter.action || undefined, days: auditFilter.days })
      .then(({ entries }) => setAuditEntries(entries))
      .catch(() => setAuditEntries([]))
      .finally(() => setLoading(""));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section, token, auditFilter.action, auditFilter.days]);

  // The attestation covers a specific version of the content, so it is reloaded
  // whenever the stage is opened rather than cached across edits.
  useEffect(() => {
    if (stage !== "Assemble" || !selectedId) return;
    void loadAttestation(selectedId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, selectedId, tenders]);

  useEffect(() => {
    if (!API_BASE || !token || isDemo) return;
    void refreshWatchlist();
    void refreshSavedSearches();
    if (section === "Portfolio") void loadPortfolio();
    void filterSkills(skillFilter);
    // Recomputed on the server from the vault itself, so it is never stale.
    apiClient.vaultCompleteness().then(({ completeness }) => setVaultReadiness(completeness)).catch(() => setVaultReadiness(null));
    void refreshDeclarations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, section]);

  // The history follows the question being edited; there is nothing useful to
  // show about a question the user is not looking at.
  useEffect(() => {
    if (stage !== "Respond" || !selected || isDemo) return;
    const first = selected.questions[0]?.id;
    if (first) void loadAnswerHistory(first);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, selectedId]);

  // The pack Q&A belongs to the tender being looked at.
  useEffect(() => {
    if (!selectedId || isDemo) return;
    void refreshPackQuestions(selectedId);
    void refreshAnalysisChanges(selectedId);
    void refreshClarifications(selectedId);
    void refreshTasks(selectedId);
    void refreshRunbook(selectedId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 3400);
    return () => window.clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    if (!API_BASE || !token) return;
    let active = true;
    async function loadWorkspace() {
      setLoading("initial");
      try {
        const [bidsData, companyData, evidenceData, peopleData, notificationsData, sectorsData, preferencesData] = await Promise.all([
          apiClient.listTenders(), apiClient.getCompany(), apiClient.listEvidence(), apiClient.listPeople(), apiClient.listNotifications(),
          apiClient.listSectors(), apiClient.getPreferences(),
        ]);
        if (!active) return;
        setTenders(bidsData.items ?? []);
        setCompany((current) => ({ ...current, ...(companyData.company ?? {}) }));
        setEvidence(evidenceData.items ?? []);
        setPeople(peopleData.items ?? []);
        setNotifications(notificationsData.items ?? []);
        setSectors(sectorsData.items ?? []);
        setPreferences(preferencesData.preferences);
        // Remember a default bid without navigating: the URL the user arrived on wins.
        if (bidsData.items?.[0]) setFallbackId(bidsData.items[0].id);

        try {
          const discoveryData = await apiClient.discover();
          if (active) setDiscoveries(discoveryData.items ?? []);
        } catch (error) {
          if (active) setToast(error instanceof ApiError && error.isSessionExpired ? "Session expired — sign in again" : "Workspace loaded · live eTenders feed is temporarily unavailable");
        }
      } catch (error) {
        if (!active) return;
        if (error instanceof ApiError && error.isSessionExpired) {
          window.localStorage.removeItem("tenderly_token");
          setToken("");
          setToast("Session expired — sign in again");
          return;
        }
        setToast(error instanceof ApiError ? `${error.action}: ${error.message}` : "Could not load workspace");
      } finally {
        if (active) setLoading("");
      }
    }
    void loadWorkspace();
    return () => { active = false; };
  }, [token]);

  const visibleTenders = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return discoveries;
    return discoveries.filter((tender) => `${tender.title} ${tender.authority} ${tender.category}`.toLowerCase().includes(needle));
  }, [query, discoveries]);

  async function saveDiscoveryPreferences(next: DiscoveryPreferences) {
    if (isDemo) { setPreferences(next); setToast("Preferences saved in the demo workspace"); return; }
    try {
      setLoading("preferences");
      const data = await apiClient.savePreferences(next);
      setPreferences(data.preferences);
      setToast("Discovery preferences saved · refreshing opportunities");
      const refreshed = await apiClient.discover();
      setDiscoveries(refreshed.items ?? []);
    } catch (error) {
      setToast(error instanceof ApiError ? error.message : "Could not save preferences");
    } finally { setLoading(""); }
  }

  async function refreshDiscovery(searchId = activeSearchId) {
    if (isDemo) {
      setToast("Demo feed refreshed · connect the Render API for live eTenders data");
      return;
    }
    try {
      setLoading("feed");
      const data = await apiClient.discover(query, searchId);
      setDiscoveries(data.items);
      setActiveSearchName(data.activeSearch?.name ?? "");
      setToast(`${data.items.length} opportunities checked${data.activeSearch ? ` · ${data.activeSearch.name}` : ""}`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Could not refresh feed");
    } finally {
      setLoading("");
    }
  }

  async function refreshSavedSearches() {
    if (isDemo || !API_BASE || !token) return;
    try {
      const { items } = await apiClient.savedSearches();
      setSavedSearches(items);
    } catch {
      // The selector is a convenience; its absence must not break Discover.
    }
  }

  /** Selecting "All matches" (an empty id) falls back to the account profile. */
  async function selectSavedSearch(searchId: string) {
    setActiveSearchId(searchId);
    if (!searchId) setActiveSearchName("");
    await refreshDiscovery(searchId);
  }

  async function saveCurrentSearch(name: string, filter: SavedSearchFilter) {
    if (isDemo) { setToast("Saved searches are disabled in the demo"); return; }
    try {
      setLoading("feed");
      const { search } = await apiClient.createSavedSearch(name, filter);
      await refreshSavedSearches();
      setToast(`Saved "${search.name}"`);
      await selectSavedSearch(search.id);
    } catch (error) {
      // A duplicate name is the server's 409; show its wording, not a guess.
      setToast(error instanceof ApiError ? error.message : "Could not save that search");
    } finally {
      setLoading("");
    }
  }

  async function removeSavedSearch(searchId: string) {
    if (isDemo) return;
    try {
      setLoading("feed");
      await apiClient.deleteSavedSearch(searchId);
      await refreshSavedSearches();
      // Deleting the active search falls back to the profile view.
      if (activeSearchId === searchId) await selectSavedSearch("");
      setToast("Saved search deleted");
    } catch (error) {
      setToast(error instanceof ApiError ? error.message : "Could not delete that search");
    } finally {
      setLoading("");
    }
  }

  async function importTender(event: FormEvent) {
    event.preventDefault();
    if (!importUrl.trim()) return;
    if (isDemo) {
      const id = `imported-${Date.now()}`;
      const imported: Tender = {
        ...demoTenders[0],
        id,
        resourceId: "Pending",
        title: "Imported eTenders opportunity",
        authority: "Awaiting source analysis",
        match: 0,
        decision: "REVIEW",
        access: "Needs source review",
        sourceUrl: importUrl.trim(),
        summary: "Tenderly will fetch the notice and tender documents, then build the qualification view when the live API is connected.",
        gates: [{ label: "Source import", state: "review", bidder: "Pending", requirement: "Fetch notice and documents", source: importUrl.trim() }],
        questions: [],
      };
      setTenders((items) => [imported, ...items]);
      setSelectedId(id);
      setStage("Qualify");
      setSection("My bids");
      setShowImport(false);
      setImportUrl("");
      setToast("Tender imported into demo workspace");
      return;
    }
    try {
      setLoading("import");
      const data = await apiClient.importTender(importUrl.trim());
      setTenders((items) => [data.tender, ...items.filter((item) => item.id !== data.tender.id)]);
      setSelectedId(data.tender.id);
      setStage("Qualify");
      setSection("My bids");
      setShowImport(false);
      setImportUrl("");
      setToast("Notice and public tender documents imported");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Import failed");
    } finally {
      setLoading("");
    }
  }

  async function openBid(id: string) {
    const savedBid = tenders.find((item) => item.id === id);
    if (savedBid || isDemo) {
      setSelectedId(id);
      return;
    }
    const opportunity = discoveries.find((item) => item.id === id);
    if (!opportunity) return;
    try {
      setLoading(`import-${id}`);
      const data = await apiClient.importTender(opportunity.sourceUrl);
      setTenders((items) => [data.tender, ...items.filter((item) => item.id !== data.tender.id)]);
      setSelectedId(data.tender.id);
      setToast("Tender pack imported and qualification started");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Could not import tender");
    } finally {
      setLoading("");
    }
  }

  async function runAnalysis() {
    if (!selected) return;
    if (isDemo) {
      setLoading("analyse");
      window.setTimeout(() => {
        setLoading("");
        setToast("Qualification re-run · 3 sourced gates passed, 1 needs evidence");
      }, 900);
      return;
    }
    try {
      setLoading("analyse");
      const data = await apiClient.analyse(selected.id);
      setTenders((items) => items.map((item) => item.id === data.tender.id ? data.tender : item));
      setToast("Eligibility and bid fit re-analysed from source evidence");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Analysis failed");
    } finally {
      setLoading("");
    }
  }

  async function loadAttestation(tenderId: string) {
    if (isDemo) return;
    try {
      setAttestationState(await apiClient.attestationState(tenderId));
    } catch {
      // The panel is advisory; a failure here must not block the stage.
      setAttestationState(null);
    }
  }

  async function recordAttestation() {
    if (!selected) return;
    if (isDemo) { setToast("Attestation recorded"); return; }
    try {
      setLoading("attest");
      await apiClient.recordAttestation(selected.id);
      await loadAttestation(selected.id);
      setToast("Attestation recorded · the final pack is released");
    } catch (error) {
      setToast(error instanceof ApiError ? error.message : "Could not record the attestation");
    } finally {
      setLoading("");
    }
  }

  async function refreshRunbook(tenderId: string) {
    if (isDemo || !API_BASE || !token) return;
    try {
      const { runbook: steps, completed, total } = await apiClient.runbook(tenderId);
      setRunbook(steps);
      setRunbookCompleted(completed);
      setRunbookTotal(total);
    } catch {
      setRunbook(null);
    }
  }

  async function tickRunbookStep(stepId: string, done: boolean) {
    if (!selected || isDemo) return;
    try {
      setLoading("runbook");
      await apiClient.tickRunbookStep(selected.id, stepId, done);
      await refreshRunbook(selected.id);
    } catch (error) {
      setToast(error instanceof ApiError ? error.message : "Could not update the runbook");
    } finally {
      setLoading("");
    }
  }

  async function refreshTasks(tenderId: string) {
    if (isDemo || !API_BASE || !token) return;
    try {
      const { tasks: items } = await apiClient.tasks(tenderId);
      setTasks(items);
    } catch {
      setTasks([]);
    }
  }

  async function addTask(title: string, dueOn: string) {
    if (!selected || isDemo) return;
    try {
      setLoading("tasks");
      await apiClient.addTask(selected.id, title, "", dueOn);
      await refreshTasks(selected.id);
    } catch (error) {
      setToast(error instanceof ApiError ? error.message : "Could not add that task");
    } finally {
      setLoading("");
    }
  }

  async function updateTask(taskId: string, patch: { owner?: string; dueOn?: string; completed?: boolean }) {
    if (!selected || isDemo) return;
    try {
      setLoading("tasks");
      await apiClient.updateTask(selected.id, taskId, patch);
      await refreshTasks(selected.id);
    } catch (error) {
      // "This task completes when its blocker is resolved" is the server's
      // wording and the honest explanation; do not paraphrase it.
      setToast(error instanceof ApiError ? error.message : "Could not update that task");
    } finally {
      setLoading("");
    }
  }

  async function refreshClarifications(tenderId: string) {
    if (isDemo || !API_BASE || !token) return;
    try {
      const { items, open } = await apiClient.clarifications(tenderId);
      setClarifications(items);
      setOpenClarifications(open);
    } catch {
      setClarifications([]);
      setOpenClarifications(0);
    }
  }

  async function askClarification(question: string) {
    if (!selected || isDemo) return;
    try {
      setLoading("clarify");
      await apiClient.askClarification(selected.id, question, new Date().toISOString().slice(0, 10));
      await refreshClarifications(selected.id);
      setToast("Clarification recorded");
    } catch (error) {
      setToast(error instanceof ApiError ? error.message : "Could not record that clarification");
    } finally {
      setLoading("");
    }
  }

  async function answerClarification(clarificationId: string, response: string) {
    if (!selected || isDemo) return;
    try {
      setLoading("clarify");
      await apiClient.answerClarification(selected.id, clarificationId, response, new Date().toISOString().slice(0, 10));
      await refreshClarifications(selected.id);
      // The answer is now part of the pack, so what it changed is worth re-reading.
      setToast("Buyer response recorded · re-run the analysis to see what it changed");
    } catch (error) {
      setToast(error instanceof ApiError ? error.message : "Could not record that response");
    } finally {
      setLoading("");
    }
  }

  async function refreshAnalysisChanges(tenderId: string) {
    if (isDemo || !API_BASE || !token) return;
    try {
      setAnalysisChanges(await apiClient.analysisVersions(tenderId));
    } catch {
      setAnalysisChanges(null);
    }
  }

  /** An earlier analysis is shown read-only: it records what the pack said then. */
  async function viewAnalysisVersion(versionId: string) {
    if (!selected || isDemo) return;
    try {
      const state = await apiClient.analysisVersions(selected.id, versionId);
      setAnalysisChanges(state);
      if (versionId) setToast("Showing an earlier analysis · read-only");
    } catch (error) {
      setToast(error instanceof ApiError ? error.message : "Could not load that analysis");
    }
  }

  async function refreshPackQuestions(tenderId: string) {
    if (isDemo || !API_BASE || !token) return;
    try {
      const { questions, searchable } = await apiClient.packQuestions(tenderId);
      setPackQuestions(questions);
      setPackSearchable(searchable);
    } catch {
      setPackQuestions([]);
      setPackSearchable(false);
    }
  }

  async function askThePack(question: string) {
    if (!selected) return;
    if (isDemo) { setToast("Asking the pack is disabled in the demo"); return; }
    try {
      setLoading("ask");
      const { result } = await apiClient.askThePack(selected.id, question);
      setPackQuestions((items) => [result, ...items]);
    } catch (error) {
      setToast(error instanceof ApiError ? error.message : "Could not read the pack");
    } finally {
      setLoading("");
    }
  }

  async function runMockEvaluation() {
    if (!selected) return;
    if (isDemo) { setToast("Mock evaluation is disabled in the demo"); return; }
    try {
      setLoading("evaluation");
      const { evaluation: result, gaps } = await apiClient.runMockEvaluation(selected.id);
      setEvaluation({ result, gaps });
      setToast(`Estimated ${result.total}/100 against the published criteria`);
    } catch (error) {
      // "No award criteria extracted" is the server's wording and the honest
      // answer; showing a score without weights would be worse than none.
      setToast(error instanceof ApiError ? error.message : "Could not run the mock evaluation");
    } finally {
      setLoading("");
    }
  }

  async function loadAnswerHistory(questionId: string) {
    if (!selected || isDemo) return;
    try {
      setLoading("versions");
      const { versions } = await apiClient.answerVersions(selected.id, questionId);
      setAnswerHistory({ questionId, versions, selected: [] });
    } catch {
      // History is a convenience; its absence must not block editing.
      setAnswerHistory(null);
    } finally {
      setLoading("");
    }
  }

  /** Ticking a third version replaces the older of the two already ticked. */
  function selectVersion(versionId: string) {
    setAnswerHistory((current) => {
      if (!current) return current;
      const already = current.selected.includes(versionId);
      const next = already
        ? current.selected.filter((id) => id !== versionId)
        : [...current.selected, versionId].slice(-2);
      return { ...current, selected: next, diff: undefined };
    });
  }

  async function compareVersions() {
    if (!selected || !answerHistory || answerHistory.selected.length !== 2) return;
    // Compare oldest to newest, so "added" reads as what the later one gained.
    const ordered = answerHistory.versions
      .filter((version) => answerHistory.selected.includes(version.id))
      .map((version) => version.id);
    try {
      setLoading("versions");
      const { diff } = await apiClient.answerVersions(selected.id, answerHistory.questionId, { from: ordered[0], to: ordered[1] });
      setAnswerHistory((current) => (current ? { ...current, diff } : current));
    } catch (error) {
      setToast(error instanceof ApiError ? error.message : "Could not compare those versions");
    } finally {
      setLoading("");
    }
  }

  async function restoreVersion(versionId: string) {
    if (!selected || !answerHistory) return;
    try {
      setLoading("versions");
      const { versions } = await apiClient.restoreAnswerVersion(selected.id, answerHistory.questionId, versionId);
      setAnswerHistory({ questionId: answerHistory.questionId, versions, selected: [] });
      const { tender } = await apiClient.tender(selected.id);
      setTenders((items) => items.map((item) => (item.id === tender.id ? tender : item)));
      setToast("Version restored · a new version was written, nothing was rewound");
    } catch (error) {
      setToast(error instanceof ApiError ? error.message : "Could not restore that version");
    } finally {
      setLoading("");
    }
  }

  async function critiqueAnswer(questionId: string) {
    if (!selected) return;
    try {
      setLoading(`critique-${questionId}`);
      const result = await apiClient.critiqueAnswer(selected.id, questionId);
      setCritique({ questionId, ...result });
    } catch (error) {
      setToast(error instanceof ApiError ? error.message : "Could not critique this answer");
    } finally {
      setLoading("");
    }
  }

  async function refreshDeclarations() {
    if (isDemo || !API_BASE || !token) return;
    try {
      setDeclarations(await apiClient.declarations());
    } catch {
      setDeclarations(null);
    }
  }

  async function saveDeclarations(answers: DeclarationAnswer[]) {
    if (isDemo) { setToast("Declarations are disabled in the demo"); return; }
    try {
      setLoading("declarations");
      await apiClient.saveDeclarations(answers);
      await refreshDeclarations();
    } catch (error) {
      setToast(error instanceof ApiError ? error.message : "Could not save the declarations");
    } finally {
      setLoading("");
    }
  }

  async function affirmDeclarations() {
    if (isDemo) return;
    try {
      setLoading("declarations");
      const { affirmation } = await apiClient.affirmDeclarations();
      await refreshDeclarations();
      setToast(`Declarations affirmed by ${affirmation.affirmedBy}`);
    } catch (error) {
      // The server's wording is the one the AC names; do not paraphrase it.
      setToast(error instanceof ApiError ? error.message : "Could not affirm the declarations");
    } finally {
      setLoading("");
    }
  }

  /** A citation points at a vault document, so opening it downloads that file. */
  async function openCitation(citation: { id: string; name: string; hasFile: boolean }) {
    if (isDemo || !citation.hasFile) return;
    try {
      await apiClient.downloadEvidenceFile(citation.id, citation.name);
    } catch (error) {
      setToast(error instanceof ApiError ? error.message : "Could not open that document");
    }
  }

  async function downloadEvidence(item: EvidenceItem) {
    if (isDemo || !item.filename) return;
    try {
      await apiClient.downloadEvidenceFile(item.id, item.filename);
    } catch (error) {
      setToast(error instanceof ApiError ? error.message : "Could not download that file");
    }
  }

  async function loadPortfolio(sort: "deadline" | "recommendation" | "blockers" = portfolioSort) {
    setPortfolioSort(sort);
    if (isDemo || !API_BASE || !token) return;
    try {
      setLoading("portfolio");
      const { portfolio: board } = await apiClient.portfolio(sort);
      setPortfolio(board);
    } catch {
      setPortfolio(null);
    } finally {
      setLoading("");
    }
  }

  async function refreshWatchlist() {
    if (isDemo || !API_BASE || !token) return;
    try {
      const { items } = await apiClient.watchlist();
      setWatchlist(items);
    } catch {
      // The watchlist is a convenience; a failure here must not break Discover.
    }
  }

  async function toggleWatch(tender: Tender) {
    if (isDemo) { setToast("Watchlist is disabled in the demo"); return; }
    const externalId = tender.resourceId;
    try {
      setLoading("watchlist");
      if (watchedIds.has(externalId)) {
        await apiClient.unwatch(externalId);
        setToast("Removed from watchlist");
      } else {
        await apiClient.watch({
          externalId, title: tender.title, authority: tender.authority,
          deadline: tender.deadline, sourceUrl: tender.sourceUrl,
        });
        setToast("Added to watchlist");
      }
      await refreshWatchlist();
    } catch (error) {
      setToast(error instanceof ApiError ? error.message : "Could not update the watchlist");
    } finally {
      setLoading("");
    }
  }

  async function unwatchNotice(externalId: string) {
    if (isDemo) return;
    try {
      setLoading("watchlist");
      await apiClient.unwatch(externalId);
      await refreshWatchlist();
      setToast("Removed from watchlist");
    } catch (error) {
      setToast(error instanceof ApiError ? error.message : "Could not update the watchlist");
    } finally {
      setLoading("");
    }
  }

  /** Promoting a watched notice runs the ordinary import and opens the bid. */
  async function importWatched(item: WatchlistItem) {
    if (isDemo || !item.sourceUrl) return;
    try {
      setLoading("watchlist");
      const { tender } = await apiClient.importTender(item.sourceUrl);
      setTenders((items) => [tender, ...items.filter((entry) => entry.id !== tender.id)]);
      await refreshWatchlist();
      setSelectedId(tender.id);
      setSection("My bids");
      setToast(`Imported ${tender.title}`);
    } catch (error) {
      setToast(error instanceof ApiError ? error.message : "Could not import that notice");
    } finally {
      setLoading("");
    }
  }

  async function recordBidDecision(decision: "BID" | "NO_BID", reason: string) {
    if (!selected) return;
    if (isDemo) { setToast(`Decision recorded: ${decision === "BID" ? "Bid" : "No bid"}`); return; }
    try {
      setLoading("decision");
      await apiClient.recordBidDecision(selected.id, decision, reason);
      const { tender } = await apiClient.tender(selected.id);
      setTenders((items) => items.map((item) => (item.id === tender.id ? tender : item)));
      setToast(`Decision recorded: ${decision === "BID" ? "Bid" : "No bid"}`);
    } catch (error) {
      setToast(error instanceof ApiError ? error.message : "Could not record the decision");
    } finally {
      setLoading("");
    }
  }

  async function assignRole(role: string, personId: string | null) {
    if (!selected) return;
    if (isDemo) { setToast("Assignment is disabled in the demo"); return; }
    try {
      setLoading("assign-role");
      const { tender } = await apiClient.assignRole(selected.id, role, personId);
      setTenders((items) => items.map((item) => (item.id === tender.id ? tender : item)));
      setToast(personId ? `Assigned to ${role}` : `Cleared the assignment for ${role}`);
    } catch (error) {
      setToast(error instanceof ApiError ? error.message : "Could not change that assignment");
    } finally {
      setLoading("");
    }
  }

  async function setSelectedLots(lotIds: string[]) {
    if (!selected) return;
    if (isDemo) { setToast(lotIds.length ? `Bidding ${lotIds.join(", ")}` : "All lots in scope"); return; }
    try {
      setLoading("lots");
      const { tender } = await apiClient.setSelectedLots(selected.id, lotIds);
      setTenders((items) => items.map((item) => (item.id === tender.id ? tender : item)));
      setToast(lotIds.length ? `Bidding ${lotIds.join(", ")} · gates and questions scoped` : "All lots in scope");
    } catch (error) {
      setToast(error instanceof ApiError ? error.message : "Could not change the lot selection");
    } finally {
      setLoading("");
    }
  }

  async function setNoAiMode(enabled: boolean) {
    if (!selected) return;
    if (isDemo) {
      setToast(enabled ? "No-AI mode enabled · generation disabled for this tender" : "No-AI mode disabled");
      return;
    }
    try {
      setLoading("no-ai-mode");
      const { aiWrittenAnswers } = await apiClient.setNoAiMode(selected.id, enabled);
      setTenders((items) => items.map((item) => item.id !== selected.id ? item : { ...item, noAiMode: enabled }));
      // Enabling the mode does not rewrite history: sections a model wrote keep
      // their provenance, and the user is told which they are.
      setToast(enabled
        ? aiWrittenAnswers.length
          ? `No-AI mode enabled · ${aiWrittenAnswers.length} existing section${aiWrittenAnswers.length > 1 ? "s were" : " was"} written with AI: ${aiWrittenAnswers.join(", ")}`
          : "No-AI mode enabled · generation disabled for this tender"
        : "No-AI mode disabled");
    } catch (error) {
      setToast(error instanceof ApiError ? error.message : "Could not change no-AI mode");
    } finally {
      setLoading("");
    }
  }

  async function acknowledgeAiPolicy(action: "confirmed" | "dismissed") {
    if (!selected) return;
    if (isDemo) {
      setToast(action === "confirmed" ? "AI use policy confirmed" : "AI use policy dismissed");
      return;
    }
    try {
      setLoading("ai-policy");
      const { acknowledgement } = await apiClient.acknowledgeAiPolicy(selected.id, action);
      setTenders((items) => items.map((item) => item.id !== selected.id || !item.aiUsePolicy
        ? item
        : { ...item, aiUsePolicy: { ...item.aiUsePolicy, acknowledgement } }));
      setToast(`AI use policy ${action} · recorded against your account`);
    } catch (error) {
      setToast(error instanceof ApiError ? error.message : "Could not record the acknowledgement");
    } finally {
      setLoading("");
    }
  }

  async function draftAnswer(questionId: string) {
    if (!selected) return;
    if (isDemo) {
      setTenders((items) => items.map((item) => item.id !== selected.id ? item : {
        ...item,
        questions: item.questions.map((q) => q.id !== questionId ? q : {
          ...q,
          status: "draft" as const,
          answer: "We will deliver the programme through a controlled four-stage cycle: baseline, instructor-led delivery, exam-focused practice and measured improvement. Each cohort begins with a diagnostic assessment; the results tailor emphasis across the PMP domains. Weekly progress, attendance, mock-exam performance and learner feedback are tracked against agreed thresholds. Any learner below threshold receives a targeted recovery plan. Governance is led by a named programme manager with a concise RAID and quality log, giving the contracting authority clear evidence of progress and intervention throughout delivery.",
        }),
      }));
      setToast("Evidence-grounded draft created · review claims before marking ready");
      return;
    }
    try {
      setLoading(questionId);
      const data = await apiClient.draftAnswer(selected.id, questionId);
      setTenders((items) => items.map((item) => item.id !== selected.id ? item : {
        ...item,
        questions: item.questions.map((q) => q.id !== questionId ? q : { ...q, answer: data.answer, status: data.missingInputs.length ? "needs-input" : "draft" }),
      }));
      setToast(data.missingInputs.length ? `Draft needs ${data.missingInputs.length} input${data.missingInputs.length > 1 ? "s" : ""}` : "Evidence-grounded draft created");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Draft failed");
    } finally {
      setLoading("");
    }
  }

  async function markAnswerReady(questionId: string) {
    if (!selected) return;
    const question = selected.questions.find((item) => item.id === questionId);
    if (!question?.answer.trim()) { setToast("Add or draft a response before marking it ready"); return; }
    if (isDemo) {
      setTenders((items) => items.map((item) => item.id !== selected.id ? item : { ...item, questions: item.questions.map((q) => q.id === questionId ? { ...q, status: "ready" } : q) }));
      setToast("Response marked ready · final pack will still run all submission gates");
      return;
    }
    try {
      setLoading(`ready-${questionId}`);
      await apiClient.saveAnswer(selected.id, questionId, question.answer, "ready");
      setTenders((items) => items.map((item) => item.id !== selected.id ? item : { ...item, questions: item.questions.map((q) => q.id === questionId ? { ...q, status: "ready" } : q) }));
      setToast("Response marked ready");
    } catch (error) { setToast(error instanceof Error ? error.message : "Could not save response"); } finally { setLoading(""); }
  }

  async function uploadTenderFile(file: File, role: "source" | "submission") {
    if (!selected) return;
    if (isDemo) { setToast(`${file.name} selected · live upload is available when the Render API is connected`); return; }
    try {
      setLoading("upload");
      await apiClient.uploadTenderDocument(selected.id, file, role);
      setToast(role === "source" ? `${file.name} added to the tender source · re-run qualification` : `${file.name} added to the submission pack`);
    } catch (error) { setToast(error instanceof Error ? error.message : "Upload failed"); } finally { setLoading(""); }
  }

  async function uploadEvidenceFile(file: File) {
    if (isDemo) { setEvidence((items) => [{ id: `demo-${Date.now()}`, kind: "Document", name: file.name, content: "Demo upload", tags: [], verified: false }, ...items]); setToast(`${file.name} added · verify it before Tenderly uses its claims`); return; }
    try {
      setLoading("evidence-upload");
      const data = await apiClient.uploadEvidenceFile(file);
      setEvidence((items) => [data.item, ...items]);
      setToast(`${file.name} extracted · review and verify it before AI drafting`);
    } catch (error) { setToast(error instanceof Error ? error.message : "Evidence upload failed"); } finally { setLoading(""); }
  }

  const [busyPersonId, setBusyPersonId] = useState("");

  async function renamePerson(personId: string, title: string) {
    if (isDemo) { setToast("Editing people is disabled in the demo"); return; }
    try {
      setBusyPersonId(personId);
      const { person } = await apiClient.updatePerson(personId, { title });
      setPeople((items) => items.map((item) => (item.id === person.id ? person : item)));
      setToast(`${person.name} updated`);
    } catch (error) {
      setToast(error instanceof ApiError ? error.message : "Could not update that person");
    } finally {
      setBusyPersonId("");
    }
  }

  async function archivePerson(target: PersonItem, archived: boolean) {
    if (isDemo) { setToast("Archiving is disabled in the demo"); return; }
    try {
      setBusyPersonId(target.id);
      const { person, affectedTenders } = await apiClient.setPersonArchived(target.id, archived);
      setPeople((items) => items.map((item) => (item.id === person.id ? person : item)));
      // Naming the affected bids is the point: archiving quietly would leave a
      // live tender proposing someone the company can no longer field.
      setToast(archived
        ? affectedTenders.length
          ? `${person.name} archived · ${affectedTenders.length} live bid${affectedTenders.length > 1 ? "s" : ""} proposed them: ${affectedTenders.map((entry) => entry.title).join(", ")}`
          : `${person.name} archived`
        : `${person.name} reinstated`);
    } catch (error) {
      setToast(error instanceof ApiError ? error.message : "Could not change that person");
    } finally {
      setBusyPersonId("");
    }
  }

  async function filterSkills(skill: string) {
    setSkillFilter(skill);
    if (isDemo || !API_BASE || !token) return;
    try {
      const { matrix } = await apiClient.skillsMatrix(skill);
      setSkillsMatrix(matrix);
    } catch {
      setSkillsMatrix(null);
    }
  }

  async function exportSkillsMatrix() {
    if (isDemo) { setToast("Export is disabled in the demo"); return; }
    try {
      await apiClient.downloadSkillsMatrix(skillFilter);
    } catch (error) {
      setToast(error instanceof ApiError ? error.message : "Could not export the matrix");
    }
  }

  async function loadPersonRecords(personId: string) {
    setRecordsPersonId(personId);
    if (!personId || isDemo) { setPersonRecords([]); return; }
    try {
      setLoading("cv-records");
      const { records } = await apiClient.personRecords(personId);
      setPersonRecords(records);
    } catch (error) {
      setPersonRecords([]);
      setToast(error instanceof ApiError ? error.message : "Could not load the CV records");
    } finally {
      setLoading("");
    }
  }

  async function confirmPersonRecords() {
    if (!recordsPersonId || isDemo) return;
    try {
      setLoading("cv-records");
      const { records } = await apiClient.confirmPersonRecords(recordsPersonId);
      setPersonRecords(records);
      setToast(`${records.length} record${records.length === 1 ? "" : "s"} confirmed`);
    } catch (error) {
      setToast(error instanceof ApiError ? error.message : "Could not confirm those records");
    } finally {
      setLoading("");
    }
  }

  /** Correcting a record confirms it: the user has just read and fixed it. */
  async function correctPersonRecord(factId: string, value: string) {
    if (isDemo) return;
    try {
      setLoading("cv-records");
      const { record } = await apiClient.updatePersonRecord(factId, { value, confirmed: true });
      setPersonRecords((items) => items.map((item) => (item.id === record.id ? record : item)));
    } catch (error) {
      setToast(error instanceof ApiError ? error.message : "Could not update that record");
    } finally {
      setLoading("");
    }
  }

  async function uploadCvFile(file: File) {
    if (isDemo) { setPeople((items) => [{ id: `demo-${Date.now()}`, name: file.name.replace(/\.[^.]+$/, ""), title: "CV uploaded", cvText: "Demo CV", skills: [] }, ...items]); setToast(`${file.name} added to the demo CV library`); return; }
    try {
      setLoading("cv-upload");
      const data = await apiClient.uploadCv(file);
      setPeople((items) => [data.person, ...items]);
      setToast(`${file.name} extracted · re-run a tender check to match this CV to required roles`);
    } catch (error) { setToast(error instanceof Error ? error.message : "CV upload failed"); } finally { setLoading(""); }
  }

  async function setEvidenceVerification(itemId: string, verified: boolean) {
    if (isDemo) { setEvidence((items) => items.map((item) => item.id === itemId ? { ...item, verified } : item)); setToast(verified ? "Evidence approved for bid drafting" : "Evidence returned to review"); return; }
    try {
      setLoading(`evidence-${itemId}`);
      const data = await apiClient.setEvidenceVerified(itemId, verified);
      setEvidence((items) => items.map((item) => item.id === itemId ? data.item : item));
      setToast(verified ? "Evidence approved for bid drafting" : "Evidence returned to review");
    } catch (error) { setToast(error instanceof Error ? error.message : "Could not update evidence"); } finally { setLoading(""); }
  }

  async function markChecklistReady(itemId: string) {
    if (!selected) return;
    if (isDemo) { setToast("Checklist confirmation recorded in the live workflow when the API is connected"); return; }
    try {
      setLoading(`check-${itemId}`);
      await apiClient.setChecklistStatus(selected.id, itemId, "READY");
      setTenders((items) => items.map((item) => item.id !== selected.id ? item : { ...item, submissionChecklist: item.submissionChecklist?.map((entry) => entry.id === itemId ? { ...entry, status: "READY" as const } : entry) }));
      setToast("Submission item confirmed ready");
    } catch (error) { setToast(error instanceof Error ? error.message : "Could not update checklist"); } finally { setLoading(""); }
  }

  async function downloadAsset(kind: "deck" | "pack", draft = false) {
    if (!selected) return;
    if (isDemo) {
      setToast(kind === "deck" ? "Deck generation is wired to the live API · the 3-slide preview is shown below" : draft ? "Draft pack generation is wired to the live API" : "Final pack stays locked until every mandatory gate is green");
      return;
    }
    try {
      setLoading(kind);
      const { blob, filename } = await apiClient.download(selected.id, kind, draft);
      setBlockers([]);
      const href = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = href;
      anchor.download = filename;
      anchor.click();
      URL.revokeObjectURL(href);
      setToast(kind === "deck" ? "Synopsis deck downloaded" : "Submission pack downloaded");
    } catch (error) {
      if (error instanceof ApiError && error.blockers.length) {
        setBlockers(error.blockers);
        const extra = error.blockers.length > 1 ? ` (+${error.blockers.length - 1} more)` : "";
        setToast(`${error.message} · ${error.blockers[0]}${extra}`);
      } else {
        setToast(error instanceof Error ? error.message : "Generation failed");
      }
    } finally {
      setLoading("");
    }
  }

  if (!authReady) return <div className="boot-screen"><Logo /><span className="spinner" /></div>;
  if (API_BASE && !token) return <AuthScreen onToken={(nextToken) => { window.localStorage.setItem("tenderly_token", nextToken); setToken(nextToken); }} />;

  return (
    <div className="tenderly-app">
      <aside className="side-rail">
        <Logo />
        <div className="workspace-switcher">
          <span className="workspace-avatar">{companyInitials}</span>
          <span><strong>{company.name || "Your company"}</strong><small>Bid workspace</small></span>
          <span className="chev">⌄</span>
        </div>
        <nav className="primary-nav" aria-label="Primary">
          <p className="nav-label">Workspace</p>
          {navItems.slice(0, 5).map((item) => (
            <button key={item.label} className={section === item.label ? "active" : ""} onClick={() => setSection(item.label)}>
              <span className="nav-icon">{item.icon}</span><span>{item.label}</span>{item.badge && <em>{item.label === "Discover" ? discoveries.length : item.label === "My bids" ? tenders.length : item.badge}</em>}
            </button>
          ))}
        </nav>
        <div className="rail-spacer" />
        <div className="rail-callout">
          <span className="spark">✦</span>
          <strong>Bid profile</strong>
          <small>{profileCompleteness}% complete</small>
          <div className="mini-progress"><i style={{ width: `${profileCompleteness}%` }} /></div>
          <button onClick={() => setSection("Company")}>Complete profile →</button>
        </div>
        <nav className="secondary-nav">
          <button className={section === "Settings" ? "active" : ""} onClick={() => setSection("Settings")}><span>⚙</span> Settings</button>
          <button onClick={() => { if (API_BASE) { window.localStorage.removeItem("tenderly_token"); setToken(""); } else { setToast("Connect the live API to create your own workspace"); } }}><span>{API_BASE ? "↪" : "?"}</span> {API_BASE ? "Sign out" : "Help & guide"}</button>
        </nav>
        <div className="user-card">
          <span className="user-avatar">{isDemo ? "GG" : companyInitials}</span>
          <span><strong>Bid owner</strong><small>{isDemo ? "Demo workspace" : "Signed in"}</small></span>
          <span className="online-dot" />
        </div>
      </aside>

      <main className="main-shell">
        <header className="topbar">
          <button className="mobile-menu" onClick={() => setSection("Discover")} aria-label="Open navigation">☰</button>
          <div className="crumbs"><span>Tenderly</span><b>/</b><strong>{section === "My bids" && selected ? selected.title : section}</strong></div>
          <div className="top-actions">
            {isDemo && <span className="demo-chip"><i /> Demo data</span>}
            <button className="icon-button" aria-label="Notifications" onClick={() => setNotificationOpen((value) => !value)}>♢<span className="notif-dot" /></button>
            <button className="primary-compact" onClick={() => setShowImport(true)}>＋ Add tender</button>
          </div>
          {notificationOpen && (
            <div className="notification-popover">
              <div className="popover-head"><strong>Matched opportunities</strong><span>{notifications.length} saved</span></div>
              {notifications.slice(0, 4).map((item) => <article key={item.id}><i className={`n-dot ${scoreTone(item.matchScore)}`} /><div><strong>{item.matchScore}% preview match</strong><p>{item.title}</p></div><a href={item.sourceUrl} target="_blank" rel="noreferrer">Open ↗</a></article>)}
              {!notifications.length && <div className="notification-empty"><strong>No saved matches yet</strong><p>The discovery job stores new matches here once your bidder profile is filled in.</p></div>}
            </div>
          )}
        </header>

        <div className="content-wrap">
          {section === "Discover" && (
            <Discover
              tenders={visibleTenders}
              query={query}
              setQuery={setQuery}
              refreshDiscovery={refreshDiscovery}
              loading={loading === "feed"}
              openBid={openBid}
              setShowImport={setShowImport}
              hasPreferences={preferences.sectors.length > 0 || preferences.keywords.length > 0}
              onOpenSettings={() => setSection("Settings")}
              watching={watchedIds}
              onToggleWatch={toggleWatch}
              savedSearches={savedSearches}
              activeSearchId={activeSearchId}
              activeSearchName={activeSearchName}
              onSelectSearch={selectSavedSearch}
              onSaveSearch={saveCurrentSearch}
              onDeleteSearch={removeSavedSearch}
            />
          )}
          {section === "Watchlist" && (
            <WatchlistView
              items={watchlist}
              loading={loading === "watchlist"}
              onUnwatch={unwatchNotice}
              onImport={importWatched}
              onDiscover={() => setSection("Discover")}
            />
          )}
          {section === "Portfolio" && (
            <PortfolioView
              portfolio={portfolio}
              sort={portfolioSort}
              onSort={loadPortfolio}
              onOpen={openBid}
              onDiscover={() => setSection("Discover")}
              loading={loading === "portfolio"}
            />
          )}
          {section === "My bids" && selected && (
            <>
            <BidList tenders={tenders} selectedId={selected.id} onSelect={setSelectedId} />
            <BidWorkspace
              acknowledgeAiPolicy={acknowledgeAiPolicy}
              assignRole={assignRole}
              packQuestions={packQuestions}
              packSearchable={packSearchable}
              askThePack={askThePack}
              analysisChanges={analysisChanges}
              viewAnalysisVersion={viewAnalysisVersion}
              clarifications={clarifications}
              openClarifications={openClarifications}
              askClarification={askClarification}
              answerClarification={answerClarification}
              onOpenCitation={openCitation}
              setSelectedLots={setSelectedLots}
              recordBidDecision={recordBidDecision}
              setNoAiMode={setNoAiMode}
              critiqueAnswer={critiqueAnswer}
              critique={critique}
              evaluation={evaluation}
              runMockEvaluation={runMockEvaluation}
              answerHistory={answerHistory}
              selectVersion={selectVersion}
              compareVersions={compareVersions}
              restoreVersion={restoreVersion}
              attestation={attestationState}
              onAttest={recordAttestation}
              runbook={runbook}
              runbookCompleted={runbookCompleted}
              runbookTotal={runbookTotal}
              tickRunbookStep={tickRunbookStep}
              tasks={tasks}
              addTask={addTask}
              updateTask={updateTask}
              tender={selected}
              stage={stage}
              setStage={setStage}
              runAnalysis={runAnalysis}
              loading={loading}
              draftAnswer={draftAnswer}
              markAnswerReady={markAnswerReady}
              uploadTenderFile={uploadTenderFile}
              downloadAsset={downloadAsset}
              markChecklistReady={markChecklistReady}
              blockers={blockers}
              updateQuestion={(questionId, answer) => setTenders((items) => items.map((item) => item.id !== selected.id ? item : { ...item, questions: item.questions.map((q) => q.id === questionId ? { ...q, answer, status: "draft" } : q) }))}
            />
            </>
          )}
          {section === "My bids" && tenderNotFound && (
            <div className="no-questions panel" data-testid="bid-not-found">
              <span>▱</span>
              <h2>That bid could not be found</h2>
              <p>The link may be out of date, or the bid may belong to another workspace.</p>
              <button className="continue-btn" onClick={() => setSection("My bids")}>Back to My bids</button>
            </div>
          )}
          {section === "My bids" && !selected && !tenderNotFound && <div className="no-questions panel"><span>▱</span><h2>No active bids yet</h2><p>Open a recommended opportunity or paste an eTenders link. Tenderly will import it into this workspace before qualification begins.</p><button className="continue-btn" onClick={() => setSection("Discover")}>Discover opportunities →</button></div>}
          {section === "Company" && <CompanyView vaultReadiness={vaultReadiness} onOpenEvidence={() => setSection("Evidence")} declarations={declarations} onSaveDeclarations={saveDeclarations} onAffirmDeclarations={affirmDeclarations} busyDeclarations={loading === "declarations"} company={company} setCompany={setCompany} onSave={async () => {
            if (isDemo) { setToast("Company profile saved for this demo session"); return; }
            try { await apiClient.saveCompany(company); setToast("Company profile saved"); } catch (error) { setToast(error instanceof Error ? error.message : "Could not save profile"); }
          }} />}
          {section === "Evidence" && <EvidenceView tab={evidenceTab} setTab={setEvidenceTab} evidence={evidence} people={people} onUploadEvidence={uploadEvidenceFile} onUploadCv={uploadCvFile} onVerify={setEvidenceVerification} onDownload={downloadEvidence} loading={loading} />}
          {section === "Team" && <TeamView people={people} onUploadCv={uploadCvFile} onRename={renamePerson} onArchive={archivePerson} busyPersonId={busyPersonId} loading={loading === "cv-upload"} records={personRecords} selectedPersonId={recordsPersonId} onSelectPerson={loadPersonRecords} onConfirmAll={confirmPersonRecords} onCorrect={correctPersonRecord} busyRecords={loading === "cv-records"} matrix={skillsMatrix} skillFilter={skillFilter} onSkillFilter={filterSkills} onExportMatrix={exportSkillsMatrix} />}
          {section === "Settings" && <SettingsView isDemo={isDemo} sectors={sectors} preferences={preferences} onSave={saveDiscoveryPreferences} loading={loading} usage={usage} audit={{ entries: auditEntries, action: auditAction, days: auditDays, onFilter: setAuditFilter, loading: loading === "audit" }} />}
        </div>
      </main>

      {showImport && <ImportModal value={importUrl} setValue={setImportUrl} onClose={() => setShowImport(false)} onSubmit={importTender} loading={loading === "import"} />}
      {toast && <div className="toast"><span>✓</span>{toast}</div>}
    </div>
  );
}

/**
 * Every saved bid, so a user can get back to one. Before TLY-118 the workspace
 * showed tenders[0] and nothing else could be reached: openBid was wired only
 * from Discover's public-opportunity cards.
 */
function BidList({ tenders, selectedId, onSelect }: { tenders: Tender[]; selectedId: string; onSelect: (id: string) => void }) {
  if (tenders.length < 2) return null;
  return (
    <nav className="bid-list" aria-label="Your bids" data-testid="bid-list">
      <p className="eyebrow">YOUR BIDS · {tenders.length}</p>
      <div className="bid-list-items">
        {tenders.map((tender) => (
          <button
            key={tender.id}
            className={tender.id === selectedId ? "bid-list-item active" : "bid-list-item"}
            aria-current={tender.id === selectedId ? "true" : undefined}
            onClick={() => onSelect(tender.id)}
          >
            <strong>{tender.title}</strong>
            <small>{tender.authority} · closes {tender.deadline}</small>
            <span className={`decision-pill decision-${decisionSlug(tender.decision)}`}>{decisionLabel(tender.decision)}</span>
          </button>
        ))}
      </div>
    </nav>
  );
}

/**
 * Why a notice scored what it scored.
 *
 * The total is the sum of what is listed, so a user can check the number rather
 * than take it on trust — and can see which profile fact to change. A notice
 * that matched nothing shows the reason rather than a bare zero.
 */
function ScoreBreakdownDetail({ breakdown }: { breakdown?: ScoreBreakdown }) {
  if (!breakdown) return null;
  return (
    <details className="score-breakdown" data-testid="score-breakdown" onClick={(event) => event.stopPropagation()}>
      <summary>Why {breakdown.total}?</summary>
      {breakdown.contributions.length === 0
        ? <p className="score-note">{breakdown.note ?? "No profile facts matched"}</p>
        : (
          <ul>
            {breakdown.contributions.map((item) => (
              <li key={`${item.kind}-${item.matched}`}><span>{item.label}</span><b>+{item.points}</b></li>
            ))}
            <li className="score-total"><span>Total</span><b>{breakdown.total}</b></li>
          </ul>
        )}
    </details>
  );
}

/**
 * Notices being watched without a bid record.
 *
 * Live items first, soonest deadline first. A passed deadline reads "Deadline
 * passed" under a Closed heading rather than a negative number — the item stays
 * because the user put it there, but it stops pretending to be an opportunity.
 */
/**
 * The saved-search selector above the Discover list.
 *
 * "All matches" is the account's preference profile, and it stays the default:
 * saved searches are extra slices, not a replacement for the profile.
 */
function SavedSearchBar({ searches, activeId, activeName, onSelect, onSave, onDelete, busy }: {
  searches: SavedSearch[]; activeId: string; activeName: string;
  onSelect: (id: string) => void; onSave: (name: string, filter: SavedSearchFilter) => void;
  onDelete: (id: string) => void; busy: boolean;
}) {
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [buyer, setBuyer] = useState("");
  const [cpv, setCpv] = useState("");
  const [keywords, setKeywords] = useState("");

  const list = (value: string) => value.split(",").map((item) => item.trim()).filter(Boolean);

  return (
    <section className="panel saved-search-bar" data-testid="saved-searches">
      <div className="saved-search-row">
        <label>
          <span>View</span>
          <select value={activeId} onChange={(event) => onSelect(event.target.value)} disabled={busy}>
            <option value="">All matches</option>
            {searches.map((search) => <option key={search.id} value={search.id}>{search.name}</option>)}
          </select>
        </label>
        {activeId && activeName && <strong className="active-search" data-testid="active-search">{activeName}</strong>}
        {activeId && <button className="text-action" onClick={() => onDelete(activeId)} disabled={busy}>Delete</button>}
        <button className="text-action" onClick={() => setShowForm((open) => !open)}>{showForm ? "Cancel" : "＋ Save search"}</button>
      </div>

      {showForm && (
        <div className="saved-search-form">
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Name, e.g. HSE energy" />
          <input value={buyer} onChange={(event) => setBuyer(event.target.value)} placeholder="Buyer contains…" />
          <input value={cpv} onChange={(event) => setCpv(event.target.value)} placeholder="CPV codes, comma separated" />
          <input value={keywords} onChange={(event) => setKeywords(event.target.value)} placeholder="Keywords, comma separated" />
          <button
            className="quiet-btn"
            disabled={busy || !name.trim()}
            onClick={() => {
              onSave(name.trim(), {
                buyer: buyer.trim(), sectors: [], keywords: list(keywords),
                cpvCodes: list(cpv), valueMin: null, valueMax: null,
              });
              setShowForm(false);
              setName(""); setBuyer(""); setCpv(""); setKeywords("");
            }}
          >Save</button>
        </div>
      )}
    </section>
  );
}

const euros = (value: number) =>
  new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(value);

/**
 * The whole pipeline on one board.
 *
 * Bid decisions are made one tender at a time, but capacity is finite across
 * the week. Nothing here is scored again — every figure comes from the tender
 * it belongs to, so the board can never disagree with the tender.
 */
function PortfolioView({ portfolio, sort, onSort, onOpen, onDiscover, loading }: {
  portfolio: Portfolio | null;
  sort: "deadline" | "recommendation" | "blockers";
  onSort: (sort: "deadline" | "recommendation" | "blockers") => void;
  onOpen: (tenderId: string) => void;
  onDiscover: () => void;
  loading: boolean;
}) {
  const row = (entry: PortfolioRow) => (
    <article className="portfolio-row" key={entry.id} onClick={() => onOpen(entry.id)} data-testid={`portfolio-${entry.id}`}>
      <div>
        <h3>{entry.title}</h3>
        <p className="authority">{entry.authority}</p>
      </div>
      <span className={`decision-pill decision-${decisionSlug(entry.recommendation)}`}>{decisionLabel(entry.recommendation)}</span>
      <div className="portfolio-facts">
        <span><small>Deadline</small><strong>{entry.deadline}</strong></span>
        <span><small>Time left</small><strong className={entry.closed ? "watch-passed" : ""}>{entry.closed ? "Passed" : entry.daysRemaining === null ? "Not stated" : `${entry.daysRemaining} days`}</strong></span>
        <span><small>Open items</small><strong className={entry.unresolvedBlockers > 0 ? "portfolio-blockers" : ""}>{entry.unresolvedBlockers}</strong></span>
        <span><small>Decision</small><strong>{entry.decision === "BID" ? "Bid" : entry.decision === "NO_BID" ? "No bid" : "Not recorded"}</strong></span>
      </div>
    </article>
  );

  return (
    <div className="portfolio-page">
      <div className="section-intro">
        <div>
          <p className="eyebrow">PORTFOLIO</p>
          <h2>Triage the week.</h2>
          <p>Every live opportunity with its recommendation, its deadline and what is still open on it.</p>
        </div>
        <label className="portfolio-sort">Sort by
          <select value={sort} onChange={(event) => onSort(event.target.value as typeof sort)} disabled={loading}>
            <option value="deadline">Deadline</option>
            <option value="recommendation">Recommendation</option>
            <option value="blockers">Open items</option>
          </select>
        </label>
      </div>

      {portfolio?.note && (
        <section className="panel" data-testid="portfolio-empty">
          <p>{portfolio.note} — <button className="text-action" onClick={onDiscover}>find one on Discover</button></p>
        </section>
      )}

      {(portfolio?.pipeline.length ?? 0) > 0 && (
        <section className="panel portfolio-summary" data-testid="pipeline-value">
          {portfolio!.pipeline.map((entry) => (
            <span key={entry.decision}>
              <strong>{euros(entry.value)}</strong>
              <small>{entry.decision === "BID" ? "Bidding" : "Not bidding"} · {entry.count} tender{entry.count === 1 ? "" : "s"}</small>
            </span>
          ))}
        </section>
      )}

      {(portfolio?.live.length ?? 0) > 0 && <section className="panel portfolio-list">{portfolio!.live.map(row)}</section>}
      {(portfolio?.closed.length ?? 0) > 0 && (
        <section className="panel portfolio-list">
          <p className="eyebrow">CLOSED</p>
          {portfolio!.closed.map(row)}
        </section>
      )}
    </div>
  );
}

function WatchlistView({ items, loading, onUnwatch, onImport, onDiscover }: {
  items: WatchlistItem[]; loading: boolean;
  onUnwatch: (externalId: string) => void; onImport: (item: WatchlistItem) => void; onDiscover: () => void;
}) {
  const live = items.filter((item) => !item.closed);
  const closed = items.filter((item) => item.closed);
  const row = (item: WatchlistItem) => (
    <article className="watch-row" key={item.externalId} data-testid={`watch-row-${item.externalId}`}>
      <div>
        <h3>{item.title}</h3>
        <p className="authority">{item.authority || "Contracting authority"}</p>
        <div className="tender-facts">
          <span><small>Deadline</small><strong>{item.deadline || "Not stated"}</strong></span>
          <span><small>Time left</small><strong className={item.closed ? "watch-passed" : ""}>{item.closed ? "Deadline passed" : item.daysRemaining === null ? "Not stated" : `${item.daysRemaining} day${item.daysRemaining === 1 ? "" : "s"}`}</strong></span>
        </div>
      </div>
      <div className="watch-actions">
        <button className="quiet-btn" onClick={() => onImport(item)} disabled={loading}>Import as bid</button>
        <button className="text-action" onClick={() => onUnwatch(item.externalId)} disabled={loading}>Unwatch</button>
      </div>
    </article>
  );

  return (
    <div className="watchlist-page">
      <div className="section-intro">
        <div>
          <p className="eyebrow">WATCHLIST</p>
          <h2>Interesting, not yet a bid.</h2>
          <p>Notices you are keeping an eye on. Nothing here has been imported or analysed, so watching costs nothing.</p>
        </div>
        <button className="quiet-btn" onClick={onDiscover}>Back to Discover</button>
      </div>
      {items.length === 0 && <section className="panel"><p>Nothing on the watchlist yet. Star a notice on Discover to keep an eye on its deadline.</p></section>}
      {live.length > 0 && <section className="panel watch-list">{live.map(row)}</section>}
      {closed.length > 0 && (
        <section className="panel watch-list">
          <p className="eyebrow">CLOSED</p>
          {closed.map(row)}
        </section>
      )}
    </div>
  );
}

function Discover({ tenders, query, setQuery, refreshDiscovery, loading, openBid, setShowImport, hasPreferences, onOpenSettings, watching, onToggleWatch, savedSearches, activeSearchId, activeSearchName, onSelectSearch, onSaveSearch, onDeleteSearch }: {
  tenders: Tender[]; query: string; setQuery: (value: string) => void; refreshDiscovery: () => void; loading: boolean; openBid: (id: string) => void; setShowImport: (value: boolean) => void; hasPreferences: boolean; onOpenSettings: () => void; watching: Set<string>; onToggleWatch: (tender: Tender) => void; savedSearches: SavedSearch[]; activeSearchId: string; activeSearchName: string; onSelectSearch: (id: string) => void; onSaveSearch: (name: string, filter: SavedSearchFilter) => void; onDeleteSearch: (id: string) => void;
}) {
  return (
    <div className="discover-page">
      <section className="discover-hero">
        <div>
          <p className="eyebrow"><span>✦</span> BID INTELLIGENCE</p>
          <h1>Find the bids worth <em>winning.</em></h1>
          <p>Tenderly watches public opportunities, checks them against your company, and tells you what deserves bid effort.</p>
        </div>
        <div className="hero-stats">
          <div><span className="stat-orb strong">{tenders.length}</span><p><strong>Matches in view</strong><small>profile-ranked</small></p></div>
          <div><span className="stat-orb neutral">Live</span><p><strong>eTenders source</strong><small>manual refresh anytime</small></p></div>
          <div><span className="stat-orb pale">1–3</span><p><strong>Synopsis slides</strong><small>after qualification</small></p></div>
        </div>
      </section>

      <section className="search-panel">
        <div className="search-box"><span>⌕</span><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search tenders, buyers, services or CPV codes…" /><kbd>⌘ K</kbd></div>
        <button className="link-button" onClick={() => setShowImport(true)}><span>↗</span> Paste eTenders link</button>
      </section>

      <section className="feed-head">
        <div><h2>Recommended for you</h2><span>{tenders.length} opportunities · ranked against your profile</span></div>
        <div className="feed-actions"><button className="refresh-btn" onClick={refreshDiscovery} disabled={loading}>{loading ? "Checking…" : "↻ Refresh live"}</button></div>
      </section>

      {!hasPreferences && (
        <section className="panel attention-card" data-testid="no-preferences">
          <span>✦</span>
          <div>
            <strong>Set your discovery preferences</strong>
            <p>Tenderly is showing every current opportunity. Tick the sectors you bid in and it will show only the ones worth your time.</p>
          </div>
          <button className="quiet-btn" onClick={onOpenSettings}>Choose sectors</button>
        </section>
      )}
      <SavedSearchBar
        searches={savedSearches}
        activeId={activeSearchId}
        activeName={activeSearchName}
        onSelect={onSelectSearch}
        onSave={onSaveSearch}
        onDelete={onDeleteSearch}
        busy={loading}
      />
      <div className="tender-list">
        {tenders.map((tender) => (
          <article className="tender-card" key={tender.id} onClick={() => openBid(tender.id)}>
            <div className={`score-ring ${scoreTone(tender.match)}`}><strong>{tender.match}</strong><small>match</small></div>
            <div className="tender-main">
              <div className="tender-meta"><span className={`notice-source ${(tender.noticeSource ?? "eTenders") === "TED" ? "ted" : "etenders"}`}>{tender.noticeSource ?? "eTenders"}</span><i>•</i><span>{tender.category}</span><i>•</i><span>{tender.procedure}</span><i>•</i><span>Published {tender.published}</span></div>
              <h3>{tender.title}</h3>
              <p className="authority">{tender.authority}</p>
              <div className="tender-facts"><span><small>Deadline</small><strong>{tender.deadline}</strong></span><span><small>Value</small><strong>{tender.value}</strong></span><span><small>Access</small><strong>{tender.access}</strong></span></div>
              {(tender.matchedBy?.length ?? 0) > 0 && (
                <div className="match-reasons" data-testid="match-reasons">
                  {tender.matchedBy!.map((reason) => <i key={`${reason.sector}-${reason.keyword}`} title={`matched on "${reason.keyword}"`}>{reason.label}</i>)}
                </div>
              )}
              {(tender.alternateSources?.length ?? 0) > 1 && (
                <p className="alternate-sources" data-testid="alternate-sources">
                  Published on {tender.alternateSources!.map((entry, index) => (
                    <span key={entry.url}>{index > 0 && " and "}<a href={entry.url} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>{entry.label}</a></span>
                  ))}
                  {tender.mergeReason === "heuristic" && <small title="Matched on buyer, title and deadline rather than a shared OJEU reference"> · matched without a shared reference</small>}
                </p>
              )}
              <ScoreBreakdownDetail breakdown={tender.scoreBreakdown} />
            </div>
            <div className="tender-decision">
              <button
                className={`watch-star ${watching.has(tender.resourceId) ? "active" : ""}`}
                data-testid={`watch-${tender.resourceId}`}
                title={watching.has(tender.resourceId) ? "Remove from watchlist" : "Watch this notice"}
                onClick={(event) => { event.stopPropagation(); onToggleWatch(tender); }}
              >{watching.has(tender.resourceId) ? "★" : "☆"}</button>
              <span className={`decision-pill decision-${decisionSlug(tender.decision)}`}>{tender.decision === "GO" ? "✓" : tender.decision === "PARTNER" ? "↔" : tender.decision === "NO_GO" ? "×" : "!"} {decisionLabel(tender.decision)}</span>
              <button aria-label={`Review ${tender.title}`}>Review <span>→</span></button>
            </div>
          </article>
        ))}
        {tenders.length === 0 && <div className="empty-state"><span>⌕</span><h3>No matches in this view</h3><p>Try a broader search or paste an eTenders link directly.</p></div>}
      </div>

      <div className="source-note"><span>●</span><p><strong>eTenders discovery</strong><small>Public opportunities are compared with your services, CPVs and evidence. Full eligibility is checked only after the tender pack is imported.</small></p><em>Profile-based ranking</em></div>
    </div>
  );
}

function BidWorkspace({ tender, stage, setStage, runAnalysis, loading, draftAnswer, markAnswerReady, uploadTenderFile, downloadAsset, markChecklistReady, updateQuestion, acknowledgeAiPolicy, packQuestions, packSearchable, askThePack, analysisChanges, viewAnalysisVersion, clarifications, openClarifications, askClarification, answerClarification, assignRole, onOpenCitation, recordBidDecision, setSelectedLots, setNoAiMode, critiqueAnswer, critique, evaluation, runMockEvaluation, answerHistory, selectVersion, compareVersions, restoreVersion, attestation, onAttest, runbook, runbookCompleted, runbookTotal, tickRunbookStep, tasks, addTask, updateTask, blockers }: {
  tender: Tender; stage: BidStage; setStage: (stage: BidStage) => void; runAnalysis: () => void; loading: string; draftAnswer: (id: string) => void; markAnswerReady: (id: string) => void; uploadTenderFile: (file: File, role: "source" | "submission") => void; downloadAsset: (kind: "deck" | "pack", draft?: boolean) => void; markChecklistReady: (id: string) => void; updateQuestion: (id: string, answer: string) => void; acknowledgeAiPolicy: (action: "confirmed" | "dismissed") => void; packQuestions: PackQuestion[]; packSearchable: boolean; askThePack: (question: string) => void; analysisChanges: AnalysisChanges | null; viewAnalysisVersion: (versionId: string) => void; clarifications: Clarification[]; openClarifications: number; askClarification: (question: string) => void; answerClarification: (id: string, response: string) => void; assignRole: (role: string, personId: string | null) => void; recordBidDecision: (decision: "BID" | "NO_BID", reason: string) => void; setSelectedLots: (lotIds: string[]) => void; setNoAiMode: (enabled: boolean) => void; critiqueAnswer: (id: string) => void; critique: AnswerCritique | null; evaluation: EvaluationState | null; runMockEvaluation: () => void; answerHistory: AnswerHistory | null; selectVersion: (versionId: string) => void; compareVersions: () => void; restoreVersion: (versionId: string) => void; onOpenCitation: (citation: { id: string; name: string; hasFile: boolean }) => void; attestation: AttestationState | null; onAttest: () => void; runbook: Runbook | null; runbookCompleted: number; runbookTotal: number; tickRunbookStep: (stepId: string, done: boolean) => void; tasks: BidTask[]; addTask: (title: string, dueOn: string) => void; updateTask: (taskId: string, patch: { owner?: string; dueOn?: string; completed?: boolean }) => void; blockers: string[];
}) {
  const passed = tender.gates.filter((gate) => gate.state === "pass").length;
  const reviewed = tender.gates.filter((gate) => gate.state === "review").length;
  const failed = tender.gates.filter((gate) => gate.state === "fail").length;
  return (
    <div className="workspace-page">
      <section className="bid-titlebar">
        <div className="bid-id">eTenders <b>#{tender.resourceId}</b></div>
        <div className="bid-title-row">
          <div><h1>{tender.title}</h1><p>{tender.authority} · {tender.procedure} · closes <strong>{tender.deadline}</strong></p></div>
          <div className="bid-title-actions"><a href={tender.sourceUrl} target="_blank" rel="noreferrer">View source ↗</a><button className="ghost-btn">•••</button></div>
        </div>
      </section>

      {tender.analysisOutdated && (
        <section className="panel attention-card" data-testid="analysis-outdated">
          <span>!</span>
          <div>
            <strong>Analysis is from an earlier version — re-analyse to update</strong>
            <p>This tender was analysed under an older shape. Everything below still renders; re-running qualification brings it up to date.</p>
          </div>
          <button className="quiet-btn" onClick={runAnalysis} disabled={Boolean(loading)}>{loading === "analyse" ? "Re-analysing…" : "Re-analyse"}</button>
        </section>
      )}

      <nav className="stage-tabs" aria-label="Bid workflow">
        {stages.map((item, index) => <button key={item} className={stage === item ? "active" : ""} onClick={() => setStage(item)}><span>{index + 1}</span>{item}{item === "Qualify" && reviewed > 0 && <i>{reviewed}</i>}</button>)}
      </nav>

      {stage === "Qualify" && (
        <div className="bid-grid">
          <div className="bid-primary">
            <section className={`decision-hero ${decisionSlug(tender.decision)}`}>
              <div className="decision-score"><strong>{tender.match}</strong><span>/100</span><small>bid fit</small></div>
              <div><p className="eyebrow">TENDERLY RECOMMENDATION</p><h2>{tender.decision === "GO" ? "Go for it." : tender.decision === "PARTNER" ? "Bid with a partner." : tender.decision === "NO_GO" ? "Save your bid effort." : "Review before committing."}</h2><p>{tender.partnerNote ?? tender.summary}</p></div>
              <span className={`hero-decision decision-${decisionSlug(tender.decision)}`}>{decisionLabel(tender.decision)}</span>
            </section>

            <RecommendationPanel recommendation={tender.recommendation} />
            <Clarifications items={clarifications} open={openClarifications} onAsk={askClarification} onAnswer={answerClarification} busy={loading === "clarify"} />
            <WhatChanged state={analysisChanges} onSelectVersion={viewAnalysisVersion} />
            <AskThePack questions={packQuestions} searchable={packSearchable} onAsk={askThePack} busy={loading === "ask"} />
            <BidDecisionPanel tender={tender} onRecord={recordBidDecision} busy={loading === "decision"} />
            <RoleMatches matches={tender.roleMatches ?? []} onAssign={assignRole} busy={loading === "assign-role"} />
            <LotSelector lots={tender.lots ?? []} selected={tender.selectedLots ?? []} onChange={setSelectedLots} busy={loading === "lots"} />
            <AiUsePolicyPanel policy={tender.aiUsePolicy} onAcknowledge={acknowledgeAiPolicy} busy={loading === "ai-policy"} />
            <AwardHistory data={tender.awardIntelligence} />
            <AwardCriteria criteria={tender.awardCriteria ?? []} warning={tender.awardCriteriaWarning} />
            <Formalities formalities={tender.formalities ?? []} certificates={tender.requiredCertificates ?? []} />
            <section className="panel gate-panel">
              <div className="panel-heading"><div><h2>Eligibility gates</h2><p>Hard requirements before quality scoring. Every conclusion points back to source evidence.</p></div><button className="text-action" onClick={runAnalysis}>{loading === "analyse" ? "Analysing…" : "↻ Re-run checks"}</button></div>
              <div className="gate-summary"><span className="sum-pass">✓ {passed} passed</span><span className="sum-review">! {reviewed} review</span>{failed > 0 && <span className="sum-fail">× {failed} failed</span>}<span className="source-guard">◇ Sourced, not guessed</span></div>
              <div className="gate-table">
                <div className="gate-tr gate-header"><span>Requirement</span><span>Your evidence</span><span>Status</span><span>Source</span></div>
                {tender.gates.map((gate) => <div className="gate-tr" key={gate.label}><span><strong>{gate.label}</strong><small>{gate.requirement}</small></span><span>{gate.bidder}</span><span><GatePill state={gate.state} /></span><span><button className="source-link" title={gate.source}>Quote ↗</button></span></div>)}
              </div>
            </section>

            <section className="panel fit-panel">
              <div className="panel-heading"><div><h2>Bid fit</h2><p>Commercial and delivery fit after eligibility.</p></div><strong className="fit-score">{tender.match}%</strong></div>
              <div className="fit-bars">
                {[['Capability match', 92], ['Past evidence', 78], ['Team / CV fit', 84], ['Commercial fit', 73], ['Delivery confidence', 89]].map(([label, score]) => <div key={String(label)}><span><strong>{label}</strong><em>{score}%</em></span><i><b style={{ width: `${score}%` }} /></i></div>)}
              </div>
            </section>
          </div>

          <aside className="bid-aside">
            <section className="panel snapshot-card"><p className="eyebrow">AT A GLANCE</p><h3>Bid snapshot</h3><dl>{tender.cpv && <div><dt>CPV</dt><dd title={tender.cpv.recognised ? tender.cpv.ancestors?.map((a) => `${a.code} ${a.description}`).join(" · ") : undefined}>{tender.cpv.recognised ? `${tender.cpv.code} — ${tender.cpv.description}` : <>{tender.cpv.raw} <small className="cpv-unknown">Unrecognised CPV</small></>}</dd></div>}<div><dt>Procedure</dt><dd>{tender.procedure}</dd></div><div><dt>Competition</dt><dd>{tender.framework}</dd></div><div><dt>Access</dt><dd>{tender.access}</dd></div><div><dt>Est. value</dt><dd>{tender.value}</dd></div><div><dt>Deadline</dt><dd className="deadline">{tender.deadline}</dd></div></dl></section>
            <PressurePanel pressure={tender.pressure} />
            <section className="panel attention-card"><span>!</span><div><strong>{reviewed ? `${reviewed} item${reviewed > 1 ? "s" : ""} need your input` : "No eligibility blockers"}</strong><p>{reviewed ? "Resolve review gates before changing this bid to final-ready." : "You can move into response drafting."}</p></div></section>
            {!!tender.roles?.length && <section className="panel role-match-card"><div className="role-match-head"><strong>Required people / CVs</strong><span>{tender.roles.length} role{tender.roles.length > 1 ? "s" : ""}</span></div>{tender.roles.slice(0, 4).map((role) => <div className="role-match-row" key={`${role.role}-${role.quantity}`}><div><strong>{role.quantity > 1 ? `${role.quantity}× ` : ""}{role.role}</strong><small>{role.bidderMatch || "No evidenced match"}</small></div><GatePill state={role.status === "PASS" ? "pass" : role.status === "FAIL" ? "fail" : "review"} /><p>{role.action || role.qualifications || role.experience}</p></div>)}</section>}
            <button className="continue-btn" onClick={() => setStage("Synopsis")}>Preview synopsis <span>→</span></button>
            <button className="quiet-btn" onClick={() => setStage("Respond")}>Let’s go — start response</button>
          </aside>
        </div>
      )}

      {stage === "Synopsis" && <Synopsis tender={tender} onDownload={() => downloadAsset("deck")} onContinue={() => setStage("Respond")} loading={loading === "deck"} />}
      {stage === "Respond" && <Respond tender={tender} setNoAiMode={setNoAiMode} critiqueAnswer={critiqueAnswer} critique={critique} evaluation={evaluation} onRunEvaluation={runMockEvaluation} history={answerHistory} onSelectVersion={selectVersion} onCompareVersions={compareVersions} onRestoreVersion={restoreVersion} onBackToQualify={() => setStage("Qualify")} onOpenCitation={onOpenCitation} draftAnswer={draftAnswer} markAnswerReady={markAnswerReady} uploadTenderFile={uploadTenderFile} loading={loading} updateQuestion={updateQuestion} onContinue={() => setStage("Assemble")} />}
      {stage === "Assemble" && <Assemble tender={tender} blockers={blockers} attestation={attestation} onAttest={onAttest} tasks={tasks} onAddTask={addTask} onUpdateTask={updateTask} onDraft={() => downloadAsset("pack", true)} uploadTenderFile={uploadTenderFile} onMarkReady={markChecklistReady} onContinue={() => setStage("Submit")} loading={loading} />}
      {stage === "Submit" && <Submit runbook={runbook} runbookCompleted={runbookCompleted} runbookTotal={runbookTotal} onTickRunbook={tickRunbookStep} runbookBusy={loading === "runbook"} tender={tender} blockers={blockers} onDownload={() => downloadAsset("pack", false)} onReview={() => setStage("Assemble")} loading={loading === "pack"} />}
    </div>
  );
}

function Synopsis({ tender, onDownload, onContinue, loading }: { tender: Tender; onDownload: () => void; onContinue: () => void; loading: boolean }) {
  return (
    <div className="synopsis-view">
      <div className="section-intro"><div><p className="eyebrow">3-SLIDE BID BRIEF</p><h2>Understand the tender in five minutes.</h2><p>Generated from the notice and tender pack. Critical facts stay attached to source evidence.</p></div><button className="outline-primary" onClick={onDownload}>{loading ? "Building…" : "⇩ Download .pptx"}</button></div>
      <div className="slide-stack">
        <article className="brief-slide slide-one"><div className="slide-number">01</div><div className="slide-brand"><Logo /></div><p className="slide-kicker">THE OPPORTUNITY</p><h3>{tender.title}</h3><p>{tender.summary}</p><div className="slide-metrics"><span><small>Buyer</small><strong>{tender.authority}</strong></span><span><small>Value</small><strong>{tender.value}</strong></span><span><small>Deadline</small><strong>{tender.deadline}</strong></span></div></article>
        <article className="brief-slide"><div className="slide-number">02</div><p className="slide-kicker">CAN WE BID?</p><div className="slide-two-grid"><div><h3><b>{tender.match}</b><span>/100 fit</span></h3><p>{tender.access}</p><span className={`decision-pill decision-${decisionSlug(tender.decision)}`}>{decisionLabel(tender.decision)}</span></div><div className="slide-gates">{tender.gates.slice(0, 4).map((gate) => <p key={gate.label}><GatePill state={gate.state} /><span><strong>{gate.label}</strong><small>{gate.bidder}</small></span></p>)}</div></div></article>
        <article className="brief-slide"><div className="slide-number">03</div><p className="slide-kicker">HOW TO WIN</p><h3>Win themes & bid plan</h3><div className="win-grid"><div><b>01</b><strong>Lead with relevant outcomes</strong><p>Use named evidence, measurable delivery controls and buyer-language.</p></div><div><b>02</b><strong>Close evidence gaps early</strong><p>Resolve CV / credential inputs before drafting scored sections.</p></div><div><b>03</b><strong>Write to the marks</strong><p>Allocate response effort to weight, word limit and minimum scores.</p></div><div><b>04</b><strong>Red-team before pack</strong><p>Verify every claim, attachment and mandatory declaration.</p></div></div></article>
      </div>
      <div className="bottom-action"><span><strong>Ready to bid?</strong><small>Tenderly will turn evaluation criteria into a controlled response workspace.</small></span><button className="continue-btn" onClick={onContinue}>Let’s go <span>→</span></button></div>
    </div>
  );
}

type EvaluationState = {
  result: MockEvaluation;
  gaps: { criterion: string; gap: string; questionId: string; marksLost: number }[];
};

type AnswerHistory = {
  questionId: string;
  versions: AnswerVersion[];
  diff?: DiffSegment[];
  /** The two versions ticked for comparison. */
  selected: string[];
};

type AnswerCritique = { questionId: string; strengths: string[]; gaps: string[]; missingEvidence: string[] };

/**
 * A review of text the user wrote. Deliberately three lists and no prose: in a
 * tender that prohibits AI-generated content, a "suggested rewrite" would be
 * exactly the thing that is prohibited.
 */
function CritiquePanel({ critique }: { critique: AnswerCritique }) {
  const section = (title: string, items: string[], tone: string) => items.length > 0 && (
    <div className={`critique-group ${tone}`}><strong>{title}</strong><ul>{items.map((item) => <li key={item}>{item}</li>)}</ul></div>
  );
  return (
    <section className="panel critique-panel" data-testid="critique-panel">
      <div className="panel-heading"><div><h2>Critique of your answer</h2><p>What this text does well and where it misses the requirement. No replacement wording is offered.</p></div></div>
      {section("Strengths", critique.strengths, "pass")}
      {section("Gaps against the requirement", critique.gaps, "review")}
      {section("Missing evidence", critique.missingEvidence, "review")}
    </section>
  );
}

const provenanceLabels: Record<ProvenanceClass, string> = {
  "ai-generated": "AI-generated",
  "ai-assisted": "AI-assisted",
  human: "Human",
};

/**
 * How this section came to exist. Buyers ask, and some prohibit AI-generated
 * content outright, so the badge states the class plainly rather than hiding it.
 * An answer with no ledger shows nothing — it makes no claim about itself.
 */
function ProvenanceBadge({ entry }: { entry?: ProvenanceEntry }) {
  if (!entry) return null;
  const detail = entry.model ? `${entry.model} · ${entry.promptVersion ?? "prompt version not recorded"}` : `Written by ${entry.actor}`;
  return (
    <p className={`provenance-badge ${entry.class}`} data-testid="provenance-badge" title={detail}>
      <span>{provenanceLabels[entry.class]}</span>
      <small>{detail}</small>
    </p>
  );
}

/**
 * Every saved state of an answer, with a comparison and a restore.
 *
 * Restoring adds a version rather than rewinding, and keeps the class of the
 * text it restores — an answer restored from an AI draft still reads as
 * AI-generated. Restoring is not a way to launder how something was written.
 */
function VersionHistory({ versions, diff, selected, onSelect, onCompare, onRestore, busy }: {
  versions: AnswerVersion[]; diff?: DiffSegment[]; selected: string[];
  onSelect: (versionId: string) => void; onCompare: () => void;
  onRestore: (versionId: string) => void; busy: boolean;
}) {
  if (versions.length === 0) return null;
  return (
    <section className="panel version-history" data-testid="version-history">
      <div className="panel-heading">
        <div><h3>History</h3><p>Every saved state. Restoring writes a new version — nothing is ever lost.</p></div>
        <button
          className="text-action"
          disabled={busy || versions.length < 2 || selected.length !== 2}
          title={versions.length < 2 ? "There is only one version" : "Select two versions to compare"}
          onClick={onCompare}
        >Compare</button>
      </div>

      <ul className="version-list">
        {versions.map((version, index) => (
          <li key={version.id} data-testid={`version-${version.id}`}>
            <label>
              <input
                type="checkbox"
                checked={selected.includes(version.id)}
                disabled={versions.length < 2}
                onChange={() => onSelect(version.id)}
              />
              <span>
                <strong>Version {index + 1}{version.restoredFrom ? " · restored" : ""}</strong>
                <small>{version.provenanceClass} · {version.actor} · {new Date(version.createdAt).toLocaleString()}</small>
              </span>
            </label>
            {index < versions.length - 1 && (
              <button className="text-action" disabled={busy} onClick={() => onRestore(version.id)}>Restore</button>
            )}
          </li>
        ))}
      </ul>

      {diff && (
        <p className="version-diff" data-testid="version-diff">
          {diff.map((segment, index) => (
            <span key={index} className={segment.kind}>{segment.text}</span>
          ))}
        </p>
      )}
    </section>
  );
}

/**
 * How the drafted response would score against the published criteria.
 *
 * The number is an estimate, and the panel says so before it says anything
 * else: we do not know the buyer's panel, the competing bids or the moderation.
 * A generous mock score is worse than none, because it tells a company to stop
 * working on a bid that will lose.
 */
function MockEvaluationPanel({ evaluation, gaps, onRun, onJumpToQuestion, busy }: {
  evaluation: MockEvaluation | null;
  gaps: { criterion: string; gap: string; questionId: string; marksLost: number }[];
  onRun: () => void;
  onJumpToQuestion: (questionId: string) => void;
  busy: boolean;
}) {
  return (
    <section className="panel mock-evaluation" data-testid="mock-evaluation">
      <div className="panel-heading">
        <div><h3>Mock evaluation</h3><p>Scored against the criteria the buyer published.</p></div>
        <button className="quiet-btn" onClick={onRun} disabled={busy}>{busy ? "Scoring…" : evaluation ? "Re-run" : "Run"}</button>
      </div>

      {!evaluation
        ? <p className="mock-empty">Run it once there is something drafted to score.</p>
        : (
          <>
            <p className="mock-notice" data-testid="mock-notice">{evaluation.notice}</p>
            <p className="mock-total"><strong>{evaluation.total}</strong><span>/ 100 estimated</span></p>

            <ul className="mock-criteria">
              {evaluation.criteria.map((criterion) => (
                <li key={criterion.name} className={criterion.belowHalf ? "below-half" : ""}>
                  <div>
                    <strong>{criterion.name}</strong>
                    <small>{criterion.reasoning}</small>
                    {criterion.gap && (
                      <em>
                        {criterion.gap}
                        {criterion.questionId && (
                          <button className="text-action" onClick={() => onJumpToQuestion(criterion.questionId)}>Open the answer</button>
                        )}
                      </em>
                    )}
                  </div>
                  <span>{criterion.mark}/{criterion.maximum}<small>+{criterion.weightedContribution}</small></span>
                </li>
              ))}
            </ul>

            {gaps.length > 0 && (
              <p className="mock-worklist">Worst first: {gaps.map((gap) => `${gap.criterion} (−${gap.marksLost})`).join(", ")}</p>
            )}
          </>
        )}
    </section>
  );
}

function Respond({ tender, setNoAiMode, critiqueAnswer, critique, evaluation, onRunEvaluation, history, onSelectVersion, onCompareVersions, onRestoreVersion, onBackToQualify, onOpenCitation, draftAnswer, markAnswerReady, uploadTenderFile, loading, updateQuestion, onContinue }: { tender: Tender; setNoAiMode: (enabled: boolean) => void; critiqueAnswer: (id: string) => void; critique: AnswerCritique | null; evaluation: EvaluationState | null; onRunEvaluation: () => void; history: AnswerHistory | null; onSelectVersion: (versionId: string) => void; onCompareVersions: () => void; onRestoreVersion: (versionId: string) => void; onBackToQualify: () => void; onOpenCitation: (citation: { id: string; name: string; hasFile: boolean }) => void; draftAnswer: (id: string) => void; markAnswerReady: (id: string) => void; uploadTenderFile: (file: File, role: "source" | "submission") => void; loading: string; updateQuestion: (id: string, answer: string) => void; onContinue: () => void }) {
  const [activeId, setActiveId] = useState(tender.questions[0]?.id ?? "");
  const active = tender.questions.find((question) => question.id === activeId) ?? tender.questions[0];
  if (!active) return <div className="no-questions panel"><span>◇</span><h2>Import the full tender pack first</h2><p>The notice gives Tenderly the opportunity metadata. The RFT / RFQ documents are needed to extract scored questions, word limits, mandatory roles and response templates.</p><FileButton label={loading === "upload" ? "Uploading…" : "Upload tender documents"} accept=".pdf,.docx,.xlsx,.xls,.pptx,.zip,.txt,.xml" onFile={(file) => uploadTenderFile(file, "source")} /></div>;
  return (
    <div className="response-layout">
      <aside className="question-list">
        <div><p className="eyebrow">RESPONSE PLAN</p><h3>{tender.questions.length} scored sections</h3><small>80% of quality marks mapped</small></div>
        {tender.questions.map((question, index) => <button key={question.id} className={active.id === question.id ? "active" : ""} onClick={() => setActiveId(question.id)}><span className="q-index">{String(index + 1).padStart(2, '0')}</span><span><strong>{question.title}</strong><small>{question.weight}% · max {question.maxWords} words</small></span><i className={`q-state ${question.status}`} /></button>)}
        <div className="response-key"><p><i className="q-state ready" /> Ready</p><p><i className="q-state draft" /> Draft</p><p><i className="q-state needs-input" /> Needs input</p></div>
        {(tender.orphanedAnswers?.length ?? 0) > 0 && (
          <div className="orphaned-answers" data-testid="orphaned-answers">
            <p className="eyebrow">NO LONGER IN THE TENDER</p>
            <small>{tender.orphanedAnswers!.length} saved answer{tender.orphanedAnswers!.length > 1 ? "s" : ""} whose question the latest analysis does not contain. Kept so nothing written by a person is lost.</small>
            {tender.orphanedAnswers!.map((orphan) => (
              <details key={orphan.questionId}><summary>{orphan.status} · {orphan.questionId}</summary><p>{orphan.response}</p></details>
            ))}
          </div>
        )}
      </aside>
      <section className="answer-editor">
        {(tender.bidDecisions?.length ?? 0) === 0 && (
          <div className="ai-policy-prompt" data-testid="decision-required">
            <strong>Record your bid decision first.</strong>
            <p>Tenderly recommends; the company decides. Go back to Qualify and record whether you are bidding before writing the response.</p>
            <button className="quiet-btn" onClick={onBackToQualify}>Back to Qualify</button>
          </div>
        )}
        {tender.noAiMode ? (
          <div className="no-ai-banner" data-testid="no-ai-banner">
            <strong>No-AI mode: generation disabled for this tender</strong>
            <p>Analysis, the requirement checklist, gap analysis and critique of what you write all still work. Drafting does not.</p>
            <button className="text-action" onClick={() => setNoAiMode(false)} disabled={loading === "no-ai-mode"}>Turn off</button>
          </div>
        ) : tender.aiUsePolicy?.state === "prohibited" && (
          <div className="ai-policy-prompt" data-testid="no-ai-prompt">
            <strong>This tender prohibits AI-generated content.</strong>
            <p>“{tender.aiUsePolicy.quote}” — {tender.aiUsePolicy.source || "tender pack"}. Enable no-AI mode for this tender before using any draft control.</p>
            <button className="quiet-btn" onClick={() => setNoAiMode(true)} disabled={loading === "no-ai-mode"}>Enable no-AI mode</button>
          </div>
        )}
        <div className="answer-head"><div><p className="eyebrow">SCORED QUESTION · {active.weight}%</p><h2>{active.title}</h2><p>{active.prompt}</p><ProvenanceBadge entry={active.provenance} /></div><div className="mark-badge"><strong>{active.weight}</strong><small>marks</small></div></div>
        <div className="answer-brief"><div><span>✦</span><p><strong>Tenderly writing brief</strong><small>Answer the question directly, lead with the outcome, evidence every material claim, and reserve ~10% of words for measurable controls and assurance.</small></p></div><button>View scoring logic</button></div>
        <div className="editor-toolbar"><button><b>B</b></button><button><i>I</i></button><button>≡</button><button>• list</button><span /><button>Insert evidence ⌄</button></div>
        <textarea value={active.answer} onChange={(event) => updateQuestion(active.id, event.target.value)} placeholder="Draft your response here, or ask Tenderly to build a first draft from verified evidence…" />
        <div className="editor-foot"><span>{active.answer.trim() ? active.answer.trim().split(/\s+/).length : 0} / {active.maxWords || "—"} words</span><div>{active.status === "ready" ? <button className="ready-button" disabled>✓ Reviewed & ready</button> : <button className="quiet-btn" onClick={() => markAnswerReady(active.id)} disabled={loading === `ready-${active.id}`}>{loading === `ready-${active.id}` ? "Saving…" : "Mark reviewed & ready"}</button>}{tender.noAiMode
          ? <button className="quiet-btn" onClick={() => critiqueAnswer(active.id)} disabled={loading === `critique-${active.id}`}>{loading === `critique-${active.id}` ? "Reviewing…" : "◇ Critique what I wrote"}</button>
          : <button className="ai-draft" onClick={() => draftAnswer(active.id)} disabled={loading === active.id}>{loading === active.id ? "Drafting…" : "✦ Draft from evidence"}</button>}</div></div>
        <MockEvaluationPanel
          evaluation={evaluation?.result ?? null}
          gaps={evaluation?.gaps ?? []}
          onRun={onRunEvaluation}
          onJumpToQuestion={setActiveId}
          busy={loading === "evaluation"}
        />
        {critique?.questionId === active.id && <CritiquePanel critique={critique} />}
        {history?.questionId === active.id && (
          <VersionHistory
            versions={history.versions}
            diff={history.diff}
            selected={history.selected}
            onSelect={onSelectVersion}
            onCompare={onCompareVersions}
            onRestore={onRestoreVersion}
            busy={loading === "versions"}
          />
        )}
        {(active.citations?.length ?? 0) > 0 && (
          <section className="answer-citations" data-testid="answer-citations">
            <p className="eyebrow">CITED FROM YOUR VAULT</p>
            {active.citations!.map((citation) => (
              <button
                key={citation.id}
                className="citation"
                disabled={!citation.hasFile}
                title={citation.hasFile ? "Open the source document" : "This vault item has no file attached"}
                onClick={() => onOpenCitation(citation)}
              >◇ {citation.name}{citation.hasFile ? " ↗" : ""}</button>
            ))}
          </section>
        )}
        <section className="evidence-strip"><div className="evidence-title"><span>◇</span><p><strong>Evidence Tenderly will use</strong><small>Only approved library facts are passed into the draft.</small></p></div>{active.evidence.map((item) => <span className={item.toLowerCase().includes("needed") ? "missing" : ""} key={item}>{item.toLowerCase().includes("needed") ? "!" : "✓"} {item}</span>)}<button>＋ Attach evidence</button></section>
        <div className="response-next"><span><strong>Response readiness</strong><small>{tender.questions.filter((q) => q.status === "ready").length} of {tender.questions.length} sections ready</small></span><button className="continue-btn" onClick={onContinue}>Assemble pack <span>→</span></button></div>
      </section>
    </div>
  );
}

/**
 * The moment a named person states they have reviewed this exact content and
 * understand how it was produced. The final pack stays blocked until it happens,
 * and editing any answer invalidates it — the statement is about content, not a
 * box that stays ticked.
 */
function AttestationPanel({ state, onAttest, busy }: { state: AttestationState | null; onAttest: () => void; busy: boolean }) {
  const [confirmed, setConfirmed] = useState(false);
  if (!state) return null;
  const { summary, attestation, invalidated } = state;
  const otherBlockers = state.blockers.filter((blocker) => blocker !== "Attestation not recorded");
  const total = summary.counts["ai-generated"] + summary.counts["ai-assisted"] + summary.counts.human;
  return (
    <section className="panel attestation-panel" data-testid="attestation-panel">
      <div className="panel-heading"><div><h3>Review and attestation</h3><p>The final pack is released by a person, not by a checklist. Confirm you have read this response and understand how it was produced.</p></div></div>
      <div className="attestation-counts">
        <span><strong>{summary.counts["ai-generated"]}</strong><small>AI-generated</small></span>
        <span><strong>{summary.counts["ai-assisted"]}</strong><small>AI-assisted</small></span>
        <span><strong>{summary.counts.human}</strong><small>Human</small></span>
        <span><strong>{total}</strong><small>sections with a record</small></span>
      </div>
      {summary.aiGeneratedSections.length > 0 && (
        <p className="attestation-sections">Written by a model: {summary.aiGeneratedSections.join(", ")}</p>
      )}
      {summary.conflict && <p className="attestation-conflict" data-testid="attestation-conflict">{summary.conflict}</p>}
      {invalidated && <p className="attestation-conflict" data-testid="attestation-invalidated">The content changed after it was attested. Review it again before releasing the final pack.</p>}
      {attestation && !invalidated
        ? <p className="attestation-done" data-testid="attestation-done">Attested by {attestation.actor} on {new Date(attestation.at).toLocaleString()}</p>
        : otherBlockers.length > 0
          ? <p className="attestation-waiting">Resolve the remaining blockers before attesting.</p>
          : (
            <div className="attestation-confirm">
              <label><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> I have reviewed this response and understand how each section was produced.</label>
              <button className="outline-primary" onClick={onAttest} disabled={!confirmed || busy}>{busy ? "Recording…" : "Record attestation"}</button>
            </div>
          )}
    </section>
  );
}

/**
 * The work on this bid: who is doing what, by when.
 *
 * Blockers appear here as tasks automatically, and complete when the blocker
 * clears — a blocker task has no tick of its own, because a tick and a blocker
 * disagreeing about the same fact helps nobody.
 */
function TaskList({ tasks, onAdd, onUpdate, busy }: {
  tasks: BidTask[];
  onAdd: (title: string, dueOn: string) => void;
  onUpdate: (taskId: string, patch: { owner?: string; dueOn?: string; completed?: boolean }) => void;
  busy: boolean;
}) {
  const [title, setTitle] = useState("");
  const [dueOn, setDueOn] = useState("");
  const open = tasks.filter((task) => !task.completedAt);
  const done = tasks.filter((task) => task.completedAt);

  const row = (task: BidTask) => (
    <li key={task.id} className={task.overdue ? "overdue" : ""} data-testid={`task-${task.id}`}>
      <div>
        <strong>{task.title}</strong>
        <small>
          {task.origin === "blocker" ? "From a blocker" : "Added by hand"}
          {task.owner ? ` · ${task.owner}` : ""}
          {task.dueOn ? ` · due ${task.dueOn}` : ""}
          {task.overdue ? " · Overdue" : ""}
        </small>
      </div>
      <div className="task-actions">
        <input
          className="task-due"
          type="date"
          value={task.dueOn}
          onChange={(event) => onUpdate(task.id, { dueOn: event.target.value })}
          disabled={busy || Boolean(task.completedAt)}
        />
        {task.origin === "manual" && !task.completedAt && (
          <button className="text-action" disabled={busy} onClick={() => onUpdate(task.id, { completed: true })}>Done</button>
        )}
      </div>
    </li>
  );

  return (
    <section className="panel task-list" data-testid="task-list">
      <div className="panel-heading">
        <div><h3>Tasks</h3><p>Blockers appear here automatically and clear themselves when resolved.</p></div>
        {open.length > 0 && <span className="manifest-status">{open.length} open</span>}
      </div>

      <form
        className="ask-form"
        onSubmit={(event) => { event.preventDefault(); if (title.trim()) { onAdd(title.trim(), dueOn); setTitle(""); setDueOn(""); } }}
      >
        <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Draft the method statement" disabled={busy} />
        <input type="date" value={dueOn} onChange={(event) => setDueOn(event.target.value)} disabled={busy} />
        <button className="quiet-btn" disabled={busy || !title.trim()}>Add</button>
      </form>

      {open.length > 0 && <ul className="tasks">{open.map(row)}</ul>}
      {done.length > 0 && (
        <details className="tasks-done">
          <summary>{done.length} completed</summary>
          <ul className="tasks">{done.map(row)}</ul>
        </details>
      )}
    </section>
  );
}

function Assemble({ tender, onDraft, uploadTenderFile, onMarkReady, onContinue, loading, blockers, attestation, onAttest, tasks, onAddTask, onUpdateTask }: { tender: Tender; onDraft: () => void; uploadTenderFile: (file: File, role: "source" | "submission") => void; onMarkReady: (id: string) => void; onContinue: () => void; loading: string; blockers: string[]; attestation: AttestationState | null; onAttest: () => void; tasks: BidTask[]; onAddTask: (title: string, dueOn: string) => void; onUpdateTask: (taskId: string, patch: { owner?: string; dueOn?: string; completed?: boolean }) => void }) {
  const fallbackRows: SubmissionItem[] = [
    { id: "demo-response", label: "Tender response", required: true, kind: "RESPONSE", status: tender.questions.length && tender.questions.every((question) => question.status === "ready") ? "READY" : "ACTION", source: "Scored response workspace" },
    { id: "demo-cv", label: "Personnel CVs", required: true, kind: "CV", status: "VERIFY", source: "Tender pack · role requirements" },
    { id: "demo-pricing", label: "Pricing schedule", required: true, kind: "PRICING", status: "ACTION", source: "Buyer template" },
    { id: "demo-sign", label: "Signed declarations", required: true, kind: "SIGNATURE", status: "ACTION", source: "Buyer declaration" },
  ];
  const rows = tender.submissionChecklist?.length ? tender.submissionChecklist : fallbackRows;
  const unresolved = rows.filter((row) => row.required && row.status !== "READY").length;
  const readiness = Math.round(((rows.length - unresolved) / Math.max(1, rows.length)) * 100);
  return (
    <div className="assemble-page">
      {blockers.length > 0 && (
        <section className="panel attention-card" data-testid="blockers">
          <span>!</span>
          <div>
            <strong>Final pack blocked — {blockers.length} item{blockers.length > 1 ? "s" : ""} unresolved</strong>
            <ul>{blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul>
          </div>
        </section>
      )}
      <div className="section-intro"><div><p className="eyebrow">SUBMISSION ASSEMBLY</p><h2>One controlled pack. Nothing forgotten.</h2><p>Tenderly keeps mandatory buyer templates separate from generated response material and will not call a pack “final” while blockers remain.</p></div><div className="section-actions"><FileButton label={loading === "upload" ? "Uploading…" : "＋ Add completed buyer file"} accept=".pdf,.docx,.xlsx,.xls,.zip" onFile={(file) => uploadTenderFile(file, "submission")} /><button className="outline-primary" onClick={onDraft}>{loading === "pack" ? "Building…" : "⇩ Build draft ZIP"}</button></div></div>
      <div className="assemble-grid">
        <section className="panel manifest"><div className="panel-heading"><div><h3>Submission manifest</h3><p>Extracted from the tender pack; verify each buyer-controlled file after completion.</p></div><span className="manifest-status">{unresolved ? `${unresolved} need attention` : "Checklist clear"}</span></div>{rows.map((item, index) => <div className="manifest-row" key={item.id}><span>{String(index + 1).padStart(2, "0")}</span><p><strong>{item.label}</strong><small>{item.kind.replace("_", " ")} · {item.source}</small></p><GatePill state={item.status === "READY" ? "pass" : "review"} />{item.status === "READY" ? <button className="manifest-done" disabled>✓</button> : <button className="manifest-ready" onClick={() => onMarkReady(item.id)} disabled={loading === `check-${item.id}`} title="Confirm only after you have checked/completed this item">Ready</button>}</div>)}</section>
        <aside className="assembly-aside"><TaskList tasks={tasks} onAdd={onAddTask} onUpdate={onUpdateTask} busy={loading === "tasks"} /><AttestationPanel state={attestation} onAttest={onAttest} busy={loading === "attest"} /><section className="panel pack-score"><p className="eyebrow">PACK READINESS</p><div className="large-ring"><strong>{readiness}</strong><small>%</small></div><h3>{unresolved ? `${unresolved} thing${unresolved > 1 ? "s" : ""} left` : "Automated gates clear"}</h3><p>{unresolved ? "Resolve each required item, upload completed buyer files, then explicitly confirm it ready." : "Build the final checks view; human submission control still remains."}</p></section><section className="panel integrity-card"><strong>Submission guardrails</strong><p>✓ Eligibility checked before final pack</p><p>✓ Answer ready-state enforced</p><p>✓ Word-limit red-team available</p><p className={unresolved ? "warn" : ""}>{unresolved ? "!" : "✓"} Buyer checklist {unresolved ? "still open" : "cleared"}</p><p>✓ Final portal submit stays human</p></section><button className="continue-btn" onClick={onContinue}>Final checks <span>→</span></button></aside>
      </div>
    </div>
  );
}

function FileButton({ label, accept, onFile }: { label: string; accept: string; onFile: (file: File) => void }) {
  return <label className="file-action">{label}<input type="file" accept={accept} onChange={(event) => { const file = event.target.files?.[0]; if (file) onFile(file); event.currentTarget.value = ""; }} /></label>;
}

/**
 * The steps to take on the buyer's portal, in order.
 *
 * Tenderly does not submit. This is the handover: which file goes where, under
 * what name, in what order — the things bids actually fail on. Where the pack
 * states a rule it is quoted; where it states none the step says so rather than
 * inventing a convention.
 */
function SubmissionRunbook({ runbook, completed, total, onTick, busy }: {
  runbook: Runbook | null; completed: number; total: number;
  onTick: (stepId: string, done: boolean) => void; busy: boolean;
}) {
  if (!runbook) return null;
  return (
    <section className="panel runbook" data-testid="runbook">
      <div className="panel-heading">
        <div>
          <h3>Submission runbook</h3>
          <p>Tenderly does not submit on your behalf. These are the steps on the buyer's portal.</p>
        </div>
        <span className="manifest-status" data-testid="runbook-progress">{completed} of {total} done</span>
      </div>

      <dl className="runbook-facts">
        <div><dt>Channel</dt><dd>{runbook.channel}</dd></div>
        <div><dt>Deadline</dt><dd className="deadline">{runbook.deadline}</dd></div>
      </dl>

      {runbook.generic && (
        <p className="runbook-generic">The pack stated no submission formalities, so these are the general steps.</p>
      )}

      <ol className="runbook-steps">
        {runbook.steps.map((step) => (
          <li key={step.id} className={step.done ? "done" : ""} data-testid={`runbook-${step.id}`}>
            <label>
              <input type="checkbox" checked={step.done} disabled={busy} onChange={() => onTick(step.id, !step.done)} />
              <span>
                {step.text}
                {step.source && <small>Pack says: “{step.source}”</small>}
              </span>
            </label>
          </li>
        ))}
      </ol>
    </section>
  );
}

function Submit({ tender, onDownload, onReview, loading, blockers, runbook, runbookCompleted, runbookTotal, onTickRunbook, runbookBusy }: { tender: Tender; onDownload: () => void; onReview: () => void; loading: boolean; blockers: string[]; runbook: Runbook | null; runbookCompleted: number; runbookTotal: number; onTickRunbook: (stepId: string, done: boolean) => void; runbookBusy: boolean }) {
  const eligibilityReady = tender.eligibility ? tender.eligibility === "PASS" : tender.gates.every((gate) => gate.state === "pass");
  const requiredQuestions = tender.questions.filter((question) => question.required !== false);
  const responsesReady = requiredQuestions.length === 0 || requiredQuestions.every((question) => question.status === "ready" && question.answer.trim());
  const requiredChecklist = (tender.submissionChecklist ?? []).filter((item) => item.required);
  const checklistReady = requiredChecklist.every((item) => item.status === "READY");
  const checks: Array<[string, boolean, string]> = [
    ["Eligibility blockers resolved", eligibilityReady, eligibilityReady ? "Tenderly qualification is green" : "Resolve every mandatory gate before final pack"],
    ["Mandatory responses human-reviewed", responsesReady, responsesReady ? "Required response sections are marked ready" : "One or more response sections still need review"],
    ["Buyer submission checklist cleared", checklistReady, checklistReady ? "Required templates / declarations are confirmed" : "Confirm required buyer files in Assemble"],
    ["Deadline re-check", false, "Re-check the official eTenders page immediately before upload"],
  ];
  return (
    <div className="submit-page">
      <section className="submit-hero"><span className="lock-orb">✓</span><p className="eyebrow">HUMAN-CONTROLLED SUBMISSION</p><h2>Ready means actually ready.</h2><p>Tenderly can build the final ZIP, but it never presses the buyer portal’s final submit button for you. You keep the last check and submission control.</p></section>
      <SubmissionRunbook runbook={runbook} completed={runbookCompleted} total={runbookTotal} onTick={onTickRunbook} busy={runbookBusy} />
      <div className="submit-grid"><section className="panel final-checks"><h3>Final verification</h3>{checks.map(([label, ok, detail]) => <div key={label}><span className={ok ? "check-ok" : "check-wait"}>{ok ? "✓" : "!"}</span><p><strong>{label}</strong><small>{detail}</small></p>{label === "Deadline re-check" ? <a href={tender.sourceUrl} target="_blank" rel="noreferrer">Open ↗</a> : <button onClick={onReview}>{ok ? "View" : "Review"}</button>}</div>)}</section><aside className="panel submit-card"><p className="eyebrow">SUBMISSION</p><h3>{tender.deadline}</h3><p>Official deadline shown from the source notice. Re-check eTenders immediately before upload.</p><button className="continue-btn" onClick={onDownload} disabled={loading}>{loading ? "Checking pack…" : "⇩ Download final ZIP"}</button><a href={tender.sourceUrl} target="_blank" rel="noreferrer">Open eTenders submission page ↗</a><small>The API performs the authoritative blocker check when you request the final ZIP.</small>{blockers.length > 0 && <ul className="blocker-list" data-testid="blockers">{blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul>}</aside></div>
    </div>
  );
}

function CompanyView({ company, setCompany, onSave, vaultReadiness, onOpenEvidence, declarations, onSaveDeclarations, onAffirmDeclarations, busyDeclarations }: { company: CompanyProfile; setCompany: (company: CompanyProfile) => void; onSave: () => void; vaultReadiness: VaultCompleteness | null; onOpenEvidence: () => void; declarations: DeclarationState | null; onSaveDeclarations: (answers: DeclarationAnswer[]) => void; onAffirmDeclarations: () => void; busyDeclarations: boolean }) {
  const fields: { key: keyof CompanyProfile; label: string; hint: string; wide?: boolean }[] = [
    { key: "name", label: "Legal company name", hint: "Exact registered name" },
    { key: "registration", label: "Company registration no.", hint: "Used for declarations" },
    { key: "turnover", label: "Annual turnover", hint: "e.g. €1.2m · latest year" },
    { key: "employees", label: "Employees / delivery capacity", hint: "Permanent + committed associates" },
    { key: "services", label: "Services & capability", hint: "What you can credibly sell", wide: true },
    { key: "cpv", label: "Target CPV codes", hint: "Comma-separated CPVs", wide: true },
    { key: "certifications", label: "Certifications & standards", hint: "Company and relevant professional credentials", wide: true },
    { key: "insurance", label: "Insurance limits", hint: "PI, PL, EL and cyber where applicable", wide: true },
  ];
  const completeness = Math.round((fields.filter((field) => company[field.key].trim()).length / fields.length) * 100);
  return <div className="profile-page"><div className="section-intro"><div><p className="eyebrow">BIDDER PROFILE</p><h2>Teach Tenderly what you can prove.</h2><p>This profile drives tender matching and eligibility. Missing data produces “Review”, never a guessed pass.</p></div><button className="continue-btn" onClick={onSave}>Save profile</button></div><div className="profile-grid"><section className="panel profile-form"><div className="profile-completeness"><span><strong>{completeness}%</strong><small>profile completeness</small></span><i><b style={{ width: `${completeness}%` }} /></i><p>Add registration, turnover and insurance limits to strengthen automatic qualification.</p></div><div className="form-grid">{fields.map((field) => <label key={field.key} className={field.wide ? "wide" : ""}><span>{field.label}</span>{field.wide ? <textarea value={company[field.key]} onChange={(event) => setCompany({ ...company, [field.key]: event.target.value })} placeholder={field.hint} /> : <input value={company[field.key]} onChange={(event) => setCompany({ ...company, [field.key]: event.target.value })} placeholder={field.hint} />}</label>)}</div></section><aside className="profile-aside"><VaultMeter completeness={vaultReadiness} onOpenEvidence={onOpenEvidence} /><DeclarationsPanel state={declarations} onSave={onSaveDeclarations} onAffirm={onAffirmDeclarations} busy={busyDeclarations} /><section className="panel"><span className="aside-icon">◇</span><h3>Why this matters</h3><p>Tenderly compares explicit tender requirements with explicit bidder facts. The stronger this profile, the fewer false positives your feed contains.</p></section><section className="panel"><h3>Next best additions</h3><p>1. Upload audited accounts / turnover evidence</p><p>2. Add insurance certificates</p><p>3. Add 3–5 reference projects</p><p>4. Add reusable company policies</p></section></aside></div></div>;
}

/** File sizes as a person reads them, not as bytes. */
function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * How ready the company is to be asked for its paperwork.
 *
 * A kind counts only when it is present, in date and verified. The three ways
 * of falling short are listed separately, because "you have it but nobody
 * checked it" and "you never uploaded it" are different jobs.
 */
/**
 * The ESPD self-declarations, answered once and reused on every bid.
 *
 * Affirming is the moment a named person stands behind the whole set, so it is
 * refused while anything is unanswered or while a "yes" that needs explaining
 * has no explanation — "yes, but" without the "but" is worse than silence.
 */
function DeclarationsPanel({ state, onSave, onAffirm, busy }: {
  state: DeclarationState | null;
  onSave: (answers: DeclarationAnswer[]) => void;
  onAffirm: () => void;
  busy: boolean;
}) {
  const [draft, setDraft] = useState<DeclarationAnswer[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!state) return;
    const byId = new Map(state.answers.map((answer) => [answer.declarationId, answer]));
    setDraft(state.declarations.map((declaration) =>
      byId.get(declaration.id) ?? { declarationId: declaration.id, answer: null, notes: "" }));
  }, [state]);

  if (!state) return null;

  const update = (id: string, patch: Partial<DeclarationAnswer>) =>
    setDraft((current) => current.map((answer) => (answer.declarationId === id ? { ...answer, ...patch } : answer)));

  const needsDetail = (id: string) => {
    const declaration = state.declarations.find((entry) => entry.id === id);
    const answer = draft.find((entry) => entry.declarationId === id);
    return Boolean(declaration && answer?.answer === declaration.answerRequiringDetail && !answer.notes.trim());
  };
  const blocked = draft.some((answer) => !answer.answer) || draft.some((answer) => needsDetail(answer.declarationId));

  return (
    <section className="panel declarations-panel" data-testid="declarations">
      <div className="panel-heading">
        <div><h3>ESPD declarations</h3><p>Answer once, reuse on every bid. A buyer asks when these were last affirmed.</p></div>
        <button className="text-action" onClick={() => setOpen((value) => !value)}>{open ? "Hide" : "Open"}</button>
      </div>

      {state.affirmation && !state.needsReaffirmation && (
        <p className="declarations-affirmed" data-testid="affirmed">
          Affirmed by {state.affirmation.affirmedBy} on {new Date(state.affirmation.at).toLocaleDateString()}
        </p>
      )}
      {state.needsReaffirmation && (
        <p className="declarations-stale" data-testid="needs-reaffirmation">
          Declarations need re-affirmation
          {state.affirmation ? ` · last affirmed ${new Date(state.affirmation.at).toLocaleDateString()}` : " · never affirmed"}
        </p>
      )}

      {open && (
        <>
          {(["III", "IV"] as const).map((part) => (
            <div className="declaration-part" key={part}>
              <p className="eyebrow">{part === "III" ? "PART III · GROUNDS FOR EXCLUSION" : "PART IV · SELECTION CRITERIA"}</p>
              {state.declarations.filter((declaration) => declaration.part === part).map((declaration) => {
                const answer = draft.find((entry) => entry.declarationId === declaration.id);
                return (
                  <div className="declaration-row" key={declaration.id} data-testid={`declaration-${declaration.id}`}>
                    <p><strong>{declaration.heading}</strong><small>{declaration.statement}</small></p>
                    <div className="declaration-answer">
                      <label><input type="radio" checked={answer?.answer === "yes"} onChange={() => update(declaration.id, { answer: "yes" })} /> Yes</label>
                      <label><input type="radio" checked={answer?.answer === "no"} onChange={() => update(declaration.id, { answer: "no" })} /> No</label>
                    </div>
                    <input
                      value={answer?.notes ?? ""}
                      onChange={(event) => update(declaration.id, { notes: event.target.value })}
                      placeholder={needsDetail(declaration.id) ? "Supporting details are required for this answer" : "Notes"}
                      className={needsDetail(declaration.id) ? "needs-detail" : ""}
                    />
                  </div>
                );
              })}
            </div>
          ))}
          <div className="declaration-actions">
            <button className="text-action" onClick={() => onSave(draft)} disabled={busy}>Save answers</button>
            <button className="quiet-btn" onClick={() => { onSave(draft); onAffirm(); }} disabled={busy || blocked}>Affirm</button>
          </div>
          {blocked && <p className="declaration-warning">Every declaration needs an answer, and a Yes on an exclusion ground needs supporting details.</p>}
        </>
      )}
    </section>
  );
}

function VaultMeter({ completeness, onOpenEvidence }: { completeness: VaultCompleteness | null; onOpenEvidence: () => void }) {
  if (!completeness) return null;
  const done = completeness.complete === completeness.total;
  const group = (title: string, items: string[], tone: string) => items.length > 0 && (
    <div className={`vault-group ${tone}`}><strong>{title}</strong><ul>{items.map((item) => <li key={item}>{item}</li>)}</ul></div>
  );
  return (
    <section className={`panel vault-meter ${done ? "complete" : ""}`} data-testid="vault-meter">
      <div className="panel-heading">
        <div><h3>Vault readiness</h3><p>The documents Irish public tenders routinely ask for.</p></div>
        <strong className="vault-count" data-testid="vault-count">{completeness.complete} of {completeness.total}</strong>
      </div>
      <i className="vault-bar"><b style={{ width: `${Math.round((completeness.complete / completeness.total) * 100)}%` }} /></i>
      {done
        ? <p className="vault-done">Every standard document is present, in date and verified.</p>
        : (
          <>
            {group("Expired", completeness.expired, "warn")}
            {group("Awaiting verification", completeness.awaitingVerification, "warn")}
            {group("Missing", completeness.missing, "missing")}
            <button className="quiet-btn" onClick={onOpenEvidence}>Open the vault</button>
          </>
        )}
    </section>
  );
}

function EvidenceView({ tab, setTab, evidence, people, onUploadEvidence, onUploadCv, onVerify, onDownload, loading }: { tab: "Evidence" | "CVs"; setTab: (tab: "Evidence" | "CVs") => void; evidence: EvidenceItem[]; people: PersonItem[]; onUploadEvidence: (file: File) => void; onUploadCv: (file: File) => void; onVerify: (id: string, verified: boolean) => void; onDownload: (item: EvidenceItem) => void; loading: string }) {
  return <div className="library-page"><div className="section-intro"><div><p className="eyebrow">REUSABLE BID LIBRARY</p><h2>Write from evidence, not memory.</h2><p>Approved case studies, methods and policies are the only reusable claims Tenderly gives its bid writer. CV facts are kept separately for role matching.</p></div>{tab === "Evidence" ? <FileButton label={loading === "evidence-upload" ? "Extracting…" : "＋ Upload evidence"} accept=".pdf,.docx,.xlsx,.xls,.pptx,.zip,.txt,.csv" onFile={onUploadEvidence} /> : <FileButton label={loading === "cv-upload" ? "Extracting…" : "＋ Upload CV"} accept=".pdf,.docx,.txt" onFile={onUploadCv} />}</div><div className="segmented"><button className={tab === "Evidence" ? "active" : ""} onClick={() => setTab("Evidence")}>Evidence library</button><button className={tab === "CVs" ? "active" : ""} onClick={() => setTab("CVs")}>CV library</button></div>{tab === "Evidence" ? <section className="panel evidence-table">{evidence.map((item) => <div key={item.id}><span className="file-orb">◇</span><p><strong>{item.name}</strong><small>{[item.kind, item.expiresOn ? `expires ${item.expiresOn}` : "", item.sizeBytes ? formatBytes(item.sizeBytes) : "", item.tags.length ? item.tags.join(" · ") : ""].filter(Boolean).join(" · ")}</small></p><span className={item.verified ? "verified" : "review-state"}>{item.verified ? "✓ Verified" : "! Review"}</span>{/* Text-only items from before files were kept have nothing to download. */}{item.filename && <button className="text-action" onClick={() => onDownload(item)}>Download</button>}<button onClick={() => onVerify(item.id, !item.verified)} disabled={loading === `evidence-${item.id}`}>{loading === `evidence-${item.id}` ? "Saving…" : item.verified ? "Unverify" : "Verify →"}</button></div>)}{!evidence.length && <div className="library-empty"><span className="file-orb">◇</span><p><strong>No evidence yet</strong><small>Upload case studies, policies, methods or certificates. Review them before marking verified.</small></p></div>}</section> : <div className="cv-grid">{people.map((person) => <article className="panel cv-card" key={person.id}><span className="cv-avatar">{person.name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "CV"}</span><h3>{person.name}</h3><p>{person.title || "Parsed CV"}</p><small>{person.cvText ? `${Math.min(person.cvText.length, 9999).toLocaleString()} characters extracted` : "CV text pending"}</small><div>{person.skills.length ? person.skills.slice(0, 4).map((skill) => <span key={skill}>{skill}</span>) : <span>Full CV available to role matching</span>}</div></article>)}<article className="panel gap-card"><span>＋</span><h3>Add another CV</h3><p>Upload the people you may propose. Re-run qualification and Tenderly will match explicit CV facts to tender roles.</p><FileButton label="Upload CV" accept=".pdf,.docx,.txt" onFile={onUploadCv} /></article></div>}</div>;
}

/**
 * One person, with the controls to correct or retire their record.
 *
 * Archiving is never a delete: a submitted bid named this person, and the
 * record of what the buyer received has to stay intact. An archived card says
 * so plainly rather than disappearing.
 */
function PersonCard({ person, onRename, onArchive, busy }: {
  person: PersonItem; onRename: (id: string, title: string) => void;
  onArchive: (person: PersonItem, archived: boolean) => void; busy: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(person.title);
  const archived = Boolean(person.archivedAt);

  return (
    <section className={archived ? "panel team-card archived" : "panel team-card"} data-testid={`person-${person.id}`}>
      <span className="cv-avatar">{person.name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "CV"}</span>
      <div>
        <h3>{person.name}{archived && <em className="archived-tag">Archived</em>}</h3>
        {editing
          ? <div className="person-edit"><input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Job title" /><button className="text-action" disabled={busy} onClick={() => { onRename(person.id, title); setEditing(false); }}>Save</button></div>
          : <p>{person.title || "Parsed CV profile"}</p>}
      </div>
      <strong>{archived ? "Not available to match" : "Available to match"}</strong>
      <small>{person.skills.length ? person.skills.join(" · ") : "Tenderly will match requirements against the full extracted CV text."}</small>
      <div className="person-actions">
        {!editing && <button className="text-action" onClick={() => { setTitle(person.title); setEditing(true); }}>Edit</button>}
        <button className="text-action" disabled={busy} onClick={() => onArchive(person, !archived)}>{archived ? "Reinstate" : "Archive"}</button>
      </div>
    </section>
  );
}

const factSectionTitles: Record<PersonFact["type"], string> = {
  certification: "Certifications",
  skill: "Skills",
  role: "Roles held",
  experience: "Experience",
};

/**
 * What Tenderly read out of a CV, for a person to check.
 *
 * Every record shows the line it came from, because the reviewer's job is to
 * compare the two. Nothing is confirmed until someone says so: a parsed claim
 * about a named individual is a suggestion, and it is their credibility in
 * front of a buyer.
 */
function CvRecords({ records, onConfirmAll, onCorrect, busy }: {
  records: PersonFact[];
  onConfirmAll: () => void;
  onCorrect: (factId: string, value: string) => void;
  busy: boolean;
}) {
  const [editing, setEditing] = useState("");
  const [draft, setDraft] = useState("");
  const unconfirmed = records.filter((record) => !record.confirmed).length;

  return (
    <section className="panel cv-records" data-testid="cv-records">
      <div className="panel-heading">
        <div><h3>Read from the CV</h3><p>Check each line against the quote beside it. Nothing is used for role matching until it is confirmed.</p></div>
        {unconfirmed > 0 && <button className="quiet-btn" onClick={onConfirmAll} disabled={busy}>Confirm all</button>}
      </div>

      {(Object.keys(factSectionTitles) as PersonFact["type"][]).map((type) => {
        const group = records.filter((record) => record.type === type);
        return (
          <div className="cv-record-group" key={type}>
            <p className="eyebrow">{factSectionTitles[type].toUpperCase()}</p>
            {group.length === 0
              ? <p className="cv-record-empty">None found in CV</p>
              : group.map((record) => (
                <div className="cv-record" key={record.id} data-testid={`cv-record-${record.id}`}>
                  {editing === record.id
                    ? <div className="person-edit"><input value={draft} onChange={(event) => setDraft(event.target.value)} /><button className="text-action" disabled={busy} onClick={() => { onCorrect(record.id, draft); setEditing(""); }}>Save</button></div>
                    : <p><strong>{record.value}</strong><small>{[record.detail, record.period].filter(Boolean).join(" · ")}</small></p>}
                  <blockquote>“{record.quote}”</blockquote>
                  <div className="cv-record-foot">
                    <span className={record.confirmed ? "verified" : "review-state"}>{record.confirmed ? "✓ Confirmed" : "Unconfirmed"}</span>
                    <button className="text-action" onClick={() => { setDraft(record.value); setEditing(record.id); }}>Correct</button>
                  </div>
                </div>
              ))}
          </div>
        );
      })}
    </section>
  );
}

/**
 * The team as a grid: who can we put on this, and where are we one person deep.
 *
 * An empty matrix says so rather than drawing a grid with no columns — a blank
 * table reads as a bug, not as "nobody has confirmed a skill yet".
 */
function SkillsMatrix({ matrix, filter, onFilter, onExport, onOpenTeam, busy }: {
  matrix: SkillMatrix | null; filter: string;
  onFilter: (skill: string) => void; onExport: () => void; onOpenTeam: () => void; busy: boolean;
}) {
  if (!matrix) return null;
  if (matrix.note) {
    return (
      <section className="panel skills-matrix" data-testid="skills-matrix">
        <div className="panel-heading"><div><h3>Skills matrix</h3><p>Who can we put on this, and where is the team one person deep.</p></div></div>
        <p className="skills-empty" data-testid="skills-empty">{matrix.note} — <button className="text-action" onClick={onOpenTeam}>upload a CV and confirm its skills</button></p>
      </section>
    );
  }
  return (
    <section className="panel skills-matrix" data-testid="skills-matrix">
      <div className="panel-heading">
        <div><h3>Skills matrix</h3><p>Confirmed skills only. A column with one holder is a single point of dependency.</p></div>
        <button className="text-action" onClick={onExport} disabled={busy}>Export CSV</button>
      </div>
      <div className="skills-filter">
        <label>Filter by skill
          <select value={filter} onChange={(event) => onFilter(event.target.value)}>
            <option value="">All skills</option>
            {matrix.columns.map((column) => <option key={column.skill} value={column.skill}>{column.skill}</option>)}
          </select>
        </label>
      </div>
      <div className="skills-scroll">
        <table>
          <thead>
            <tr>
              <th>Person</th>
              {matrix.columns.map((column) => (
                <th key={column.skill} className={column.singlePointOfDependency ? "single-point" : ""}>
                  {column.skill}
                  {column.singlePointOfDependency && <em title="Single point of dependency">1</em>}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {matrix.people.map((row) => (
              <tr key={row.id}>
                <td>{row.name}</td>
                {matrix.columns.map((column) => (
                  <td key={column.skill} className="skill-cell">{row.skills.includes(column.skill) ? "●" : ""}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {matrix.columns.some((column) => column.singlePointOfDependency) && (
        <p className="skills-warning">Single point of dependency: {matrix.columns.filter((column) => column.singlePointOfDependency).map((column) => column.skill).join(", ")}</p>
      )}
    </section>
  );
}

function TeamView({ people, onUploadCv, onRename, onArchive, busyPersonId, loading, records, selectedPersonId, onSelectPerson, onConfirmAll, onCorrect, busyRecords, matrix, skillFilter, onSkillFilter, onExportMatrix }: { people: PersonItem[]; onUploadCv: (file: File) => void; onRename: (id: string, title: string) => void; onArchive: (person: PersonItem, archived: boolean) => void; busyPersonId: string; loading: boolean; records: PersonFact[]; selectedPersonId: string; onSelectPerson: (id: string) => void; onConfirmAll: () => void; onCorrect: (factId: string, value: string) => void; busyRecords: boolean; matrix: SkillMatrix | null; skillFilter: string; onSkillFilter: (skill: string) => void; onExportMatrix: () => void }) {
  return <div className="library-page"><div className="section-intro"><div><p className="eyebrow">TEAM & PARTNERS</p><h2>Know your bid shape before you write.</h2><p>Tenderly maps required roles to CV evidence and only flags a tie-up when a concrete capability, capacity or credential gap remains.</p></div><FileButton label={loading ? "Extracting…" : "＋ Add person / CV"} accept=".pdf,.docx,.txt" onFile={onUploadCv} /></div><div className="team-grid">{people.map((person) => <PersonCard key={person.id} person={person} onRename={onRename} onArchive={onArchive} busy={busyPersonId === person.id} />)}<section className="panel gap-card"><span>＋</span><h3>Build your partner bench</h3><p>Add trusted associates or partner CVs here. A tender analysis will identify exactly which required role or credential still lacks evidence.</p><FileButton label="Add partner CV" accept=".pdf,.docx,.txt" onFile={onUploadCv} /></section></div><SkillsMatrix matrix={matrix} filter={skillFilter} onFilter={onSkillFilter} onExport={onExportMatrix} onOpenTeam={() => undefined} busy={busyRecords} />{people.length > 0 && <div className="cv-review"><div className="cv-review-picker"><label>Review CV records for<select value={selectedPersonId} onChange={(event) => onSelectPerson(event.target.value)}><option value="">Choose a person</option>{people.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}</select></label></div>{selectedPersonId && <CvRecords records={records} onConfirmAll={onConfirmAll} onCorrect={onCorrect} busy={busyRecords} />}</div>}</div>;
}

/**
 * What this account has spent on model calls this month.
 *
 * The figures are the metered totals, not an estimate: every model call writes
 * a row, and this reads them back. Only this account's rows are ever counted.
 */
function AiUsagePanel({ usage }: { usage: UsageTotals | null }) {
  if (!usage) return null;
  const label: Record<string, string> = { analysis: "Tender analyses", draft: "Answer drafts", critique: "Critiques" };
  return (
    <section className="panel settings-list" data-testid="ai-usage">
      <div><span><strong>AI usage this month</strong><small>{usage.month} · what your account has used. Tokens are the unit AI is billed in.</small></span></div>
      <div className="usage-totals">
        <span><strong>{usage.actions}</strong><small>AI actions</small></span>
        <span><strong>{usage.inputTokens.toLocaleString()}</strong><small>input tokens</small></span>
        <span><strong>{usage.outputTokens.toLocaleString()}</strong><small>output tokens</small></span>
      </div>
      {usage.byKind.length > 0 && (
        <ul className="usage-breakdown">
          {usage.byKind.map((row) => (
            <li key={row.kind}><strong>{label[row.kind] ?? row.kind}</strong><small>{row.actions} · {(row.inputTokens + row.outputTokens).toLocaleString()} tokens</small></li>
          ))}
        </ul>
      )}
      {usage.actions === 0 && <p className="usage-empty">No AI actions recorded this month.</p>}
    </section>
  );
}

const auditLabels: Record<string, string> = {
  "evidence.verified": "Evidence verified",
  "evidence.unverified": "Evidence verification withdrawn",
  "answer.marked_ready": "Answer marked ready",
  "attestation.recorded": "Attestation recorded",
  "pack.final.downloaded": "Final pack downloaded",
  "pack.draft.downloaded": "Draft pack downloaded",
  "document.uploaded": "Document uploaded",
  "no_ai_mode.enabled": "No-AI mode enabled",
  "no_ai_mode.disabled": "No-AI mode disabled",
  "ai_policy.acknowledged": "AI use policy acknowledged",
};

/**
 * A read-only view of the actions that change what eventually reaches a buyer.
 *
 * Filterable by action and by how far back to look, which is what a diligence
 * question actually asks. Nothing here can be edited or removed: the log is
 * append-only in the database, not merely read-only in this view.
 */
function AuditLogPanel({ entries, action, days, onFilter, loading }: {
  entries: AuditEntry[]; action: string; days: number;
  onFilter: (next: { action: string; days: number }) => void; loading: boolean;
}) {
  return (
    <section className="panel settings-list" data-testid="audit-log">
      <div><span><strong>Audit log</strong><small>Who changed what, and when. Entries record the action and the item — never file contents.</small></span></div>
      <div className="audit-filters">
        <label>Action
          <select value={action} onChange={(event) => onFilter({ action: event.target.value, days })}>
            <option value="">All actions</option>
            {Object.entries(auditLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label>Period
          <select value={days} onChange={(event) => onFilter({ action, days: Number(event.target.value) })}>
            <option value={7}>Last 7 days</option>
            <option value={30}>Last 30 days</option>
            <option value={90}>Last 90 days</option>
            <option value={365}>Last year</option>
          </select>
        </label>
      </div>
      {loading
        ? <p className="usage-empty">Loading…</p>
        : entries.length === 0
          ? <p className="usage-empty">No entries for this filter.</p>
          : (
            <ul className="audit-list">
              {entries.map((entry) => (
                <li key={entry.id}>
                  <strong>{auditLabels[entry.action] ?? entry.action}</strong>
                  <span>{entry.subjectLabel || entry.subjectId}</span>
                  <small>{entry.actor} · {new Date(entry.createdAt).toLocaleString()}</small>
                </li>
              ))}
            </ul>
          )}
    </section>
  );
}

function SettingsView({ isDemo, sectors, preferences, onSave, loading, usage, audit }: { isDemo: boolean; sectors: SectorPreset[]; preferences: DiscoveryPreferences; onSave: (preferences: DiscoveryPreferences) => void; loading: string; usage: UsageTotals | null; audit: { entries: AuditEntry[]; action: string; days: number; onFilter: (next: { action: string; days: number }) => void; loading: boolean } }) {
  const [draft, setDraft] = useState<DiscoveryPreferences>(preferences);
  const [keywordText, setKeywordText] = useState(preferences.keywords.join(", "));
  const [cpvText, setCpvText] = useState(preferences.cpvCodes.join(", "));
  const [showAdvanced, setShowAdvanced] = useState(preferences.cpvCodes.length > 0);
  const [error, setError] = useState("");

  useEffect(() => {
    setDraft(preferences);
    setKeywordText(preferences.keywords.join(", "));
    setCpvText(preferences.cpvCodes.join(", "));
  }, [preferences]);

  const toggleSector = (slug: string) => setDraft((current) => ({
    ...current,
    sectors: current.sectors.includes(slug) ? current.sectors.filter((item) => item !== slug) : [...current.sectors, slug],
  }));

  const coveredCodes = sectors.filter((preset) => draft.sectors.includes(preset.slug)).flatMap((preset) => preset.cpvCodes);

  function save() {
    const list = (value: string) => value.split(",").map((item) => item.trim()).filter(Boolean);
    const codes = list(cpvText);
    const badCode = codes.find((code) => !/^[0-9]{8}$/.test(code));
    if (badCode) { setError(`A CPV code is 8 digits — "${badCode}" is not`); return; }
    if (draft.valueMin !== null && draft.valueMax !== null && draft.valueMax <= draft.valueMin) {
      setError("Upper value must be greater than lower value"); return;
    }
    setError("");
    onSave({ ...draft, keywords: list(keywordText), cpvCodes: codes });
  }

  const numberOrNull = (value: string) => (value.trim() === "" ? null : Number(value.replace(/[^0-9]/g, "")));

  return <div className="settings-page">
    <div className="section-intro"><div><p className="eyebrow">SETTINGS</p><h2>What should Tenderly watch for?</h2><p>Pick the kind of work you bid for. Tenderly turns that into the CPV codes and keywords behind the scenes — you never have to go code-hunting on eTenders.</p></div></div>

    <AiUsagePanel usage={usage} />

    <AuditLogPanel entries={audit.entries} action={audit.action} days={audit.days} onFilter={audit.onFilter} loading={audit.loading} />

    <section className="panel settings-list" data-testid="discovery-preferences">
      <div><span><strong>Sectors you bid in</strong><small>Tick what applies. Discover shows only opportunities matching these.</small></span></div>
      <div className="sector-grid">
        {sectors.map((preset) => (
          <label key={preset.slug} className={draft.sectors.includes(preset.slug) ? "sector-card selected" : "sector-card"} data-testid={`sector-${preset.slug}`}>
            <input type="checkbox" checked={draft.sectors.includes(preset.slug)} onChange={() => toggleSector(preset.slug)} />
            <span><strong>{preset.label}</strong><small>{preset.description}</small></span>
          </label>
        ))}
        {sectors.length === 0 && <p className="muted">Sector list unavailable — connect the API to choose sectors.</p>}
      </div>

      <div><span><strong>Extra keywords</strong><small>Anything the sectors miss, comma separated. Example: procurement portal, GIS</small></span>
        <input value={keywordText} onChange={(event) => setKeywordText(event.target.value)} placeholder="e.g. case management, GIS" /></div>

      <div><span><strong>Contract value range (EUR)</strong><small>Leave blank for no limit. Opportunities that do not state a value are always shown.</small></span>
        <span className="value-band">
          <input inputMode="numeric" aria-label="Minimum value" value={draft.valueMin ?? ""} onChange={(event) => setDraft({ ...draft, valueMin: numberOrNull(event.target.value) })} placeholder="from" />
          <input inputMode="numeric" aria-label="Maximum value" value={draft.valueMax ?? ""} onChange={(event) => setDraft({ ...draft, valueMax: numberOrNull(event.target.value) })} placeholder="to" />
        </span></div>

      <div><span><strong>CPV codes these sectors cover</strong><small>{coveredCodes.length ? `${coveredCodes.length} codes applied once a tender is imported` : "Pick a sector to see its codes"}</small></span>
        <span className="cpv-chips" data-testid="covered-cpv">{coveredCodes.map((entry) => <i key={entry.code} title={entry.label}>{entry.code}</i>)}</span></div>

      <div><span><strong>Advanced</strong><small>Add CPV codes the sectors do not cover. Most people never need this.</small></span>
        <button type="button" className="quiet-btn" onClick={() => setShowAdvanced((value) => !value)}>{showAdvanced ? "Hide" : "Add CPV codes"}</button></div>
      {showAdvanced && <div><span><strong>Your own CPV codes</strong><small>8 digits each, comma separated</small></span>
        <input aria-label="Additional CPV codes" value={cpvText} onChange={(event) => setCpvText(event.target.value)} placeholder="e.g. 79212000" /></div>}

      {error && <p className="auth-error" data-testid="preferences-error">{error}</p>}
      <div><span /><button className="continue-btn" onClick={save} disabled={loading === "preferences"}>{loading === "preferences" ? "Saving…" : "Save preferences"}</button></div>
    </section>

    <section className="panel settings-list"><div><span><strong>eTenders watcher</strong><small>Daily Render cron when enabled, plus manual Refresh live at any time</small></span><label className="switch disabled"><input type="checkbox" defaultChecked disabled /><i /></label></div><div><span><strong>Conservative eligibility</strong><small>Missing proof is Review, not Pass. Conflicting source evidence blocks final readiness.</small></span><label className="switch disabled"><input type="checkbox" defaultChecked disabled /><i /></label></div><div><span><strong>Automatic final submission</strong><small>Disabled by design — a human always performs the final portal submit action.</small></span><label className="switch disabled"><input type="checkbox" disabled /><i /></label></div><div><span><strong>Connection</strong><small>{isDemo ? "Demo mode · set VITE_API_URL in Netlify to connect the Render API" : "Render API connected"}</small></span><span className={isDemo ? "connection demo" : "connection live"}>● {isDemo ? "Demo" : "Live"}</span></div></section>
  </div>;
}

function ImportModal({ value, setValue, onClose, onSubmit, loading }: { value: string; setValue: (value: string) => void; onClose: () => void; onSubmit: (event: FormEvent) => void; loading: boolean }) {
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) onClose(); }}><form className="import-modal" onSubmit={onSubmit}><button type="button" className="modal-close" onClick={onClose}>×</button><span className="modal-icon">↗</span><p className="eyebrow">IMPORT A TENDER</p><h2>Paste the eTenders link.</h2><p>Tenderly fetches the public notice and documents it can access. If a document requires your eTenders login, you’ll be asked to upload that file instead — never your portal password.</p><label><span>eTenders URL</span><input autoFocus type="url" value={value} onChange={(event) => setValue(event.target.value)} placeholder="https://www.etenders.gov.ie/epps/…" required /></label><div className="modal-note"><span>◇</span><p><strong>Source-safe import</strong><small>Only etenders.gov.ie and official TED links are fetched. Decisive facts retain their source reference.</small></p></div><button className="continue-btn" type="submit" disabled={loading}>{loading ? "Fetching tender…" : "Import & analyse →"}</button></form></div>;
}

function AuthScreen({ onToken }: { onToken: (token: string) => void }) {
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [company, setCompany] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const data = mode === "login"
        ? await apiClient.signIn(email, password)
        : await apiClient.register(email, password, company);
      onToken(data.token);
    } catch (err) { setError(err instanceof Error ? err.message : "Sign in failed"); } finally { setBusy(false); }
  }
  return <div className="auth-screen"><div className="auth-brand"><Logo /><p>Bid intelligence that knows when to say “not enough evidence”.</p></div><form className="auth-card" onSubmit={submit}><p className="eyebrow">{mode === "login" ? "WELCOME BACK" : "CREATE YOUR WORKSPACE"}</p><h1>{mode === "login" ? "Sign in to Tenderly" : "Start qualifying bids"}</h1>{mode === "register" && <label><span>Company name</span><input value={company} onChange={(event) => setCompany(event.target.value)} required /></label>}<label><span>Email</span><input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required /></label><label><span>Password</span><input type="password" minLength={10} value={password} onChange={(event) => setPassword(event.target.value)} required /></label>{error && <p className="auth-error">{error}</p>}<button className="continue-btn" disabled={busy}>{busy ? "Please wait…" : mode === "login" ? "Sign in →" : "Create workspace →"}</button><button type="button" className="auth-switch" onClick={() => setMode(mode === "login" ? "register" : "login")}>{mode === "login" ? "New to Tenderly? Create a workspace" : "Already have an account? Sign in"}</button></form></div>;
}
