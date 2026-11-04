/**
 * EU market (country) scope: the ISO alpha-3 list Tenderly can watch, the
 * checkbox-chip picker used by Settings and board creation, and the small
 * badges shown on tender cards for non-domestic notices.
 */

export const EU_MARKETS: { code: string; label: string }[] = [
  { code: "IRL", label: "Ireland" },
  { code: "GBR", label: "United Kingdom" },
  { code: "FRA", label: "France" },
  { code: "DEU", label: "Germany" },
  { code: "ESP", label: "Spain" },
  { code: "ITA", label: "Italy" },
  { code: "NLD", label: "Netherlands" },
  { code: "BEL", label: "Belgium" },
  { code: "POL", label: "Poland" },
  { code: "SWE", label: "Sweden" },
];

/** The workspace default when nothing has been chosen yet. */
export const DEFAULT_MARKETS = ["IRL"];

export function marketLabel(code: string): string {
  return EU_MARKETS.find((market) => market.code === code)?.label ?? code;
}

/**
 * Badges are only worth pixels when a notice reaches beyond the home market:
 * an all-Ireland notice is the default and says nothing new.
 */
export function showMarketBadges(markets?: string[]): boolean {
  return Boolean(markets && markets.length > 0 && !(markets.length === 1 && markets[0] === "IRL"));
}

export function MarketBadges({ markets }: { markets?: string[] }) {
  if (!showMarketBadges(markets)) return null;
  return (
    <span className="market-badges" aria-label={`Markets: ${(markets ?? []).map(marketLabel).join(", ")}`}>
      {(markets ?? []).map((code) => <i key={code} className="market-badge" title={marketLabel(code)}>{code}</i>)}
    </span>
  );
}

export function MarketScopePicker({ value, onChange, disabled, label }: {
  value: string[];
  onChange: (markets: string[]) => void;
  disabled?: boolean;
  /** Accessible description of what the scope applies to. */
  label: string;
}) {
  const selected = new Set(value);
  const allSelected = EU_MARKETS.every((market) => selected.has(market.code));
  const toggle = (code: string) =>
    onChange(selected.has(code) ? value.filter((item) => item !== code) : [...value, code]);
  return (
    <div className="market-scope" role="group" aria-label={label}>
      {EU_MARKETS.map((market) => (
        <label key={market.code} className={selected.has(market.code) ? "market-chip selected" : "market-chip"} data-testid={`market-${market.code}`}>
          <input type="checkbox" checked={selected.has(market.code)} disabled={disabled} onChange={() => toggle(market.code)} />
          <span title={market.label}>{market.code}</span>
        </label>
      ))}
      <button
        type="button"
        className="quiet-btn market-all"
        aria-pressed={allSelected}
        disabled={disabled}
        onClick={() => onChange(allSelected ? [...DEFAULT_MARKETS] : EU_MARKETS.map((market) => market.code))}
      >All EU</button>
    </div>
  );
}
