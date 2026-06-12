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
- Cache history responses in `localStorage` for 6 hours.

## Next Scope

- Add `l2Book` depth and slippage checks.
- Join broker-side quote, shortable, borrow-fee, and margin data for real net-yield evaluation.
