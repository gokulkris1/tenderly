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
 * Journey 3 — the final pack stays locked until mandatory items resolve.
 * This is product rule 2 and the single most important behaviour to protect.
 */
test.describe("final pack gating", () => {
  test("@quarantine @smoke final ZIP is blocked while a mandatory item is unresolved", async ({ page }) => {
    await signIn(page);
    await importFixtureTender(page);
    await page.getByRole("button", { name: "Assemble" }).click();

    await expect(page.getByRole("button", { name: "Download final ZIP" })).toBeDisabled();
    await expect(page.getByTestId("blockers")).toContainText(/tax clearance/i);

    // The draft pack must stay available so work can continue while gaps are closed.
    await expect(page.getByRole("button", { name: "Download draft ZIP" })).toBeEnabled();
  });

  test("@quarantine resolving the blocker unlocks the final ZIP", async ({ page }) => {
    await signIn(page);
    await importFixtureTender(page);

    await page.goto("/evidence");
    await page.getByRole("button", { name: "Add evidence" }).click();
    await page.getByLabel("Name").fill("Tax clearance certificate");
    await page.getByLabel("Kind").selectOption("Tax clearance");
    await page.getByRole("button", { name: "Save" }).click();
    await page.getByRole("button", { name: "Verify" }).first().click();

    await page.goto("/bids");
    await page.getByRole("link", { name: /Stage 0 Energy Audit/ }).click();
    await page.getByRole("button", { name: "Assemble" }).click();
    await expect(page.getByTestId("blockers")).not.toContainText(/tax clearance/i);
  });
});
