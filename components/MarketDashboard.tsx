import type { CompetitorInsight, MarketStats } from "@tenderly/shared";

/**
 * The market around the workspace: what is open, what is closing, which CPV
 * divisions and buyers dominate, and — once the OGP award dataset is loaded —
 * who else keeps winning the work you bid for.
 *
 * Every figure is computed from stored data. Where a dataset has not been
 * loaded, the panel says so instead of showing an empty chart that looks
 * like a quiet market.
 */
export function MarketDashboard({ stats, competitors, state, error, onRetry, onOpenBuyer, isDemo }: {
  stats: MarketStats | null;
  competitors: CompetitorInsight[] | null;
  state: "loading" | "ready" | "error";
  error?: string;
  onRetry: () => void;
  onOpenBuyer: (name: string) => void;
  isDemo: boolean;
}) {
  const maxDivision = Math.max(0, ...(stats?.byDivision ?? []).map((division) => division.count));
  const bandTotal = stats ? stats.valueBands.under + stats.valueBands.over + stats.valueBands.unknown : 0;
  const sourceTotal = stats ? stats.sources.etenders + stats.sources.ted : 0;

  return (
    <div className="market-page">
      <header className="tracker-heading buyers-heading">
        <div className="tracker-heading-main">
          <h1>Market</h1>
          {isDemo && <span className="demo-pill">Demo data</span>}
        </div>
        <p className="buyers-sub">The public-procurement market around your CPV profile, computed from your tracked tenders and discovery data.</p>
      </header>

      {state === "loading" && <p className="superset-status" role="status">Computing market statistics…</p>}
      {state === "error" && (
        <div className="criteria-warning superset-error" role="alert">
          {error || "Could not compute market statistics."} <button className="text-action" onClick={onRetry}>Retry</button>
        </div>
      )}

      {state === "ready" && stats && (
        <>
          <section className="market-stat-cards" aria-label="Market totals">
            <div className="stat-card"><strong>{stats.active}</strong><span>Active notices</span></div>
            <div className="stat-card"><strong>{stats.newThisWeek}</strong><span>New this week</span></div>
            <div className="stat-card"><strong>{stats.closingSoon.in7}</strong><span>Closing ≤ 7 days</span></div>
            <div className="stat-card"><strong>{stats.closingSoon.in14}</strong><span>Closing ≤ 14 days</span></div>
            <div className="stat-card"><strong>{stats.closingSoon.in30}</strong><span>Closing ≤ 30 days</span></div>
          </section>

          <div className="market-grid">
            <section className="panel" data-testid="market-divisions">
              <div className="panel-heading"><div><h2>CPV divisions</h2><p>Where the open notices sit, by 2-digit division.</p></div></div>
              {stats.byDivision.length === 0
                ? <p className="buyers-empty-note">No division data yet — sync tenders to populate this.</p>
                : (
                  <ul className="division-bars">
                    {stats.byDivision.map((division) => (
                      <li key={division.code}>
                        <span className="division-label" title={division.label}><strong>{division.code}</strong> {division.label}</span>
                        <span className="division-bar"><i style={{ width: `${maxDivision ? Math.max(4, Math.round((division.count / maxDivision) * 100)) : 0}%` }} /></span>
                        <span className="division-count">{division.count}</span>
                      </li>
                    ))}
                  </ul>
                )}
            </section>

            <section className="panel" data-testid="market-top-buyers">
              <div className="panel-heading"><div><h2>Most active buyers</h2><p>Buyers with the most notices in your data.</p></div></div>
              {stats.topBuyers.length === 0
                ? <p className="buyers-empty-note">No buyers yet — sync tenders to populate this.</p>
                : (
                  <ul className="top-buyer-list">
                    {stats.topBuyers.map((buyer) => (
                      <li key={buyer.name}>
                        <button className="buyer-link" onClick={() => onOpenBuyer(buyer.name)}>{buyer.name}</button>
                        <span>{buyer.count} notice{buyer.count === 1 ? "" : "s"}</span>
                      </li>
                    ))}
                  </ul>
                )}
            </section>

            <section className="panel" data-testid="market-values">
              <div className="panel-heading"><div><h2>Contract values</h2><p>Split at EUR 200,000 (inclusive in the lower band). Notices without a stated value stay visible.</p></div></div>
              {bandTotal === 0
                ? <p className="buyers-empty-note">No value data yet.</p>
                : (
                  <ul className="market-splits">
                    <li><span>Up to EUR 200k</span><b>{stats.valueBands.under}</b></li>
                    <li><span>Above EUR 200k</span><b>{stats.valueBands.over}</b></li>
                    <li><span>Value not stated</span><b>{stats.valueBands.unknown}</b></li>
                  </ul>
                )}
            </section>

            <section className="panel" data-testid="market-sources">
              <div className="panel-heading"><div><h2>Sources</h2><p>Where the notices were published.</p></div></div>
              {sourceTotal === 0
                ? <p className="buyers-empty-note">No source data yet.</p>
                : (
                  <ul className="market-splits">
                    <li><span>eTenders</span><b>{stats.sources.etenders}</b></li>
                    <li><span>TED</span><b>{stats.sources.ted}</b></li>
                  </ul>
                )}
            </section>
          </div>

          <section className="panel" data-testid="market-competitors">
            <div className="panel-heading">
              <div><h2>Competitors</h2><p>Suppliers winning awards in your CPV families, from the published OGP award dataset.</p></div>
            </div>
            {competitors === null
              ? <p className="superset-status" role="status">Loading competitor history…</p>
              : competitors.length === 0
                ? (
                  <div className="market-competitors-empty" data-testid="competitors-empty">
                    <strong>Load the OGP award dataset to see competitor history</strong>
                    <p>Competitor insight is computed only from real award records. Import the published OGP awards with <code>npm run import:ogp</code> and this panel fills itself in — until then there is nothing honest to show.</p>
                  </div>
                )
                : (
                  <div className="tender-table competitors-table" role="table" aria-label="Competitors">
                    <div className="tt-head competitors-head" role="row">
                      <span role="columnheader">Supplier</span>
                      <span role="columnheader">Wins</span>
                      <span role="columnheader">Total value</span>
                      <span role="columnheader">Last win</span>
                      <span role="columnheader">Buyers</span>
                    </div>
                    {competitors.map((competitor) => (
                      <div className="tt-row competitors-row" role="row" key={competitor.supplier}>
                        <span className="tt-title" role="cell"><strong>{competitor.supplier}</strong></span>
                        <span role="cell" className="buyers-num">{competitor.wins}</span>
                        <span role="cell" className="tt-value">{competitor.totalValue ?? "—"}</span>
                        <span role="cell">{competitor.lastWin ?? "—"}</span>
                        <span role="cell" className="competitor-buyers">{competitor.buyers.join(", ")}</span>
                      </div>
                    ))}
                  </div>
                )}
          </section>

          <p className="tracker-help">Computed from stored data at {new Date(stats.generatedAt).toLocaleString()}.</p>
        </>
      )}
    </div>
  );
}
