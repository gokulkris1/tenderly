/**
 * The single place the web app talks to the Tenderly API.
 *
 * Every endpoint has one typed function here, so screens never assemble a URL,
 * attach a token, or interpret an HTTP status themselves. Extracted from
 * components/TenderlyApp.tsx in TLY-22; the feature modules that follow import
 * from here rather than calling fetch.
 */
import type {
  Affirmation,
  AiPolicyAcknowledgement,
  AnswerVersion,
  Attestation,
  AttestationState,
  AuditEntry,
  BidDecisionRecord,
  CompanyProfile,
  DeclarationAnswer,
  DeclarationState,
  DiffSegment,
  DiscoveryPreferences,
  EvidenceItem,
  NotificationItem,
  PersonFact,
  PersonItem,
  SavedSearch,
  SavedSearchFilter,
  SectorPreset,
  SkillMatrix,
  Tender,
  UsageTotals,
  VaultCompleteness,
  WatchlistItem,
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
    discover: (query = "", searchId = "") => {
      const params = new URLSearchParams();
      if (query) params.set("query", query);
      if (searchId) params.set("search", searchId);
      const suffix = params.toString();
      return request<{ items: Tender[]; activeSearch: { id: string; name: string } | null }>(
        `/api/tenders/discover${suffix ? `?${suffix}` : ""}`,
        "Refresh opportunities",
      );
    },
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
    answerVersions: (tenderId: string, questionId: string, compare?: { from: string; to: string }) => {
      const query = compare ? `?from=${encodeURIComponent(compare.from)}&to=${encodeURIComponent(compare.to)}` : "";
      return request<{ versions: AnswerVersion[]; diff?: DiffSegment[] }>(
        `/api/tenders/${tenderId}/answers/${questionId}/versions${query}`, "Load answer history");
    },
    restoreAnswerVersion: (tenderId: string, questionId: string, versionId: string) =>
      request<{ answer: unknown; versions: AnswerVersion[] }>(
        `/api/tenders/${tenderId}/answers/${questionId}/versions/${versionId}/restore`, "Restore version",
        { method: "POST", body: "{}" }),
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
    savedSearches: () => request<{ items: SavedSearch[] }>("/api/saved-searches", "Load saved searches"),
    createSavedSearch: (name: string, filter: SavedSearchFilter) =>
      request<{ search: SavedSearch }>("/api/saved-searches", "Save search", {
        method: "POST", body: JSON.stringify({ name, filter }),
      }),
    deleteSavedSearch: (id: string) =>
      request<unknown>(`/api/saved-searches/${encodeURIComponent(id)}`, "Delete saved search", { method: "DELETE" }),
    watchlist: () => request<{ items: WatchlistItem[] }>("/api/watchlist", "Load watchlist"),
    watch: (notice: { externalId: string; title: string; authority: string; deadline: string; sourceUrl: string }) =>
      request<unknown>("/api/watchlist", "Watch notice", { method: "POST", body: JSON.stringify(notice) }),
    unwatch: (externalId: string) =>
      request<unknown>(`/api/watchlist/${encodeURIComponent(externalId)}`, "Unwatch notice", { method: "DELETE" }),
    recordBidDecision: (tenderId: string, decision: "BID" | "NO_BID", reason: string) =>
      request<{ decision: BidDecisionRecord }>(`/api/tenders/${tenderId}/decision`, "Record bid decision", {
        method: "POST",
        body: JSON.stringify({ decision, reason }),
      }),
    assignRole: (tenderId: string, role: string, personId: string | null) =>
      request<{ tender: Tender }>(
        `/api/tenders/${tenderId}/roles/${encodeURIComponent(role)}/assignment`, "Assign role",
        { method: "PUT", body: JSON.stringify({ personId }) },
      ),
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
    /** The download URL for a vault item's original file, token included. */
    evidenceFileUrl: (evidenceId: string) => `${baseUrl}/api/evidence/${encodeURIComponent(evidenceId)}/file`,
    downloadEvidenceFile: async (evidenceId: string, filename: string) => {
      const response = await fetch(`${baseUrl}/api/evidence/${encodeURIComponent(evidenceId)}/file`, { headers: authHeaders() });
      if (!response.ok) throw await failure(response, "Download evidence");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = filename;
      anchor.click();
      URL.revokeObjectURL(url);
    },
    declarations: () => request<DeclarationState>("/api/declarations", "Load declarations"),
    saveDeclarations: (answers: DeclarationAnswer[]) =>
      request<{ answers: DeclarationAnswer[] }>("/api/declarations", "Save declarations", {
        method: "PUT", body: JSON.stringify({ answers }),
      }),
    affirmDeclarations: () =>
      request<{ affirmation: Affirmation }>("/api/declarations/affirm", "Affirm declarations", {
        method: "POST", body: "{}",
      }),
    vaultCompleteness: () => request<{ completeness: VaultCompleteness }>("/api/vault/completeness", "Load vault readiness"),
    updatePerson: (personId: string, patch: { name?: string; title?: string; email?: string; phone?: string }) =>
      request<{ person: PersonItem }>(`/api/people/${encodeURIComponent(personId)}`, "Update person", {
        method: "PUT", body: JSON.stringify(patch),
      }),
    setPersonArchived: (personId: string, archived: boolean) =>
      request<{ person: PersonItem; affectedTenders: { id: string; title: string }[] }>(
        `/api/people/${encodeURIComponent(personId)}/archive`, "Archive person",
        { method: "POST", body: JSON.stringify({ archived }) },
      ),
    skillsMatrix: (skill = "") =>
      request<{ matrix: SkillMatrix }>(`/api/skills-matrix${skill ? `?skill=${encodeURIComponent(skill)}` : ""}`, "Load skills matrix"),
    downloadSkillsMatrix: async (skill = "") => {
      const params = new URLSearchParams({ format: "csv" });
      if (skill) params.set("skill", skill);
      const response = await fetch(`${baseUrl}/api/skills-matrix?${params}`, { headers: authHeaders() });
      if (!response.ok) throw await failure(response, "Export skills matrix");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "tenderly-skills-matrix.csv";
      anchor.click();
      URL.revokeObjectURL(url);
    },
    personRecords: (personId: string) =>
      request<{ records: PersonFact[] }>(`/api/people/${encodeURIComponent(personId)}/records`, "Load CV records"),
    updatePersonRecord: (factId: string, patch: { value?: string; detail?: string; confirmed?: boolean }) =>
      request<{ record: PersonFact }>(`/api/people/records/${encodeURIComponent(factId)}`, "Update CV record", {
        method: "PUT", body: JSON.stringify(patch),
      }),
    confirmPersonRecords: (personId: string) =>
      request<{ records: PersonFact[] }>(`/api/people/${encodeURIComponent(personId)}/records/confirm`, "Confirm CV records", {
        method: "POST", body: "{}",
      }),
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
