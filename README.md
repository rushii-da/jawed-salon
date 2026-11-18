# Jawed Salon · Owner Operating System (v2.0.0)

Full-stack Salon Management Dashboard, Counter POS Billing, Advance Scheduling, Client 360° CRM, and Indian GST Audit Engine powered by **Node 22+ `node:sqlite`** with zero external runtime dependencies.

- **Live Production:** [https://jawed-salon.onrender.com](https://jawed-salon.onrender.com)
- **Health Endpoint:** `GET /api/health`

## Key Capabilities
- **Single Source of Truth (SQLite WAL):** All KPIs, 7-day/14-day charts, stylist commissions, payment splits, and retention tiers are computed live from SQLite (`data/salon.db` or custom `DB_PATH`).
- **Hardened Security:** Static files served strictly from `public/` (never exposing backend files or `salon.db`), security headers (`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`), optional Owner PIN protection (`X-Owner-Pin`), dev-only `/api/reset`, and XSS-escaped event-delegated UI.
- **Counter POS & Indian GST:** Auto-lookup returning clients by 10-digit phone, discounts, Split payments (`UPI` + `Cash`), inclusive CGST/SGST breakdown, SAC `999722`, 80mm thermal print styling, and 1-click WhatsApp e-bill.
- **Live Chair Queue & Double-Booking Guard:** Track `Scheduled → Confirmed → In-Chair → Completed`, reschedule or cancel slots, and prevent stylist time-slot collisions (`409 Conflict`).
- **Client 360° Profile & Opt-In WhatsApp Queue:** Store hair color formula/allergy notes, manage opt-in consent, and dispatch personalized offers via a logged 1-click WhatsApp queue.
- **Revenue Reports & GST CSV Export:** Switch `Day | Week | Month`, reconcile End-of-Day Cash Drawer (`Opening Float + Cash Sales`), and download Tally-ready GST CSV exports (`/api/reports/gst-csv`).
- **Frosted Glassmorphism & Purposeful Motion:** Light & Dark frosted-glass theme tokens with route-entrance panel/chart/KPI digit motion, sticky mobile bottom navigation (`<= 900px`), and full `prefers-reduced-motion` support.

## Project Layout
```
├── server.js          # HTTP server, REST API, security headers, strict public/ static root
├── db/database.js     # SQLite v2 schema, transactions, conflict guard, GST & analytics SQL
├── public/            # Static frontend (index.html, css/styles.css, js/api.js, utils.js, app.js)
├── tests/             # Isolated node:test + node:assert/strict API & UI integrity suites
├── render.yaml        # Render Blueprint (auto-deploy from main, Node 22.14.0, /api/health)
└── .node-version      # Pins Node 22.14.0 for native node:sqlite
```

## REST API Reference
| Endpoint | Methods | Purpose |
| :--- | :--- | :--- |
| `/api/health` | `GET` | Liveness & SQLite engine status |
| `/api/dashboard` | `GET` | Live daily KPIs, 7-day trend, payment split, active queue, lapsed VIPs |
| `/api/appointments` | `GET`, `POST`, `PATCH /:id`, `DELETE /:id` | Walk-in billing, advance booking (`409` conflict guard), lifecycle transitions |
| `/api/clients` | `GET`, `GET /lookup?phone=`, `GET /:id`, `PATCH /:id` | Client search, phone auto-lookup, 360° profile & formula notes |
| `/api/services` | `GET`, `POST`, `PATCH /:id`, `DELETE /:id` | Salon service & pricing catalog CRUD |
| `/api/stylists` | `GET?period=today\|week\|month`, `POST`, `PATCH /:id` | Stylist CRUD & live SQL commission/retention metrics |
| `/api/campaigns` | `GET`, `POST`, `PATCH /:id` | Logged opt-in WhatsApp campaign queue & dispatch tracking |
| `/api/reports` | `GET?period=day\|week\|month`, `GET /gst-csv` | Live financial analytics, EOD Cash Drawer, RFC-4180 GST CSV export |
| `/api/settings` | `GET`, `PATCH` | Salon profile, GSTIN/SAC/rate, opening cash float, optional Owner PIN |

## Local Development
Requires **Node.js >= 22.5.0** (pinned in `.node-version`):
```bash
node server.js
```
Open [http://localhost:3000](http://localhost:3000).

## Run Automated Tests
Runs isolated `node:test` + `node:assert/strict` suites against a temporary SQLite database (never mutating `data/salon.db`):
```bash
npm test
```

## Cloud Deployment (Render)
Deployment is configured via [render.yaml](render.yaml) and [CLAUDE.md](CLAUDE.md) for auto-deploy on push to `main`:
- `NODE_ENV=production` (automatically disables `POST /api/reset`)
- `NODE_VERSION=22.14.0` (ensures native `node:sqlite`)
- `DB_PATH=/var/data/salon.db` *(optional — set when attaching a Render Persistent Disk mounted at `/var/data` so SQLite data survives restarts)*
- `ALLOWED_ORIGIN=https://your-salon-domain.com` *(optional — only needed for cross-origin API access)*
- Health Check Path: `/api/health`
- Start Command: `node server.js`
