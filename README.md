# Tenderly 🎯

**Smart Irish Public Procurement Assistant** — deployed at [tenderly.netlify.app](https://tenderly.netlify.app)

## What it does

1. **Discover** — Search live tenders from [eTenders.ie](https://www.etenders.gov.ie) or paste any procurement URL to import instantly
2. **Synopsis Deck** — Get a 1–3 slide overview: key details, value, deadline, critical info
3. **Eligibility Check** — Framework bid detection, can-you-apply-alone analysis, consortium recommendations
4. **Bid Builder** — Auto-fill all bid documents, answer scored questions, upload CVs
5. **ZIP Export** — Download a complete bid package ready to submit on eTenders.ie

---

## Stack

| Layer | Tech |
|-------|------|
| Frontend | React + Vite → **Netlify** (`tenderly.netlify.app`) |
| Backend API | Node.js + Express → **Render** |
| Database | PostgreSQL → **Neon DB** |
| AI Synopsis | OpenAI GPT-4o-mini (optional) |

---

## Quick Start (Local Dev)

### 1. Backend

```bash
cd backend
cp .env.example .env
# Fill in DATABASE_URL from Neon dashboard
npm install
node server.js
```

### 2. Frontend

```bash
cd frontend
cp .env.example .env.local
# Set VITE_API_URL=http://localhost:4000
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173)

---

## Deploy

### Netlify (Frontend)

`netlify.toml` is already configured. Steps:
1. Connect this repo to Netlify
2. Add env var: `VITE_API_URL = https://your-render-app.onrender.com`
3. Deploy — Netlify will build `frontend/` automatically

### Render (Backend)

`render.yaml` is pre-configured. Steps:
1. Connect this repo to Render
2. Set env vars in Render dashboard:
   - `DATABASE_URL` = your Neon connection string
   - `OPENAI_API_KEY` = optional, enables AI-powered synopsis
   - `CORS_ORIGIN` = `https://tenderly.netlify.app`

### Neon DB (Database)

1. Create a project at [neon.tech](https://neon.tech)
2. Copy the connection string into `DATABASE_URL`
3. The schema (`backend/src/db/schema.sql`) is auto-applied on first server start

---

## Environment Variables

### Backend (`backend/.env`)

| Variable | Required | Description |
|----------|----------|-------------|
| `DATABASE_URL` | Yes | Neon PostgreSQL connection string |
| `PORT` | No | Server port (default: 4000) |
| `CORS_ORIGIN` | No | Frontend URL for CORS |
| `OPENAI_API_KEY` | No | Enables AI-generated synopsis |

### Frontend (`frontend/.env.local`)

| Variable | Required | Description |
|----------|----------|-------------|
| `VITE_API_URL` | Yes | Backend API base URL |

---

## API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check |
| GET | `/api/tenders` | List/search tenders |
| POST | `/api/tenders/fetch` | Fetch & parse tender from URL |
| GET | `/api/tenders/:id` | Get saved tender |
| POST | `/api/tenders/:id/synopsis` | Generate synopsis deck |
| POST | `/api/bids` | Create bid submission |
| PATCH | `/api/bids/:id` | Update bid form data / Q&A |
| POST | `/api/bids/:id/upload-cv` | Upload CV files |
| POST | `/api/bids/:id/generate-zip` | Generate & download bid ZIP |
| POST | `/api/companies` | Save company profile |
| PATCH | `/api/companies/:id` | Update company profile |

---

## Project Structure

```
tenderly/
├── netlify.toml          # Netlify deploy config
├── render.yaml           # Render deploy config
├── frontend/             # React + Vite SPA
│   ├── src/
│   │   ├── App.jsx
│   │   ├── App.css
│   │   ├── context/      # AppContext (global state)
│   │   ├── pages/        # Home, Discover, TenderDetail, BidBuilder, CompanyProfile
│   │   ├── components/   # layout, tender, synopsis, bid
│   │   └── utils/api.js  # Axios API client
│   └── .env.example
└── backend/              # Node.js + Express API
    ├── server.js
    ├── src/
    │   ├── db/           # Neon PostgreSQL + schema.sql
    │   ├── routes/       # tenders, bids, companies
    │   ├── services/     # etenders scraper, synopsis, bidBuilder (ZIP)
    │   └── middleware/
    └── .env.example
```

---

Built with ❤️ for Irish public procurement.
