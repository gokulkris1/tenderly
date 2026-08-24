# Data processing, sub-processors and retention

This page states what Tenderly holds, who processes it on our behalf, where it
is held, and how long it is kept. It is the page a public-sector buyer's
procurement team asks to see, so it is written to be read by them rather than
by us.

Last reviewed: 24 August 2026.

## What Tenderly holds

| Data | Why | Where |
|---|---|---|
| Company profile (registration, turnover, insurances, services) | Deciding eligibility against a tender's stated requirements | Neon Postgres, EU region |
| Vault documents (certificates, statements, policies) and their extracted text | Evidencing requirements a buyer asks about | Neon Postgres, EU region |
| People records and CVs | Matching named roles a tender requires | Neon Postgres, EU region |
| Tender documents downloaded from eTenders and TED | Analysing what the tender actually requires | Neon Postgres, EU region |
| Drafted and human-written responses, and their provenance ledger | Producing the submission, and recording how each section was produced | Neon Postgres, EU region |
| Audit log, usage events, ingestion runs | Traceability, billing accuracy and service health | Neon Postgres, EU region |

Tenderly does not sell, share or use customer data to train any model.

## Sub-processors

A sub-processor is a third party that processes customer data on our behalf.
Each one below is named with what it processes and why. A sub-processor that is
not yet in use is marked as such rather than listed as if it were — a
sub-processor list that includes things we do not use is not an honest list.

| Sub-processor | Purpose | Data it processes | Location | Status |
|---|---|---|---|---|
| Anthropic | Tender analysis, answer drafting, CV parsing, critique | Tender text, company profile, verified evidence, CV text | United States | In use |
| Neon | Managed Postgres: the application database | All stored data | EU (Frankfurt) | In use |
| Render | API hosting | Data in transit through the API | EU (Frankfurt) | In use |
| Netlify | Static hosting of the web application | No customer data at rest; requests transit their edge | Global CDN | In use |
| Email provider | Digest and reminder email | Recipient address, notice titles | To be confirmed | **Not yet in use** — see TLY-35 |
| Stripe | Subscription billing | Billing contact and payment details (held by Stripe, never by us) | EU / US | **Not yet in use** — see TLY-89 |
| Sentry | Error tracking | Request identifiers, stack traces, no request bodies | EU | **Not yet in use** — see TLY-95 |
| Object storage provider | Vault and tender document storage | Document bytes | To be confirmed | **Not yet in use** — see TLY-52 |

Anthropic processes prompts and completions and does not use them to train its
models under its commercial terms. Where a tender prohibits AI-generated
content, Tenderly's no-AI mode disables generation for that tender entirely, so
no tender text is sent for drafting.

## Retention

Retention is enforced by a job, not by intention. Each period is configurable
per deployment; the defaults are below and the environment variable that
overrides each is named so an operator can check what is actually set.

| Data class | Default | Measured from | Override |
|---|---|---|---|
| Closed tenders and their documents, answers and provenance | 24 months | The tender's last update | `RETENTION_CLOSED_TENDERS_MONTHS` |
| AI usage events | 24 months | The metered call | `RETENTION_USAGE_MONTHS` |
| Discovery notifications | 12 months | The match | `RETENTION_NOTIFICATIONS_MONTHS` |
| Ingestion run records | 12 months | The run | `RETENTION_INGESTION_MONTHS` |
| Audit log | 84 months | The recorded action | `RETENTION_AUDIT_MONTHS` |

The audit log is kept longest on purpose: the record of what happened to the
data has to outlive the data, or a deletion cannot be verified after the fact.
A submitted tender is never removed by the retention job — what a company sent
to a buyer is the company's own record of its submission.

Running the job:

```
npm run retention:dry-run --prefix server   # counts, deletes nothing
npm run retention --prefix server           # applies the policy
```

The dry run names every tender it would remove. Deleting customer data is the
one operation where "run it and see" is not acceptable.

## Deletion on request

Account deletion and data export are handled separately (TLY-97) and are not
the same thing as retention: retention is what happens without anyone asking.

## Changes to this page

Material changes to sub-processors are recorded here with the date. This page
lives in the repository so its history is the change log.
