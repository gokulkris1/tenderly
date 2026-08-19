import { test, expect } from "@playwright/test";
import { SEEDED, openSeededTender, signIn } from "../support/app";

/**
 * Product rule 1: unknown facts are declared, never invented. If this journey
 * ever passes while the placeholder is absent, the product has started guessing.
 */
test.describe("unknown facts are declared", () => {
  test("@smoke an answer missing a fact carries [INPUT NEEDED] and reads needs-input", async ({ page }) => {
    await signIn(page);
    await openSeededTender(page, SEEDED.blocked, "Respond");
    const answers = page.locator(".answer-editor, .response-layout");
    await expect(answers.first()).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(/\[INPUT NEEDED/).first()).toBeVisible();
    // The section is not counted as finished.
    await expect(page.getByText(/needs input/i).first()).toBeVisible();
  });
});
