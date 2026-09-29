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
    {coin:'@266',midPx:'339',dayNtlVlm:'20000'},
  ]];
  context.__perp = [{ universe: [
    {name:'xyz:NVDA',szDecimals:2}, {name:'xyz:MU',szDecimals:2}, {name:'xyz:AAPL',szDecimals:2},
    {name:'NVDA',szDecimals:2}, {name:'xyz:GOOGL',szDecimals:2},
  ] }, [{midPx:'231'}, {midPx:'1066'}, {midPx:'330'}, {midPx:'230'}, {midPx:'339'}]];
  const pairs = run('findSimulatorPairs(__spot,__perp)');
  assert.deepEqual(Array.from(pairs, (pair) => pair.perp), ['xyz:NVDA', 'xyz:MU', 'xyz:AAPL', 'xyz:GOOGL']);
  assert.equal(pairs.find((pair) => pair.perp === 'xyz:NVDA').spotCoin, '@702');
  assert.match(pairs.find((pair) => pair.spotToken === 'AAPLX').reason, /No live midpoint/);
  assert.equal(pairs.find((pair) => pair.spotToken === 'GOOGL').eligible, false);
  assert.match(pairs.find((pair) => pair.spotToken === 'GOOGL').reason, /underlying unverified/);
  context.__pairs = pairs;
  const options = run('renderSimulatorPairOptions(__pairs)');
  assert.match(options, /<optgroup label="Can simulate">/);
  assert.match(options, /<optgroup label="Reference only">/);
  assert.equal((options.match(/<option /g) || []).length, pairs.length);
  assert.match(options, /value="@266"[^>]*>GOOGL[^<]*View only/);
  context.__spot[0].tokens[1].tokenId = 'wrong-token';
  assert.deepEqual(Array.from(run('findSimulatorPairs(__spot,__perp)'), (pair) => pair.perp), ['xyz:MU', 'xyz:AAPL', 'xyz:GOOGL']);
});

test('simulator includes four book fills, four taker fees and signed short funding', () => {
  context.__points = [{time:1,rate:0.01,cumulativeRate:0.01},{time:2,rate:-0.005,cumulativeRate:0.005}];
  context.__spotBook = {bids:[{px:99,sz:100}],asks:[{px:100,sz:100}]};
  context.__perpBook = {bids:[{px:101,sz:100}],asks:[{px:102,sz:100}]};
  const result = run('modelFundingArbitrage(__points,__spotBook,__perpBook,1000,0.001,0.002,0)');
  assert.equal(result.quantity, 4);
  assert.equal(result.spotEntry, 400);
  assert.equal(result.spotExit, 396);
  assert.equal(result.perpEntry, 404);
  assert.equal(result.perpExit, 408);
  assert.ok(Math.abs(result.entryFees - 1.208) < 1e-9);
  assert.ok(Math.abs(result.exitFees - 1.212) < 1e-9);
  assert.equal(result.pricePnl, -8);
  assert.ok(Math.abs(result.fundingUsd - 2.02) < 1e-9);
  assert.ok(Math.abs(result.netUsd - (2.02 - 8 - 1.208 - 1.212)) < 1e-9);
  assert.ok(result.curve[0].netUsd > result.curve[1].netUsd);
});

test('simulator refuses an unfillable round trip', () => {
  context.__points = [{time:1,rate:0,cumulativeRate:0}];
  context.__spotBook = {bids:[{px:1,sz:0.1}],asks:[{px:2,sz:0.1}]};
  context.__perpBook = {bids:[{px:2,sz:0.1}],asks:[{px:3,sz:0.1}]};
  assert.throws(() => run('modelFundingArbitrage(__points,__spotBook,__perpBook,1000,0,0,0)'), /depth/);
});
