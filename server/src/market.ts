import type { BuyerSummary, MarketStats } from "@tenderly/shared";
import { allCpvCodes, extractCpvCode } from "./cpv.js";
import { buyerAwardTotals, listNotifications, listTenders } from "./db.js";
import { deadlineInstant, parseDeadline } from "./pressure.js";
import { parseContractValue } from "./scoring.js";
import { tenderWorkflow } from "./tender-workflow.js";
import type { TenderRecord } from "./types.js";

/**
 * The market overview: what the workspace can see, counted from what is
 * actually stored.
 *
 * Every figure is a count over real rows — tracked tenders and the discovery
 * notifications the runs recorded — never a model's narration and never a
 * number carried over from a competitor's website. When the store is empty
 * the answer is zeros, and the screen says why.
 */

/** CPV division labels for the divisions this dataset actually meets. */
const CPV_DIVISION_LABELS: Record<string, string> = {
  "30": "Office and computing machinery, equipment and supplies",
  "32": "Radio, television, communication and telecommunication equipment",
  "33": "Medical equipments, pharmaceuticals and personal care products",
  "34": "Transport equipment and auxiliary products to transportation",
  "45": "Construction work",
  "48": "Software package and information systems",
  "50": "Repair and maintenance services",
  "55": "Hotel, restaurant and retail trade services",
  "60": "Transport services",
  "64": "Postal and telecommunications services",
  "65": "Public utilities",
  "66": "Financial and insurance services",
  "70": "Real estate services",
  "71": "Architectural, construction, engineering and inspection services",
  "72": "IT services: consulting, software development, Internet and support",
  "73": "Research and development services and related consultancy services",
  "77": "Agricultural, forestry, horticultural, aquacultural and apicultural services",
  "79": "Business services: law, marketing, consulting, recruitment, printing and security",
  "80": "Education and training services",
  "85": "Health and social work services",
  "90": "Sewage, refuse, cleaning and environmental services",
  "92": "Recreational, cultural and sporting services",
};

let divisionDescriptions: Map<string, string> | null = null;

/** The official division description from the bundled CPV list, else the small map, else a plainly-labelled fallback. */
export function cpvDivisionLabel(division: string): string {
  divisionDescriptions ??= new Map(
    allCpvCodes().filter((entry) => /^[0-9]{2}0{6}$/.test(entry.code)).map((entry) => [entry.code.slice(0, 2), entry.description]),
  );
  return divisionDescriptions.get(division) ?? CPV_DIVISION_LABELS[division] ?? `CPV division ${division}`;
}

/** The value band the overview is grouped around: EUR 200,000, inclusive below. */
export const VALUE_BAND_THRESHOLD = 200_000;

/** Reads either portal's date spelling; null when there is nothing readable. */
function anyDate(value: unknown): Date | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const iso = new Date(value);
  if (!Number.isNaN(iso.getTime()) && /^\d{4}-\d{2}-\d{2}T/.test(value.trim())) return iso;
  return parseDeadline(value);
}

/** One row of the universe the market overview counts. */
type MarketItem = {
  key: string;
  authority: string;
  deadline: Date | null;
  published: Date | null;
  ingestedAt: Date | null;
  cpv: string | null;
  value: number | null;
  source: "etenders" | "ted";
  /** Done or ignored work is no longer part of the live market picture. */
  active: boolean;
};

function tenderItem(tender: TenderRecord): MarketItem {
  const workflow = tenderWorkflow(tender.metadata.workflow);
  const cpv = tender.cpvNormalised ?? extractCpvCode(String(tender.metadata["CPV Codes"] ?? ""));
  return {
    key: `${tender.source}:${tender.externalId}`,
    authority: tender.authority.trim(),
    deadline: deadlineInstant(tender.deadline || tender.analysis?.deadline || ""),
    published: anyDate(tender.published),
    ingestedAt: anyDate(tender.metadata.ingestedAt),
    cpv,
    value: parseContractValue(tender.estimatedValue || tender.analysis?.contractValue),
    source: tender.source === "ted" ? "ted" : "etenders",
    active: workflow.stage !== "DONE" && workflow.stage !== "IGNORE",
  };
}

function notificationItem(notification: { externalId: string; sourceUrl: string; payload: Record<string, unknown> }): MarketItem {
  const payload = notification.payload;
  const source = notification.sourceUrl.includes("ted.europa.eu") ? "ted" as const : "etenders" as const;
  return {
    key: `${source}:${notification.externalId}`,
    authority: String(payload.authority ?? "").trim(),
    deadline: deadlineInstant(String(payload.deadline ?? "")),
    published: anyDate(payload.published),
    ingestedAt: null,
    cpv: extractCpvCode(String(payload["CPV Codes"] ?? payload.description ?? "")),
    value: parseContractValue(String(payload.estimatedValue ?? "")),
    source,
    active: true,
  };
}

/**
 * The market the workspace is looking at, from its tracked tenders plus the
 * discovery notifications the runs stored. A tender that is both is counted
 * once, as the tracked record.
 */
export async function computeMarketStats(accountId: string, now = new Date()): Promise<MarketStats> {
  const [tenders, notifications] = await Promise.all([listTenders(accountId), listNotifications(accountId)]);
  const items = new Map<string, MarketItem>();
  for (const notification of notifications) {
    const item = notificationItem(notification);
    if (!items.has(item.key)) items.set(item.key, item);
  }
  for (const tender of tenders) {
    const item = tenderItem(tender);
    items.set(item.key, item);
  }

  const live = [...items.values()].filter((item) => item.active);
  const open = live.filter((item) => item.deadline === null || item.deadline >= now);
  const closing = (days: number) => open.filter((item) =>
    item.deadline !== null && item.deadline.getTime() <= now.getTime() + days * 86_400_000).length;
  const weekAgo = now.getTime() - 7 * 86_400_000;

  const divisions = new Map<string, number>();
  for (const item of open) {
    if (!item.cpv) continue;
    const division = item.cpv.slice(0, 2);
    divisions.set(division, (divisions.get(division) ?? 0) + 1);
  }

  const buyers = new Map<string, number>();
  for (const item of open) {
    if (!item.authority) continue;
    buyers.set(item.authority, (buyers.get(item.authority) ?? 0) + 1);
  }

  return {
    active: open.length,
    newThisWeek: live.filter((item) =>
      (item.published && item.published.getTime() >= weekAgo) || (item.ingestedAt && item.ingestedAt.getTime() >= weekAgo)).length,
    closingSoon: { in7: closing(7), in14: closing(14), in30: closing(30) },
    byDivision: [...divisions.entries()]
      .map(([code, count]) => ({ code, label: cpvDivisionLabel(code), count }))
      .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code)),
    topBuyers: [...buyers.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
      .slice(0, 5),
    valueBands: {
      under: open.filter((item) => item.value !== null && item.value <= VALUE_BAND_THRESHOLD).length,
      over: open.filter((item) => item.value !== null && item.value > VALUE_BAND_THRESHOLD).length,
      unknown: open.filter((item) => item.value === null).length,
    },
    sources: {
      etenders: open.filter((item) => item.source === "etenders").length,
      ted: open.filter((item) => item.source === "ted").length,
    },
    generatedAt: now.toISOString(),
  };
}

const euro = new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });

/**
 * The buyers behind the workspace's tracked tenders, with what the award
 * history records about each. Award figures come from the shared OGP dataset;
 * a buyer with none shows zero, which is a fact, not a gap in the code.
 */
export async function listBuyers(accountId: string, now = new Date()): Promise<BuyerSummary[]> {
  const tenders = await listTenders(accountId);
  const groups = new Map<string, { name: string; active: number; tracked: number }>();
  for (const tender of tenders) {
    const name = tender.authority.trim();
    if (!name) continue;
    const key = name.toLowerCase();
    const group = groups.get(key) ?? { name, active: 0, tracked: 0 };
    group.tracked += 1;
    const item = tenderItem(tender);
    if (item.active && (item.deadline === null || item.deadline >= now)) group.active += 1;
    groups.set(key, group);
  }

  const items: BuyerSummary[] = [];
  for (const group of groups.values()) {
    const totals = await buyerAwardTotals(group.name).catch(() => ({ awards: 0, totalValue: null }));
    items.push({
      name: group.name,
      activeTenders: group.active,
      trackedTenders: group.tracked,
      awards: totals.awards,
      awardedValue: totals.totalValue === null ? null : euro.format(totals.totalValue),
    });
  }
  return items.sort((a, b) => b.activeTenders - a.activeTenders || b.trackedTenders - a.trackedTenders || a.name.localeCompare(b.name));
}
