const API_URL = "https://api.hyperliquid.xyz/info";
const REFRESH_MS = 30_000;
const HOURS_PER_YEAR = 24 * 365;
const HISTORY_CACHE_PREFIX = "hyperFunding.history.v4";
const HISTORY_CACHE_TTL_MS = 5 * 60 * 1000;
const EMPTY_HISTORY_CACHE_TTL_MS = 60 * 1000;
const COMPLETED_CHUNK_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const HISTORY_WEIGHT_BUDGET = 900;
const HISTORY_CONCURRENCY = 1;
const FUNDING_HISTORY_CHUNK_HOURS = 480;
const FUNDING_HISTORY_STEP_MS = 60 * 60 * 1000;
const HISTORY_CHUNK_RETRIES = 6;
const HISTORY_REQUEST_INTERVAL_MS = 500;
const HISTORY_RETRY_DELAY_MS = 1_000;
const HISTORY_RATE_LIMIT_DELAY_MS = 8_000;
const HISTORY_MAX_RETRY_DELAY_MS = 60_000;

let historyRequestQueue = Promise.resolve();
let lastHistoryRequestAt = 0;
let historyWeightEvents = [];

const state = {
  rows: [],
  filteredRows: [],
  analysisRows: [],
  marketMetadata: {
    conciseAnnotations: new Map(),
    categories: new Map(),
    oiCaps: new Map(),
    fullAnnotations: new Map(),
    loaded: false,
    loading: null,
    lastAttemptAt: 0,
  },
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
  symbolChartInstance: null,
  symbolAnalysisSymbol: null,
  symbolAnalysisPoints: [],
  symbolAnalysisPage: 0,
  symbolAnalysisRequest: 0,
  symbolOptionsKey: "",
  activeView: "viewMarketBoard",
  autoBatchAnalysisStarted: false,
  batchRequest: 0,
  batchAbortController: null,
  detailHistoryRequest: 0,
  marketFetchedAt: null,
  marketStale: false,
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
  analysisConfig: document.getElementById("analysisConfig"),
  cancelAnalysisButton: document.getElementById("cancelAnalysisButton"),
  analyzedCount: document.getElementById("analyzedCount"),
  bestScore: document.getElementById("bestScore"),
  bestScoreSymbol: document.getElementById("bestScoreSymbol"),
  bestAvgApr: document.getElementById("bestAvgApr"),
  bestAvgAprSymbol: document.getElementById("bestAvgAprSymbol"),
  directionButtons: [...document.querySelectorAll("[data-direction]")],
  
  // Navigation Tabs
  tabMarkets: document.getElementById("tabMarkets"),
  tabAnalytics: document.getElementById("tabAnalytics"),
  tabSymbolAnalysis: document.getElementById("tabSymbolAnalysis"),
  viewMarketBoard: document.getElementById("viewMarketBoard"),
  viewBatchAnalytics: document.getElementById("viewBatchAnalytics"),
  viewSymbolAnalysis: document.getElementById("viewSymbolAnalysis"),
  symbolAnalysisSelect: document.getElementById("symbolAnalysisSelect"),
  symbolHistoryWindowSelect: document.getElementById("symbolHistoryWindowSelect"),
  analyzeSymbolButton: document.getElementById("analyzeSymbolButton"),
  symbolAnalysisStatus: document.getElementById("symbolAnalysisStatus"),
  symbolAnalysisTitle: document.getElementById("symbolAnalysisTitle"),
  symbolHistoryRows: document.getElementById("symbolHistoryRows"),
  symbolPrevPage: document.getElementById("symbolPrevPage"),
  symbolNextPage: document.getElementById("symbolNextPage"),
  symbolPageStatus: document.getElementById("symbolPageStatus"),
  
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
    state.rows = normalizeRows(meta?.universe, contexts);
    state.marketFetchedAt = Date.now();
    state.marketStale = false;
    loadSupplementalMetadata().then(() => {
      if (state.selectedSymbol) {
        updateDetailMetadata(state.selectedSymbol);
      }
    });
    setStatus("ready", "Live");
    render();
  } catch (error) {
    console.error(error);
    state.marketStale = true;
    setStatus("error", state.rows.length ? "Stale data" : "API error");
    if (state.rows.length) render();
    else {
      renderError("Failed to load Hyperliquid market data");
      elements.exportButton.disabled = true;
    }
  } finally {
    setLoading(false);
    elements.analyzeTopButton.disabled = state.analyzing || state.marketStale || !state.filteredRows.length;
  }
}

function normalizeRows(universe, contexts) {
  if (!Array.isArray(universe) || !Array.isArray(contexts) || universe.length !== contexts.length) {
    throw new Error("Market metadata and context lists are missing or misaligned");
  }
  return universe
    .map((asset, index) => {
      const context = contexts[index] ?? {};
      const funding = toNumber(context.funding);
      const mark = toNumber(context.markPx);
      const oracle = toNumber(context.oraclePx);
      const volume = toNumber(context.dayNtlVlm);
      const openInterest = toNumber(context.openInterest);
      const basis = Number.isFinite(mark) && Number.isFinite(oracle) && oracle !== 0
        ? (mark - oracle) / oracle : NaN;

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
        marginMode: asset.marginMode,
        growthMode: asset.growthMode,
        lastGrowthModeChangeTime: asset.lastGrowthModeChangeTime,
      };
    })
    .filter((row) => Number.isFinite(row.funding) && row.symbol);
}

function render() {
  const rows = applyFiltersAndSort();
  state.filteredRows = rows;
  renderMetrics(state.rows);
  renderTable(rows);
  renderAnalysis();
  renderSymbolOptions();
  elements.analyzeTopButton.disabled = state.analyzing || state.marketStale || !rows.length;
  elements.exportButton.disabled = state.marketStale || !rows.length;
  
  // UX Optimization: Auto-select the first market on initial load
  if (!state.selectedSymbol && rows.length > 0) {
    selectSymbol(rows[0].symbol);
  } else if (state.selectedSymbol) {
    // Keep live metrics fresh on auto-refresh
    updateDetailPanelLiveMetrics(state.selectedSymbol);
  }

  updateAnalysisConfigDescription();
  maybeAutoAnalyzeBatch();
}

function applyFiltersAndSort() {
  const query = state.search.trim().toLowerCase();
  const rows = state.rows.filter((row) => {
    if (query && !row.symbol.toLowerCase().includes(query)) return false;
    if (state.direction === "positive" && row.funding <= 0) return false;
    if (state.direction === "negative" && row.funding >= 0) return false;
    if (state.minVolume > 0 && (!Number.isFinite(row.volume) || row.volume < state.minVolume)) return false;
    if (state.minOi > 0 && (!Number.isFinite(row.openInterest) || row.openInterest < state.minOi)) return false;
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
    const aValid = Number.isFinite(a[key]);
    const bValid = Number.isFinite(b[key]);
    if (aValid !== bValid) return aValid ? -1 : 1;
    if (!aValid) return a.symbol.localeCompare(b.symbol);
    return (a[key] - b[key]) * directionFactor || a.symbol.localeCompare(b.symbol);
  });
}

function renderMetrics(rows) {
  const positiveCount = rows.filter((row) => row.funding > 0).length;
  const negativeCount = rows.filter((row) => row.funding < 0).length;
  const sorted = [...rows].sort((a, b) => b.funding - a.funding);
  const highest = sorted[0];
  const lowest = sorted[sorted.length - 1];

  elements.marketCount.textContent = rows.length ? rows.length.toString() : "--";
  elements.updatedAt.textContent = state.marketFetchedAt
    ? `${state.marketStale ? "Stale · " : "Updated "}${formatUtc(state.marketFetchedAt)} UTC`
    : "--";
  elements.highestFunding.textContent = highest ? `${highest.funding >= 0 ? '+' : ''}${formatPercent(highest.funding)}` : "--";
  elements.highestSymbol.textContent = highest?.displaySymbol ?? "--";
  elements.lowestFunding.textContent = lowest ? formatPercent(lowest.funding) : "--";
  elements.lowestSymbol.textContent = lowest?.displaySymbol ?? "--";
  elements.directionSplit.textContent = rows.length ? `${positiveCount} / ${negativeCount}` : "--";
}

function renderTable(rows) {
  elements.resultCount.textContent = `${rows.length} rows · ${rows.filter((row) => row.volume > 0 || row.openInterest > 0).length} with activity`;

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
              <button class="row-analysis-button compact-analyze" type="button" data-analyze-symbol="${escapeHtml(row.symbol)}" aria-label="Analyze ${escapeHtml(row.displaySymbol)}">Analyze →</button>
            </div>
          </td>
          <td class="num"><span class="tone-pill ${tone}">${row.funding >= 0 ? '+' : ''}${formatPercent(row.funding)}</span></td>
          <td class="num ${tone}">${row.apr >= 0 ? '+' : ''}${formatPercent(row.apr)}</td>
          <td class="num">${formatNumber(row.mark, 4)}</td>
          <td class="num ${Number.isFinite(row.basis) ? row.basis >= 0 ? "positive" : "negative" : ""}">${Number.isFinite(row.basis) && row.basis >= 0 ? '+' : ''}${formatPercent(row.basis)}</td>
          <td class="num">${formatCompact(row.openInterest)}</td>
          <td class="num">${formatUsd(row.volume)}</td>
          <td class="num">${row.maxLeverage ? `${row.maxLeverage}x` : "--"}</td>
          <td><button class="row-analysis-button" type="button" data-analyze-symbol="${escapeHtml(row.symbol)}" aria-label="Analyze ${escapeHtml(row.displaySymbol)}">Analyze →</button></td>
        </tr>
      `;
    })
    .join("");
}

function renderError(message) {
  elements.fundingRows.innerHTML = `<tr><td colspan="9" class="empty-cell">${escapeHtml(message)}</td></tr>`;
}

function renderAnalysis() {
  const rows = [...state.analysisRows].sort((a, b) => Number(b.complete) - Number(a.complete) || b.score - a.score);
  const ranked = rows.filter((row) => row.complete);
  const bestScore = ranked[0];
  const bestApr = [...ranked].filter((row) => row.avgApr > 0).sort((a, b) => b.avgApr - a.avgApr)[0];

  elements.analyzedCount.textContent = rows.length ? rows.length.toString() : "--";
  elements.bestScore.textContent = bestScore ? bestScore.score.toFixed(1) : "--";
  elements.bestScoreSymbol.textContent = bestScore?.displaySymbol ?? "--";
  elements.bestAvgApr.textContent = bestApr ? `${bestApr.avgApr >= 0 ? '+' : ''}${formatPercent(bestApr.avgApr)}` : "--";
  elements.bestAvgAprSymbol.textContent = bestApr?.displaySymbol ?? "--";

  if (!rows.length) {
    elements.analysisRows.innerHTML = `<tr><td colspan="9" class="empty-cell">Run history analysis from the controls above or a table row</td></tr>`;
    return;
  }

  elements.analysisRows.innerHTML = rows
    .map((row) => {
      const tone = row.avgFunding >= 0 ? "positive" : "negative";
      return `
        <tr data-symbol="${escapeHtml(row.symbol)}">
          <td>
            <div class="symbol-cell">
              <span class="symbol-chip">XYZ</span>
              <span>${escapeHtml(row.displaySymbol)}</span>
              <button class="row-analysis-button compact-analyze" type="button" data-analyze-symbol="${escapeHtml(row.symbol)}" aria-label="Analyze ${escapeHtml(row.displaySymbol)}">Analyze →</button>
            </div>
          </td>
          <td class="num"><strong style="color: var(--text-primary);">${row.complete ? row.score.toFixed(1) : "--"}</strong></td>
          <td class="num ${tone}">${row.avgFunding >= 0 ? '+' : ''}${formatPercent(row.avgFunding)}</td>
          <td class="num ${tone}">${row.avgApr >= 0 ? '+' : ''}${formatPercent(row.avgApr)}</td>
          <td class="num">${formatPercent(row.volatility)}</td>
          <td class="num">${formatPercent(row.directionHitRate)}</td>
          <td class="num">${row.positiveCount} / ${row.negativeCount}</td>
          <td class="num" title="${row.samples} of ${row.expectedSamples} expected hourly samples">${row.samples} / ${row.expectedSamples} (${row.complete ? "complete" : "partial"})</td>
          <td><button class="row-analysis-button" type="button" data-analyze-symbol="${escapeHtml(row.symbol)}" aria-label="Analyze ${escapeHtml(row.displaySymbol)}">Analyze →</button></td>
        </tr>
      `;
    })
    .join("");
}

// Select a single symbol to show in the right-hand panel & render Chart
async function selectSymbol(symbol, isManual = false) {
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
  updateDetailMetadata(symbol);
  loadFullAnnotation(symbol).then(() => {
    if (state.selectedSymbol === symbol) {
      updateDetailMetadata(symbol);
    }
  });
  
  // Show detail content & hide empty state
  elements.detailPanelContent.classList.remove("hidden");
  elements.detailEmptyState.classList.add("hidden");
  
  // Fetch and load historical chart
  const windowDays = Number(elements.detailHistoryWindowSelect.value) || 7;
  await loadHistoryData(symbol, windowDays);

  if (isManual && window.innerWidth <= 1100) {
    const detailPanel = document.getElementById("detailPanel");
    if (detailPanel) {
      detailPanel.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }
}

// Update live metrics on the detail card without refreshing graph
function updateDetailPanelLiveMetrics(symbol) {
  const row = state.rows.find(r => r.symbol === symbol);
  if (!row) return;
  
  document.getElementById("detailCurrentPrice").textContent = Number.isFinite(row.mark) ? `$${formatNumber(row.mark, 4)}` : "--";
  
  const fundingEl = document.getElementById("detailCurrentFunding");
  fundingEl.textContent = `${row.funding >= 0 ? '+' : ''}${formatPercent(row.funding)} / hr`;
  fundingEl.className = `detail-funding-pill ${row.funding >= 0 ? 'positive' : 'negative'}`;
  
  document.getElementById("detailVolume").textContent = formatUsd(row.volume);
  document.getElementById("detailOi").textContent = formatCompact(row.openInterest);
  document.getElementById("detailBasis").textContent = `${Number.isFinite(row.basis) && row.basis >= 0 ? '+' : ''}${formatPercent(row.basis)}`;
}

async function loadSupplementalMetadata() {
  if (state.marketMetadata.loaded) return;
  if (state.marketMetadata.loading) return state.marketMetadata.loading;
  if (Date.now() - state.marketMetadata.lastAttemptAt < 5 * 60_000) return;
  state.marketMetadata.lastAttemptAt = Date.now();

  state.marketMetadata.loading = (async () => {
    const [conciseResult, categoriesResult, dexsResult] = await Promise.allSettled([
      fetchInfo({ type: "perpConciseAnnotations" }),
      fetchInfo({ type: "perpCategories" }),
      fetchInfo({ type: "perpDexs" }),
    ]);

    if (conciseResult.status === "fulfilled" && Array.isArray(conciseResult.value)) {
      state.marketMetadata.conciseAnnotations = new Map(conciseResult.value);
    }

    if (categoriesResult.status === "fulfilled" && Array.isArray(categoriesResult.value)) {
      state.marketMetadata.categories = new Map(categoriesResult.value);
    }

    if (dexsResult.status === "fulfilled" && Array.isArray(dexsResult.value)) {
      const xyzDex = dexsResult.value.find((dex) => dex?.name === "xyz");
      state.marketMetadata.oiCaps = new Map(xyzDex?.assetToStreamingOiCap ?? []);
    }

    state.marketMetadata.loaded = [conciseResult, categoriesResult, dexsResult].every((result) => result.status === "fulfilled");
  })().catch((error) => {
    console.error("Failed to load supplemental metadata", error);
  }).finally(() => {
    state.marketMetadata.loading = null;
  });

  return state.marketMetadata.loading;
}

async function loadFullAnnotation(symbol) {
  if (state.marketMetadata.fullAnnotations.has(symbol)) return;

  try {
    const annotation = await fetchInfo({ type: "perpAnnotation", coin: symbol });
    state.marketMetadata.fullAnnotations.set(symbol, annotation ?? null);
  } catch (error) {
    console.error(`Failed to load annotation for ${symbol}`, error);
    // Leave failed lookups retryable on the next selection.
  }
}

async function fetchInfo(body) {
  const response = await fetch(API_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.json();
}

function updateDetailMetadata(symbol) {
  const row = state.rows.find((item) => item.symbol === symbol);
  if (!row) return;

  const fullAnnotation = state.marketMetadata.fullAnnotations.get(symbol);
  const conciseAnnotation = state.marketMetadata.conciseAnnotations.get(symbol);
  const annotation = fullAnnotation || conciseAnnotation || {};
  const category = annotation.category || state.marketMetadata.categories.get(symbol);
  const keywords = Array.isArray(annotation.keywords) ? annotation.keywords : [];
  const oiCap = toNumber(state.marketMetadata.oiCaps.get(symbol));

  document.getElementById("detailMetadataSource").textContent = state.marketMetadata.loaded
    ? "Hyperliquid metadata"
    : state.marketMetadata.loading ? "Loading optional sources" : "Optional metadata partial / unavailable";
  document.getElementById("detailCategory").textContent = formatOptional(category);
  document.getElementById("detailOiCap").textContent = Number.isFinite(oiCap) ? formatUsd(oiCap) : "Not available";
  document.getElementById("detailMarginMode").textContent = formatOptional(formatMode(row.marginMode));
  document.getElementById("detailGrowthMode").textContent = formatOptional(formatMode(row.growthMode));
  document.getElementById("detailDescription").textContent = annotation.description || "No annotation available.";
  document.getElementById("detailKeywords").innerHTML = keywords.length
    ? keywords.map((keyword) => `<span class="metadata-chip">${escapeHtml(keyword)}</span>`).join("")
    : "";
  document.getElementById("detailLinks").innerHTML = getMetadataLinks(row, category)
    .map((link) => `<a class="metadata-link" href="${escapeHtml(link.href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(link.label)}</a>`)
    .join("");
}

function getMetadataLinks(row, category) {
  const links = [
    {
      label: "Hyperliquid",
      href: `https://app.hyperliquid.xyz/trade/${encodeURIComponent(row.symbol)}`,
    },
  ];

  if (category === "stocks" && /^[A-Z.]+$/.test(row.displaySymbol)) {
    links.push(
      {
        label: "Yahoo Finance",
        href: `https://finance.yahoo.com/quote/${encodeURIComponent(row.displaySymbol)}`,
      },
      {
        label: "Nasdaq",
        href: `https://www.nasdaq.com/market-activity/stocks/${encodeURIComponent(row.displaySymbol.toLowerCase())}`,
      },
    );
  }

  return links;
}

// Fetch historical rates, calculate analytics summary, and render line graph
async function loadHistoryData(symbol, days) {
  const requestId = ++state.detailHistoryRequest;
  const chartContainer = document.querySelector(".chart-container");
  chartContainer.style.opacity = "0.6";
  chartContainer.classList.add("is-loading");
  resetDetailHistorySummary(days, "Loading history...");
  if (state.chartInstance) { state.chartInstance.destroy(); state.chartInstance = null; }
  
  try {
    const history = await fetchFundingHistory(symbol, days);
    if (requestId !== state.detailHistoryRequest) return;
    const stats = summarizeFundingHistory(symbol, history);
    
    if (!stats) throw new Error("No historical rates");
    const coverage = getHistoryCoverage(stats, days);
    
    // Update analytics cards
    document.getElementById("detailScore").textContent = coverage.complete ? stats.score.toFixed(1) : "--";
    
    const avgFundingEl = document.getElementById("detailAvgFunding");
    avgFundingEl.textContent = `${stats.avgFunding >= 0 ? '+' : ''}${formatPercent(stats.avgFunding)}`;
    avgFundingEl.className = stats.avgFunding >= 0 ? "positive" : "negative";
    
    const avgAprEl = document.getElementById("detailAvgApr");
    avgAprEl.textContent = `${stats.avgApr >= 0 ? '+' : ''}${formatPercent(stats.avgApr)}`;
    avgAprEl.className = stats.avgApr >= 0 ? "positive" : "negative";
    
    document.getElementById("detailVolatility").textContent = formatPercent(stats.volatility);
    document.getElementById("detailPosRatio").textContent = `${stats.positiveCount} / ${stats.negativeCount}`;
    document.getElementById("detailSamplesCount").textContent = `${stats.samples} / ${coverage.expectedSamples} hourly samples (${coverage.complete ? "complete" : "partial"})`;
    document.getElementById("detailHitRate").textContent = formatPercent(stats.directionHitRate);
    document.getElementById("detailFirstFunding").textContent = formatDateOnly(stats.firstSampleTime);
    document.getElementById("detailFirstFundingDesc").textContent = `${formatTimeOnly(stats.firstSampleTime)} UTC`;
    updateDetailHistorySubtitle(days, coverage, history.fetchedAt);
    
    // Process points for line chart
    const chartPoints = history.filter((item) => item.fundingRate != null && item.fundingRate !== "").map(item => ({
      x: new Date(item.time),
      y: Number(item.fundingRate) * 100 // convert to percentage
    })).sort((a, b) => a.x - b.x);
    
    const labels = chartPoints.map(p => {
      const d = p.x;
      return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, '0')}:00 UTC`;
    });
    const rates = chartPoints.map(p => p.y);
    
    updateChart(labels, rates, stats.avgFunding);
  } catch (error) {
    if (requestId !== state.detailHistoryRequest) return;
    console.error("Failed to load historical data", error);
    resetDetailHistorySummary(days, "History unavailable");
    if (state.chartInstance) { state.chartInstance.destroy(); state.chartInstance = null; }
  } finally {
    if (requestId === state.detailHistoryRequest) {
      chartContainer.style.opacity = "1";
      chartContainer.classList.remove("is-loading");
    }
  }
}

function resetDetailHistorySummary(days, subtitle = "Hourly rates & cumulative yield indicators") {
  document.getElementById("detailScore").textContent = "--";
  document.getElementById("detailAvgFunding").textContent = "--";
  document.getElementById("detailAvgApr").textContent = "--";
  document.getElementById("detailVolatility").textContent = "--";
  document.getElementById("detailPosRatio").textContent = "--";
  document.getElementById("detailSamplesCount").textContent = `${getWindowLabel(days)} window`;
  document.getElementById("detailHitRate").textContent = "--";
  document.getElementById("detailFirstFunding").textContent = "--";
  document.getElementById("detailFirstFundingDesc").textContent = "Earliest available history";
  const subtitleEl = document.getElementById("detailHistorySubtitle");
  if (subtitleEl) subtitleEl.textContent = subtitle;
}

function updateDetailHistorySubtitle(requestedDays, coverage, fetchedAt) {
  const subtitleEl = document.getElementById("detailHistorySubtitle");
  if (!subtitleEl) return;

  const requested = getWindowLabel(requestedDays);
  subtitleEl.textContent = `Requested ${requested}; ${coverage.complete ? "complete" : "partial"} coverage (${coverage.samples}/${coverage.expectedSamples} hours, ${formatSampleDays(coverage.spanHours / 24)} span) · as of ${formatUtc(fetchedAt)} UTC`;
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
  state.activeView = viewId;
  for (const [tab, view] of [
    [elements.tabMarkets, elements.viewMarketBoard],
    [elements.tabAnalytics, elements.viewBatchAnalytics],
    [elements.tabSymbolAnalysis, elements.viewSymbolAnalysis],
  ]) {
    const active = view.id === viewId;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
    view.classList.toggle("active", active);
  }
  maybeAutoAnalyzeBatch();
}

function renderSymbolOptions() {
  const previous = state.symbolAnalysisSymbol || elements.symbolAnalysisSelect.value;
  const symbols = [...state.rows].sort((a, b) => a.displaySymbol.localeCompare(b.displaySymbol));
  const optionsKey = symbols.map((row) => row.symbol).join("\u0000");
  if (optionsKey !== state.symbolOptionsKey) {
    elements.symbolAnalysisSelect.innerHTML = symbols.map((row) =>
      `<option value="${escapeHtml(row.symbol)}">${escapeHtml(row.displaySymbol)}</option>`
    ).join("");
    state.symbolOptionsKey = optionsKey;
  }
  const selected = symbols.some((row) => row.symbol === previous)
    ? previous
    : symbols.find((row) => row.symbol === state.selectedSymbol)?.symbol || symbols[0]?.symbol;
  if (state.symbolAnalysisSymbol && state.symbolAnalysisSymbol !== selected) state.symbolAnalysisSymbol = null;
  if (selected) elements.symbolAnalysisSelect.value = selected;
  elements.analyzeSymbolButton.disabled = !selected;
}

function openSymbolAnalysis(symbol, days) {
  if (!state.rows.some((row) => row.symbol === symbol)) return;
  state.symbolAnalysisSymbol = symbol;
  elements.symbolAnalysisSelect.value = symbol;
  if (days) elements.symbolHistoryWindowSelect.value = String(days);
  switchTab("viewSymbolAnalysis");
  analyzeSelectedSymbol();
}

function resetSymbolAnalysis() {
  for (const id of ["symbolAvgFunding", "symbolAvgApr", "symbolVolatility", "symbolScore",
    "symbolHitRate", "symbolDirectionCount", "symbolSampleCount", "symbolAvailableSpan"]) {
    document.getElementById(id).textContent = "--";
  }
  document.getElementById("symbolChartRange").textContent = "--";
  state.symbolAnalysisPoints = [];
  state.symbolAnalysisPage = 0;
  if (state.symbolChartInstance) {
    state.symbolChartInstance.destroy();
    state.symbolChartInstance = null;
  }
  renderSymbolHistoryTable();
}

async function analyzeSelectedSymbol() {
  const symbol = elements.symbolAnalysisSelect.value;
  if (!symbol || !state.rows.some((row) => row.symbol === symbol)) return;
  const days = Number(elements.symbolHistoryWindowSelect.value) || 7;
  const requestId = ++state.symbolAnalysisRequest;
  state.symbolAnalysisSymbol = symbol;
  const displaySymbol = state.rows.find((row) => row.symbol === symbol).displaySymbol;
  elements.symbolAnalysisTitle.textContent = `${displaySymbol} History Analysis`;
  elements.symbolAnalysisStatus.textContent = `Loading ${getWindowLabel(days)} of ${displaySymbol} funding history...`;
  elements.analyzeSymbolButton.disabled = true;
  resetSymbolAnalysis();
  try {
    const history = await fetchFundingHistory(symbol, days);
    if (requestId !== state.symbolAnalysisRequest) return;
    const stats = summarizeFundingHistory(symbol, history);
    if (!stats) throw new Error("No valid historical funding samples");
    const points = buildSymbolAnalysisPoints(history);
    state.symbolAnalysisPoints = points;
    const coverage = getHistoryCoverage(stats, days);
    const available = formatSampleDays(coverage.spanHours / 24);
    elements.symbolAnalysisStatus.textContent = `${coverage.complete ? "Complete" : "Partial"} · ${stats.samples}/${coverage.expectedSamples} hourly samples · ${available} span · as of ${formatUtc(history.fetchedAt)} UTC`;
    document.getElementById("symbolAvgFunding").textContent = signedPercent(stats.avgFunding);
    document.getElementById("symbolAvgApr").textContent = signedPercent(stats.avgApr);
    document.getElementById("symbolVolatility").textContent = formatPercent(stats.volatility);
    document.getElementById("symbolScore").textContent = coverage.complete ? stats.score.toFixed(1) : "--";
    document.getElementById("symbolHitRate").textContent = formatPercent(stats.directionHitRate);
    document.getElementById("symbolDirectionCount").textContent = `${stats.positiveCount} / ${stats.negativeCount}`;
    document.getElementById("symbolSampleCount").textContent = String(stats.samples);
    document.getElementById("symbolAvailableSpan").textContent = available;
    document.getElementById("symbolChartRange").textContent = `${formatUtc(stats.firstSampleTime)} – ${formatUtc(stats.lastSampleTime)} UTC`;
    renderSymbolChart(points);
    renderSymbolHistoryTable();
  } catch (error) {
    if (requestId !== state.symbolAnalysisRequest) return;
    console.error("Failed to analyze symbol history", error);
    elements.symbolAnalysisStatus.textContent = `History unavailable for ${displaySymbol}: ${error.message}`;
    elements.symbolHistoryRows.innerHTML = `<tr><td colspan="5" class="empty-cell">${escapeHtml(error.message)}</td></tr>`;
  } finally {
    if (requestId === state.symbolAnalysisRequest) elements.analyzeSymbolButton.disabled = false;
  }
}

function buildSymbolAnalysisPoints(history) {
  let total = 0;
  return dedupeAndSortHistory(history)
    .filter((item) => item.fundingRate != null && item.fundingRate !== "")
    .map((item) => ({ time: Number(item.time), rate: Number(item.fundingRate) }))
    .filter((item) => Number.isFinite(item.time) && Number.isFinite(item.rate))
    .map((item, index) => {
      total += item.rate;
      return { ...item, cumulativeRate: total, runningRate: total / (index + 1), runningApr: total / (index + 1) * HOURS_PER_YEAR };
    });
}

function renderSymbolChart(points) {
  if (typeof Chart === "undefined") throw new Error("Chart.js is not loaded");
  const canvas = document.getElementById("symbolAnalysisChart");
  const labels = points.map((point) => formatUtc(point.time));
  state.symbolChartInstance = new Chart(canvas, {
    type: "line",
    data: {
      labels,
      datasets: [
        { label: "Funding / Hr", data: points.map((point) => point.rate * 100), yAxisID: "rate", borderColor: "#10b981", backgroundColor: "#10b981", borderWidth: 1.5, pointRadius: 0, pointHoverRadius: 3, tension: 0 },
        { label: "Running Avg APR", data: points.map((point) => point.runningApr * 100), yAxisID: "apr", borderColor: "#60a5fa", backgroundColor: "#60a5fa", borderWidth: 2.5, pointRadius: 0, pointHoverRadius: 3, tension: 0 },
        { label: "Cumulative Funding", data: points.map((point) => point.cumulativeRate * 100), yAxisID: "cumulative", borderColor: "#f59e0b", backgroundColor: "#f59e0b", borderWidth: 2.5, pointRadius: 0, pointHoverRadius: 3, tension: 0 },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (context) => `${context.dataset.label}: ${context.parsed.y >= 0 ? "+" : ""}${context.parsed.y.toFixed(context.dataset.yAxisID === "rate" ? 5 : context.dataset.yAxisID === "cumulative" ? 4 : 2)}%` } },
      },
      scales: {
        x: { ticks: { color: "#94a3b8", maxTicksLimit: 8 }, grid: { display: false } },
        rate: { type: "linear", position: "left", title: { display: true, text: "Funding / Hr (%)", color: "#10b981" }, ticks: { color: "#10b981", callback: (value) => `${Number(value).toFixed(4)}%` }, grid: { color: "rgba(148,163,184,.12)" } },
        apr: { type: "linear", position: "right", title: { display: true, text: "Running Avg APR (%)", color: "#60a5fa" }, ticks: { color: "#60a5fa", callback: (value) => `${Number(value).toFixed(1)}%` }, grid: { drawOnChartArea: false } },
        cumulative: { type: "linear", position: "right", weight: 2, title: { display: true, text: "Cumulative Funding (%)", color: "#f59e0b" }, ticks: { color: "#f59e0b", callback: (value) => `${Number(value).toFixed(2)}%` }, grid: { drawOnChartArea: false } },
      },
    },
  });
}

function renderSymbolHistoryTable() {
  const points = state.symbolAnalysisPoints;
  const pageSize = 100;
  const pages = Math.ceil(points.length / pageSize);
  state.symbolAnalysisPage = Math.min(state.symbolAnalysisPage, Math.max(0, pages - 1));
  const start = state.symbolAnalysisPage * pageSize;
  const visible = points.slice().reverse().slice(start, start + pageSize);
  elements.symbolHistoryRows.innerHTML = visible.length ? visible.map((point) => `
    <tr>
      <td>${formatUtc(point.time)}</td>
      <td class="num ${point.rate >= 0 ? "positive" : "negative"}">${signedPercent(point.rate)}</td>
      <td class="num">${signedPercent(point.rate * HOURS_PER_YEAR)}</td>
      <td class="num">${signedPercent(point.runningRate)}</td>
      <td class="num ${point.runningApr >= 0 ? "positive" : "negative"}">${signedPercent(point.runningApr)}</td>
    </tr>`).join("") : `<tr><td colspan="5" class="empty-cell">No history loaded</td></tr>`;
  elements.symbolPageStatus.textContent = points.length ? `${start + 1}–${Math.min(start + pageSize, points.length)} of ${points.length}` : "--";
  elements.symbolPrevPage.disabled = state.symbolAnalysisPage === 0;
  elements.symbolNextPage.disabled = state.symbolAnalysisPage >= pages - 1;
}

function signedPercent(value) {
  return `${value >= 0 ? "+" : ""}${formatPercent(value)}`;
}

function formatUtc(time) {
  return new Date(time).toISOString().slice(0, 16).replace("T", " ");
}

function maybeAutoAnalyzeBatch() {
  if (state.activeView !== "viewBatchAnalytics") return;
  if (state.autoBatchAnalysisStarted || state.analyzing || state.analysisRows.length || state.marketStale) return;
  if (!state.filteredRows.length) return;

  state.autoBatchAnalysisStarted = true;
  analyzeTopMarkets();
}

async function analyzeTopMarkets() {
  if (!state.filteredRows.length || state.marketStale) {
    setAnalysisStatus("Market data is still loading; try again in a moment");
    return;
  }

  const limitValue = elements.analysisLimitSelect.value;
  const selectedRows =
    limitValue === "all"
      ? state.filteredRows
      : state.filteredRows.slice(0, Number(limitValue) || 10);
  const symbols = selectedRows.filter((row) => row.volume > 0 || row.openInterest > 0).map((row) => row.symbol);
  const skippedCount = selectedRows.length - symbols.length;
  if (!symbols.length) { setAnalysisStatus(`${skippedCount} selected market(s) have no current volume or open interest`); return; }
  await analyzeSymbols(symbols, skippedCount);
}

async function analyzeSymbols(symbols, skippedCount = 0) {
  const uniqueSymbols = [...new Set(symbols)].filter(Boolean);
  if (!uniqueSymbols.length || state.analyzing) return;

  const requestId = ++state.batchRequest;
  const controller = new AbortController();
  state.batchAbortController = controller;
  state.analysisRows = [];
  renderAnalysis();
  state.analyzing = true;
  elements.analyzeTopButton.disabled = true;
  elements.cancelAnalysisButton.disabled = false;
  setAnalysisStatus(`Analyzing 0 / ${uniqueSymbols.length}`);

  if (elements.analysisProgressWrapper && elements.analysisProgressBar) {
    elements.analysisProgressBar.style.width = "0%";
    elements.analysisProgressWrapper.classList.add("active");
  }

  const days = Number(elements.historyWindowSelect.value) || 7;
  const results = [];
  const failedSymbols = [];
  const noHistorySymbols = [];
  const partialSymbols = [];
  let completed = 0;

  try {
    for (let index = 0; index < uniqueSymbols.length; index += HISTORY_CONCURRENCY) {
      const batch = uniqueSymbols.slice(index, index + HISTORY_CONCURRENCY);
      const batchResults = await Promise.all(
        batch.map(async (symbol) => {
          try {
            const history = await fetchFundingHistory(symbol, days, controller.signal);
            if (requestId !== state.batchRequest) return null;
            const stats = summarizeFundingHistory(symbol, history);
            if (!stats) {
              noHistorySymbols.push(symbol.replace("xyz:", ""));
              return null;
            }
            Object.assign(stats, getHistoryCoverage(stats, days));
            if (!stats.complete) partialSymbols.push(stats.displaySymbol);
            return stats;
          } catch (error) {
            if (error.name === "AbortError") return null;
            console.error(error);
            failedSymbols.push(symbol.replace("xyz:", ""));
            return null;
          } finally {
            completed += 1;
            if (requestId === state.batchRequest) setAnalysisStatus(`Analyzing ${completed} / ${uniqueSymbols.length}`);
            if (elements.analysisProgressBar) {
              const percent = Math.min(100, Math.round((completed / uniqueSymbols.length) * 100));
              elements.analysisProgressBar.style.width = `${percent}%`;
            }
          }
        }),
      );
      if (requestId !== state.batchRequest) return;
      results.push(...batchResults);
    }

    const validResults = results.filter(Boolean);
    state.analysisRows = validResults;
    const pieces = [`${validResults.filter((row) => row.complete).length} complete`, `${partialSymbols.length} partial`, `${noHistorySymbols.length} no history`, `${failedSymbols.length} failed`];
    if (skippedCount) pieces.push(`${skippedCount} no current activity skipped`);
    setAnalysisStatus(`${getWindowLabel(days)} · ${pieces.join(" · ")} · as of ${formatUtc(Date.now())} UTC${failedSymbols.length ? ` · failed: ${failedSymbols.join(", ")}` : ""}`);
  } catch (error) {
    console.error(error);
    setAnalysisStatus("History analysis failed");
  } finally {
    if (requestId !== state.batchRequest) return;
    state.analyzing = false;
    state.batchAbortController = null;
    elements.analyzeTopButton.disabled = state.marketStale || !state.filteredRows.length;
    elements.cancelAnalysisButton.disabled = true;
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

function cancelBatchAnalysis(message = "Analysis cancelled") {
  ++state.batchRequest;
  state.batchAbortController?.abort();
  state.batchAbortController = null;
  state.analyzing = false;
  state.analysisRows = [];
  elements.analyzeTopButton.disabled = state.marketStale || !state.filteredRows.length;
  elements.cancelAnalysisButton.disabled = true;
  elements.analysisProgressWrapper.classList.remove("active");
  elements.analysisProgressBar.style.width = "0%";
  setAnalysisStatus(message);
  renderAnalysis();
}

async function fetchFundingHistory(symbol, days, signal) {
  signal?.throwIfAborted();
  const cacheKey = getHistoryCacheKey(symbol, days);
  const cached = readHistoryCache(cacheKey);
  if (cached) return Object.assign(cached.data, { fetchedAt: cached.savedAt });

  const endTime = Date.now();
  const startTime = endTime - days * 24 * 60 * 60 * 1000;
  const chunkMs = FUNDING_HISTORY_CHUNK_HOURS * FUNDING_HISTORY_STEP_MS;
  const chunks = [];
  let hasSeenHistory = false;

  for (let cursorEnd = endTime; cursorEnd > startTime;) {
    const bucketStart = Math.floor(cursorEnd / chunkMs) * chunkMs;
    const chunkStart = Math.max(startTime, bucketStart);
    const completeChunk = chunkStart === bucketStart && cursorEnd === bucketStart + chunkMs - 1;
    const chunkKey = `${HISTORY_CACHE_PREFIX}.chunk.${symbol}.${bucketStart}`;
    const savedChunk = completeChunk ? readHistoryCache(chunkKey, COMPLETED_CHUNK_CACHE_TTL_MS) : null;
    const chunk = savedChunk ? savedChunk.data : await fetchFundingHistoryChunk(symbol, chunkStart, cursorEnd, signal);
    if (completeChunk && !savedChunk && chunk.length) writeHistoryCache(chunkKey, chunk);
    if (!chunk.length && hasSeenHistory) break;
    if (!chunk.length) { cursorEnd = chunkStart - 1; continue; }

    hasSeenHistory = true;
    chunks.push(...chunk);
    cursorEnd = chunkStart - 1;
  }

  const history = dedupeAndSortHistory(chunks).filter((item) => item.time >= startTime && item.time <= endTime);
  signal?.throwIfAborted();
  writeHistoryCache(cacheKey, history);
  return Object.assign(history, { fetchedAt: Date.now() });
}

async function fetchFundingHistoryChunk(symbol, startTime, endTime, signal) {
  let lastError;

  for (let attempt = 1; attempt <= HISTORY_CHUNK_RETRIES; attempt += 1) {
    try {
      const response = await scheduleHistoryRequest(() => fetch(API_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal,
        body: JSON.stringify({
          type: "fundingHistory",
          coin: symbol,
          startTime,
          endTime,
        }),
      }), estimateHistoryWeight(startTime, endTime), signal);

      if (!response.ok) {
        const error = new Error(`HTTP ${response.status}`);
        error.status = response.status;
        error.retryAfterMs = getRetryAfterMs(response.headers);
        throw error;
      }

      const data = await response.json();
      if (!Array.isArray(data)) {
        throw new Error("Unexpected history response");
      }

      return data;
    } catch (error) {
      if (error.name === "AbortError") throw error;
      lastError = error;
      if (attempt < HISTORY_CHUNK_RETRIES) {
        const delayMs = getHistoryRetryDelayMs(error, attempt);
        if (error?.status === 429 && state.analyzing) {
          setAnalysisStatus(`Rate limited; retrying ${symbol.replace("xyz:", "")} in ${formatRetryDelay(delayMs)}`);
        }
        await sleep(delayMs, signal);
      }
    }
  }

  const from = new Date(startTime).toISOString();
  const to = new Date(endTime).toISOString();
  throw new Error(`History ${symbol} failed for ${from} - ${to}: ${lastError?.message ?? "unknown error"}`);
}

function estimateHistoryWeight(startTime, endTime) {
  return 20 + Math.ceil((endTime - startTime) / FUNDING_HISTORY_STEP_MS / 20);
}

function scheduleHistoryRequest(request, weight, signal) {
  const run = historyRequestQueue.then(async () => {
    signal?.throwIfAborted();
    const elapsed = Date.now() - lastHistoryRequestAt;
    if (elapsed < HISTORY_REQUEST_INTERVAL_MS) {
      await sleep(HISTORY_REQUEST_INTERVAL_MS - elapsed, signal);
    }
    while (true) {
      signal?.throwIfAborted();
      const now = Date.now();
      historyWeightEvents = historyWeightEvents.filter((event) => now - event.time < 60_000);
      const used = historyWeightEvents.reduce((sum, event) => sum + event.weight, 0);
      if (used + weight <= HISTORY_WEIGHT_BUDGET) break;
      const waitMs = Math.max(250, historyWeightEvents[0].time + 60_000 - now + 50);
      if (state.analyzing) setAnalysisStatus(`Waiting ${formatRetryDelay(waitMs)} for API request budget`);
      await sleep(waitMs, signal);
    }
    lastHistoryRequestAt = Date.now();
    historyWeightEvents.push({ time: lastHistoryRequestAt, weight });
    return request();
  });

  historyRequestQueue = run.catch(() => {});
  return run;
}

function getRetryAfterMs(headers) {
  const retryAfter = headers.get("retry-after");
  if (!retryAfter) return 0;

  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }

  const retryDate = Date.parse(retryAfter);
  if (Number.isFinite(retryDate)) {
    return Math.max(0, retryDate - Date.now());
  }

  return 0;
}

function getHistoryRetryDelayMs(error, attempt) {
  const baseDelay = error?.status === 429 ? HISTORY_RATE_LIMIT_DELAY_MS : HISTORY_RETRY_DELAY_MS;
  const retryAfterMs = error?.status === 429 ? error.retryAfterMs || 0 : 0;
  const backoffMs = baseDelay * attempt;
  return Math.min(HISTORY_MAX_RETRY_DELAY_MS, Math.max(retryAfterMs, backoffMs));
}

function formatRetryDelay(ms) {
  if (!Number.isFinite(ms)) return "soon";
  return `${Math.ceil(ms / 1000)}s`;
}

function dedupeAndSortHistory(history) {
  const byTime = new Map();
  history.forEach((item) => {
    const time = Number(item.time);
    if (!Number.isFinite(time) || item.fundingRate == null || item.fundingRate === "" || !Number.isFinite(Number(item.fundingRate))) return;
    byTime.set(time, { ...item, time });
  });
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

function summarizeFundingHistory(symbol, history) {
  const validHistory = dedupeAndSortHistory(history)
    .filter((item) => item.fundingRate != null && item.fundingRate !== "")
    .map((item) => ({
      time: Number(item.time),
      fundingRate: Number(item.fundingRate),
    }))
    .filter((item) => Number.isFinite(item.time) && Number.isFinite(item.fundingRate))
    .sort((a, b) => a.time - b.time);
  const values = validHistory.map((item) => item.fundingRate);
  if (!values.length) return null;

  const avgFunding = mean(values);
  const volatility = standardDeviation(values, avgFunding);
  const avgApr = avgFunding * HOURS_PER_YEAR;
  const direction = avgFunding >= 0 ? 1 : -1;
  const positiveCount = values.filter((value) => value > 0).length;
  const negativeCount = values.filter((value) => value < 0).length;
  const directionHits = values.filter((value) => Math.sign(value) === direction).length;
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
    sampleDays: (validHistory.at(-1).time - validHistory[0].time) / FUNDING_HISTORY_STEP_MS / 24,
    firstSampleTime: validHistory[0].time,
    lastSampleTime: validHistory.at(-1).time,
    score,
  };
}

function getHistoryCoverage(stats, days) {
  const expectedSamples = Math.ceil(days * 24);
  const spanHours = (stats.lastSampleTime - stats.firstSampleTime) / FUNDING_HISTORY_STEP_MS;
  const missingSamples = Math.max(0, Math.round(spanHours) + 1 - stats.samples);
  const recentEnough = Date.now() - stats.lastSampleTime <= 2 * FUNDING_HISTORY_STEP_MS;
  const complete = stats.samples >= expectedSamples * 0.95 && missingSamples <= expectedSamples * 0.05 && recentEnough;
  return { samples: stats.samples, expectedSamples, spanHours, missingSamples, complete };
}

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    function onAbort() { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function formatSampleDays(days) {
  if (!Number.isFinite(days)) return "--";
  if (days < 1) return `${(days * 24).toFixed(0)}h`;
  return `${days.toFixed(1)}d`;
}

function getWindowLabel(days) {
  const number = Number(days);
  if (!Number.isFinite(number)) return "selected";
  if (number === 365) return "1 Year";
  if (number === 1) return "1 Day";
  return `${number} Days`;
}

function formatDateOnly(time) {
  if (!Number.isFinite(time)) return "--";
  return new Date(time).toISOString().slice(0, 10);
}

function formatTimeOnly(time) {
  if (!Number.isFinite(time)) return "--";
  return new Date(time).toISOString().slice(11, 16);
}

function formatOptional(value) {
  return value ? value : "Not available";
}

function formatMode(value) {
  if (!value) return "";
  return String(value)
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
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

function updateAnalysisConfigDescription() {
  const sortLabel = getSortLabel(state.sort);
  const limitLabelEl = document.getElementById("analysisLimitLabel");
  if (limitLabelEl) {
    limitLabelEl.textContent = `Rows from ${sortLabel}`;
  }

  const filtersDesc = getActiveFiltersDescription();
  elements.analysisConfig.textContent = `Selection: ${sortLabel}; filters: ${filtersDesc}. Positive funding: longs pay shorts. APR is a signed hourly-rate annualization, not realized P&L. Score combines absolute APR, direction consistency and volatility; only complete history is ranked.`;
}

function setAnalysisStatus(text) {
  elements.analysisStatus.textContent = text;
}

function getHistoryCacheKey(symbol, days) {
  return `${HISTORY_CACHE_PREFIX}.${days}.${symbol}`;
}

function readHistoryCache(key, nonemptyTtl = HISTORY_CACHE_TTL_MS) {
  try {
    const cached = JSON.parse(localStorage.getItem(key) || "null");
    if (!cached || !Array.isArray(cached.data) || !Number.isFinite(cached.savedAt)) return null;
    const ttl = cached.data.length ? nonemptyTtl : EMPTY_HISTORY_CACHE_TTL_MS;
    if (Date.now() - cached.savedAt > ttl) return null;
    return cached;
  } catch {
    return null;
  }
}

function writeHistoryCache(key, data) {
  try {
    localStorage.setItem(key, JSON.stringify({ savedAt: Date.now(), data }));
  } catch {
    // The browser's small localStorage quota can fill on long windows. Remove
    // the oldest history entries before giving up on this best-effort cache.
    const oldKeys = Object.keys(localStorage)
      .filter((candidate) => candidate.startsWith("hyperFunding.history.") && candidate !== key)
      .map((candidate) => {
        try { return { key: candidate, savedAt: Number(JSON.parse(localStorage.getItem(candidate) || "null")?.savedAt) || 0 }; }
        catch { return { key: candidate, savedAt: 0 }; }
      })
      .sort((a, b) => a.savedAt - b.savedAt);
    for (const entry of oldKeys) {
      localStorage.removeItem(entry.key);
      try { localStorage.setItem(key, JSON.stringify({ savedAt: Date.now(), data })); return; } catch { /* try more space */ }
    }
  }
}

function clearHistoryCache() {
  Object.keys(localStorage)
    .filter((key) => key.startsWith("hyperFunding.history."))
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
  if (value == null || value === "") return NaN;
  const number = Number(value);
  return Number.isFinite(number) ? number : NaN;
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
elements.cancelAnalysisButton.addEventListener("click", () => cancelBatchAnalysis());
elements.clearHistoryCacheButton.addEventListener("click", clearHistoryCache);
elements.autoRefreshToggle.addEventListener("change", scheduleRefresh);

// Market Board table interaction
elements.fundingRows.addEventListener("click", (event) => {
  const analyzeButton = event.target.closest("[data-analyze-symbol]");
  if (analyzeButton) {
    openSymbolAnalysis(analyzeButton.dataset.analyzeSymbol);
    return;
  }
  const row = event.target.closest("tr[data-symbol]");
  if (!row) return;
  
  const symbol = row.dataset.symbol;
  selectSymbol(symbol, true);
});

// Batch Analytics comparison table row click -> select and switch view
elements.analysisRows.addEventListener("click", (event) => {
  const analyzeButton = event.target.closest("[data-analyze-symbol]");
  if (analyzeButton) {
    openSymbolAnalysis(analyzeButton.dataset.analyzeSymbol, Number(elements.historyWindowSelect.value));
    return;
  }
  const row = event.target.closest("tr[data-symbol]");
  if (!row) return;
  const match = state.rows.find(r => r.symbol === row.dataset.symbol);
  if (match) {
    selectSymbol(match.symbol, true);
    switchTab("viewMarketBoard");
  }
});

elements.sortSelect.addEventListener("change", (event) => {
  cancelBatchAnalysis("Sort changed; run analysis again");
  state.sort = event.target.value;
  render();
});

elements.historyWindowSelect.addEventListener("change", () => {
  cancelBatchAnalysis("Window changed; run analysis again");
});
elements.analysisLimitSelect.addEventListener("change", () => cancelBatchAnalysis("Limit changed; run analysis again"));

// Detail Panel History Window Selector listener
elements.detailHistoryWindowSelect.addEventListener("change", (event) => {
  if (state.selectedSymbol) {
    loadHistoryData(state.selectedSymbol, Number(event.target.value));
  }
});

elements.searchInput.addEventListener("input", (event) => {
  cancelBatchAnalysis("Search changed; run analysis again");
  state.search = event.target.value;
  render();
});

elements.minVolumeInput.addEventListener("input", (event) => {
  cancelBatchAnalysis("Volume filter changed; run analysis again");
  state.minVolume = Number(event.target.value) || 0;
  render();
});

elements.minOiInput.addEventListener("input", (event) => {
  cancelBatchAnalysis("Open interest filter changed; run analysis again");
  state.minOi = Number(event.target.value) || 0;
  render();
});

elements.directionButtons.forEach((button) => {
  button.addEventListener("click", () => {
    cancelBatchAnalysis("Direction changed; run analysis again");
    state.direction = button.dataset.direction;
    elements.directionButtons.forEach((item) => item.classList.toggle("active", item === button));
    render();
  });
});

// Navigation Tabs
elements.tabMarkets.addEventListener("click", () => switchTab("viewMarketBoard"));
elements.tabAnalytics.addEventListener("click", () => switchTab("viewBatchAnalytics"));
elements.tabSymbolAnalysis.addEventListener("click", () => {
  const symbol = state.symbolAnalysisSymbol || state.selectedSymbol || elements.symbolAnalysisSelect.value;
  if (symbol) openSymbolAnalysis(symbol);
  else switchTab("viewSymbolAnalysis");
});
elements.symbolAnalysisSelect.addEventListener("change", analyzeSelectedSymbol);
elements.symbolHistoryWindowSelect.addEventListener("change", analyzeSelectedSymbol);
elements.analyzeSymbolButton.addEventListener("click", analyzeSelectedSymbol);
elements.symbolPrevPage.addEventListener("click", () => {
  state.symbolAnalysisPage -= 1;
  renderSymbolHistoryTable();
});
elements.symbolNextPage.addEventListener("click", () => {
  state.symbolAnalysisPage += 1;
  renderSymbolHistoryTable();
});

// Initial Run
fetchMarkets();
scheduleRefresh();
