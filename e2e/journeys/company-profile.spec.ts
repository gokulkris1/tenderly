import { test, expect } from "@playwright/test";
import { signIn } from "../support/app";

/** Journey 2 — the company profile round-trips. Everything downstream cites it. */
test.describe("company profile", () => {
  test("@smoke profile values survive a save and reload", async ({ page }) => {
    await signIn(page);
    await page.goto("/company");

    const turnover = `${2_000_000 + Math.floor(Date.now() % 1000)}`;
    await page.getByLabel("Annual turnover").fill(turnover);
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Saved")).toBeVisible();

    await page.reload();
    await expect(page.getByLabel("Annual turnover")).toHaveValue(turnover);
  });

  test("an unknown fact renders as INPUT NEEDED rather than an invented value", async ({ page }) => {
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
