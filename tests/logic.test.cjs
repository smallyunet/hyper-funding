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
