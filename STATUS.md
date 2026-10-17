# Status — what is done, partly done, and not done (17 Oct 2026, version 1.0.0)

**Tests:** 47 unit and backend tests and 21 browser checks, all passing (`npm test`, `npm run e2e`).
The backend was tested on a **simulated** Google environment. It has **not yet run on real Google**, because that needs the doctor's account. Do the checks in DEPLOY.md, Step 7, before entering real patients.

## Done and tested

| Area | What works | How it was tested |
|---|---|---|
| Money engine | Exact 70/30 split frozen on every payment (1,000 → 700/300, 800 → 560/240); lab rules; refunds; reversals; discounts; charges in the schedule; history unchanged by agreement changes | 19 unit tests |
| Audit defects | T1–T12 and R1–R9 from the audit fixed (closed months, overpayment, over-discount, charges, missing agreement, clinic-share label, fixed+deduct, duplicate guard, formula injection, rounding, real login, atomic reschedule, restore safety, future attendance, midnight date, plan history, Arabic search, second-phone duplicates) | unit + browser tests |
| Business rules | Every change is an operation with a unique ID. Retries never duplicate. Permission checks run on the server. Assistants see only their clinics and no money splits. | 21 tests |
| Conflicts | Edits to different fields merge. The same field shows both values for the user to choose. Plan money is never merged. Money entries are append-only. | unit tests |
| Backend | Setup, Google sign-in check, Sheet read/write with types, lock, backups every hour (keeps 48 hourly + 30 daily), nightly check, daily .xlsx with read-back check, restore with pre-restore copy and typed confirmation, email on failure | 7 tests on simulated Google |
| App | Installable, works offline, outbox survives restarts, sync every 60 s and right after a save, honest status ("تمت المزامنة" only after the server confirms), day/week/month calendar, patient search picker, "save and add another", overlap warning with override, lab Ordered / Delivered groups, inventory, 9 reports (CSV + print), light/dark/auto theme, PIN lock, sign-out wipe | 21 browser checks on phone and desktop sizes |

## Partly done

- **Excel snapshot** is Google's own export of the whole database Sheet (one tab per table) plus a manifest row in the `backupLog` tab. It is not a custom-designed 15-sheet report workbook.
- **Nightly backup check** opens and parses the newest copy and compares row counts. A full restore into a separate test database is a manual step (DEPLOY.md, Step 7).
- **Offline:** viewing and recording work offline after the first sign-in. Signing in again needs internet; until then changes wait in the outbox.
- **Device data protection:** optional PIN and sign-out wipe. The browser's IndexedDB copy is not encrypted.
- **Inventory:** items, stock in / use / adjust, low-stock alert. No purchase orders and no transfers between clinics.
- **Receipts:** the patient statement can be printed. There is no numbered receipt document.

## Not done (deferred)

- One full run on real Google (needs the owner, see DEPLOY.md).
- Deleting patients or records: not available by design. To clear test data, start a fresh database.
- Data migration tool: not needed, because the old demo held only sample data.
- SMS / WhatsApp reminders, push notifications, English screens.

## Assumptions (all changeable)

| Assumption | Where to change |
|---|---|
| New clinics use 70% doctor / 30% clinic and lab rule "deduct before split" | Clinic form / New agreement |
| Lab cost counts on the order date | Business rule in `shared/ledger.js` (`clinicCalc`) |
| Week starts on Saturday; time zone Africa/Cairo | `web/app.js`, `apps-script/server.js` |
| Assistants can register a new patient with the plan amounts; only the doctor can change a plan later | `shared/core.js` (`patient.save`, `plan.update`) |
| A settlement cannot be more than the amount owed at that moment | `shared/core.js` (`settle.add`) |
| A doctor's net can be negative in a month, for example when a big lab order falls in a month with few payments. It is shown as it is, not carried over. | — |
| Patient codes (P-0001…) are given by the server. A patient added offline shows a temporary code until sync. | — |

## Known limits

- Each save takes about 1–3 seconds (Apps Script). That is fine for a few users, not for a large chain.
- Google's free quotas apply (DEPLOY.md). Data is loaded fully on each request; plan a move to a real database after roughly 100,000 records.
- The "Ortho DB" Sheet must never be edited by hand.
