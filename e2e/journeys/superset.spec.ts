import { expect, test, type Page } from "@playwright/test";
import type { Clarification, PortalConnection, Tender } from "@tenderly/shared";

/**
 * Superset journeys: buyers directory and profiles, the market dashboard,
 * discovery match buckets and dismissal, the clarifications portal hub, the
 * portal connection card, and EU market scope. Fully mocked — no API server.
 */

const DAY = 86_400_000;

function makeTender(overrides: Partial<Tender> & { id: string }): Tender {
  return {
    resourceId: "91000", title: "Untitled notice", authority: "Example buyer",
    category: "IT services", procedure: "Open", deadline: "not stated",
    value: "Not stated", match: 0, decision: "REVIEW", access: "Not assessed",
    summary: "Summary.", published: "01/11/2026", framework: "Direct contract",
    gates: [], questions: [],
    cpv: { raw: "72212000", recognised: false },
    sourceUrl: "https://www.etenders.gov.ie/epps/cft/prepareViewCfTWS.do?resourceId=91000",
    workflow: { stage: "NEW", outcome: "PENDING", priority: "MEDIUM", assignee: "", history: [] },
    ...overrides,
  };
}

type FixtureOptions = {
  competitors?: { supplier: string; wins: number; totalValue: string | null; lastWin: string | null; buyers: string[] }[];
  portal?: PortalConnection;
  portalPutStatus?: number;
  sendStatus?: number;
};

async function supersetWorkspace(page: Page, options: FixtureOptions = {}) {
  const tenders: Tender[] = [
    makeTender({
      id: "t-1", resourceId: "91001", title: "Case management system",
      authority: "Limerick City and County Council",
      deadline: new Date(Date.now() + 12 * DAY).toLocaleDateString("en-IE"),
      deadlineIso: new Date(Date.now() + 12 * DAY).toISOString(),
      value: "EUR 180,000", valueAmount: 180000, match: 82, decision: "GO",
      markets: ["IRL"], noticeSource: "eTenders",
      messagingUrl: "https://www.etenders.gov.ie/epps/cft/prepareViewCfTWS.do?resourceId=91001",
      sourceCheckedAt: new Date(Date.now() - DAY).toISOString(),
      sourceUrl: "https://www.etenders.gov.ie/epps/cft/prepareViewCfTWS.do?resourceId=91001",
    }),
    makeTender({
      id: "t-2", resourceId: "TED-123-2026", title: "Cross-border testing services",
      authority: "Example German ministry", procedure: "Restricted",
      deadline: new Date(Date.now() + 20 * DAY).toLocaleDateString("en-IE"),
      deadlineIso: new Date(Date.now() + 20 * DAY).toISOString(),
      value: "EUR 500,000", valueAmount: 500000, match: 55,
      markets: ["DEU", "FRA"], noticeSource: "TED",
      sourceUrl: "https://ted.europa.eu/udl?uri=TED:NOTICE:123-2026:TEXT:EN:HTML",
    }),
    makeTender({
      id: "t-3", resourceId: "91003", title: "Accessibility audit",
      authority: "Limerick City and County Council",
      deadline: new Date(Date.now() + 5 * DAY).toLocaleDateString("en-IE"),
      deadlineIso: new Date(Date.now() + 5 * DAY).toISOString(),
      value: "Not stated", valueAmount: null, match: 20,
      markets: ["IRL"], noticeSource: "eTenders",
      sourceUrl: "https://www.etenders.gov.ie/epps/cft/prepareViewCfTWS.do?resourceId=91003",
    }),
  ];
  const buyers = [
    { name: "Limerick City and County Council", activeTenders: 2, trackedTenders: 2, awards: 4, awardedValue: "EUR 960,000" },
    { name: "Example German ministry", activeTenders: 1, trackedTenders: 1, awards: 0, awardedValue: null },
  ];
  let preferences = { sectors: [] as string[], keywords: [] as string[], cpvCodes: ["72000000"], valueMin: null, valueMax: null, countries: ["IRL"] };
  let portal: PortalConnection = options.portal ?? { connected: false, email: null, status: "untested", verifiedAt: null, lastSyncAt: null, error: null };
  let clarifications: Clarification[] = [
    {
      id: "c-1", question: "Is the site visit mandatory?", askedOn: "2026-11-01", askedBy: "owner@example.test",
      response: "Yes — attendance is required.", respondedOn: "2026-11-02", status: "Answered",
      createdAt: "2026-11-01T09:00:00Z", direction: "out", origin: "manual",
    },
    {
      id: "c-2", question: "Evaluation weights have been republished.", askedOn: "2026-11-03", askedBy: "buyer",
      response: "", respondedOn: "", status: "Open",
      createdAt: "2026-11-03T10:00:00Z", subject: "Evaluation weights updated", direction: "in", origin: "portal", portalMessageId: "pm-1",
    },
  ];
  const dismissed: string[] = [];
  const calls = { dismiss: [] as { externalId: string; source: string }[], undismiss: 0, preferencesPut: [] as typeof preferences[], portalPut: 0, portalDelete: 0, sends: 0, syncs: 0 };

  const errors: string[] = [];
  page.on("pageerror", (error) => { errors.push(error.message); console.error(error.stack); });
  await page.addInitScript(() => localStorage.setItem("tenderly_token", "local-browser-fixture"));
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (!path.startsWith("/api/")) return route.continue();
    const method = request.method();
    const reply = (body: unknown, status = 200) => route.fulfill({ status, json: body });

    if (path === "/api/me") return reply({ role: "owner", user: { email: "owner@example.test" } });
    if (path === "/api/company") return reply({ company: { name: "Example company", registration: "", turnover: "", employees: "", services: "Software", cpv: "72000000", certifications: "", insurance: "" } });
    if (path === "/api/preferences") {
      if (method === "PUT") {
        const next = request.postDataJSON() as typeof preferences;
        calls.preferencesPut.push(next);
        preferences = next;
        return reply({ preferences });
      }
      return reply({ preferences });
    }
    if (path === "/api/tenders") return reply({ items: tenders });
    if (path === "/api/tender-boards") {
      if (method === "POST") return reply({ board: { id: "new-board", ...request.postDataJSON() } }, 201);
      return reply({ items: [{ id: "it", name: "IT services", cpvCodes: ["72000000"] }] });
    }
    if (path === "/api/tenders/discover/dismiss") {
      if (method === "POST") {
        const body = request.postDataJSON() as { externalId: string; source: string };
        calls.dismiss.push(body);
        dismissed.push(body.externalId);
      } else if (method === "DELETE") {
        calls.undismiss += 1;
        const body = request.postDataJSON() as { externalId: string };
        dismissed.splice(dismissed.indexOf(body.externalId), 1);
      }
      return route.fulfill({ status: 204 });
    }
    if (path === "/api/tenders/discover") return reply({ items: tenders.filter((tender) => !dismissed.includes(tender.resourceId)), activeSearch: null, warnings: [] });
    if (/^\/api\/tenders\/[^/]+\/clarifications\/send$/.test(path)) {
      calls.sends += 1;
      if (options.sendStatus === 503) {
        return reply({ error: "Portal connection is not enabled on this server", portalUrl: "https://www.etenders.gov.ie/epps/cft/prepareViewCfTWS.do?resourceId=91001" }, 503);
      }
      const body = request.postDataJSON() as { subject: string; question: string };
      const clarification: Clarification = {
        id: `c-sent-${calls.sends}`, question: body.question, askedOn: "2026-11-04", askedBy: "owner@example.test",
        response: "", respondedOn: "", status: "Open", createdAt: new Date().toISOString(),
        subject: body.subject, direction: "out", origin: "portal", portalMessageId: `pm-sent-${calls.sends}`,
      };
      clarifications = [...clarifications, clarification];
      return reply({ clarification, delivered: true });
    }
    if (/^\/api\/tenders\/[^/]+\/clarifications\/sync$/.test(path)) {
      calls.syncs += 1;
      const syncedItem: Clarification = {
        id: "c-synced", question: "Buyer's notice: briefing slides published", askedOn: "2026-11-04", askedBy: "buyer",
        response: "", respondedOn: "", status: "Open", createdAt: new Date().toISOString(),
        subject: "Briefing slides published", direction: "in", origin: "portal", portalMessageId: "pm-synced",
      };
      if (!clarifications.some((item) => item.id === syncedItem.id)) clarifications = [...clarifications, syncedItem];
      return reply({ items: clarifications, synced: 1 });
    }
    if (path.endsWith("/clarifications")) {
      if (method === "POST") {
        const body = request.postDataJSON() as { question: string };
        clarifications = [...clarifications, {
          id: `c-manual-${clarifications.length}`, question: body.question, askedOn: "2026-11-04", askedBy: "owner@example.test",
          response: "", respondedOn: "", status: "Open", createdAt: new Date().toISOString(), direction: "out", origin: "manual",
        }];
        return reply({ clarification: clarifications[clarifications.length - 1] });
      }
      return reply({ items: clarifications, open: clarifications.filter((item) => !item.response).length });
    }
    if (path === "/api/buyers") return reply({ items: buyers });
    if (path.startsWith("/api/buyers/")) {
      const name = decodeURIComponent(path.slice("/api/buyers/".length));
      const buyer = buyers.find((entry) => entry.name === name);
      if (!buyer) return reply({ error: "Unknown buyer" }, 404);
      return reply({
        name,
        tenders: tenders.filter((tender) => tender.authority === name),
        intelligence: buyer.awards > 0
          ? {
            awards: buyer.awards, medianValue: 240000, minValue: 90000, maxValue: 620000,
            topSuppliers: [{ supplier: "Acme Systems", awards: 2 }],
            relatedCpv: false, licenceNote: "OGP award notices, CC-BY-4.0.",
          }
          : null,
      });
    }
    if (path === "/api/market/stats") {
      return reply({
        active: 3, newThisWeek: 2,
        closingSoon: { in7: 1, in14: 1, in30: 3 },
        byDivision: [{ code: "72", label: "IT services", count: 3 }],
        topBuyers: [{ name: "Limerick City and County Council", count: 2 }],
        valueBands: { under: 1, over: 1, unknown: 1 },
        sources: { etenders: 2, ted: 1 },
        generatedAt: "2026-11-04T08:00:00Z",
      });
    }
    if (path === "/api/market/competitors") return reply({ items: options.competitors ?? [] });
    if (path === "/api/portal/connection") {
      if (method === "PUT") {
        calls.portalPut += 1;
        if (options.portalPutStatus === 503) return reply({ error: "Portal connection is not enabled on this server" }, 503);
        const body = request.postDataJSON() as { email: string };
        portal = { connected: true, email: body.email, status: "ok", verifiedAt: new Date().toISOString(), lastSyncAt: null, error: null };
        return reply(portal);
      }
      if (method === "DELETE") {
        calls.portalDelete += 1;
        portal = { connected: false, email: null, status: "untested", verifiedAt: null, lastSyncAt: null, error: null };
        return route.fulfill({ status: 204 });
      }
      return reply(portal);
    }
    if (/^\/api\/tenders\/[^/]+$/.test(path)) return reply({ tender: tenders.find((tender) => tender.id === path.split("/")[3]) });
    if (path.endsWith("/tasks")) return reply({ tasks: [] });
    if (path.endsWith("/ask")) return reply({ questions: [], searchable: false });
    if (path.endsWith("/runbook")) return reply({ runbook: null, completed: 0, total: 0 });
    if (["/api/evidence", "/api/people", "/api/notifications", "/api/sectors", "/api/watchlist", "/api/saved-searches"].includes(path)) return reply({ items: [] });
    return reply({ error: "Optional analysis fixture not configured" }, 404);
  });
  return { errors, calls };
}

test.describe("superset: buyers", () => {
  test("buyers directory searches and opens a buyer profile with award intelligence", async ({ page }) => {
    const { errors } = await supersetWorkspace(page);
    await page.goto("/buyers");
    await expect(page.getByRole("heading", { name: "Buyers", exact: true })).toBeVisible();
    await expect(page.locator(".buyers-row")).toHaveCount(2);

    await page.getByLabel("Search buyers").fill("german");
    await expect(page.locator(".buyers-row")).toHaveCount(1);
    await page.getByLabel("Search buyers").fill("");
    await expect(page.locator(".buyers-row")).toHaveCount(2);

    await page.getByRole("row").filter({ hasText: "Limerick City and County Council" }).click();
    await expect(page).toHaveURL(/\/buyers\/Limerick/);
    await expect(page.getByRole("heading", { name: "Limerick City and County Council" })).toBeVisible();
    await expect(page.getByTestId("buyer-tenders").locator(".buyer-tender-card")).toHaveCount(2);
    const intel = page.getByTestId("buyer-intelligence");
    await expect(intel).toContainText("4");
    await expect(intel).toContainText("Acme Systems");

    await page.getByRole("button", { name: "← Back to buyers" }).click();
    await expect(page).toHaveURL(/\/buyers$/);

    // Buyer names on tracker cards link to the same profile.
    await page.goto("/bids");
    await expect(page.locator(".tracker-card").first()).toBeVisible();
    await page.locator(".tracker-card").first().getByRole("button", { name: "Limerick City and County Council" }).first().click();
    await expect(page).toHaveURL(/\/buyers\/Limerick/);
    expect(errors).toEqual([]);
  });

  test("an unknown buyer says so instead of rendering an empty profile", async ({ page }) => {
    const { errors } = await supersetWorkspace(page);
    await page.goto("/buyers/No%20Such%20Buyer");
    await expect(page.getByTestId("buyer-not-found")).toBeVisible();
    expect(errors).toEqual([]);
  });
});

test.describe("superset: market", () => {
  test("market statistics render and competitors show the honest empty state", async ({ page }) => {
    const { errors } = await supersetWorkspace(page);
    await page.goto("/market");
    await expect(page.getByRole("heading", { name: "Market", exact: true })).toBeVisible();

    const cards = page.locator(".stat-card");
    await expect(cards).toHaveCount(5);
    await expect(cards.nth(0)).toContainText("3");
    await expect(cards.nth(0)).toContainText("Active notices");
    await expect(cards.nth(1)).toContainText("New this week");
    await expect(cards.nth(2)).toContainText("1");

    await expect(page.getByTestId("market-divisions")).toContainText("IT services");
    await expect(page.getByTestId("market-top-buyers").getByRole("button", { name: "Limerick City and County Council" })).toBeVisible();
    await expect(page.getByTestId("market-values")).toContainText("Up to EUR 200k");
    await expect(page.getByTestId("market-sources")).toContainText("TED");

    await expect(page.getByTestId("competitors-empty")).toContainText("Load the OGP award dataset to see competitor history");
    await expect(page.getByTestId("competitors-empty")).toContainText("npm run import:ogp");

    // The top-buyers list links through to the buyer profile.
    await page.getByTestId("market-top-buyers").getByRole("button", { name: "Limerick City and County Council" }).click();
    await expect(page).toHaveURL(/\/buyers\/Limerick/);
    expect(errors).toEqual([]);
  });

  test("loaded competitor history renders as a table", async ({ page }) => {
    const { errors } = await supersetWorkspace(page, {
      competitors: [
        { supplier: "Acme Systems", wins: 6, totalValue: "EUR 1,940,000", lastWin: "2026-09-14", buyers: ["Limerick City and County Council"] },
      ],
    });
    await page.goto("/market");
    const table = page.getByRole("table", { name: "Competitors" });
    await expect(table).toBeVisible();
    await expect(table).toContainText("Acme Systems");
    await expect(table).toContainText("EUR 1,940,000");
    await expect(table).toContainText("2026-09-14");
    expect(errors).toEqual([]);
  });
});

test.describe("superset: discover", () => {
  test("match buckets filter the list and dismissal can be undone", async ({ page }) => {
    const { errors, calls } = await supersetWorkspace(page);
    await page.goto("/discover");
    await expect(page.locator(".tt-row")).toHaveCount(3);

    await expect(page.getByRole("button", { name: /^Strong ≥70/ })).toContainText("1");
    await expect(page.getByRole("button", { name: /^Possible 45–69/ })).toContainText("1");
    await expect(page.getByRole("button", { name: /^Weak <45/ })).toContainText("1");

    await page.getByRole("button", { name: /^Strong ≥70/ }).click();
    await expect(page.locator(".tt-row")).toHaveCount(1);
    await expect(page.locator(".tt-row").first()).toContainText("Case management system");
    // Freshness is shown when the source was checked.
    await expect(page.locator(".tt-row").first()).toContainText("checked");
    await page.getByRole("button", { name: /^All\s/ }).click();
    await expect(page.locator(".tt-row")).toHaveCount(3);

    // The TED notice carries its market badges; the Irish ones stay bare.
    const tedRow = page.locator(".tt-row").filter({ hasText: "Cross-border testing services" });
    await expect(tedRow.locator(".market-badge").first()).toHaveText("DEU");
    await expect(page.locator(".tt-row").filter({ hasText: "Case management system" }).locator(".market-badge")).toHaveCount(0);

    // Dismiss removes the notice and reports to the API; Undo restores it.
    await page.getByRole("button", { name: "Not interested in Accessibility audit" }).click();
    await expect(page.locator(".tt-row")).toHaveCount(2);
    expect(calls.dismiss).toEqual([{ externalId: "91003", source: "etenders" }]);
    await expect(page.getByTestId("dismiss-undo")).toContainText("Accessibility audit");
    await page.getByTestId("dismiss-undo").getByRole("button", { name: "Undo" }).click();
    await expect(page.locator(".tt-row")).toHaveCount(3);
    expect(calls.undismiss).toBe(1);
    expect(errors).toEqual([]);
  });

  test("value, deadline, procedure and market filters narrow the list; export downloads CSV", async ({ page }) => {
    const { errors } = await supersetWorkspace(page);
    await page.goto("/discover");
    await expect(page.locator(".tt-row")).toHaveCount(3);

    // Value bounds keep notices without a stated value visible.
    await page.getByLabel("Minimum value").fill("200000");
    await expect(page.locator(".tt-row")).toHaveCount(2);
    await page.getByLabel("Minimum value").fill("");
    await page.getByLabel("Maximum value").fill("400000");
    await expect(page.locator(".tt-row")).toHaveCount(2);
    await page.getByLabel("Maximum value").fill("");

    await page.getByLabel("Deadline within").selectOption("7");
    await expect(page.locator(".tt-row")).toHaveCount(1);
    await expect(page.locator(".tt-row").first()).toContainText("Accessibility audit");
    await page.getByLabel("Deadline within").selectOption("any");
    await expect(page.locator(".tt-row")).toHaveCount(3);

    await page.getByLabel("Procedure").selectOption("Restricted");
    await expect(page.locator(".tt-row")).toHaveCount(1);
    await page.getByLabel("Procedure").selectOption("");

    await page.getByLabel("Market", { exact: true }).selectOption("DEU");
    await expect(page.locator(".tt-row")).toHaveCount(1);
    await expect(page.locator(".tt-row").first()).toContainText("Cross-border testing services");
    await page.getByRole("button", { name: "Clear filters" }).click();
    await expect(page.locator(".tt-row")).toHaveCount(3);

    const downloadPromise = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export CSV" }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("tenderly-discovery.csv");
    expect(errors).toEqual([]);
  });
});

test.describe("superset: clarifications hub", () => {
  test("thread shows direction and origin; without a connection the official portal link is offered", async ({ page }) => {
    const { errors } = await supersetWorkspace(page);
    await page.goto("/bids");
    await expect(page.locator(".tracker-card")).toHaveCount(3);
    await page.getByRole("button", { name: "Case management system", exact: true }).click();
    await expect(page).toHaveURL(/\/bids\/t-1\/overview$/);

    const thread = page.getByTestId("clarifications");
    await expect(thread.locator(".clar-list li")).toHaveCount(2);
    // Oldest first, with direction and origin badges.
    const first = thread.locator(".clar-list li").first();
    await expect(first.locator(".clar-badge.dir-out")).toHaveText("You → buyer");
    await expect(first.locator(".clar-badge.origin-manual")).toHaveText("Manual");
    const second = thread.locator(".clar-list li").nth(1);
    await expect(second.locator(".clar-badge.dir-in")).toHaveText("Buyer → you");
    await expect(second.locator(".clar-badge.origin-portal")).toHaveText("Portal");
    await expect(second).toContainText("Evaluation weights updated");

    // No connection: the deep link is the way to ask, and no compose form pretends otherwise.
    await expect(page.getByRole("link", { name: "Ask on eTenders ↗" })).toHaveAttribute("href", /prepareViewCfTWS/);
    await expect(thread).toContainText("Sign-in required");
    await expect(page.getByTestId("portal-compose")).toHaveCount(0);
    await expect(thread).toContainText("Connect the eTenders portal in Settings");

    // The buyer name in the title bar links to the buyer profile.
    await page.getByRole("button", { name: "Limerick City and County Council" }).first().click();
    await expect(page).toHaveURL(/\/buyers\/Limerick/);
    expect(errors).toEqual([]);
  });

  test("a TED tender has no portal messaging link", async ({ page }) => {
    const { errors } = await supersetWorkspace(page);
    await page.goto("/bids/t-2/overview");
    await expect(page.getByTestId("clarifications")).toBeVisible();
    await expect(page.getByRole("link", { name: "Ask on eTenders ↗" })).toHaveCount(0);
    // Non-domestic markets are badged in the tender header.
    await expect(page.locator(".bid-meta .market-badge").first()).toHaveText("DEU");
    expect(errors).toEqual([]);
  });

  test("send failure stays on screen with the portal fallback; connected send and sync work", async ({ page }) => {
    const { errors, calls } = await supersetWorkspace(page, {
      portal: { connected: true, email: "bid****@example.test", status: "ok", verifiedAt: "2026-11-03T09:00:00Z", lastSyncAt: null, error: null },
      sendStatus: 503,
    });
    await page.goto("/bids/t-1/overview");
    await expect(page.getByTestId("portal-compose")).toBeVisible();

    // The portal feature is disabled server-side: 503 must persist, not toast away.
    await page.getByLabel("Portal message subject").fill("Site visit");
    await page.getByLabel("Portal message question").fill("Is the site visit mandatory?");
    await page.getByRole("button", { name: "Send via portal" }).click();
    const sendError = page.getByTestId("send-error");
    await expect(sendError).toContainText("Portal connection is not enabled on this server");
    await expect(sendError.getByRole("link", { name: "ask on eTenders ↗" })).toBeVisible();
    await page.waitForTimeout(3800);
    await expect(sendError).toBeVisible();

    // Server-side recovery: the same action now delivers through the portal.
    await page.route("**/api/tenders/t-1/clarifications/send", async (route) => {
      calls.sends += 1;
      const body = route.request().postDataJSON() as { subject: string; question: string };
      await route.fulfill({
        status: 200,
        json: {
          clarification: {
            id: "c-live", question: body.question, askedOn: "2026-11-04", askedBy: "owner@example.test",
            response: "", respondedOn: "", status: "Open", createdAt: new Date().toISOString(),
            subject: body.subject, direction: "out", origin: "portal", portalMessageId: "pm-live",
          },
          delivered: true,
        },
      });
    });
    await page.getByLabel("Portal message question").fill("Is the site visit mandatory?");
    await page.getByRole("button", { name: "Send via portal" }).click();
    await expect(page.getByTestId("send-result")).toContainText("Sent via the portal");
    await expect(page.getByTestId("send-error")).toHaveCount(0);
    expect(calls.sends).toBe(2);

    // Sync pulls buyer messages from the portal into the same thread.
    await page.getByRole("button", { name: "Sync from portal" }).click();
    await expect(page.getByTestId("sync-result")).toContainText("Synced 1 message");
    await expect(page.getByTestId("clarifications")).toContainText("Briefing slides published");
    expect(calls.syncs).toBe(1);
    expect(errors).toEqual([]);
  });
});

test.describe("superset: settings", () => {
  test("portal connection card shows disabled, connects, and disconnects", async ({ page }) => {
    const { errors, calls } = await supersetWorkspace(page, {
      portal: { connected: false, email: null, status: "disabled", verifiedAt: null, lastSyncAt: null, error: null },
      portalPutStatus: 503,
    });
    await page.goto("/settings");
    await expect(page.getByTestId("portal-status")).toHaveText("Disabled");
    await expect(page.getByTestId("portal-disabled")).toHaveText("Not enabled on this server");
    await expect(page.getByTestId("portal-connection")).toContainText("Uses your own eTenders account. Credentials are encrypted; messages are sent as you. You are responsible for your portal credentials.");
    await expect(page.getByLabel("eTenders account email")).toHaveCount(0);

    // The server enables the feature; the card offers the connect form.
    await page.route("**/api/portal/connection", async (route) => {
      const request = route.request();
      if (request.method() === "PUT") {
        calls.portalPut += 1;
        const body = request.postDataJSON() as { email: string };
        return route.fulfill({ json: { connected: true, email: body.email, status: "ok", verifiedAt: new Date().toISOString(), lastSyncAt: null, error: null } });
      }
      if (request.method() === "DELETE") {
        calls.portalDelete += 1;
        return route.fulfill({ status: 204 });
      }
      return route.fulfill({ json: { connected: false, email: null, status: "untested", verifiedAt: null, lastSyncAt: null, error: null } });
    });
    await page.reload();
    await expect(page.getByTestId("portal-status")).toHaveText("Not verified");
    await page.getByLabel("eTenders account email").fill("bids@example.test");
    await page.getByLabel("eTenders account password").fill("correct horse battery staple");
    await page.getByRole("button", { name: "Connect portal" }).click();
    await expect(page.getByTestId("portal-status")).toHaveText("Connected");
    await expect(page.getByTestId("portal-connection")).toContainText("bids@example.test");
    expect(calls.portalPut).toBe(1);

    await page.getByRole("button", { name: "Disconnect" }).click();
    await expect(page.getByTestId("portal-status")).toHaveText("Not verified");
    await expect(page.getByLabel("eTenders account email")).toBeVisible();
    expect(calls.portalDelete).toBe(1);
    expect(errors).toEqual([]);
  });

  test("markets to watch persist with the discovery preferences", async ({ page }) => {
    const { errors, calls } = await supersetWorkspace(page);
    await page.goto("/settings");
    const scope = page.getByTestId("market-scope");
    await expect(scope.getByTestId("market-IRL").locator("input")).toBeChecked();
    await expect(scope.getByTestId("market-GBR").locator("input")).not.toBeChecked();

    await scope.getByTestId("market-GBR").click();
    await page.getByRole("button", { name: "Save preferences" }).click();
    await expect(calls.preferencesPut.at(-1)?.countries).toEqual(["IRL", "GBR"]);

    await page.reload();
    await expect(page.getByTestId("market-scope").getByTestId("market-GBR").locator("input")).toBeChecked();

    // The All EU shortcut selects every market, and pressing it again resets.
    await page.getByTestId("market-scope").getByRole("button", { name: "All EU" }).click();
    await expect(page.getByTestId("market-scope").getByTestId("market-SWE").locator("input")).toBeChecked();
    await page.getByTestId("market-scope").getByRole("button", { name: "All EU" }).click();
    await expect(page.getByTestId("market-scope").getByTestId("market-GBR").locator("input")).not.toBeChecked();
    await expect(page.getByTestId("market-scope").getByTestId("market-IRL").locator("input")).toBeChecked();
    expect(errors).toEqual([]);
  });

  test("board creation accepts an optional market scope", async ({ page }) => {
    const { errors } = await supersetWorkspace(page);
    let created: { name?: string; cpvCodes?: string[]; countries?: string[] } = {};
    await page.route("**/api/tender-boards", async (route) => {
      if (route.request().method() === "POST") {
        created = route.request().postDataJSON() as typeof created;
        return route.fulfill({ status: 201, json: { board: { id: "scoped", ...created } } });
      }
      return route.fulfill({ json: { items: [{ id: "it", name: "IT services", cpvCodes: ["72000000"] }] } });
    });
    await page.goto("/bids");
    await expect(page.locator(".tracker-card").first()).toBeVisible();
    await page.getByRole("button", { name: "Create CPV board", exact: true }).click();
    await page.getByLabel("Board name").fill("EU software");
    await page.getByLabel("CPV codes", { exact: true }).fill("72200000");
    await page.getByLabel("Board market scope").getByTestId("market-DEU").click();
    await page.getByRole("button", { name: "Create board", exact: true }).click();
    await expect(page.getByLabel("Tender board", { exact: true })).toHaveValue("scoped");
    expect(created.name).toBe("EU software");
    expect(created.countries).toEqual(["DEU"]);
    expect(errors).toEqual([]);
  });
});
