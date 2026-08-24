import { test, expect } from "@playwright/test";
import { SEEDED, signIn } from "../support/app";

/**
 * Screens are addressable (TLY-23): a bid can be linked, reloaded and navigated
 * back to. Before this, everything was component state and no screen had a URL.
 */
test.describe("routing", () => {
  test("@smoke a bid stage has its own address and survives a reload", async ({ page }) => {
    await signIn(page);
    await page.getByRole("button", { name: /My bids/ }).first().click();
    await page.getByRole("button", { name: /Respond/ }).first().click();
    await expect(page).toHaveURL(/\/bids\/[^/]+\/respond$/);

    const url = page.url();
    await page.reload({ waitUntil: "networkidle" });
    await expect(page).toHaveURL(url);
    await expect(page.getByText(SEEDED.blocked).first()).toBeVisible({ timeout: 30_000 });
  });

  test("the back button returns to the previous screen", async ({ page }) => {
    await signIn(page);
    await page.getByRole("button", { name: /Evidence/ }).first().click();
    await expect(page).toHaveURL(/\/evidence$/);
    await page.getByRole("button", { name: /Company/ }).first().click();
    await expect(page).toHaveURL(/\/company$/);
    await page.goBack();
    await expect(page).toHaveURL(/\/evidence$/);
  });

  test("an unknown bid says so instead of showing a different one", async ({ page }) => {
    await signIn(page);
    await page.goto("/bids/does-not-exist/qualify");
    await expect(page.locator('[data-testid="bid-not-found"]')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("button", { name: /Back to My bids/i })).toBeVisible();
  });
});
