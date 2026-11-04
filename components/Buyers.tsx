import { useMemo, useState } from "react";
import type { AwardIntelligence, BuyerProfile, BuyerSummary, Tender } from "@tenderly/shared";
import { workflowOf } from "./TenderTracker";
import { MarketBadges } from "./MarketScope";

const euro = (n: number | null) =>
  n === null || n === undefined ? "—" : new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR", maximumFractionDigits: 0 }).format(n);

/** The profile payload serialises the award-intelligence shape as-is; check before trusting it. */
function asAwardIntelligence(data: unknown): AwardIntelligence | null {
  if (!data || typeof data !== "object") return null;
  const candidate = data as Partial<AwardIntelligence>;
  return typeof candidate.awards === "number" && Array.isArray(candidate.topSuppliers) ? (candidate as AwardIntelligence) : null;
}

/**
 * Every buyer appearing in the workspace's tracked tenders and award history,
 * so a bid team can answer "what else is this buyer running?" in one click.
 */
export function BuyersDirectory({ items, state, error, onOpen, onRetry, isDemo }: {
  items: BuyerSummary[];
  state: "loading" | "ready" | "error";
  error?: string;
  onOpen: (name: string) => void;
  onRetry: () => void;
  isDemo: boolean;
}) {
  const [query, setQuery] = useState("");
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle ? items.filter((buyer) => buyer.name.toLowerCase().includes(needle)) : items;
  }, [items, query]);

  return (
    <div className="buyers-page">
      <header className="tracker-heading buyers-heading">
        <div className="tracker-heading-main">
          <h1>Buyers</h1>
          {isDemo && <span className="demo-pill">Demo data</span>}
        </div>
        <p className="buyers-sub">Public buyers across your tracked tenders and award history. Open a buyer for their tenders and what they have awarded before.</p>
      </header>

      <section className="tracker-toolbar" aria-label="Buyer filters">
        <input aria-label="Search buyers" placeholder="Search buyer names" value={query} onChange={(event) => setQuery(event.target.value)} />
      </section>

      {state === "loading" && <p className="superset-status" role="status">Loading the buyer directory…</p>}
      {state === "error" && (
        <div className="criteria-warning superset-error" role="alert">
          {error || "Could not load buyers."} <button className="text-action" onClick={onRetry}>Retry</button>
        </div>
      )}

      {state === "ready" && (
        <div className="tender-table buyers-table" role="table" aria-label="Buyers">
          <div className="tt-head buyers-head" role="row">
            <span role="columnheader">Buyer</span>
            <span role="columnheader">Active</span>
            <span role="columnheader">Tracked</span>
            <span role="columnheader">Awards</span>
            <span role="columnheader">Awarded value</span>
          </div>
          {visible.map((buyer) => (
            <div className="tt-row buyers-row" role="row" key={buyer.name} tabIndex={0}
              onClick={() => onOpen(buyer.name)}
              onKeyDown={(event) => { if (event.key === "Enter") onOpen(buyer.name); }}>
              <span className="tt-title" role="cell"><strong>{buyer.name}</strong></span>
              <span role="cell" className="buyers-num">{buyer.activeTenders}</span>
              <span role="cell" className="buyers-num">{buyer.trackedTenders}</span>
              <span role="cell" className="buyers-num">{buyer.awards}</span>
              <span role="cell" className="tt-value">{buyer.awardedValue ?? "—"}</span>
            </div>
          ))}
          {visible.length === 0 && (
            <div className="empty-state">
              <span>◈</span>
              <h3>{items.length === 0 ? "No buyers yet" : "No buyers match that search"}</h3>
              <p>{items.length === 0 ? "Sync tenders and the buyer directory builds itself from what arrives." : "Try a shorter name or a different spelling."}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** One buyer: everything the workspace tracks for them, plus award history. */
export function BuyerProfileView({ profile, state, error, onBack, onOpenTender, isDemo }: {
  profile: BuyerProfile | null;
  state: "loading" | "ready" | "error";
  error?: string;
  onBack: () => void;
  onOpenTender: (id: string) => void;
  isDemo: boolean;
}) {
  const intelligence = asAwardIntelligence(profile?.intelligence);
  return (
    <div className="buyers-page buyer-profile">
      <button className="tracker-back" onClick={onBack}>← Back to buyers</button>

      {state === "loading" && <p className="superset-status" role="status">Loading buyer profile…</p>}
      {state === "error" && (
        <div className="no-questions panel" data-testid="buyer-not-found">
          <span>◈</span>
          <h2>That buyer could not be found</h2>
          <p>{error || "The buyer may not appear in your tracked tenders or award history yet."}</p>
          <button className="continue-btn" onClick={onBack}>Back to buyers</button>
        </div>
      )}

      {state === "ready" && profile && (
        <>
          <header className="tracker-heading buyers-heading">
            <div className="tracker-heading-main">
              <h1>{profile.name}</h1>
              {isDemo && <span className="demo-pill">Demo data</span>}
            </div>
            <p className="buyers-sub">{profile.tenders.length} tender{profile.tenders.length === 1 ? "" : "s"} in this workspace</p>
          </header>

          <section className="panel" data-testid="buyer-tenders">
            <div className="panel-heading"><div><h2>Their tenders</h2><p>Notices from this buyer that you are tracking or have discovered.</p></div></div>
            {profile.tenders.length === 0
              ? <p className="buyers-empty-note">No tenders from this buyer in the workspace yet.</p>
              : (
                <div className="tracker-list buyer-tender-list">
                  {profile.tenders.map((tender: Tender) => {
                    const workflow = workflowOf(tender);
                    return (
                      <article className="tracker-card buyer-tender-card" key={tender.id} data-testid={`buyer-tender-${tender.id}`}>
                        <div className="tracker-card-top"><span className="tracker-ref">CFT-{tender.resourceId}</span><MarketBadges markets={tender.markets} /></div>
                        <button className="tracker-card-title" onClick={() => onOpenTender(tender.id)}>{tender.title}</button>
                        <dl className="tracker-card-facts">
                          <div><dt>Value</dt><dd>{tender.value}</dd></div>
                          <div><dt>Closes</dt><dd>{tender.deadline}</dd></div>
                          <div><dt>Stage</dt><dd>{workflow.stage === "DONE" ? (workflow.outcome === "WON" ? "Won" : workflow.outcome === "NOT_WON" ? "Not won" : "Done") : workflow.stage.toLowerCase()}</dd></div>
                        </dl>
                      </article>
                    );
                  })}
                </div>
              )}
          </section>

          <section className="panel gate-panel" data-testid="buyer-intelligence">
            <div className="panel-heading"><div><h2>Award intelligence</h2><p>Past awards by this authority from published data. Counts, not estimates.</p></div></div>
            {!intelligence || intelligence.awards === 0 ? (
              <p className="input-needed" data-testid="no-buyer-awards">No award history loaded for this buyer</p>
            ) : (
              <>
                {intelligence.relatedCpv && <p className="criteria-warning">Based on the wider CPV division, not the exact code</p>}
                <div className="award-stats">
                  <span><strong>{intelligence.awards}</strong><small>awards</small></span>
                  <span><strong>{euro(intelligence.medianValue)}</strong><small>median value</small></span>
                  <span><strong>{euro(intelligence.minValue)} – {euro(intelligence.maxValue)}</strong><small>range</small></span>
                </div>
                {intelligence.topSuppliers.length > 0 && (
                  <ul className="supplier-list">
                    {intelligence.topSuppliers.map((supplier) => <li key={supplier.supplier}><strong>{supplier.supplier}</strong><small>{supplier.awards} award{supplier.awards === 1 ? "" : "s"}</small></li>)}
                  </ul>
                )}
                {(intelligence.companyAwards ?? 0) > 0 && (
                  <p className="you-won">Your company appears in this history — {intelligence.companyAwards} award{(intelligence.companyAwards ?? 0) > 1 ? "s" : ""}</p>
                )}
              </>
            )}
            {intelligence?.licenceNote && <small className="licence-note">{intelligence.licenceNote}</small>}
          </section>
        </>
      )}
    </div>
  );
}
