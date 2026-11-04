import { expect, test, type Page } from "@playwright/test";
import type { Tender, TenderBoardConfig, TenderWorkflowPatch } from "@tenderly/shared";

async function workspace(page: Page, role = "owner") {
  const amounts = [199999.99, 200000, 200000.01, null];
  let tenders: Tender[] = amounts.map((valueAmount, n) => ({
    id: `tender-${n}`, resourceId: `91000${n}`, title: `Application services ${n}`,
    authority: "Example public buyer", category: "IT services", procedure: "Open",
    deadline: "26/03/2030 17:00", deadlineIso: "2030-03-26T17:00:00Z",
    value: valueAmount === null ? "Not stated" : `EUR ${valueAmount.toLocaleString("en-IE")}`,
    valueAmount, match: 0, decision: "REVIEW", access: "Not assessed",
    summary: "Build and support accessible applications.", published: "01/11/2026",
    framework: "Direct contract", gates: [], questions: [],
    cpv: { raw: "79400000, 72212000", recognised: false },
    noticeFields: { Description: "Build and support accessible applications.", "Custom published field": "Complete CFT information" },
    sourceUrl: `https://www.etenders.gov.ie/epps/cft/prepareViewCfTWS.do?resourceId=91000${n}`,
    sourceLinks: [{ label: "Tender documents and attachments", url: `https://www.etenders.gov.ie/epps/cft/listContractDocuments.do?resourceId=91000${n}` }],
    contactEmails: ["procurement@example.test"],
    workflow: { stage: "NEW", outcome: "PENDING", priority: "MEDIUM", assignee: "", history: [] },
  }));
  let boards: TenderBoardConfig[] = [{ id: "it", name: "IT services", cpvCodes: ["72000000"] }];
  const errors: string[] = [];
  page.on("pageerror", (error) => { errors.push(error.message); console.error(error.stack); });
  await page.addInitScript(() => localStorage.setItem("tenderly_token", "local-browser-fixture"));
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (!path.startsWith("/api/")) return route.continue();
    const method = request.method();
    const reply = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    if (path === "/api/me") return reply({ role, user: { email: "owner@example.test" } });
    if (path === "/api/company") return reply({ company: { name: "Example company", registration: "", turnover: "", employees: "", services: "Software", cpv: "72000000", certifications: "", insurance: "" } });
    if (path === "/api/preferences") return reply({ preferences: { sectors: [], keywords: [], cpvCodes: ["72000000"], valueMin: null, valueMax: null, countries: ["IRL"] } });
    if (path === "/api/tenders") return reply({ items: tenders });
    if (path === "/api/tenders/sync") return reply({ items: tenders, warnings: ["TED is temporarily unavailable; eTenders was refreshed."], checked: 4 });
    if (path === "/api/tender-boards") {
      if (method === "POST") {
        const input = request.postDataJSON();
        const board = { id: "software", ...input };
        boards = [...boards, board];
        return reply({ board }, 201);
      }
      return reply({ items: boards });
    }
    if (/^\/api\/tenders\/[^/]+$/.test(path)) {
      return reply({ tender: tenders.find((tender) => tender.id === path.split("/")[3]) });
    }
    if (path.endsWith("/workflow")) {
      const patch: TenderWorkflowPatch = request.postDataJSON();
      const id = path.split("/")[3];
      tenders = tenders.map((tender) => {
        if (tender.id !== id || !tender.workflow) return tender;
        const { comment, ...fields } = patch;
        const workflow = { ...tender.workflow, ...fields };
        if (patch.outcome && patch.outcome !== "PENDING") workflow.stage = "DONE";
        else if (patch.stage && patch.stage !== "DONE") workflow.outcome = "PENDING";
        workflow.history = [...workflow.history, { at: new Date().toISOString(), actor: "owner@example.test", message: comment || "Workflow updated" }];
        return { ...tender, workflow };
      });
      return reply({ tender: tenders.find((tender) => tender.id === id) });
    }
    if (path.endsWith("/clarifications")) return reply({ items: [], open: 0 });
    if (path.endsWith("/tasks")) return reply({ tasks: [] });
    if (path.endsWith("/ask")) return reply({ questions: [], searchable: false });
    if (path.endsWith("/runbook")) return reply({ runbook: null, completed: 0, total: 0 });
    if (["/api/evidence", "/api/people", "/api/notifications", "/api/sectors", "/api/watchlist", "/api/saved-searches"].includes(path)) return reply({ items: [] });
    return reply({ error: "Optional analysis fixture not configured" }, 404);
  });
  await page.goto("/bids");
  await expect(page.locator(".tracker-card")).toHaveCount(4);
  return errors;
}

test.describe("tracking-first tender workspace", () => {
  test("value grouping and filters respect the exact EUR 200k boundary", async ({ page }) => {
    const errors = await workspace(page);
    await expect(page.locator(".tracker-chips button").first()).toHaveText(/All\s*4/);
    await expect(page.locator(".tracker-card").first().locator(".tracker-next-step")).toHaveText("Triage — keep, review or ignore");
    await page.getByRole("button", { name: /^Review/ }).click();
    await expect(page.locator(".tracker-card")).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "No tenders match this board or these filters" })).toBeVisible();
    await page.getByRole("button", { name: /^All\s/ }).click();
    await expect(page.locator(".tracker-card")).toHaveCount(4);
    await page.getByRole("combobox", { name: "Value", exact: true }).selectOption("under");
    await expect(page.locator(".tracker-card")).toHaveCount(2);
    await page.getByRole("combobox", { name: "Value", exact: true }).selectOption("over");
    await expect(page.locator(".tracker-card")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "Application services 2", exact: true })).toBeVisible();
    await page.getByRole("combobox", { name: "Value", exact: true }).selectOption("unknown");
    await expect(page.locator(".tracker-card")).toHaveCount(1);
    await page.getByRole("combobox", { name: "Value", exact: true }).selectOption("all");
    await page.getByLabel("Group by value").check();
    await expect(page.locator(".tracker-group-section")).toHaveCount(3);
    expect(errors).toEqual([]);
  });

  test("a tender opens with complete source details, keeps notes and records a result", async ({ page }) => {
    const errors = await workspace(page);
    await page.getByLabel("Stage for Application services 0").selectOption("REVIEW");
    await expect(page.getByRole("region", { name: "Review tenders", exact: true }).locator(".tracker-card")).toHaveCount(1);
    await page.getByRole("button", { name: "Application services 0", exact: true }).click();
    await expect(page).toHaveURL(/\/bids\/tender-0\/overview$/);
    await expect(page.getByLabel("Tender stage", { exact: true })).toHaveValue("REVIEW");
    await expect(page.locator(".bid-meta .stage-pill")).toHaveText("Review");
    await expect(page.locator(".bid-freshness")).toContainText("Source not checked since tracking");
    await expect(page.getByRole("heading", { name: "Tracking", exact: true })).toBeVisible();
    await page.getByText(/All published CFT fields/).click();
    await expect(page.getByText("Complete CFT information", { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Tender documents and attachments" })).toHaveAttribute("href", /listContractDocuments/);
    await expect(page.getByRole("link", { name: "procurement@example.test" })).toHaveAttribute("href", "mailto:procurement@example.test");
    await page.getByLabel("Add a tracking note").fill("Bid lead to review pricing");
    await page.getByRole("button", { name: "Add note", exact: true }).click();
    await expect(page.getByText("Bid lead to review pricing", { exact: true })).toBeVisible();
    await page.getByLabel("Tender result").selectOption("WON");
    await expect(page.getByLabel("Tender stage", { exact: true })).toHaveValue("DONE");
    await page.reload();
    await expect(page.getByLabel("Tender result")).toHaveValue("WON");
    await page.getByLabel("Tender stage", { exact: true }).selectOption("REVIEW");
    await expect(page.getByLabel("Tender result")).toHaveValue("PENDING");
    expect(errors).toEqual([]);
  });

  test("returning from a tender restores the selected board and filters", async ({ page }) => {
    const errors = await workspace(page);
    await page.getByLabel("Tender board", { exact: true }).selectOption("it");
    await expect(page).toHaveURL(/\/bids\?board=it$/);
    await page.getByLabel("Search tracked tenders").fill("services 2");
    await expect(page.locator(".tracker-card")).toHaveCount(1);
    await page.getByRole("button", { name: "Application services 2", exact: true }).click();
    await expect(page).toHaveURL(/\/bids\/tender-2\/overview\?board=it$/);
    await page.getByRole("button", { name: "← Back to tender board" }).click();
    await expect(page).toHaveURL(/\/bids\?board=it$/);
    await expect(page.getByLabel("Tender board", { exact: true })).toHaveValue("it");
    await expect(page.getByLabel("Search tracked tenders")).toHaveValue("services 2");
    await expect(page.locator(".tracker-card")).toHaveCount(1);
    expect(errors).toEqual([]);
  });

  test("separate CPV boards persist and share existing tender records", async ({ page }) => {
    const errors = await workspace(page);
    await page.getByRole("button", { name: "Create CPV board", exact: true }).click();
    await page.getByLabel("Board name").fill("Software");
    await page.getByLabel("CPV codes", { exact: true }).fill("72200000");
    await page.getByRole("button", { name: "Create board", exact: true }).click();
    await expect(page.getByLabel("Tender board", { exact: true })).toHaveValue("software");
    await expect(page.locator(".tracker-card")).toHaveCount(4);
    await page.reload();
    await expect(page.getByLabel("Tender board", { exact: true })).toHaveValue("software");
    await expect(page.locator(".tracker-card")).toHaveCount(4);
    expect(errors).toEqual([]);
  });

  test("source refresh failures retain the record; retry updates source facts without moving the application", async ({ page }) => {
    const errors = await workspace(page);
    await page.getByLabel("Stage for Application services 0").selectOption("APPLICATION");
    const loaded = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/tenders/tender-0");
    await page.getByRole("button", { name: "Application services 0", exact: true }).click();
    const snapshot = await (await loaded).json();
    let attempts = 0;
    await page.route("**/api/tenders/tender-0/refresh", (route) => {
      attempts += 1;
      if (attempts === 1) return route.fulfill({ status: 502, json: { error: "Official source temporarily unavailable" } });
      return route.fulfill({ json: { tender: {
        ...snapshot.tender,
        sourceDescription: "Updated published application scope",
        noticeFields: {},
        sourceChanges: [{ at: "2026-11-04T10:00:00Z", field: "description", from: "Original scope", to: "Updated published application scope" }],
      } } });
    });
    await page.getByRole("button", { name: "Refresh CFT information" }).click();
    await expect(page.getByText("Official source temporarily unavailable", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Tender stage", { exact: true })).toHaveValue("APPLICATION");
    await expect(page.locator(".record-scope .tracker-synopsis")).toHaveText("Build and support accessible applications.");
    await page.getByRole("button", { name: "Refresh CFT information" }).click();
    await expect(page.locator(".record-scope .tracker-synopsis")).toHaveText("Updated published application scope");
    await expect(page.getByLabel("Tender stage", { exact: true })).toHaveValue("APPLICATION");
    await page.getByText("Published source updates (1)", { exact: true }).click();
    await expect(page.getByText("Previously: Original scope", { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("dragging a card persists the new tender stage", async ({ page }) => {
    const errors = await workspace(page);
    const target = page.getByRole("region", { name: "Consider tenders", exact: true });
    await page.getByTestId("tender-card-tender-0").dragTo(target);
    await expect(target.locator(".tracker-card")).toHaveCount(1);
    await page.reload();
    await expect(page.getByRole("region", { name: "Consider tenders", exact: true }).locator(".tracker-card")).toHaveCount(1);
    expect(errors).toEqual([]);
  });

  test("an empty live workspace offers CPV sync instead of demo tenders", async ({ page }) => {
    const errors = await workspace(page);
    await page.route("**/api/tenders", (route) => route.fulfill({ json: { items: [] } }));
    await page.reload();
    await expect(page.getByRole("heading", { name: "Your tender board starts here" })).toBeVisible();
    await expect(page.locator(".tracker-card")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Sync matching tenders" })).toBeEnabled();
    expect(errors).toEqual([]);
  });

  test("sync warnings remain visible instead of disappearing in a success toast", async ({ page }) => {
    await workspace(page);
    await page.getByRole("button", { name: "Sync tenders", exact: true }).click();
    await expect(page.locator(".tracker-sync-status")).toContainText("TED is temporarily unavailable");
    await page.getByRole("button", { name: "List", exact: true }).click();
    await expect(page.locator(".tracker-sync-status")).toContainText("TED is temporarily unavailable");
  });

  test("viewer sees tender information without editable workflow controls", async ({ page }) => {
    await workspace(page, "viewer");
    await expect(page.getByRole("button", { name: "Create CPV board", exact: true })).toBeDisabled();
    await expect(page.getByLabel("Stage for Application services 0")).toBeDisabled();
    await page.getByRole("button", { name: "Application services 0", exact: true }).click();
    await expect(page.getByLabel("Tender result")).toBeDisabled();
    await expect(page.getByRole("button", { name: "Add note", exact: true })).toBeDisabled();
    await expect(page.getByRole("link", { name: "Tender documents and attachments" })).toBeVisible();
    await page.getByRole("button", { name: "Assemble", exact: true }).click();
    await expect(page.getByRole("button", { name: /Build draft ZIP/ })).toBeDisabled();
    await expect(page.getByPlaceholder("Draft the method statement")).toBeDisabled();
    await expect(page.locator('input[type="file"]')).toHaveCount(0);
  });

  test("a notice without a pack does not invent mandatory checklist requirements", async ({ page }) => {
    const errors = await workspace(page);
    await page.getByRole("button", { name: "Application services 0", exact: true }).click();
    await page.getByRole("button", { name: "Assemble", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Checklist not extracted", exact: true })).toBeVisible();
    await expect(page.locator(".manifest-row")).toHaveCount(0);
    await expect(page.locator(".manifest-status")).toHaveText("Not extracted");
    expect(errors).toEqual([]);
  });

  test("mobile navigation works and the page does not overflow horizontally", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const errors = await workspace(page);
    await page.getByRole("button", { name: "Open navigation", exact: true }).click();
    await expect(page.getByRole("navigation", { name: "Mobile navigation" })).toBeVisible();
    await page.getByRole("navigation", { name: "Mobile navigation" }).getByRole("button", { name: "Company", exact: true }).click();
    await expect(page).toHaveURL(/\/company$/);
    await page.goto("/bids");
    await page.getByRole("button", { name: "List", exact: true }).click();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    expect(overflow).toBe(false);
    expect(errors).toEqual([]);
  });
});
