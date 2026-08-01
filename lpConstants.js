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
export const AIRDROP_ATA_RENT_SOL = 0.00203928;
export const AIRDROP_TX_FEE_SOL = 0.000005;
export const AIRDROP_RECIPIENTS_PER_TX = 10;

export function estimateAirdropExecutionCostSol(recipientCount) {
  const count = Math.max(0, Math.floor(Number(recipientCount) || 0));
  if (!count) return 0;
  return (count * AIRDROP_ATA_RENT_SOL)
    + (Math.ceil(count / AIRDROP_RECIPIENTS_PER_TX) * AIRDROP_TX_FEE_SOL);
}
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

// Fallback SOL-USD price when oracle is unavailable.
export const FALLBACK_SOL_USD = 200;

// Well-known mint addresses.
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
