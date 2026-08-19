# Setup checklist — the hand-off contract

Everything that cannot be done from the editor, and the current state of each item.
Updated 2026-08-19 after bootstrap phases 0–4.

Legend: **[done]** already completed · **[you]** needs a human · **[auto]** a script does it

---

## 1. Jira — project TLY at ingenietech.atlassian.net

| | Item | Notes |
|---|---|---|
| **[done]** | Project **TLY — Tenderly** exists (team-managed software) | id 10000, board id 1 |
| **[done]** | Workflow statuses To Do → In Progress → In Review → In Test → Done | already configured |
| **[done]** | Issue types **Epic, Story** | shipped with the project |
| **[done]** | Issue types **Test** (10041), **Bug** (10040) | added by hand — team-managed projects expose no API for this |
| **[done]** | Link type **Verifies** (`is verified by` / `verifies`) | created via API |
| **[done]** | 13 Epics + 88 Stories imported | `TLY-6`…`TLY-106`, keys in `backlog/created-issues.csv` |
| **[done]** | Sprint 1 filled and running | 10 stories + 10 Test tickets, sprint id 2 |
| **[auto]** | Test ticket per Story, carrying the acceptance criteria as its manual script | `scripts/jira/start-sprint.mjs` |
| **[auto]** | Story transitions on branch/PR/merge | `.github/workflows/jira-sync.yml` |
| **[auto]** | Bug filed and linked on e2e failure, added to the sprint | `scripts/jira/report-e2e.mjs` |
| **[auto]** | Sprint closes when everything is Done | `scripts/jira/close-sprint.mjs` |
| **[you]** | Three filtered boards, if you want them: *Stories*, *Tests*, *Bugs* | cosmetic; the automation does not need them |

> **No Jira automation rules are required.** The state machine lives in this repository —
> see `docs/AUTOMATION.md` for why. If you later add a rule covering the same event,
> make sure only one owner handles each transition.

## 2. GitHub — github.com/gokulkris1/tenderly

| | Item | Notes |
|---|---|---|
| **[you]** | Push `TLY-0-bootstrap` and open its PR into `main` | first PR through the pipeline |
| **[auto]** | Repository secrets | `scripts/github/configure-repo.mjs` |
| **[auto]** | Branch protection on `main` requiring `ci-pr`, with auto-merge enabled | same script |
| **[auto]** | Environments `staging` and `production` | same script; **production requires a reviewer** |
| **[you]** | Add yourself as the required reviewer on the `production` environment | GitHub does not let a token grant approval rights to its own owner reliably — confirm it in Settings → Environments |
| **[you]** | Install **GitHub for Jira** against this repository | Jira → Apps → GitHub for Jira. Gives Jira the commit/branch/PR panel. Not needed for the automation, but you lose the development panel without it. |

### Repository secrets

| Secret | Needed by | Have it? |
|---|---|---|
| `JIRA_SITE` `JIRA_EMAIL` `JIRA_API_TOKEN` `JIRA_PROJECT` | every Jira transition | yes — in `~/.tenderly/secrets.env` |
| `STAGING_URL` | health poll, e2e target | **[you]** once staging exists |
| `RENDER_DEPLOY_HOOK_STAGING` | API staging deploy | **[you]** Render → service → Settings → Deploy Hook |
| `NETLIFY_BUILD_HOOK_STAGING` | web staging deploy | **[you]** Netlify → Site config → Build hooks |
| `PRODUCTION_URL` `RENDER_DEPLOY_HOOK_PRODUCTION` `NETLIFY_BUILD_HOOK_PRODUCTION` | prod release | **[you]** when production is stood up |
| `JIRA_AUTOMATION_WEBHOOK` | optional mirror | only if you ever add Jira-side rules |

Every deploy step is guarded on its secret being present, so the workflows stay green
while an environment is still being built rather than failing on absence.

## 3. Hosting

| | Item | Notes |
|---|---|---|
| **[you]** | Stand up a **staging** Render service + Netlify site + Neon branch | none exist today — deploys are currently straight to production |
| **[you]** | Staging env vars: `DATABASE_URL`, `JWT_SECRET`, `CRON_SECRET`, `CORS_ORIGINS`, **`ANTHROPIC_API_KEY`**, `ANTHROPIC_MODEL=claude-fable-5` | the model key is server-side only and must never reach the browser |
| **[you]** | Turn **off** Render/Netlify autodeploy from `main` once `main.yml` owns deploys | otherwise two things deploy the same commit |
| **[you]** | Neon: confirm point-in-time retention window | feeds story `TLY-100` (backup runbook) |

## 4. Observability and third parties (later epics)

| | Item | Story |
|---|---|---|
| **[you]** | Sentry projects for API and web, with the Jira integration | `TLY-95` (E12-03) |
| **[you]** | Transactional email provider account + DNS (SPF/DKIM/DMARC) | after the spike `TLY-35` (E3-02) |
| **[you]** | Object storage bucket, EU region | after the spike `TLY-51` (E6-01) |
| **[you]** | Stripe account, test mode first | `TLY-84` onward (E11) |

## 5. Credentials hygiene

- Live credentials are in `~/.tenderly/secrets.env` (mode 600, outside the repo).
- `.gitignore` blocks `.env` files; `git ls-files` shows no secret has ever been tracked.
- The Atlassian token is user-scoped. If you want the audit trail to read as automation
  rather than as you, mint a second token from a dedicated Atlassian user and swap it in
  — nothing else changes.
- Rotation: revoke at the issuing site, edit `~/.tenderly/secrets.env`, re-run
  `scripts/github/configure-repo.mjs` to push the new value into GitHub.

## 6. The one thing that is genuinely manual, forever

Adding issue types to a **team-managed** Jira project. If you ever need another type
beyond Epic/Story/Test/Bug, it is a UI action. Everything else in this pipeline is
scripted.
