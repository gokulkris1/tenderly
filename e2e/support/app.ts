import { expect, type Page } from "@playwright/test";

/**
 * Shared journey helpers. Selectors live here so a UI change is a one-file fix
 * rather than a rewrite of every spec.
 *
 * TODO(TLY-19): the data-testid hooks these rely on (eligibility-gates, gate,
 * blockers, answer-list) are added when the v1 source lands and the screens are
 * split into feature modules. Until then these journeys are the specification.
 */

const seeded = {
  email: process.env.E2E_EMAIL ?? "demo@tenderly.example",
  password: process.env.E2E_PASSWORD ?? "e2e-seeded-password",
};

export async function signIn(page: Page) {
  await page.goto("/");
  await page.getByLabel("Email").fill(seeded.email);
  await page.getByLabel("Password").fill(seeded.password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await expect(page.getByRole("navigation")).toBeVisible();
}

/**
 * Imports the recorded fixture notice. Never reaches etenders.gov.ie: the API is
 * pointed at the fixture by the staging seed (story E13-04).
 */
export async function importFixtureTender(page: Page) {
  const title = "Stage 0 Energy Audit Services";
  await page.goto("/discover");
  await page.getByRole("button", { name: /import by url/i }).click();
  await page.getByLabel("Notice URL").fill(process.env.E2E_FIXTURE_NOTICE_URL ?? "fixture://notice-detail");
  await page.getByRole("button", { name: /^import$/i }).click();
  await expect(page.getByRole("heading", { name: title })).toBeVisible({ timeout: 60_000 });
  return { title };
}
