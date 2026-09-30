const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8')
  .replace(/\/\/ Initial Run\s+fetchMarkets\(\);\s+scheduleRefresh\(\);\s*$/, '');
const nodes = new Map();
function node(id) {
  if (!nodes.has(id)) nodes.set(id, {
    value: '', textContent: '', innerHTML: '', disabled: false, dataset: {}, style: {},
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {}, setAttribute() {},
  });
  return nodes.get(id);
}
const storage = new Map();
const context = vm.createContext({
  document: { getElementById: node, querySelectorAll: () => [] },
  localStorage: { getItem: (key) => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key) },
  window: {}, console, setTimeout, clearTimeout, setInterval, clearInterval,
  Date, Number, Math, Map, Set, Promise, Intl, DOMException, AbortController,
});
vm.runInContext(source, context);
const run = (code) => vm.runInContext(code, context);

test('missing numeric fields stay missing, and basis never falls back to premium', () => {
  const rows = run(`normalizeRows([{name:'xyz:A'}, {name:'xyz:B'}], [
    {funding:'0.0001', premium:'0.05', markPx:'2', oraclePx:'1'},
    {funding:null, markPx:'1', oraclePx:'1'}
  ])`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].basis, 1);
  assert.ok(Number.isNaN(run("toNumber(null)")));
  assert.ok(Number.isNaN(run("normalizeRows([{name:'xyz:A'}], [{funding:'0',premium:'0.05'}])[0].basis")));
  assert.throws(() => run("normalizeRows([{name:'xyz:A'}], [])"), /misaligned/);
});

test('coverage rejects short or gapped history and accepts a full recent window', () => {
  const now = Date.now();
  const hour = 3600000;
  context.__now = now;
  const full = Array.from({length: 168}, (_, i) => ({time: now - (167 - i) * hour, fundingRate: '0.0001'}));
  context.__history = full;
  const complete = run("getHistoryCoverage(summarizeFundingHistory('xyz:A', __history), 7)");
  assert.equal(complete.complete, true);
  context.__history = full.filter((_, i) => i % 2 === 0);
  const gapped = run("getHistoryCoverage(summarizeFundingHistory('xyz:A', __history), 7)");
  assert.equal(gapped.complete, false);
  context.__history = full.slice(-24);
  const short = run("getHistoryCoverage(summarizeFundingHistory('xyz:A', __history), 7)");
  assert.equal(short.complete, false);
});

test('empty cache expires earlier than populated history', () => {
  run("writeHistoryCache('empty', []); writeHistoryCache('full', [{time:1,fundingRate:'0'}])");
  const empty = JSON.parse(storage.get('empty'));
  const full = JSON.parse(storage.get('full'));
  empty.savedAt -= 61000;
  full.savedAt -= 61000;
  storage.set('empty', JSON.stringify(empty));
  storage.set('full', JSON.stringify(full));
  assert.equal(run("readHistoryCache('empty')"), null);
  assert.ok(run("readHistoryCache('full')"));
});

test('cumulative funding sums signed hourly rates while APR annualizes their running mean', () => {
  context.__history = [
    { time: 1, fundingRate: '0.0001' },
    { time: 2, fundingRate: '-0.0002' },
    { time: 3, fundingRate: '0.0003' },
  ];
  const points = run('buildSymbolAnalysisPoints(__history)');
  assert.ok(Math.abs(points[1].cumulativeRate - -0.0001) < 1e-12);
  assert.ok(Math.abs(points[2].cumulativeRate - 0.0002) < 1e-12);
  assert.ok(Math.abs(points[2].runningApr - 0.0002 / 3 * 8760) < 1e-12);
});

test('older batch result cannot overwrite a cancelled run', async () => {
  node('historyWindowSelect').value = '7';
  node('analysisProgressWrapper').classList = { add() {}, remove() {} };
  run("state.rows = [{symbol:'xyz:A',displaySymbol:'A'}]; state.filteredRows = state.rows");
  context.fetch = () => new Promise(() => {});
  const pending = run("analyzeSymbols(['xyz:A'])");
  run("cancelBatchAnalysis('changed')");
  await pending;
  assert.equal(run('state.analysisRows.length'), 0);
  assert.equal(node('analysisStatus').textContent, 'changed');
});

test('simulator separates verified xStocks from same-ticker reference markets', () => {
  context.__spot = [{ universe: [
    {name:'@702',index:702,tokens:[2,0]},
    {name:'@706',index:706,tokens:[3,0]},
    {name:'@713',index:713,tokens:[4,0]},
    {name:'@1',index:1,tokens:[5,0]},
    {name:'@266',index:266,tokens:[6,0]},
  ], tokens: [
    {index:0,name:'USDC',isCanonical:true},
    {index:2,name:'NVDAX',tokenId:'0x8e3a7531199e3f0d6e616a1f9edae9a3',fullName:'Wrapped NVIDIA xStock',szDecimals:2},
    {index:3,name:'MUX',tokenId:'0x6679db5a5be138456cf95b1fc7e870a5',fullName:'Wrapped Micron Technology xStock',szDecimals:2},
    {index:4,name:'AAPLX',tokenId:'0xc7fe8485e778ce51cf9df81a1c84bfea',fullName:'Wrapped Apple xStock',szDecimals:2},
    {index:5,name:'NVDAX',tokenId:'imposter',fullName:'Wrapped NVIDIA xStock',szDecimals:2},
    {index:6,name:'GOOGL',tokenId:'0xba48f5724be19bf0b127bb4c7fbeb9db',szDecimals:2},
  ] }, [
    {coin:'@706',midPx:'1065',dayNtlVlm:'20000'},
    {coin:'@713',midPx:null,dayNtlVlm:'0'},
    {coin:'@702',midPx:'230',dayNtlVlm:'20000'},
    {coin:'@1',midPx:'230',dayNtlVlm:'1000000'},
    {coin:'@266',midPx:'339',dayNtlVlm:'0'},
  ]];
  context.__perp = [{ universe: [
    {name:'xyz:NVDA',szDecimals:2}, {name:'xyz:MU',szDecimals:2}, {name:'xyz:AAPL',szDecimals:2},
    {name:'NVDA',szDecimals:2}, {name:'xyz:GOOGL',szDecimals:2},
  ] }, [{midPx:'231'}, {midPx:'1066'}, {midPx:'330'}, {midPx:'230'}, {midPx:'339'}]];
  const pairs = run('findSimulatorPairs(__spot,__perp)');
  assert.deepEqual(Array.from(pairs, (pair) => pair.perp), ['xyz:NVDA', 'xyz:MU', 'xyz:GOOGL', 'xyz:AAPL']);
  assert.equal(pairs.find((pair) => pair.perp === 'xyz:NVDA').spotCoin, '@702');
  assert.match(pairs.find((pair) => pair.spotToken === 'AAPLX').reason, /No current midpoint/);
  assert.equal(pairs.find((pair) => pair.spotToken === 'GOOGL').eligible, true);
  assert.match(pairs.find((pair) => pair.spotToken === 'GOOGL').warning, /underlying unverified/);
  assert.match(pairs.find((pair) => pair.spotToken === 'GOOGL').warning, /No spot trades/);
  context.__pairs = pairs;
  const options = run('renderSimulatorPairOptions(__pairs)');
  assert.match(options, /<optgroup label="Midpoint scenario available">/);
  assert.match(options, /<optgroup label="No two-sided midpoint">/);
  assert.equal((options.match(/<option /g) || []).length, pairs.length);
  assert.match(options, /value="@266"[^>]*>GOOGL/);
  run("renderSimulatorPairList(__pairs, '@702')");
  const pairRows = node('simPairRows').innerHTML;
  assert.match(pairRows, /https:\/\/app\.hyperliquid\.xyz\/trade\/NVDAX\/USDC/);
  assert.match(pairRows, /https:\/\/app\.hyperliquid\.xyz\/trade\/xyz%3ANVDA/);
  assert.match(pairRows, /https:\/\/app\.hyperliquid\.xyz\/trade\/AAPLX\/USDC/);
  assert.equal((pairRows.match(/>Spot ↗<\/a>/g) || []).length, pairs.length);
  assert.equal((pairRows.match(/>Perp ↗<\/a>/g) || []).length, pairs.length);
  context.__spot[0].tokens[1].tokenId = 'wrong-token';
  assert.deepEqual(Array.from(run('findSimulatorPairs(__spot,__perp)'), (pair) => pair.perp), ['xyz:MU', 'xyz:GOOGL', 'xyz:AAPL']);
});

test('midpoint simulator charges four fees and replays signed short funding', () => {
  context.__points = [{time:1,rate:0.01,cumulativeRate:0.01},{time:2,rate:-0.005,cumulativeRate:0.005}];
  const result = run('modelFundingArbitrage(__points,100,101,1000,0.001,0.002,0)');
  assert.equal(result.quantity, 4);
  assert.equal(result.spotEntry, 400);
  assert.equal(result.spotExit, 400);
  assert.equal(result.perpEntry, 404);
  assert.equal(result.perpExit, 404);
  assert.ok(Math.abs(result.entryFees - 1.208) < 1e-9);
  assert.ok(Math.abs(result.exitFees - 1.208) < 1e-9);
  assert.equal(result.pricePnl, 0);
  assert.ok(Math.abs(result.fundingUsd - 2.02) < 1e-9);
  assert.ok(Math.abs(result.netUsd - (2.02 - 1.208 * 2)) < 1e-9);
  assert.ok(result.curve[0].netUsd > result.curve[1].netUsd);
});

test('exit basis convergence changes price P&L and exit perp fee', () => {
  context.__points = [{time:1,rate:0.01,cumulativeRate:0.01}];
  const unchanged = run('modelFundingArbitrage(__points,100,90,1000,0.001,0.002,0)');
  const converged = run('modelFundingArbitrage(__points,100,90,1000,0.001,0.002,0,0)');
  assert.equal(converged.quantity, 4);
  assert.equal(unchanged.pricePnl, 0);
  assert.equal(converged.perpExit, 400);
  assert.equal(converged.pricePnl, -40);
  assert.ok(Math.abs(converged.exitFees - 1.2) < 1e-9);
  assert.ok(Math.abs(converged.netUsd - (3.6 - converged.entryFees - 1.2 - 40)) < 1e-9);
  const widened = run('modelFundingArbitrage(__points,100,90,1000,0.001,0.002,0,-0.2)');
  assert.equal(widened.pricePnl, 40);
  assert.throws(() => run('modelFundingArbitrage(__points,100,90,1000,0.001,0.002,0,-1)'), /exit gap/);
});

test('scenario APR annualizes net capital return over elapsed replay hours including the first funding hour', () => {
  const hour = 3600000;
  context.__aprFirst = hour;
  context.__aprLast = 168 * hour;
  const weekly = run('annualizeScenarioReturn(-0.000633,__aprFirst,__aprLast)');
  assert.equal(weekly.hours, 168);
  assert.ok(Math.abs(weekly.apr - (-0.000633 * 365 / 7)) < 1e-12);
  assert.equal(run('annualizeScenarioReturn(0.01,3600000,3600000).hours'), 1);
  assert.equal(run('annualizeScenarioReturn(0.01,3600000,10800000).hours'), 3);
  assert.equal(run('annualizeScenarioReturn(0,3600000,10800000).apr'), 0);
  assert.equal(run('annualizeScenarioReturn(0.1,3600000,31536000000).apr'), 0.1);
  assert.ok(Number.isNaN(run('annualizeScenarioReturn(0.1,2,1).apr')));
  assert.ok(Number.isNaN(run('annualizeScenarioReturn(0.1,NaN,1).apr')));
});

test('fee details reconcile both legs and show the selected exit price and basis', () => {
  run(`
    __detailMarket = {spotMid:100,perpMid:90};
    __detailResult = modelFundingArbitrage([{time:1,rate:0.01,cumulativeRate:0.01}],100,90,1000,0.001,0.002,0,0.05);
    renderSimulatorCalculationDetails(__detailResult,__detailMarket,0.001,0.002,'custom');
  `);
  const result = run('__detailResult');
  assert.equal(result.spotEntryFee + result.perpEntryFee, result.entryFees);
  assert.equal(result.spotExitFee + result.perpExitFee, result.exitFees);
  assert.match(node('simEntryDetails').innerHTML, /Spot buy fee: \$0\.4000/);
  assert.match(node('simEntryDetails').innerHTML, /Perp short-open fee: \$0\.7200/);
  assert.match(node('simExitDetails').innerHTML, /Perp short-close fee: \$0\.8400/);
  assert.match(node('simBasisDetails').innerHTML, /Custom exit gap/);
  assert.match(node('simBasisDetails').innerHTML, /\(105\.00000000 − 100\.00000000\) ÷ 100\.00000000/);
  assert.match(node('simPnlDetails').textContent, /-\$60\.00/);
  run('resetSimulator()');
  for (const id of ['simEntryDetails', 'simExitDetails', 'simBasisDetails']) {
    assert.doesNotMatch(node(id).textContent, /105|0\.8400/);
  }
  assert.equal(node('simPnlDetails').textContent, 'P&L calculation: --');
  assert.equal(node('simApr').textContent, '--');
  assert.equal(node('simAprDetails').textContent, 'APR calculation: --');
});

test('chart applies entry costs at open and exit costs after the last funding sample', () => {
  context.__points = [{time:3600000,rate:0.01,cumulativeRate:0.01},{time:7200000,rate:0.005,cumulativeRate:0.015}];
  const result = run('modelFundingArbitrage(__points,100,90,1000,0.001,0.002,0,0)');
  context.__result = result;
  const timeline = run('buildSimulatorChartTimeline(__result)');
  assert.deepEqual(Array.from(timeline, (point) => point.kind), ['beforeOpen','open','sample','sample','close']);
  assert.equal(timeline[0].pnlUsd, 0);
  assert.equal(timeline[1].pnlUsd, -result.entryFees);
  assert.ok(Math.abs(timeline[2].pnlUsd - (result.curve[0].fundingUsd - result.entryFees)) < 1e-9);
  assert.ok(Math.abs(timeline[3].pnlUsd - (result.fundingUsd - result.entryFees)) < 1e-9);
  assert.equal(timeline[4].pnlUsd, result.netUsd);
  assert.ok(Math.abs(timeline[4].pnlUsd - timeline[3].pnlUsd - (result.pricePnl - result.exitFees)) < 1e-9);
  assert.equal(timeline[1].rate, null);
  assert.equal(timeline[4].rate, null);
});

test('midpoint simulator requires both prices and a tradable size increment', () => {
  context.__points = [{time:1,rate:0,cumulativeRate:0}];
  assert.throws(() => run('modelFundingArbitrage(__points,0,100,1000,0,0,0)'), /capital/);
  assert.throws(() => run('modelFundingArbitrage(__points,10000,10000,1000,0,0,0)'), /size increment/);
});

test('native crypto and classified XYZ markets keep distinct identities and omit delisted assets', () => {
  run("state.marketMetadata.categories = new Map([['xyz:NVDA','stocks'],['xyz:GOLD','commodities'],['xyz:EUR','FX']])");
  const rows = run(`normalizeRows([{name:'BTC'}, {name:'OLD',isDelisted:true}], [{funding:'0'},{funding:'0'}], '')`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].symbol, 'BTC');
  assert.equal(rows[0].category, 'crypto');
  assert.equal(run("marketCategory('xyz:NVDA')"), 'stocks');
  assert.equal(run("marketCategory('xyz:GOLD')"), 'commodities');
  assert.equal(run("marketCategory('xyz:EUR')"), 'fx');
  assert.equal(run("marketCategory('xyz:NEW')"), 'other');
});

test('category filtering feeds market board and symbol selector without mixing stocks or commodities', () => {
  run(`state.rows = [{symbol:'BTC',displaySymbol:'BTC',category:'crypto',funding:0.01},
    {symbol:'xyz:NVDA',displaySymbol:'NVDA',category:'stocks',funding:0.02},
    {symbol:'xyz:GOLD',displaySymbol:'GOLD',category:'commodities',funding:0.03}];
    state.assetType = 'crypto'; state.search = ''; state.direction = 'all'; state.minVolume = 0; state.minOi = 0;
    renderSymbolOptions();`);
  assert.deepEqual(Array.from(run('applyFiltersAndSort()'), row => row.symbol), ['BTC']);
  assert.match(node('symbolAnalysisSelect').innerHTML, /BTC/);
  assert.doesNotMatch(node('symbolAnalysisSelect').innerHTML, /NVDA|GOLD/);
  run("state.assetType = 'all'");
});

test('crypto simulator maps Unit Bitcoin to BTC by token identity and context coin, rejecting impostors', () => {
  context.__cryptoSpot = [{universe:[{name:'@142',index:142,tokens:[1,0]}, {name:'@999',index:999,tokens:[2,0]}],tokens:[
    {index:0,name:'USDC',isCanonical:true},
    {index:1,name:'UBTC',tokenId:'0x8f254b963e8468305d409b33aa137c67',fullName:'Unit Bitcoin',szDecimals:5},
    {index:2,name:'UBTC',tokenId:'impostor',fullName:'Unit Bitcoin',szDecimals:5}
  ]}, [{coin:'@999',midPx:'1'},{coin:'@142',midPx:'83000',dayNtlVlm:'1000'}]];
  context.__native = [{universe:[{name:'BTC',szDecimals:5}]},[{funding:'0.0001',midPx:'83100'}]];
  const pairs = run('findSimulatorPairs(__cryptoSpot, [{universe:[]},[]], __native)');
  assert.equal(pairs.length, 1);
  assert.equal(pairs[0].perp, 'BTC');
  assert.equal(pairs[0].spotCoin, '@142');
  assert.equal(pairs[0].category, 'crypto');
  assert.equal(pairs[0].perpMid, 83100);
  assert.equal(pairs[0].eligible, true);
  assert.match(pairs[0].warning, /wrapper/);
  run("state.assetType = 'stocks'");
  assert.equal(run('findSimulatorPairs(__cryptoSpot, [{universe:[]},[]], __native).filter(matchesAssetType).length'), 0);
  run("state.assetType = 'all'");
});

test('a failed market source keeps the last complete snapshot and marks it stale', async () => {
  run("state.rows = [{symbol:'BTC',displaySymbol:'BTC',category:'crypto',funding:0.01}]; state.filteredRows = state.rows; state.selectedSymbol = 'BTC'; state.loading = false; state.marketMetadata.loaded = true;");
  context.fetch = async (_url, request) => {
    const body = JSON.parse(request.body);
    if (body.dex === 'xyz') return {ok:false,status:503};
    return {ok:true,json:async () => [{universe:[{name:'ETH'}]},[{funding:'0.0001'}]]};
  };
  await run('fetchMarkets()');
  assert.equal(run('state.marketStale'), true);
  assert.equal(run('state.rows[0].symbol'), 'BTC');
  assert.equal(node('statusText').textContent, 'Stale data');
});

test('category changes invalidate all previous analysis and unlock cancelled simulator controls', () => {
  run("state.rows = []; state.filteredRows = []; state.selectedSymbol = null; state.activeView = 'viewMarketBoard'; state.simSnapshot = {}; state.analysisRows = []; state.symbolAnalysisPoints = [{time:1}];");
  node('simRunButton').disabled = true;
  const oldRequest = run('state.simRequest');
  run("setAssetType('commodities')");
  assert.equal(run('state.simSnapshot'), null);
  assert.equal(run('state.symbolAnalysisPoints.length'), 0);
  assert.equal(run('state.simRequest'), oldRequest + 1);
  assert.equal(node('simRunButton').disabled, false);
  assert.equal(node('symbolAnalysisTitle').textContent, 'Symbol Analysis');
  for (const id of ['assetTypeSelect','symbolAssetType','simAssetType']) assert.equal(node(id).value, 'commodities');
  run("state.assetType = 'all'");
});

test('batch result sorting retains complete-first ranking and independent highest-score summary', () => {
  run(`state.analysisRows = [
    {symbol:'BTC',displaySymbol:'BTC',complete:true,score:80,avgApr:0.1,avgFunding:0.1,volatility:0.1,directionHitRate:0.8,samples:168,expectedSamples:168,positiveCount:168,negativeCount:0},
    {symbol:'ETH',displaySymbol:'ETH',complete:true,score:20,avgApr:0.3,avgFunding:0.3,volatility:0.1,directionHitRate:0.8,samples:168,expectedSamples:168,positiveCount:168,negativeCount:0},
    {symbol:'SOL',displaySymbol:'SOL',complete:false,score:99,avgApr:0.5,avgFunding:0.5,volatility:0.1,directionHitRate:0.8,samples:10,expectedSamples:168,positiveCount:10,negativeCount:0}
  ]; state.analysisSort = 'apr-desc'; renderAnalysis();`);
  assert.deepEqual(Array.from(run('sortAnalysisRows(state.analysisRows)'), row => row.symbol), ['ETH','BTC','SOL']);
  assert.equal(node('bestScoreSymbol').textContent, 'BTC');
  assert.equal(node('bestAvgAprSymbol').textContent, 'ETH');
  assert.match(node('analysisRows').innerHTML, /coverage-badge partial/);
  run("state.analysisRows = []; state.analysisSort = 'score-desc'");
});
