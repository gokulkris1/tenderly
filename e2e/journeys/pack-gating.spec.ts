import { test, expect } from "@playwright/test";
import { SEEDED, openSeededTender, signIn } from "../support/app";

/**
 * Product rule 2: the final pack stays locked until mandatory items resolve.
 * The draft pack must stay available throughout, so work can continue.
 */
test.describe("final pack gating", () => {
  test("@smoke the final ZIP is refused while a mandatory item is unresolved", async ({ page }) => {
    await signIn(page);
    await openSeededTender(page, SEEDED.blocked, "Submit");
    await page.getByRole("button", { name: /Download final ZIP/i }).click();
    // The API is the authority: it answers 409 with the blocker list.
    await expect(page.locator('[data-testid="blockers"]').first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-testid="blockers"]').first()).toContainText(/tax clearance/i);
  });

  test("the draft pack stays available while the final one is locked", async ({ page }) => {
    await signIn(page);
    await openSeededTender(page, SEEDED.blocked, "Assemble");
    await expect(page.getByRole("button", { name: /draft ZIP/i })).toBeEnabled();
  });

  // The "everything resolved unlocks the pack" case cannot be driven from the UI
  // until TLY-118 gives a route to a second saved bid. It is covered server-side
  // by documents-pack.test.ts, which asserts the blocker list empties.
});
