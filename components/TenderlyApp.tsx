"use client";

import { FormEvent, useEffect, useMemo, useState } from "react";
import { ApiError, createApiClient } from "../web/src/api/client";
import "./tenderly.css";

import type {
  BidQuestion,
  CompanyProfile,
  Decision,
  EvidenceItem,
  Gate,
  GateState,
  NotificationItem,
  PersonItem,
  SubmissionItem,
  Tender,
} from "@tenderly/shared";

// Screen navigation is local to the app, not part of the wire contract.
type AppSection = "Discover" | "My bids" | "Evidence" | "Team" | "Company" | "Settings";
type BidStage = "Qualify" | "Synopsis" | "Respond" | "Assemble" | "Submit";

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
  const [section, setSection] = useState<AppSection>("Discover");
  const [stage, setStage] = useState<BidStage>("Qualify");
  const [selectedId, setSelectedId] = useState(API_BASE ? "" : demoTenders[0].id);
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

  const isDemo = !API_BASE;
  currentToken = token;
  const selected = tenders.find((item) => item.id === selectedId) ?? tenders[0];
  const companyInitials = company.name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "CO";
  const profileValues = [company.name, company.registration, company.turnover, company.employees, company.services, company.cpv, company.certifications, company.insurance];
  const profileCompleteness = Math.round((profileValues.filter((value) => value.trim()).length / profileValues.length) * 100);

  useEffect(() => {
    if (!API_BASE) return;
    const saved = window.localStorage.getItem("tenderly_token") ?? "";
    setToken(saved);
    setAuthReady(true);
  }, []);

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
        const [bidsData, companyData, evidenceData, peopleData, notificationsData] = await Promise.all([
          apiClient.listTenders(), apiClient.getCompany(), apiClient.listEvidence(), apiClient.listPeople(), apiClient.listNotifications(),
        ]);
        if (!active) return;
        setTenders(bidsData.items ?? []);
        setCompany((current) => ({ ...current, ...(companyData.company ?? {}) }));
        setEvidence(evidenceData.items ?? []);
        setPeople(peopleData.items ?? []);
        setNotifications(notificationsData.items ?? []);
        if (bidsData.items?.[0]) setSelectedId(bidsData.items[0].id);

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

  async function refreshDiscovery() {
    if (isDemo) {
      setToast("Demo feed refreshed · connect the Render API for live eTenders data");
      return;
    }
    try {
      setLoading("feed");
      const data = await apiClient.discover(query);
      setDiscoveries(data.items);
      setToast(`${data.items.length} opportunities checked`);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Could not refresh feed");
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
      setStage("Qualify");
      setSection("My bids");
      return;
    }
    const opportunity = discoveries.find((item) => item.id === id);
    if (!opportunity) return;
    try {
      setLoading(`import-${id}`);
      const data = await apiClient.importTender(opportunity.sourceUrl);
      setTenders((items) => [data.tender, ...items.filter((item) => item.id !== data.tender.id)]);
      setSelectedId(data.tender.id);
      setStage("Qualify");
      setSection("My bids");
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
            />
          )}
          {section === "My bids" && selected && (
            <BidWorkspace
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
          )}
          {section === "My bids" && !selected && <div className="no-questions panel"><span>▱</span><h2>No active bids yet</h2><p>Open a recommended opportunity or paste an eTenders link. Tenderly will import it into this workspace before qualification begins.</p><button className="continue-btn" onClick={() => setSection("Discover")}>Discover opportunities →</button></div>}
          {section === "Company" && <CompanyView company={company} setCompany={setCompany} onSave={async () => {
            if (isDemo) { setToast("Company profile saved for this demo session"); return; }
            try { await apiClient.saveCompany(company); setToast("Company profile saved"); } catch (error) { setToast(error instanceof Error ? error.message : "Could not save profile"); }
          }} />}
          {section === "Evidence" && <EvidenceView tab={evidenceTab} setTab={setEvidenceTab} evidence={evidence} people={people} onUploadEvidence={uploadEvidenceFile} onUploadCv={uploadCvFile} onVerify={setEvidenceVerification} loading={loading} />}
          {section === "Team" && <TeamView people={people} onUploadCv={uploadCvFile} loading={loading === "cv-upload"} />}
          {section === "Settings" && <SettingsView isDemo={isDemo} />}
        </div>
      </main>

      {showImport && <ImportModal value={importUrl} setValue={setImportUrl} onClose={() => setShowImport(false)} onSubmit={importTender} loading={loading === "import"} />}
      {toast && <div className="toast"><span>✓</span>{toast}</div>}
    </div>
  );
}

function Discover({ tenders, query, setQuery, refreshDiscovery, loading, openBid, setShowImport }: {
  tenders: Tender[]; query: string; setQuery: (value: string) => void; refreshDiscovery: () => void; loading: boolean; openBid: (id: string) => void; setShowImport: (value: boolean) => void;
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

      <div className="tender-list">
        {tenders.map((tender) => (
          <article className="tender-card" key={tender.id} onClick={() => openBid(tender.id)}>
            <div className={`score-ring ${scoreTone(tender.match)}`}><strong>{tender.match}</strong><small>match</small></div>
            <div className="tender-main">
              <div className="tender-meta"><span>{tender.category}</span><i>•</i><span>{tender.procedure}</span><i>•</i><span>Published {tender.published}</span></div>
              <h3>{tender.title}</h3>
              <p className="authority">{tender.authority}</p>
              <div className="tender-facts"><span><small>Deadline</small><strong>{tender.deadline}</strong></span><span><small>Value</small><strong>{tender.value}</strong></span><span><small>Access</small><strong>{tender.access}</strong></span></div>
            </div>
            <div className="tender-decision">
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

function BidWorkspace({ tender, stage, setStage, runAnalysis, loading, draftAnswer, markAnswerReady, uploadTenderFile, downloadAsset, markChecklistReady, updateQuestion, blockers }: {
  tender: Tender; stage: BidStage; setStage: (stage: BidStage) => void; runAnalysis: () => void; loading: string; draftAnswer: (id: string) => void; markAnswerReady: (id: string) => void; uploadTenderFile: (file: File, role: "source" | "submission") => void; downloadAsset: (kind: "deck" | "pack", draft?: boolean) => void; markChecklistReady: (id: string) => void; updateQuestion: (id: string, answer: string) => void; blockers: string[];
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
            <section className="panel snapshot-card"><p className="eyebrow">AT A GLANCE</p><h3>Bid snapshot</h3><dl><div><dt>Procedure</dt><dd>{tender.procedure}</dd></div><div><dt>Competition</dt><dd>{tender.framework}</dd></div><div><dt>Access</dt><dd>{tender.access}</dd></div><div><dt>Est. value</dt><dd>{tender.value}</dd></div><div><dt>Deadline</dt><dd className="deadline">{tender.deadline}</dd></div></dl></section>
            <section className="panel attention-card"><span>!</span><div><strong>{reviewed ? `${reviewed} item${reviewed > 1 ? "s" : ""} need your input` : "No eligibility blockers"}</strong><p>{reviewed ? "Resolve review gates before changing this bid to final-ready." : "You can move into response drafting."}</p></div></section>
            {!!tender.roles?.length && <section className="panel role-match-card"><div className="role-match-head"><strong>Required people / CVs</strong><span>{tender.roles.length} role{tender.roles.length > 1 ? "s" : ""}</span></div>{tender.roles.slice(0, 4).map((role) => <div className="role-match-row" key={`${role.role}-${role.quantity}`}><div><strong>{role.quantity > 1 ? `${role.quantity}× ` : ""}{role.role}</strong><small>{role.bidderMatch || "No evidenced match"}</small></div><GatePill state={role.status === "PASS" ? "pass" : role.status === "FAIL" ? "fail" : "review"} /><p>{role.action || role.qualifications || role.experience}</p></div>)}</section>}
            <button className="continue-btn" onClick={() => setStage("Synopsis")}>Preview synopsis <span>→</span></button>
            <button className="quiet-btn" onClick={() => setStage("Respond")}>Let’s go — start response</button>
          </aside>
        </div>
      )}

      {stage === "Synopsis" && <Synopsis tender={tender} onDownload={() => downloadAsset("deck")} onContinue={() => setStage("Respond")} loading={loading === "deck"} />}
      {stage === "Respond" && <Respond tender={tender} draftAnswer={draftAnswer} markAnswerReady={markAnswerReady} uploadTenderFile={uploadTenderFile} loading={loading} updateQuestion={updateQuestion} onContinue={() => setStage("Assemble")} />}
      {stage === "Assemble" && <Assemble tender={tender} blockers={blockers} onDraft={() => downloadAsset("pack", true)} uploadTenderFile={uploadTenderFile} onMarkReady={markChecklistReady} onContinue={() => setStage("Submit")} loading={loading} />}
      {stage === "Submit" && <Submit tender={tender} blockers={blockers} onDownload={() => downloadAsset("pack", false)} onReview={() => setStage("Assemble")} loading={loading === "pack"} />}
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

function Respond({ tender, draftAnswer, markAnswerReady, uploadTenderFile, loading, updateQuestion, onContinue }: { tender: Tender; draftAnswer: (id: string) => void; markAnswerReady: (id: string) => void; uploadTenderFile: (file: File, role: "source" | "submission") => void; loading: string; updateQuestion: (id: string, answer: string) => void; onContinue: () => void }) {
  const [activeId, setActiveId] = useState(tender.questions[0]?.id ?? "");
  const active = tender.questions.find((question) => question.id === activeId) ?? tender.questions[0];
  if (!active) return <div className="no-questions panel"><span>◇</span><h2>Import the full tender pack first</h2><p>The notice gives Tenderly the opportunity metadata. The RFT / RFQ documents are needed to extract scored questions, word limits, mandatory roles and response templates.</p><FileButton label={loading === "upload" ? "Uploading…" : "Upload tender documents"} accept=".pdf,.docx,.xlsx,.xls,.pptx,.zip,.txt,.xml" onFile={(file) => uploadTenderFile(file, "source")} /></div>;
  return (
    <div className="response-layout">
      <aside className="question-list">
        <div><p className="eyebrow">RESPONSE PLAN</p><h3>{tender.questions.length} scored sections</h3><small>80% of quality marks mapped</small></div>
        {tender.questions.map((question, index) => <button key={question.id} className={active.id === question.id ? "active" : ""} onClick={() => setActiveId(question.id)}><span className="q-index">{String(index + 1).padStart(2, '0')}</span><span><strong>{question.title}</strong><small>{question.weight}% · max {question.maxWords} words</small></span><i className={`q-state ${question.status}`} /></button>)}
        <div className="response-key"><p><i className="q-state ready" /> Ready</p><p><i className="q-state draft" /> Draft</p><p><i className="q-state needs-input" /> Needs input</p></div>
      </aside>
      <section className="answer-editor">
        <div className="answer-head"><div><p className="eyebrow">SCORED QUESTION · {active.weight}%</p><h2>{active.title}</h2><p>{active.prompt}</p></div><div className="mark-badge"><strong>{active.weight}</strong><small>marks</small></div></div>
        <div className="answer-brief"><div><span>✦</span><p><strong>Tenderly writing brief</strong><small>Answer the question directly, lead with the outcome, evidence every material claim, and reserve ~10% of words for measurable controls and assurance.</small></p></div><button>View scoring logic</button></div>
        <div className="editor-toolbar"><button><b>B</b></button><button><i>I</i></button><button>≡</button><button>• list</button><span /><button>Insert evidence ⌄</button></div>
        <textarea value={active.answer} onChange={(event) => updateQuestion(active.id, event.target.value)} placeholder="Draft your response here, or ask Tenderly to build a first draft from verified evidence…" />
        <div className="editor-foot"><span>{active.answer.trim() ? active.answer.trim().split(/\s+/).length : 0} / {active.maxWords || "—"} words</span><div>{active.status === "ready" ? <button className="ready-button" disabled>✓ Reviewed & ready</button> : <button className="quiet-btn" onClick={() => markAnswerReady(active.id)} disabled={loading === `ready-${active.id}`}>{loading === `ready-${active.id}` ? "Saving…" : "Mark reviewed & ready"}</button>}<button className="ai-draft" onClick={() => draftAnswer(active.id)} disabled={loading === active.id}>{loading === active.id ? "Drafting…" : "✦ Draft from evidence"}</button></div></div>
        <section className="evidence-strip"><div className="evidence-title"><span>◇</span><p><strong>Evidence Tenderly will use</strong><small>Only approved library facts are passed into the draft.</small></p></div>{active.evidence.map((item) => <span className={item.toLowerCase().includes("needed") ? "missing" : ""} key={item}>{item.toLowerCase().includes("needed") ? "!" : "✓"} {item}</span>)}<button>＋ Attach evidence</button></section>
        <div className="response-next"><span><strong>Response readiness</strong><small>{tender.questions.filter((q) => q.status === "ready").length} of {tender.questions.length} sections ready</small></span><button className="continue-btn" onClick={onContinue}>Assemble pack <span>→</span></button></div>
      </section>
    </div>
  );
}

function Assemble({ tender, onDraft, uploadTenderFile, onMarkReady, onContinue, loading, blockers }: { tender: Tender; onDraft: () => void; uploadTenderFile: (file: File, role: "source" | "submission") => void; onMarkReady: (id: string) => void; onContinue: () => void; loading: string; blockers: string[] }) {
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
        <aside className="assembly-aside"><section className="panel pack-score"><p className="eyebrow">PACK READINESS</p><div className="large-ring"><strong>{readiness}</strong><small>%</small></div><h3>{unresolved ? `${unresolved} thing${unresolved > 1 ? "s" : ""} left` : "Automated gates clear"}</h3><p>{unresolved ? "Resolve each required item, upload completed buyer files, then explicitly confirm it ready." : "Build the final checks view; human submission control still remains."}</p></section><section className="panel integrity-card"><strong>Submission guardrails</strong><p>✓ Eligibility checked before final pack</p><p>✓ Answer ready-state enforced</p><p>✓ Word-limit red-team available</p><p className={unresolved ? "warn" : ""}>{unresolved ? "!" : "✓"} Buyer checklist {unresolved ? "still open" : "cleared"}</p><p>✓ Final portal submit stays human</p></section><button className="continue-btn" onClick={onContinue}>Final checks <span>→</span></button></aside>
      </div>
    </div>
  );
}

function FileButton({ label, accept, onFile }: { label: string; accept: string; onFile: (file: File) => void }) {
  return <label className="file-action">{label}<input type="file" accept={accept} onChange={(event) => { const file = event.target.files?.[0]; if (file) onFile(file); event.currentTarget.value = ""; }} /></label>;
}

function Submit({ tender, onDownload, onReview, loading, blockers }: { tender: Tender; onDownload: () => void; onReview: () => void; loading: boolean; blockers: string[] }) {
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
      <div className="submit-grid"><section className="panel final-checks"><h3>Final verification</h3>{checks.map(([label, ok, detail]) => <div key={label}><span className={ok ? "check-ok" : "check-wait"}>{ok ? "✓" : "!"}</span><p><strong>{label}</strong><small>{detail}</small></p>{label === "Deadline re-check" ? <a href={tender.sourceUrl} target="_blank" rel="noreferrer">Open ↗</a> : <button onClick={onReview}>{ok ? "View" : "Review"}</button>}</div>)}</section><aside className="panel submit-card"><p className="eyebrow">SUBMISSION</p><h3>{tender.deadline}</h3><p>Official deadline shown from the source notice. Re-check eTenders immediately before upload.</p><button className="continue-btn" onClick={onDownload} disabled={loading}>{loading ? "Checking pack…" : "⇩ Download final ZIP"}</button><a href={tender.sourceUrl} target="_blank" rel="noreferrer">Open eTenders submission page ↗</a><small>The API performs the authoritative blocker check when you request the final ZIP.</small>{blockers.length > 0 && <ul className="blocker-list" data-testid="blockers">{blockers.map((blocker) => <li key={blocker}>{blocker}</li>)}</ul>}</aside></div>
    </div>
  );
}

function CompanyView({ company, setCompany, onSave }: { company: CompanyProfile; setCompany: (company: CompanyProfile) => void; onSave: () => void }) {
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
  return <div className="profile-page"><div className="section-intro"><div><p className="eyebrow">BIDDER PROFILE</p><h2>Teach Tenderly what you can prove.</h2><p>This profile drives tender matching and eligibility. Missing data produces “Review”, never a guessed pass.</p></div><button className="continue-btn" onClick={onSave}>Save profile</button></div><div className="profile-grid"><section className="panel profile-form"><div className="profile-completeness"><span><strong>{completeness}%</strong><small>profile completeness</small></span><i><b style={{ width: `${completeness}%` }} /></i><p>Add registration, turnover and insurance limits to strengthen automatic qualification.</p></div><div className="form-grid">{fields.map((field) => <label key={field.key} className={field.wide ? "wide" : ""}><span>{field.label}</span>{field.wide ? <textarea value={company[field.key]} onChange={(event) => setCompany({ ...company, [field.key]: event.target.value })} placeholder={field.hint} /> : <input value={company[field.key]} onChange={(event) => setCompany({ ...company, [field.key]: event.target.value })} placeholder={field.hint} />}</label>)}</div></section><aside className="profile-aside"><section className="panel"><span className="aside-icon">◇</span><h3>Why this matters</h3><p>Tenderly compares explicit tender requirements with explicit bidder facts. The stronger this profile, the fewer false positives your feed contains.</p></section><section className="panel"><h3>Next best additions</h3><p>1. Upload audited accounts / turnover evidence</p><p>2. Add insurance certificates</p><p>3. Add 3–5 reference projects</p><p>4. Add reusable company policies</p></section></aside></div></div>;
}

function EvidenceView({ tab, setTab, evidence, people, onUploadEvidence, onUploadCv, onVerify, loading }: { tab: "Evidence" | "CVs"; setTab: (tab: "Evidence" | "CVs") => void; evidence: EvidenceItem[]; people: PersonItem[]; onUploadEvidence: (file: File) => void; onUploadCv: (file: File) => void; onVerify: (id: string, verified: boolean) => void; loading: string }) {
  return <div className="library-page"><div className="section-intro"><div><p className="eyebrow">REUSABLE BID LIBRARY</p><h2>Write from evidence, not memory.</h2><p>Approved case studies, methods and policies are the only reusable claims Tenderly gives its bid writer. CV facts are kept separately for role matching.</p></div>{tab === "Evidence" ? <FileButton label={loading === "evidence-upload" ? "Extracting…" : "＋ Upload evidence"} accept=".pdf,.docx,.xlsx,.xls,.pptx,.zip,.txt,.csv" onFile={onUploadEvidence} /> : <FileButton label={loading === "cv-upload" ? "Extracting…" : "＋ Upload CV"} accept=".pdf,.docx,.txt" onFile={onUploadCv} />}</div><div className="segmented"><button className={tab === "Evidence" ? "active" : ""} onClick={() => setTab("Evidence")}>Evidence library</button><button className={tab === "CVs" ? "active" : ""} onClick={() => setTab("CVs")}>CV library</button></div>{tab === "Evidence" ? <section className="panel evidence-table">{evidence.map((item) => <div key={item.id}><span className="file-orb">◇</span><p><strong>{item.name}</strong><small>{item.kind}{item.tags.length ? ` · ${item.tags.join(" · ")}` : " · extracted source"}</small></p><span className={item.verified ? "verified" : "review-state"}>{item.verified ? "✓ Verified" : "! Review"}</span><button onClick={() => onVerify(item.id, !item.verified)} disabled={loading === `evidence-${item.id}`}>{loading === `evidence-${item.id}` ? "Saving…" : item.verified ? "Unverify" : "Verify →"}</button></div>)}{!evidence.length && <div className="library-empty"><span className="file-orb">◇</span><p><strong>No evidence yet</strong><small>Upload case studies, policies, methods or certificates. Review them before marking verified.</small></p></div>}</section> : <div className="cv-grid">{people.map((person) => <article className="panel cv-card" key={person.id}><span className="cv-avatar">{person.name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "CV"}</span><h3>{person.name}</h3><p>{person.title || "Parsed CV"}</p><small>{person.cvText ? `${Math.min(person.cvText.length, 9999).toLocaleString()} characters extracted` : "CV text pending"}</small><div>{person.skills.length ? person.skills.slice(0, 4).map((skill) => <span key={skill}>{skill}</span>) : <span>Full CV available to role matching</span>}</div></article>)}<article className="panel gap-card"><span>＋</span><h3>Add another CV</h3><p>Upload the people you may propose. Re-run qualification and Tenderly will match explicit CV facts to tender roles.</p><FileButton label="Upload CV" accept=".pdf,.docx,.txt" onFile={onUploadCv} /></article></div>}</div>;
}

function TeamView({ people, onUploadCv, loading }: { people: PersonItem[]; onUploadCv: (file: File) => void; loading: boolean }) {
  return <div className="library-page"><div className="section-intro"><div><p className="eyebrow">TEAM & PARTNERS</p><h2>Know your bid shape before you write.</h2><p>Tenderly maps required roles to CV evidence and only flags a tie-up when a concrete capability, capacity or credential gap remains.</p></div><FileButton label={loading ? "Extracting…" : "＋ Add person / CV"} accept=".pdf,.docx,.txt" onFile={onUploadCv} /></div><div className="team-grid">{people.map((person) => <section className="panel team-card" key={person.id}><span className="cv-avatar">{person.name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]?.toUpperCase()).join("") || "CV"}</span><div><h3>{person.name}</h3><p>{person.title || "Parsed CV profile"}</p></div><strong>Available to match</strong><small>{person.skills.length ? person.skills.join(" · ") : "Tenderly will match requirements against the full extracted CV text."}</small></section>)}<section className="panel gap-card"><span>＋</span><h3>Build your partner bench</h3><p>Add trusted associates or partner CVs here. A tender analysis will identify exactly which required role or credential still lacks evidence.</p><FileButton label="Add partner CV" accept=".pdf,.docx,.txt" onFile={onUploadCv} /></section></div></div>;
}

function SettingsView({ isDemo }: { isDemo: boolean }) {
  return <div className="settings-page"><div className="section-intro"><div><p className="eyebrow">SETTINGS</p><h2>Discovery & guardrails.</h2><p>Production guardrails are conservative by default. Deployment-level watcher values live in Render environment settings for this V1.</p></div></div><section className="panel settings-list"><div><span><strong>eTenders watcher</strong><small>Daily Render cron when enabled, plus manual Refresh live at any time</small></span><label className="switch disabled"><input type="checkbox" defaultChecked disabled /><i /></label></div><div><span><strong>Minimum notification match</strong><small>`TENDERLY_DISCOVERY_MIN_SCORE` · defaults to 45%</small></span><select defaultValue="45" disabled><option value="45">45% · Render config</option></select></div><div><span><strong>Conservative eligibility</strong><small>Missing proof is Review, not Pass. Conflicting source evidence blocks final readiness.</small></span><label className="switch disabled"><input type="checkbox" defaultChecked disabled /><i /></label></div><div><span><strong>Automatic final submission</strong><small>Disabled by design — a human always performs the final portal submit action.</small></span><label className="switch disabled"><input type="checkbox" disabled /><i /></label></div><div><span><strong>Connection</strong><small>{isDemo ? "Demo mode · set VITE_API_URL in Netlify to connect the Render API" : "Render API connected"}</small></span><span className={isDemo ? "connection demo" : "connection live"}>● {isDemo ? "Demo" : "Live"}</span></div></section></div>;
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
