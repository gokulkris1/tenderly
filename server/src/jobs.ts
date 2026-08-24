import { discoverETenders } from "./etenders.js";
import { getPreferences, knownBuyersFor, listAllCompanies, saveNotification } from "./db.js";
import { scoreNotice } from "./scoring.js";

export async function runDiscoveryJob() {
  const opportunities = await discoverETenders("", { maxPages: Math.max(1, Math.min(Number(process.env.ETENDERS_MAX_PAGES || 2), 4)) });
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
  return { opportunitiesChecked: opportunities.length, companyProfilesChecked: companies.length, matchesStored: createdOrUpdated, threshold };
}
