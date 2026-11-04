import { useEffect, useMemo, useState } from "react";
import type { Tender, TenderAttachment, TenderBoardConfig, TenderStage, TenderWorkflow, TenderWorkflowPatch } from "@tenderly/shared";
import { MarketBadges, MarketScopePicker, showMarketBadges } from "./MarketScope";

export const TENDER_STAGES: { id: TenderStage; label: string; short: string }[] = [
  { id: "NEW", label: "New", short: "New" },
  { id: "REVIEW", label: "Review", short: "Review" },
  { id: "CONSIDER", label: "Consider", short: "Consider" },
  { id: "APPLICATION", label: "Application in progress", short: "Applying" },
  { id: "DONE", label: "Done", short: "Done" },
  { id: "IGNORE", label: "Ignore", short: "Ignore" },
];

export function workflowOf(tender: Tender): TenderWorkflow {
  return tender.workflow ?? { stage: "NEW", outcome: "PENDING", priority: "MEDIUM", assignee: "", history: [] };
}

export function valueBand(tender: Tender): "under" | "over" | "unknown" {
  const figures = [...tender.value.replace(/(\d),(?=\d{3}\b)/g, "$1").matchAll(/\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));
  const amount = tender.valueAmount === undefined ? (figures.length ? Math.max(...figures) : null) : tender.valueAmount;
  return amount === null ? "unknown" : amount <= 200_000 ? "under" : "over";
}

const bandLabels = { all: "All values", under: "Up to EUR 200k", over: "Above EUR 200k", unknown: "Value not stated" };

export function deadlineInfo(tender: Tender, now = Date.now()): { label: string; tone: "overdue" | "soon" | "open" | "none" } {
  if (!tender.deadlineIso) return { label: "", tone: "none" };
  const at = Date.parse(tender.deadlineIso);
  if (Number.isNaN(at)) return { label: "", tone: "none" };
  const days = Math.ceil((at - now) / 86_400_000);
  if (days < 0) return { label: "Deadline passed", tone: "overdue" };
  if (days === 0) return { label: "Closes today", tone: "soon" };
  if (days <= 7) return { label: `${days}d left`, tone: "soon" };
  if (days <= 14) return { label: `${days}d left`, tone: "open" };
  return { label: "", tone: "none" };
}

const NEXT_STEP: Record<TenderStage, string> = {
  NEW: "Triage — keep, review or ignore",
  REVIEW: "Decide whether to pursue",
  CONSIDER: "Confirm the bid decision",
  APPLICATION: "Prepare and submit on time",
  DONE: "Outcome recorded",
  IGNORE: "No action — set aside",
};

export function nextStep(workflow: TenderWorkflow): string {
  return workflow.stage === "DONE" && workflow.outcome === "PENDING" ? "Record the outcome" : NEXT_STEP[workflow.stage];
}

type BoardViewMemory = { query: string; band: keyof typeof bandLabels; stage: TenderStage | "ALL"; view: "board" | "list"; groupValues: boolean };
// Survives board -> tender -> back navigation within the session so the user
// returns to the filters they left, not a reset board. Reloads start clean.
let rememberedView: BoardViewMemory | null = null;

function Synopsis({ tender }: { tender: Tender }) {
  return <p className="tracker-synopsis">{tender.noticeFields?.Description || tender.sourceDescription || tender.noticeSummary?.ask || tender.summary || "Open the CFT for the published scope."}</p>;
}

export function TenderBoard({ tenders, boards, boardId, onSelectBoard, onCreateBoard, onDeleteBoard, onOpen, onMove, onSync, onDiscover, onOpenBuyer, onExport, loading, readOnly }: {
  tenders: Tender[]; onOpen: (id: string) => void; onMove: (id: string, patch: TenderWorkflowPatch) => void;
  onSync: () => void; onDiscover: () => void; loading: boolean; readOnly: boolean;
  boards: TenderBoardConfig[]; boardId: string; onSelectBoard: (id: string) => void;
  onCreateBoard: (name: string, cpvCodes: string[], countries: string[]) => Promise<boolean>; onDeleteBoard: (id: string) => void;
  onOpenBuyer: (name: string) => void; onExport?: () => void;
}) {
  const [query, setQuery] = useState(rememberedView?.query ?? "");
  const [band, setBand] = useState<keyof typeof bandLabels>(rememberedView?.band ?? "all");
  const [view, setView] = useState<"board" | "list">(rememberedView?.view ?? "board");
  const [groupValues, setGroupValues] = useState(rememberedView?.groupValues ?? false);
  const [stage, setStage] = useState<TenderStage | "ALL">(rememberedView?.stage ?? "ALL");
  const [creating, setCreating] = useState(false);
  const [boardName, setBoardName] = useState("");
  const [boardCodes, setBoardCodes] = useState("");
  const [boardMarkets, setBoardMarkets] = useState<string[]>([]);
  const [deleting, setDeleting] = useState(false);
  const [draggingId, setDraggingId] = useState("");
  const [dropStage, setDropStage] = useState<TenderStage | "">("");
  useEffect(() => { rememberedView = { query, band, stage, view, groupValues }; }, [query, band, stage, view, groupValues]);
  const board = boards.find((entry) => entry.id === boardId);
  const boardTenders = useMemo(() => !board ? tenders : tenders.filter((tender) => {
    const codes = `${tender.cpv?.raw ?? ""} ${tender.noticeFields?.["CPV Codes"] ?? ""}`.match(/\b\d{8}\b/g) ?? [];
    return board.cpvCodes.some((parent) => codes.some((code) => code.startsWith(parent.replace(/0+$/, ""))));
  }), [board, tenders]);
  const stageBase = useMemo(() => boardTenders.filter((tender) => {
    const needle = query.trim().toLowerCase();
    return (!needle || `${tender.resourceId} ${tender.title} ${tender.authority} ${tender.sourceDescription ?? ""} ${tender.summary} ${tender.cpv?.raw ?? ""}`.toLowerCase().includes(needle))
      && (band === "all" || valueBand(tender) === band);
  }), [boardTenders, query, band]);
  const filtered = useMemo(() => stageBase.filter((tender) => stage === "ALL" || workflowOf(tender).stage === stage), [stageBase, stage]);
  const stageCounts = useMemo(() => {
    const tally = Object.fromEntries(TENDER_STAGES.map((entry) => [entry.id, 0])) as Record<TenderStage, number>;
    for (const tender of stageBase) tally[workflowOf(tender).stage] += 1;
    return tally;
  }, [stageBase]);
  const wonCount = useMemo(() => boardTenders.filter((tender) => workflowOf(tender).outcome === "WON").length, [boardTenders]);
  const groups = groupValues ? (["under", "over", "unknown"] as const) : (["all"] as const);
  const card = (tender: Tender) => {
    const workflow = workflowOf(tender);
    const due = deadlineInfo(tender);
    return <article className={`tracker-card${draggingId === tender.id ? " dragging" : ""}`} key={tender.id} draggable={!readOnly && !loading}
      onDragStart={(event) => { event.dataTransfer.setData("text/tender-id", tender.id); event.dataTransfer.effectAllowed = "move"; setDraggingId(tender.id); }}
      onDragEnd={() => { setDraggingId(""); setDropStage(""); }}
      data-testid={`tender-card-${tender.id}`}>
      <div className="tracker-card-top"><span className="tracker-ref">CFT-{tender.resourceId}</span><span className={`tracker-priority priority-${workflow.priority.toLowerCase()}`}>{workflow.priority.toLowerCase()}</span></div>
      <button className="tracker-card-title" onClick={() => onOpen(tender.id)}>{tender.title}</button>
      <p className="tracker-buyer">
        <button className="buyer-link" onClick={() => onOpenBuyer(tender.authority)} title={`Open buyer profile for ${tender.authority}`}>{tender.authority}</button>
        {showMarketBadges(tender.markets) && <> <MarketBadges markets={tender.markets} /></>}
      </p>
      {tender.cpv?.raw && <p className="tracker-cpv" title={tender.cpv.raw}>CPV {(tender.cpv.raw.match(/\b\d{8}\b/g) ?? []).join(", ") || tender.cpv.raw}</p>}
      {tender.sourceWarnings?.length ? <p className="criteria-warning">Source details need attention</p> : null}
      <Synopsis tender={tender} />
      <dl className="tracker-card-facts">
        <div><dt>Value</dt><dd>{tender.value}</dd></div>
        <div><dt>Closes</dt><dd>{tender.deadline}{due.label && <span className={`tracker-due due-${due.tone}`}>{due.label}</span>}</dd></div>
      </dl>
      <p className="tracker-next-step">{nextStep(workflow)}</p>
      <div className="tracker-card-footer"><span>{workflow.assignee || "Unassigned"}</span>{workflow.outcome !== "PENDING" && <strong className={`outcome-${workflow.outcome.toLowerCase()}`}>{workflow.outcome === "WON" ? "Won" : "Not won"}</strong>}</div>
      <label className="tracker-move">Move to
        <select aria-label={`Stage for ${tender.title}`} value={workflow.stage} disabled={readOnly || loading}
          onChange={(event) => onMove(tender.id, { stage: event.target.value as TenderStage })}>
          {TENDER_STAGES.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
        </select>
      </label>
    </article>;
  };
  return <div className="tracker-page">
    <header className="tracker-heading">
      <div className="tracker-heading-main">
        <h1>Tender board</h1>
        <div className="tracker-board-inline">
          <label>Board
            <select aria-label="Tender board" value={boardId} onChange={(event) => { onSelectBoard(event.target.value); setDeleting(false); }}>
              <option value="">All tracked tenders</option>
              {boards.map((entry) => <option key={entry.id} value={entry.id}>{entry.name} ({entry.cpvCodes.join(", ")})</option>)}
            </select>
          </label>
          <button className="quiet-btn" onClick={() => setCreating((value) => !value)} disabled={readOnly}>Create CPV board</button>
          {board && boards.length > 1 && <button className="text-action" disabled={readOnly || loading} onClick={() => setDeleting(true)}>Remove board</button>}
        </div>
      </div>
      <div className="tracker-actions">{onExport && <button className="quiet-btn" onClick={onExport} disabled={loading}>Export CSV</button>}<button className="quiet-btn" onClick={onDiscover}>Browse sources</button><button className="continue-btn" onClick={onSync} disabled={loading || readOnly}>{loading ? "Syncing…" : "Sync tenders"}</button></div>
    </header>
    {deleting && board && <div className="tracker-confirm" role="alert">Remove "{board.name}"? Tenders and their workflow will be kept. <button className="quiet-btn" onClick={() => { onDeleteBoard(board.id); setDeleting(false); }}>Confirm removal</button><button className="quiet-btn" onClick={() => setDeleting(false)}>Cancel</button></div>}
    {creating && <form className="panel tracker-create-board" onSubmit={async (event) => {
      event.preventDefault();
      const codes = [...new Set(boardCodes.split(/[\s,]+/).filter(Boolean))];
      if (await onCreateBoard(boardName.trim(), codes, boardMarkets)) { setCreating(false); setBoardName(""); setBoardCodes(""); setBoardMarkets([]); }
    }}><h2>A board for your CPV criteria</h2><p>One or more CPV families per board. A tender matching two boards stays one record, with the same stage and result.</p>
      <label>Board name<input value={boardName} onChange={(event) => setBoardName(event.target.value)} required maxLength={100} placeholder="e.g. Software development" /></label>
      <label>CPV codes<input value={boardCodes} onChange={(event) => setBoardCodes(event.target.value)} required pattern="[0-9]{8}([ ,]+[0-9]{8})*" placeholder="72200000, 72500000" /></label>
      <div className="tracker-board-scope"><span>Market scope <small>optional — no selection watches the workspace markets</small></span>
        <MarketScopePicker label="Board market scope" value={boardMarkets} onChange={setBoardMarkets} disabled={loading} /></div>
      <div><button className="continue-btn" disabled={loading}>Create board</button><button className="quiet-btn" type="button" onClick={() => setCreating(false)}>Cancel</button></div>
    </form>}
    <section className="tracker-toolbar" aria-label="Tender filters">
      <input aria-label="Search tracked tenders" placeholder="Search CFT, title, buyer or scope" value={query} onChange={(event) => setQuery(event.target.value)} />
      <label>Value<select value={band} onChange={(event) => setBand(event.target.value as keyof typeof bandLabels)}>{Object.entries(bandLabels).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></label>
      <label className="tracker-group"><input type="checkbox" checked={groupValues} onChange={(event) => setGroupValues(event.target.checked)} />Group by value</label>
      <div className="tracker-view" aria-label="Display"><button aria-pressed={view === "board"} onClick={() => setView("board")}>Board</button><button aria-pressed={view === "list"} onClick={() => setView("list")}>List</button></div>
    </section>
    <div className="tracker-chips" role="group" aria-label="Filter by stage">
      <button aria-pressed={stage === "ALL"} onClick={() => setStage("ALL")}>All<span>{stageBase.length}</span></button>
      {TENDER_STAGES.map((entry) => <button key={entry.id} aria-pressed={stage === entry.id} onClick={() => setStage(stage === entry.id ? "ALL" : entry.id)}>{entry.short}<span>{stageCounts[entry.id]}</span></button>)}
    </div>
    <p className="tracker-count" role="status">{filtered.length} of {boardTenders.length} tenders · {wonCount} won · {board ? `CPV ${board.cpvCodes.join(", ")}` : "All CPV boards"} · Values in EUR</p>
    {!tenders.length && <section className="panel tracker-empty"><h2>Your tender board starts here</h2><p>Sync to create a New card for every open matching tender. No score threshold hides CPV matches.</p><button className="continue-btn" disabled={loading || readOnly} onClick={onSync}>Sync matching tenders</button></section>}
    {tenders.length > 0 && !filtered.length && <section className="panel tracker-empty"><h2>No tenders match this board or these filters</h2><p>Sync to fetch this board's CPV families, or clear filters to see every stage.</p><button className="quiet-btn" onClick={() => { setQuery(""); setBand("all"); setStage("ALL"); }}>Clear filters</button></section>}
    {filtered.length > 0 && groups.map((group) => {
      const items = group === "all" ? filtered : filtered.filter((tender) => valueBand(tender) === group);
      return <section className="tracker-group-section" key={group}>
        {group !== "all" && <h2 className="tracker-group-heading">{bandLabels[group]} <span>{items.length}</span></h2>}
        {view === "board" ? <div className="tracker-board" aria-label={`Tender workflow ${bandLabels[group]}`}>
          {TENDER_STAGES.map((column) => {
            const columnItems = items.filter((tender) => workflowOf(tender).stage === column.id);
            return <section className={`tracker-column stage-${column.id.toLowerCase()}${dropStage === column.id ? " drop-target" : ""}`} key={column.id} aria-label={`${column.label} tenders`}
              onDragOver={(event) => { if (!readOnly && !loading) event.preventDefault(); }}
              onDragEnter={(event) => { if (!readOnly && !loading) { event.preventDefault(); setDropStage(column.id); } }}
              onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropStage(""); }}
              onDrop={(event) => {
                event.preventDefault();
                setDropStage("");
                setDraggingId("");
                const id = event.dataTransfer.getData("text/tender-id");
                if (!readOnly && !loading && tenders.some((tender) => tender.id === id)) onMove(id, { stage: column.id });
              }}>
              <h2>{column.label}<span>{columnItems.length}</span></h2>
              {columnItems.map(card)}
              {!columnItems.length && <p className="tracker-column-empty">No tenders</p>}
            </section>;
          })}
        </div> : <div className="tracker-list">{items.map(card)}</div>}
      </section>;
    })}
    <p className="tracker-help">New arrivals stay in New until you move them. Drag cards between stages or use their Move to menu. Scoring is optional inside each tender.</p>
  </div>;
}

export function TenderRecordPanel({ tender, onChange, onRefresh, onDownload, busy, readOnly }: {
  tender: Tender; onChange: (patch: TenderWorkflowPatch) => Promise<boolean>; onRefresh: () => void;
  onDownload: (attachment: TenderAttachment) => void; busy: boolean; readOnly: boolean;
}) {
  const workflow = workflowOf(tender);
  const [comment, setComment] = useState("");
  const [assignee, setAssignee] = useState(workflow.assignee);
  useEffect(() => setAssignee(workflow.assignee), [workflow.assignee]);
  return <section className="tender-record" aria-label="Tender record">
    <section className="panel record-tracking">
      <div className="panel-heading"><div><h2>Tracking</h2><p>Your stage, result and ownership — never changed by a source refresh.</p></div></div>
      <div className="record-controls">
      <label>Tender stage<select aria-label="Tender stage" value={workflow.stage} disabled={busy || readOnly} onChange={(event) => void onChange({ stage: event.target.value as TenderStage })}>{TENDER_STAGES.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}</select></label>
      <label>Result<select aria-label="Tender result" value={workflow.outcome} disabled={busy || readOnly} onChange={(event) => void onChange({ outcome: event.target.value as TenderWorkflow["outcome"] })}><option value="PENDING">Not recorded</option><option value="WON">Won</option><option value="NOT_WON">Not won</option></select></label>
      <label>Priority<select value={workflow.priority} disabled={busy || readOnly} onChange={(event) => void onChange({ priority: event.target.value as TenderWorkflow["priority"] })}><option value="LOW">Low</option><option value="MEDIUM">Medium</option><option value="HIGH">High</option></select></label>
      <form className="record-assignee" onSubmit={(event) => { event.preventDefault(); void onChange({ assignee }); }}><label>Assignee<input value={assignee} onChange={(event) => setAssignee(event.target.value)} placeholder="Name or email" maxLength={254} disabled={busy || readOnly} /></label><button className="quiet-btn" disabled={busy || readOnly || assignee === workflow.assignee}>Assign</button></form>
      </div>
    </section>
    <div className="record-layout">
      <section className="panel record-scope"><p className="eyebrow">PUBLISHED CFT SYNOPSIS</p><h2>What is being procured</h2><Synopsis tender={tender} />
        <dl className="record-facts">
          <div><dt>Buyer</dt><dd>{tender.authority}</dd></div><div><dt>Estimated value</dt><dd>{tender.value}</dd></div>
          <div><dt>Submission deadline</dt><dd>{tender.deadline}</dd></div><div><dt>Clarification deadline</dt><dd>{tender.noticeFields?.["End of clarification period"] || "Not published"}</dd></div>
          <div><dt>Procedure</dt><dd>{tender.procedure}</dd></div><div><dt>Published</dt><dd>{tender.published || "Not published"}</dd></div>
          <div><dt>CPV codes</dt><dd>{tender.cpv?.raw || tender.noticeFields?.["CPV Codes"] || "Not published"}</dd></div><div><dt>Contact point</dt><dd>{tender.noticeFields?.["Contact Point"] || "Use the CFT portal messaging service"}</dd></div>
        </dl>
        <details className="record-source-fields"><summary>All published CFT fields ({Object.keys(tender.noticeFields ?? {}).length})</summary>
          {Object.keys(tender.noticeFields ?? {}).length ? <dl>{Object.entries(tender.noticeFields ?? {}).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value || "Not stated"}</dd></div>)}</dl> : <p>No structured CFT snapshot yet. Refresh the source or open the published notice.</p>}
        </details>
      </section>
      <aside className="panel record-documents"><h2>Documents & buyer contact</h2>
        <a href={tender.sourceUrl} target="_blank" rel="noreferrer">Open published CFT</a>
        {(tender.sourceLinks ?? []).map((link) => <a key={link.url} href={link.url} target="_blank" rel="noreferrer">{link.label}</a>)}
        {!(tender.sourceLinks ?? []).length && /^\d+$/.test(tender.resourceId) && <a href={`https://www.etenders.gov.ie/epps/cft/listContractDocuments.do?resourceId=${encodeURIComponent(tender.resourceId)}`} target="_blank" rel="noreferrer">Tender documents and attachments</a>}
        {(tender.contactEmails ?? []).map((email) => <a key={email} href={`mailto:${email}`}>{email}</a>)}
        {!(tender.contactEmails ?? []).length && <p>No public clarification email is stated. Use the buyer's messaging channel on the CFT; portal sign-in may be required.</p>}
        <h3>Workspace attachments</h3>
        {(tender.attachments ?? []).map((attachment) => <button className="record-file" key={attachment.id} onClick={() => onDownload(attachment)}>{attachment.filename}<small>{attachment.role}</small></button>)}
        {!tender.attachments?.length && <p>No files imported yet. The public document link above remains available.</p>}
        {(tender.sourceWarnings ?? []).map((warning) => <p role="status" key={warning} className="criteria-warning">{warning}</p>)}
        <div className="source-freshness">
          <p role="status">{tender.sourceCheckedAt ? <>Source checked <strong>{new Date(tender.sourceCheckedAt).toLocaleString()}</strong></> : "Source not checked since tracking started."}{tender.sourceChanges?.length ? ` ${tender.sourceChanges.length} published update${tender.sourceChanges.length === 1 ? "" : "s"} captured since then.` : ""}</p>
          <small>{Object.keys(tender.noticeFields ?? {}).length ? `${Object.keys(tender.noticeFields ?? {}).length} published fields captured in the current snapshot — the portal remains the source of truth.` : "No structured fields captured yet. Refresh or open the published notice."}</small>
        </div>
        <button className="quiet-btn" onClick={onRefresh} disabled={busy || readOnly || !/etenders\.gov\.ie/.test(tender.sourceUrl)}>{busy ? "Refreshing…" : "Refresh CFT information"}</button>
        <p>Source refresh never moves your tender or changes its result. Private portal messages and emails are not synced automatically; record them in Clarifications below.</p>
      </aside>
    </div>
    {!!tender.sourceChanges?.length && <details className="panel record-activity"><summary>Published source updates ({tender.sourceChanges.length})</summary><ol>{[...tender.sourceChanges].reverse().map((change, index) => <li key={`${change.at}-${index}`}><strong>{change.field}</strong><time>{new Date(change.at).toLocaleString()}</time><p>Previously: {change.from || "Not stated"}</p><p>Now: {change.to || "Not stated"}</p></li>)}</ol></details>}
    <section className="panel record-activity"><h2>Activity & notes</h2>
      <form onSubmit={async (event) => { event.preventDefault(); if (await onChange({ comment: comment.trim() })) setComment(""); }}>
        <label htmlFor="tender-note">Add a tracking note</label><textarea id="tender-note" value={comment} onChange={(event) => setComment(event.target.value)} placeholder="Decision context, next action, or buyer update..." maxLength={4000} disabled={readOnly} />
        <button className="quiet-btn" disabled={busy || readOnly || !comment.trim()}>Add note</button>
      </form>
      <ol>{[...workflow.history].reverse().map((entry, index) => <li key={`${entry.at}-${index}`}><strong>{entry.actor}</strong><time>{new Date(entry.at).toLocaleString()}</time><p>{entry.message}</p></li>)}</ol>
      {!workflow.history.length && <p>No workflow changes yet. This tender is waiting in New.</p>}
    </section>
  </section>;
}
