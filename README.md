# Jawed Salon · Owner Operating System (v2.0)

Full-stack Salon Management Dashboard, Counter POS Billing, Advance Scheduling, Client 360° CRM, and Indian GST Audit Engine powered by **Node 22+ `node:sqlite`** with zero external runtime dependencies.

## Key Capabilities
- **Single Source of Truth (SQLite WAL):** All KPIs, 7-day/14-day charts, stylist commissions, payment splits, and retention tiers are computed live from SQLite (`data/salon.db`).
- **Hardened Security:** Static files served strictly from `public/` (never exposing backend files or `salon.db`), security headers (`X-Content-Type-Options`, `X-Frame-Options`), optional Owner PIN protection, dev-only `/api/reset`, and XSS-escaped event-delegated UI.
- **Counter POS & Indian GST:** Auto-lookup returning clients by 10-digit phone, discounts, Split payments (UPI + Cash), CGST/SGST breakdown, SAC `999722`, 80mm thermal print styling, and 1-click WhatsApp e-bill.
- **Live Chair Queue & Double-Booking Guard:** Track `Scheduled → Confirmed → In-Chair → Completed`, reschedule or cancel slots, and prevent stylist time-slot collisions (`409 Conflict`).
- **Client 360° Profile & Opt-In WhatsApp Queue:** Store hair color formula/allergy notes, manage opt-in consent, and dispatch personalized offers via a logged 1-click WhatsApp queue.
- **Revenue Reports & GST CSV Export:** Switch `Day | Week | Month`, reconcile End-of-Day Cash Drawer (`Opening Float + Cash Sales`), and download Tally-ready GST CSV exports.

## Local Development
```bash
node server.js
```
Open [http://localhost:3000](http://localhost:3000).

## Run Automated Tests
Runs isolated `node:test` + `node:assert/strict` suites against a temporary SQLite database (never mutating `data/salon.db`):
```bash
npm test
```

## Cloud Deployment Notes
Because this app uses SQLite (`data/salon.db`), deploy on a platform with a **Persistent Volume** (e.g., Render Web Service + Persistent Disk, Railway Volume, or Fly.io Volume) and set:
- `NODE_ENV=production` (disables `/api/reset`)
- `ALLOWED_ORIGIN=https://your-salon-domain.com` (if hosting API cross-origin)
- Start Command: `node server.js`
