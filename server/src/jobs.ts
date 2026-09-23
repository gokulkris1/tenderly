import { cpvFromDetail, discoverETenders, fetchNoticeDetail } from "./etenders.js";
import { getPreferences, knownBuyersFor, listAllCompanies, listTenders, recentIngestionYields, recordIngestionRun, saveNotification, upsertTender } from "./db.js";
import { scoreNotice } from "./scoring.js";
import { assessRun, fieldCoverage } from "./ingestion-health.js";
import { decideIngest } from "./ingest.js";
import { log } from "./logging.js";
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
  const sources: { source: string; notices: PublicTender[]; seen: number }[] = [];

  // One source failing must not hide what the other yielded.
  const [etenders, ted] = await Promise.allSettled([
    // No page count is passed. The job used to cap this at four pages, which
    // silently overrode the date window and meant a run read forty notices out
    // of the twenty-one thousand eTenders holds — and since roughly one IT
    // tender is published a day against twenty-five of everything else, a
    // four-page read found none of them. How far back to read is a date
    // decision now, and discoverETenders owns it.
    discoverETenders(""),
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

  // The CPV that decides whether a tender belongs on anyone's board is published
  // only on the notice's own page, so the listing has to be enriched before any
  // of it can be matched. Capped, because the first run meets the whole open
  // list and the portal should not be asked for all of it at once.
  const enrichment = await enrichWithCpv(etendersItems);

  let createdOrUpdated = 0;
  let tendersIngested = 0;
  for (const { accountId, company } of companies) {
    const preferences = await getPreferences(accountId);
    const knownBuyers = await knownBuyersFor(company.name).catch(() => [] as string[]);
    // Read once per account rather than per notice. Re-upserting a tender that
    // is already on the board would reset its status, and a bid the owner had
    // moved to Pursuing would quietly go back to being an unread notice.
    const alreadyOnBoard = new Set((await listTenders(accountId)).map((record) => record.externalId));
    const profileCpvCodes = [
      ...preferences.cpvCodes,
      ...String(company.cpv ?? "").split(/[^0-9]+/).filter((value) => value.length === 8),
    ];

    for (const tender of opportunities) {
      // The breakdown is stored with the notification, so the Discover list can
      // explain a score without recomputing it against a profile that may have
      // changed since — the number and its reasons stay consistent.
      const breakdown = scoreNotice({ tender, preferences, company, knownBuyers });
      if (breakdown.total >= threshold) {
        await saveNotification(accountId, tender.externalId, tender.title, tender.sourceUrl, breakdown.total, {
          ...(tender as unknown as Record<string, unknown>),
          scoreBreakdown: breakdown,
        });
        createdOrUpdated += 1;
      }

      // A notification is something to look at; a tender is something to work
      // on. Only the second one puts the morning board together, which is what
      // the 05:00 run exists to do.
      const enriched = enrichment.byExternalId.get(tender.externalId);
      const verdict = decideIngest({
        deadline: tender.deadline,
        noticeCpv: enriched?.cpv ?? null,
        profileCpvCodes,
        score: breakdown.total,
        threshold,
      });
      if (!verdict.ingest || alreadyOnBoard.has(tender.externalId)) continue;

      await upsertTender(accountId, {
        source: enriched ? "etenders" : "discovery",
        externalId: tender.externalId,
        title: tender.title,
        authority: tender.authority,
        procedure: enriched?.detail.procedure || tender.procedure,
        deadline: enriched?.detail.deadline || tender.deadline,
        estimatedValue: enriched?.detail.estimatedValue || tender.estimatedValue,
        description: enriched?.detail.description || tender.description,
        sourceUrl: tender.sourceUrl,
        published: enriched?.detail.published || tender.published,
        status: "IMPORTED",
        metadata: {
          ...(enriched?.detail.metadata ?? {}),
          scoreBreakdown: breakdown,
          ingestReason: verdict.reason,
          matchedCpv: verdict.matchedCpv ?? "",
          deadlineUnknown: verdict.deadlineUnknown ?? false,
          ingestedAt: new Date().toISOString(),
        },
      });
      alreadyOnBoard.add(tender.externalId);
      tendersIngested += 1;
    }
  }

  return {
    opportunitiesChecked: opportunities.length,
    companyProfilesChecked: companies.length,
    matchesStored: createdOrUpdated,
    tendersIngested,
    enriched: enrichment.enriched,
    enrichmentDeferred: enrichment.deferred,
    threshold,
    sources: sources.map((entry) => ({ source: entry.source, parsed: entry.notices.length })),
    alarms,
    healthy: alarms.length === 0,
  };
}

/** How many notice detail pages one run will fetch before leaving the rest for the next. */
const ENRICHMENT_CAP = Math.max(1, Number(process.env.TENDERLY_ENRICHMENT_CAP || 60));

/**
 * Reads each notice's CPV from its own page.
 *
 * A page that will not load leaves the notice in place with no CPV rather than
 * dropping it: a tender missed because a request timed out is a tender missed,
 * and the score still gets its chance to include it.
 */
async function enrichWithCpv(notices: PublicTender[]) {
  const byExternalId = new Map<string, { cpv: string | null; detail: Awaited<ReturnType<typeof fetchNoticeDetail>> }>();
  const delayMs = Math.max(200, Number(process.env.ETENDERS_REQUEST_DELAY_MS ?? 850));
  let enriched = 0;
  let failed = 0;

  const queue = notices.slice(0, ENRICHMENT_CAP);
  for (const notice of queue) {
    try {
      const detail = await fetchNoticeDetail(notice.externalId);
      byExternalId.set(notice.externalId, { cpv: cpvFromDetail(detail), detail });
      enriched += 1;
    } catch {
      failed += 1;
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  const deferred = Math.max(0, notices.length - queue.length);
  if (failed || deferred) log("info", { job: "discovery", step: "enrichment", enriched, failed, deferred });
  return { byExternalId, enriched, deferred };
}
