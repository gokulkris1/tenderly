import { defineConfig, devices } from "@playwright/test";

/**
 * Journeys run against a deployed staging environment (STAGING_URL), never against
 * live eTenders: tender imports in CI use the recorded fixtures in e2e/fixtures/.
 *
 * Tags:
 *   @smoke      — the subset run against production after a release.
 *   @quarantine — known-flaky, excluded from the blocking run. See CONTRIBUTING.md.
 */
export default defineConfig({
  testDir: "./e2e/journeys",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  retries: 2,
  workers: process.env.CI ? 2 : undefined,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [["html", { open: "never" }], ["github"]] : [["list"]],
  use: {
    baseURL: process.env.STAGING_URL ?? "http://localhost:5173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
