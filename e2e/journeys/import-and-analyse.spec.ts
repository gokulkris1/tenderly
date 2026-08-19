import { test, expect } from "@playwright/test";

/**
 * QUARANTINED (TLY-102): these journeys are specifications, not passing tests.
 * They assert on data-testid hooks that arrive with the screen split (TLY-24,
 * TLY-25) and on seeded staging data that arrives with TLY-104. Running them
 * now would fail for reasons unrelated to the story being merged and file
 * misattributed Bugs. Remove the @quarantine tags in TLY-103, which makes them
 * real. Quarantined 2026-08-19.
 */

import { signIn, importFixtureTender } from "../support/app";

/**
 * Journey 1 — register/sign in, import a fixture tender, see the analysis render.
 * This is the product's spine: if this breaks, nothing else matters.
 */
test.describe("import and analyse", () => {
  test("@quarantine @smoke a signed-in user imports a tender and sees its analysis", async ({ page }) => {
    await signIn(page);

    const tender = await importFixtureTender(page);
    await expect(page.getByRole("heading", { name: tender.title })).toBeVisible();

    // Qualify stage renders gates with source quotes, not an empty shell.
    await page.getByRole("button", { name: "Qualify" }).click();
    await expect(page.getByTestId("eligibility-gates")).toBeVisible();
    await expect(page.getByTestId("eligibility-gates").getByRole("listitem")).not.toHaveCount(0);
  });

  test("@quarantine a requirement with no supporting evidence shows Review, never a green tick", async ({ page }) => {
    await signIn(page);
    await importFixtureTender(page);
    await page.getByRole("button", { name: "Qualify" }).click();

    // Product rule 1: missing or conflicting evidence is Review — never PASS, never FAIL.
    const unsupported = page.getByTestId("gate").filter({ hasText: "Employers Liability" });
    await expect(unsupported).toContainText(/review/i);
    await expect(unsupported).not.toContainText(/^pass$/i);
  });
});
