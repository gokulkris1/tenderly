# CLAUDE.md

Guidance for Claude Code working in this repository.

## What this is

Tenderly is a bidder-side workspace for Irish public tenders (eTenders). A React +
Vite front end on Netlify talks to an Express/TypeScript API on Render, which talks to
Postgres (Neon), eTenders and the Anthropic API. The browser never reaches the
database or the model directly — secrets stay on the API.

Read `README.md` for the product, `CONTRIBUTING.md` for the delivery rules and
`docs/AUTOMATION.md` for what CI/Jira automation does and why.

## The two rules nothing may weaken

1. **Missing or conflicting evidence is `Review`, never a green tick.** Unknown facts
   render as `[INPUT NEEDED: …]`. The system never invents a claim. `PASS` needs
   affirmative bidder evidence *and* a requirement it satisfies; `FAIL` is reserved
   for an explicit mandatory mismatch.
2. **The final pack stays locked** while fatal gates are `REVIEW`/`FAIL`, required
   answers are not marked ready, or mandatory buyer-file items are incomplete. Draft
   ZIPs are always allowed; the final one is not.

If a change makes either easier to bypass, stop and raise it rather than shipping it.

## Layout

| Path | What lives there |
|---|---|
| `server/src/` | Express API. `etenders.ts` is the only portal connector; `ai.ts` + `prompts/` the model calls; `pack.ts` the ZIP/gating; `documents.ts` extraction. |
| `server/tests/` | `node --test` unit tests over parsing, extraction, gating, prompt injection. |
| `server/migrations/` | Idempotent SQL, applied on API startup and in CI. |
| `components/`, `web/src/`, `web-static/` | The Vite front end and its API client. |
| `packages/shared/` | Wire types shared by web and server (`@tenderly/shared`). |
| `e2e/journeys/` | Playwright journeys against staging, from `e2e/fixtures/`. |
| `scripts/jira/`, `scripts/github/` | Delivery automation called from workflows. |
| `backlog/` | Story data the Phase 2 importer reads; `scripts/backlog-lint.mjs` gates it in CI. |

## Commands

```bash
npm ci && npm ci --prefix server   # install both projects
npm run typecheck                  # all three tsconfigs, reports every failure
npm run lint
npm test --prefix server           # unit tests
npm run build:netlify              # web build
npm run build --prefix server      # API build
npx playwright test                # needs a running app or STAGING_WEB_URL
```

`npm run typecheck` deliberately does not stop at the first project — a shared-type
change usually breaks web and server together.

Run `npm run typecheck && npm run lint && npm test --prefix server` before pushing.
That is most of what `ci-pr` checks.

## Conventions

- Branch `TLY-<n>-<slug>`, commit `TLY-<n>: <what changed>`, PR title
  `TLY-<n>: <summary>`. The `pr-conventions` check enforces the title and that the
  branch carries the same key, and every Jira transition keys off it.
- Never push to `main`. Never force-push a shared branch. Never commit `.env` or a
  token — credentials come from the environment.
- Implement to the numbered acceptance criteria on the story exactly; ask rather than
  reinterpret. Name tests after the criterion they verify
  (`TLY-42 AC3: final pack stays locked without tax clearance`).
- Unit tests always; extend the matching Playwright journey when a user journey
  changes. No drive-by refactors inside a feature branch — file a new story.
- TypeScript strict everywhere. Small commits. Unused throwaways are `_`-prefixed.

## Things that bite

- **`ci-pr` is the required check and branch protection includes administrators.**
  Never merge red or pending; enable auto-merge and let the check gate it.
- **A journey that reaches `etenders.gov.ie` in CI is a bug** — flaky, and not our
  service to call. Use the recorded fixtures.
- **`@quarantine` is a 10-working-day loan**, recorded on the owning story with a date
  and name. After that the test is fixed or deleted. The empty-suite guard in
  `main.yml` reports an all-quarantined run as "did not run", never as a pass.
- **`ANTHROPIC_API_KEY` is empty in CI on purpose.** Analysis and drafting must never
  reach a live model there.
- **The heading string `Acceptance Criteria` is load-bearing.** `jira-import.mjs`
  writes it and `scripts/jira/client.mjs` reads it; changing one alone produces empty
  Test tickets silently. See `docs/AUTOMATION.md`.
- **SSRF boundary:** arbitrary pasted URLs are not fetched; automatic procurement
  fetches are restricted to official eTenders hosts. Keep it that way.
- If the portal changes its markup, fix `server/src/etenders.ts` and its fixtures —
  not the bid workflow.
