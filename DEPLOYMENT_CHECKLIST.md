# Tenderly — tomorrow-morning deployment checklist

## Neon

- [ ] Create the Postgres database.
- [ ] Copy the connection string; keep it secret.

## Render

- [ ] Create services from `render.yaml`.
- [ ] Decide whether to keep the daily **tenderly-discovery** cron. It uses Render's paid `starter` cron plan; remove that cron block before Blueprint creation if you want to launch without it.
- [ ] Set `DATABASE_URL` on **tenderly-api** and, if kept, **tenderly-discovery**.
- [ ] Set `OPENAI_API_KEY` on **tenderly-api**.
- [ ] Confirm `CORS_ORIGINS=https://tenderly.netlify.app`.
- [ ] Wait for `/health` to return `database: configured` and `ai: configured`.
- [ ] Copy the Render API public URL.

## Netlify

- [ ] Deploy repository root; `netlify.toml` contains the build/publish settings.
- [ ] Set `NEXT_PUBLIC_API_URL` to the Render API URL (no trailing slash).
- [ ] Confirm the production site is `https://tenderly.netlify.app`.
- [ ] Register your first Tenderly account.

## Before the first real tender

- [ ] Complete Company: legal name, registration, turnover, capacity, services, CPVs, certifications, insurance limits.
- [ ] Add key CVs / delivery people.
- [ ] Add reusable case studies and policies; only mark evidence verified after checking it.
- [ ] Paste a real `etenders.gov.ie` opportunity URL.
- [ ] If Tenderly reports a protected/missing source document, download it from your own eTenders session and upload it to the bid.
- [ ] Resolve every yellow/red eligibility gate before deciding to bid.
- [ ] Download and sanity-check the synopsis deck.
- [ ] Mark scored answers ready only after human review.
- [ ] Upload completed pricing/declaration/buyer templates as submission files.
- [ ] Run final pack; if it remains blocked, resolve the reported blocker rather than bypassing it.
- [ ] Re-check the official eTenders deadline, ZIP/file rules and clarification updates immediately before submission.
