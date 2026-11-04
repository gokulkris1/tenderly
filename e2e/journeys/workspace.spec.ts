import { test, expect } from "@playwright/test";
import { SEEDED, signIn } from "../support/app";

/**
 * The seed writes the blocked tender last, so it is the one selected on arrival.
 * Since TLY-118 every saved bid is reachable from the list.
 */

test.describe("workspace", () => {
  test("@smoke a seeded user signs in and lands on their current bid", async ({ page }) => {
    await signIn(page);
    await page.getByRole("button", { name: /Tender board/ }).first().click();
    await expect(page.getByText(SEEDED.blocked).first()).toBeVisible({ timeout: 30_000 });
    await page.getByText(SEEDED.blocked).first().click();
    for (const stage of ["Overview", "Qualification & scoring", "Synopsis", "Respond", "Assemble", "Submit"]) {
      await expect(page.getByRole("button", { name: new RegExp(stage) }).first()).toBeVisible();
    }
  });

  test("@smoke every saved bid is reachable, not just the most recent", async ({ page }) => {
    await signIn(page);
    await page.getByRole("button", { name: /Tender board/ }).first().click();
    // The seed creates two tenders; both must be listed and openable.
    const items = page.locator(".tracker-card");
    await expect(items).toHaveCount(2);
    await expect(page.getByText(SEEDED.blocked).first()).toBeVisible();
    await items.filter({ hasText: /Software Testing and QA/ }).getByRole("button").click();
    await expect(page.locator("h1").first()).toContainText(/Software Testing and QA/);
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
