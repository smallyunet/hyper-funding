# Hyper Funding Panel

Professional funding-rate dashboard for Hyperliquid XYZ markets.

## Run

Open `index.html` directly, or serve the folder with any static server:

```sh
python3 -m http.server 8080
```

The page calls Hyperliquid's public `info` endpoint from the browser:

```json
{ "type": "metaAndAssetCtxs", "dex": "xyz" }
```

## Current Scope

- List all XYZ market funding rates.
- Sort by funding, APR estimate, volume, open interest, and basis.
- Filter by symbol, funding direction, minimum 24h volume, and minimum open interest.
- Export the currently filtered table as CSV.
- Auto refresh every 30 seconds.
- Browser-side history analysis with `fundingHistory`.
- Score selected or top-ranked markets by average funding, volatility, direction consistency, and estimated APR.
- Open Symbol Analysis from either market table for one market's historical summary, hourly funding, running-average APR, cumulative funding chart, and paginated hourly samples.
- Show requested versus available hourly coverage; only complete windows qualify for score ranking.
- Limit funding-history requests with a conservative rolling API weight budget; cache current windows for 5 minutes, empty responses for 1 minute, and completed 480-hour chunks for 24 hours.

Symbol Analysis uses the same historical summary formula as Batch Analytics: average hourly funding multiplied by 8,760 for an estimated annual rate. The running APR line applies that formula to all samples available up to each timestamp. The cumulative funding line sums signed hourly rates from the first available sample without compounding. These are historical rate summaries, not simulated trades or realized returns.

Positive funding is paid by longs to shorts. The signed APR does not include position direction, basis, fees, borrow cost, or trading P&L. History responses are browser-local snapshots with their collection time shown in the UI.

## Next Scope

- Add `l2Book` depth and slippage checks.
- Join broker-side quote, shortable, borrow-fee, and margin data for real net-yield evaluation.
