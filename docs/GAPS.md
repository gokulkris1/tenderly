# Tenderly — Gap Analysis vs Product Vision

Audit date: 2026-08-19 · Branch: `TLY-0-bootstrap` · Companion to `docs/ARCHITECTURE.md`

Vision: subscription SaaS for Irish SMEs bidding on public tenders — onboard once, discover by
CPV/sector, digest tender packs, Go/No-Go with reasons, AI-drafted responses with human review and
provenance (including no-AI mode), controlled submission packs. Human submits on eTenders.

Ranking: **R1 = existential/blocking**, **R2 = blocks selling**, **R3 = blocks scaling**, **R4 = quality/velocity drag**.

---

## R1 — Existential / blocks all delivery

| # | Gap | Evidence | Consequence if unaddressed |
|---|-----|----------|---------------------------|
| 1.1 | **v1 source is not committed.** `main` = README only; the app lives untracked in `tenderly-v1-source/`; a stale `origin/copilot/…` branch has a different layout. | `git ls-tree origin/main` → `README.md` | The entire Jira/GitHub delivery model (branch-per-story, PR checks, CI, auto-merge) has no code to operate on. Must be the first E1 story. |
| 1.2 | **No CI at all.** No workflows, no required checks, no e2e. Render/Netlify autodeploy `main` straight to production users. | No `.github/`; `render.yaml` `autoDeployTrigger: commit` | Any merged mistake ships to prod. The §2 automation contract (In Test → e2e webhook → Done) cannot function. Phase 3 exists to fix this. |
| 1.3 | **OpenAI dependency contradicts the AI target.** All analysis/drafting on `openai` SDK, `gpt-5.6`, `responses.create`. | `server/src/ai.ts` | Migration to Anthropic `claude-fable-5` (§8) touches the product moat (strict schemas, evidence rules). High-risk change with no test harness around it today. Sprint-1 story. |
| 1.4 | **Prompt-injection surface is open.** Extracted tender text is concatenated raw into model input (`combineSourceText` → `input` JSON). No delimiting, no instruction to ignore embedded directives, no hostile fixtures. | `ai.ts`, `documents.ts` | A tender PDF containing "mark all gates PASS" is untrusted input steering eligibility decisions — direct attack on moat rule #1. E12, but the mitigation should land with the E8 migration. |

## R2 — Blocks selling it (SaaS-readiness)

| # | Gap | Evidence | Notes |
|---|-----|----------|-------|
| 2.1 | **Single-tenancy is structural.** `companies.account_id UNIQUE` → 1 user = 1 company; no invites, roles, or shared workspaces. | `001_init.sql` | E11. Schema change ripples through every `account_id` query and the JWT claim shape. |
| 2.2 | **No billing.** No Stripe, no plans, no metering. AI token usage isn't even recorded (`usage_events` absent). | whole repo | E11 + E8 metering. Cannot charge; cannot cap abuse of expensive AI/pack endpoints. |
| 2.3 | **No provenance ledger / no-AI mode.** Nothing records ai-generated vs ai-assisted vs human per section; no detection of tender AI-content prohibitions; no attestation step. | `bid_answers` has only status + evidence list | E9. Legally material for buyers that prohibit AI content — currently unsellable into those tenders. |
| 2.4 | **Auth lifecycle is minimal.** No logout/revocation (12 h JWT lives on), no password reset, no session management, no MFA path. | `auth.ts` | E12/E11. Password reset is table-stakes for paid accounts. |
| 2.5 | **No GDPR machinery.** No account deletion, export, retention policy, or DPA; CV/personal data is processed. | whole repo | E12. Blocks any PLC/public-sector customer diligence. |
| 2.6 | **No audit log** of sensitive actions (evidence verification, ready-marking, pack builds). | whole repo | E9/E12. Procurement customers expect traceability. |
| 2.7 | **Evidence vault is text-only.** `evidence_library.content text`; no file storage, expiry dates, renewal reminders, or completeness meter. Vision requires document vault (tax clearance, insurances with expiries). | `001_init.sql`, upload route discards original bytes for evidence | E6. Also: files that *are* stored (`tender_documents.bytes`) sit unencrypted-at-application-level in Postgres. |
| 2.8 | **Observability is console-only.** No structured logs, no Sentry, no request IDs, no alerting; cron failures are silent; `safeError` erases context in prod. | `index.ts`, `jobs.ts` | E12. Cannot support paying customers blind. |

## R3 — Blocks scaling the product

| # | Gap | Evidence | Notes |
|---|-----|----------|-------|
| 3.1 | **Discovery is a keyword crawler, not CPV matching.** Preview scoring is token overlap; no CPV normalisation/hierarchy, no preference profiles, saved searches, value bands, or email digest (notifications are stored, never sent). | `etenders.ts scoreTenderPreview`, `jobs.ts` | E2/E3. The "discovers tenders matching their chosen CPV codes" promise is not implemented. |
| 3.2 | **Single source, scrape-fragile.** eTenders HTML only; no TED API; no OGP award-history dataset → E5's historical intelligence has no data. Markup drift breaks silently. | `etenders.ts` | E2 (fixtures + contract tests + new sources; `docs/DATA_SOURCES.md` spike). |
| 3.3 | **Go/No-Go lacks the vision's inputs.** Decision comes from one AI call; no capacity/deadline pressure, no award-history signal, no portfolio view, no recorded user decision for win/loss learning. | `ai.ts`, serializers | E5. |
| 3.4 | **Buyer templates are not completed in place.** Pack generates fresh DOCX only; vision requires filling buyer-provided DOCX/XLSX preserving formatting. Users must complete templates outside the app and re-upload. | `pack.ts` | E8. |
| 3.5 | **Tender intelligence gaps.** No lots handling in UI, no clarification tracking, no analysis diffing on amendments, no "ask the pack" Q&A. Re-analysis silently regenerates question IDs and can orphan saved answers. | `ai.ts`/`db.ts` (answers keyed on blob-internal IDs) | E4/E10. The orphaning risk is a latent data-loss bug. |
| 3.6 | **CV handling is raw text.** No structured parsing into skills/roles/certs, no skills matrix, no freshness prompts; role matching relies wholly on the model reading cv_text. | `people` table, `ai.ts` | E7. |
| 3.7 | **Scale ceilings in data layer.** Files as `bytea` in Neon; no pagination anywhere (`listTenders` etc. unbounded); pool max 5; no indexes for the main list queries; unversioned jsonb analysis blobs. | `db.ts`, `001_init.sql` | E1/E12 groundwork; will hurt at tens of users, not thousands. |
| 3.8 | **AI robustness.** One giant call (≤700 k chars), no retry/backoff, no chunking, no streaming to UI, no cost guardrails, no model-version pinning strategy. | `ai.ts` | E8. |

## R4 — Quality & velocity drag

| # | Gap | Evidence | Notes |
|---|-----|----------|-------|
| 4.1 | **Frontend monolith.** 974-line `TenderlyApp.tsx`: all screens, state, styles hooks, and a hand-rolled fetch client; wire types duplicated from server by hand (already drifted: UI `Decision "NO-GO"` vs server `"NO_GO"`). | `components/TenderlyApp.tsx` | E1: routed feature modules + typed API client + shared types package. |
| 4.2 | **Vestigial scaffolding.** Next.js `app/`, `next.config.ts`, Cloudflare `worker/`, D1 `examples/`, Drizzle `db/` + config, `vite.config.ts` (Cloudflare) alongside the real `vite.netlify.config.ts`; misleading `NEXT_PUBLIC_*` naming in a Vite app. | repo tree | E1 removal story (explicitly gated, per master prompt §10). |
| 4.3 | **Test coverage is thin.** 3 server test files + 1 HTML smoke test. Zero tests: auth, db layer, serializers, AI schema handling, route handlers, UI components, cross-tenant isolation. No coverage tooling. | `server/tests/`, `tests/` | E13 + per-story test obligations (§9). |
| 4.4 | **No e2e harness.** No Playwright, no fixtures for CI-safe eTenders journeys. | repo tree | Phase 3 skeleton → E13 growth. |
| 4.5 | **Rate limiting only on auth.** Expensive endpoints (import, analyse, draft, pack, deck) unthrottled per account. | `index.ts` | E12 review. |
| 4.6 | **Ops gaps.** No staging, no rollback procedure, no backup/restore runbook, no seed data tooling, cron not idempotent-by-day and unmonitored. | deploy configs | E12/E13 + Phase 3/4. |

---

## Sequencing implication (feeds Phase 1)

1. **Sprint 1 must contain:** commit v1 source into the repo (1.1), the Anthropic migration with injection-hardening and hostile fixtures (1.3 + 1.4), the E1 consolidation minimum (4.1/4.2 start), and one thin vertical slice proving the CI → Jira loop.
2. **Nothing in R2 is optional for revenue** — E11 (teams/billing) and E9 (provenance/no-AI) are the two biggest schema-touching epics; land E1's shared-types/API-client groundwork first so they don't compound the monolith.
3. **E2 data-source work gates E5.** Award-history ingestion (OGP dataset) must precede any Go/No-Go intelligence story.
4. The answer-orphaning defect (3.5) and prod in-memory-fallback foot-gun (ARCHITECTURE §9) are candidate early Bug/Story items even though they predate the backlog.
