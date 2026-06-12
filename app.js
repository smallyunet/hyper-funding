const API_URL = "https://api.hyperliquid.xyz/info";
const REFRESH_MS = 30_000;
const HOURS_PER_YEAR = 24 * 365;
const HISTORY_CACHE_PREFIX = "hyperFunding.history.v1";
const HISTORY_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const HISTORY_CONCURRENCY = 3;

const state = {
  rows: [],
  filteredRows: [],
  analysisRows: [],
  direction: "all",
  sort: "funding-desc",
  search: "",
  minVolume: 0,
  minOi: 0,
  loading: false,
  analyzing: false,
  refreshTimer: null,
};

const elements = {
  status: document.getElementById("connectionStatus"),
  statusText: document.getElementById("statusText"),
  refreshButton: document.getElementById("refreshButton"),
  marketCount: document.getElementById("marketCount"),
  updatedAt: document.getElementById("updatedAt"),
  highestFunding: document.getElementById("highestFunding"),
  highestSymbol: document.getElementById("highestSymbol"),
  lowestFunding: document.getElementById("lowestFunding"),
  lowestSymbol: document.getElementById("lowestSymbol"),
  directionSplit: document.getElementById("directionSplit"),
  searchInput: document.getElementById("searchInput"),
  sortSelect: document.getElementById("sortSelect"),
  minVolumeInput: document.getElementById("minVolumeInput"),
  minOiInput: document.getElementById("minOiInput"),
  fundingRows: document.getElementById("fundingRows"),
  resultCount: document.getElementById("resultCount"),
  exportButton: document.getElementById("exportButton"),
  autoRefreshToggle: document.getElementById("autoRefreshToggle"),
  historyWindowSelect: document.getElementById("historyWindowSelect"),
  analysisLimitSelect: document.getElementById("analysisLimitSelect"),
  analyzeTopButton: document.getElementById("analyzeTopButton"),
  clearHistoryCacheButton: document.getElementById("clearHistoryCacheButton"),
  analysisStatus: document.getElementById("analysisStatus"),
  analysisRows: document.getElementById("analysisRows"),
  analyzedCount: document.getElementById("analyzedCount"),
  bestScore: document.getElementById("bestScore"),
  bestScoreSymbol: document.getElementById("bestScoreSymbol"),
  bestAvgApr: document.getElementById("bestAvgApr"),
  bestAvgAprSymbol: document.getElementById("bestAvgAprSymbol"),
  directionButtons: [...document.querySelectorAll("[data-direction]")],
};

async function fetchMarkets() {
  if (state.loading) return;
  setLoading(true);

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "metaAndAssetCtxs", dex: "xyz" }),
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const [meta, contexts] = await response.json();
    state.rows = normalizeRows(meta?.universe ?? [], contexts ?? []);
    setStatus("ready", "Live");
    render();
  } catch (error) {
    console.error(error);
    setStatus("error", "API error");
    renderError("Failed to load Hyperliquid market data");
  } finally {
    setLoading(false);
  }
}

function normalizeRows(universe, contexts) {
  return universe
    .map((asset, index) => {
      const context = contexts[index] ?? {};
      const funding = toNumber(context.funding);
      const mark = toNumber(context.markPx);
      const oracle = toNumber(context.oraclePx);
      const volume = toNumber(context.dayNtlVlm);
      const openInterest = toNumber(context.openInterest);
      const premium = toNumber(context.premium);
      const basis = mark && oracle ? (mark - oracle) / oracle : premium;

      return {
        symbol: asset.name,
        displaySymbol: asset.name.replace("xyz:", ""),
        funding,
        apr: funding * HOURS_PER_YEAR,
        mark,
        oracle,
        basis,
        openInterest,
        volume,
        maxLeverage: asset.maxLeverage,
      };
    })
    .filter((row) => Number.isFinite(row.funding));
}

function render() {
  const rows = applyFiltersAndSort();
  state.filteredRows = rows;
  renderMetrics(state.rows);
  renderTable(rows);
  renderAnalysis();
}

function applyFiltersAndSort() {
  const query = state.search.trim().toLowerCase();
  const rows = state.rows.filter((row) => {
    if (query && !row.symbol.toLowerCase().includes(query)) return false;
    if (state.direction === "positive" && row.funding <= 0) return false;
    if (state.direction === "negative" && row.funding >= 0) return false;
    if (row.volume < state.minVolume) return false;
    if (row.openInterest < state.minOi) return false;
    return true;
  });

  const [field, direction] = state.sort.split("-");
  const directionFactor = direction === "asc" ? 1 : -1;
  const fieldMap = {
    funding: "funding",
    apr: "apr",
    volume: "volume",
    oi: "openInterest",
    basis: "basis",
  };
  const key = fieldMap[field] ?? "funding";

  return rows.sort((a, b) => {
    const aValue = Number.isFinite(a[key]) ? a[key] : -Infinity;
    const bValue = Number.isFinite(b[key]) ? b[key] : -Infinity;
    return (aValue - bValue) * directionFactor;
  });
}

function renderMetrics(rows) {
  const positiveCount = rows.filter((row) => row.funding > 0).length;
  const negativeCount = rows.filter((row) => row.funding < 0).length;
  const sorted = [...rows].sort((a, b) => b.funding - a.funding);
  const highest = sorted[0];
  const lowest = sorted[sorted.length - 1];

  elements.marketCount.textContent = rows.length ? rows.length.toString() : "--";
  elements.updatedAt.textContent = rows.length ? `Updated ${formatTime(new Date())}` : "--";
  elements.highestFunding.textContent = highest ? formatPercent(highest.funding) : "--";
  elements.highestSymbol.textContent = highest?.symbol ?? "--";
  elements.lowestFunding.textContent = lowest ? formatPercent(lowest.funding) : "--";
  elements.lowestSymbol.textContent = lowest?.symbol ?? "--";
  elements.directionSplit.textContent = rows.length ? `${positiveCount} / ${negativeCount}` : "--";
}

function renderTable(rows) {
  elements.resultCount.textContent = `${rows.length} rows`;

  if (!rows.length) {
    elements.fundingRows.innerHTML = `<tr><td colspan="10" class="empty-cell">No markets match the current filters</td></tr>`;
    return;
  }

  elements.fundingRows.innerHTML = rows
    .map((row) => {
      const tone = row.funding >= 0 ? "positive" : "negative";
      return `
        <tr>
          <td>
            <div class="symbol-cell">
              <span class="symbol-chip">XYZ</span>
              <span>${escapeHtml(row.displaySymbol)}</span>
            </div>
          </td>
          <td class="num"><span class="tone-pill ${tone}">${formatPercent(row.funding)}</span></td>
          <td class="num ${tone}">${formatPercent(row.apr)}</td>
          <td class="num">${formatNumber(row.mark, 4)}</td>
          <td class="num">${formatNumber(row.oracle, 4)}</td>
          <td class="num ${row.basis >= 0 ? "positive" : "negative"}">${formatPercent(row.basis)}</td>
          <td class="num">${formatCompact(row.openInterest)}</td>
          <td class="num">${formatUsd(row.volume)}</td>
          <td class="num">${row.maxLeverage ? `${row.maxLeverage}x` : "--"}</td>
          <td class="num"><button class="mini-button" type="button" data-analyze-symbol="${escapeHtml(row.symbol)}">Analyze</button></td>
        </tr>
      `;
    })
    .join("");
}

function renderError(message) {
  elements.fundingRows.innerHTML = `<tr><td colspan="10" class="empty-cell">${escapeHtml(message)}</td></tr>`;
}

function renderAnalysis() {
  const rows = [...state.analysisRows].sort((a, b) => b.score - a.score);
  const bestScore = rows[0];
  const bestApr = [...rows].sort((a, b) => Math.abs(b.avgApr) - Math.abs(a.avgApr))[0];

  elements.analyzedCount.textContent = rows.length ? rows.length.toString() : "--";
  elements.bestScore.textContent = bestScore ? bestScore.score.toFixed(1) : "--";
  elements.bestScoreSymbol.textContent = bestScore?.symbol ?? "--";
  elements.bestAvgApr.textContent = bestApr ? formatPercent(bestApr.avgApr) : "--";
  elements.bestAvgAprSymbol.textContent = bestApr?.symbol ?? "--";

  if (!rows.length) {
    elements.analysisRows.innerHTML = `<tr><td colspan="8" class="empty-cell">Run history analysis from the controls above or a table row</td></tr>`;
    return;
  }

  elements.analysisRows.innerHTML = rows
    .map((row) => {
      const tone = row.avgFunding >= 0 ? "positive" : "negative";
      return `
        <tr>
          <td>
            <div class="symbol-cell">
              <span class="symbol-chip">XYZ</span>
              <span>${escapeHtml(row.displaySymbol)}</span>
            </div>
          </td>
          <td class="num">${row.score.toFixed(1)}</td>
          <td class="num ${tone}">${formatPercent(row.avgFunding)}</td>
          <td class="num ${tone}">${formatPercent(row.avgApr)}</td>
          <td class="num">${formatPercent(row.volatility)}</td>
          <td class="num">${formatPercent(row.directionHitRate)}</td>
          <td class="num">${row.positiveCount} / ${row.negativeCount}</td>
          <td class="num">${row.samples}</td>
        </tr>
      `;
    })
    .join("");
}

async function analyzeTopMarkets() {
  const limit = Number(elements.analysisLimitSelect.value) || 10;
  const symbols = state.filteredRows.slice(0, limit).map((row) => row.symbol);
  await analyzeSymbols(symbols);
}

async function analyzeSymbols(symbols) {
  const uniqueSymbols = [...new Set(symbols)].filter(Boolean);
  if (!uniqueSymbols.length || state.analyzing) return;

  state.analyzing = true;
  elements.analyzeTopButton.disabled = true;
  setAnalysisStatus(`Analyzing 0 / ${uniqueSymbols.length}`);

  const days = Number(elements.historyWindowSelect.value) || 7;
  const results = [];
  let completed = 0;

  try {
    for (let index = 0; index < uniqueSymbols.length; index += HISTORY_CONCURRENCY) {
      const batch = uniqueSymbols.slice(index, index + HISTORY_CONCURRENCY);
      const batchResults = await Promise.all(
        batch.map(async (symbol) => {
          try {
            const history = await fetchFundingHistory(symbol, days);
            return summarizeFundingHistory(symbol, history);
          } catch (error) {
            console.error(error);
            return null;
          } finally {
            completed += 1;
            setAnalysisStatus(`Analyzing ${completed} / ${uniqueSymbols.length}`);
          }
        }),
      );
      results.push(...batchResults);
    }

    const validResults = results.filter(Boolean);
    mergeAnalysisRows(validResults);
    setAnalysisStatus(`Analyzed ${validResults.length} market(s), ${days}d window`);
  } catch (error) {
    console.error(error);
    setAnalysisStatus("History analysis failed");
  } finally {
    state.analyzing = false;
    elements.analyzeTopButton.disabled = false;
    renderAnalysis();
  }
}

async function fetchFundingHistory(symbol, days) {
  const cacheKey = getHistoryCacheKey(symbol, days);
  const cached = readHistoryCache(cacheKey);
  if (cached) return cached;

  const endTime = Date.now();
  const startTime = endTime - days * 24 * 60 * 60 * 1000;
  const response = await fetch(API_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "fundingHistory",
      coin: symbol,
      startTime,
      endTime,
    }),
  });

  if (!response.ok) {
    throw new Error(`History ${symbol} failed with HTTP ${response.status}`);
  }

  const history = await response.json();
  writeHistoryCache(cacheKey, history);
  return history;
}

function summarizeFundingHistory(symbol, history) {
  const values = history.map((item) => Number(item.fundingRate)).filter(Number.isFinite);
  if (!values.length) return null;

  const avgFunding = mean(values);
  const volatility = standardDeviation(values, avgFunding);
  const avgApr = avgFunding * HOURS_PER_YEAR;
  const direction = avgFunding >= 0 ? 1 : -1;
  const positiveCount = values.filter((value) => value > 0).length;
  const negativeCount = values.filter((value) => value < 0).length;
  const directionHits = values.filter((value) => Math.sign(value || direction) === direction).length;
  const directionHitRate = directionHits / values.length;
  const stability = Math.abs(avgFunding) / (Math.abs(avgFunding) + volatility || 1);
  const score = Math.min(100, Math.abs(avgApr) * 100 * directionHitRate * stability);

  return {
    symbol,
    displaySymbol: symbol.replace("xyz:", ""),
    avgFunding,
    avgApr,
    volatility,
    directionHitRate,
    positiveCount,
    negativeCount,
    samples: values.length,
    score,
  };
}

function mergeAnalysisRows(rows) {
  const existing = new Map(state.analysisRows.map((row) => [row.symbol, row]));
  rows.forEach((row) => existing.set(row.symbol, row));
  state.analysisRows = [...existing.values()];
}

function setAnalysisStatus(text) {
  elements.analysisStatus.textContent = text;
}

function getHistoryCacheKey(symbol, days) {
  return `${HISTORY_CACHE_PREFIX}.${days}.${symbol}`;
}

function readHistoryCache(key) {
  try {
    const cached = JSON.parse(localStorage.getItem(key) || "null");
    if (!cached || Date.now() - cached.savedAt > HISTORY_CACHE_TTL_MS) return null;
    return cached.data;
  } catch {
    return null;
  }
}

function writeHistoryCache(key, data) {
  try {
    localStorage.setItem(key, JSON.stringify({ savedAt: Date.now(), data }));
  } catch {
    // Cache is best-effort only; analysis still works without it.
  }
}

function clearHistoryCache() {
  Object.keys(localStorage)
    .filter((key) => key.startsWith(HISTORY_CACHE_PREFIX))
    .forEach((key) => localStorage.removeItem(key));
  setAnalysisStatus("History cache cleared");
}

function setStatus(type, text) {
  elements.status.classList.remove("ready", "error");
  if (type) elements.status.classList.add(type);
  elements.statusText.textContent = text;
}

function setLoading(isLoading) {
  state.loading = isLoading;
  elements.refreshButton.classList.toggle("loading", isLoading);
  elements.refreshButton.disabled = isLoading;
  if (isLoading) setStatus("", "Refreshing");
}

function scheduleRefresh() {
  clearInterval(state.refreshTimer);
  if (!elements.autoRefreshToggle.checked) return;
  state.refreshTimer = setInterval(fetchMarkets, REFRESH_MS);
}

function exportCsv() {
  const header = [
    "symbol",
    "funding_per_hour",
    "apr_estimate",
    "mark",
    "oracle",
    "basis",
    "open_interest",
    "day_volume",
    "max_leverage",
  ];
  const lines = state.filteredRows.map((row) =>
    [
      row.symbol,
      row.funding,
      row.apr,
      row.mark,
      row.oracle,
      row.basis,
      row.openInterest,
      row.volume,
      row.maxLeverage,
    ].join(","),
  );
  const csv = [header.join(","), ...lines].join("\n");
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `hyper-funding-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardDeviation(values, avg) {
  const variance = values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function formatPercent(value) {
  if (!Number.isFinite(value)) return "--";
  return `${(value * 100).toFixed(Math.abs(value) < 0.0001 ? 5 : 4)}%`;
}

function formatNumber(value, decimals = 2) {
  if (!Number.isFinite(value)) return "--";
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: decimals,
  }).format(value);
}

function formatCompact(value) {
  if (!Number.isFinite(value)) return "--";
  return new Intl.NumberFormat("en-US", {
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(value);
}

function formatUsd(value) {
  if (!Number.isFinite(value)) return "--";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(value);
}

function formatTime(date) {
  return new Intl.DateTimeFormat("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    const entities = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;",
    };
    return entities[char];
  });
}

elements.refreshButton.addEventListener("click", fetchMarkets);
elements.exportButton.addEventListener("click", exportCsv);
elements.analyzeTopButton.addEventListener("click", analyzeTopMarkets);
elements.clearHistoryCacheButton.addEventListener("click", clearHistoryCache);
elements.autoRefreshToggle.addEventListener("change", scheduleRefresh);
elements.fundingRows.addEventListener("click", (event) => {
  const button = event.target.closest("[data-analyze-symbol]");
  if (!button) return;
  analyzeSymbols([button.dataset.analyzeSymbol]);
});
elements.sortSelect.addEventListener("change", (event) => {
  state.sort = event.target.value;
  render();
});
elements.historyWindowSelect.addEventListener("change", () => {
  state.analysisRows = [];
  setAnalysisStatus("Window changed; run analysis again");
  renderAnalysis();
});
elements.searchInput.addEventListener("input", (event) => {
  state.search = event.target.value;
  render();
});
elements.minVolumeInput.addEventListener("input", (event) => {
  state.minVolume = Number(event.target.value) || 0;
  render();
});
elements.minOiInput.addEventListener("input", (event) => {
  state.minOi = Number(event.target.value) || 0;
  render();
});
elements.directionButtons.forEach((button) => {
  button.addEventListener("click", () => {
    state.direction = button.dataset.direction;
    elements.directionButtons.forEach((item) => item.classList.toggle("active", item === button));
    render();
  });
});

fetchMarkets();
scheduleRefresh();
