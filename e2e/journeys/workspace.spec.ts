import { test, expect } from "@playwright/test";
import { SEEDED, signIn } from "../support/app";

/**
 * NOTE (TLY-118): there is no UI to switch between saved bids — My bids always
 * shows the most recently updated tender. Until that is fixed these journeys can
 * only exercise the selected tender, which the seed makes deterministic by
 * writing the blocked tender last.
 */

test.describe("workspace", () => {
  test("@smoke a seeded user signs in and lands on their current bid", async ({ page }) => {
    await signIn(page);
    await page.getByRole("button", { name: /My bids/ }).first().click();
    await expect(page.getByText(SEEDED.blocked).first()).toBeVisible({ timeout: 30_000 });
    // The five bid stages are reachable.
    for (const stage of ["Qualify", "Synopsis", "Respond", "Assemble", "Submit"]) {
      await expect(page.getByRole("button", { name: new RegExp(stage) }).first()).toBeVisible();
    }
  });

  test("@smoke the discovery sector lever persists", async ({ page }) => {
    await signIn(page);
    await page.getByRole("button", { name: /Settings/ }).first().click();
    await expect(page.locator('[data-testid="discovery-preferences"]')).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-testid="sector-software-development"] input')).toBeChecked();
    await expect(page.locator('[data-testid="sector-software-testing"] input')).toBeChecked();
    await expect(page.locator('[data-testid="covered-cpv"] i').first()).toBeVisible();
  });
});
