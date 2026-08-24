import { discoverETenders } from "./etenders.js";
import { getPreferences, knownBuyersFor, listAllCompanies, recentIngestionYields, recordIngestionRun, saveNotification } from "./db.js";
import { scoreNotice } from "./scoring.js";
import { assessRun, fieldCoverage } from "./ingestion-health.js";
import { searchTed } from "./sources/ted.js";
import type { PublicTender } from "./types.js";

/**
 * Reads each source, records what it yielded, and matches the results against
 * every account's profile.
 *
 * The yield is recorded per source before any matching happens: a collapse in
 * what a portal returns is a fact about the portal, not about anyone's
 * preferences, and it must be visible even when nobody's profile matches.
 */
export async function runDiscoveryJob() {
  const maxPages = Math.max(1, Math.min(Number(process.env.ETENDERS_MAX_PAGES || 2), 4));
  const sources: { source: string; notices: PublicTender[]; seen: number }[] = [];

  // One source failing must not hide what the other yielded.
  const [etenders, ted] = await Promise.allSettled([
    discoverETenders("", { maxPages }),
    searchTed({ limit: 40 }),
  ]);
  const etendersItems = etenders.status === "fulfilled" ? etenders.value : [];
  const tedItems = ted.status === "fulfilled" ? ted.value.items : [];
  sources.push({ source: "etenders", notices: etendersItems, seen: etendersItems.length });
  sources.push({ source: "ted", notices: tedItems, seen: tedItems.length });

  const alarms: string[] = [];
  for (const entry of sources) {
    const coverage = fieldCoverage(entry.notices);
    const history = await recentIngestionYields(entry.source);
    const verdict = assessRun({
      source: entry.source,
      noticesParsed: entry.notices.length,
      fieldCoverage: coverage,
      history,
    });
    alarms.push(...verdict.alarms);
    await recordIngestionRun({
      source: entry.source,
      noticesSeen: entry.seen,
      noticesParsed: entry.notices.length,
      fieldCoverage: coverage,
      alarms: verdict.alarms,
    });
  }

  const opportunities = [...etendersItems, ...tedItems];
  const companies = await listAllCompanies();
  const threshold = Math.max(0, Math.min(100, Number(process.env.TENDERLY_DISCOVERY_MIN_SCORE || 45)));
  let createdOrUpdated = 0;
  for (const { accountId, company } of companies) {
    const preferences = await getPreferences(accountId);
    const knownBuyers = await knownBuyersFor(company.name).catch(() => [] as string[]);
    for (const tender of opportunities) {
      // The breakdown is stored with the notification, so the Discover list can
      // explain a score without recomputing it against a profile that may have
      // changed since — the number and its reasons stay consistent.
      const breakdown = scoreNotice({ tender, preferences, company, knownBuyers });
      if (breakdown.total < threshold) continue;
      await saveNotification(accountId, tender.externalId, tender.title, tender.sourceUrl, breakdown.total, {
        ...(tender as unknown as Record<string, unknown>),
        scoreBreakdown: breakdown,
      });
      createdOrUpdated += 1;
    }
  }

  return {
    opportunitiesChecked: opportunities.length,
    companyProfilesChecked: companies.length,
    matchesStored: createdOrUpdated,
    threshold,
    sources: sources.map((entry) => ({ source: entry.source, parsed: entry.notices.length })),
    alarms,
    healthy: alarms.length === 0,
  };
}
