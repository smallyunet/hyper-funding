# Hyper Funding Panel

Browser-only funding-rate dashboard for Hyperliquid native crypto perpetuals and XYZ markets.

## Run

Open `index.html` directly, or serve the folder with any static server:

```sh
python3 -m http.server 8080
```

The page calls Hyperliquid's public `info` endpoint from the browser, loading both native crypto and XYZ markets:

```json
{ "type": "metaAndAssetCtxs" }
{ "type": "metaAndAssetCtxs", "dex": "xyz" }
```

## Current Scope

- List active native crypto and XYZ perpetual funding rates; exclude delisted markets.
- Filter by asset category (Crypto, Stocks, Indices, Commodities, FX, Pre-IPO, Other / unknown), with synchronized selectors in Market Board, Symbol Analysis and Simulator. Stocks includes all officially classified stocks, not only US listings. CSV exports retain category and market source.
- Sort by funding, APR estimate, volume, open interest, and basis.
- Filter by symbol, funding direction, minimum 24h volume, and minimum open interest.
- Export the currently filtered table as CSV.
- Auto refresh every 30 seconds.
- Browser-side history analysis with `fundingHistory`.
- Score selected or top-ranked markets by average funding, volatility, direction consistency, and estimated APR.
- Open Symbol Analysis from either market table for one market's historical summary, hourly funding and cumulative funding chart, and paginated hourly samples.
- Choose a long-spot/short-perp midpoint scenario in the Arbitrage Simulator tab, with historical hourly funding, editable capital and taker fees, and an estimated net P&L curve.
- Show requested versus available hourly coverage; only complete windows qualify for score ranking.
- Limit funding-history requests with a conservative rolling API weight budget; cache current windows for 5 minutes, empty responses for 1 minute, and completed 480-hour chunks for 24 hours.

Symbol Analysis uses the same historical summary formula as Batch Analytics: average hourly funding multiplied by 8,760 for an estimated annual rate. The hourly samples table applies that formula to the running mean through each timestamp. The cumulative funding line sums signed hourly rates from the first available sample without compounding. These are historical rate summaries, not simulated trades or realized returns.

Positive funding is paid by longs to shorts. The signed APR does not include position direction, basis, fees, borrow cost, or trading P&L. History responses are browser-local snapshots with their collection time shown in the UI.

The simulator pairs pinned tokenized US stock xStock spots with corresponding XYZ stock perps: NVDA, MU, SNDK, TSLA, AAPL, and CRCL. It also lists ten pinned same-ticker spot/XYZ candidates for US stocks. Every candidate with a current midpoint price on both legs can be simulated regardless of spot volume, spread or order-book depth. The spot token ID, full name and USDC quote are checked to avoid accidental ticker collisions, but ticker-only pairs may still have a different underlying or unit and are labeled as such. The simulator additionally maps BTC to UBTC, ETH to UETH, SOL to USOL, and HYPE and PURR to their identified USDC spot tokens. These explicit mappings use equal token quantities; Unit tokens retain wrapper/redemption risk. Other crypto markets remain available in funding analysis even when no mapped spot leg exists. Indices, private companies and non-US stock pairs are excluded from the simulator. Tokenized stock redemption and spot/perp basis risk remain; matching midpoint prices do not prove an executable hedge.

The model reserves half of initial capital for spot and half for 1× perp margin, sizing equal token quantities at current midpoints and leaving any unused capital idle. The exit scenario holds the spot midpoint fixed and sets the perp exit midpoint from a selected target basis: current gap unchanged (default), zero gap, or a custom gap as a percent of the spot midpoint. Price P&L equals quantity times (entry perp-minus-spot gap minus exit gap). Four taker fees are applied to the entry and scenario exit notionals; changing the target gap also changes the modeled perp exit fee. Default fees are 0.07% spot and 0.045% perp, editable because account tiers differ. Short funding is modeled as the fixed current perp entry notional times each observed hourly funding rate. Net P&L is cumulative modeled funding plus scenario price P&L less entry and exit fees. Modeled net APR simply annualizes return on initial capital by multiplying it by 8,760 and dividing by elapsed replay hours, from one hour before the first funding sample through the last sample. This includes the first funding hour and retains missing hours in the duration for partial coverage, without estimating their funding. APR scales the entire net scenario, including its one-time fees and basis P&L; it does not compound or forecast future returns. The chart begins at zero immediately before a hypothetical open, drops by entry fees, then tracks funding less entry fees during the hold; a separate final point applies exit fees and basis P&L immediately after the last observed funding sample. The final point is a scenario, not an observed historical exit. Liquidity, bid/ask spread, slippage, other future price changes, and liquidation are omitted. It is not a historical execution, current account quote, future return, or realized P&L; incomplete history remains labeled partial.

Sources: [Hyperliquid spot metadata](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/spot), [perpetual contexts and funding history](https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint/perpetuals), [fees](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/fees), [funding](https://hyperliquid.gitbook.io/hyperliquid-docs/trading/funding), and [Unit tokenization](https://docs.hyperunit.xyz/).

Market refreshes load native and XYZ sources together. If either source fails or has misaligned metadata, the prior complete snapshot stays visible as stale. Official XYZ classifications are used when available; missing classifications remain Other / unknown. Native perps are classified as Crypto. Category changes cancel previous batch results and invalidate single-symbol and simulator results.

## Next Scope

- Extend the pinned spot-token registry when further liquid, identified spot markets and matching perps become available.
- Join account-specific fee and margin data for account-level estimates.
