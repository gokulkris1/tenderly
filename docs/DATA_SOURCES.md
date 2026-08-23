# Ingestion sources

Spike TLY-27 · verified 2026-08-23 by probing each source directly, not from documentation alone.

Discovery currently depends on scraping one HTML portal. This assesses the three
candidate sources on access, licence, stability and cost, and says which to adopt.

---

## 1. eTenders (www.etenders.gov.ie) — HTML scrape

| | |
|---|---|
| Access | Public HTML. No API, no key. Crawled politely: HTTPS only, host allow-list, redirect re-validation, 18s timeout, 6 MB HTML / 20 MB document caps, page cap and inter-request delay. |
| Auth | None |
| Cadence | Continuous — this is the live feed |
| Licence | Site terms of use. Public notices are published for suppliers to read and act on; we read the same pages a bidder would, at a lower rate than a human browsing. |
| Stability | **Low.** `parseSearchHtml` reads fixed table positions and `extractStructuredFields` scans 33 known labels. A portal redesign changes results silently. |

**What the listing gives us:** external id, title, buying authority, description,
published date, deadline, procedure, status, estimated value. **It does not give
CPV** — CPV appears only on a notice's detail page. That is why sector filtering
(TLY-34) matches on title and description, and CPV applies after import.

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
