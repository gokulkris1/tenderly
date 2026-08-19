import { test, expect } from "@playwright/test";
import { signIn, importFixtureTender } from "../support/app";

/**
 * Journey 1 — register/sign in, import a fixture tender, see the analysis render.
 * This is the product's spine: if this breaks, nothing else matters.
 */
test.describe("import and analyse", () => {
  test("@smoke a signed-in user imports a tender and sees its analysis", async ({ page }) => {
    await signIn(page);

    const tender = await importFixtureTender(page);
    await expect(page.getByRole("heading", { name: tender.title })).toBeVisible();

    // Qualify stage renders gates with source quotes, not an empty shell.
    await page.getByRole("button", { name: "Qualify" }).click();
    await expect(page.getByTestId("eligibility-gates")).toBeVisible();
    await expect(page.getByTestId("eligibility-gates").getByRole("listitem")).not.toHaveCount(0);
  });

  test("a requirement with no supporting evidence shows Review, never a green tick", async ({ page }) => {
    await signIn(page);
    await importFixtureTender(page);
    await page.getByRole("button", { name: "Qualify" }).click();

    // Product rule 1: missing or conflicting evidence is Review — never PASS, never FAIL.
    const unsupported = page.getByTestId("gate").filter({ hasText: "Employers Liability" });
    await expect(unsupported).toContainText(/review/i);
    await expect(unsupported).not.toContainText(/^pass$/i);
  });
});
