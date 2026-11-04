# Ingestion sources

Spike TLY-27 · verified 2026-08-23 by probing each source directly, not from documentation alone.

Discovery uses the public eTenders portal and TED. OGP is historical reference
data, not a live feed. Source failures are recorded explicitly.

## Tracking-first discovery (November 2026)

- eTenders searches use `viewCFTSAction.do`, `status=cft.status.tender.submission`
  and explicit `cpvLabels` expanded to include the selected families' descendants.
  Expanded codes are batched to keep URLs bounded; all result pages are read and
  duplicate CFT IDs are collapsed.
- The default is **all open matching CFTs**, not notices published in the last
  three days. An explicit `sinceDays` option is still available for callers that
  intentionally want a publication window.
- A read-only live check on 4 November 2026 returned **23** notices for the parent
  `72000000` alone versus **58 unique notices** across the expanded family and all
  result pages. Counts change as buyers publish and close competitions.
- Every returned CFT is enriched; the old first-sixty cap is removed. Tracked
  eTenders CFTs are also refreshed after leaving the open listing. User stages,
  results, notes and other human decisions survive reimport.
- TED is supplemental: Irish CPV-family matches with a published submission
  deadline on or after today. All raw pages are traversed, even when individual
  notices are invalid or intentionally excluded award notices. TED notices without
  a published deadline are not covered by this query; eTenders is the primary
  open-CFT source.
- Page ceilings, repeated pages, detail failures and source failures are explicit
  warnings/errors, never an apparently complete truncated feed.
- A metadata refresh does not fetch private portal communications or replace
  locally saved documents. The overview publishes official document/clarification
  links and public contact addresses; private correspondence is recorded manually.

---

## 1. eTenders (www.etenders.gov.ie) — HTML scrape

| | |
|---|---|
| Access | Public HTML. No API, no key. Crawled politely: HTTPS only, host allow-list, redirect re-validation, 18s timeout, 6 MB HTML / 20 MB document caps, page cap and inter-request delay. |
| Auth | None |
| Cadence | Continuous — this is the live feed |
| Licence | Site terms of use. Public notices are published for suppliers to read and act on; we read the same pages a bidder would, at a lower rate than a human browsing. |
| Stability | **Low.** Listing extraction depends on the portal's table layout. Detail extraction reads published `dt`/`dd` fields with a known-label fallback. Parse failures and ingestion-health alarms must be monitored for portal changes. |

**What the listing gives us:** external id, title, buying authority, description,
published date, deadline, procedure, status, estimated value. **It does not give
CPV** — CPV appears only on a notice's detail page. CPV-filtered discovery uses the
portal's search criteria before reading each detail page. Matching any published
classification (including secondary codes) is sufficient for intake; keyword
preferences and optional scores cannot hide those CPV matches.

**Verdict: keep, with the drift alarm.** It is the only source of *live Irish
below-threshold* notices, which is most of the SME market. Fixtures and contract
tests (TLY-28) turn a silent breakage into a loud one.

---

## 2. TED — Tenders Electronic Daily (api.ted.europa.eu)

| | |
|---|---|
| Access | **`POST https://api.ted.europa.eu/v3/notices/search`** |
| Auth | **None for published notices.** "The Search API does not require a key." A key is only needed for endpoints that manipulate *unpublished* notices, which we never touch. |
| Cadence | Daily publication |
| Licence | EU open data, re-use permitted with attribution |
| Stability | **High.** Versioned REST API with a published schema, unlike scraping. |

Verified live on 2026-08-23 — an anonymous request returned real Irish notices:

```
POST https://api.ted.europa.eu/v3/notices/search
{ "query": "(classification-cpv=72*) AND (place-of-performance=IRL)",
  "fields": ["publication-number","notice-title","buyer-name",
             "deadline-receipt-request","classification-cpv"],
  "limit": 3, "page": 1 }
→ 200, notices[] with publication-number, classification-cpv[], buyer-name{lang},
  and links{xml,pdf} per language.
```

**Field mapping to `tenders`:** `publication-number` → `external_id` (with
`source='ted'`), `notice-title` → `title`, `buyer-name` → `authority`,
`deadline-receipt-request` → `deadline`, `classification-cpv[0]` → CPV,
`links.pdf` → `source_url`.

Note the shape: `buyer-name` and `notice-title` are **language-keyed objects**
(`{"eng": ["..."]}`), not strings, and `classification-cpv` is an **array**. An
ingestion that assumes strings will silently store `[object Object]`.

**Verdict: adopt.** It covers above-threshold Irish notices, needs no
credentials, and gives CPV *in the listing* — which eTenders does not.

---

## 3. OGP quarterly open dataset (data.gov.ie)

| | |
|---|---|
| Access | **`https://assets.gov.ie/static/documents/c41c3a86/Public_Procurement_Opendata_Dataset.csv`** |
| Auth | None |
| Size | **63,109,178 bytes** (verified by HEAD, `content-type: text/csv`) |
| Coverage | All published competitions from 01/01/2013 onward |
| Cadence | Quarterly |
| Licence | **CC-BY-4.0** — attribution required wherever the data is shown |

Header verified live:

```
Tender ID, Contracting Authority, Tender Name, Notice Published Date, Directive,
Competition Type, Main Cpv Code, Main Cpv Code Description, Additional CPV Codes on CFT,
Spend Category, Contract Type, Threshold Level, Procedure, Tender Submission Deadline,
Evaluation Type, Notice Estimated Value, Contract Duration (Months), Cancelled Date,
Award Published, Awarded Value, No of Bids Received, No of SMEs Bids Received,
Awarded Suppliers, No of Awarded SMEs, TED Notice Link, TED CAN Link, Platform
```

That carries exactly what E5's Go/No-Go intelligence needs: authority, CPV,
awarded value, awarded suppliers, bid counts and SME participation.

Two facts that shape the loader: empty cells are the **string `NULL`**, not
blank, and `Additional CPV Codes on CFT` arrives as a mangled comma-grouped
number (`"2,282,100,079,810,000,..."`), so only `Main Cpv Code` is trustworthy.
At 63 MB the file must be **streamed**, not buffered.

**Verdict: adopt as reference data, not a live feed.** It is historical, updated
quarterly, and belongs in `award_history` for intelligence — never in Discover.

---

## 4. eTenders authenticated account (Beta) — clarification messaging

| | |
|---|---|
| Access | The user's **own eTenders account**, walked through the documented ePPS flow: login form → CfT workspace → Messaging → compose. |
| Auth | The user's email and password, supplied by them and stored AES-256-GCM encrypted under `TENDERLY_PORTAL_KEY`. **Without that key the feature is disabled**: `GET /api/portal/connection` reports `status: "disabled"` and `PUT` answers 503. |
| Licence | The user's own account and the portal's terms; we send only what the user composes. |
| Stability | **Unknown — Beta.** The client is exercised only against synthetic fixtures (`server/tests/fixtures/portal/`) and has never been verified against the live portal. Connection status starts `untested` and moves to `ok`/`failed` only after a real attempt; a send the portal does not confirm returns `delivered: false` with a warning, never a fabricated success. |

There is no public messaging API, so every tender also carries `messagingUrl`
(eTenders CFT workspace deep link) and the send endpoint answers 503 with that
link in `portalUrl` whenever no connection exists — asking on the portal and
recording the exchange in Tenderly is always the supported path.

## Geographic scope

Discovery is EU-wide and configurable: workspace preferences carry
`countries` (ISO 3166-1 alpha-3, default `["IRL"]`) and each tender board may
override them (`countries?`, omitted = workspace-wide). The TED query ORs the
union of configured markets across accounts and each account ingests only
notices performed in its own markets; eTenders remains Ireland-only
(`markets: ["IRL"]`). TED notices carry `markets` from place-of-performance,
falling back to `["IRL"]` for notices ingested before the field existed.

---

## Recommendation

| Source | Decision | Build order |
|---|---|---|
| eTenders | **Keep** — the only live below-threshold feed | TLY-28 (fixtures and contract tests) first, so drift is caught |
| TED | **Adopt** — no key, stable schema, CPV in the listing | TLY-29 |
| OGP dataset | **Adopt** as reference data | TLY-30, then TLY-48 consumes it |

Nothing here needs an account, a key or a payment. The earlier assumption that
TED required an API key was wrong: only unpublished-notice endpoints do.

**Attribution obligation:** the OGP data is CC-BY-4.0, so any screen showing
figures derived from it must carry the attribution. `award_history` stores the
licence note alongside the rows so the obligation travels with the data.
