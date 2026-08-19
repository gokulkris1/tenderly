# Delivery automation — what runs where, and why

Audit date: 2026-08-19 · Companion to `CONTRIBUTING.md`

## The decision

The master build prompt (§2) assumed the Jira side of the delivery loop would be built
as **Jira automation rules configured outside this repository**: sprint-start Test
creation, branch/PR transitions, e2e webhook handling, Bug filing, sprint close.

We did not do that. **The automation lives in this repository instead**, as GitHub
Actions calling `scripts/jira/*`.

### Why

1. **TLY is a team-managed (next-gen) Jira project.** Automation rules in a
   team-managed project can only be created by clicking through the Jira UI. There is
   no supported public REST API for creating them, and the internal endpoints the UI
   uses are not exposed to token auth (four were probed on 2026-08-19; all 404).
2. **The requirement was explicit: no hand-built tickets or rules.** Anything that can
   only be produced by clicking is a step that rots the moment someone forgets it.
3. **Version control is the point.** A rule in the Jira UI has no diff, no review, no
   test, and no history. `scripts/jira/report-e2e.mjs` has all four.

### What this costs

- The transitions happen a few seconds later than a native Jira rule would fire.
- If someone later adds a Jira automation rule covering the same event, both will run.
  The scripts are idempotent — an issue already in the target status is a logged no-op —
  so the outcome stays correct, but **one owner per transition** is the rule. Add rules
  in Jira only for events this repo does not handle.
- GitHub secrets now hold Jira credentials. They are repo-scoped and used only by the
  workflows below.

## The state machine

```
  branch TLY-19-…  ──►  In Progress        (jira-sync.yml, on: create)
  PR opened        ──►  In Review          (jira-sync.yml)
  PR merged        ──►  In Test            (jira-sync.yml)
  PR closed unmerged ─►  To Do             (jira-sync.yml)

  push to main ──► staging deploy ──► /health poll ──► e2e
                                                       │
                            pass ──► Test → Done, Story → Done   (report-e2e.mjs)
                            fail ──► Bug filed, linked "Blocks",
                                     added to the active sprint,
                                     Story stays In Test          (report-e2e.mjs)

  bug fixed & merged ──► dispatch e2e-rerun.yml with issueKeys ──► re-report
```

A Story reaches Done only through a passing Test ticket. Merging is not verification.

## The pieces

| Path | Responsibility |
|---|---|
| `.github/workflows/pr.yml` | `ci-pr` — the required check. Lint, typecheck, unit tests, both builds, integration tests against a Postgres service container. Plus `pr-conventions`, which enforces the `TLY-n:` title and matching branch name. |
| `.github/workflows/jira-sync.yml` | Branch and PR lifecycle transitions. |
| `.github/workflows/main.yml` | Staging deploy, health poll, e2e, and the pass/fail report into Jira. The web deploys by advancing the `staging` branch, which Netlify branch-deploys from the same repository; the API deploys through its Render hook. Mirrors to `JIRA_AUTOMATION_WEBHOOK` if one is ever configured. |
| `.github/workflows/prod.yml` | Manual or tag-triggered production deploy behind the `production` environment approval gate, then the `@smoke` suite. |
| `.github/workflows/e2e-rerun.yml` | `workflow_dispatch` with `issueKeys` — what unblocks a Test after a Bug fix. |
| `scripts/jira/client.mjs` | REST v3 + Agile v1 helper: auth, 429 retry, transitions, links, comments, and the acceptance-criteria extractor. |
| `scripts/jira/transition.mjs` | Moves every key found in a branch name or PR title to a status. No keys is a no-op, not a failure. |
| `scripts/jira/report-e2e.mjs` | Turns a CI result into Jira state: closes Tests, or files and links a Bug. |
| `scripts/jira/start-sprint.mjs` | Creates the sprint, fills it, and gives every Story a Test ticket carrying its acceptance criteria verbatim. |
| `scripts/jira/close-sprint.mjs` | Closes the sprint when everything in it is Done; otherwise reports what is open. |
| `scripts/jira-import.mjs` | The Phase 2 backlog importer. Idempotent by summary. |
| `scripts/backlog-lint.mjs` | Enforces the story and acceptance-criteria contract. Runs in `ci-pr`. |

## The load-bearing string

`start-sprint.mjs` finds the acceptance criteria by looking for a heading whose text is
exactly **`Acceptance Criteria`** in the Story's description, and copies the ordered
list beneath it into the Test ticket as the manual test script.

`jira-import.mjs` writes that heading. `client.mjs` reads it. **Change the wording in
one place and the Test tickets come out empty** — silently, because an empty script
still creates a valid ticket. If it must ever change, change `ACCEPTANCE_HEADING` in
both files in the same commit, and re-run against a dry-run sprint first.

## Secrets these workflows need

Set as repository secrets (see `SETUP_CHECKLIST.md`):

`JIRA_SITE`, `JIRA_EMAIL`, `JIRA_API_TOKEN`, `JIRA_PROJECT`,
`RENDER_DEPLOY_HOOK_STAGING`, `NETLIFY_BUILD_HOOK_STAGING`,
`RENDER_DEPLOY_HOOK_PRODUCTION`, `NETLIFY_BUILD_HOOK_PRODUCTION`,
`STAGING_URL`, `PRODUCTION_URL`, and optionally `JIRA_AUTOMATION_WEBHOOK`.

Every deploy and health step is guarded on its secret being present, so the workflows
run green while an environment is still being stood up rather than failing on absence.

## Known gaps

- **The app source is not committed yet** (story E1-01 / `TLY-19`). Until it lands,
  `ci-pr`'s install, lint, typecheck, build and test steps skip themselves via
  `hashFiles(...)` guards, and only the backlog validation runs. That story must also
  add `@playwright/test` to the root dev dependencies, or the e2e steps stay skipped.
- **The Playwright journeys are real and unquarantined** as of TLY-103. Six journeys
  run against staging from the seeded state TLY-104 creates, covering both product
  rules: an answer missing a fact carries `[INPUT NEEDED]` and reads `needs-input`,
  and the final ZIP is refused with the API's blocker list while the draft pack stays
  available. The empty-suite guard in `main.yml` stays — if every journey were ever
  quarantined again, the run would be reported as "did not run", never as a pass.
- **Journeys can only reach the selected tender** until TLY-118 is fixed: there is no
  UI to switch between saved bids, so the seed writes the blocked tender last to make
  the selection deterministic.
- **Sprints require the board feature.** `start-sprint.mjs` fails with a clear message
  if the TLY board has no scrum/sprint support enabled.
