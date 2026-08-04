// ── Apex Portfolio Dashboard — Consolidated Apps Script ─────────────────────
//
// This is the single Apps Script file that should back the Google Sheet
// powering the dashboard. It's NOT executed by the dashboard directly —
// it's a reference copy of code that must be pasted into the Apps Script
// project bound to your Sheet. It combines everything the dashboard needs
// server-side:
//   1. dailySnapshot()  — a daily trigger that fetches live prices and
//                          appends a portfolio-value row to "Snapshots"
//                          (powers the Portfolio History tab).
//   2. doPost()          — the write-back endpoint the dashboard's
//                          "Log Purchase" / "Log Sale" modals call, which
//                          updates "Active Holdings" and (for sales)
//                          appends closed trades to "Realized History".
//
// Selling requires a "Realized History" tab (see REALIZED_SHEET below) to
// already exist in the same spreadsheet, with at least Date/Ticker/Shares
// columns — headers are matched by substring, not fixed position, same as
// the Active Holdings sheet.
//
// ── Setup ────────────────────────────────────────────────────────────────
// 1. Open the Apps Script project bound to your Sheet (Extensions → Apps
//    Script), and replace Code.gs's contents with this entire file.
// 2. Project Settings (gear icon) → Time zone → Asia/Singapore (dailySnapshot
//    formats dates in this zone).
// 3. Project Settings → Script Properties → add:
//      WRITE_TOKEN = <a secret string you choose — treat it like a password>
//      SHEET_ID    = <the spreadsheet ID from its URL,
//                     e.g. docs.google.com/spreadsheets/d/THIS_PART/edit>
// 4. Run createDailyTrigger() once from the editor (select it in the
//    function dropdown, click Run) to register the 8am daily snapshot
//    trigger. Re-running it is safe — it clears any existing dailySnapshot
//    trigger first.
// 5. Deploy → New deployment → type "Web app":
//      Execute as:      Me
//      Who has access:  Anyone
//    (This is the only pairing that lets the dashboard call it without a
//    Google sign-in flow. The URL + WRITE_TOKEN are the only gate — this is
//    proportionate obscurity for a personal tracker, not real
//    authorization. Don't post the deployment URL publicly.)
// 6. Copy the deployment URL. In the dashboard's Data Sources panel, paste
//    it into "Write Endpoint URL" and the same WRITE_TOKEN value into
//    "Write Token".
//
// If you ever change WRITE_TOKEN, redeploy is NOT required — Script
// Properties are read live on every request. If you edit the code itself,
// you DO need to create a new deployment (or manage versions) for changes
// to take effect on the existing URL.

const ACTIVE_SHEET   = 'Active Holdings';
const SNAPSHOT_SHEET = 'Snapshots';
const REALIZED_SHEET = 'Realized History';

// ── Daily Snapshot ───────────────────────────────────────────────────────────

// ── Entry point called by the daily trigger ───────────────────────────────────
function dailySnapshot() {
  // Respects the SHEET_ID Script Property the same way handleBuy/handleSell
  // do, so pointing the script at a different spreadsheet (e.g. after
  // migrating data) only requires updating one Script Property rather than
  // rebinding the whole Apps Script project.
  const sheetId      = PropertiesService.getScriptProperties().getProperty('SHEET_ID');
  const ss           = sheetId ? SpreadsheetApp.openById(sheetId) : SpreadsheetApp.getActiveSpreadsheet();
  const activeSheet  = ss.getSheetByName(ACTIVE_SHEET);
  const snapSheet    = ss.getSheetByName(SNAPSHOT_SHEET) || ss.insertSheet(SNAPSHOT_SHEET);

  const today   = Utilities.formatDate(new Date(), 'Asia/Singapore', 'yyyy-MM-dd');
  const sgdRate = getExchangeRate();

  // ── Read Active Holdings ──────────────────────────────────────────────────
  const raw     = activeSheet.getDataRange().getValues();
  const headers = raw[0].map(h => h.toString().toLowerCase().trim());

  const col = {
    ticker:   headers.findIndex(h => h.includes('ticker') || h.includes('symbol')),
    shares:   headers.findIndex(h => h.includes('share')  || h.includes('qty')),
    currency: headers.findIndex(h => h.includes('currency'))
  };

  if (col.ticker < 0 || col.shares < 0) {
    console.error('Required columns not found in Active Holdings sheet.');
    return;
  }

  const holdings = [];
  for (let i = 1; i < raw.length; i++) {
    const ticker   = raw[i][col.ticker].toString().trim().toUpperCase();
    const shares   = parseFloat(raw[i][col.shares]) || 0;
    const currency = col.currency >= 0
      ? raw[i][col.currency].toString().trim().toUpperCase()
      : 'USD';

    if (!ticker || shares === 0) continue;

    // Auto-append .SI for SGD-denominated tickers (SGX market)
    const yfTicker = (currency === 'SGD' && !ticker.includes('.'))
      ? ticker + '.SI'
      : ticker;

    holdings.push({ ticker, yfTicker, shares, currency });
  }

  if (holdings.length === 0) {
    console.error('No valid holdings found.');
    return;
  }

  // ── Fetch Prices ──────────────────────────────────────────────────────────
  const allYfTickers = holdings.map(h => h.yfTicker);
  const prices       = batchFetchPrices(allYfTickers);

  // ── Build Rows ────────────────────────────────────────────────────────────
  let portfolioTotal = 0;
  const rows = holdings.map(h => {
    const priceNative = prices[h.yfTicker] || 0;
    const priceUSD    = h.currency === 'SGD' ? priceNative / sgdRate : priceNative;
    const totalUSD    = h.shares * priceUSD;
    portfolioTotal   += totalUSD;
    return [today, h.ticker, h.shares, priceUSD, totalUSD, null, h.currency];
  });

  // Backfill portfolio total (only known after summing all rows)
  rows.forEach(r => { r[5] = portfolioTotal; });

  // ── Write to Snapshots Sheet (idempotent — removes today's rows first) ────
  removeRowsForDate(snapSheet, today);
  rows.forEach(row => snapSheet.appendRow(row));
  SpreadsheetApp.flush();

  console.log(`Snapshot saved for ${today}: $${portfolioTotal.toFixed(2)} across ${rows.length} holdings.`);
}

// ── Price Fetching ────────────────────────────────────────────────────────────

function batchFetchPrices(tickers) {
  const prices  = {};
  const joined  = tickers.join(',');
  const options = { muteHttpExceptions: true, headers: { 'User-Agent': 'Mozilla/5.0' } };

  // Primary: Spark v8 batch endpoint (same as dashboard, but no CORS proxy needed here)
  try {
    const url  = `https://query1.finance.yahoo.com/v8/finance/spark?symbols=${encodeURIComponent(joined)}&range=1d&interval=1d`;
    const resp = UrlFetchApp.fetch(url, options);
    if (resp.getResponseCode() === 200) {
      const data = JSON.parse(resp.getContentText());
      Object.keys(data).forEach(sym => {
        const p = data[sym];
        if (p?.close?.length > 0)
          prices[sym.toUpperCase()] = p.close[p.close.length - 1];
      });
    }
  } catch (e) {
    console.warn('Spark batch fetch failed:', e.message);
  }

  // Fallback: v7 quote endpoint for any tickers that came back empty
  tickers.forEach(ticker => {
    if (prices[ticker.toUpperCase()]) return;
    try {
      const url  = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(ticker)}`;
      const resp = UrlFetchApp.fetch(url, options);
      if (resp.getResponseCode() === 200) {
        const result = JSON.parse(resp.getContentText())?.quoteResponse?.result?.[0];
        if (result?.regularMarketPrice)
          prices[ticker.toUpperCase()] = result.regularMarketPrice;
      }
    } catch (e) {
      console.warn(`Fallback price fetch failed for ${ticker}:`, e.message);
    }
  });

  return prices;
}

function getExchangeRate() {
  try {
    const resp = UrlFetchApp.fetch('https://open.er-api.com/v6/latest/USD', { muteHttpExceptions: true });
    if (resp.getResponseCode() === 200) {
      const data = JSON.parse(resp.getContentText());
      if (data?.rates?.SGD) return data.rates.SGD;
    }
  } catch (e) {
    console.warn('Exchange rate fetch failed; using 1.35 fallback.');
  }
  return 1.35;
}

// ── Utility: remove today's rows before re-inserting (makes script re-runnable) ──
function removeRowsForDate(sheet, dateStr) {
  const values = sheet.getDataRange().getValues();
  for (let i = values.length - 1; i >= 1; i--) {
    if (String(values[i][0]).startsWith(dateStr)) sheet.deleteRow(i + 1);
  }
}

// ── Trigger Setup: run this ONCE from the editor to register the daily trigger ──
function createDailyTrigger() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'dailySnapshot')
    .forEach(t => ScriptApp.deleteTrigger(t));

  ScriptApp.newTrigger('dailySnapshot')
    .timeBased()
    .atHour(8)       // 8am — uses the script timezone (Asia/Singapore set in Step 2)
    .everyDays(1)
    .create();

  console.log('Trigger created: dailySnapshot will run at 8am SGT every day.');
}

// ── Write-Back Handler: "Log Purchase" / "Log Sale" / "Log Dividend" ───────

function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);

    const props = PropertiesService.getScriptProperties();
    const expectedToken = props.getProperty('WRITE_TOKEN');
    if (!expectedToken || payload.token !== expectedToken) {
      return jsonResponse({ success: false, error: 'unauthorized' });
    }

    const action = String(payload.action || 'buy').trim().toLowerCase();
    if (action === 'sell') {
      return handleSell(payload, props);
    }
    if (action === 'dividend') {
      return handleDividend(payload, props);
    }
    return handleBuy(payload, props);

  } catch (err) {
    return jsonResponse({ success: false, error: err.message });
  }
}

// Finds a column index by substring match on lowercased header text — the
// sheet's exact header wording isn't fixed, so both handlers tolerate any
// header containing the expected word rather than assuming fixed positions.
function findCol(headerArr, needle) {
  return headerArr.findIndex(h => h.includes(needle));
}

// Percent-return column (e.g. "% of Profit", "Profit %", "Return %",
// "Yield") — shared by handleSell (realized trade return) and
// handleDividend (yield on cost), since both write into the same column.
// Matched on '%' first, falling back to word-based headers with no literal
// % sign — 'yield' is included because the frontend CSV parser's own
// dividend-profitPct keys explicitly include it (app.js findValue(['%% of
// profit', 'profit %', 'yield', 'yield %', 'return'])).
function findProfitPctCol(headerArr) {
  if (findCol(headerArr, '%') >= 0)      return findCol(headerArr, '%');
  if (findCol(headerArr, 'return') >= 0) return findCol(headerArr, 'return');
  if (findCol(headerArr, 'yield') >= 0)  return findCol(headerArr, 'yield');
  return findCol(headerArr, 'gain');
}

function handleBuy(payload, props) {
  const ticker    = String(payload.ticker || '').trim().toUpperCase();
  const shares    = Number(payload.shares);
  const totalCost = Number(payload.totalCost);
  const currency  = String(payload.currency || 'USD').trim().toUpperCase();
  const category  = String(payload.category || 'Other').trim();

  if (!ticker || !(shares > 0) || !(totalCost > 0)) {
    return jsonResponse({ success: false, error: 'Missing or invalid ticker/shares/totalCost.' });
  }

  const sheetId = props.getProperty('SHEET_ID');
  const ss = sheetId ? SpreadsheetApp.openById(sheetId) : SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(ACTIVE_SHEET);
  if (!sheet) {
    return jsonResponse({ success: false, error: `Sheet "${ACTIVE_SHEET}" not found.` });
  }

  const values = sheet.getDataRange().getValues();
  const header = values[0].map(h => String(h).toLowerCase());

  const cTicker   = findCol(header, 'ticker') >= 0 ? findCol(header, 'ticker') : findCol(header, 'symbol');
  const cCategory = findCol(header, 'category');
  const cCost     = findCol(header, 'cost');
  const cShares   = findCol(header, 'share');
  const cCurrency = findCol(header, 'currency');

  if (cTicker < 0 || cCost < 0 || cShares < 0) {
    return jsonResponse({ success: false, error: 'Could not find Ticker/Cost/Shares columns in the sheet header.' });
  }

  // Find an existing row for this ticker
  let rowIndex = -1, existingRow = null;
  for (let i = 1; i < values.length; i++) {
    const rowTicker = String(values[i][cTicker] || '').trim().toUpperCase();
    if (rowTicker === ticker) { rowIndex = i; existingRow = values[i]; break; }
  }

  if (rowIndex >= 0) {
    const existingCurrency = cCurrency >= 0
      ? String(existingRow[cCurrency] || 'USD').trim().toUpperCase()
      : 'USD';
    if (existingCurrency !== currency) {
      return jsonResponse({
        success: false,
        error: `${ticker} already exists in ${existingCurrency}; this purchase is in ${currency}. Reconcile manually.`
      });
    }

    // Merge: sum shares and cost into the existing row (weighted-average cost basis)
    const newShares = Number(existingRow[cShares]) + shares;
    const newCost   = Number(existingRow[cCost])   + totalCost;
    sheet.getRange(rowIndex + 1, cShares + 1).setValue(newShares);
    sheet.getRange(rowIndex + 1, cCost   + 1).setValue(newCost);
    if (cCategory >= 0 && payload.category) {
      sheet.getRange(rowIndex + 1, cCategory + 1).setValue(category);
    }

    SpreadsheetApp.flush();
    return jsonResponse({ success: true, action: 'merged', ticker, shares: newShares, totalCost: newCost });
  }

  // New ticker — append a row, placing values by the header's actual column order
  const newRow = new Array(header.length).fill('');
  newRow[cTicker] = ticker;
  newRow[cCost]   = totalCost;
  newRow[cShares] = shares;
  if (cCategory >= 0) newRow[cCategory] = category;
  if (cCurrency >= 0) newRow[cCurrency] = currency;
  sheet.appendRow(newRow);

  SpreadsheetApp.flush();
  return jsonResponse({ success: true, action: 'appended', ticker, shares, totalCost });
}

// Sells (fully or partially) an existing Active Holdings position:
//   1. Validates the ticker exists and enough shares are held (server-side
//      is the authoritative check — the frontend's own check is just UX).
//   2. Reduces shares/cost proportionally (average-cost-basis method), or
//      deletes the row entirely if the full position is sold.
//   3. Appends a "Trade" row to Realized History with the realized P&L.
// Both sheets are validated BEFORE either is mutated, to minimize the
// (unavoidable, since Apps Script has no cross-sheet transactions) window
// where Active Holdings could be changed but the Realized History append
// fails.
function handleSell(payload, props) {
  const ticker     = String(payload.ticker || '').trim().toUpperCase();
  const sharesSold = Number(payload.shares);
  const totalSell  = Number(payload.totalSell);
  const commission = Number(payload.commission) || 0;
  const date       = String(payload.date || '').trim() || new Date().toISOString().split('T')[0];

  if (!ticker || !(sharesSold > 0) || !(totalSell > 0)) {
    return jsonResponse({ success: false, error: 'Missing or invalid ticker/shares/totalSell.' });
  }

  const sheetId = props.getProperty('SHEET_ID');
  const ss = sheetId ? SpreadsheetApp.openById(sheetId) : SpreadsheetApp.getActiveSpreadsheet();

  // ── Locate + validate the Active Holdings row being sold ────────────────
  const activeSheet = ss.getSheetByName(ACTIVE_SHEET);
  if (!activeSheet) {
    return jsonResponse({ success: false, error: `Sheet "${ACTIVE_SHEET}" not found.` });
  }
  const activeValues = activeSheet.getDataRange().getValues();
  const activeHeader = activeValues[0].map(h => String(h).toLowerCase());

  const cTicker   = findCol(activeHeader, 'ticker') >= 0 ? findCol(activeHeader, 'ticker') : findCol(activeHeader, 'symbol');
  const cCategory = findCol(activeHeader, 'category');
  const cCost     = findCol(activeHeader, 'cost');
  const cShares   = findCol(activeHeader, 'share');
  const cCurrency = findCol(activeHeader, 'currency');

  if (cTicker < 0 || cCost < 0 || cShares < 0) {
    return jsonResponse({ success: false, error: 'Could not find Ticker/Cost/Shares columns in the Active Holdings sheet.' });
  }

  let rowIndex = -1, existingRow = null;
  for (let i = 1; i < activeValues.length; i++) {
    if (String(activeValues[i][cTicker] || '').trim().toUpperCase() === ticker) {
      rowIndex = i; existingRow = activeValues[i]; break;
    }
  }
  if (rowIndex < 0) {
    return jsonResponse({ success: false, error: `${ticker} not found in Active Holdings.` });
  }

  const existingShares = Number(existingRow[cShares]);
  const existingCost   = Number(existingRow[cCost]);
  const currency = cCurrency >= 0 ? String(existingRow[cCurrency] || 'USD').trim().toUpperCase() : 'USD';
  const category = cCategory >= 0 ? String(existingRow[cCategory] || '') : (String(payload.category || 'Other').trim());

  const EPS = 1e-6;
  if (sharesSold > existingShares + EPS) {
    return jsonResponse({
      success: false,
      error: `Cannot sell ${sharesSold} shares of ${ticker} — only ${existingShares} held.`
    });
  }

  // ── Locate + validate Realized History BEFORE mutating Active Holdings ──
  const realizedSheet = ss.getSheetByName(REALIZED_SHEET);
  if (!realizedSheet) {
    return jsonResponse({ success: false, error: `Sheet "${REALIZED_SHEET}" not found.` });
  }
  const realizedValues = realizedSheet.getDataRange().getValues();
  const realizedHeader = realizedValues[0].map(h => String(h).toLowerCase());

  const rDate              = findCol(realizedHeader, 'date');
  const rTicker             = findCol(realizedHeader, 'ticker') >= 0 ? findCol(realizedHeader, 'ticker') : findCol(realizedHeader, 'symbol');
  const rCategory            = findCol(realizedHeader, 'category');
  const rType                = findCol(realizedHeader, 'type');
  const rShares              = findCol(realizedHeader, 'share');
  const rBuyCost             = findCol(realizedHeader, 'buy') >= 0 ? findCol(realizedHeader, 'buy') : findCol(realizedHeader, 'cost');
  const rSellProceeds        = findCol(realizedHeader, 'sell') >= 0 ? findCol(realizedHeader, 'sell') : findCol(realizedHeader, 'proceeds');
  // Deliberately does NOT fall back to a generic 'price' substring match —
  // that could collide with a "Sell Price" / "Total Sell Price" column
  // already claimed by rSellProceeds above. Mirrors the frontend CSV parser's
  // own column keys for this field (app.js findValue(['transacted price',
  // 'transaction price', 'transacted'])) exactly.
  const rSellPricePerShare   = findCol(realizedHeader, 'transacted') >= 0 ? findCol(realizedHeader, 'transacted') : findCol(realizedHeader, 'transaction');
  const rCommission          = findCol(realizedHeader, 'commission') >= 0 ? findCol(realizedHeader, 'commission') : findCol(realizedHeader, 'fee');
  // rProfit explicitly EXCLUDES '%' headers so a "% of Profit" column
  // (which also contains the substring "profit") never gets mistaken for
  // the raw dollar Profit column.
  const rProfitPct           = findProfitPctCol(realizedHeader);
  const rProfit              = realizedHeader.findIndex(h => h.includes('profit') && !h.includes('%'));
  const rCurrency            = findCol(realizedHeader, 'currency');

  if (rDate < 0 || rTicker < 0 || rShares < 0 || (rBuyCost < 0 && rProfit < 0)) {
    return jsonResponse({
      success: false,
      error: 'Could not find required Date/Ticker/Shares/(Cost or Profit) columns in Realized History.'
    });
  }

  // ── Proportional average-cost-basis reduction ────────────────────────────
  const costBasisRemoved = existingCost * (sharesSold / existingShares);
  const remainingShares  = existingShares - sharesSold;
  const remainingCost    = existingCost - costBasisRemoved;

  let sheetAction;
  if (remainingShares <= EPS) {
    activeSheet.deleteRow(rowIndex + 1);
    sheetAction = 'deleted';
  } else {
    activeSheet.getRange(rowIndex + 1, cShares + 1).setValue(remainingShares);
    activeSheet.getRange(rowIndex + 1, cCost   + 1).setValue(remainingCost);
    sheetAction = 'reduced';
  }
  SpreadsheetApp.flush();

  // ── Append the closed trade to Realized History ──────────────────────────
  const profit    = totalSell - costBasisRemoved - commission;
  const profitPct = costBasisRemoved > 0 ? (profit / costBasisRemoved) * 100 : 0;
  const sellPricePerShare = sharesSold > 0 ? totalSell / sharesSold : 0;

  const newRealizedRow = new Array(realizedHeader.length).fill('');
  newRealizedRow[rDate]   = date;
  newRealizedRow[rTicker] = ticker;
  if (rCategory >= 0)          newRealizedRow[rCategory] = category;
  if (rType >= 0)              newRealizedRow[rType] = 'Trade';
  newRealizedRow[rShares]      = sharesSold;
  if (rBuyCost >= 0)           newRealizedRow[rBuyCost] = costBasisRemoved;
  if (rSellProceeds >= 0)      newRealizedRow[rSellProceeds] = totalSell;
  if (rSellPricePerShare >= 0) newRealizedRow[rSellPricePerShare] = sellPricePerShare;
  if (rCommission >= 0)        newRealizedRow[rCommission] = commission;
  if (rProfit >= 0)            newRealizedRow[rProfit] = profit;
  if (rProfitPct >= 0)         newRealizedRow[rProfitPct] = profitPct;
  if (rCurrency >= 0)          newRealizedRow[rCurrency] = currency;
  realizedSheet.appendRow(newRealizedRow);
  SpreadsheetApp.flush();

  return jsonResponse({
    success: true,
    action: sheetAction, // 'reduced' | 'deleted'
    ticker,
    sharesSold,
    remainingShares: sheetAction === 'deleted' ? 0 : remainingShares,
    remainingCost:   sheetAction === 'deleted' ? 0 : remainingCost,
    costBasisRemoved,
    totalSell,
    commission,
    currency,
    category,
    profit,
    profitPct,
    date,
  });
}

// Logs a dividend payout: cash income, not a disposal — it never touches
// Active Holdings (no share count or cost basis change), it only appends a
// "Dividend" row to Realized History.
function handleDividend(payload, props) {
  const ticker   = String(payload.ticker || '').trim().toUpperCase();
  const amount   = Number(payload.amount);
  const currency = String(payload.currency || 'USD').trim().toUpperCase();
  const date     = String(payload.date || '').trim() || new Date().toISOString().split('T')[0];

  if (!ticker || !(amount > 0)) {
    return jsonResponse({ success: false, error: 'Missing or invalid ticker/amount.' });
  }

  const sheetId = props.getProperty('SHEET_ID');
  const ss = sheetId ? SpreadsheetApp.openById(sheetId) : SpreadsheetApp.getActiveSpreadsheet();

  // Category is informational context, pulled fresh from Active Holdings if
  // this ticker is still held; otherwise falls back to whatever the
  // frontend sent (the holding's category at modal-open time) or 'Other'.
  // Cost basis is pulled the same way, purely to compute a yield-on-cost %
  // — if the ticker isn't currently held (e.g. dividend arrived after a
  // full sell), yield just can't be computed and stays 0.
  let category  = String(payload.category || 'Other').trim();
  let costBasis = 0;
  const activeSheet = ss.getSheetByName(ACTIVE_SHEET);
  if (activeSheet) {
    const activeValues = activeSheet.getDataRange().getValues();
    const activeHeader = activeValues[0].map(h => String(h).toLowerCase());
    const cTicker   = findCol(activeHeader, 'ticker') >= 0 ? findCol(activeHeader, 'ticker') : findCol(activeHeader, 'symbol');
    const cCategory = findCol(activeHeader, 'category');
    const cCost     = findCol(activeHeader, 'cost');
    if (cTicker >= 0) {
      for (let i = 1; i < activeValues.length; i++) {
        if (String(activeValues[i][cTicker] || '').trim().toUpperCase() === ticker) {
          if (cCategory >= 0) category = String(activeValues[i][cCategory] || category);
          if (cCost >= 0)     costBasis = Number(activeValues[i][cCost]) || 0;
          break;
        }
      }
    }
  }

  const yieldPct = costBasis > 0 ? (amount / costBasis) * 100 : 0;

  const realizedSheet = ss.getSheetByName(REALIZED_SHEET);
  if (!realizedSheet) {
    return jsonResponse({ success: false, error: `Sheet "${REALIZED_SHEET}" not found.` });
  }
  const realizedValues = realizedSheet.getDataRange().getValues();
  const realizedHeader = realizedValues[0].map(h => String(h).toLowerCase());

  const rDate     = findCol(realizedHeader, 'date');
  const rTicker   = findCol(realizedHeader, 'ticker') >= 0 ? findCol(realizedHeader, 'ticker') : findCol(realizedHeader, 'symbol');
  const rCategory = findCol(realizedHeader, 'category');
  const rType     = findCol(realizedHeader, 'type');
  // Reuses the SAME "profit" column detection as handleSell (dollar amount,
  // excluding any '%' header) rather than searching for a separate
  // "dividend"/"income"/"payout" column — the sheet most likely has ONE
  // shared Profit/Realized P&L column for both Trade and Dividend rows,
  // since the dashboard's CSV parser checks a 'profit' substring FIRST for
  // both row types (see app.js's findValue keys for dividend profit) before
  // falling back to dividend-specific words.
  const rAmount    = realizedHeader.findIndex(h => h.includes('profit') && !h.includes('%'));
  const rYieldPct  = findProfitPctCol(realizedHeader);
  const rCurrency  = findCol(realizedHeader, 'currency');

  if (rDate < 0 || rTicker < 0 || rAmount < 0) {
    return jsonResponse({
      success: false,
      error: 'Could not find required Date/Ticker/Profit columns in Realized History.'
    });
  }

  const newRow = new Array(realizedHeader.length).fill('');
  newRow[rDate]   = date;
  newRow[rTicker] = ticker;
  if (rCategory >= 0) newRow[rCategory] = category;
  if (rType >= 0)     newRow[rType] = 'Dividend';
  newRow[rAmount]     = amount;
  if (rYieldPct >= 0) newRow[rYieldPct] = yieldPct;
  if (rCurrency >= 0) newRow[rCurrency] = currency;
  realizedSheet.appendRow(newRow);
  SpreadsheetApp.flush();

  return jsonResponse({ success: true, action: 'dividend-logged', ticker, amount, currency, category, date, yieldPct });
}

function jsonResponse(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
