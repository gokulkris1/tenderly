import { cpvFromDetail, discoverETenders, fetchNoticeDetail } from "./etenders.js";
import { getPreferences, knownBuyersFor, listAllCompanies, listTenderBoards, listTenders, recentIngestionYields, recordIngestionRun, saveNotification, upsertTender } from "./db.js";
import { scoreNotice } from "./scoring.js";
import { assessRun, fieldCoverage } from "./ingestion-health.js";
import { decideIngest } from "./ingest.js";
import { log } from "./logging.js";
import { cpvCountryQuery, searchAllTed } from "./sources/ted.js";
import type { DiscoveryPreferences, PublicTender } from "./types.js";
import type { TenderBoardConfig } from "@tenderly/shared";

/**
 * Reads each source, records what it yielded, and matches the results against
 * every account's profile.
 *
 * The yield is recorded per source before any matching happens: a collapse in
 * what a portal returns is a fact about the portal, not about anyone's
 * preferences, and it must be visible even when nobody's profile matches.
 */
/** A rejection reason as something a person reading a log can act on. */
export function reasonOf(reason: unknown) {
  if (reason instanceof Error) return reason.message || reason.name;
  const text = String(reason ?? "").trim();
  return text || "no reason given";
}

/**
 * The markets an account watches: the workspace countries plus any board's
 * own list. A board with no countries of its own watches the workspace's,
 * which are already in the union.
 */
export function accountCountries(preferences: Pick<DiscoveryPreferences, "countries">, boards: Pick<TenderBoardConfig, "countries">[]): string[] {
  const countries = [...new Set([...(preferences.countries ?? ["IRL"]), ...boards.flatMap((board) => board.countries ?? [])])];
  return countries.length ? countries : ["IRL"];
}

/** A fresh notice belongs to the account only when one of its markets is watched. */
export function marketsWatched(tender: Pick<PublicTender, "markets">, countries: string[]) {
  if (!tender.markets?.length) return true; // no market data is not a reason to hide a notice
  return tender.markets.some((market) => countries.includes(market));
}

/**
 * The Discover list as the account may see it.
 *
 * A dismissed notice stays dismissed however well it scores, and a notice
 * performed only in markets the workspace does not watch is not its
 * opportunity. `sourceOf` names the portal in the lowercase form dismissals
 * are stored in.
 */
export function visibleNotices<T extends { externalId: string; markets?: string[] }>(
  items: T[],
  options: {
    dismissals: { externalId: string; source: string }[];
    sourceOf: (item: T) => string;
    countries: string[];
  },
): T[] {
  const dismissed = new Set(options.dismissals.map((entry) => `${entry.source}:${entry.externalId}`));
  return items.filter((item) => {
    if (dismissed.has(`${options.sourceOf(item)}:${item.externalId}`)) return false;
    return marketsWatched(item, options.countries);
  });
}

export async function runDiscoveryJob(onlyAccountId?: string) {
  const sources: { source: string; notices: PublicTender[]; seen: number }[] = [];
  const companies = (await listAllCompanies()).filter((entry) => !onlyAccountId || entry.accountId === onlyAccountId);
  const profiles = await Promise.all(companies.map(async (entry) => ({
    ...entry, preferences: await getPreferences(entry.accountId), existing: await listTenders(entry.accountId), boards: await listTenderBoards(entry.accountId),
  })));
  // TED serves the whole EU: one query covers the union of every account's
  // markets, and each account then keeps only what its own configuration asks
  // for. eTenders publishes Irish competitions regardless.
  const allCountries = [...new Set(profiles.flatMap(({ preferences, boards }) => accountCountries(preferences, boards)))];
  const cpvCodes = [...new Set(profiles.flatMap(({ preferences, company, boards }) => [
    ...boards.flatMap((board) => board.cpvCodes), ...preferences.cpvCodes,
    ...(String(company.cpv ?? "").match(/\b\d{8}\b/g) ?? []),
  ]))];
  if (!profiles.length) return { opportunitiesChecked: 0, companyProfilesChecked: 0, matchesStored: 0, tendersIngested: 0, accountsSkipped: 0, enriched: 0, enrichmentDeferred: 0, threshold: 0, sources: [], alarms: [], healthy: true };

  // One source failing must not hide what the other yielded.
  const [etenders, ted] = await Promise.allSettled([
    discoverETenders("", { cpvCodes }),
    searchAllTed({ query: cpvCountryQuery(cpvCodes, allCountries) }),
  ]);
  const etendersItems = etenders.status === "fulfilled" ? etenders.value : [];
  const tedItems = ted.status === "fulfilled" ? ted.value.items : [];
  // Why a source yielded nothing, not merely that it did.
  //
  // These two lines used to discard the rejection reason, so a portal that was
  // down read exactly like a quiet morning: the run recorded `parsed: 0` and an
  // alarm saying the count was below the floor, and nothing anywhere said the
  // fetch had failed or how. That happened in production on 2026-10-05 —
  // eTenders returned nothing, the run ended in 8.8 seconds where a normal one
  // takes minutes, and the log held no cause at all.
  const failures = new Map<string, string>();
  if (etenders.status === "rejected") failures.set("etenders", reasonOf(etenders.reason));
  if (ted.status === "rejected") failures.set("ted", reasonOf(ted.reason));
  if (ted.status === "fulfilled" && ted.value.warnings.length) failures.set("ted", ted.value.warnings.join("; "));

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
    // First, and in its own words: a failed fetch is the reason for every other
    // alarm this source will raise, and it reads as the cause rather than as a
    // symptom. Persisted with the run, so it survives log retention and shows
    // up on /health.
    const failure = failures.get(entry.source);
    const sourceAlarms = failure
      ? [`${entry.source}: the source could not be read — ${failure}`, ...verdict.alarms]
      : verdict.alarms;
    if (failure) log("error", { job: "discovery", source: entry.source, event: "source-unreadable", message: failure });
    alarms.push(...sourceAlarms);
    await recordIngestionRun({
      source: entry.source,
      noticesSeen: entry.seen,
      noticesParsed: entry.notices.length,
      fieldCoverage: coverage,
      alarms: sourceAlarms,
    });
  }

  const opportunities = [...etendersItems, ...tedItems];
  const threshold = Math.max(0, Math.min(100, Number(process.env.TENDERLY_DISCOVERY_MIN_SCORE || 45)));

  // Enrich every matching CFT, including tracked records no longer in the open listing.
  const tracked = profiles.flatMap(({ existing }) => existing.filter((record) => record.source === "etenders"));
  const enrichment = await enrichWithCpv([...new Map([...etendersItems, ...tracked].map((item) => [item.externalId, item])).values()]);
  if (enrichment.failed) alarms.push(`${enrichment.failed} CFT detail pages could not be refreshed; retry discovery`);

  let createdOrUpdated = 0;
  let tendersIngested = 0;
  let accountsSkipped = 0;
  for (const { accountId, company, preferences, existing, boards } of profiles) {

    // An account that has set no CPV codes, no sectors and no keywords has told
    // us nothing to match against, so every notice would be scored and written
    // for no one's benefit. The first production run spent forty-six minutes
    // doing exactly that for three abandoned test accounts and had its database
    // connection dropped before it ever reached the real one.
    const profileCpvCodes = [
      ...boards.flatMap((board) => board.cpvCodes),
      ...preferences.cpvCodes,
      ...String(company.cpv ?? "").split(/[^0-9]+/).filter((value) => value.length === 8),
    ];
    if (!profileCpvCodes.length && !preferences.sectors.length && !preferences.keywords.length) {
      accountsSkipped += 1;
      continue;
    }
    const knownBuyers = await knownBuyersFor(company.name).catch(() => [] as string[]);
    const alreadyOnBoard = new Map(existing.map((record) => [record.externalId, record]));
    const accountOpportunities = [...new Map([...existing, ...opportunities].map((item) => [item.externalId, item])).values()];
    const watched = accountCountries(preferences, boards);

    for (const tender of accountOpportunities) {
      const enriched = enrichment.byExternalId.get(tender.externalId);
      const prior = alreadyOnBoard.get(tender.externalId);
      // A notice performed only in markets this account does not watch is not
      // ingested for it. Records already on the board are refreshed regardless —
      // they were chosen deliberately, and a preference change must not drop work.
      if (!prior && !marketsWatched(tender, watched)) continue;
      const notice = enriched?.detail ?? tender;
      // The breakdown is stored with the notification, so the Discover list can
      // explain a score without recomputing it against a profile that may have
      // changed since — the number and its reasons stay consistent.
      const breakdown = scoreNotice({ tender: notice, preferences, company, knownBuyers });
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
      const verdict = decideIngest({
        deadline: notice.deadline,
        noticeCpv: enriched?.cpv ?? (tender.sourceUrl.includes("ted.europa.eu") ? tender.description : null),
        profileCpvCodes,
        score: !enriched && etendersItems.some((item) => item.externalId === tender.externalId) ? threshold : breakdown.total,
        threshold,
      });
      if (!prior && !verdict.ingest) continue;
      if (prior && prior.source === "etenders" && !enriched) continue;

      const saved = await upsertTender(accountId, {
        source: prior?.source ?? (tender.sourceUrl.includes("etenders.gov.ie") ? "etenders" : tender.sourceUrl.includes("ted.europa.eu") ? "ted" : "discovery"),
        externalId: tender.externalId,
        title: notice.title,
        authority: notice.authority,
        procedure: enriched?.detail.procedure || tender.procedure,
        deadline: enriched?.detail.deadline || tender.deadline,
        estimatedValue: enriched?.detail.estimatedValue || tender.estimatedValue,
        description: enriched?.detail.description || tender.description,
        sourceUrl: tender.sourceUrl,
        published: enriched?.detail.published || tender.published,
        status: "IMPORTED",
        metadata: {
          ...(enriched?.detail.metadata ?? {}),
          ...(enriched ? { sourceText: enriched.detail.sourceText } : {}),
          ...(tender.markets?.length ? { markets: tender.markets } : {}),
          refreshWarnings: enriched || !tender.sourceUrl.includes("etenders.gov.ie") ? [] : ["CFT detail refresh failed. This card was kept from the matching CPV listing; verify its source details and retry sync."],
          ...(!enriched && tender.sourceUrl.includes("ted.europa.eu") ? { "CPV Codes": tender.description } : {}),
          scoreBreakdown: breakdown,
          ingestReason: !enriched && tender.sourceUrl.includes("etenders.gov.ie") ? "Matched configured CPV search; CFT detail verification pending" : verdict.reason,
          matchedCpv: verdict.matchedCpv ?? "",
          deadlineUnknown: verdict.deadlineUnknown ?? false,
          ingestedAt: new Date().toISOString(),
        },
      });
      alreadyOnBoard.set(tender.externalId, saved);
      tendersIngested += 1;
    }
  }

  return {
    opportunitiesChecked: opportunities.length,
    companyProfilesChecked: companies.length,
    matchesStored: createdOrUpdated,
    tendersIngested,
    accountsSkipped,
    enriched: enrichment.enriched,
    enrichmentDeferred: enrichment.deferred,
    threshold,
    sources: sources.map((entry) => ({ source: entry.source, parsed: entry.notices.length })),
    alarms,
    healthy: alarms.length === 0,
  };
}

/** Read all CFT details at a polite rate; failures are reported for retry. */
export async function enrichWithCpv(notices: PublicTender[]) {
  const byExternalId = new Map<string, { cpv: string | null; detail: Awaited<ReturnType<typeof fetchNoticeDetail>> }>();
  const delayMs = Math.max(200, Number(process.env.ETENDERS_REQUEST_DELAY_MS ?? 850));
  let enriched = 0;
  let failed = 0;

  const queue = notices;
  for (const notice of queue) {
    try {
      const detail = await fetchNoticeDetail(notice.externalId);
      byExternalId.set(notice.externalId, { cpv: cpvFromDetail(detail), detail });
      enriched += 1;
    } catch (error) {
      failed += 1;
      log("error", { job: "discovery", step: "enrichment", externalId: notice.externalId, message: reasonOf(error) });
    }
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  const deferred = Math.max(0, notices.length - queue.length);
  if (failed || deferred) log("info", { job: "discovery", step: "enrichment", enriched, failed, deferred });
  return { byExternalId, enriched, deferred, failed };
}
