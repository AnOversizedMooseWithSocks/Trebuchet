// lpConstants.js
//
// Cost and sizing constants shared between lpService.js (the Raydium CLMM
// orchestrator) and lpEstimate.js (the funding estimator). Extracted from
// lpService.js so each module stays focused and the constants can be tested
// in isolation.

// Per-account rent costs (in SOL). These are reasonably stable on-chain
// rents for the account types involved.
export const COST_POOL_RENT_SOL    = 0.062;
// Rent to initialise one CLMM tick array measures 0.07216 SOL on-chain. A
// full-preset funding audit showed the prior flat 0.072 left the per-array
// budget a hair under actual, leaning on the 20% safety buffer to cover the
// gap. Rounding up to 0.0722 covers the measured rent with a sliver of margin,
// so the buffer stays pure margin rather than load-bearing.
export const COST_TICK_ARRAY_SOL   = 0.0722;
export const COST_POSITION_SOL     = 0.022;
export const COST_LOCK_SOL         = 0.005;
export const COST_TRANSFER_SOL     = 0.005;
export const COST_BS_QUOTE_SOL     = 0.001;
export const COST_TX_BUFFER_SOL    = 0.001;
export const COST_TOKEN_CREATE_SOL = 0.05;
// Permanent launch report (Arweave) publish cost.
//
// The report — the rendered HTML plus a small JSON record — is posted to Arweave
// via Irys, signed by the launch wallet. Arweave is priced per byte and is very
// cheap, so the real cost is a small fraction of a cent. We compute it as
// (representative report size) x (per-byte price) rather than guessing a flat
// number. At ~128 KB and Arweave's going rate this lands well under 0.0001 SOL —
// effectively negligible, and small reports may even fall under Irys's free
// threshold. Tune these two inputs if Arweave/SOL move materially, or replace the
// product with a live lookup (GET https://node1.irys.xyz/price/solana/<bytes>,
// which returns lamports) for byte-exact pricing.
export const LAUNCH_REPORT_EST_BYTES = 131072;     // ~128 KB: HTML (with a modest embedded logo) + JSON
export const ARWEAVE_LAMPORTS_PER_BYTE = 0.06;     // conservative; ~$7/GiB at ~$150/SOL
export const COST_LAUNCH_REPORT_SOL = (LAUNCH_REPORT_EST_BYTES * ARWEAVE_LAMPORTS_PER_BYTE) / 1e9;
export const SAFETY_BUFFER_PCT     = 0.20;

// Bootstrap budget: $1 worth of quote token (USD-denominated).
export const BS_BOOTSTRAP_USD = 1;

// Auto-swap acquire target (USD). Oversized 2x over actual need.
export const AUTOSWAP_TARGET_USD = 2;

// Fallback whole-unit amount when no USD price is available.
export const BS_FALLBACK_WHOLE = 0.01;

// SOL spend multiplier for auto-swap sizing.
export const AUTOSWAP_SIZING_MULTIPLIER = 2;

// Custom-mode multipliers — dialed back from minimal-mode defaults.
export const AUTOSWAP_CUSTOM_TARGET_MULTIPLIER = 1.15;
export const AUTOSWAP_CUSTOM_SIZING_MULTIPLIER = 1.10;

// Minimum share of a pool's supply that must stay in the wide "main"
// position — the one that spans from just above the launch price to the top
// of the tick range. It is the pool's continuous base layer. Ladder and
// custom bands are discrete ranges stacked ON TOP of it; if they consume
// the entire supply, the pool has zero liquidity between bands and above
// the top band. In a CLMM, price teleports across a zero-liquidity range on
// the first trade with nothing to swap against — effectively untradeable
// there. A thin base is enough: it only needs to exist at every price so
// the bands are the *bulk* of the supply, never the *only* supply.
// 0.5% of the pool's supply, expressed in basis points.
export const MIN_WIDE_BASE_BPS = 50;

// Fallback SOL-USD price when oracle is unavailable.
export const FALLBACK_SOL_USD = 200;

// Minimum USD liquidity that must back an aggregator-sourced quote-token
// price before it may be used to set a pool's STARTING price.
//
// Rationale: the starting price fixes the launch market cap, and it is
// computed as launchedTokenUsd / quoteUsd. For an unverified low-cap quote
// token the aggregators will happily report a price derived from a pool
// holding a few dollars — a number that reflects the last tiny trade, not
// a market. Using it puts that pool at a different market cap than its
// siblings; arbitrage then drains the cheap side the moment trading opens
// and the chart shows an immediate crash.
//
// $10k is deliberately modest: it admits genuinely small but real markets
// while excluding dust pools. Users who know better can still proceed by
// setting an explicit price override.
export const MIN_QUOTE_LIQUIDITY_USD = 10_000;

// Maximum price impact (percent) the Raydium price probe may report before
// its price is refused as a launch reference. Same problem as the
// aggregator liquidity floor above, on the OTHER (and first-tried) path:
// the probe swaps a small fixed SOL notional; a real market absorbs it
// with a fraction of a percent of impact, a dust pool shows tens of
// percent. 5% is generous for the probe size and still catches the
// dust-pool case decisively.
export const MAX_PROBE_PRICE_IMPACT_PCT = 5;

// Well-known mint addresses.
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
