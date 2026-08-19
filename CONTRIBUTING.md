# Contributing to Tenderly

Delivery runs through Jira project **TLY** and GitHub. The rules below are not style
preferences — the automation depends on them. See `docs/AUTOMATION.md` for what runs
where and why.

## The two product rules

Nothing merges that weakens either of these:

1. **Missing or conflicting evidence is `Review`, never a green tick.** Unknown facts
   render as `[INPUT NEEDED: …]`. The system never invents a claim.
2. **The final pack stays locked** until mandatory items are resolved, and a human
   reviews before anything leaves the system.

If a change makes either easier to bypass, it needs an explicit decision recorded on
the story — not a reviewer's shrug.

## One story, one branch, one PR

| Thing | Format | Example |
|---|---|---|
| Branch | `TLY-<n>-<short-slug>` | `TLY-19-commit-v1-source` |
| Commit | `TLY-<n>: <what changed>` | `TLY-19: move v1 application source to repo root` |
| PR title | `TLY-<n>: <story summary>` | `TLY-19: Commit the v1 application source into the repository` |

The `pr-conventions` check enforces the PR title and that the branch carries the same
key. The key is how every automated transition finds your issue — without it your
story silently never moves.

Never push to `main`. Never force-push a shared branch. Never commit `.env` or a token.

## The lifecycle, and what moves your ticket

| You do | Automation does |
|---|---|
| Push a branch named `TLY-19-…` | Story → **In Progress** |
| Open a PR | Story → **In Review** |
| Merge the PR | Story → **In Test**, staging deploys, e2e runs |
| e2e passes | Linked **Test** ticket → Done, Story → **Done** |
| e2e fails | A **Bug** is filed against the story, linked and added to the sprint. The Story stays In Test. |
| Fix the bug and merge | Dispatch **E2E rerun** with `issueKeys=TLY-19` to re-report and unblock |

A Story reaches Done only when its Test tickets pass. That is deliberate: merged is not
the same as verified.

## Writing the work

- **Implement to the acceptance criteria exactly.** They are on the story, numbered
  `AC1…ACn`, and they are also the manual test script on the linked Test ticket. If a
  criterion is ambiguous, ask — do not guess and do not quietly reinterpret it.
- **Name tests after the scenario they verify**, so a failure points at a criterion:
  `TLY-42 AC3: final pack stays locked without tax clearance`.
- **Unit tests always.** If the story changes a user journey, extend the matching
  Playwright journey too.
- **No drive-by refactors** inside a feature branch. Spot something? New story.
- TypeScript strict everywhere. Small commits.

## Tests and CI

`ci-pr` is the required check: lint, typecheck, unit tests, both builds, and
integration tests against a Postgres service container running `server/migrations`.
**Never merge a red PR.** Enable auto-merge and let the check gate it.

E2E journeys live in `e2e/journeys/` and run against staging. They use the recorded
fixtures in `e2e/fixtures/` — **a journey that reaches `etenders.gov.ie` in CI is a
bug**, both because it is flaky and because we do not own that service.

### Tags

- `@smoke` — the subset run against production after a release. Keep it fast and keep
  it to journeys whose failure means "roll back now".
- `@quarantine` — known-flaky. Excluded from the blocking run, executed in a separate
  non-blocking job so it stays visible.

### Quarantine rules

Anyone may quarantine a test that has failed twice without a code change. When you do:
add the tag, and add a line to the quarantine list on the story that owns it, with the
date and your name. **A test may stay quarantined for 10 working days.** After that it
is fixed or deleted — a permanently quarantined test is worse than no test, because it
looks like coverage.

## Local setup

```bash
npm ci && npm ci --prefix server
npm run typecheck && npm run lint
npm test --prefix server
npx playwright test          # needs a running app or STAGING_URL
```

Credentials for the Jira tooling come from the environment, never from a file in the
repo:

```bash
set -a; . ~/.tenderly/secrets.env; set +a
node scripts/backlog-lint.mjs           # validate the backlog
node scripts/jira/start-sprint.mjs --name "Sprint 1" --sprint1 --days 14 --dry-run
```
