import { discoverETenders, scoreTenderPreview } from "./etenders.js";
import { listAllCompanies, saveNotification } from "./db.js";

export async function runDiscoveryJob() {
  const opportunities = await discoverETenders("", { maxPages: Math.max(1, Math.min(Number(process.env.ETENDERS_MAX_PAGES || 2), 4)) });
  const companies = await listAllCompanies();
  const threshold = Math.max(0, Math.min(100, Number(process.env.TENDERLY_DISCOVERY_MIN_SCORE || 45)));
  let createdOrUpdated = 0;
  for (const { accountId, company } of companies) {
    const profileText = `${company.services} ${company.cpv} ${company.certifications}`;
    for (const tender of opportunities) {
      const score = scoreTenderPreview(tender, profileText);
      if (score < threshold) continue;
      await saveNotification(accountId, tender.externalId, tender.title, tender.sourceUrl, score, tender as unknown as Record<string, unknown>);
      createdOrUpdated += 1;
    }
  }
  return { opportunitiesChecked: opportunities.length, companyProfilesChecked: companies.length, matchesStored: createdOrUpdated, threshold };
}
