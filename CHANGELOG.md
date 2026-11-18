# Changelog

## [2.0.0] - 2026-11-18

### Security
- Isolated static file serving strictly to `public/` (blocking access to `data/salon.db`, `server.js`, `db/database.js`, dotfiles, and traversal paths).
- Added security headers (`X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`), controlled CORS (`ALLOWED_ORIGIN`), safe URL parsing (`400` on malformed encoding), production guard on `POST /api/reset`, and optional Owner PIN protection (`X-Owner-Pin`).
- Eliminated inline `onclick` handlers and escaped all dynamic HTML rendering (`escapeHtml`) across the frontend.

### Architecture & Data Integrity
- Upgraded SQLite schema to v2 (`PRAGMA user_version = 2`) with normalized tables, `crypto.randomUUID()` IDs, sequential invoice numbers (`INV-YYYY-XXXX`), canonical 10-digit phone normalization, ISO `YYYY-MM-DD` dates, and `process.env.DB_PATH` support for Render persistent disks.
- Wrapped appointment creation, settlement, and deletion in SQLite transactions (`BEGIN IMMEDIATE ... COMMIT`) so client visits and spend reconcile accurately only on `Completed` bills.
- Added stylist double-booking conflict detection (`409 Conflict`).
- Eliminated `localStorage` vs SQLite split-brain: all views, KPIs, charts, stylist commissions, and reports hydrate directly from `/api/*`.

### Product & UI/UX
- Added Live Chair Queue (`Scheduled -> Confirmed -> In-Chair -> Completed`, Reschedule, Cancel), Walk-in Counter Billing with 10-digit phone auto-lookup, discounts, Split UPI+Cash payments, Indian CGST/SGST tax breakdown, and 80mm thermal print styling.
- Added Client 360° slide-over drawer with visit history, editable hair color/formula notes, and WhatsApp opt-in controls.
- Wired `Today | Week | Month` Stylist & `Day | Week | Month` Revenue Reports toggles, End-of-Day Cash Drawer reconciliation, downloadable GST CSV export, Services & Stylists CRUD, and a logged 1-click WhatsApp opt-in queue.
- Upgraded UI with frosted Glassmorphism tokens (Light & Dark), restrained route/period-only motion for panels, charts, and KPI digits, mobile bottom navigation, inline SVG favicon, singular/plural UI labels, and full `prefers-reduced-motion` support.
- Upgraded deployment readiness with `render.yaml`, `.node-version` (`22.14.0`), `CLAUDE.md` deploy configuration, and isolated `node:test` + `node:assert/strict` suites.
