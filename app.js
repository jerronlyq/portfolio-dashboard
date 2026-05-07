// Default Mock Data
const DEFAULT_CSV_DATA = `Ticker,Category,Total Cost Price,Shares,Currency
AAPL,Tech,15000.00,100,USD
MSFT,Tech,14000.00,50,USD
VOO,ETF,76000.00,200,USD
TSLA,Auto,6000.00,30,USD
NVDA,Tech,16000.00,40,USD`;

const DEFAULT_REALIZED_DATA = `Ticker,Category,Total Buy Cost,Total shares,Total Sell Price,Commission fees,Currency
NFLX,Tech,1500.00,10,2500.00,5.00,USD
GOOGL,Tech,3000.00,25,3100.00,0,USD
DBS,Bank,5000.00,100,6000.00,10.00,SGD`;

// Per-ticker line colours — shared between chips and chart datasets
const CHART_COLORS = ['#8b5cf6', '#10b981', '#f59e0b', '#ef4444', '#3b82f6', '#ec4899', '#6366f1', '#f97316'];

let allocationChartInstance = null;
let historyChartInstance    = null;

// ── Global State ──────────────────────────────────────────────────────────────
let activeCurrency        = 'USD';
let currentSgdRate        = 1.35;
let currentTab            = 'active';
let currentSort           = { column: null, direction: 'asc', table: null };
let globalActiveData      = [];
let globalRealizedData    = [];
let globalSnapshotData    = null;   // { dates[], tickers[], series{} }
let lastPriceUpdate       = null;
let activeHistoryRange    = 'All';
let selectedHistoryTickers = new Set();

// ── Module-Level Utilities ────────────────────────────────────────────────────

const parseNum = (val) => parseFloat(String(val).replace(/[^0-9.-]+/g, '')) || 0;

const findValue = (row, keys) => {
  const match = Object.keys(row).find(k =>
    keys.some(key => k.toLowerCase().includes(key.toLowerCase()))
  );
  return match ? row[match] : '';
};

const nameOf = (ticker) => TICKER_NAME_MAP[ticker] || ticker;

const toDisplayCurrency = (v) => activeCurrency === 'SGD' ? v * currentSgdRate : v;

// Auto-appends .SI for SGD-denominated tickers missing an exchange qualifier
const normalizeTicker = (raw, currency = 'USD') => {
  let t = String(raw).trim().toUpperCase();
  if (t === 'BTCUSD') return 'BTC-USD';
  if (t === 'ETHUSD') return 'ETH-USD';
  if (t === 'SOLUSD') return 'SOL-USD';
  if (currency === 'SGD' && !t.includes('.')) return t + '.SI';
  return t;
};

const FINNHUB_CRYPTO_MAP = {
  'BTC-USD': 'BINANCE:BTCUSDT',
  'ETH-USD': 'BINANCE:ETHUSDT',
  'SOL-USD': 'BINANCE:SOLUSDT',
};
const toFinnhubSymbol = (ticker) => FINNHUB_CRYPTO_MAP[ticker] || ticker;

const SOURCE_COLORS = {
  'Finnhub': 'var(--accent-orange)',
  'Yahoo':   'var(--accent-cyan)',
  'Google':  'var(--accent-red)',
};

const formatCurrency = (value) => {
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: activeCurrency === 'SGD' ? 'SGD' : 'USD',
    minimumFractionDigits: 2, maximumFractionDigits: 2
  }).format(toDisplayCurrency(value));
};

// Compact axis-label formatter: $182k, $1.2M, etc.
const formatAxisValue = (val) => {
  const converted = toDisplayCurrency(val);
  const symbol    = activeCurrency === 'SGD' ? 'S$' : '$';
  if (converted >= 1_000_000) return `${symbol}${(converted / 1_000_000).toFixed(1)}M`;
  if (converted >= 1_000)     return `${symbol}${(converted / 1_000).toFixed(0)}k`;
  return `${symbol}${converted.toFixed(0)}`;
};

function updateLastRefreshed() {
  lastPriceUpdate = new Date();
  const el = document.getElementById('last-updated');
  if (el) el.textContent = `Updated: ${lastPriceUpdate.toLocaleTimeString()}`;
}

// ── Source Status Pills ───────────────────────────────────────────────────────

function updateSourcePills() {
  [
    { id: 'pill-active',    key: 'saved_csv_url',      cls: 'pill-cyan'   },
    { id: 'pill-realized',  key: 'saved_realized_url', cls: 'pill-purple' },
    { id: 'pill-snapshots', key: 'saved_snapshot_url', cls: 'pill-green'  },
    { id: 'pill-finnhub',   key: 'finnhub_api_key',    cls: 'pill-orange' },
  ].forEach(({ id, key, cls }) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.className = `source-pill ${localStorage.getItem(key) ? cls : ''}`;
  });
}

// ── Exchange Rate ─────────────────────────────────────────────────────────────

async function fetchExchangeRate() {
  try {
    const response = await fetch('https://open.er-api.com/v6/latest/USD');
    const data = await response.json();
    if (data?.rates?.SGD) {
      currentSgdRate = data.rates.SGD;
      const display = document.getElementById('exchange-rate-display');
      if (display) display.textContent = `1 USD = ${currentSgdRate.toFixed(4)} SGD`;
    }
  } catch (e) {
    console.error('Failed to fetch live exchange rate; using 1.35 fallback.', e);
  }
}

// ── CORS Proxy Chain ──────────────────────────────────────────────────────────

const CORS_PROXIES = [
  url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  url => `https://corsproxy.io/?${encodeURIComponent(url)}`,
  url => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(url)}`,
];

async function fetchWithProxy(targetUrl) {
  for (const proxyFn of CORS_PROXIES) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 6000);
      const res = await fetch(proxyFn(targetUrl), { signal: controller.signal });
      clearTimeout(timer);
      if (res.ok) return res;
    } catch (e) { /* try next proxy */ }
  }
  return null;
}

// ── Offline Ticker Name Dictionary ───────────────────────────────────────────

const TICKER_NAME_MAP = {
  'AAPL': 'Apple Inc.', 'MSFT': 'Microsoft Corp.', 'NVDA': 'NVIDIA Corp.', 'AMZN': 'Amazon.com Inc.',
  'GOOGL': 'Alphabet Inc. (Class A)', 'GOOG': 'Alphabet Inc. (Class C)', 'META': 'Meta Platforms Inc.',
  'BRK.B': 'Berkshire Hathaway', 'TSLA': 'Tesla Inc.', 'UNH': 'UnitedHealth Group',
  'JNJ': 'Johnson & Johnson', 'XOM': 'Exxon Mobil Corp.', 'JPM': 'JPMorgan Chase & Co.',
  'V': 'Visa Inc.', 'PG': 'Procter & Gamble Co.', 'HD': 'The Home Depot Inc.',
  'CVX': 'Chevron Corp.', 'MA': 'Mastercard Inc.', 'ABBV': 'AbbVie Inc.',
  'LLY': 'Eli Lilly and Co.', 'MRK': 'Merck & Co.', 'PEP': 'PepsiCo Inc.',
  'KO': 'The Coca-Cola Co.', 'AVGO': 'Broadcom Inc.', 'PFE': 'Pfizer Inc.',
  'TMO': 'Thermo Fisher Scientific', 'COST': 'Costco Wholesale Corp.', 'CSCO': 'Cisco Systems Inc.',
  'MCD': "McDonald's Corp.", 'CRM': 'Salesforce Inc.', 'DHR': 'Danaher Corp.',
  'BAC': 'Bank of America Corp.', 'ABT': 'Abbott Laboratories', 'ACN': 'Accenture plc',
  'LIN': 'Linde plc', 'ORCL': 'Oracle Corp.', 'ADBE': 'Adobe Inc.',
  'NFLX': 'Netflix Inc.', 'DIS': 'The Walt Disney Co.', 'INTC': 'Intel Corp.',
  'AMD': 'Advanced Micro Devices', 'CMCSA': 'Comcast Corp.', 'TXN': 'Texas Instruments Inc.',
  'VZ': 'Verizon Communications Inc.', 'NKE': 'NIKE Inc.', 'WMT': 'Walmart Inc.',
  'QCOM': 'QUALCOMM Inc.', 'T': 'AT&T Inc.', 'BA': 'The Boeing Co.', 'IBM': 'International Business Machines',
  'NOW': 'ServiceNow Inc.', 'UBER': 'Uber Technologies', 'SQ': 'Block Inc.',
  'PLTR': 'Palantir Technologies', 'SNOW': 'Snowflake Inc.', 'SHOP': 'Shopify Inc.',
  'VOO': 'Vanguard S&P 500 ETF', 'SPY': 'SPDR S&P 500 ETF', 'QQQ': 'Invesco QQQ Trust',
  'IVV': 'iShares Core S&P 500 ETF', 'VTI': 'Vanguard Total Stock Market ETF',
  'ARKK': 'ARK Innovation ETF', 'SCHD': 'Schwab US Dividend Equity ETF',
  'DBS': 'DBS Group Holdings Ltd', 'D05.SI': 'DBS Group Holdings Ltd',
  'OCBC': 'OCBC Bank', 'O39.SI': 'OCBC Bank',
  'UOB': 'United Overseas Bank (UOB)', 'U11.SI': 'United Overseas Bank (UOB)',
  'Z74.SI': 'Singtel', 'C38U.SI': 'CapitaLand Integrated Commercial Trust',
  'BTC-USD': 'Bitcoin', 'ETH-USD': 'Ethereum', 'SOL-USD': 'Solana'
};

// ── Live Price Fetching ───────────────────────────────────────────────────────

async function fetchLivePrices(tickers) {
  const dictionary = {};
  if (!tickers || tickers.length === 0) return dictionary;

  const cleanTickers = [...new Set(
    tickers
      .map(t => normalizeTicker(t))
      .filter(t => t && t !== 'UNKNOWN' && !t.includes('LOADING'))
  )];
  if (cleanTickers.length === 0) return dictionary;

  const finnhubKey = localStorage.getItem('finnhub_api_key') || '';

  // ── 1. Finnhub — direct CORS, no proxy needed (US stocks, ETFs, crypto) ────
  if (finnhubKey) {
    const finnhubTickers = cleanTickers.filter(t => !t.endsWith('.SI'));
    await Promise.all(finnhubTickers.map(async (ticker) => {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        const res = await fetch(
          `https://finnhub.io/api/v1/quote?symbol=${toFinnhubSymbol(ticker)}&token=${finnhubKey}`,
          { signal: controller.signal }
        );
        clearTimeout(timer);
        if (res.ok) {
          const data = await res.json();
          if (data.c > 0) {
            dictionary[ticker] = { price: data.c, name: nameOf(ticker), source: 'Finnhub' };
            console.log(`[Finnhub] ${ticker}: ${data.c}`);
          }
        }
      } catch (e) {
        console.warn(`[Finnhub] failed for ${ticker}:`, e);
      }
    }));
  }

  // ── 2. Yahoo Spark v8 — for SGX (.SI) tickers and any Finnhub misses ──────
  const afterFinnhub = cleanTickers.filter(t => !dictionary[t]?.price);
  if (afterFinnhub.length > 0) {
    try {
      const sparkUrl = `https://query1.finance.yahoo.com/v8/finance/spark?symbols=${afterFinnhub.join(',')}&range=1d&interval=1d`;
      const res = await fetchWithProxy(sparkUrl);
      if (res) {
        const data = await res.json();
        (data?.spark?.result || []).forEach(item => {
          const symbol   = item?.symbol?.toUpperCase();
          if (!symbol) return;
          const response = item?.response?.[0];
          const closes   = (response?.indicators?.quote?.[0]?.close || []).filter(p => p != null);
          const price    = closes[closes.length - 1] ?? response?.meta?.regularMarketPrice;
          if (price) {
            dictionary[symbol] = { price, name: nameOf(symbol), source: 'Yahoo' };
            console.log(`[Spark v8] ${symbol}: ${price}`);
          }
        });
      }
    } catch (e) {
      console.warn('[Spark v8] batch fetch failed:', e);
    }
  }

  // ── 3. Yahoo v7 Quote — final fallback ────────────────────────────────────
  const afterSpark = cleanTickers.filter(t => !dictionary[t]?.price);
  if (afterSpark.length > 0) {
    try {
      const quoteUrl = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${afterSpark.join(',')}`;
      const res = await fetchWithProxy(quoteUrl);
      if (res) {
        const data = await res.json();
        (data?.quoteResponse?.result || []).forEach(item => {
          const symbol = item?.symbol?.toUpperCase();
          const price  = item?.regularMarketPrice;
          if (symbol && price) {
            dictionary[symbol] = {
              price,
              name: item.shortName || item.longName || nameOf(symbol),
              source: 'Yahoo'
            };
            console.log(`[v7 Quote] ${symbol}: ${price}`);
          }
        });
      }
    } catch (e) {
      console.warn('[v7 Quote] fallback failed:', e);
    }
  }

  // ── 4. Static names; live name lookup only for priced tickers ─────────────
  await Promise.all(cleanTickers.map(async (ticker) => {
    if (TICKER_NAME_MAP[ticker]) {
      if (dictionary[ticker]) dictionary[ticker].name = TICKER_NAME_MAP[ticker];
      else dictionary[ticker] = { price: 0, name: TICKER_NAME_MAP[ticker] };
      return;
    }
    if (!dictionary[ticker]?.price) return;
    if (dictionary[ticker].name && dictionary[ticker].name !== ticker) return;
    try {
      const searchUrl = `https://query2.finance.yahoo.com/v1/finance/search?q=${ticker}`;
      const res = await fetchWithProxy(searchUrl);
      if (res) {
        const searchData = await res.json();
        if (searchData?.quotes?.length > 0) {
          const match = searchData.quotes.find(q => q.symbol === ticker) || searchData.quotes[0];
          const realName = match.shortname || match.longname || ticker;
          if (dictionary[ticker]) dictionary[ticker].name = realName;
          else dictionary[ticker] = { price: 0, name: realName };
        }
      }
    } catch (e) {
      console.warn(`[Name lookup] failed for ${ticker}:`, e);
    }
  }));

  console.log('[fetchLivePrices] result:', dictionary);
  return dictionary;
}

// ── Refresh Active Prices In-Place ───────────────────────────────────────────

async function refreshPrices() {
  if (globalActiveData.length === 0) return;
  const loader = document.getElementById('loading');
  if (loader) {
    loader.querySelector('p').textContent = 'Refreshing live prices...';
    loader.classList.remove('hidden');
  }

  const tickers = globalActiveData.map(item => normalizeTicker(item.ticker, item.originalBase));
  const prices  = await fetchLivePrices(tickers);

  globalActiveData = globalActiveData.map(item => {
    const cleanTicker = normalizeTicker(item.ticker, item.originalBase);
    const dictData    = prices[cleanTicker];
    if (!dictData?.price) return item;

    let mktPrice = dictData.price;
    if (item.originalBase === 'SGD' && currentSgdRate > 0) mktPrice /= currentSgdRate;

    const totalCostVal = item.costPrice * item.shares;
    const totalMktVal  = item.shares * mktPrice;
    const profit       = totalMktVal - totalCostVal;
    const profitPct    = totalCostVal > 0 ? (profit / totalCostVal) * 100 : 0;

    return { ...item, mktPrice, totalMktVal, profit, profitPct, source: dictData.source || 'Yahoo' };
  });

  updateLastRefreshed();
  if (loader) loader.classList.add('hidden');
  if (currentTab === 'active') renderDashboard();
}

// ── Application Init ──────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  await fetchExchangeRate();
  try { if (typeof feather !== 'undefined') feather.replace(); } catch (e) {}
  if (typeof Chart !== 'undefined') {
    Chart.defaults.color = '#94a3b8';
    Chart.defaults.font.family = "'Outfit', sans-serif";
  }

  // ── Data sources collapsible panel ───────────────────────────────────────

  const sourcesToggle = document.getElementById('sources-toggle');
  const sourcesBody   = document.getElementById('sources-body');
  const chevron       = document.getElementById('sources-chevron');

  sourcesToggle.addEventListener('click', () => {
    const isNowOpen = sourcesBody.classList.toggle('open');
    if (chevron) chevron.style.transform = isNowOpen ? 'rotate(180deg)' : 'rotate(0deg)';
    localStorage.setItem('sources_panel_open', isNowOpen);
  });

  // Restore panel state — open by default on first visit
  const panelState = localStorage.getItem('sources_panel_open');
  if (panelState === 'true' || panelState === null) {
    sourcesBody.classList.add('open');
    if (chevron) chevron.style.transform = 'rotate(180deg)';
  }

  updateSourcePills();

  // ── Currency toggle ───────────────────────────────────────────────────────

  const toggle = document.getElementById('currency-toggle');
  if (toggle) {
    toggle.addEventListener('change', (e) => {
      activeCurrency = e.target.checked ? 'SGD' : 'USD';
      const usdLabel = document.getElementById('usd-label');
      const sgdLabel = document.getElementById('sgd-label');
      if (activeCurrency === 'SGD') {
        if (usdLabel) { usdLabel.style.color = 'var(--text-secondary)'; usdLabel.style.fontWeight = '500'; }
        if (sgdLabel) { sgdLabel.style.color = 'var(--accent-purple)'; sgdLabel.style.fontWeight = '600'; }
      } else {
        if (usdLabel) { usdLabel.style.color = 'var(--accent-cyan)'; usdLabel.style.fontWeight = '600'; }
        if (sgdLabel) { sgdLabel.style.color = 'var(--text-secondary)'; sgdLabel.style.fontWeight = '500'; }
      }
      renderDashboard();
    });
  }

  // ── Tab switching ─────────────────────────────────────────────────────────

  function activateTab(tabId) {
    ['tab-active', 'tab-realized', 'tab-history'].forEach(id => {
      document.getElementById(id).classList.remove('active');
    });
    document.getElementById(tabId).classList.add('active');

    const isHistory = tabId === 'tab-history';
    document.getElementById('portfolio-content').classList.toggle('hidden', isHistory);
    document.getElementById('history-content').classList.toggle('hidden', !isHistory);
  }

  document.getElementById('tab-active').addEventListener('click', () => {
    currentTab = 'active';
    activateTab('tab-active');
    renderDashboard();
  });

  document.getElementById('tab-realized').addEventListener('click', () => {
    currentTab = 'realized';
    activateTab('tab-realized');
    renderDashboard();
  });

  document.getElementById('tab-history').addEventListener('click', () => {
    currentTab = 'history';
    activateTab('tab-history');
    renderHistoryTab();
  });

  // ── Load buttons ──────────────────────────────────────────────────────────

  document.getElementById('load-btn').addEventListener('click', () => {
    const url = document.getElementById('csv-url').value.trim();
    if (url) { localStorage.setItem('saved_csv_url', url); updateSourcePills(); fetchRemoteCSV(url, 'active'); }
    else alert("Please paste the Active Holdings CSV URL.");
  });

  document.getElementById('load-realized-btn').addEventListener('click', () => {
    const url = document.getElementById('realized-url').value.trim();
    if (url) { localStorage.setItem('saved_realized_url', url); updateSourcePills(); fetchRemoteCSV(url, 'realized'); }
    else alert("Please paste the Realized History CSV URL.");
  });

  document.getElementById('load-snapshot-btn').addEventListener('click', () => {
    const url = document.getElementById('snapshot-url').value.trim();
    if (url) { localStorage.setItem('saved_snapshot_url', url); updateSourcePills(); fetchRemoteCSV(url, 'snapshot'); }
    else alert("Please paste the Snapshots CSV URL.");
  });

  // ── Offline file upload ───────────────────────────────────────────────────

  document.getElementById('csv-file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    Papa.parse(file, {
      header: true, skipEmptyLines: true,
      complete: (results) => processData(results.data, currentTab),
      error: (err) => alert('Error parsing file.\n' + err.message)
    });
    e.target.value = '';
  });

  // ── Finnhub API key ───────────────────────────────────────────────────────

  const finnhubKeyInput = document.getElementById('finnhub-key');
  const saveFinnhubBtn  = document.getElementById('save-finnhub-btn');

  if (finnhubKeyInput && localStorage.getItem('finnhub_api_key')) {
    finnhubKeyInput.value = localStorage.getItem('finnhub_api_key');
  }

  saveFinnhubBtn?.addEventListener('click', () => {
    const key = finnhubKeyInput?.value?.trim();
    if (key) {
      localStorage.setItem('finnhub_api_key', key);
      updateSourcePills();
      saveFinnhubBtn.textContent = '✓ Saved';
      setTimeout(() => { saveFinnhubBtn.textContent = 'Save Key'; }, 1500);
    } else {
      localStorage.removeItem('finnhub_api_key');
      updateSourcePills();
    }
  });

  // ── Clear all ────────────────────────────────────────────────────────────

  document.getElementById('clear-btn').addEventListener('click', () => {
    ['saved_csv_url', 'saved_realized_url', 'saved_snapshot_url', 'finnhub_api_key'].forEach(k => localStorage.removeItem(k));
    ['csv-url', 'realized-url', 'snapshot-url'].forEach(id => { document.getElementById(id).value = ''; });
    if (finnhubKeyInput) finnhubKeyInput.value = '';
    globalSnapshotData = null;
    selectedHistoryTickers.clear();
    updateSourcePills();
    alert('All links cleared. Resetting to demo data...');
    processData(Papa.parse(DEFAULT_CSV_DATA,      { header: true, skipEmptyLines: true }).data, 'active');
    processData(Papa.parse(DEFAULT_REALIZED_DATA, { header: true, skipEmptyLines: true }).data, 'realized');
    if (currentTab === 'history') renderHistoryTab();
  });

  // ── Refresh prices button ─────────────────────────────────────────────────

  const refreshBtn = document.getElementById('refresh-btn');
  if (refreshBtn) refreshBtn.addEventListener('click', refreshPrices);

  // ── Date range buttons ────────────────────────────────────────────────────

  document.querySelectorAll('.range-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('.range-btn').forEach(b => b.classList.remove('active'));
      e.currentTarget.classList.add('active');
      activeHistoryRange = e.currentTarget.dataset.range;
      if (currentTab === 'history') renderHistoryChart();
    });
  });

  // ── Table column sorting ──────────────────────────────────────────────────

  document.querySelectorAll('th.sortable').forEach(th => {
    th.addEventListener('click', (e) => {
      const column      = e.target.getAttribute('data-sort');
      const tableId     = e.target.closest('table').id;
      const isRealized  = tableId === 'table-realized';

      if (currentSort.column === column && currentSort.table === tableId) {
        currentSort.direction = currentSort.direction === 'asc' ? 'desc' : 'asc';
      } else {
        currentSort.column    = column;
        currentSort.direction = 'asc';
        currentSort.table     = tableId;
      }

      document.querySelectorAll(`#${tableId} th.sortable`).forEach(h => h.classList.remove('sort-asc', 'sort-desc'));
      e.target.classList.add(currentSort.direction === 'asc' ? 'sort-asc' : 'sort-desc');

      const dataTarget = isRealized ? globalRealizedData : globalActiveData;
      dataTarget.sort((a, b) => {
        let valA = a[column], valB = b[column];
        if (column === 'date') { valA = new Date(valA).getTime() || 0; valB = new Date(valB).getTime() || 0; }
        if (typeof valA === 'string' && typeof valB === 'string') {
          valA = valA.toLowerCase(); valB = valB.toLowerCase();
          if (valA < valB) return currentSort.direction === 'asc' ? -1 : 1;
          if (valA > valB) return currentSort.direction === 'asc' ?  1 : -1;
          return 0;
        }
        valA = valA || 0; valB = valB || 0;
        return currentSort.direction === 'asc' ? valA - valB : valB - valA;
      });

      renderTables(dataTarget, isRealized);
    });
  });

  // ── Initial data load ─────────────────────────────────────────────────────

  const savedActive   = localStorage.getItem('saved_csv_url');
  const savedRealized = localStorage.getItem('saved_realized_url');
  const savedSnapshot = localStorage.getItem('saved_snapshot_url');

  if (savedActive) {
    document.getElementById('csv-url').value = savedActive;
    fetchRemoteCSV(savedActive, 'active');
  } else {
    processData(Papa.parse(DEFAULT_CSV_DATA, { header: true, skipEmptyLines: true }).data, 'active', false);
  }

  if (savedRealized) {
    document.getElementById('realized-url').value = savedRealized;
    fetchRemoteCSV(savedRealized, 'realized');
  } else {
    processData(Papa.parse(DEFAULT_REALIZED_DATA, { header: true, skipEmptyLines: true }).data, 'realized', false);
  }

  if (savedSnapshot) {
    document.getElementById('snapshot-url').value = savedSnapshot;
    fetchRemoteCSV(savedSnapshot, 'snapshot');
  }
});

// ── Remote CSV Fetch ──────────────────────────────────────────────────────────

function fetchRemoteCSV(url, targetTab) {
  const loader = document.getElementById('loading');
  if (loader) {
    loader.querySelector('p').textContent = `Fetching ${targetTab.toUpperCase()} data...`;
    loader.classList.remove('hidden');
  }
  const liveUrl = url + (url.includes('?') ? '&' : '?') + 'nocache=' + Date.now();
  Papa.parse(liveUrl, {
    download: true, header: true, skipEmptyLines: true,
    complete: (results) => {
      if (results.data?.length > 0) {
        if (targetTab === 'snapshot') handleSnapshotData(results.data);
        else processData(results.data, targetTab);
      } else {
        if (loader) loader.classList.add('hidden');
        alert(`The CSV for ${targetTab} returned no valid rows.`);
      }
    },
    error: (error) => {
      if (loader) loader.classList.add('hidden');
      alert(`Error fetching ${targetTab} CSV.\n${error.message}`);
    }
  });
}

// ── Snapshot Data Handler ────────────────────────────────────────────────────

function handleSnapshotData(rows) {
  globalSnapshotData = processSnapshotData(rows);
  selectedHistoryTickers.clear();
  const loader = document.getElementById('loading');
  if (loader) loader.classList.add('hidden');
  if (currentTab === 'history') renderHistoryTab();
}

// Pivot flat CSV rows into { dates[], tickers[], series{}, prices{}, shares{} } for charting
function processSnapshotData(rows) {
  const dateMap    = {};
  const priceMap   = {};
  const sharesMap  = {};
  const tickerSet  = new Set();

  rows.forEach(row => {
    const date           = (findValue(row, ['date']) || '').trim();
    const ticker         = (findValue(row, ['ticker', 'symbol']) || '').trim().toUpperCase();
    const totalUSD       = parseNum(findValue(row, ['total value']));
    const portfolioTotal = parseNum(findValue(row, ['portfolio total']));
    const priceUSD       = parseNum(findValue(row, ['price usd', 'price', 'unit price', 'close price', 'close']));
    const sharesCount    = parseNum(findValue(row, ['shares', 'share', 'qty', 'quantity']));

    if (!date || !ticker) return;
    tickerSet.add(ticker);
    if (!dateMap[date])   dateMap[date]   = {};
    if (!priceMap[date])  priceMap[date]  = {};
    if (!sharesMap[date]) sharesMap[date] = {};

    dateMap[date][ticker]      = totalUSD;
    dateMap[date]['__TOTAL__'] = portfolioTotal;
    priceMap[date][ticker]     = priceUSD;
    sharesMap[date][ticker]    = sharesCount;
  });

  const dates   = Object.keys(dateMap).sort();
  const tickers = [...tickerSet].sort();

  const series = { '__TOTAL__': dates.map(d => dateMap[d]['__TOTAL__'] || 0) };
  tickers.forEach(t => { series[t] = dates.map(d => dateMap[d][t] || 0); });

  const prices = {};
  const shares = {};
  tickers.forEach(t => {
    prices[t] = dates.map(d => priceMap[d]?.[t]  || 0);
    shares[t] = dates.map(d => sharesMap[d]?.[t] || 0);
  });

  return { dates, tickers, series, prices, shares };
}

// Slice snapshot data to the selected date range
function filterByRange(data, range) {
  if (range === 'All' || !data.dates.length) return data;
  const now    = new Date();
  const cutoff = new Date(now);
  if (range === '1W') cutoff.setDate(now.getDate() - 7);
  else if (range === '1M') cutoff.setMonth(now.getMonth() - 1);
  else if (range === '3M') cutoff.setMonth(now.getMonth() - 3);

  const cutoffStr = cutoff.toISOString().split('T')[0];
  const indices   = data.dates.map((d, i) => d >= cutoffStr ? i : -1).filter(i => i >= 0);

  const sliceMap = (obj) => Object.fromEntries(
    Object.entries(obj || {}).map(([k, v]) => [k, indices.map(i => v[i])])
  );

  return {
    dates:   indices.map(i => data.dates[i]),
    tickers: data.tickers,
    series:  sliceMap(data.series),
    prices:  sliceMap(data.prices),
    shares:  sliceMap(data.shares),
  };
}

// ── Active Portfolio Data Processing ─────────────────────────────────────────

async function processData(data, targetTab, showLoader = true) {
  const loader = document.getElementById('loading');
  if (showLoader && loader) {
    loader.querySelector('p').textContent = `Processing ${targetTab.toUpperCase()} data...`;
    loader.classList.remove('hidden');
  }

  const processedData = [];

  // ── ACTIVE PORTFOLIO ──────────────────────────────────────────────────────
  if (targetTab === 'active') {
    const allTickers = data.map(row => {
      const rawTicker = findValue(row, ['ticker', 'symbol', 'name']) || 'UNKNOWN';
      const currency  = (findValue(row, ['currency', 'base']) || 'USD').trim().toUpperCase();
      return normalizeTicker(rawTicker, currency);
    });

    const pricesDict = await fetchLivePrices(allTickers);
    updateLastRefreshed();

    for (const row of data) {
      const rawTicker   = findValue(row, ['ticker', 'symbol', 'name']) || 'UNKNOWN';
      const rowCurrency = (findValue(row, ['currency', 'base']) || 'USD').trim().toUpperCase();
      const cleanTicker = normalizeTicker(rawTicker, rowCurrency);

      const shares     = parseNum(findValue(row, ['share', 'qty', 'quantity']));
      let totalCostVal = parseNum(findValue(row, ['total cost price', 'total cost value', 'total cost', 'cost price', 'purchase']));

      const dictData = pricesDict[cleanTicker];
      let dataSource = dictData?.source || (dictData?.price ? 'Yahoo' : 'Google');
      let mktPrice   = dictData?.price || 0;
      let stockName  = dictData?.name  || nameOf(cleanTicker);

      if (mktPrice === 0) {
        mktPrice   = parseNum(findValue(row, ['market price', 'current price', 'live price', 'googlefinance']));
        dataSource = 'Google';
      }

      if (rowCurrency === 'SGD' && currentSgdRate > 0) {
        totalCostVal /= currentSgdRate;
        mktPrice     /= currentSgdRate;
      }

      const costPrice  = shares > 0 ? totalCostVal / shares : 0;
      const totalMktVal = shares * mktPrice;
      const profit      = totalMktVal - totalCostVal;
      const profitPct   = totalCostVal > 0 ? (profit / totalCostVal) * 100 : 0;

      processedData.push({
        ticker: rawTicker, stockName,
        category: findValue(row, ['category', 'sector', 'type']) || 'Other',
        shares, costPrice, mktPrice, totalMktVal, profit, profitPct,
        source: dataSource, originalBase: rowCurrency
      });
    }

    globalActiveData = processedData;
    if (currentTab === 'active') renderDashboard();
  }

  // ── REALIZED HISTORY ──────────────────────────────────────────────────────
  else if (targetTab === 'realized') {
    for (const row of data) {
      const rawTicker   = findValue(row, ['ticker', 'symbol', 'name']) || 'UNKNOWN';
      const rowCurrency = (findValue(row, ['currency', 'base']) || 'USD').trim().toUpperCase();
      const stockName   = nameOf(normalizeTicker(rawTicker, rowCurrency));

      // 'type' is read separately so it doesn't bleed into the category lookup
      const rawType = findValue(row, ['type', 'return type', 'income type', 'transaction type']) || '';
      const type    = rawType.toLowerCase().includes('div') ? 'Dividend' : 'Trade';

      const category = findValue(row, ['category', 'sector']) || 'Other';
      const shares   = parseNum(findValue(row, ['share', 'qty', 'quantity']));
      const date     = findValue(row, ['date', 'closed', 'time']) || 'Historical';

      let totalBuyCost   = 0;
      let totalSellPrice = 0;
      let profit         = 0;
      let profitPct      = 0;

      if (type === 'Dividend') {
        // Dividend rows: profit = cash received, no buy/sell cost basis
        profit    = parseNum(findValue(row, ['profit', 'realized profit', 'dividend', 'income', 'payout', 'amount', 'cash']));
        profitPct = parseNum(findValue(row, ['% of profit', 'profit %', 'yield', 'yield %', 'return']));
      } else {
        // Trade rows: derive profit from buy/sell/commission
        totalBuyCost   = parseNum(findValue(row, ['total buy cost', 'buy cost', 'cost']));
        totalSellPrice = parseNum(findValue(row, ['total sell price', 'sell price', 'proceeds', 'sell']));
        const commission = parseNum(findValue(row, ['commission', 'fee']));

        profit = parseNum(findValue(row, ['profit', 'realized profit', 'profits']));
        if (profit === 0 && totalSellPrice > 0) profit = totalSellPrice - totalBuyCost - commission;

        profitPct = parseNum(findValue(row, ['% of profit', 'profit %', 'return', 'gain %', 'gain']));
        if (profitPct === 0 && totalBuyCost > 0) profitPct = (profit / totalBuyCost) * 100;
      }

      if (rowCurrency === 'SGD' && currentSgdRate > 0) {
        profit         /= currentSgdRate;
        totalBuyCost   /= currentSgdRate;
        totalSellPrice /= currentSgdRate;
      }

      processedData.push({
        date, ticker: rawTicker, stockName, category, type, shares,
        profit, profitPct,
        totalCost: totalBuyCost, totalSell: totalSellPrice,
        originalBase: rowCurrency
      });
    }

    globalRealizedData = processedData;
    if (currentTab === 'realized') renderDashboard();
  }

  if (loader) loader.classList.add('hidden');
}

// ── Dashboard Rendering ───────────────────────────────────────────────────────

function renderDashboard() {
  // When currency toggles on the history tab, just re-render the chart
  if (currentTab === 'history') { renderHistoryChart(); return; }

  const isRealized = currentTab === 'realized';
  const data = isRealized ? globalRealizedData : globalActiveData;

  const w1 = document.getElementById('widget-1');
  const w2 = document.getElementById('widget-2');
  const tradeBadgeEl = document.getElementById('trade-return-badge');

  const setBadge = (el, pct) => {
    el.textContent = `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
    el.style.backgroundColor = pct >= 0 ? 'rgba(16,185,129,0.1)' : 'rgba(239,68,68,0.1)';
    el.style.color = pct >= 0 ? 'var(--accent-green)' : 'var(--accent-red)';
  };

  if (isRealized) {
    // ── Split dividends vs closed trades ──────────────────────────────────
    let dividendTotal    = 0;
    let tradeProfitTotal = 0;
    let tradeCostTotal   = 0;
    data.forEach(item => {
      if (item.type === 'Dividend') {
        dividendTotal += item.profit || 0;
      } else {
        tradeProfitTotal += item.profit    || 0;
        tradeCostTotal   += item.totalCost || 0;
      }
    });
    const totalRealizedProfit = dividendTotal + tradeProfitTotal;
    const overallReturn = tradeCostTotal > 0 ? (totalRealizedProfit / tradeCostTotal) * 100 : 0;
    const tradeReturn   = tradeCostTotal > 0 ? (tradeProfitTotal    / tradeCostTotal) * 100 : 0;

    if (w1) w1.style.display = 'flex';
    if (w2) w2.style.display = 'flex';

    document.getElementById('title-val').textContent  = 'Total Realized P&L';
    document.getElementById('title-cost').textContent = 'Dividend Payout';
    document.getElementById('title-prof').textContent = 'Closed Trade P&L';

    const totalValEl = document.getElementById('total-value');
    totalValEl.textContent = formatCurrency(totalRealizedProfit);
    totalValEl.className   = `widget-value ${totalRealizedProfit >= 0 ? 'profit-positive' : 'profit-negative'}`;

    const totalCostEl = document.getElementById('total-cost');
    totalCostEl.textContent = formatCurrency(dividendTotal);
    totalCostEl.className   = `widget-value ${dividendTotal >= 0 ? 'profit-positive' : 'profit-negative'}`;

    const profitEl = document.getElementById('total-profit');
    profitEl.textContent = formatCurrency(tradeProfitTotal);
    profitEl.className   = `widget-value ${tradeProfitTotal >= 0 ? 'profit-positive' : 'profit-negative'}`;

    setBadge(document.getElementById('total-return-badge'), overallReturn);
    if (tradeBadgeEl) { tradeBadgeEl.style.display = 'inline-block'; setBadge(tradeBadgeEl, tradeReturn); }

  } else {
    // ── Active portfolio ───────────────────────────────────────────────────
    let totalGross = 0, totalCost = 0, totalProfitAgg = 0;
    data.forEach(item => {
      totalGross     += item.totalMktVal || 0;
      totalCost      += (item.totalMktVal - item.profit) || 0;
      totalProfitAgg += item.profit || 0;
    });
    const overallReturn = totalCost > 0 ? (totalProfitAgg / totalCost) * 100 : 0;

    if (w1) w1.style.display = 'flex';
    if (w2) w2.style.display = 'flex';

    document.getElementById('title-val').textContent  = 'Total Market Value';
    document.getElementById('title-cost').textContent = 'Total Cost Value';
    document.getElementById('title-prof').textContent = 'Unrealized Profit';

    const totalValEl = document.getElementById('total-value');
    totalValEl.textContent = formatCurrency(totalGross);
    totalValEl.className   = 'widget-value';

    document.getElementById('total-cost').textContent = formatCurrency(totalCost);
    document.getElementById('total-cost').className   = 'widget-value';

    const profitEl = document.getElementById('total-profit');
    profitEl.textContent = formatCurrency(totalProfitAgg);
    profitEl.className   = `widget-value ${totalProfitAgg >= 0 ? 'profit-positive' : 'profit-negative'}`;

    setBadge(document.getElementById('total-return-badge'), overallReturn);
    if (tradeBadgeEl) tradeBadgeEl.style.display = 'none';
  }

  const indicator = document.getElementById('data-source-indicator');
  if (indicator) {
    if (isRealized) {
      indicator.innerHTML = '● <span style="color:var(--accent-purple);">Offline Master Record</span>';
    } else {
      const usedFinnhub = data.some(i => i.source === 'Finnhub');
      const usedYahoo   = data.some(i => i.source === 'Yahoo');
      const usedGoogle  = data.some(i => i.source === 'Google');
      const parts = [];
      if (usedFinnhub) parts.push(`<span style="color:${SOURCE_COLORS.Finnhub};">Finnhub</span>`);
      if (usedYahoo)   parts.push(`<span style="color:${SOURCE_COLORS.Yahoo};">Yahoo Finance</span>`);
      if (usedGoogle)  parts.push(`<span style="color:${SOURCE_COLORS.Google};">Google (Fallback)</span>`);
      indicator.innerHTML = parts.length
        ? `● Data Source: ${parts.join(' & ')}`
        : '● System Output';
    }
  }

  renderTables(data, isRealized);
  try { renderChart(data, isRealized); } catch (e) { console.error('Chart error', e); }
}

// ── Table Rendering ───────────────────────────────────────────────────────────

function renderTables(data, isRealized) {
  const tableActive   = document.getElementById('table-active');
  const tableRealized = document.getElementById('table-realized');
  const headTitle     = document.getElementById('table-head-title');

  if (isRealized) {
    tableActive.classList.add('hidden');
    tableRealized.classList.remove('hidden');
    tableRealized.style.display = 'table';
    headTitle.textContent = 'Historical Closed Transactions';

    const tbody = document.getElementById('realized-body');
    tbody.innerHTML = '';
    data.forEach(item => {
      const pos   = item.profit >= 0;
      const cls   = pos ? 'profit-positive' : 'profit-negative';
      const sign  = pos ? '+' : '';
      const sgdBadge = item.originalBase === 'SGD'
        ? ' <span style="font-size:0.6rem;background:rgba(255,255,255,0.1);padding:2px 4px;border-radius:4px;color:#94a3b8;margin-left:4px;">SGD</span>'
        : '';
      const isDividend = item.type === 'Dividend';
      const typeBadge  = `<span class="type-badge ${isDividend ? 'dividend' : 'trade'}">${isDividend ? 'Dividend' : 'Trade'}</span>`;
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="mobile-date">${item.date}</td>
        <td class="ticker-cell"><div style="display:flex;flex-direction:column;">
          <span style="font-weight:600;color:var(--text-primary);font-size:0.95rem;">${item.stockName}</span>
          <span style="font-size:0.7rem;color:var(--text-secondary);opacity:0.8;">${item.ticker}${sgdBadge}</span>
        </div></td>
        <td data-label="Category"><span class="category-badge">${item.category}</span></td>
        <td data-label="Type">${typeBadge}</td>
        <td data-label="P&amp;L" class="${cls}">${sign}${formatCurrency(item.profit || 0)}</td>
        <td data-label="Return" class="${cls}">${sign}${(item.profitPct || 0).toFixed(2)}%</td>
      `;
      tbody.appendChild(tr);
    });
  } else {
    tableRealized.classList.add('hidden');
    tableActive.classList.remove('hidden');
    tableActive.style.display = 'table';
    headTitle.textContent = 'Live Holdings Breakdown';

    const tbody = document.getElementById('holdings-body');
    tbody.innerHTML = '';
    data.forEach(item => {
      const pos  = item.profit >= 0;
      const cls  = pos ? 'profit-positive' : 'profit-negative';
      const sign = pos ? '+' : '';
      const sgdBadge = item.originalBase === 'SGD'
        ? ' <span style="font-size:0.6rem;background:rgba(255,255,255,0.1);padding:2px 4px;border-radius:4px;color:#94a3b8;margin-left:4px;">SGD</span>'
        : '';
      const srcColor = SOURCE_COLORS[item.source] || 'var(--accent-red)';
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="ticker-cell"><div style="display:flex;flex-direction:column;">
          <span style="font-weight:600;color:var(--text-primary);font-size:0.95rem;">${item.stockName}</span>
          <span style="font-size:0.7rem;color:var(--text-secondary);opacity:0.8;">${item.ticker}${sgdBadge}</span>
        </div></td>
        <td data-label="Category"><span class="category-badge">${item.category}</span></td>
        <td data-label="Shares">${item.shares.toLocaleString()}</td>
        <td data-label="Cost / Share">${formatCurrency(item.costPrice)}</td>
        <td data-label="Mkt Price">${formatCurrency(item.mktPrice)} <span style="font-size:0.60rem;color:${srcColor};display:block;">${item.source}</span></td>
        <td data-label="Market Value">${formatCurrency(item.totalMktVal)}</td>
        <td data-label="P&amp;L" class="${cls}">${sign}${formatCurrency(item.profit)}</td>
        <td data-label="Return" class="${cls}">${sign}${item.profitPct.toFixed(2)}%</td>
      `;
      tbody.appendChild(tr);
    });
  }
}

// ── Allocation Chart ──────────────────────────────────────────────────────────

function renderChart(data, isRealized) {
  if (typeof Chart === 'undefined') return;

  const allocations = {};
  data.forEach(item => {
    if (!allocations[item.category]) allocations[item.category] = 0;
    const rawVal = isRealized ? (item.totalSell || Math.abs(item.profit)) : item.totalMktVal;
    allocations[item.category] += toDisplayCurrency(rawVal);
  });

  const labels = Object.keys(allocations);
  const values = Object.values(allocations);

  const canvas = document.getElementById('allocationChart');
  if (!canvas) return;
  if (allocationChartInstance) allocationChartInstance.destroy();

  const palette = isRealized
    ? ['#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#06b6d4', '#6366f1']
    : ['#06b6d4', '#8b5cf6', '#10b981', '#3b82f6', '#f59e0b', '#ec4899'];

  allocationChartInstance = new Chart(canvas.getContext('2d'), {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{ data: values, backgroundColor: palette.slice(0, Math.min(labels.length, palette.length)), borderWidth: 0, hoverOffset: 4 }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: '75%',
      plugins: {
        legend: { position: 'bottom', labels: { padding: 20, usePointStyle: true, pointStyle: 'circle' } },
        tooltip: {
          backgroundColor: 'rgba(15,23,42,0.9)', titleColor: '#fff', bodyColor: '#e2e8f0',
          borderColor: 'rgba(255,255,255,0.1)', borderWidth: 1, padding: 12,
          callbacks: {
            label: (ctx) => ` ${ctx.label}: ${new Intl.NumberFormat('en-US', { style: 'currency', currency: activeCurrency, minimumFractionDigits: 2 }).format(ctx.raw)}`
          }
        }
      }
    }
  });
}

// ── History Tab ───────────────────────────────────────────────────────────────

function renderHistoryTab() {
  const hasData = globalSnapshotData && globalSnapshotData.dates.length > 0;

  document.getElementById('history-chart-section').classList.toggle('hidden', !hasData);
  document.getElementById('history-empty').classList.toggle('hidden', hasData);

  if (!hasData) return;

  renderTickerFilter();
  renderHistoryChart();
}

function renderTickerFilter() {
  const container = document.getElementById('ticker-filter');
  if (!container || !globalSnapshotData) return;
  container.innerHTML = '';

  const select = document.createElement('select');
  select.id        = 'ticker-select';
  select.className = 'ticker-select';

  const totalOpt = document.createElement('option');
  totalOpt.value       = '__TOTAL__';
  totalOpt.textContent = 'Total Portfolio';
  select.appendChild(totalOpt);

  globalSnapshotData.tickers.forEach(ticker => {
    const opt = document.createElement('option');
    opt.value       = ticker;
    opt.textContent = ticker;
    select.appendChild(opt);
  });

  // Restore previous single selection
  const prev = [...selectedHistoryTickers][0];
  if (prev) select.value = prev;

  select.addEventListener('change', () => {
    selectedHistoryTickers.clear();
    if (select.value !== '__TOTAL__') selectedHistoryTickers.add(select.value);
    renderHistoryChart();
  });

  container.appendChild(select);
}

function renderHistoryChart() {
  if (typeof Chart === 'undefined' || !globalSnapshotData) return;

  const filtered = filterByRange(globalSnapshotData, activeHistoryRange);
  const canvas   = document.getElementById('historyChart');
  if (!canvas) return;

  if (historyChartInstance) historyChartInstance.destroy();

  // Single-select: show only the chosen ticker (or total portfolio)
  const selectedTicker = [...selectedHistoryTickers][0] || null;
  const seriesKey  = selectedTicker || '__TOTAL__';
  const seriesData = filtered.series[seriesKey] || [];
  const label      = selectedTicker || 'Total Portfolio';
  const color      = selectedTicker
    ? CHART_COLORS[globalSnapshotData.tickers.indexOf(selectedTicker) % CHART_COLORS.length]
    : '#06b6d4';

  // Day-over-day % change (null for first data point)
  const pctChanges = seriesData.map((v, i) => {
    if (i === 0) return null;
    const prev = seriesData[i - 1];
    return prev > 0 ? ((v - prev) / prev) * 100 : null;
  });

  // Per-date stock price and share count (only meaningful when a ticker is selected)
  const pricesAtDate = selectedTicker ? (filtered.prices?.[selectedTicker] || []) : [];
  const sharesAtDate = selectedTicker ? (filtered.shares?.[selectedTicker] || []) : [];

  historyChartInstance = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels: filtered.dates,
      datasets: [{
        label,
        data: seriesData,
        borderColor: color,
        backgroundColor: selectedTicker ? 'transparent' : `${color}0f`,
        borderWidth: selectedTicker ? 2 : 3,
        pointRadius: 3,
        pointHoverRadius: 6,
        tension: 0.3,
        fill: !selectedTicker
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: {
          position: 'top',
          labels: { usePointStyle: true, pointStyle: 'circle', padding: 20 }
        },
        tooltip: {
          backgroundColor: 'rgba(15,23,42,0.95)',
          titleColor: '#fff',
          bodyColor: '#e2e8f0',
          borderColor: 'rgba(255,255,255,0.1)',
          borderWidth: 1,
          padding: 14,
          callbacks: {
            label: (ctx) => {
              const idx   = ctx.dataIndex;
              const pct   = pctChanges[idx];
              const lines = [` ${ctx.dataset.label}: ${formatCurrency(ctx.raw)}`];

              if (pct !== null) {
                const arrow = pct >= 0 ? '▲' : '▼';
                lines.push(` ${arrow} ${pct >= 0 ? '+' : ''}${pct.toFixed(2)}% vs prev day`);
              }

              const price  = pricesAtDate[idx];
              const shares = sharesAtDate[idx];
              if (price  > 0) lines.push(` Stock Price : ${formatCurrency(price)}`);
              if (shares > 0) lines.push(` Shares Held : ${shares.toLocaleString()}`);

              return lines;
            }
          }
        }
      },
      scales: {
        x: {
          grid: { color: 'rgba(255,255,255,0.03)' },
          ticks: { color: '#94a3b8', maxTicksLimit: 10, maxRotation: 0 }
        },
        y: {
          grid: { color: 'rgba(255,255,255,0.05)' },
          ticks: { color: '#94a3b8', callback: (val) => formatAxisValue(val) }
        }
      }
    }
  });

  renderHistoryMetrics(seriesData, pctChanges, color);
}

function renderHistoryMetrics(seriesData, pctChanges, color) {
  const container = document.getElementById('history-metrics');
  if (!container) return;

  const n = seriesData.length;
  if (n < 2) { container.innerHTML = ''; return; }

  const firstVal  = seriesData.find(v => v > 0) || seriesData[0];
  const lastVal   = seriesData[n - 1];
  const periodPct = firstVal > 0 ? ((lastVal - firstVal) / firstVal) * 100 : null;
  const lastPct   = pctChanges[n - 1];

  const fmtPct = (pct) => {
    if (pct === null || isNaN(pct)) return '–';
    return `${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`;
  };
  const cls = (pct) => (pct === null || isNaN(pct)) ? '' : pct >= 0 ? 'metric-positive' : 'metric-negative';

  container.innerHTML = `
    <div class="history-metric-item">
      <span class="history-metric-label">Period Return</span>
      <span class="history-metric-value ${cls(periodPct)}">${fmtPct(periodPct)}</span>
    </div>
    <div class="history-metric-item">
      <span class="history-metric-label">Last Day Change</span>
      <span class="history-metric-value ${cls(lastPct)}">${fmtPct(lastPct)}</span>
    </div>
    <div class="history-metric-item">
      <span class="history-metric-label">Current Value</span>
      <span class="history-metric-value" style="color:${color}">${formatCurrency(lastVal)}</span>
    </div>
  `;
}
