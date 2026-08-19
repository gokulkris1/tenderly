import { test, expect } from "@playwright/test";

/**
 * QUARANTINED (TLY-102): these journeys are specifications, not passing tests.
 * They assert on data-testid hooks that arrive with the screen split (TLY-24,
 * TLY-25) and on seeded staging data that arrives with TLY-104. Running them
 * now would fail for reasons unrelated to the story being merged and file
 * misattributed Bugs. Remove the @quarantine tags in TLY-103, which makes them
 * real. Quarantined 2026-08-19.
 */

import { signIn } from "../support/app";

/** Journey 2 — the company profile round-trips. Everything downstream cites it. */
test.describe("company profile", () => {
  test("@quarantine @smoke profile values survive a save and reload", async ({ page }) => {
    await signIn(page);
    await page.goto("/company");

    const turnover = `${2_000_000 + Math.floor(Date.now() % 1000)}`;
    await page.getByLabel("Annual turnover").fill(turnover);
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Saved")).toBeVisible();

    await page.reload();
    await expect(page.getByLabel("Annual turnover")).toHaveValue(turnover);
  });

  test("@quarantine an unknown fact renders as INPUT NEEDED rather than an invented value", async ({ page }) => {
    await signIn(page);
    await page.goto("/company");

    await page.getByLabel("Annual turnover").fill("");
    await page.getByRole("button", { name: "Save" }).click();

    // Product rule 1: unknowns are declared, never guessed.
    await page.goto("/bids");
    await page.getByRole("link", { name: /Stage 0 Energy Audit/ }).click();
    await page.getByRole("button", { name: "Respond" }).click();
    await expect(page.getByTestId("answer-list")).toContainText("[INPUT NEEDED");
  });
});
