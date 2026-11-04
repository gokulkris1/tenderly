# Tenderly — Handover Notes

**Date:** 2026-11-04 · **Branch:** `TLY-242-attestation-covers-the-submission` · **Head commit:** `b1f4f9b`
**PR to open/merge:** https://github.com/gokulkris1/tenderly/compare/main...TLY-242-attestation-covers-the-submission

---

## 1. What Tenderly is now

A **tracking-first tender workspace** for Irish (and now EU-wide via TED) public tenders:

- **Tender board** (Jira-style): New → Review → Consider → Application in progress → Done, plus Ignore; Won / Not-won outcomes; assignee, priority, notes; drag/drop; value bands (EUR 200k inclusive); CPV boards (org-scoped, one shared tender record across boards).
- **Complete discovery**: eTenders (Ireland, full CPV descendant expansion, all pages, no caps) + TED (EU-wide, all pages, future-deadline filter). Live check on 2026-11-04: **58 open CFTs** for the 72000000 family.
- **Tender overview**: full CFT fields, document links, public buyer contacts, source-change history, attachments; source refresh never overwrites human decisions.
- **Biddy**: evidence-bound AI bid writer (draft/revise), with `[INPUT NEEDED]` markers, claims-to-verify, AI-use policy handling, no-AI mode.
- **Superset features**: Buyers directory/profiles, Market dashboard (stats, CPV divisions, top buyers, competitor insights from OGP awards), Discover upgrades (match buckets, dismissals, filters, CSV export), clarification hub with eTenders deep link + optional portal connection (Beta).
- Existing retained: qualification/scoring, evidence vault, people/CVs, pack assembly, submission runbook, ESPD declarations, team/roles, account export/deletion.

## 2. Deployment state

| Piece | Where | State |
|---|---|---|
| Web app | Netlify `gettenderly` → https://gettenderly.netlify.app | ✅ **Deployed 2026-11-04** (CLI deploy `6aeaf80ecc7fd79e89adeb06`, prebuilt `dist-netlify`). Runs in **demo mode** because `VITE_API_URL` is not set on Netlify. |
| API | Render service `tenderly-api` (https://tenderly-api.onrender.com) | ⛔ **SUSPENDED** — resume it in the Render dashboard. Migrations 029–033 apply automatically on startup. |
| DB | Neon Postgres (connection string in Render env) | Untouched by this work; migrations pending until API restarts. |
| Cron | Render `tenderly-discovery` (starter plan) + `tenderly-deletions` | Defined in `render.yaml`; verify they're enabled. |

**Netlify build gate:** `netlify.toml` skips all builds unless site env `TENDERLY_NETLIFY_DEPLOYS=on` (build-credit protection). Two deploy paths:
1. CLI (fast, no build credits): build locally with Bun, then `netlify deploy --prod --dir=dist-netlify --no-build`. Must add `dist-netlify/_redirects` (`/* /index.html 200`) and `_headers` (copy from `netlify.toml`) first — the linked `netlify.toml` build config is *not* applied to `--no-build` dir deploys.
2. Git: set `TENDERLY_NETLIFY_DEPLOYS=on` (`node scripts/netlify-deploys.mjs on`, needs `NETLIFY_AUTH_TOKEN`), merge PR to main. Remember to turn it off again or every PR burns credits.

**To connect live data:** resume Render API → confirm `/health` 200 → set Netlify env `VITE_API_URL=https://tenderly-api.onrender.com` → redeploy (either path). Check the API's `CORS_ORIGINS` env includes the site origin (code default still says `tenderly.netlify.app`, the real site is `gettenderly.netlify.app`).

## 3. Environment quirks of this machine (important)

- **No system node/npm on PATH.** Node = VS Code's Electron binary: `ELECTRON_RUN_AS_NODE=1 '/Applications/Visual Studio Code.app/Contents/MacOS/Code' <script>`.
- **Bun** at `/Users/gurijala/.bun/bin/bun` — required for Vite builds (`bun run --bun node_modules/vite/bin/vite.js build --config vite.netlify.config.ts`). Vite under Electron-node fails on a native module (code-signing), that is NOT a missing dependency.
- Netlify CLI: `/Users/gurijala/AgentiumDirect/agentiumdirect/node-v20.19.0-darwin-arm64/bin/netlify`, already authenticated as the owner; site linked (`.netlify/` local, gitignored).
- Port 5173 belongs to a different app — never touch. Tenderly demo preview uses 5174.
- **Incident (resolved):** an agent briefly truncated the VS Code binary via a symlink; it was restored and verified (`codesign --verify --deep --strict` passes). Never write files through `node` symlinks.

## 4. How to run and verify

```bash
# Frontend dev (demo mode, no API)
/Users/gurijala/.bun/bin/bun run --bun node_modules/vite/bin/vite.js --config vite.netlify.config.ts --host 127.0.0.1   # port 5174

# API tests — ALWAYS neutralise env so no real DB/AI is touched
cd server && DOTENV_CONFIG_PATH=/dev/null DATABASE_URL='' OPENAI_API_KEY='' ANTHROPIC_API_KEY='' \
  ELECTRON_RUN_AS_NODE=1 '/Applications/Visual Studio Code.app/Contents/MacOS/Code' \
  --import tsx --test tests/*.test.ts ../components/TenderTracker.test.ts
# Baseline: 611 pass / 0 fail / 1 skip

# Typechecks (root / server / shared)
.../Code node_modules/typescript/bin/tsc --noEmit -p tsconfig.typecheck.json   # + server/tsconfig.json, packages/shared/tsconfig.json

# Browser journeys (mocked API, no server needed)
VITE_API_URL=http://127.0.0.1:8788 bun run --bun node_modules/vite/bin/vite.js --config vite.netlify.config.ts --host 127.0.0.1 --port 5175 --strictPort &
PLAYWRIGHT_BASE_URL=http://127.0.0.1:5175 .../Code node_modules/@playwright/test/cli.js test e2e/journeys --project=chromium
# Staging-only specs (workspace/routing/no-live-etenders/input-needed/pack-gating) need a seeded API: scripts/seed-staging.mjs (requires a non-production DATABASE_URL).
```

## 5. Product rules that must not be broken (tests enforce most)

1. Missing evidence is **Review**, never a green tick; unknown facts become `[INPUT NEEDED: …]`, never invented.
2. Opening a tender never changes its stage; only humans mark ready; Biddy output is always a draft.
3. Source refresh preserves workflow/attestation/checklist/lot selection (see `USER_OWNED_METADATA` in `server/src/db.ts`).
4. A matching CPV family is enough for intake — no score threshold may hide CPV matches.
5. EUR 200,000 exactly belongs to the **lower** value band; unknown values are their own band.
6. Won/Not-won forces Done; leaving Done resets outcome to Pending.
7. Discovery truncation is an explicit error, never a silent partial feed (page ceilings, repeated pages, detail failures).
8. Tenant isolation: every new route must be account-scoped; owner/editor/viewer roles enforced server-side (viewers read-only).
9. No fake success: failed syncs/portal sends surface persistent warnings; demo data is labelled demo.
10. Credentials (portal connection) are AES-256-GCM under `TENDERLY_PORTAL_KEY`, never logged or returned.

## 6. Known limitations / honest gaps

- **Migrations 029–033 are untested against real Postgres** (memory-mode tested only; no local Postgres available). Verify on staging before they hit production data.
- **eTenders portal connection is fixture-tested only** — no public messaging API exists; first real login flips status untested→ok/failed. ePPS layout changes will break it loudly by design.
- **OGP award dataset not loaded** → Market/competitors shows honest empty state. Load with `npm run import:ogp` (server).
- **No email provider** — `server/src/mail.ts` logs only (`mailConfigured()` false). Invitations/alerts are in-app until TLY-35 chooses a provider.
- **No payments** — billing scaffolding exists, no checkout activated.
- **TED query intentionally excludes notices without a published deadline** (documented in `docs/DATA_SOURCES.md`).
- Board `countries` union at account level in matching (boards pool CPVs the same way).
- Frontend bundle ~431 kB (124 kB gzip) — fine for now, watch it.

## 7. Key files map

| Area | Files |
|---|---|
| Board + record UI | `components/TenderTracker.tsx`, `tracker.css` |
| App shell + workspace | `components/TenderlyApp.tsx` (~4.5k lines — candidate for splitting), `tenderly.css` |
| New superset UI | `components/Buyers.tsx`, `MarketDashboard.tsx`, `MarketScope.tsx`, `PortalConnectionCard.tsx`, `superset.css` |
| Biddy | `server/src/prompts/drafting.ts`, `prompts/refine.ts`, `src/ai-policy.ts`, `src/drafting.ts`, skill: `.github/skills/biddy-bid-writing/SKILL.md` |
| Discovery | `server/src/etenders.ts`, `sources/ted.ts`, `jobs.ts`, `ingest.ts`, `pressure.ts` (deadline parsing, Europe/Dublin) |
| Superset backend | `server/src/market.ts`, `portal.ts`, `sources/etenders-account.ts` |
| Workflow | `server/src/tender-workflow.ts` |
| DB/migrations | `server/src/db.ts`, `server/migrations/029–033` |
| Contracts | `packages/shared/src/index.ts`, `web/src/api/client.ts` |
| Tests | `server/tests/tender-tracker.test.ts`, `discovery-completeness.test.ts`, `superset-features.test.ts`, `biddy-policy.test.ts`; `e2e/journeys/tender-tracker.spec.ts`, `superset.spec.ts`, `biddy-respond.spec.ts` |
| Docs | `README.md`, `docs/DATA_SOURCES.md` |

## 8. Next actions (priority order)

1. Resume Render `tenderly-api`; watch startup logs for migrations 029–033; verify `/health`.
2. Set Netlify `VITE_API_URL`, redeploy, sign in with the real account, run **Sync tenders**, eyeball the 58-CFT board.
3. Create + merge the PR to main (link above); decide the Netlify build-gate policy.
4. Load OGP awards on the API; verify Market → Competitors populates.
5. Decide `TENDERLY_PORTAL_KEY` (Beta portal connection) and an email provider (TLY-35).
6. Real-evaluation pass on Biddy output against representative tender packs (browser tests mock the model).
7. Payments/subscription design before any external customer.
