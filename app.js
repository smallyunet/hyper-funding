const API_URL = "https://api.hyperliquid.xyz/info";
const REFRESH_MS = 30_000;
const HOURS_PER_YEAR = 24 * 365;
const HISTORY_CACHE_PREFIX = "hyperFunding.history.v1";
const HISTORY_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const HISTORY_CONCURRENCY = 3;
const FUNDING_HISTORY_CHUNK_HOURS = 480;
const FUNDING_HISTORY_STEP_MS = 60 * 60 * 1000;

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
  selectedSymbol: null,
  chartInstance: null,
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
  analysisProgressWrapper: document.getElementById("analysisProgressWrapper"),
  analysisProgressBar: document.getElementById("analysisProgressBar"),
  analysisRows: document.getElementById("analysisRows"),
  analyzedCount: document.getElementById("analyzedCount"),
  bestScore: document.getElementById("bestScore"),
  bestScoreSymbol: document.getElementById("bestScoreSymbol"),
  bestAvgApr: document.getElementById("bestAvgApr"),
  bestAvgAprSymbol: document.getElementById("bestAvgAprSymbol"),
  directionButtons: [...document.querySelectorAll("[data-direction]")],
  
  // Navigation Tabs
  tabMarkets: document.getElementById("tabMarkets"),
  tabAnalytics: document.getElementById("tabAnalytics"),
  viewMarketBoard: document.getElementById("viewMarketBoard"),
  viewBatchAnalytics: document.getElementById("viewBatchAnalytics"),
  
  // Asset Detail elements
  detailPanelContent: document.getElementById("detailPanelContent"),
  detailEmptyState: document.getElementById("detailEmptyState"),
  detailHistoryWindowSelect: document.getElementById("detailHistoryWindowSelect"),
};

async function fetchMarkets() {
  if (state.loading) return;
  setLoading(true);
  elements.analyzeTopButton.disabled = true;

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
    elements.analyzeTopButton.disabled = state.analyzing || !state.filteredRows.length;
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
  elements.analyzeTopButton.disabled = state.analyzing || !rows.length;
  
  // UX Optimization: Auto-select the first market on initial load
  if (!state.selectedSymbol && rows.length > 0) {
    selectSymbol(rows[0].symbol);
  } else if (state.selectedSymbol) {
    // Keep live metrics fresh on auto-refresh
    updateDetailPanelLiveMetrics(state.selectedSymbol);
  }

  updateAnalysisStatusDescription();
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
  elements.highestFunding.textContent = highest ? `${highest.funding >= 0 ? '+' : ''}${formatPercent(highest.funding)}` : "--";
  elements.highestSymbol.textContent = highest?.displaySymbol ?? "--";
  elements.lowestFunding.textContent = lowest ? formatPercent(lowest.funding) : "--";
  elements.lowestSymbol.textContent = lowest?.displaySymbol ?? "--";
  elements.directionSplit.textContent = rows.length ? `${positiveCount} / ${negativeCount}` : "--";
}

function renderTable(rows) {
  elements.resultCount.textContent = `${rows.length} rows`;

  if (!rows.length) {
    elements.fundingRows.innerHTML = `<tr><td colspan="9" class="empty-cell">No markets match the current filters</td></tr>`;
    return;
  }

  elements.fundingRows.innerHTML = rows
    .map((row) => {
      const tone = row.funding >= 0 ? "positive" : "negative";
      const isActive = row.symbol === state.selectedSymbol ? "active-row" : "";
      return `
        <tr data-symbol="${escapeHtml(row.symbol)}" class="${isActive}">
          <td>
            <div class="symbol-cell">
              <span class="symbol-chip">XYZ</span>
              <span>${escapeHtml(row.displaySymbol)}</span>
            </div>
          </td>
          <td class="num"><span class="tone-pill ${tone}">${row.funding >= 0 ? '+' : ''}${formatPercent(row.funding)}</span></td>
          <td class="num ${tone}">${row.apr >= 0 ? '+' : ''}${formatPercent(row.apr)}</td>
          <td class="num">${formatNumber(row.mark, 4)}</td>
          <td class="num ${row.basis >= 0 ? "positive" : "negative"}">${row.basis >= 0 ? '+' : ''}${formatPercent(row.basis)}</td>
          <td class="num">${formatCompact(row.openInterest)}</td>
          <td class="num">${formatUsd(row.volume)}</td>
          <td class="num">${row.maxLeverage ? `${row.maxLeverage}x` : "--"}</td>
        </tr>
      `;
    })
    .join("");
}

function renderError(message) {
  elements.fundingRows.innerHTML = `<tr><td colspan="9" class="empty-cell">${escapeHtml(message)}</td></tr>`;
}

function renderAnalysis() {
  const rows = [...state.analysisRows].sort((a, b) => b.score - a.score);
  const bestScore = rows[0];
  const bestApr = [...rows].sort((a, b) => Math.abs(b.avgApr) - Math.abs(a.avgApr))[0];

  elements.analyzedCount.textContent = rows.length ? rows.length.toString() : "--";
  elements.bestScore.textContent = bestScore ? bestScore.score.toFixed(1) : "--";
  elements.bestScoreSymbol.textContent = bestScore?.displaySymbol ?? "--";
  elements.bestAvgApr.textContent = bestApr ? `${bestApr.avgApr >= 0 ? '+' : ''}${formatPercent(bestApr.avgApr)}` : "--";
  elements.bestAvgAprSymbol.textContent = bestApr?.displaySymbol ?? "--";

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
          <td class="num"><strong style="color: var(--text-primary);">${row.score.toFixed(1)}</strong></td>
          <td class="num ${tone}">${row.avgFunding >= 0 ? '+' : ''}${formatPercent(row.avgFunding)}</td>
          <td class="num ${tone}">${row.avgApr >= 0 ? '+' : ''}${formatPercent(row.avgApr)}</td>
          <td class="num">${formatPercent(row.volatility)}</td>
          <td class="num">${formatPercent(row.directionHitRate)}</td>
          <td class="num">${row.positiveCount} / ${row.negativeCount}</td>
          <td class="num">${row.samples}</td>
        </tr>
      `;
    })
    .join("");
}

// Select a single symbol to show in the right-hand panel & render Chart
async function selectSymbol(symbol) {
  state.selectedSymbol = symbol;
  
  // Highlight active row in table
  document.querySelectorAll("#fundingRows tr").forEach(tr => {
    if (tr.dataset.symbol === symbol) {
      tr.classList.add("active-row");
    } else {
      tr.classList.remove("active-row");
    }
  });
  
  const row = state.rows.find(r => r.symbol === symbol);
  if (!row) return;
  
  // Render main details card header
  document.getElementById("detailSymbolName").textContent = row.displaySymbol;
  document.getElementById("detailLeverageText").textContent = `Max Leverage: ${row.maxLeverage ? row.maxLeverage + 'x' : '--'}`;
  
  // Live Metrics updates
  updateDetailPanelLiveMetrics(symbol);
  
  // Show detail content & hide empty state
  elements.detailPanelContent.classList.remove("hidden");
  elements.detailEmptyState.classList.add("hidden");
  
  // Fetch and load historical chart
  const windowDays = Number(elements.detailHistoryWindowSelect.value) || 7;
  await loadHistoryData(symbol, windowDays);
}

// Update live metrics on the detail card without refreshing graph
function updateDetailPanelLiveMetrics(symbol) {
  const row = state.rows.find(r => r.symbol === symbol);
  if (!row) return;
  
  document.getElementById("detailCurrentPrice").textContent = `$${formatNumber(row.mark, 4)}`;
  
  const fundingEl = document.getElementById("detailCurrentFunding");
  fundingEl.textContent = `${row.funding >= 0 ? '+' : ''}${formatPercent(row.funding)} / hr`;
  fundingEl.className = `detail-funding-pill ${row.funding >= 0 ? 'positive' : 'negative'}`;
  
  document.getElementById("detailVolume").textContent = formatUsd(row.volume);
  document.getElementById("detailOi").textContent = formatCompact(row.openInterest);
  document.getElementById("detailBasis").textContent = `${row.basis >= 0 ? '+' : ''}${formatPercent(row.basis)}`;
}

// Fetch historical rates, calculate analytics summary, and render line graph
async function loadHistoryData(symbol, days) {
  const chartContainer = document.querySelector(".chart-container");
  chartContainer.style.opacity = "0.6";
  chartContainer.classList.add("is-loading");
  
  try {
    const history = await fetchFundingHistory(symbol, days);
    const stats = summarizeFundingHistory(symbol, history);
    
    if (!stats) throw new Error("No historical rates");
    
    // Update analytics cards
    document.getElementById("detailScore").textContent = stats.score.toFixed(1);
    
    const avgFundingEl = document.getElementById("detailAvgFunding");
    avgFundingEl.textContent = `${stats.avgFunding >= 0 ? '+' : ''}${formatPercent(stats.avgFunding)}`;
    avgFundingEl.className = stats.avgFunding >= 0 ? "positive" : "negative";
    
    const avgAprEl = document.getElementById("detailAvgApr");
    avgAprEl.textContent = `${stats.avgApr >= 0 ? '+' : ''}${formatPercent(stats.avgApr)}`;
    avgAprEl.className = stats.avgApr >= 0 ? "positive" : "negative";
    
    document.getElementById("detailVolatility").textContent = formatPercent(stats.volatility);
    document.getElementById("detailPosRatio").textContent = `${stats.positiveCount} / ${stats.negativeCount}`;
    document.getElementById("detailSamplesCount").textContent = `${stats.samples} hourly samples`;
    document.getElementById("detailHitRate").textContent = formatPercent(stats.directionHitRate);
    
    // Process points for line chart
    const chartPoints = history.map(item => ({
      x: new Date(item.time),
      y: Number(item.fundingRate) * 100 // convert to percentage
    })).sort((a, b) => a.x - b.x);
    
    const labels = chartPoints.map(p => {
      const d = p.x;
      return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:00`;
    });
    const rates = chartPoints.map(p => p.y);
    
    updateChart(labels, rates, stats.avgFunding);
  } catch (error) {
    console.error("Failed to load historical data", error);
  } finally {
    chartContainer.style.opacity = "1";
    chartContainer.classList.remove("is-loading");
  }
}

// Render line chart with area gradient matching rate tone
function updateChart(labels, data, avgFundingRate) {
  const canvas = document.getElementById("fundingChart");
  if (!canvas) return;
  if (typeof Chart === "undefined") {
    throw new Error("Chart.js is not loaded");
  }
  const ctx = canvas.getContext("2d");
  
  if (state.chartInstance) {
    state.chartInstance.destroy();
  }
  
  const isPositive = avgFundingRate >= 0;
  const color = isPositive ? "#10b981" : "#ef4444";
  const gradientColor = isPositive ? "rgba(16, 185, 129, 0.15)" : "rgba(239, 68, 68, 0.15)";
  
  const gradient = ctx.createLinearGradient(0, 0, 0, 180);
  gradient.addColorStop(0, gradientColor);
  gradient.addColorStop(1, "rgba(6, 9, 15, 0)");

  state.chartInstance = new Chart(ctx, {
    type: "line",
    data: {
      labels: labels,
      datasets: [{
        label: "Funding Rate",
        data: data,
        borderColor: color,
        borderWidth: 2,
        backgroundColor: gradient,
        fill: true,
        tension: 0.15,
        pointRadius: 0,
        pointHoverRadius: 4,
        pointHoverBackgroundColor: color,
        pointHoverBorderColor: "#fff",
        pointHoverBorderWidth: 1.5,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: "index",
        intersect: false,
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "#0b0f19",
          titleColor: "#94a3b8",
          bodyColor: "#f8fafc",
          borderColor: "rgba(30, 41, 59, 0.8)",
          borderWidth: 1,
          padding: 8,
          cornerRadius: 6,
          displayColors: false,
          callbacks: {
            label: function(context) {
              const val = context.parsed.y;
              return `Rate: ${val >= 0 ? '+' : ''}${val.toFixed(5)}%`;
            }
          }
        }
      },
      scales: {
        x: {
          grid: { display: false },
          ticks: {
            color: "#cbd5e1",
            maxTicksLimit: 6,
            font: { family: "Plus Jakarta Sans", size: 10 }
          }
        },
        y: {
          grid: { color: "rgba(30, 41, 59, 0.3)" },
          ticks: {
            color: "#cbd5e1",
            font: { family: "Plus Jakarta Sans", size: 10 },
            callback: function(value) {
              return (value >= 0 ? '+' : '') + value.toFixed(4) + "%";
            }
          }
        }
      }
    }
  });
}

// Swaps the tab view
function switchTab(viewId) {
  const isMarkets = viewId === "viewMarketBoard";
  elements.tabMarkets.classList.toggle("active", isMarkets);
  elements.tabMarkets.setAttribute("aria-selected", isMarkets ? "true" : "false");
  elements.tabAnalytics.classList.toggle("active", !isMarkets);
  elements.tabAnalytics.setAttribute("aria-selected", !isMarkets ? "true" : "false");
  
  elements.viewMarketBoard.classList.toggle("active", isMarkets);
  elements.viewBatchAnalytics.classList.toggle("active", !isMarkets);
}

async function analyzeTopMarkets() {
  if (!state.filteredRows.length) {
    setAnalysisStatus("Market data is still loading; try again in a moment");
    return;
  }

  const limitValue = elements.analysisLimitSelect.value;
  const selectedRows =
    limitValue === "all"
      ? state.filteredRows
      : state.filteredRows.slice(0, Number(limitValue) || 10);
  const symbols = selectedRows.map((row) => row.symbol);
  const scopeText = limitValue === "all" ? "all filtered rows" : `first ${symbols.length} row(s)`;
  setAnalysisStatus(`Using ${scopeText} from current Market Board filters and sort`);
  await analyzeSymbols(symbols);
}

async function analyzeSymbols(symbols) {
  const uniqueSymbols = [...new Set(symbols)].filter(Boolean);
  if (!uniqueSymbols.length || state.analyzing) return;

  state.analyzing = true;
  elements.analyzeTopButton.disabled = true;
  setAnalysisStatus(`Analyzing 0 / ${uniqueSymbols.length}`);

  if (elements.analysisProgressWrapper && elements.analysisProgressBar) {
    elements.analysisProgressBar.style.width = "0%";
    elements.analysisProgressWrapper.classList.add("active");
  }

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
            if (elements.analysisProgressBar) {
              const percent = Math.min(100, Math.round((completed / uniqueSymbols.length) * 100));
              elements.analysisProgressBar.style.width = `${percent}%`;
            }
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

    if (elements.analysisProgressBar && elements.analysisProgressWrapper) {
      elements.analysisProgressBar.style.width = "100%";
      setTimeout(() => {
        elements.analysisProgressWrapper.classList.remove("active");
        setTimeout(() => {
          elements.analysisProgressBar.style.width = "0%";
        }, 300);
      }, 600);
    }
  }
}

async function fetchFundingHistory(symbol, days) {
  const cacheKey = getHistoryCacheKey(symbol, days);
  const cached = readHistoryCache(cacheKey);
  if (cached) return cached;

  const endTime = Date.now();
  const startTime = endTime - days * 24 * 60 * 60 * 1000;
  const chunkMs = FUNDING_HISTORY_CHUNK_HOURS * FUNDING_HISTORY_STEP_MS;
  const chunks = [];

  for (let cursor = startTime; cursor < endTime; cursor += chunkMs) {
    const chunkEnd = Math.min(cursor + chunkMs - 1, endTime);
    const chunk = await fetchFundingHistoryChunk(symbol, cursor, chunkEnd);
    chunks.push(...chunk);
  }

  const history = dedupeAndSortHistory(chunks).filter((item) => item.time >= startTime && item.time <= endTime);
  writeHistoryCache(cacheKey, history);
  return history;
}

async function fetchFundingHistoryChunk(symbol, startTime, endTime) {
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

  return response.json();
}

function dedupeAndSortHistory(history) {
  const byTime = new Map();
  history.forEach((item) => {
    const time = Number(item.time);
    if (!Number.isFinite(time)) return;
    byTime.set(time, { ...item, time });
  });
  return [...byTime.values()].sort((a, b) => a.time - b.time);
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

function getSortLabel(sortValue) {
  const sortMap = {
    "funding-desc": "Funding (H → L)",
    "funding-asc": "Funding (L → H)",
    "apr-desc": "Est. APR (H → L)",
    "volume-desc": "24h Vol (H → L)",
    "oi-desc": "Open Interest (H → L)",
    "basis-desc": "Basis (H → L)",
  };
  return sortMap[sortValue] ?? "Current Sort";
}

function getActiveFiltersDescription() {
  const parts = [];
  if (state.search.trim()) {
    parts.push(`Search: "${state.search.trim()}"`);
  }
  if (state.direction !== "all") {
    parts.push(`Dir: ${state.direction === "positive" ? "Pos" : "Neg"}`);
  }
  if (state.minVolume > 0) {
    parts.push(`Vol ≥ ${formatUsd(state.minVolume)}`);
  }
  if (state.minOi > 0) {
    parts.push(`OI ≥ ${formatCompact(state.minOi)}`);
  }
  return parts.length ? parts.join(", ") : "None";
}

function updateAnalysisStatusDescription() {
  const sortLabel = getSortLabel(state.sort);
  const limitLabelEl = document.getElementById("analysisLimitLabel");
  if (limitLabelEl) {
    limitLabelEl.textContent = `Rows from ${sortLabel}`;
  }

  if (!state.analyzing) {
    const filtersDesc = getActiveFiltersDescription();
    const filterText = filtersDesc !== "None" ? ` (Filters: ${filtersDesc})` : "";
    setAnalysisStatus(`Uses current Market Board sort (${sortLabel})${filterText}`);
  }
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
    // Cache is best-effort only
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

// Returns standard localized formatting for numbers
function formatNumber(value, decimals = 2) {
  if (!Number.isFinite(value)) return "--";
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: decimals,
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

// Event Listeners Binding
elements.refreshButton.addEventListener("click", fetchMarkets);
elements.exportButton.addEventListener("click", exportCsv);
elements.analyzeTopButton.addEventListener("click", analyzeTopMarkets);
elements.clearHistoryCacheButton.addEventListener("click", clearHistoryCache);
elements.autoRefreshToggle.addEventListener("change", scheduleRefresh);

// Market Board table interaction
elements.fundingRows.addEventListener("click", (event) => {
  const row = event.target.closest("tr[data-symbol]");
  if (!row) return;
  
  const symbol = row.dataset.symbol;
  selectSymbol(symbol);
});

// Batch Analytics comparison table row click -> select and switch view
elements.analysisRows.addEventListener("click", (event) => {
  const row = event.target.closest("tr");
  if (!row) return;
  
  const symbolCell = row.querySelector(".symbol-cell");
  if (!symbolCell) return;
  
  const displaySymbol = symbolCell.querySelector("span:last-child").textContent;
  const match = state.rows.find(r => r.displaySymbol === displaySymbol);
  if (match) {
    selectSymbol(match.symbol);
    switchTab("viewMarketBoard");
  }
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

// Detail Panel History Window Selector listener
elements.detailHistoryWindowSelect.addEventListener("change", (event) => {
  if (state.selectedSymbol) {
    loadHistoryData(state.selectedSymbol, Number(event.target.value));
  }
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

// Navigation Tabs
elements.tabMarkets.addEventListener("click", () => switchTab("viewMarketBoard"));
elements.tabAnalytics.addEventListener("click", () => switchTab("viewBatchAnalytics"));

// Initial Run
fetchMarkets();
scheduleRefresh();
