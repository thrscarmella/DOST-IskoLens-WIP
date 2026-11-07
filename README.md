# DOST-IskoLens v4 (Node.js + Python analytics)

Scholarship monitoring and analytics system for DOST Davao Oriental.

v4 runs the web system on **JavaScript (Node.js with Express)**. The **analytics and machine learning stay in Python** (pandas, SciPy, scikit-learn, imbalanced-learn, SHAP), in a separate service the web system calls. The screens, features and database are the same as v3.3.

```
iskolens/
  frontend/    the screens (HTML, CSS, JavaScript, Chart.js, D3.js), unchanged from v3.3
  server/      the web system: Node.js + Express (accounts, records, imports, backups, ...)
  analytics/   Python: feature building, Random Forest / CART training, forecasts, prediction service
  schema/      MySQL schema (identical tables to v3.3, matching the ERD and Data Dictionary)
  .env.example settings to copy into .env
```

## What's new in v4.2

- **Scholars are identified by Scholar ID only.** Names are not collected, stored or shown anywhere: forms, tables, imports, exports, the PDF record, notifications and the audit log. On first start, v4.2 removes the name columns from an existing database. This is permanent, so make a backup first. The duplicate warning, which compared names and birth dates, is removed with them.
- **No dropdown options are written into the pages.** Lists the office maintains come from the database; fixed system values (sex, semesters, statuses, termination grounds, roles, settings) come from the server through `/api/lookups`.
- **Prescriptive page on live data.** "At-Risk Scholar Intervention Recommendations" is a data table, and the other sections show live data or "No data yet". No page uses sample records anymore.
- **Sign-up password rules** appear as a checklist the moment the Password box is clicked.
- **Welcome line** ("Welcome, Administrator" / "Welcome, Scholarship Officer") replaces the button-like role label.
- **Scholar Records tab counts** follow the same search and filters as the table. The "no academic record yet" follow-up opens the Active tab with that filter.

## What's new in v4.1

- **Two-step verification:** authenticator-app codes with a QR code and one-time recovery codes, in My Profile > Security.
  - Administrators can reset it for a user who lost their phone (User Management).
  - Set `REQUIRE_ADMIN_2FA=1` to make it mandatory for Administrators.
- **Public sign-up switch:** `ALLOW_SIGNUP=0` hides sign-up, so only Administrators create accounts.
- **No outside resources:** Font Awesome, Chart.js and the Poppins and Inter fonts are bundled. A strict Content Security Policy lets pages load only from this server and blocks framing by other sites. Inline scripts are still allowed, because the pages use them.
- **Risk levels:** shown in Scholar Records, the scholar profile, Predictive, Interventions and termination eligibility.
  - Without a trained model they follow academic standing (Failed = High, Probation = Moderate, Good Standing = Low), marked with \*.
  - After training they switch to the model automatically, with each scholar's top factors.
- **Interventions:** cases open automatically for active scholars at High or Moderate risk.
  - Officers claim a case, log actions (counseling, HEI coordination and so on), and close it with an outcome.
  - Each case has a monitoring log and suggested actions based on the scholar's risk factors.
- **KPI Reports (Administrator):** five report types computed from the records, as PDF or CSV, with a saved history. When DOST provides the official KPI format, only the layouts in `server/src/lib/reports.js` change.
- **System Management:**
  - service status for the web system, database, analytics service, backups and disk space
  - the security settings in effect
  - the import log
  - Refresh Risk Levels, and Recalibrate Model, which retrains on the records in the database and rescores everyone
- **Descriptive, Diagnostic and Predictive pages:** they now compute from the database and the Python service. Each section shows a clear "No data yet" (or "Analytics service not running") message until there is enough data.
- **GeoMap:** Acceptance rate and Outreach priority metrics. The priority score combines qualification rate, active scholars and application growth.
- **New tables:** `school_applicants`, `scholar_risk`, `intervention_cases`, `intervention_logs`, `kpi_reports`, plus two-step verification fields on `users` and extra academic fields (enrollment status, units, failed subjects). They are added automatically to an existing database.

The Prescriptive overview page is the only page still showing sample figures.

## What you need

- **Node.js 22 LTS** (or 20 LTS) from nodejs.org. During installation, tick "Automatically install the necessary tools" if offered.
- **MySQL 8 or MariaDB** (WAMP is fine) for the real system. Without it, a local SQLite test file is used.
- **Python 3.11 or 3.12**, only for the analytics folder.

## Setup (Windows)

Open a terminal in `iskolens\server`. In File Explorer, click the address bar, type `cmd` and press Enter.

```
npm install
npm run cli -- init-db
npm run cli -- create-admin
npm run cli -- seed-demo --count 60
npm start
```

Then open http://127.0.0.1:5000.

`seed-demo` adds fictional scholars for testing. Never run it on the database you'll use for real records. After the first time, starting the system only takes `npm start` in the `server` folder.

### Using MySQL (WAMP)

1. In phpMyAdmin, run: `CREATE DATABASE iskolens CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`
2. Copy `.env.example` to `.env` in the `iskolens` folder and set `DATABASE_URL=mysql://root:@localhost:3306/iskolens` (add the password after `root:` if you set one).
3. Run `npm run cli -- init-db` and `npm run cli -- create-admin`, then `npm start`.

On MySQL, `init-db` also installs database triggers that refuse any edit or deletion in the audit log.

## Moving from v3.3 (Python version)

v4 uses the same database tables, so your data carries over:

1. Copy your `instance` folder from v3.3 into the new `iskolens` folder, next to `server` and `frontend`. If you used MySQL, keep the same `DATABASE_URL` in `.env`; the old `mysql+pymysql://...` form also works.
2. In `server`, run `npm install`, then `npm start`. Any missing table or column is added automatically.
3. Sign in with your existing accounts; the passwords stay the same.
4. Make a new backup on Data Protection. Backups made by v3.3 can only be restored by v3.3.

The audit log carries over too: v3.3 entries and new v4 entries verify as one chain.

## Commands (in the server folder)

| Command | What it does |
|---|---|
| `npm start` | Starts IskoLens. |
| `npm run cli -- init-db` | Creates the tables and the lookup lists (municipalities, placeholder schools and HEIs, programs, cycles). |
| `npm run cli -- create-admin` | Creates an Administrator; it asks for the details. |
| `npm run cli -- seed-demo --count 60` | Fictional scholars for testing only. |
| `npm run cli -- load-lookups schools schools.csv` | Loads DOST's official schools (CSV columns: `name,municipality`). Use `heis heis.csv` with a `name` column for HEIs. |
| `npm run cli -- backup` | Encrypted backup (kept: latest 30 scheduled ones). |
| `npm run cli -- restore NAME --yes` | Replaces all data with a backup, after a safety copy. Prefer the Data Protection page. |
| `npm run cli -- send-digest` | Weekly summary emails. |
| `npm run cli -- verify-audit` | Checks that no audit entry was changed or deleted. |
| `npm run cli -- upgrade-db` | Adds new tables or columns after an update (also runs on every start). |
| `npm test` | Jest + Supertest tests. |
| `python -m pytest tests/contract -q` | The full v3.3 test suite (17 groups) run against the Node server, proving both versions behave the same. Needs Python with `pytest` and `requests`. |
| `node tools/measure-nfr.js` | Measures the performance NFRs on a separate fictional database and writes `tools/nfr-results.md` for Chapter 4. |

### Scheduling backups and the digest

Set `BACKUP_SCHEDULE` and `DIGEST_SCHEDULE` in `.env` (the examples are daily at 2:00 AM and Mondays at 7:00 AM), and the running server does them itself. Or schedule `npm run cli -- backup` and `npm run cli -- send-digest` in Windows Task Scheduler with "Start in" set to the `server` folder. Set a `BACKUP_KEY` and keep a copy outside the computer: a backup can't be restored without the key that made it.

## Analytics (Python)

In `iskolens\analytics`:

```
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
```

**Rehearse now, with fictional data in the exact format of the DOST Data Request Template:**

```
python make_fake_data.py --scholars 300 --out fake_dost_data.xlsx
python train_risk.py --data fake_dost_data.xlsx
python forecast.py --data fake_dost_data.xlsx --test-from 2024
```

Then delete `fake_dost_data.xlsx` and everything in `models` and `reports`, so no model trained on fictional data is ever used.

**When the real data arrives** (de-identified, per the Letter of Agreement), run the same two commands with `--data` pointing to DOST's workbook.

- `train_risk.py` follows the manuscript's plan:
  - 80/20 stratified split
  - SMOTENC applied inside each of the 5 cross-validation folds, on training data only
  - Random Forest compared with CART
  - accuracy, precision, recall, F1 and AUC-ROC
  - SHAP feature contributions
- **Risk label rule:** terminated = High; delayed or at risk of delay = Moderate; graduated on time = Low. Active scholars are scored, not trained on.
- **Early-warning design:** every scholar is described by their first two terms only, so the model learns warning signs instead of reading the outcome. State both rules in Chapter 3.
- **Small classes:** if a class has fewer than 8 scholars, the classes are merged into High vs Not high, and the report says so.
- **Results:** `reports/risk_metrics.json` (for Chapter 4) and the model in `models/risk_model.joblib`.
- `forecast.py` uses a time-based split (earlier cycles train, later cycles test) and reports MAE, RMSE, R², MAPE (zeros excluded) and sMAPE.

**Once the real data is in the system:** start the service, then in System Management click **Recalibrate Model**. It trains on the database records, using the same label rule and early-warning design, and refreshes every active scholar's risk level. The analytics pages, interventions and GeoMap then fill in automatically.

**Start the prediction service** that the web system calls (`ANALYTICS_URL`, default `http://127.0.0.1:8001`):

```
python service.py
```

For production, use `waitress-serve --listen=127.0.0.1:8001 service:app`. Signed-in users can check its state at `/api/analytics/status`. The service listens only on the server itself; it is reached through the Node.js server, never directly from the internet.

The analytics screens (Descriptive, Diagnostic, Predictive, Prescriptive, Interventions, KPI Reports) still show sample data. They will be connected to these results once the dataset and the KPI format are available.

## Deployment (public website)

These are the same steps planned before, with Node instead of Flask:

- **Server:** an Ubuntu VPS (2 vCPU, 4 GB RAM for machine-learning retraining) in Singapore, with MySQL 8 and Node.js 22.
- **Running it:** run `npm start` under PM2 (`pm2 start src/server.js --name iskolens`) or as a Windows service, behind Nginx.
- **HTTPS:** use a Let's Encrypt certificate, and set `FORCE_HTTPS=1` and `TRUST_PROXY=1` in `.env`.
- **Analytics:** run the Python service with Waitress on `127.0.0.1:8001`.
- **Address and email:** set `PUBLIC_BASE_URL` to the website address, and the `MAIL_*` settings to DOST's email account.
- **Before going public:** get DOST's written consent naming the hosting provider (LOA Section III.2).
- **Not on Vercel:** the system needs a persistent server for the database, uploaded files, scheduled jobs and model training.

## Map data and licences

Municipality boundaries come from faeldon/philippines-json-maps (MIT License, PSGC 2023). D3.js is under the ISC License.
