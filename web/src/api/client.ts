/**
 * The single place the web app talks to the Tenderly API.
 *
 * Every endpoint has one typed function here, so screens never assemble a URL,
 * attach a token, or interpret an HTTP status themselves. Extracted from
 * components/TenderlyApp.tsx in TLY-22; the feature modules that follow import
 * from here rather than calling fetch.
 */
import type {
  AiPolicyAcknowledgement,
  Attestation,
  AttestationState,
  AuditEntry,
  BidDecisionRecord,
  CompanyProfile,
  DiscoveryPreferences,
  EvidenceItem,
  NotificationItem,
  PersonItem,
  SectorPreset,
  Tender,
  UsageTotals,
} from "@tenderly/shared";

/** A failed API call, carrying enough for a screen to explain itself to a user. */
export class ApiError extends Error {
  readonly status: number;
  /** The pack endpoint answers 409 with the list of unresolved mandatory items. */
  readonly blockers: string[];
  /** What the user was doing, so the message can name the action that failed. */
  readonly action: string;

  constructor(message: string, status: number, action: string, blockers: string[] = []) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.action = action;
    this.blockers = blockers;
  }

  /** A 401 means the session is gone: the caller should sign the user out. */
  get isSessionExpired() {
    return this.status === 401;
  }
}

export type ApiClientOptions = {
  /** Blank in demo mode — see `isDemo`. */
  baseUrl: string;
  /** Read at call time, not construction time, so a fresh token is always used. */
  getToken: () => string;
};

export type DraftedAnswer = { answer: string; status: string; missingInputs: string[] };
export type DownloadedAsset = { blob: Blob; filename: string };

export function createApiClient({ baseUrl, getToken }: ApiClientOptions) {
  /** No API configured: the app runs its built-in demonstration workspace. */
  const isDemo = !baseUrl;

  function authHeaders(): Record<string, string> {
    const token = getToken();
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  async function failure(response: Response, action: string): Promise<ApiError> {
    const detail = await response.json().catch(() => ({}) as Record<string, unknown>);
    const message = typeof detail.error === "string" ? detail.error
      : typeof detail.detail === "string" ? detail.detail
      : `${action} failed (${response.status})`;
    const blockers = Array.isArray(detail.blockers) ? (detail.blockers as string[]) : [];
    return new ApiError(message, response.status, action, blockers);
  }

  async function request<T>(path: string, action: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...authHeaders(),
        ...(init.headers ?? {}),
      },
    });
    if (!response.ok) throw await failure(response, action);
    return (await response.json()) as T;
  }

  /** Multipart upload: the browser sets its own Content-Type boundary. */
  async function upload<T>(path: string, action: string, body: FormData): Promise<T> {
    const response = await fetch(`${baseUrl}${path}`, { method: "POST", headers: authHeaders(), body });
    if (!response.ok) throw await failure(response, action);
    return (await response.json()) as T;
  }

  return {
    isDemo,

    // --- auth -------------------------------------------------------------
    signIn: (email: string, password: string) =>
      request<{ token: string }>("/api/auth/login", "Sign in", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      }),
    register: (email: string, password: string, companyName: string) =>
      request<{ token: string }>("/api/auth/register", "Create workspace", {
        method: "POST",
        body: JSON.stringify({ email, password, companyName }),
      }),

    // --- workspace --------------------------------------------------------
    listTenders: () => request<{ items: Tender[] }>("/api/tenders", "Load bids"),
    tender: (tenderId: string) => request<{ tender: Tender }>(`/api/tenders/${tenderId}`, "Load bid"),
    getCompany: () => request<{ company: CompanyProfile }>("/api/company", "Load company profile"),
    saveCompany: (company: CompanyProfile) =>
      request<{ company: CompanyProfile }>("/api/company", "Save company profile", {
        method: "PUT",
        body: JSON.stringify(company),
      }),
    listEvidence: () => request<{ items: EvidenceItem[] }>("/api/evidence", "Load evidence"),
    listPeople: () => request<{ items: PersonItem[] }>("/api/people", "Load team"),
    listNotifications: () =>
      request<{ items: NotificationItem[] }>("/api/notifications", "Load notifications"),

    // --- discovery preferences ------------------------------------------
    listSectors: () => request<{ items: SectorPreset[] }>("/api/sectors", "Load sectors"),
    getPreferences: () =>
      request<{ preferences: DiscoveryPreferences }>("/api/preferences", "Load discovery preferences"),
    savePreferences: (preferences: DiscoveryPreferences) =>
      request<{ preferences: DiscoveryPreferences }>("/api/preferences", "Save discovery preferences", {
        method: "PUT",
        body: JSON.stringify(preferences),
      }),

    // --- discovery and import --------------------------------------------
    discover: (query = "") =>
      request<{ items: Tender[] }>(
        `/api/tenders/discover${query ? `?query=${encodeURIComponent(query)}` : ""}`,
        "Refresh opportunities",
      ),
    importTender: (url: string) =>
      request<{ tender: Tender; warnings?: string[] }>("/api/tenders/import", "Import tender", {
        method: "POST",
        body: JSON.stringify({ url }),
      }),

    // --- analysis and drafting -------------------------------------------
    analyse: (tenderId: string) =>
      request<{ tender: Tender }>(`/api/tenders/${tenderId}/analyse`, "Run qualification", {
        method: "POST",
        body: "{}",
      }),
    draftAnswer: (tenderId: string, questionId: string) =>
      request<DraftedAnswer>(
        `/api/tenders/${tenderId}/answers/${questionId}/draft`,
        "Draft answer",
        { method: "POST", body: "{}" },
      ),
    saveAnswer: (tenderId: string, questionId: string, response: string, status: string) =>
      request<unknown>(`/api/tenders/${tenderId}/answers/${questionId}`, "Save answer", {
        method: "PUT",
        body: JSON.stringify({ response, status }),
      }),
    attestationState: (tenderId: string) =>
      request<AttestationState>(`/api/tenders/${tenderId}/attestation`, "Load attestation"),
    recordAttestation: (tenderId: string) =>
      request<{ attestation: Attestation }>(`/api/tenders/${tenderId}/attestation`, "Record attestation", {
        method: "POST",
        body: JSON.stringify({ confirmed: true }),
      }),
    recordBidDecision: (tenderId: string, decision: "BID" | "NO_BID", reason: string) =>
      request<{ decision: BidDecisionRecord }>(`/api/tenders/${tenderId}/decision`, "Record bid decision", {
        method: "POST",
        body: JSON.stringify({ decision, reason }),
      }),
    setSelectedLots: (tenderId: string, lotIds: string[]) =>
      request<{ tender: Tender }>(`/api/tenders/${tenderId}/lots`, "Select lots", {
        method: "PUT",
        body: JSON.stringify({ lotIds }),
      }),
    setNoAiMode: (tenderId: string, enabled: boolean) =>
      request<{ noAiMode: boolean; aiWrittenAnswers: string[] }>(`/api/tenders/${tenderId}/no-ai-mode`, "Set no-AI mode", {
        method: "PUT",
        body: JSON.stringify({ enabled }),
      }),
    critiqueAnswer: (tenderId: string, questionId: string) =>
      request<{ strengths: string[]; gaps: string[]; missingEvidence: string[] }>(`/api/tenders/${tenderId}/answers/${questionId}/critique`, "Critique answer", {
        method: "POST",
        body: JSON.stringify({}),
      }),
    acknowledgeAiPolicy: (tenderId: string, action: "confirmed" | "dismissed") =>
      request<{ acknowledgement: AiPolicyAcknowledgement }>(`/api/tenders/${tenderId}/ai-policy/acknowledge`, "Acknowledge AI policy", {
        method: "POST",
        body: JSON.stringify({ action }),
      }),
    usage: () => request<{ usage: UsageTotals }>("/api/usage", "Load AI usage"),
    audit: (filter: { action?: string; days?: number } = {}) => {
      const query = new URLSearchParams();
      if (filter.action) query.set("action", filter.action);
      if (filter.days) query.set("days", String(filter.days));
      const suffix = query.toString();
      return request<{ entries: AuditEntry[] }>(`/api/audit${suffix ? `?${suffix}` : ""}`, "Load audit log");
    },
    setChecklistStatus: (tenderId: string, itemId: string, status: string) =>
      request<unknown>(`/api/tenders/${tenderId}/checklist/${itemId}`, "Update checklist", {
        method: "POST",
        body: JSON.stringify({ status }),
      }),

    // --- evidence and people ---------------------------------------------
    setEvidenceVerified: (itemId: string, verified: boolean) =>
      request<{ item: EvidenceItem }>(`/api/evidence/${itemId}/verification`, "Update evidence", {
        method: "PUT",
        body: JSON.stringify({ verified }),
      }),
    uploadEvidenceFile: (file: File) => {
      const body = new FormData();
      body.append("file", file);
      body.append("kind", "Document");
      body.append("verified", "false");
      return upload<{ item: EvidenceItem }>("/api/evidence/upload", "Evidence upload", body);
    },
    uploadCv: (file: File) => {
      const body = new FormData();
      body.append("file", file);
      return upload<{ person: PersonItem }>("/api/people/upload", "CV upload", body);
    },
    uploadTenderDocument: (tenderId: string, file: File, role: string) => {
      const body = new FormData();
      body.append("file", file);
      body.append("role", role);
      return upload<unknown>(`/api/tenders/${tenderId}/documents`, "Upload", body);
    },

    // --- generated artefacts ---------------------------------------------
    /**
     * Returns bytes, not JSON. A blocked final pack answers 409 with the list of
     * unresolved mandatory items, which surfaces as ApiError.blockers.
     */
    async download(tenderId: string, kind: "deck" | "pack", draft = false): Promise<DownloadedAsset> {
      const action = kind === "deck" ? "Deck download" : "Pack download";
      const query = kind === "pack" ? `?draft=${draft}` : "";
      const response = await fetch(`${baseUrl}/api/tenders/${tenderId}/${kind}${query}`, {
        headers: authHeaders(),
      });
      if (!response.ok) throw await failure(response, action);
      const blob = await response.blob();
      const disposition = response.headers.get("content-disposition") ?? "";
      const fallback = kind === "deck" ? "Tenderly-Synopsis.pptx" : "Tenderly-Submission.zip";
      const filename = disposition.match(/filename="?([^";]+)"?/)?.[1] ?? fallback;
      return { blob, filename };
    },
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
