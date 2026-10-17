# Ortho Practice Manager

Arabic, mobile-first practice manager for an orthodontist who works in several clinics, with assistants.
It runs **free** on the doctor's Google account (Apps Script + a Google Sheet) and a GitHub Pages site.

- **Deploy:** [DEPLOY.md](DEPLOY.md)
- **User guide (Arabic):** [GUIDE-ar.md](GUIDE-ar.md)
- **What is done and what is not:** [STATUS.md](STATUS.md)

## How it fits together

```
Phone / laptop (installable app, GitHub Pages)
  app.js      screens
  sync.js     IndexedDB outbox + sync every 60 s
  core.js     business rules   ┐ same code on both sides
  ledger.js   money engine     ┘
        │  HTTPS, Google sign-in token
        ▼
Google Apps Script (runs as the doctor)        → "Ortho DB" Google Sheet (source of truth)
  server.js   sign-in check, lock, save        → "Ortho Backups" (hourly copies)
              triggers: hourly / daily / nightly → "Ortho Excel" (daily .xlsx)
```

## Folders

| Path | What |
|---|---|
| `shared/ledger.js` | Money engine: integer piasters, 70/30 split, installments, lab rules, clinic accounts |
| `shared/core.js` | All operations, permissions, idempotency, field-level conflict merge, sync filtering |
| `apps-script/server.js` | Apps Script backend: API, Sheet storage, backups, Excel, restore |
| `web/` | The app (PWA): screens, offline sync, service worker, icons |
| `dev/server.js` | Local test server that runs the real backend on simulated Google services |
| `tests/` | Unit tests, backend tests (simulated Google), browser end-to-end test |
| `tools/build.js` | Builds `dist/apps-script/Code.gs` (one file) and `dist/web` |

## Commands (Node 18+)

```bash
npm test          # 47 unit + backend tests
npm run dev       # local app at http://localhost:8787 with fictional sample data (sign in by typing an email)
npm run e2e       # browser test (needs Playwright + Chromium)
npm run build     # make the files to deploy in dist/
```

Money is always stored as whole piasters (1 EGP = 100). Money entries are never edited or deleted; corrections are reversal entries dated in an open month.
