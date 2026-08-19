import { expect, type Page } from "@playwright/test";

/**
 * Shared journey helpers.
 *
 * Journeys run against the seeded demo account created by `npm run seed:staging`
 * (TLY-104), so every run starts from the same state: two tenders, one ready to
 * assemble and one with an unresolved mandatory item.
 */

export const demo = {
  email: process.env.E2E_EMAIL ?? "demo@tenderly.example",
  password: process.env.E2E_PASSWORD ?? "tenderly-staging-demo-password",
};

/** Titles of the seeded tenders. */
export const SEEDED = {
  ready: /Software Testing and QA Services/,
  blocked: /Application Development Framework/,
};

export async function signIn(page: Page) {
  await page.goto("/");
  await page.getByLabel("Email").fill(demo.email);
  await page.getByLabel("Password").fill(demo.password);
  await page.getByRole("button", { name: /sign in/i }).click();
  // The workspace loads several endpoints plus a live discovery call.
  await expect(page.getByRole("button", { name: /My bids/ }).first()).toBeVisible({ timeout: 60_000 });
}

/** Opens one of the seeded tenders and lands on the named stage. */
export async function openSeededTender(page: Page, title: RegExp, stage: string) {
  await page.getByRole("button", { name: /My bids/ }).first().click();
  await page.getByText(title).first().click();
  await page.getByRole("button", { name: new RegExp(stage) }).first().click();
}
