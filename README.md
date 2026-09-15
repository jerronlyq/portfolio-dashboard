# Apex Portfolio Dashboard

A free, self-hosted investment portfolio tracker. It's a static web page (no
server, no database, no build step) that reads and writes to a Google Sheet
you own, pulls live prices and market context from free APIs, and runs
entirely in your browser.

- **Your data stays in your own Google Sheet** — the dashboard is just a lens
  on top of it.
- **No backend to host** — the "server" is a small Google Apps Script
  attached to your Sheet, and the frontend is served for free by GitHub
  Pages (or just opened locally).
- **No cost** — Google Sheets, Google Apps Script, GitHub Pages, and
  Finnhub's free tier are all free for personal use at this scale.

---

## Table of Contents

- [What it does](#what-it-does)
- [How it fits together](#how-it-fits-together)
- [Project structure](#project-structure)
- [Setup guide](#setup-guide)
  1. [Create your Google Sheet](#1-create-your-google-sheet)
  2. [Set up the Apps Script backend](#2-set-up-the-apps-script-backend)
  3. [Get a Finnhub API key](#3-get-a-finnhub-api-key-optional-but-recommended)
  4. [Deploy the dashboard](#4-deploy-the-dashboard)
  5. [Connect the dashboard to your Sheet](#5-connect-the-dashboard-to-your-sheet)
- [Using the dashboard](#using-the-dashboard)
  - [Active Portfolio](#active-portfolio)
  - [Logging a purchase](#logging-a-purchase)
  - [Logging a sale](#logging-a-sale)
  - [Logging a dividend](#logging-a-dividend)
  - [Realized History](#realized-history)
  - [Portfolio History](#portfolio-history)
  - [Insights](#insights)
- [Troubleshooting](#troubleshooting)
- [Security notes](#security-notes)

---

## What it does

The dashboard has four tabs:

| Tab | What you see |
|---|---|
| **Active Portfolio** | Your current holdings: live prices, cost basis, unrealized P&L, category allocation, a holdings heatmap. |
| **Realized History** | Every closed trade and dividend you've logged: realized P&L, yearly summary, monthly breakdown chart. |
| **Portfolio History** | A line chart of your total portfolio value over time, built from a snapshot Google takes of your holdings once a day. |
| **Insights** | Recent news, analyst buy/hold/sell consensus, and an EPS-actual-vs-estimate chart — for whatever you currently hold. |

You log activity — buys, sells, dividends — through modals in the dashboard;
those write straight back to your Google Sheet, and the dashboard updates
immediately without waiting for a page reload.

## How it fits together

```
┌─────────────────┐        reads (CSV)        ┌──────────────────┐
│  Google Sheet    │ ◄───────────────────────  │   Dashboard       │  ──►  Finnhub
│  (your data)     │                            │  (GitHub Pages   │       (US prices,
│                   │  ──────────────────────►  │   or local)      │        news, EPS,
│ • Active Holdings │   writes (via Apps Script) └──────────────────┘        analysts)
│ • Realized History│                                     ▲
│ • Snapshots       │                                     │
│ • Live Price col  │                                     │
└─────────▲─────────┘                                     │
          │ scheduled: daily snapshot +                   │
          │ 30-min non-US price refresh                   │
┌─────────┴─────────┐                                     │
│  Apps Script       │  ──►  Yahoo Finance  ───────────────┘
│  (backend/*.gs)    │       (non-US prices, snapshots)
└────────────────────┘
```

- **The Sheet** is your single source of truth — three tabs: `Active
  Holdings`, `Realized History`, `Snapshots`.
- **Apps Script** is the only thing allowed to *write* to the Sheet. It's a
  tiny web service (free, hosted by Google) that the dashboard calls when
  you log a purchase, sale, or dividend. It also runs two scheduled jobs: a
  once-a-day portfolio-value snapshot for the History chart, and a
  30-minute refresh of non-US prices (SGX, LSE, Xetra, Euronext, SIX, Hong
  Kong, Toronto) into a `Live Price` column — the dashboard can't fetch
  those itself (Finnhub's free tier is US-only, Yahoo has no CORS support).
- **The dashboard** reads your Sheet as CSV (no auth needed beyond "anyone
  with the link can view"), and separately calls Finnhub directly from your
  browser for US live prices, news, and analyst data.

## Project structure

```
portfolio-dashboard/
├── docs/                                    ← the dashboard itself (GitHub Pages source)
│   ├── index.html
│   ├── app.js
│   ├── styles.css
│   ├── site.webmanifest
│   └── assets/                              ← icons/logo
└── backend/
    └── google-apps-script-write-handler.gs  ← paste this into Apps Script (see setup)
```

There's no `npm install`, no build step — `docs/` is served as-is.

---

## Setup guide

This takes about 15 minutes the first time. You only do it once.

### 1. Create your Google Sheet

Create a new Google Sheet with **three tabs**, named exactly:

**`Active Holdings`** — one row per position you currently hold.

| Ticker | Category | Total Cost Price | Shares | Currency |
|---|---|---|---|---|
| AAPL | Tech | 15000.00 | 100 | USD |
| DBS.SI | Bank | 5000.00 | 100 | SGD |

**`Realized History`** — closed trades and dividends land here automatically
once you start logging them; you can also seed it with historical data.
Columns are matched flexibly by keyword, so exact naming isn't critical, but
a sensible header row is:

| Date | Ticker | Category | Type | Shares | Total Buy Cost | Total Sell Price | Transacted Price | Commission | Profit | % of Profit | Currency |
|---|---|---|---|---|---|---|---|---|---|---|---|

`Type` should say "Dividend" for dividend rows; anything else is treated as
a trade.

**`Snapshots`** — left empty; the Apps Script backend fills this in
automatically once a day. Columns: `Date, Ticker, Shares, Price, Total
Value, Portfolio Total, Currency`.

Column headers are matched by **substring, case-insensitive** — "Total Cost
Price" and "Cost" both work, "Shares" and "Qty" both work. You don't need to
match the examples exactly, but keep the concepts recognizable.

Then **share the Sheet**: click **Share** (top right) → General access →
**"Anyone with the link"** → Viewer. This lets the dashboard read it without
you needing to sign in. (Editing still requires the write token described
below — sharing "view" access doesn't let anyone edit your Sheet.)

### 2. Set up the Apps Script backend

1. In your Sheet: **Extensions → Apps Script**.
2. Delete whatever's in the editor and paste in the entire contents of
   [`backend/google-apps-script-write-handler.gs`](backend/google-apps-script-write-handler.gs)
   from this repo.
3. **Project Settings** (gear icon, left sidebar) → set the time zone to
   your own (used for daily snapshot timestamps).
4. **Project Settings → Script Properties** → add:
   - `WRITE_TOKEN` — make up a long random string. This is the password
     that lets the dashboard write to your Sheet — treat it like one.
   - `SHEET_ID` — optional. Only needed if the script isn't directly bound
     to the Sheet you want it to write to (e.g. you're pointing it at a
     different spreadsheet than the one it's attached to).
5. In the function dropdown at the top of the editor, select
   `createDailyTrigger`, and click **Run** once. This registers the job that
   snapshots your portfolio value every day at 8am. (Re-running this later
   is safe — it won't create duplicates.)
6. Do the same for `createLivePriceTrigger` — this refreshes non-US prices
   (any ticker ending in `.SI`, `.L`, `.DE`, `.PA`, `.AS`, `.SW`, `.HK`, or
   `.TO` — see `NON_US_SUFFIXES` in the script if you need to add more)
   into a "Live Price" column of `Active Holdings` every 30 minutes (the
   column is created automatically on first run). The dashboard can fetch
   US prices itself, but not these, so this is how non-US holdings get a
   current price.
7. **Deploy → New deployment** → type **Web app**:
   - Execute as: **Me**
   - Who has access: **Anyone**
8. Click **Deploy**, then copy the **Web app URL** it gives you — you'll
   paste this into the dashboard in step 5.

> Editing the script later? Saving in the editor alone doesn't update the
> live version — go to **Deploy → Manage deployments** → pencil icon →
> **New version** → Deploy, to push code changes live without changing the
> URL.

### 3. Get a Finnhub API key (optional, but recommended)

US live prices, news, analyst ratings, and the EPS chart all come from
[Finnhub](https://finnhub.io/). Sign up free — no credit card needed — and
copy your API key from their dashboard. Without it, US prices fall back to
whatever's in a `Live Price` / `Market Price` column of your sheet, and the
Insights tab shows a prompt to add a key.

**Non-US prices** (SGX, LSE, Xetra, Euronext, SIX, Hong Kong, Toronto) don't
come from Finnhub (its free tier is US-only) or from the browser at all —
the dashboard can't reach Yahoo Finance directly (no CORS). They come from
the `Live Price` column that the Apps Script backend refreshes every 30
minutes (setup step 6 above). So those prices are ~30-min delayed, and only
update while that trigger is running. Use the full Yahoo symbol as your
ticker (e.g. `D05.SI`, `VWRA.L`) — look it up on
[finance.yahoo.com](https://finance.yahoo.com) if you're not sure of it.

### 4. Deploy the dashboard

**Option A — GitHub Pages (recommended, free, gives you a shareable URL):**

1. Fork or clone this repo.
2. Repo **Settings → Pages** → Source: **Deploy from a branch** → Branch:
   `main`, folder **`/docs`** → Save.
3. Your dashboard is live at `https://<your-username>.github.io/<repo-name>/`
   within a couple of minutes.

**Option B — run it locally:**

```bash
cd docs
python3 -m http.server 8080
```

Then open `http://localhost:8080/index.html`. (Any static file server
works — this is just the simplest one that's usually already installed.)

### 5. Connect the dashboard to your Sheet

Open the dashboard, expand **Data Sources** at the top, and fill in:

| Field | What to paste |
|---|---|
| **Google Sheet link or ID** | Your Sheet's URL (or just the ID from it) — click **Sync Sheet**. |
| **Finnhub API Key** | From step 3. |
| **Apps Script Web App URL** | The deployment URL from step 2. |
| **Write Token** | The `WRITE_TOKEN` value you chose in step 2. |

That's it — everything's stored in your browser only (nothing sent to any
server of mine), so you'll need to repeat step 5 on each device/browser you
use it from.

---

## Using the dashboard

### Active Portfolio

Your current holdings with live prices, unrealized P&L, a category
breakdown chart, and a holdings heatmap. Toggle **USD/SGD** at the top to
switch the display currency at any time. Click **↻ Refresh** to re-fetch
live prices on demand.

### Logging a purchase

Click **+ Log Purchase** on the Active Portfolio tab.

*Example: you just bought 25 shares of MSFT at $410 each, plus a $5
commission.*

- Ticker: `MSFT`
- Shares: `25`
- Currency: `USD`
- Total Cost (pre-fee): `10250` (25 × $410)
- Commission Fees: `5`
- Category: pick an existing one, or type a new one

Submit — this either creates a new row in `Active Holdings`, or if you
already hold MSFT, merges it into your existing position using a weighted
average cost basis. The dashboard updates instantly; you don't need to
re-sync.

### Logging a sale

Click **+ Log Sale** on the Active Portfolio tab. The ticker dropdown only
shows what you currently hold.

*Example: you sell 10 of your 25 MSFT shares for $4,300 total, $5
commission.*

- Ticker: `MSFT` (pick from the dropdown — it shows how many shares you hold)
- Shares Sold: `10`
- Total Sell Proceeds (pre-fee): `4300`
- Commission Fees: `5`

The preview shows your estimated realized P&L before you submit. Submitting
reduces your `Active Holdings` position (or removes it entirely if you sold
everything) and appends a row to `Realized History` with the calculated
profit/loss. Selling more shares than you hold is rejected, both in the
dashboard and by the backend.

### Logging a dividend

In the same **Log Sale** modal, check **"This is a dividend payout"** — the
form switches to ask for a dividend amount and payout date instead of
shares/proceeds/commission (dividends don't change your share count or cost
basis, so those fields disappear).

*Example: DBS pays you a S$150 dividend.*

- Ticker: `DBS.SI`
- Dividend Amount: `150`
- Payout Date: pick the date

The preview shows your estimated **yield on cost** (dividend ÷ what you
originally paid for the position). Submitting appends a "Dividend" row to
`Realized History` — it never touches `Active Holdings`.

### Realized History

Every trade and dividend you've logged (or seeded manually), with a
year-by-year summary and a monthly breakdown chart splitting dividends from
trading profit. Sorted newest-first by default; click any column header to
re-sort.

### Portfolio History

A line chart of your total portfolio's value over time, built from the
daily snapshots your Apps Script backend takes automatically. Filter to a
single ticker or view the total, and pick a date range (1W/1M/3M/All).

### Insights

Select a ticker from the dropdown (or leave it on "All My Holdings" for a
combined view) to see:

- **News** — recent headlines for your holdings, split into a "Top Stories"
  section (from recognized major outlets like Reuters/Bloomberg/CNBC) and
  everything else chronologically below.
- **Analyst consensus** — buy/hold/sell counts and an overall rating badge
  (single-ticker only).
- **EPS chart** — actual vs. analyst-estimated earnings per share for the
  last 4 quarters (single-ticker only).

This tab needs a Finnhub API key (step 3 above) — without one it shows a
prompt to add one rather than an empty/broken page.

---

## Troubleshooting

**Dashboard shows 404 / blank page on GitHub Pages.**
Check Settings → Pages → the source folder is set to `/docs`, not `/ (root)`.

**"Couldn't reach Google Sheets" when logging a purchase/sale/dividend.**
Usually means the Apps Script Web App URL is stale, or its deployment
access isn't set to "Anyone." See [step 2](#2-set-up-the-apps-script-backend).

**"Missing or invalid ticker/shares/totalCost" when logging a sale or
dividend.**
Your deployed Apps Script is running an older version of the code that
doesn't recognize the `sell`/`dividend` action yet — re-paste
`backend/google-apps-script-write-handler.gs` and deploy a new version
(see the note at the end of step 2).

**Insights tab's ticker dropdown looks empty right after opening it.**
It populates from your holdings once they've finished loading — on a slow
connection this can take a second or two, and it'll fill in on its own
without needing to leave and re-enter the tab.

**Non-US holdings (SGX, LSE, etc.) show no price / a stale price.**
These prices come from the `Live Price` column, refreshed by the Apps
Script `refreshLivePrices` trigger every 30 min. Check: (a) your ticker is
the full Yahoo symbol and ends in a suffix listed in `NON_US_SUFFIXES`
(e.g. `D05.SI`, `VWRA.L`) — a bare ticker like `DBS` or `VWRA` won't be
recognized (except the legacy SGX shortcut: a bare code with Currency =
`SGD`); (b) you ran `createLivePriceTrigger` once (setup step 6); (c) the
trigger is actually firing — Apps Script editor → Triggers (clock icon) →
look for `refreshLivePrices`, and Executions for any failures; (d) an
all-`#N/A` or blank column usually means Yahoo rate-limited (429) that run
— it'll recover on the next one, and the code keeps the last good value
rather than blanking it.

**A ticker shows no news / no analyst data / no earnings data.**
Finnhub's free tier is US/North-America-coverage only — non-US tickers
(e.g. SGX `.SI` listings) will legitimately come back empty on the Insights
tab; this isn't a bug.

## Security notes

- Your `WRITE_TOKEN` is the only thing standing between "anyone who finds
  your Apps Script URL" and "can write to your Sheet." Make it long and
  random, and don't share the deployment URL publicly.
- Sharing your Sheet as "Anyone with the link can view" makes the **whole
  spreadsheet** viewable by anyone who has that link — not just the three
  tabs the dashboard reads. If you ever add a tab with something sensitive,
  keep that in mind.
- Everything you type into Data Sources (Sheet ID, API key, write token) is
  stored only in your own browser's local storage — it's never sent
  anywhere except directly to Google/Finnhub from your own device.
