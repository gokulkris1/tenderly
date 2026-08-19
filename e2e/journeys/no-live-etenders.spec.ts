import { test, expect } from "@playwright/test";
import { SEEDED, signIn } from "../support/app";

/**
 * A journey that reaches etenders.gov.ie in CI is a bug: it makes the suite
 * flaky and puts load on a public service we do not own. Seeded data means the
 * journeys never need it.
 */
test("journeys complete with etenders.gov.ie unreachable", async ({ page }) => {
  const blocked: string[] = [];
  await page.route(/etenders\.gov\.ie/, (route) => {
    blocked.push(route.request().url());
    return route.abort("blockedbyclient");
  });
  await signIn(page);
  await page.getByRole("button", { name: /My bids/ }).first().click();
  await expect(page.getByText(SEEDED.blocked).first()).toBeVisible({ timeout: 30_000 });
  expect(blocked, "no journey should need the live portal").toEqual([]);
});
