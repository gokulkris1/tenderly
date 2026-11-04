import { expect, test, type Page } from "@playwright/test";
import type { Tender } from "@tenderly/shared";

/**
 * Biddy drafting UX over the existing API: streamed drafts, visible
 * claimsToVerify, the AI-policy reminder surviving a reload, and no-AI mode
 * removing generation controls. Fully mocked; no model calls.
 */
async function biddyWorkspace(page: Page) {
  const reminder = "This pack prohibits AI-generated content: a human must decide what to submit and how it was produced.";
  const tender: Tender = {
    id: "tender-0", resourceId: "92001", title: "Application services",
    authority: "Example public buyer", category: "IT services", procedure: "Open",
    deadline: "26/03/2030 17:00", deadlineIso: "2030-03-26T17:00:00Z",
    value: "EUR 150,000", valueAmount: 150000, match: 0, decision: "REVIEW", access: "Not assessed",
    summary: "Build and support accessible applications.", published: "01/11/2026",
    framework: "Direct contract",
    gates: [],
    questions: [{
      id: "q1", title: "Delivery methodology", weight: 40, maxWords: 500,
      status: "needs-review", prompt: "Describe your delivery approach.", answer: "",
      evidence: ["Approved case study: Cork deployment"],
    }],
    bidDecisions: [{ id: "d1", decision: "BID", reason: "Core fit", decidedBy: "owner@example.test", recommendationAtTheTime: "REVIEW", createdAt: "2026-11-01T09:00:00Z" }],
    aiUsePolicy: { state: "prohibited", source: "RFT section 4.2", quote: "Responses must not contain AI-generated content.", confidence: "HIGH", reminder },
    noAiMode: false,
    sourceUrl: "https://www.etenders.gov.ie/epps/cft/prepareViewCfTWS.do?resourceId=92001",
    sourceLinks: [],
    workflow: { stage: "APPLICATION", outcome: "PENDING", priority: "HIGH", assignee: "Bid lead", history: [] },
  };
  const state = { noAiMode: false };
  const errors: string[] = [];
  page.on("pageerror", (error) => { errors.push(error.message); console.error(error.stack); });
  await page.addInitScript(() => localStorage.setItem("tenderly_token", "local-browser-fixture"));
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (!path.startsWith("/api/")) return route.continue();
    const reply = (body: unknown, status = 200) => route.fulfill({ status, json: body });
    const current = () => ({ ...tender, noAiMode: state.noAiMode });
    if (path === "/api/me") return reply({ role: "owner", user: { email: "owner@example.test" } });
    if (path === "/api/company") return reply({ company: { name: "Example company", cpv: "72000000" } });
    if (path === "/api/preferences") return reply({ preferences: { sectors: [], keywords: [], cpvCodes: ["72000000"], valueMin: null, valueMax: null, countries: ["IRL"] } });
    if (path === "/api/tenders") return reply({ items: [current()] });
    if (path === "/api/tender-boards") return reply({ items: [] });
    if (path === "/api/tenders/tender-0") return reply({ tender: current() });
    if (path === "/api/tenders/tender-0/no-ai-mode" && request.method() === "PUT") {
      state.noAiMode = true;
      return reply({ noAiMode: true, aiWrittenAnswers: [] });
    }
    if (path === "/api/tenders/tender-0/draft-all") return reply({ run: null, summary: null, running: false });
    if (path === "/api/tenders/tender-0/answers/q1/draft-stream") {
      return route.fulfill({
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
        body: [
          `event: text\ndata: ${JSON.stringify({ answer: "We will deliver in three governed stages." })}\n`,
          `event: done\ndata: ${JSON.stringify({
            answer: "We will deliver in three governed stages.",
            status: "draft", missingInputs: [],
            claimsToVerify: [reminder],
            citations: [], evidenceUsed: ["Approved case study: Cork deployment"],
          })}\n`,
          "",
        ].join("\n"),
      });
    }
    if (path.endsWith("/clarifications")) return reply({ items: [], open: 0 });
    if (path.endsWith("/tasks")) return reply({ tasks: [] });
    if (path.endsWith("/ask")) return reply({ questions: [], searchable: false });
    if (path.endsWith("/runbook")) return reply({ runbook: null, completed: 0, total: 0 });
    if (["/api/evidence", "/api/people", "/api/notifications", "/api/sectors", "/api/watchlist", "/api/saved-searches"].includes(path)) return reply({ items: [] });
    return reply({ error: "Optional analysis fixture not configured" }, 404);
  });
  return errors;
}

test.describe("Biddy drafting assistant", () => {
  test("streams a draft, shows claims to verify, and no-AI mode removes generation controls", async ({ page }) => {
    const errors = await biddyWorkspace(page);
    await page.goto("/bids/tender-0/respond");
    await expect(page.getByTestId("no-ai-prompt")).toContainText("prohibits AI-generated content");
    await expect(page.getByRole("button", { name: "✦ Ask Biddy to draft", exact: true })).toBeVisible();

    await page.getByRole("button", { name: "✦ Ask Biddy to draft", exact: true }).click();
    await expect(page.getByTestId("claims-to-verify")).toContainText("prohibits AI-generated content: a human must decide");
    await expect(page.locator(".toast")).toContainText("Biddy draft created");

    await page.getByRole("button", { name: "Enable no-AI mode", exact: true }).click();
    await expect(page.getByTestId("no-ai-banner")).toContainText("Biddy drafting is disabled");
    await expect(page.getByRole("button", { name: "✦ Ask Biddy to draft", exact: true })).toHaveCount(0);
    await expect(page.getByTestId("draft-all")).toHaveCount(0);
    await expect(page.getByTestId("refine-box")).toHaveCount(0);

    await page.reload();
    await expect(page.getByTestId("no-ai-banner")).toContainText("Biddy drafting is disabled");
    await page.getByRole("button", { name: "Qualification & scoring", exact: true }).click();
    await expect(page.getByTestId("ai-policy-reminder")).toContainText("prohibits AI-generated content: a human must decide");
    expect(errors).toEqual([]);
  });
});
