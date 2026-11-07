# DOST-IskoLens: NFR performance measurements (v4, Node.js)

Measured 2026-11-01 with `tools/measure-nfr.js`. Dataset: 1000 fictional scholars (with GWA and stipend records), 30 officer accounts. Database: SQLite (test file). Server: Node.js v22.22.2 (Express).
Computer: Linux 6.18.44-fc-v185, 1 CPU threads.

| NFR | What was measured | Target | Median | 95th percentile | Slowest | Samples | Result |
|---|---|---|---|---|---|---|---|
| NFR 2 | Search and filter results | ≤ 3 s | 0.011 s | 0.025 s | 0.033 s | 34 | Pass |
| NFR 1 | Report: full scholar list to Excel (1000 rows) | ≤ 5 s | 0.265 s | 0.438 s | 0.438 s | 3 | Pass |
| NFR 1 | Report: one-page scholar record PDF | ≤ 5 s | 0.051 s | 0.083 s | 0.083 s | 5 | Pass |
| NFR 3 | Import 100 scholar records (validate + save) | ≤ 10 s | 0.090 s | 0.116 s | 0.116 s | 3 | Pass |
| Scope | 30 users signing in at once | all succeed | 5.631 s | 10.079 s | 10.096 s | 30 | Pass |
| Scope | 30 users working at once (900 requests, 0 errors) | 0 errors, ≤ 3 s | 0.148 s | 0.600 s | 1.299 s | 900 | Pass |

The 30-user test took 13.7 s in total.

Notes:
- KPI report generation (NFR 1) cannot be measured until the KPI reports are built; the Excel export and the PDF record stand in for it.
- Sign-in deliberately takes a fraction of a second because passwords are checked with bcrypt.
- Times include the full HTTP round trip on the same computer. Re-run on the actual server for the final manuscript.
