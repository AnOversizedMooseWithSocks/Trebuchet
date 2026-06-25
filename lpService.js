// lpService.js
//
// Handles Raydium CLMM pool and concentrated-liquidity position creation
// for the token launcher. Slots in between createTokenWithMetaplex and
// transferTokensAndSol as a new step in the existing flow.
//
// Per-launch flow (orchestrated by createPoolsAndPositions):
//   The flow is split into four phases so (a) no pool becomes tradable
//   while later pools are still being built, and (b) nothing is committed
//   for life until every position has been successfully opened. A pool
//   becomes tradable only when it has in-range liquidity — the bootstrap
//   position is what provides that. If we bootstrapped each pool
//   immediately after its main positions, a swap on the now-live first
//   pool could move its price while later pools — configured to launch
//   at the same USD price — are still being built, breaking their
//   economics. Likewise, if we locked positions inline with opening
//   them, a Phase-2 failure on (say) the third pool would leave the
//   first two pools' positions already burned-and-locked, with no way
//   to close-and-retry. Deferring all locking to Phase 3 means a
//   failure anywhere in Phase 1 or Phase 2 leaves every position
//   recoverable — the launch wallet can still close positions and the
//   user can adjust config before retrying.
//
//   Phase 1 — for each "allocation" entry the user configures, we:
//     1. Compute the initial pool price so the launched token's USD value
//        matches the target market cap.
//     2. createPool — initializes the CLMM pool at that price. No liquidity yet.
//     3. For each "slice" of the allocation's distribution: open a main
//        position with the slice's share of the supply, in a range that
//        keeps the position 100% launched-token initially.
//     4. If the allocation has ladder bands configured, open each band.
//     5. If the allocation has a support position configured, open it.
//
//     NO LOCKING happens in Phase 1. Positions stay closeable by the
//     launch wallet — important if a later phase fails and the user
//     needs to recover.
//
//   Phase 2 — once every pool's main positions are in place:
//     6. For each pool, open one bootstrap position straddling current
//        tick. This makes the pool tradable. Bootstrap is never split or
//        transferred — its Fee Key (after locking) stays with the
//        ephemeral wallet for the final sweep.
//
//        Within Phase 2, SOL-paired pools are deferred to the END of the
//        queue. Bots and aggregators index SOL pairs more aggressively
//        than flywheel/exotic quotes, so flipping the SOL pool to
//        tradable while flywheel pools are still being built would let
//        the first wave of SOL-paired trades miss the cascading
//        buy-pressure mechanism the launch was designed for. By
//        bootstrapping every flywheel before the SOL pool, the first
//        SOL-paired trade activates the flywheel as intended.
//
//        The last position opened in the entire launch is the SOL
//        bootstrap. NO LOCKING has happened yet — every position
//        opened in Phase 1 and Phase 2 is still closeable.
//
//   Phase 3 — once every position is open (lockAllPositions):
//     7. Lock every position via Burn & Earn. Each lock burns the
//        position NFT and mints a Fee Key NFT in its place. This is the
//        irreversibility line — after this, the LP'd tokens are
//        committed for life and only trading fees can be claimed.
//
//        Lock order mirrors the SOL-last ordering from Phase 2 (every
//        flywheel pool's positions locked before any SOL-pool position)
//        for visual coherence with the activity log; the lock order
//        itself doesn't affect tradability since the liquidity is
//        already in place from Phase 2.
//
//        Phase 3 is the FINAL phase that creates anything irreversible.
//        A failure in Phases 1 or 2 can be recovered from by closing
//        positions; a failure in Phase 3 leaves some positions locked
//        and others not, and the user retries the locks via the resume
//        flow.
//
//   Phase 4 — after Phase 3, if any slice has an external recipient
//     (transferFeeKeys):
//     8. For each such slice, transfer the Fee Key NFT minted by the
//        Phase 3 lock to the configured recipient. Slices without a
//        recipient keep their Fee Key in the ephemeral wallet for the
//        final sweep at the end of the launch. Bootstrap Fee Keys are
//        never transferred.
//
// Sequential execution within and across phases — failures are easy to
// recover from this way. On error we throw with partialResults and a
// failedPhase ('pre_flight', 'main_positions', 'bootstrap', 'locks',
// or 'transfers') attached.
//
// Mint-ordering note: Raydium pools have an internal canonical mintA/mintB
// ordering. The launched token may end up as either side depending on the
// quote token's pubkey. We detect this AFTER createPool returns and flip
// position-range geometry accordingly so the position always starts 100%
// launched-token regardless of which side it sorted to. See computeMainTicks.

import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
} from '@solana/web3.js';
import {
  Raydium,
  TxVersion,
  CLMM_PROGRAM_ID,
  LockClPositionLayoutV2,
} from '@raydium-io/raydium-sdk-v2';
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  unpackMint,
  getExtensionTypes,
  ExtensionType,
} from '@solana/spl-token';
import { transferTokenWithProgram } from './walletHelpers.js';
import { discoverRaydiumRoute, probeRaydiumPriceStrict } from './swapService.js';
import {
  computeBootstrapTicks,
  computeLadderTicks,
  computeLadderTicksManual,
  computeMainTicks,
  computeSupportTicks,
  SUPPORT_DEPTH_PCT_DEFAULT,
  driftExceedsThreshold,
  driftPercent,
  tickArrayStartIndex,
  TICK_ARRAY_SIZE,
} from './lpMath.js';
import BN from 'bn.js';
import Decimal from 'decimal.js';
import { getRpcUrl } from './rpcConfig.js';
// Token metadata + USD price helpers. Imported (not just re-exported below) so
// they're bound in THIS module's scope — estimateRequiredFunding and the quote
// USD lookups call getUsdPrice directly. A bare `export { ... } from` is only a
// re-export and would leave these undefined locally (which silently sent every
// SOL price into the fallback path).
import { getTokenMetadata, getUsdPrice } from './tokenInfoService.js';
import { normalizeDistribution } from './lpDistribution.js';
import {
  FALLBACK_FEE_TIERS,
  normalizeFeeTierList,
} from './lpFeeTiers.js';
import {
  classifyToken2022Extensions,
} from './lpMintCompat.js';
// Constants live in lpConstants.js as the single source of truth. We
// import rather than redefine so an update there can never silently
// diverge from a stale copy here.
//
// Note: the estimateRequiredFunding implementation in this file has
// substantially diverged from the parallel one in lpEstimate.js
// (different feature set, different math — production uses this one,
// the lpEstimate.js version has its own test suite). Unifying the
// functions is a larger refactor; consolidating just the constants is
// safe because the values currently agree byte-for-byte.
import {
  WSOL_MINT,
  FALLBACK_SOL_USD,
  COST_POOL_RENT_SOL,
  COST_TICK_ARRAY_SOL,
  COST_POSITION_SOL,
  COST_LOCK_SOL,
  COST_TRANSFER_SOL,
  COST_BS_QUOTE_SOL,
  COST_TX_BUFFER_SOL,
  COST_TOKEN_CREATE_SOL,
  COST_LAUNCH_REPORT_SOL,
  SAFETY_BUFFER_PCT,
  BS_BOOTSTRAP_USD,
  AUTOSWAP_TARGET_USD,
  BS_FALLBACK_WHOLE,
  AUTOSWAP_SIZING_MULTIPLIER,
  AUTOSWAP_CUSTOM_TARGET_MULTIPLIER,
  AUTOSWAP_CUSTOM_SIZING_MULTIPLIER,
} from './lpConstants.js';


// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// RPC URL is sourced from rpcConfig.js (which manages a persistent JSON config
// file plus runtime UI selection). We read it fresh inside initSdk() so that
// changing the active RPC mid-session takes effect on the next launch.

// Default Raydium AmmConfig index. Index 3 = 1% fee, tickSpacing 120 — the
// "exotic" tier. Matches the pattern used in past manual launches. Other
// tiers are available at runtime via raydium.api.getClmmConfigs():
//   index 0 = 0.25% fee, tickSpacing 60   (most volatile pairs)
//   index 1 = 0.05% fee, tickSpacing 10   (major pairs)
//   index 2 = 0.01% fee, tickSpacing 1    (stables)
//   index 3 = 1.00% fee, tickSpacing 120  (exotic / new tokens)  <-- default
const DEFAULT_AMM_CONFIG_INDEX = 3;

// Bootstrap funding: 1 whole token of each side. Just enough to make the
// pool tradable; intentionally negligible value.
const BOOTSTRAP_BASE_TOKENS_WHOLE = 1;

// Floor on the SOL allocation when a SOL pool is included. Aggregators
// (Jupiter, GeckoTerminal, etc.) work best with a non-trivial SOL pool.
const MIN_SOL_ALLOCATION_PCT = 1;

// F3: LP-path compute budget. The launch transactions used to hardcode a
// flat { units: 600_000, microLamports: 50_000 } in five places. A fixed
// priority fee under-pays during congestion (transactions expire — Raydium's
// own SDK guidance is to raise computeBudgetConfig when that happens) and
// over-pays when the chain is calm. These name the CU limit plus a floor and
// ceiling; lpComputeBudgetConfig() below samples recent on-chain fees and
// clamps into [floor, ceil]. The floor equals the old constant, so the calm-
// case fee never drops below previous behavior — it only rises under load.
const LP_COMPUTE_UNIT_LIMIT = 600_000;
const LP_PRIORITY_FEE_FLOOR_MICROLAMPORTS = 50_000;
const LP_PRIORITY_FEE_CEIL_MICROLAMPORTS = 1_000_000;

function lpErrorMessage(error) {
  if (typeof error?.message === 'string' && error.message.trim()) {
    return error.message;
  }
  if (typeof error === 'string' && error.trim()) return error;
  if (error == null) return 'Unknown error';
  try {
    const json = JSON.stringify(error);
    if (json && json !== '{}') return json;
  } catch (_) {
    // Fall through to String(error).
  }
  return String(error || 'Unknown error');
}

function lpErrorProgressFields(error) {
  return {
    error: lpErrorMessage(error),
    ...(error?.name ? { errorName: error.name } : {}),
    ...(error?.code ? { errorCode: error.code } : {}),
    ...(error?.signature ? { signature: error.signature } : {}),
    ...(error?.transactionMessage ? { transactionMessage: error.transactionMessage } : {}),
    ...(error?.instructionError ? { instructionError: error.instructionError } : {}),
    ...(error?.logs ? { logs: error.logs } : {}),
  };
}

function finiteNumberOr(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clonePositionArray(value) {
  return Array.isArray(value) ? value.map((item) => ({ ...item })) : [];
}

function phase1RecoveryEnabled(existingPool) {
  return !!(existingPool && existingPool.phase1Incomplete && existingPool.poolId);
}

function recoveredPositionTxIds(position) {
  return {
    open: position?.txIds?.open || position?.txId || null,
    lock: position?.txIds?.lock || null,
    transfer: position?.txIds?.transfer || null,
  };
}

function normalizeRecoveredMainPositions(existingPool, distribution, mainTicks) {
  const byIndex = new Map();
  for (const position of clonePositionArray(existingPool?.mainPositions)) {
    const sliceIndex = finiteNumberOr(position.sliceIndex, null);
    if (!Number.isInteger(sliceIndex) || sliceIndex < 0 || sliceIndex >= distribution.length) {
      throw new Error(
        `Cannot resume partial pool ${existingPool.poolId}: recorded main slice ` +
          `${position.sliceIndex} is outside the current distribution.`,
      );
    }
    if (!position.nftMint) {
      throw new Error(
        `Cannot resume partial pool ${existingPool.poolId}: recorded main slice ` +
          `${sliceIndex + 1} is missing its position NFT mint.`,
      );
    }
    byIndex.set(sliceIndex, {
      sliceIndex,
      sharePercent: finiteNumberOr(position.sharePercent, distribution[sliceIndex]?.sharePercent),
      tickLower: finiteNumberOr(position.tickLower, mainTicks.tickLower),
      tickUpper: finiteNumberOr(position.tickUpper, mainTicks.tickUpper),
      nftMint: position.nftMint,
      locked: position.locked === true,
      recipient: position.recipient || distribution[sliceIndex]?.recipient || null,
      transferredTo: position.transferredTo || null,
      feeKeyNftMint: position.feeKeyNftMint || null,
      txIds: recoveredPositionTxIds(position),
    });
  }
  return byIndex;
}

function normalizeRecoveredLadderPositions(existingPool, bandTicks) {
  const byIndex = new Map();
  for (const position of clonePositionArray(existingPool?.ladderPositions)) {
    const bandIndex = finiteNumberOr(position.bandIndex, null);
    if (!Number.isInteger(bandIndex) || bandIndex < 0 || bandIndex >= bandTicks.length) {
      throw new Error(
        `Cannot resume partial pool ${existingPool.poolId}: recorded ladder band ` +
          `${position.bandIndex} is outside the current ladder plan.`,
      );
    }
    if (!position.nftMint) {
      throw new Error(
        `Cannot resume partial pool ${existingPool.poolId}: recorded ladder band ` +
          `${bandIndex + 1} is missing its position NFT mint.`,
      );
    }
    byIndex.set(bandIndex, {
      bandIndex,
      tickLower: finiteNumberOr(position.tickLower, bandTicks[bandIndex].tickLower),
      tickUpper: finiteNumberOr(position.tickUpper, bandTicks[bandIndex].tickUpper),
      nftMint: position.nftMint,
      locked: position.locked === true,
      feeKeyNftMint: position.feeKeyNftMint || null,
      txIds: {
        open: position?.txIds?.open || position?.txId || null,
        lock: position?.txIds?.lock || null,
      },
    });
  }
  return byIndex;
}

function normalizeRecoveredSupportPositions(existingPool, supportTicks, depthPct) {
  const positions = clonePositionArray(existingPool?.supportPositions);
  if (positions.length > 1) {
    throw new Error(
      `Cannot resume partial pool ${existingPool.poolId}: recorded ${positions.length} ` +
        `support positions, but the current plan supports at most one.`,
    );
  }
  return positions.map((position, index) => {
    if (!position.nftMint) {
      throw new Error(
        `Cannot resume partial pool ${existingPool.poolId}: recorded support position ` +
          `${index + 1} is missing its position NFT mint.`,
      );
    }
    return {
      tickLower: finiteNumberOr(position.tickLower, supportTicks.tickLower),
      tickUpper: finiteNumberOr(position.tickUpper, supportTicks.tickUpper),
      depthPct: finiteNumberOr(position.depthPct, depthPct),
      quoteRaw: position.quoteRaw || position.quoteAmountRaw || null,
      nftMint: position.nftMint,
      locked: position.locked === true,
      feeKeyNftMint: position.feeKeyNftMint || null,
      txIds: {
        open: position?.txIds?.open || position?.txId || null,
        lock: position?.txIds?.lock || null,
      },
    };
  });
}

async function assertRecoveredPositionNftsOwned({
  connection,
  ownerPublicKey,
  poolId,
  positions,
}) {
  for (const position of positions) {
    if (!position || position.locked || !position.nftMint) continue;
    let mint;
    try {
      mint = new PublicKey(position.nftMint);
    } catch (_) {
      throw new Error(
        `Cannot resume partial pool ${poolId}: recorded position NFT ` +
          `${position.nftMint} is not a valid mint address.`,
      );
    }
    let resp;
    try {
      resp = await connection.getParsedTokenAccountsByOwner(ownerPublicKey, { mint });
    } catch (err) {
      throw new Error(
        `Cannot verify recorded position NFT ${position.nftMint} for pool ${poolId} ` +
          `(${lpErrorMessage(err)}). Retry when RPC can read token accounts.`,
      );
    }
    const owned = (resp?.value || []).some((acc) => {
      const info = acc?.account?.data?.parsed?.info;
      const amount = info?.tokenAmount?.amount;
      const decimals = info?.tokenAmount?.decimals;
      return info?.mint === position.nftMint && amount === '1' && decimals === 0;
    });
    if (!owned) {
      throw new Error(
        `Cannot resume partial pool ${poolId}: recorded position NFT ` +
          `${position.nftMint} is no longer held by the launch wallet. ` +
          `Sweep or manage that position manually instead.`,
      );
    }
  }
}

// Enumerate the CLMM positions the launch wallet holds in one pool, read
// straight from chain. getOwnerPositionInfo walks every position NFT the wallet
// holds and decodes the personal-position account behind each; we keep only the
// ones whose poolId matches. The resume path uses this to compare what the
// journal believes was opened against what actually landed on-chain.
async function fetchOwnerClmmPositionsForPool(raydium, poolId) {
  const all = await raydium.clmm.getOwnerPositionInfo({ programId: CLMM_PROGRAM_ID });
  const target = poolId.toString();
  return (all || [])
    .filter((p) => p && p.poolId && p.poolId.toString() === target)
    .map((p) => ({
      nftMint: p.nftMint.toString(),
      tickLower: Number(p.tickLower),
      tickUpper: Number(p.tickUpper),
    }));
}

// From a pre-fetched list of on-chain positions, return those that sit at an
// exact tick range and are NOT already accounted for by nftMint. This catches a
// position that landed on-chain but never reached the journal: a tx whose
// confirmation timed out (common under launch-time congestion) even though it
// actually succeeded. A journal-only resume would open that slot AGAIN, making a
// duplicate that wastes rent and splits liquidity, or failing outright because
// the tokens were already deposited. Matching by tick range plus an nftMint
// exclusion set lets the caller fold these into the recovered set so the open
// loop skips them instead of reopening them.
export function unrecordedPositionsAtRange(onChainPositions, tickLower, tickUpper, recordedNftMints) {
  return (onChainPositions || []).filter(
    (p) =>
      p &&
      p.nftMint &&
      Number(p.tickLower) === Number(tickLower) &&
      Number(p.tickUpper) === Number(tickUpper) &&
      !recordedNftMints.has(p.nftMint),
  );
}

// Maximum allowed ratio between the user-committed quote-token USD price
// (from funding-estimate, or from a manual override the user typed) and
// the just-in-time Raydium swap probe at pool-creation time. If the two
// differ by more than this ratio, we abort the pool creation with a
// pre_flight error and ask the user to refresh funding-estimate.
//
// 1.25 = 25% drift. Matches the Aave Shield pre-trade impact guardrail,
// which was independently validated after a $50M loss event. Tight
// enough to catch the kinds of pricing bugs the user reported, loose
// enough to absorb normal volatility on thin memecoin quotes during a
// brief funding-to-create gap.
//
// Tunable via PRICE_DRIFT_THRESHOLD_PCT (in percent, e.g. "30" for 30%).
function loadPriceDriftThreshold() {
  const raw = process.env.PRICE_DRIFT_THRESHOLD_PCT;
  if (raw === undefined || raw === null || raw === '') return 1.25;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(
      `PRICE_DRIFT_THRESHOLD_PCT="${raw}" is not a positive number; ` +
      `falling back to 25%`,
    );
    return 1.25;
  }
  // Convert percent → ratio (e.g. 25 → 1.25).
  return 1 + parsed / 100;
}
const PRICE_DRIFT_THRESHOLD = loadPriceDriftThreshold();

// Convenience map for well-known quote tokens. The caller can pass any SPL
// mint as a quote — this is just to skip on-chain decimals lookup for common
// cases and to provide a friendly default symbol.
//
// imageUrl/name are pulled from the canonical Solana token list on GitHub.
// These three tokens are stable enough that hardcoding is safer than
// adding a Gecko round-trip for them on every launch — and the URLs have
// been served from the same path for years.
export const KNOWN_QUOTES = {
  SOL: {
    address: WSOL_MINT,
    programId: TOKEN_PROGRAM_ID.toBase58(),
    decimals: 9,
    symbol: 'SOL',
    name: 'Solana',
    imageUrl:
      'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png',
  },
  USDC: {
    address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    programId: TOKEN_PROGRAM_ID.toBase58(),
    decimals: 6,
    symbol: 'USDC',
    name: 'USD Coin',
    imageUrl:
      'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png',
  },
  USDT: {
    address: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    programId: TOKEN_PROGRAM_ID.toBase58(),
    decimals: 6,
    symbol: 'USDT',
    name: 'USDT',
    imageUrl:
      'https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB/logo.svg',
  },
};

// Tokens we trust at compile time. The /api/quote-token-info endpoint
// skips the on-chain authority audit (mint/freeze authority checks) AND
// the Step 2 Raydium-route probe for any address in this set. These are
// already-vetted tokens — there's no value re-checking them on every
// keystroke as the user types/pastes a quote mint into the form.
//
// IMPORTANT: This is a Step 2 short-circuit only. The pool-create-time
// just-in-time probe in createPoolsAndPositions still runs fresh for
// every non-SOL quote regardless of this list — caching at Step 2 must
// not bypass the safety check at the irreversible commit point.
//
// Members:
//   SOL/USDC/USDT — the three KNOWN_QUOTES, classic SPL Token, vetted.
//   XLRT          — Reserve flywheel. Vetted, on-chain authorities
//                   confirmed renounced.
//   Meme flywheel — Vetted, on-chain authorities confirmed renounced.
export const KNOWN_SAFE_QUOTES = new Set([
  WSOL_MINT,
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',          // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',          // USDT
  'J1bZFRAFC8ALqAN7ktkcCpobgoeTGfP5Xh1BwCP1oqoj',          // XLRT (Reserve flywheel)
  'HipYKXiDh3Kjd1jb7ji6jCEsKQMSGWiFJMdtvH8yb5r',           // Meme flywheel
]);

// ---------------------------------------------------------------------------
// USD price + metadata lookup
// ---------------------------------------------------------------------------
//
// Implementation lives in tokenInfoService.js; we re-export here so existing
// callers (server.js for the /api/quote-token-info endpoint, the launch
// orchestrator below for per-allocation price resolution) keep using the
// same import paths they always have.
//
// What changed: getTokenMetadata used to be GeckoTerminal-only, and would
// return null whenever a token wasn't indexed there — which happens often
// for low-volume quote tokens, including the flywheel tokens this app is
// designed around. The new implementation reads decimals + symbol on-chain
// (always works for any real mint) and tries GeckoTerminal first then
// Jupiter as a price fallback, with a small in-memory cache so the user
// can flip between dropdown options without burning API quota.

// Re-export so other modules (e.g. server.js) can import these from lpService
// too. The actual import that binds them locally is near the top of the file.
export { getTokenMetadata, getUsdPrice };

// ---------------------------------------------------------------------------
// Diagnostic helpers
// ---------------------------------------------------------------------------

/**
 * Read and log the wallet's actual on-chain SOL balance and launched-token
 * ATA balance. Used between slice operations to make precision/balance bugs
 * easy to spot in the server logs.
 */
async function logWalletBalances(connection, ownerPk, tokenMint, label) {
  try {
    const lamports = await connection.getBalance(ownerPk);
    const solBalance = (lamports / 1e9).toFixed(6);

    let tokenBalance = 'no ATA';
    try {
      const accounts = await connection.getParsedTokenAccountsByOwner(ownerPk, {
        mint: new PublicKey(tokenMint),
      });
      if (accounts.value.length > 0) {
        tokenBalance = accounts.value[0].account.data.parsed.info.tokenAmount.amount;
      }
    } catch (e) {
      tokenBalance = `lookup failed: ${e.message}`;
    }

    console.log(`    [balances ${label}] SOL=${solBalance}, launched-token raw=${tokenBalance}`);
  } catch (e) {
    console.warn(`    [balances ${label}] lookup error: ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// CLMM fee tier listing (used by the UI dropdown)
// ---------------------------------------------------------------------------
//
// Raydium's CLMM uses a fixed set of AmmConfig PDAs created on-chain when
// the program was deployed. Each AmmConfig encodes a (tradeFeeRate,
// tickSpacing) pair plus protocol/fund fee shares; pools reference one
// at creation time via ammConfigIndex.
//
// The canonical list is published at api-v3.raydium.io/main/clmm-config.
// At launch time we use raydium.api.getClmmConfigs() (which hits the same
// endpoint via the SDK) but for the configuration UI we want the list
// before the user has a wallet to drive the SDK with. So this is a thin
// HTTP wrapper, with a process-lifetime cache and a hardcoded fallback
// for the case where the endpoint is unreachable.
//
// As of late 2025 there are eight tiers per Raydium's docs: 2%, 1%,
// 0.25%, 0.05%, 0.04%, 0.03%, 0.02%, 0.01%. We don't hardcode the
// indices because Raydium can add tiers; we let the API tell us.

const RAYDIUM_CLMM_CONFIG_URL = 'https://api-v3.raydium.io/main/clmm-config';
let cachedFeeTiers = null;

/**
 * Return the list of CLMM fee tiers available on Raydium. Each entry is
 * a normalized object with { index, tradeFeeRate, tickSpacing }; the
 * tradeFeeRate is in 1e-6 units (so 10000 = 1%).
 *
 * Caches the result for the process lifetime — Raydium adds new configs
 * rarely enough that re-fetching on every UI load would be wasteful.
 * Restart the server (or reload the Electron app) to pick up new tiers.
 */
export async function getClmmFeeTiers() {
  if (cachedFeeTiers) return cachedFeeTiers;
  try {
    const resp = await fetch(RAYDIUM_CLMM_CONFIG_URL, {
      headers: { Accept: 'application/json' },
    });
    if (!resp.ok) {
      console.warn(
        `getClmmFeeTiers: HTTP ${resp.status} from Raydium API, using fallback list`,
      );
      cachedFeeTiers = normalizeFeeTierList(null);
      return cachedFeeTiers;
    }
    const json = await resp.json();
    cachedFeeTiers = normalizeFeeTierList(json);
    return cachedFeeTiers;
  } catch (e) {
    console.warn(`getClmmFeeTiers: ${e.message}; using fallback list`);
    cachedFeeTiers = FALLBACK_FEE_TIERS;
    return cachedFeeTiers;
  }
}

// ---------------------------------------------------------------------------
// SDK initialization
// ---------------------------------------------------------------------------

/**
 * Build a fresh Raydium SDK instance for the given owner keypair. We don't
 * cache across calls because the owner changes per launch.
 *
 * Tests can short-circuit this entire function by setting an SDK factory
 * via setSdkFactoryForTests — the override is called with the ownerKeypair
 * and its return value is used in place of a real Raydium.load(). Tests
 * can also override just the Connection construction (when they want the
 * real Raydium.load with a fake RPC) via setConnectionFactoryForTests.
 */
async function initSdk(ownerKeypair) {
  if (__sdkFactoryOverride) return __sdkFactoryOverride(ownerKeypair);
  const connection = __connectionFactoryOverride
    ? __connectionFactoryOverride()
    : new Connection(getRpcUrl(), {
        commitment: 'confirmed',
        confirmTransactionInitialTimeout: 60_000,
      });
  return Raydium.load({
    owner: ownerKeypair,
    connection,
    cluster: 'mainnet',
    disableFeatureCheck: true,
    disableLoadToken: true, // skip the multi-MB token-list fetch
    blockhashCommitment: 'finalized',
  });
}

// ---------------------------------------------------------------------------
// Test-only DI seams
// ---------------------------------------------------------------------------
//
// Optional overrides for two external boundaries lpService touches:
//
//   __sdkFactoryOverride        — replaces Raydium.load() inside initSdk.
//                                 Called with the owner keypair; must
//                                 return an SDK-shaped object exposing
//                                 clmm, api, account, and a connection
//                                 property (the shape returned by the
//                                 real Raydium.load).
//
//   __connectionFactoryOverride — replaces new Connection(getRpcUrl(),...)
//                                 in initSdk (when no SDK override is set)
//                                 AND in the per-allocation quote-token
//                                 lookup loop inside preflightCreate-
//                                 PoolsAndPositions.
//
// Production code never sets these — they stay null and the dispatcher
// branches in initSdk / preflightCreatePoolsAndPositions fall through to
// the real implementations. Tests inject network-free fakes via the
// set*ForTests exports and clear them in afterEach via resetTestFactories.
//
// Module-level state is fine because node:test runs tests serially by
// default. If a test ever opted into .concurrency, we'd need AsyncLocal-
// Storage — but no test currently does, so the simple approach wins.
//
// The phase helpers (createSinglePool, lockAllPositions, transferFeeKeys)
// take `raydium` as a parameter directly, so tests usually inject their
// fake SDK there and don't need to use these factory overrides at all.
// The seams exist for completeness so callers of createPoolsAndPositions
// (the full orchestrator) can also be tested if needed.

let __sdkFactoryOverride = null;
let __connectionFactoryOverride = null;

/**
 * Replace the function used to construct the Raydium SDK inside
 * initSdk. The override is called with the owner Keypair and must
 * return an SDK-shaped object. Set by tests, cleared by
 * resetTestFactories.
 */
export function setSdkFactoryForTests(factory) {
  __sdkFactoryOverride = factory;
}

/**
 * Replace the function used to construct Connections. Called with no
 * arguments; must return a @solana/web3.js Connection-shaped object.
 * Affects initSdk and preflightCreatePoolsAndPositions's per-allocation
 * quote-token lookups.
 */
export function setConnectionFactoryForTests(factory) {
  __connectionFactoryOverride = factory;
}

/**
 * Clear both test overrides — returns the module to production
 * behavior. Always safe to call (idempotent, no-throw).
 */
export function resetTestFactories() {
  __sdkFactoryOverride = null;
  __connectionFactoryOverride = null;
  // Estimator seams (declared near estimateRequiredFunding) are cleared here
  // too so one reset returns the entire module to production behavior.
  __estPriceOracleForTests = null;
  __estRouteDiscoveryForTests = null;
}

// ---------------------------------------------------------------------------
// Quote-token resolution
// ---------------------------------------------------------------------------

// =============================================================================
// Raydium CLMM Token-2022 compatibility check
// =============================================================================
//
// Raydium's CLMM program enforces a strict allowlist of Token-2022 extensions
// in its on-chain `is_supported_mint` check. A mint with even one disallowed
// extension makes pool creation revert with `NotSupportMint` (or sometimes
// Anchor's ConstraintMintTokenProgram if a constraint catches it earlier).
//
// SOURCE OF TRUTH (verified against raydium-clmm/programs/amm/src/util/token.rs
// at github.com/raydium-io/raydium-clmm, function `is_supported_mint`):
//
//   - classic SPL Token mints are always supported (no extensions)
//   - Token-2022 mints with NO extensions are supported
//   - Token-2022 mints whose extensions are ALL in this allowlist are supported:
//       * TransferFeeConfig
//       * MetadataPointer
//       * TokenMetadata
//       * InterestBearingConfig
//       * ScaledUiAmount  (called ScaledUiAmountConfig in @solana/spl-token JS)
//   - escape hatches that work case-by-case but we can't rely on:
//       * hardcoded MINT_WHITELIST (a handful of specific stablecoin mints)
//       * a per-mint "support mint associated" account that has to be created
//         on chain by Raydium ahead of time
//       * Superstate special case (ScaledUI compat)
//
// Anything else — Permanent Delegate, Non-Transferable, Default Account State,
// Confidential Transfers, CPI Guard, Transfer Hooks, Pausable, Group Pointers,
// etc — will fail pool creation.
//
// pump.fun graduated tokens have only TransferFeeConfig + MetadataPointer +
// TokenMetadata, all of which are in this allowlist. They should always work.
// If pump.fun ever adds an extension to their template that isn't in this
// allowlist, this check is the trigger that tells us — and the user — clearly.
/**
 * Read a mint account and determine whether it can be used as either side of
 * a Raydium CLMM pool. Returns a richly-typed result so callers can decide
 * how to surface incompatibility — fail-fast on the server, warning chip in
 * the UI, etc.
 *
 * Returns:
 *   {
 *     programId:        PublicKey  (TOKEN_PROGRAM_ID or TOKEN_2022_PROGRAM_ID),
 *     decimals:         number,
 *     isToken2022:      bool,
 *     extensions:       ExtensionType[]   (Token-2022 only; classic = []),
 *     compatible:       bool,
 *     disallowed:       ExtensionType[]   (subset of extensions not in allowlist),
 *     disallowedNames:  string[]          (human-readable form of disallowed),
 *   }
 *
 * Throws if:
 *   - mint doesn't exist on chain
 *   - mint is owned by a program that isn't one of the two token programs
 *   - the account data can't be parsed as a mint (corrupt / not a mint)
 */

// Map a numeric ExtensionType enum value (from @solana/spl-token) to the
// string name used by classifyToken2022Extensions in lpMintCompat.js.
// Handles the two hard-coded numeric values (16, 17) that are stable in
// the spl-token-2022 program but not exported as named constants in
// @solana/spl-token v0.4.x.
function _extensionTypeToName(type) {
  // Build a reverse-lookup from ExtensionType the first time.
  if (!_extensionTypeToName._map) {
    const m = {};
    for (const [k, v] of Object.entries(ExtensionType)) {
      if (typeof v === 'number') m[v] = k;
    }
    // Hard-coded entries not in the enum export
    m[16] = 'ConfidentialTransferFeeConfig';
    m[17] = 'ConfidentialTransferFeeAmount';
    _extensionTypeToName._map = m;
  }
  return _extensionTypeToName._map[type] || `UnknownExtension:${type}`;
}

export async function getMintCompatibilityWithRaydiumClmm(connection, mintPk) {
  const accountInfo = await connection.getAccountInfo(mintPk, 'confirmed');
  if (!accountInfo) {
    throw new Error(`Mint ${mintPk.toBase58()} does not exist on chain`);
  }
  const owner = accountInfo.owner;
  if (!owner.equals(TOKEN_PROGRAM_ID) && !owner.equals(TOKEN_2022_PROGRAM_ID)) {
    throw new Error(
      `${mintPk.toBase58()} is owned by ${owner.toBase58()}, not a recognized ` +
        `token program - this isn't a token mint at all.`,
    );
  }

  // unpackMint validates the base mint struct and returns it; for Token-2022
  // it also exposes the trailing TLV bytes that hold extensions.
  const mint = unpackMint(mintPk, accountInfo, owner);
  const isToken2022 = owner.equals(TOKEN_2022_PROGRAM_ID);

  // Authority audit. The mint exposes:
  //   mint.freezeAuthority — PublicKey if a freeze authority is set,
  //                          null if the authority has been renounced.
  //                          A token with active freeze authority can
  //                          have its holders' balances frozen at any
  //                          time. For a QUOTE TOKEN this is critical:
  //                          the deployer could freeze the launch
  //                          wallet's quote-token balance mid-launch
  //                          and brick the entire process. Funds would
  //                          become unrecoverable through normal sweep.
  //   mint.mintAuthority   — PublicKey if mint authority is set, null
  //                          if renounced. Active mint authority means
  //                          supply can be inflated, which devalues
  //                          everything in the pool but doesn't directly
  //                          brick the launch. Soft warning, not block.
  //
  // For Token-2022, ALSO check the PermanentDelegate extension, which
  // gives a delegate authority similar transfer-confiscation power.
  // Raydium's whitelist already covers the known-safe Token-2022 cases.
  const freezeAuthority = mint.freezeAuthority
    ? mint.freezeAuthority.toBase58()
    : null;
  const mintAuthority = mint.mintAuthority
    ? mint.mintAuthority.toBase58()
    : null;
  const authorityAudit = {
    freezeAuthority,                              // base58 string or null
    mintAuthority,                                // base58 string or null
    freezeAuthorityDisabled: freezeAuthority === null,
    mintAuthorityRenounced: mintAuthority === null,
  };

  // Classic SPL Token mints have no extensions and are always supported.
  if (!isToken2022) {
    return {
      programId: owner,
      decimals: mint.decimals,
      isToken2022: false,
      extensions: [],
      compatible: true,
      whitelisted: false,
      disallowed: [],
      disallowedNames: [],
      ...authorityAudit,
    };
  }

  // Token-2022 path: pull the extension list from the TLV data. Some token
  // accounts (with no extensions) have empty tlvData — getExtensionTypes
  // returns [] in that case, which is fine.
  const rawExtensions = getExtensionTypes(mint.tlvData || Buffer.alloc(0));
  // Convert numeric ExtensionType values to string names so the pure
  // classifyToken2022Extensions (in lpMintCompat.js) can process them
  // without depending on @solana/spl-token.
  const extensions = rawExtensions.map((e) => _extensionTypeToName(e));

  // Delegate the compatibility classification to the pure helper in
  // lpMintCompat.js. It handles both the extension allowlist check and
  // the Raydium CLMM mint whitelist (PYUSD, AUSD, etc. — mints with
  // extensions that would normally fail the generic check but the
  // protocol team specifically vetted).
  const classification = classifyToken2022Extensions(
    extensions,
    mintPk.toBase58(),
  );

  return {
    programId: owner,
    decimals: mint.decimals,
    isToken2022: true,
    extensions,
    // classification provides: compatible, whitelisted, whitelistedDespite,
    // disallowed, disallowedNames.
    ...classification,
    // authorityAudit provides: freezeAuthority, mintAuthority,
    // freezeAuthorityDisabled, mintAuthorityRenounced. These power the
    // Step 2 quote-token safety warnings (price-safety plan Milestone D)
    // and the resolved-info panel in app.js.
    ...authorityAudit,
  };
}

/**
 * Resolve a quote-token spec to {address, programId, decimals, symbol}.
 * Accepts either a known symbol (SOL/USDC/USDT) or an arbitrary SPL mint
 * address. For arbitrary addresses we hit RPC for decimals unless an
 * override is supplied.
 */
async function resolveQuoteToken(connection, spec, overrides = {}) {
  // Symbol shortcut
  const upper = (spec || '').toUpperCase();
  if (KNOWN_QUOTES[upper]) {
    const base = { ...KNOWN_QUOTES[upper] };
    // Allow per-call overrides for symbol/decimals even on known tokens
    if (overrides.decimals !== undefined && overrides.decimals !== null) {
      base.decimals = Number(overrides.decimals);
    }
    if (overrides.symbol) base.symbol = overrides.symbol;
    return base;
  }

  // Treat as a mint address.
  //
  // We must detect (a) which token program owns this mint and (b) whether
  // its Token-2022 extensions are all in Raydium CLMM's allowlist. Both
  // checks are fail-fast safety nets — getting either wrong means the
  // pool-creation tx will revert later with an opaque on-chain error, after
  // we've already paid for it. One getAccountInfo + unpackMint roundtrip
  // covers both, so the cost is negligible.
  const mintPk = new PublicKey(spec);
  const compat = await getMintCompatibilityWithRaydiumClmm(connection, mintPk);

  if (!compat.compatible) {
    // Surface BOTH the unsupported extensions and the allowlist so the
    // user (or dev reading logs) knows exactly what changed.
    throw new Error(
      `Quote token ${spec} cannot be paired in a Raydium CLMM pool. ` +
        `Its Token-2022 mint has these unsupported extensions: ` +
        `${compat.disallowedNames.join(', ')}. ` +
        `Raydium CLMM only allows: TransferFeeConfig, MetadataPointer, ` +
        `TokenMetadata, InterestBearingConfig, ScaledUiAmount.`,
    );
  }

  // decimals: prefer caller override (helpful when Gecko returned them
  // and we want to skip the extra round-trip), else use what we just read
  // from the mint account.
  const decimals =
    overrides.decimals !== undefined && overrides.decimals !== null
      ? Number(overrides.decimals)
      : compat.decimals;

  return {
    address: mintPk.toBase58(),
    programId: compat.programId.toBase58(),
    decimals,
    symbol: overrides.symbol || spec.slice(0, 6),
    // Forward compatibility metadata so callers (e.g. progress logging,
    // bootstrap fee math) can react to Token-2022 specifics without
    // having to re-fetch the mint. Strictly informational — callers that
    // don't care can ignore these fields.
    isToken2022: compat.isToken2022,
    extensions: compat.extensions,
  };
}

/**
 * Validate and normalize the distribution array for an allocation.
 * If absent or empty, returns [{ sharePercent: 100 }] — single slice, all
 * Fee Keys end up at the destination wallet via the normal sweep.
 *
 * Each slice can optionally specify a `recipient` (a base58 wallet address)
 * to transfer that slice's Fee Key NFT to instead of the default sweep.
 */
// ---------------------------------------------------------------------------
// NFT transfer (used to send Fee Keys to external recipients)
// ---------------------------------------------------------------------------

/**
 * Transfer 1 unit of an NFT from owner to recipient.
 *
 * IMPORTANT: Raydium CLMM position NFTs (and the Fee Key NFTs minted when
 * Burn & Earn locks them) are minted under the Token-2022 program, NOT
 * classic SPL Token. The transfer instruction must target the same program
 * the mint lives under, or the tx will fail with "incorrect program id".
 *
 * We don't know upfront which program the NFT lives under, so we look up
 * the mint owner first. This handles future cases where Raydium changes
 * which program they mint under, and works correctly for any NFT regardless
 * of source.
 */
async function transferNftToRecipient({
  connection,
  ownerKeypair,
  nftMint,
  recipient,
}) {
  const mintPk = new PublicKey(nftMint);
  const recipientPk = new PublicKey(recipient);

  // Look up which token program owns this mint
  const mintAccountInfo = await connection.getAccountInfo(mintPk);
  if (!mintAccountInfo) {
    throw new Error(`Mint ${nftMint} not found on-chain`);
  }
  const programId = mintAccountInfo.owner;
  if (
    !programId.equals(TOKEN_PROGRAM_ID) &&
    !programId.equals(TOKEN_2022_PROGRAM_ID)
  ) {
    throw new Error(
      `Mint ${nftMint} is owned by an unexpected program: ${programId.toBase58()}`,
    );
  }

  return transferTokenWithProgram({
    connection,
    ownerKeypair,
    mint: mintPk,
    destination: recipientPk,
    amount: 1n,
    decimals: 0,
    programId,
  });
}

// ---------------------------------------------------------------------------
// Per-pool orchestration
// ---------------------------------------------------------------------------

/**
 * Phase 1 of the per-pool flow: create one pool, open the main positions
 * (one per distribution slice), lock each, and optionally transfer Fee Keys
 * to external recipients.
 *
 * The bootstrap position — the one that makes the pool tradable — is
 * intentionally NOT opened here. The orchestrator runs bootstraps for all
 * pools as a separate phase, after every pool's main positions have landed,
 * so no pool becomes tradable while later pools are still being built. See
 * the long comment near the bottom of this function for the full reasoning.
 *
 * Returns:
 *   {
 *     poolId,
 *     launchedSide: 'mintA' | 'mintB',
 *     mainPositions: [
 *       { sliceIndex, sharePercent, nftMint, locked, recipient,
 *         transferredTo, txIds: { open, lock, transfer } }, ...
 *     ],
 *     txIds: { createPool },
 *     // Internal — orchestrator strips this before exposing the result
 *     _bootstrapContext: { poolId, poolInfo, poolKeys, currentTickAtCreation,
 *                          tickSpacing, launchedIsMintA, bootstrapBaseRaw,
 *                          initialPrice, quoteToken },
 *   }
 */
// F3: dynamic priority fee for the LP path. Samples recent on-chain
// prioritization fees and clamps to [floor, ceil]. Uses the 75th percentile
// so we bias slightly above the median — enough to land during mild
// congestion without overpaying. Any RPC failure falls back to the floor so
// a fee lookup can never block a launch. getRecentPrioritizationFees returns
// [{ slot, prioritizationFee }, ...] over a recent window.
//
// writableAccounts (optional): the accounts this transaction will write-lock.
// When supplied, the sample is scoped to recent fees paid by transactions
// contending for *those* accounts (the `lockedWritableAccounts` filter) rather
// than the whole network — a far better predictor of what it costs to land a
// tx that locks our pool. Left undefined for the initial createPool (the pool
// account doesn't exist yet), so that path keeps the network-wide sample.
async function lpPriorityFeeMicroLamports(connection, writableAccounts) {
  try {
    const scoped =
      Array.isArray(writableAccounts) && writableAccounts.length > 0;
    const recent = await connection.getRecentPrioritizationFees(
      scoped ? { lockedWritableAccounts: writableAccounts } : undefined,
    );
    if (Array.isArray(recent) && recent.length > 0) {
      // Drop zero-fee slots before taking the percentile. Idle slots (where
      // nobody paid priority) pull the estimate toward 0 — the wrong direction
      // during the localized congestion we're trying to price for. If every
      // sampled slot is zero there's no contention and the floor is correct
      // anyway. (Remove the .filter() to revert to the prior include-zeros
      // behaviour.)
      const fees = recent
        .map((r) => Number(r.prioritizationFee) || 0)
        .filter((f) => f > 0)
        .sort((a, b) => a - b);
      if (fees.length === 0) return LP_PRIORITY_FEE_FLOOR_MICROLAMPORTS;
      const idx = Math.min(fees.length - 1, Math.floor(fees.length * 0.75));
      const p75 = fees[idx];
      return Math.max(
        LP_PRIORITY_FEE_FLOOR_MICROLAMPORTS,
        Math.min(LP_PRIORITY_FEE_CEIL_MICROLAMPORTS, p75),
      );
    }
  } catch (e) {
    console.warn(
      `lpPriorityFeeMicroLamports: fee lookup failed, using floor (${e.message})`,
    );
  }
  return LP_PRIORITY_FEE_FLOOR_MICROLAMPORTS;
}

// Build the computeBudgetConfig the Raydium SDK expects, with a CU limit and
// a freshly-sampled dynamic priority fee. Pass the raydium instance; we read
// its connection. Awaited at each SDK call site (createPool / openPosition /
// lockPosition) so the fee reflects conditions at build time.
//
// poolId (optional): the pool's state account. When known — every step after
// the pool is created — it scopes the fee sample to contention on that pool
// (see lpPriorityFeeMicroLamports). Omitted by createPool, which can't scope
// to an account that doesn't exist yet.
async function lpComputeBudgetConfig(raydium, poolId) {
  let writableAccounts;
  if (poolId) {
    try {
      writableAccounts = [
        poolId instanceof PublicKey ? poolId : new PublicKey(poolId),
      ];
    } catch {
      // Malformed id — fall back to the network-wide sample rather than throw.
      writableAccounts = undefined;
    }
  }
  return {
    units: LP_COMPUTE_UNIT_LIMIT,
    microLamports: await lpPriorityFeeMicroLamports(
      raydium.connection,
      writableAccounts,
    ),
  };
}

async function createSinglePool({
  raydium,
  ownerKeypair,
  ammConfig,
  launchedToken,
  quoteToken,
  initialPrice,
  // mainBaseRaw is the raw token amount available for the main positions
  // ONLY. The caller (orchestrator) has already subtracted out whatever
  // supply is destined for the bootstrap, so this function doesn't need
  // wideBaseRaw is the raw token amount available for the wide main
  // positions (sliced by the distribution array). The caller has
  // already subtracted out the bootstrap AND the ladder allocations,
  // so this function doesn't need to know about either carve-out
  // when computing slice sizes.
  //
  // For a no-ladder launch this equals (allocation.supplyPercent −
  // bootstrap.supplyPercent) × totalSupply. For a launch with the
  // ladder enabled, it equals that minus (ladder.supplyPercent% × main).
  // (Renamed from mainBaseRaw to disambiguate from the broader "main"
  // concept that now includes both wide and ladder positions.)
  wideBaseRaw,
  // bootstrapBaseRaw is the raw token amount the bootstrap will consume.
  // Threaded through to the deferred Phase 2 step via _bootstrapContext.
  bootstrapBaseRaw,
  // bootstrapMode is 'minimal' or 'custom'; controls the tick range in
  // Phase 2 (minimal = narrow band, custom = full range).
  bootstrapMode,
  distribution,
  // Ladder parameters.
  //   ladderMode: 'off' | 'simple' | 'manual'
  //   ladderBands: per-band data. Each entry has baseRaw (the BN raw
  //                token amount for this band). Simple-mode entries
  //                have only baseRaw and the function computes ticks
  //                via log-spacing math from ladderCeiling. Manual-mode
  //                entries also carry lowerMultiplier and upperMultiplier
  //                which the function uses to compute ticks directly.
  //   ladderCeiling: ceiling multiplier (simple mode only; ignored for
  //                  manual since the tick range is per-band).
  ladderMode,
  ladderBands,
  ladderCeiling,
  // Support position parameters.
  //   supportEnabled: true if a custom-mode support position should be
  //                   opened in this pool. When false, the support block
  //                   is skipped entirely and `supportPositions` in the
  //                   returned result is an empty array.
  //   supportQuoteRaw: BN raw amount of QUOTE token to deposit. Computed
  //                    by the orchestrator from the user's solValue input
  //                    (SOL-equivalent USD value of starting support).
  //                    Single-sided in quote — no launched-token supply
  //                    is consumed, so this is orthogonal to wideBaseRaw,
  //                    bootstrapBaseRaw, and ladder shares.
  //   supportDepthPct: how far below launch price the support position
  //                    extends, in percent. Defaults to
  //                    SUPPORT_DEPTH_PCT_DEFAULT (10) when omitted.
  supportEnabled,
  supportQuoteRaw,
  supportDepthPct,
  // Recovery path for a pool that was created and partially opened before
  // the old journal format had a completed allocation result. The pool and
  // recorded position NFTs are verified before any missing work is attempted.
  existingPool,
  // NOTE: this function no longer takes lockPositions. Locking and
  // Fee Key transfers are deferred to dedicated phases in the
  // orchestrator (lockAllPositions, transferFeeKeys). The orchestrator
  // makes the lock-or-skip decision after every position is open.
  onProgress,
}) {
  const progress = (event) => onProgress && onProgress(event);
  const connection = raydium.connection;

  // -----------------------------------------------------------------------
  // 1. Create the pool. We pass the launched token as mint1 by convention;
  //    the SDK may reorder internally. We confirm via mintA after.
  // -----------------------------------------------------------------------
  const recoveringPhase1 = phase1RecoveryEnabled(existingPool);
  let createTx;
  let poolId;
  if (recoveringPhase1) {
    poolId = existingPool.poolId;
    createTx = { txId: existingPool.txIds?.createPool || null };
    console.log(`Recovering existing CLMM pool: ${poolId}`);
    progress({
      stage: 'phase1_pool_recovery_start',
      poolId,
      existingMainCount: existingPool.mainPositions?.length || 0,
      existingLadderCount: existingPool.ladderPositions?.length || 0,
      existingSupportCount: existingPool.supportPositions?.length || 0,
    });
  } else {
    console.log(`Creating CLMM pool: ${launchedToken.address} / ${quoteToken.address}`);
    progress({ stage: 'pool_create_start' });

    const createRes = await raydium.clmm.createPool({
      programId: CLMM_PROGRAM_ID,
      mint1: launchedToken,
      mint2: quoteToken,
      ammConfig,
      initialPrice,
      txVersion: TxVersion.V0,
      computeBudgetConfig: await lpComputeBudgetConfig(raydium),
    });

    createTx = await createRes.execute({ sendAndConfirm: true });
    // extInfo.address.id is already a base58 string (SDK calls .toString() internally
    // when building the extInfo). Don't call toBase58() on it.
    poolId = createRes.extInfo.address.id;
    console.log(`  pool created: ${poolId}, tx: ${createTx.txId}`);
    progress({ stage: 'pool_create_done', poolId, txId: createTx.txId });
  }

  // -----------------------------------------------------------------------
  // 2. Refresh pool info from RPC. Newly-created pools take ~5 minutes to
  //    appear in the API; getPoolInfoFromRpc reads on-chain state directly.
  // -----------------------------------------------------------------------
  await new Promise((r) => setTimeout(r, 2000));

  const { poolInfo, poolKeys } = await raydium.clmm.getPoolInfoFromRpc(poolId);
  const rpcData = await raydium.clmm.getRpcClmmPoolInfo({ poolId });

  const tickSpacing = poolInfo.config.tickSpacing;
  const currentTick = rpcData.tickCurrent;
  const launchedIsMintA = poolInfo.mintA.address === launchedToken.address;
  if (poolInfo.mintA.address !== launchedToken.address && poolInfo.mintB.address !== launchedToken.address) {
    throw new Error(
      `Cannot resume pool ${poolId}: pool does not contain launched token ` +
        `${launchedToken.address}.`,
    );
  }
  const poolQuoteAddress = launchedIsMintA ? poolInfo.mintB.address : poolInfo.mintA.address;
  if (poolQuoteAddress !== quoteToken.address) {
    throw new Error(
      `Cannot resume pool ${poolId}: expected quote mint ${quoteToken.address}, ` +
        `but pool has ${poolQuoteAddress}.`,
    );
  }
  console.log(
    `  launched token sorted as ${launchedIsMintA ? 'mintA' : 'mintB'}, ` +
      `currentTick=${currentTick}, tickSpacing=${tickSpacing}`,
  );

  // -----------------------------------------------------------------------
  // 3. Compute the main range — same range for every slice in this pool.
  //    Then assert the range is correctly positioned on the right side of
  //    currentTick for single-sided launched-token deposit.
  //
  //    CLMM rules (Uniswap V3 conventions):
  //      currentTick <  tickLower  → position holds 100% token0
  //      tickLower <= currentTick < tickUpper  → position is in-range, holds both
  //      currentTick >= tickUpper  → position holds 100% token1
  //
  //    For single-sided launched-token deposit:
  //      - launched=mintA (token0): need currentTick < tickLower (range above)
  //      - launched=mintB (token1): need currentTick >= tickUpper (range below)
  //
  //    If these conditions aren't met (e.g., due to a tick alignment edge case),
  //    the position would be in-range and require quote-side liquidity, which
  //    would fail the deposit. Better to abort here than have the SDK fail.
  // -----------------------------------------------------------------------
  const mainTicks = computeMainTicks({ currentTick, tickSpacing, launchedIsMintA });
  console.log(`  main range: [${mainTicks.tickLower}, ${mainTicks.tickUpper}]`);

  if (launchedIsMintA && currentTick >= mainTicks.tickLower) {
    throw new Error(
      `Main range mispositioned for launched=mintA: tickLower (${mainTicks.tickLower}) ` +
        `must be > currentTick (${currentTick}) so the position is single-sided in the launched ` +
        `token. This shouldn't happen with the current tick logic - please report this.`,
    );
  }
  if (!launchedIsMintA && currentTick < mainTicks.tickUpper) {
    throw new Error(
      `Main range mispositioned for launched=mintB: tickUpper (${mainTicks.tickUpper}) ` +
        `must be <= currentTick (${currentTick}) so the position is single-sided in the launched ` +
        `token. This shouldn't happen with the current tick logic - please report this.`,
    );
  }
  console.log(
    `  range positioning verified: launched=${launchedIsMintA ? 'mintA' : 'mintB'}, ` +
      `position is ${launchedIsMintA ? 'above' : 'below'} currentTick by ` +
      `${launchedIsMintA ? mainTicks.tickLower - currentTick : currentTick - mainTicks.tickUpper} ticks`,
  );

  // -----------------------------------------------------------------------
  // 4. Open + lock + (optionally) transfer one position per slice
  //
  // The bootstrap and any ladder reserves have already been carved out
  // by the caller — wideBaseRaw is what's available for slicing into
  // the WIDE main positions (the existing single big-range positions
  // sized by the distribution array), and bootstrapBaseRaw is reserved
  // separately for Phase 2. Ladder bands are handled in the ladder
  // loop below this one and don't touch wideBaseRaw.
  //
  // We still need a small per-slice slack buffer for SDK rounding. The
  // CLMM contract uses mulDivCeil on the user-pays side, so the actual
  // transferred amount can be 1-2 raw units more than the input baseAmount.
  // With a 100% supply allocation across multiple slices, the wallet would
  // otherwise hold exactly the input amount with zero margin — any slice
  // after the first would fail with InsufficientFunds. Reserving 1 whole
  // token per slice is overkill mathematically (real rounding is sub-
  // microtoken) but costs nothing meaningful (a few tokens out of 1B is
  // dust) and bulletproofs us against future SDK rounding changes. The
  // reserved tokens stay in the wallet and get swept to destination at
  // the end.
  //
  // Edge case: if wideBaseRaw is zero or rounds to less than the slice
  // slack, the user has allocated the entire pool to the bootstrap and
  // (optionally) the ladder — a valid choice. Skip the slice loop;
  // mainPositions stays empty and the pool relies on bootstrap + ladder
  // for liquidity.
  // -----------------------------------------------------------------------
  const mainPositions = [];
  const ladderPositions = [];
  const supportPositions = [];
  // --- On-chain reconciliation (resume safety) -----------------------------
  // A position open can land on-chain even when execute() throws (a confirmation
  // timeout under congestion is the classic case). That position is never
  // written to the launch journal, so resuming purely from the journal would
  // open the same slot again. Before trusting the journal, ask the chain what
  // the wallet actually holds in this pool and fold any unrecorded positions
  // into the recovered set so they are skipped, not duplicated. The scan is
  // best-effort: if it fails we fall back to the journal-only view, which is no
  // worse than the behaviour before this check existed.
  let onChainPoolPositions = [];
  if (recoveringPhase1) {
    try {
      onChainPoolPositions = await fetchOwnerClmmPositionsForPool(raydium, poolId);
      console.log(
        `  on-chain reconciliation: launch wallet holds ${onChainPoolPositions.length} ` +
          `position(s) in pool ${poolId}`,
      );
    } catch (e) {
      console.warn(`  on-chain reconciliation scan failed (non-fatal): ${e.message}`);
      onChainPoolPositions = [];
    }

    // Main positions all share the same tick range, so reconcile by count: any
    // main-range position on-chain that is not already recorded is assigned to
    // the next free slice index. The index is cosmetic (the position already
    // landed with its own amount); what matters is that the open loop skips the
    // right NUMBER of slices and never reopens one.
    const allKnownNfts = new Set(
      [
        ...clonePositionArray(existingPool?.mainPositions),
        ...clonePositionArray(existingPool?.ladderPositions),
        ...clonePositionArray(existingPool?.supportPositions),
      ]
        .map((p) => p && p.nftMint)
        .filter(Boolean),
    );
    const unrecordedMain = unrecordedPositionsAtRange(
      onChainPoolPositions,
      mainTicks.tickLower,
      mainTicks.tickUpper,
      allKnownNfts,
    );
    if (unrecordedMain.length > 0) {
      const usedIndexes = new Set(
        clonePositionArray(existingPool?.mainPositions)
          .map((p) => finiteNumberOr(p.sliceIndex, null))
          .filter((i) => Number.isInteger(i)),
      );
      const injected = [];
      for (const pos of unrecordedMain) {
        let freeIndex = -1;
        for (let i = 0; i < distribution.length; i++) {
          if (!usedIndexes.has(i)) {
            freeIndex = i;
            break;
          }
        }
        if (freeIndex < 0) break; // more on-chain positions than planned slices
        usedIndexes.add(freeIndex);
        injected.push({
          sliceIndex: freeIndex,
          sharePercent: distribution[freeIndex] ? distribution[freeIndex].sharePercent : null,
          tickLower: pos.tickLower,
          tickUpper: pos.tickUpper,
          nftMint: pos.nftMint,
          locked: false,
          recipient: (distribution[freeIndex] && distribution[freeIndex].recipient) || null,
        });
      }
      if (injected.length > 0) {
        existingPool = {
          ...existingPool,
          mainPositions: [...clonePositionArray(existingPool?.mainPositions), ...injected],
        };
        console.log(
          `  on-chain reconciliation: adopted ${injected.length} main position(s) that landed ` +
            `on-chain but were absent from the journal`,
        );
        progress({
          stage: 'phase1_recovery_reconciled',
          poolId,
          kind: 'main',
          adopted: injected.length,
          nftMints: injected.map((p) => p.nftMint),
        });
      }
    }
  }

  const recoveredMainByIndex = recoveringPhase1
    ? normalizeRecoveredMainPositions(existingPool, distribution, mainTicks)
    : new Map();
  await assertRecoveredPositionNftsOwned({
    connection,
    ownerPublicKey: ownerKeypair.publicKey,
    poolId,
    positions: [...recoveredMainByIndex.values()],
  });

  const phase1Snapshot = () => ({
    phase1Incomplete: true,
    recoveredFrom: recoveringPhase1 ? (existingPool.recoveredFrom || 'prior_result') : 'live_progress',
    poolId,
    launchedSide: launchedIsMintA ? 'mintA' : 'mintB',
    tickSpacing,
    initialPrice: initialPrice.toString(),
    mainPositions: mainPositions.map((pos) => ({ ...pos, txIds: { ...(pos.txIds || {}) } })),
    ladderPositions: ladderPositions.map((pos) => ({ ...pos, txIds: { ...(pos.txIds || {}) } })),
    supportPositions: supportPositions.map((pos) => ({ ...pos, txIds: { ...(pos.txIds || {}) } })),
    txIds: { createPool: createTx.txId || null },
  });

  const oneTokenRaw = new BN(10).pow(new BN(launchedToken.decimals));
  const sliceSlackRaw = oneTokenRaw.mul(new BN(distribution.length));
  const slicableRaw = wideBaseRaw.sub(sliceSlackRaw);

  // Use BN's lte(0) check rather than negative-aware math — if the caller
  // sent wideBaseRaw smaller than sliceSlackRaw, the subtraction would
  // produce a negative BN that would mistakenly look like a tiny positive
  // sliceRaw after the per-slice mul/div. Guarding here keeps the loop
  // honest.
  const hasMainSupply = slicableRaw.gt(new BN(0));

  if (!hasMainSupply) {
    console.log(
      `  no wide main positions to open: wideBaseRaw=${wideBaseRaw.toString()} ` +
        `<= sliceSlackRaw=${sliceSlackRaw.toString()}. ` +
        `Bootstrap + any ladder bands will provide all liquidity for this pool.`,
    );
  } else {
    console.log(
      `  reserved: ${distribution.length} token(s) per-slice slack; ` +
        `slicableRaw=${slicableRaw.toString()}, ` +
        `bootstrapBaseRaw=${bootstrapBaseRaw.toString()} ` +
        `(${bootstrapMode || 'minimal'} mode)` +
        (ladderMode === 'simple'
          ? `, ladder=${ladderBandCount} bands x ${ladderPerBandRaw.toString()} each`
          : ''),
    );
  }

  // Diagnostic: log actual on-chain wallet balances so we can see what the
  // wallet has vs what we're about to deposit
  await logWalletBalances(connection, ownerKeypair.publicKey, launchedToken.address, 'before slicing');

  // Loop body is unchanged; the guard above is what skips it entirely for
  // bootstrap-only pools.
  for (let i = 0; hasMainSupply && i < distribution.length; i++) {
    const slice = distribution[i];
    const recovered = recoveredMainByIndex.get(i);
    if (recovered) {
      console.log(
        `  recovered slice ${i + 1}/${distribution.length}: nft=${recovered.nftMint} ` +
          `(open tx=${recovered.txIds.open || 'unknown'})`,
      );
      progress({
        stage: 'main_open_recovered',
        poolId,
        sliceIndex: i,
        nftMint: recovered.nftMint,
        txId: recovered.txIds.open || null,
        sharePercent: recovered.sharePercent,
        tickLower: recovered.tickLower,
        tickUpper: recovered.tickUpper,
      });
      mainPositions.push(recovered);
      continue;
    }

    // Compute this slice's raw token amount.
    // sliceRaw = slicableRaw * sharePercent / 100, integer math.
    // Multiply by 100 first to keep 2 decimals of precision in sharePercent.
    const sliceRaw = slicableRaw
      .mul(new BN(Math.round(slice.sharePercent * 100)))
      .div(new BN(10000));

    console.log(
      `  opening slice ${i + 1}/${distribution.length} (${slice.sharePercent}%): ` +
        `${sliceRaw.toString()} raw`,
    );
    progress({
      stage: 'main_open_start',
      poolId,
      sliceIndex: i,
      sharePercent: slice.sharePercent,
      baseAmountRaw: sliceRaw.toString(),
      tickLower: mainTicks.tickLower,
      tickUpper: mainTicks.tickUpper,
      base: launchedIsMintA ? 'MintA' : 'MintB',
    });

    // Refresh the SDK's cached token account info between slices. The previous
    // slice changed the launched-token ATA balance, and the SDK may have cached
    // assumptions that need updating before building the next tx.
    if (i > 0) {
      try {
        await raydium.account.fetchWalletTokenAccounts({ forceUpdate: true });
        console.log('    refreshed SDK token account cache');
      } catch (e) {
        console.warn('    cache refresh failed (non-fatal):', e.message);
      }
      // Brief settle so the previous lock tx is fully visible to the RPC
      await new Promise((r) => setTimeout(r, 1500));
    }

    let openTx;
    let nftMint;
    try {
      const openRes = await raydium.clmm.openPositionFromBase({
        poolInfo,
        poolKeys,
        ownerInfo: { useSOLBalance: true },
        tickLower: mainTicks.tickLower,
        tickUpper: mainTicks.tickUpper,
        base: launchedIsMintA ? 'MintA' : 'MintB',
        baseAmount: sliceRaw,
        // True single-sided: range is entirely on one side of the current tick
        // so the position genuinely needs ZERO of the other token. Pass 0 here —
        // when otherAmount is zero the SDK auto-creates the missing-side ATA.
        // (If we pass nonzero, the SDK assumes the ATA already has that balance,
        // which would fail for non-SOL quote pools where we haven't pre-created
        // the ATA.)
        otherAmountMax: new BN(0),
        txVersion: TxVersion.V0,
        computeBudgetConfig: await lpComputeBudgetConfig(raydium, poolInfo.id),
      });
      openTx = await openRes.execute({ sendAndConfirm: true });
      nftMint = openRes.extInfo?.nftMint?.toBase58();
    } catch (err) {
      progress({
        stage: 'main_open_failed',
        poolId,
        sliceIndex: i,
        sharePercent: slice.sharePercent,
        baseAmountRaw: sliceRaw.toString(),
        tickLower: mainTicks.tickLower,
        tickUpper: mainTicks.tickUpper,
        base: launchedIsMintA ? 'MintA' : 'MintB',
        ...lpErrorProgressFields(err),
      });
      err.phase1PartialResult = phase1Snapshot();
      throw err;
    }
    console.log(`    opened: nft=${nftMint}, tx=${openTx.txId}`);
    progress({
      stage: 'main_open_done',
      poolId,
      sliceIndex: i,
      nftMint,
      txId: openTx.txId,
      baseAmountRaw: sliceRaw.toString(),
      tickLower: mainTicks.tickLower,
      tickUpper: mainTicks.tickUpper,
    });

    // Diagnostic: balance after open
    await logWalletBalances(connection, ownerKeypair.publicKey, launchedToken.address, `after slice ${i + 1} open`);

    // Locking and Fee Key transfer are deferred to dedicated phases later
    // in the orchestrator. We capture the open result here and move on to
    // the next slice. This is the "open all, lock all at end" reordering:
    // it means a Phase 1 failure leaves positions that the ephemeral
    // wallet can still close (recoverable), rather than scattered
    // permanently-locked positions across pools that succeeded plus
    // pending opens that didn't. See createPoolsAndPositions for the
    // phase orchestration; lockAllPositions and transferFeeKeys are
    // the post-open phases.
    mainPositions.push({
      sliceIndex: i,
      sharePercent: slice.sharePercent,
      // Tick range recorded for the launch report / audit record — proves
      // the wide main position's bounds without an on-chain lookup.
      tickLower: mainTicks.tickLower,
      tickUpper: mainTicks.tickUpper,
      nftMint,
      // Phase 3 will flip this to true (or push to lockFailures if it
      // can't). When lockPositions is false (test/manual launches),
      // Phase 3 is skipped and these stay false; downstream consumers
      // already handle the locked: false case.
      locked: false,
      recipient: slice.recipient || null,
      // Phase 4 will populate this when the slice has a recipient AND
      // its lock succeeded in Phase 3.
      transferredTo: null,
      txIds: {
        open: openTx.txId,
        lock: null,
        transfer: null,
      },
    });
  }

  // -----------------------------------------------------------------------
  // Ladder bands.
  //
  // For each band, open a single-sided position at the band's tick range
  // with ladderPerBandRaw launched tokens. Each band is its own NFT and
  // gets locked in Phase 3, just like wide main positions and the
  // bootstrap. Ladder positions never have recipients (Fee Keys stay
  // with the launch wallet and sweep to the user's destination).
  //
  // Ladder bands open INSIDE the createSinglePool function rather than
  // in a separate orchestrator phase because the band tick math is
  // pool-local (depends on the tickSpacing the pool's AmmConfig
  // determined) and the price is fresh (the pool was just created).
  // Splitting would add coordination overhead with no benefit.
  // -----------------------------------------------------------------------
  if (
    recoveringPhase1 &&
    (!Array.isArray(ladderBands) || ladderBands.length === 0) &&
    Array.isArray(existingPool.ladderPositions) &&
    existingPool.ladderPositions.length > 0
  ) {
    throw new Error(
      `Cannot resume partial pool ${poolId}: journal records ladder positions, ` +
        `but the current allocation has ladder mode off.`,
    );
  }
  if (
    (ladderMode === 'simple' || ladderMode === 'manual') &&
    Array.isArray(ladderBands) &&
    ladderBands.length > 0
  ) {
    // Compute tick ranges for each band. For simple mode we use the
    // log-spaced helper (band count = ladderBands.length, all bands
    // equal-supply); for manual mode we use the multipliers carried in
    // each band entry.
    let bandTicks;
    if (ladderMode === 'simple') {
      bandTicks = computeLadderTicks({
        currentTick,
        tickSpacing,
        bandCount: ladderBands.length,
        ceilingMultiplier: ladderCeiling,
        launchedIsMintA,
      });
    } else {
      bandTicks = computeLadderTicksManual({
        currentTick,
        tickSpacing,
        bands: ladderBands.map((b) => ({
          lowerMultiplier: b.lowerMultiplier,
          upperMultiplier: b.upperMultiplier,
        })),
        launchedIsMintA,
      });
    }

    const ceilingLabel = ladderMode === 'simple'
      ? `ceiling ${ladderCeiling}x`
      : 'manual band ranges';
    console.log(`  opening ${ladderBands.length} ladder bands (${ceilingLabel}):`);
    // On-chain reconciliation for ladder bands: each band has a distinct tick
    // range, so match by range. Adopt any band that landed on-chain but is
    // missing from the journal so the loop below skips it. See the main-position
    // reconciliation note earlier in this function.
    if (recoveringPhase1 && onChainPoolPositions.length > 0) {
      const allKnownNfts = new Set(
        [
          ...clonePositionArray(existingPool?.mainPositions),
          ...clonePositionArray(existingPool?.ladderPositions),
          ...clonePositionArray(existingPool?.supportPositions),
        ]
          .map((p) => p && p.nftMint)
          .filter(Boolean),
      );
      const recordedBandIndexes = new Set(
        clonePositionArray(existingPool?.ladderPositions)
          .map((p) => finiteNumberOr(p.bandIndex, null))
          .filter((i) => Number.isInteger(i)),
      );
      const injectedLadder = [];
      for (let bi = 0; bi < bandTicks.length; bi++) {
        if (recordedBandIndexes.has(bi)) continue;
        const matches = unrecordedPositionsAtRange(
          onChainPoolPositions,
          bandTicks[bi].tickLower,
          bandTicks[bi].tickUpper,
          allKnownNfts,
        );
        if (matches.length > 0) {
          const pos = matches[0];
          allKnownNfts.add(pos.nftMint);
          injectedLadder.push({
            bandIndex: bi,
            tickLower: pos.tickLower,
            tickUpper: pos.tickUpper,
            nftMint: pos.nftMint,
            locked: false,
          });
        }
      }
      if (injectedLadder.length > 0) {
        existingPool = {
          ...existingPool,
          ladderPositions: [
            ...clonePositionArray(existingPool?.ladderPositions),
            ...injectedLadder,
          ],
        };
        console.log(
          `  on-chain reconciliation: adopted ${injectedLadder.length} ladder band(s) that landed ` +
            `on-chain but were absent from the journal`,
        );
        progress({
          stage: 'phase1_recovery_reconciled',
          poolId,
          kind: 'ladder',
          adopted: injectedLadder.length,
          nftMints: injectedLadder.map((p) => p.nftMint),
        });
      }
    }

    const recoveredLadderByIndex = recoveringPhase1
      ? normalizeRecoveredLadderPositions(existingPool, bandTicks)
      : new Map();
    await assertRecoveredPositionNftsOwned({
      connection,
      ownerPublicKey: ownerKeypair.publicKey,
      poolId,
      positions: [...recoveredLadderByIndex.values()],
    });

    for (let bi = 0; bi < ladderBands.length; bi++) {
      const { tickLower, tickUpper } = bandTicks[bi];
      const bandBaseRaw = ladderBands[bi].baseRaw;
      const recovered = recoveredLadderByIndex.get(bi);
      if (recovered) {
        console.log(
          `    recovered ladder band ${bi + 1}/${ladderBands.length}: ` +
            `nft=${recovered.nftMint}`,
        );
        progress({
          stage: 'ladder_open_recovered',
          poolId,
          bandIndex: bi,
          nftMint: recovered.nftMint,
          txId: recovered.txIds.open || null,
          tickLower: recovered.tickLower,
          tickUpper: recovered.tickUpper,
        });
        ladderPositions.push(recovered);
        continue;
      }
      if (!bandBaseRaw || bandBaseRaw.lte(new BN(0))) {
        // Defensive: a band with 0 supply is pointless; the SDK would
        // also reject it. Pre-flight should catch this for manual mode,
        // and simple mode never produces it (perBandRaw > 0 if
        // ladderTotalBaseRaw > 0). Skip rather than throw, so the rest
        // of the ladder can still open.
        console.log(`    band ${bi + 1}/${ladderBands.length}: skipped (0 supply)`);
        continue;
      }
      console.log(
        `    band ${bi + 1}/${ladderBands.length} ticks=[${tickLower}, ${tickUpper}], ` +
          `base=${bandBaseRaw.toString()}`,
      );
      progress({
        stage: 'ladder_open_start',
        poolId,
        bandIndex: bi,
        baseAmountRaw: bandBaseRaw.toString(),
        tickLower,
        tickUpper,
        base: launchedIsMintA ? 'MintA' : 'MintB',
      });

      // Refresh the SDK's cached token account info between bands.
      // Each band drains the launched-token ATA, and without this refresh
      // the SDK builds the next tx using stale cached balances — the CLMM
      // program then rejects the increase_liquidity with Custom:1.
      if (bi > 0) {
        try {
          await raydium.account.fetchWalletTokenAccounts({ forceUpdate: true });
          console.log('    refreshed SDK token account cache for ladder band');
        } catch (e) {
          console.warn('    ladder cache refresh failed (non-fatal):', e.message);
        }
        // Brief settle so the previous tx is fully visible to the RPC
        await new Promise((r) => setTimeout(r, 1500));
      }

      let ladderTx;
      let ladderNftMint;
      try {
        const ladderRes = await raydium.clmm.openPositionFromBase({
          poolInfo,
          poolKeys,
          tickLower,
          tickUpper,
          base: launchedIsMintA ? 'MintA' : 'MintB',
          baseAmount: bandBaseRaw,
          // Single-sided in the launched token: the band starts above
          // current tick (or below, for mintB), so the position holds 0
          // of the other side at deposit time. otherAmountMax = 0 is
          // exact and the SDK won't fund a non-existent ATA.
          otherAmountMax: new BN(0),
          ownerInfo: { useSOLBalance: false },
          txVersion: TxVersion.V0,
          computeBudgetConfig: await lpComputeBudgetConfig(raydium, poolInfo.id),
        });
        ladderTx = await ladderRes.execute({ sendAndConfirm: true });
        ladderNftMint = ladderRes.extInfo?.nftMint?.toBase58();
      } catch (err) {
        progress({
          stage: 'ladder_open_failed',
          poolId,
          bandIndex: bi,
          baseAmountRaw: bandBaseRaw.toString(),
          tickLower,
          tickUpper,
          base: launchedIsMintA ? 'MintA' : 'MintB',
          ...lpErrorProgressFields(err),
        });
        err.phase1PartialResult = phase1Snapshot();
        throw err;
      }
      console.log(`    opened: nft=${ladderNftMint}, tx=${ladderTx.txId}`);
      progress({
        stage: 'ladder_open_done',
        poolId,
        bandIndex: bi,
        nftMint: ladderNftMint,
        txId: ladderTx.txId,
        baseAmountRaw: bandBaseRaw.toString(),
        tickLower,
        tickUpper,
      });

      ladderPositions.push({
        bandIndex: bi,
        tickLower,
        tickUpper,
        nftMint: ladderNftMint,
        // Phase 3 will flip this to true. Ladder positions never have
        // recipients — Fee Keys always sweep back with the launch
        // wallet. No transferredTo field; nothing in Phase 4 looks at
        // ladder positions.
        locked: false,
        txIds: {
          open: ladderTx.txId,
          lock: null,
        },
      });
    }
  }

  // -----------------------------------------------------------------------
  // Open the support position (optional).
  //
  // The support position is single-sided in QUOTE, sitting just below
  // current tick (for mintA-side launches; mirrored above for mintB).
  // It backs any preallocated supply held outside LP — team tokens, VC
  // allocations, presale tokens, staking rewards, etc. — by providing
  // a buy wall the recipients can sell into without requiring matching
  // token-side liquidity.
  //
  // Because the position is single-sided in quote, opening it does NOT
  // consume any launched-token supply. The quote-side amount comes from
  // the user's funding wallet — already present at this point (SOL for
  // SOL pools, auto-swapped quote tokens for non-SOL pools). The actual
  // raw quote amount is computed by the orchestrator from the user's
  // solValue input and passed in as supportQuoteRaw.
  //
  // We open it AFTER the ladder bands but BEFORE the bootstrap deferral.
  // The pool is not yet tradable (no in-range liquidity until bootstrap
  // lands), so a support position sitting below currentTick is dormant
  // — exactly what we want. Once the bootstrap opens, support becomes
  // the implicit buy wall for sellers (preallocation holders) cashing
  // out below launch price.
  //
  // Modeled as an array (currently 0 or 1 entry) for symmetry with
  // mainPositions/ladderPositions. Future iterations could open multiple
  // support bands at different depths without changing the result shape.
  // -----------------------------------------------------------------------
  if (
    recoveringPhase1 &&
    (!supportEnabled || !supportQuoteRaw || !supportQuoteRaw.gt(new BN(0))) &&
    Array.isArray(existingPool.supportPositions) &&
    existingPool.supportPositions.length > 0
  ) {
    throw new Error(
      `Cannot resume partial pool ${poolId}: journal records a support position, ` +
        `but the current allocation has support mode off.`,
    );
  }
  if (supportEnabled && supportQuoteRaw && supportQuoteRaw.gt(new BN(0))) {
    const depthPct = Number.isFinite(Number(supportDepthPct))
      ? Number(supportDepthPct)
      : SUPPORT_DEPTH_PCT_DEFAULT;
    const supportTicks = computeSupportTicks({
      currentTick,
      tickSpacing,
      launchedIsMintA,
      depthPct,
    });
    console.log(
      `  support: ticks=[${supportTicks.tickLower}, ${supportTicks.tickUpper}] ` +
        `(depth=-${depthPct}%, quoteRaw=${supportQuoteRaw.toString()})`,
    );
    // Sanity-check the range is on the correct side of currentTick to
    // be single-sided in quote. mintA: quote = mintB, position must be
    // below currentTick. mintB: quote = mintA, position must be above.
    if (launchedIsMintA && currentTick < supportTicks.tickUpper) {
      throw new Error(
        `Support range mispositioned for launched=mintA: tickUpper ` +
          `(${supportTicks.tickUpper}) must be <= currentTick (${currentTick}) ` +
          `so the position is single-sided in the quote (mintB).`,
      );
    }
    if (!launchedIsMintA && currentTick >= supportTicks.tickLower) {
      throw new Error(
        `Support range mispositioned for launched=mintB: tickLower ` +
          `(${supportTicks.tickLower}) must be > currentTick (${currentTick}) ` +
          `so the position is single-sided in the quote (mintA).`,
      );
    }
    progress({
      stage: 'support_open_start',
      poolId,
      quoteAmountRaw: supportQuoteRaw.toString(),
      tickLower: supportTicks.tickLower,
      tickUpper: supportTicks.tickUpper,
      base: launchedIsMintA ? 'MintB' : 'MintA',
      depthPct,
    });

    // On-chain reconciliation for the support position (single range). Adopt it
    // if it landed on-chain but is missing from the journal. See the main note.
    if (
      recoveringPhase1 &&
      onChainPoolPositions.length > 0 &&
      clonePositionArray(existingPool?.supportPositions).length === 0
    ) {
      const allKnownNfts = new Set(
        [
          ...clonePositionArray(existingPool?.mainPositions),
          ...clonePositionArray(existingPool?.ladderPositions),
        ]
          .map((p) => p && p.nftMint)
          .filter(Boolean),
      );
      const matches = unrecordedPositionsAtRange(
        onChainPoolPositions,
        supportTicks.tickLower,
        supportTicks.tickUpper,
        allKnownNfts,
      );
      if (matches.length > 0) {
        const pos = matches[0];
        existingPool = {
          ...existingPool,
          supportPositions: [
            {
              tickLower: pos.tickLower,
              tickUpper: pos.tickUpper,
              depthPct,
              nftMint: pos.nftMint,
              locked: false,
            },
          ],
        };
        console.log(
          `  on-chain reconciliation: adopted 1 support position that landed on-chain ` +
            `but was absent from the journal`,
        );
        progress({
          stage: 'phase1_recovery_reconciled',
          poolId,
          kind: 'support',
          adopted: 1,
          nftMints: [pos.nftMint],
        });
      }
    }

    const recoveredSupportPositions = recoveringPhase1
      ? normalizeRecoveredSupportPositions(existingPool, supportTicks, depthPct)
      : [];
    await assertRecoveredPositionNftsOwned({
      connection,
      ownerPublicKey: ownerKeypair.publicKey,
      poolId,
      positions: recoveredSupportPositions,
    });
    if (recoveredSupportPositions.length > 0) {
      const recovered = recoveredSupportPositions[0];
      console.log(`  recovered support position: nft=${recovered.nftMint}`);
      progress({
        stage: 'support_open_recovered',
        poolId,
        nftMint: recovered.nftMint,
        txId: recovered.txIds.open || null,
        tickLower: recovered.tickLower,
        tickUpper: recovered.tickUpper,
        depthPct: recovered.depthPct,
      });
      supportPositions.push(recovered);
    } else {
    // Base side for the support position is the QUOTE side (opposite of
    // launched). For launchedIsMintA: launched is MintA, so quote is
    // MintB → base = 'MintB'. For launchedIsMintB: launched is MintB,
    // so quote is MintA → base = 'MintA'.
    //
    // The position is fully single-sided in quote, so otherAmountMax = 0
    // is exact (same pattern as ladder bands, just in the opposite
    // direction). useSOLBalance:true lets the SDK auto-wrap native SOL
    // for SOL-pool support positions without us having to pre-fund the
    // wSOL ATA manually.
    let supportTx;
    let supportNftMint;
    try {
      const supportRes = await raydium.clmm.openPositionFromBase({
        poolInfo,
        poolKeys,
        tickLower: supportTicks.tickLower,
        tickUpper: supportTicks.tickUpper,
        base: launchedIsMintA ? 'MintB' : 'MintA',
        baseAmount: supportQuoteRaw,
        otherAmountMax: new BN(0),
        ownerInfo: { useSOLBalance: true },
        txVersion: TxVersion.V0,
        computeBudgetConfig: await lpComputeBudgetConfig(raydium, poolInfo.id),
      });
      supportTx = await supportRes.execute({ sendAndConfirm: true });
      supportNftMint = supportRes.extInfo?.nftMint?.toBase58();
    } catch (err) {
      progress({
        stage: 'support_open_failed',
        poolId,
        quoteAmountRaw: supportQuoteRaw.toString(),
        tickLower: supportTicks.tickLower,
        tickUpper: supportTicks.tickUpper,
        base: launchedIsMintA ? 'MintB' : 'MintA',
        depthPct,
        ...lpErrorProgressFields(err),
      });
      err.phase1PartialResult = phase1Snapshot();
      throw err;
    }
    console.log(`  support opened: nft=${supportNftMint}, tx=${supportTx.txId}`);
    progress({
      stage: 'support_open_done',
      poolId,
      nftMint: supportNftMint,
      txId: supportTx.txId,
      quoteAmountRaw: supportQuoteRaw.toString(),
      tickLower: supportTicks.tickLower,
      tickUpper: supportTicks.tickUpper,
      depthPct,
    });

    supportPositions.push({
      tickLower: supportTicks.tickLower,
      tickUpper: supportTicks.tickUpper,
      depthPct,
      // Raw quote amount deposited. Useful for the journal and the user-
      // facing summary at the end of the launch.
      quoteRaw: supportQuoteRaw.toString(),
      nftMint: supportNftMint,
      // Phase 3 will flip this to true. Support positions never have
      // recipients (Fee Keys stay with the launch wallet and sweep
      // back) — same lifecycle as ladder bands and the bootstrap.
      locked: false,
      txIds: {
        open: supportTx.txId,
        lock: null,
      },
    });
    }
  }

  // -----------------------------------------------------------------------
  // NOTE: the bootstrap position is intentionally NOT opened here.
  //
  // The bootstrap is the position that makes the pool tradable (it's the
  // only position straddling currentTick at launch time). If we opened
  // the bootstrap immediately after this pool's main slices, then for a
  // multi-pool launch the FIRST pool would become tradable while later
  // pools were still being built. A swap on the now-live first pool could
  // move its price, but more importantly the price discovery happening on
  // the first pool would mean later pools — which were configured to all
  // start at the same USD price — could end up with wildly mismatched
  // economics by the time their main positions land.
  //
  // Instead, we hand back the per-pool state needed for bootstrapping
  // (poolInfo/poolKeys/tick math/etc.) and let the orchestrator open all
  // bootstraps in a separate phase, AFTER every pool's main positions are
  // in place. By the time bootstrapping starts, the main positions are
  // already locked at their target ranges and immune to any subsequent
  // price drift the bootstraps might cause.
  // -----------------------------------------------------------------------

  return {
    poolId,
    launchedSide: launchedIsMintA ? 'mintA' : 'mintB',
    // Pool parameters recorded for the launch report / audit record: the
    // tick spacing identifies the fee tier's granularity and initialPrice
    // is the launch price the pool was created at (string — Decimal
    // doesn't JSON-serialize usefully).
    tickSpacing,
    initialPrice: initialPrice.toString(),
    mainPositions,
    ladderPositions,
    supportPositions,
    txIds: { createPool: createTx.txId },
    // Context the deferred bootstrap step needs. Not part of the user-facing
    // result shape — caller strips this before returning.
    _bootstrapContext: {
      poolId,
      poolInfo,
      poolKeys,
      // currentTick captured here is the phase-1 value. The bootstrap step
      // re-fetches the fresh on-chain tick at deposit time to absorb any
      // drift that happened between phases.
      currentTickAtCreation: currentTick,
      tickSpacing,
      launchedIsMintA,
      bootstrapBaseRaw,
      // Mode determines the tick range Phase 2 uses (narrow vs full-range)
      // and influences the otherAmountMax slippage cap sizing. Threaded
      // through unchanged from the orchestrator.
      bootstrapMode: bootstrapMode || 'minimal',
      initialPrice,
      quoteToken,
    },
  };
}

// ---------------------------------------------------------------------------
// Bootstrap-position step (deferred, runs after all main positions land)
// ---------------------------------------------------------------------------

/**
 * Open and lock the bootstrap position for a single pool.
 *
 * This is the position that makes the pool tradable — a tiny (1 whole
 * launched token + a few raw units of quote) two-sided position straddling
 * currentTick. Without it, a freshly-launched pool with only single-sided
 * main positions would be untradable until somebody added in-range liquidity.
 *
 * Run sequentially across all pools at the END of a launch, after every
 * main position is in its final, locked range. See createSinglePool for
 * why this is deferred.
 */
async function openBootstrapPosition({
  raydium,
  ctx,
  // NOTE: lockPositions no longer accepted; locking happens in the
  // dedicated Phase 3 (lockAllPositions). See createSinglePool's note.
  //
  // priorNftMints: the main/ladder/support position NFTs already known for this
  // pool. Excluded from the bootstrap on-chain reconciliation match below
  // (belt-and-suspenders; the straddling bootstrap range is unique anyway).
  priorNftMints,
  onProgress,
}) {
  const progress = (event) => onProgress && onProgress(event);
  const {
    poolId,
    poolInfo,
    poolKeys,
    currentTickAtCreation,
    tickSpacing,
    launchedIsMintA,
    bootstrapBaseRaw,
    bootstrapMode,
    initialPrice,
    quoteToken,
  } = ctx;

  // Re-fetch the *current* on-chain tick rather than reusing the value
  // captured during phase 1. Phase 2 typically runs tens of seconds after
  // phase 1, and a SOL pool's tick in particular drifts on its own clock
  // since it reflects external SOL/USD reality. Computing the bootstrap
  // range against a stale tick was the proximate cause of bootstrap
  // failures observed in earlier multi-pool launches: the deposit math
  // ended up assuming current was inside the range when it was actually
  // a few ticks outside, and the SDK's amount calculation produced a
  // request the wallet couldn't fund.
  const fresh = await raydium.clmm.getRpcClmmPoolInfo({ poolId });
  const currentTick = fresh.tickCurrent;
  if (currentTick !== currentTickAtCreation) {
    console.log(
      `  bootstrap: tick drifted ${currentTickAtCreation} -> ${currentTick} ` +
        `between phases; using fresh value`,
    );
  }

  // Tick range depends on mode. Minimal keeps the historical narrow band
  // around currentTick; custom uses the full MIN_TICK..MAX_TICK range so
  // the user-funded support liquidity backs the pool at every price level.
  const bsTicks = computeBootstrapTicks({
    currentTick,
    tickSpacing,
    mode: bootstrapMode,
  });
  console.log(
    `  bootstrap range [${bsTicks.tickLower}, ${bsTicks.tickUpper}] ` +
      `(mode=${bootstrapMode})`,
  );

  // --- On-chain reconciliation (resume safety) -----------------------------
  // The bootstrap open can land on-chain even when execute() throws (a
  // confirmation timeout under congestion). If that happened on a prior attempt
  // the journal never recorded it, so item.existingBootstrap stays unset and we
  // arrive here and would open a SECOND bootstrap. Before opening, ask the chain
  // whether the wallet already holds a position at exactly this bootstrap range.
  // The bootstrap straddles the current tick (or is full-range in custom mode),
  // a shape no one-sided main, ladder, or support position can match, so a range
  // hit here is unambiguously a previously-landed bootstrap. The scan runs on
  // every attempt (not just resumes) so a late-landing duplicate is caught too.
  // Best-effort: a scan failure falls back to opening, the pre-existing path.
  try {
    const onChainBoot = await fetchOwnerClmmPositionsForPool(raydium, poolId);
    const adoptBoot = unrecordedPositionsAtRange(
      onChainBoot,
      bsTicks.tickLower,
      bsTicks.tickUpper,
      new Set((priorNftMints || []).filter(Boolean)),
    );
    if (adoptBoot.length > 0) {
      const pos = adoptBoot[0];
      console.log(
        `  on-chain reconciliation: bootstrap already landed (nft=${pos.nftMint}); ` +
          `adopting it instead of opening a duplicate`,
      );
      progress({
        stage: 'bootstrap_open_recovered',
        nftMint: pos.nftMint,
        tickLower: pos.tickLower,
        tickUpper: pos.tickUpper,
      });
      return {
        nftMint: pos.nftMint,
        locked: false,
        tickLower: pos.tickLower,
        tickUpper: pos.tickUpper,
        txIds: { open: null, lock: null },
      };
    }
  } catch (e) {
    console.warn(`  bootstrap on-chain reconciliation scan failed (non-fatal): ${e.message}`);
  }

  progress({ stage: 'bootstrap_open_start' });

  // Compute otherAmountMax for the bootstrap.
  //
  // Background on what otherAmountMax does inside the SDK:
  //
  //   - For SOL quote with useSOLBalance:true: the SDK pre-funds the
  //     wSOL ATA with `otherAmountMax` lamports BEFORE opening the
  //     position (refunding the unused remainder at the end). The
  //     wallet must hold this many lamports during the tx. Setting too
  //     high causes the SystemProgram::Transfer to the wSOL ATA to fail
  //     with InsufficientFunds.
  //
  //   - For non-SOL quote: the SDK does NOT pre-fund the quote ATA. It
  //     just transfers from the existing ATA up to the actual amount
  //     required by the position math. otherAmountMax is purely a
  //     slippage limit — the on-chain CLMM program checks
  //     `actual_required <= otherAmountMax` and fails with
  //     PriceSlippageCheck (custom error 6021) if it isn't. Setting
  //     too LOW causes that failure; setting too HIGH costs nothing
  //     because the actual transfer is bounded by the math, not by
  //     this number.
  //
  // For a position straddling the current tick (which all bootstraps
  // do, including the full-range custom variant), the quote-side need
  // is approximately equal in USD value to the launched-side. In raw
  // token terms that's `bootstrapBaseTokens × initialPrice` expressed
  // in the quote's decimals — exactly what equivOtherRaw computes.
  //
  // Old formula used a 200x multiplier as a "burst protection against
  // drift," then capped at 0.01 SOL absolute when quote was SOL. Both
  // pieces were defensive against a 1-whole-token bootstrap with a tiny
  // expected need. When the bootstrap is sized by the user in custom
  // mode (potentially many whole tokens), the 0.01 SOL cap clamps too
  // aggressively and a 200x multiplier produces absurd numbers that
  // serve no purpose. Replacing both with a flat 2x of the actual
  // expected need gives reasonable slippage tolerance at every scale
  // without scaling silliness in either direction.
  //
  // Note: for non-SOL quotes, an over-generous otherAmountMax was harmless
  // (SDK doesn't pre-fund; actual transfer bounded by math). For SOL with
  // useSOLBalance:true it could starve the wallet of lamports, so the
  // tightness change actually frees up SOL budget for the bootstrap's
  // own quote-side requirement.
  // Compute the expected quote-side requirement, then size otherAmountMax
  // at 2x of it. equivOtherRaw = (bootstrap whole-token amount) × initialPrice
  // × 10^quoteDecimals, where initialPrice is quote-per-launched-whole. This
  // is approximately what the SDK will actually transfer on the quote side
  // for any range straddling the current tick — narrow OR full.
  //
  // launchedDecimals is recovered from poolInfo since we don't carry it
  // explicitly in the bootstrap context: it's whatever the launched mint's
  // decimals are, which lives on the SDK's pool info.
  const launchedDecimals = launchedIsMintA
    ? poolInfo.mintA.decimals
    : poolInfo.mintB.decimals;
  const bootstrapWhole = new Decimal(bootstrapBaseRaw.toString())
    .div(new Decimal(10).pow(launchedDecimals));
  const equivOtherRaw = bootstrapWhole
    .mul(initialPrice)
    .mul(new Decimal(10).pow(quoteToken.decimals));

  // 2x of the expected need gives roughly 50% slippage tolerance — enough
  // to absorb tick drift between phases and intra-block price movement,
  // without over-sizing.
  const bsOtherMaxDecimal = equivOtherRaw.mul(2);

  // Floor at 1000 raw — handles extreme micro-price launches where the
  // computed value rounds to 0 (e.g. 1 token bootstrap at a $0.00000001
  // launch price against a high-decimal quote).
  const bsOtherMax = BN.max(new BN(bsOtherMaxDecimal.toFixed(0)), new BN(1000));
  const isQuoteSol = quoteToken.address === WSOL_MINT;
  console.log(
    `  bootstrap otherAmountMax: ${bsOtherMax.toString()} raw quote ` +
      `(actual need ~${equivOtherRaw.toFixed(0)} raw, ` +
      `bootstrapWhole=${bootstrapWhole.toFixed(6)}, ` +
      `isQuoteSol=${isQuoteSol})`,
  );

  const bsRes = await raydium.clmm.openPositionFromBase({
    poolInfo,
    poolKeys,
    ownerInfo: { useSOLBalance: true },
    tickLower: bsTicks.tickLower,
    tickUpper: bsTicks.tickUpper,
    base: launchedIsMintA ? 'MintA' : 'MintB',
    baseAmount: bootstrapBaseRaw,
    otherAmountMax: bsOtherMax,
    txVersion: TxVersion.V0,
    computeBudgetConfig: await lpComputeBudgetConfig(raydium, poolInfo.id),
  });
  const bsTx = await bsRes.execute({ sendAndConfirm: true });
  const bsNftMint = bsRes.extInfo?.nftMint?.toBase58();
  console.log(`  bootstrap opened: nft=${bsNftMint}, tx=${bsTx.txId}`);
  progress({
    stage: 'bootstrap_open_done',
    nftMint: bsNftMint,
    txId: bsTx.txId,
    // Journaled so a resumed launch's bootstrap record keeps its range.
    tickLower: bsTicks.tickLower,
    tickUpper: bsTicks.tickUpper,
  });

  // Lock the bootstrap. Bootstrap is never split or transferred to recipients
  // — the Fee Key just stays with the ephemeral wallet for the final sweep.
  //
  // Bootstrap locking is now deferred to a dedicated phase (lockAllPositions),
  // matching the deferred-lock model for main positions. We return the open
  // result with locked: false; Phase 3 will mutate this entry in place.
  // Until Phase 3 runs, the bootstrap is openable+closable by the ephemeral
  // wallet — the same recoverable state main positions sit in between
  // Phase 1 and Phase 3.
  return {
    nftMint: bsNftMint,
    locked: false,
    // Tick range recorded for the launch report / audit record, same as
    // every other position type.
    tickLower: bsTicks.tickLower,
    tickUpper: bsTicks.tickUpper,
    txIds: { open: bsTx.txId, lock: null },
  };
}

// Pull the Fee Key NFT mint out of a raydium.clmm.lockPosition() result.
//
// Verified against the SDK source (v0.1.144-alpha): lockPosition() returns
// extInfo = ClmmInstrument.makeLockPositions().address, which includes
// `lockNftMint` — the mint of the NEW NFT that Burn & Earn creates. The
// original position NFT is moved into the lock program's escrow ATA by the
// same instruction, so after a lock the wallet holds the lock NFT, not the
// position NFT. That lock NFT *is* the Fee Key: it collects the trading
// fees and it's what transfers (Phase 4) and sweeps (step 6).
//
// Recording it matters twice over: the launch report / Arweave audit record
// needs it so a verifier can tie each locked position to the Fee Key that
// owns its fee stream, and Phase 4 needs it to transfer the right mint.
// Defensive access throughout — a missing field records null rather than
// failing a lock that already succeeded on-chain.
function feeKeyMintFromLockResult(lockRes) {
  try {
    const m = lockRes?.extInfo?.lockNftMint;
    if (!m) return null;
    return typeof m === 'string' ? m : m.toBase58();
  } catch (_) {
    return null;
  }
}

// Raydium's CLMM lock program ("Burn & Earn"). A locked position's NFT is held
// in this program's escrow; the program also stores a per-lock account that
// maps the original position mint to the Fee Key (lock NFT) mint. The id is the
// immutable deployed program address, taken from the SDK's constants.
const CLMM_LOCK_PROGRAM_ID = new PublicKey('DLockwT7X7sxtLmGH9g5kmfcjaBtncdbUmi738m5bvQC');

// Byte offset of the positionId field inside the lock program's
// LockClPositionLayoutV2 account (8 discriminator + 1 bump + 32 lockOwner + 32
// poolId = 73). Used ONLY to pre-filter the getProgramAccounts scan below, and
// deliberately not load-bearing for correctness: if it were wrong the scan would
// just return no match and the caller would record the original failure — it can
// never produce a wrong Fee Key. The Fee Key itself is read with the SDK's own
// decoder, not a hand-coded offset, and re-verified against positionId.
const LOCK_ACCT_POSITION_ID_OFFSET = 73;

// Look up the on-chain lock for a position directly from the lock program. A
// lock account whose positionId matches means the position is already locked,
// and that same account carries the Fee Key (lock NFT) mint — the value the
// report needs and Phase 4 transfers. Returns the Fee Key mint as a base58
// string, or null when no lock exists.
//
// Why look up by positionId (a getProgramAccounts memcmp) rather than the SDK's
// getOwnerLockedPositionInfo: that method enumerates locks via the lock NFTs the
// wallet currently holds, so it would miss a main position whose Fee Key has
// already been transferred to a recipient. The lock account records the
// immutable positionId, so looking up by it finds the lock no matter where the
// Fee Key now lives. The matched account is decoded with the SDK's own
// LockClPositionLayoutV2 — not hand-coded byte offsets — and its decoded
// positionId is re-checked, so neither the filter offset nor any field offset is
// load-bearing for correctness.
//
// This is only ever called from a lock failure path: a lock attempt threw, and
// we are asking whether it nonetheless already happened (a confirmation timeout
// throws even when the tx landed, and a resume re-locks a position whose prior
// lock was never journaled). A throw or null here leaves the original failure
// intact, so this can never invent a success — only reclassify a genuine
// on-chain lock the journal missed. Cost is paid only when a lock fails, never
// on the happy path.
async function findLockFeeKeyForPosition(raydium, positionNftMint) {
  const accounts = await raydium.connection.getProgramAccounts(CLMM_LOCK_PROGRAM_ID, {
    filters: [
      {
        // Pre-filter to lock accounts whose positionId equals this position's
        // mint; the decode below re-verifies, so this only narrows the scan.
        memcmp: {
          offset: LOCK_ACCT_POSITION_ID_OFFSET,
          bytes: positionNftMint,
          encoding: 'base58',
        },
      },
    ],
  });
  for (const acct of accounts || []) {
    let decoded;
    try {
      decoded = LockClPositionLayoutV2.decode(acct.account.data);
    } catch (_) {
      continue; // not a lock account we can read — ignore
    }
    if (
      decoded &&
      decoded.positionId &&
      decoded.positionId.toString() === positionNftMint &&
      decoded.lockNftMint
    ) {
      return decoded.lockNftMint.toString();
    }
  }
  return null;
}

// Check whether a Fee Key (lock NFT) already sits in the recipient's wallet —
// positive evidence that a prior transfer landed even though its confirmation
// never reached the journal. Returns true only when the recipient's associated
// token account for the mint holds the NFT; any RPC error or missing account
// returns false (errors swallowed here). Like the lock check above, this is
// only consulted on a transfer failure path, so it adds no happy-path cost and
// can only reclassify a transfer that genuinely already landed. Lock NFTs are
// standard SPL tokens, so the classic Token program ATA is the right
// derivation.
async function feeKeyIsAtRecipient(raydium, feeKeyMint, recipient) {
  try {
    const ata = getAssociatedTokenAddressSync(
      new PublicKey(feeKeyMint),
      new PublicKey(recipient),
      true, // recipients may be PDAs or multisigs (owner off-curve)
      TOKEN_PROGRAM_ID,
    );
    const bal = await raydium.connection.getTokenAccountBalance(ata);
    return !!(bal && bal.value && Number(bal.value.amount) >= 1);
  } catch (_) {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Phase 3: Lock every position across every pool.
//
// Runs after every position (main + bootstrap) is open across every pool.
// This is the irreversibility line: each successful lock escrows the position
// NFT and mints a Fee Key NFT, committing the LP'd tokens for life.
//
// Fail-soft: failures collect into a `lockFailures` array and don't stop
// other locks from being attempted. Locks are independent transactions
// against the lock program — one failing doesn't affect another's chances.
//
// Iteration order is per-allocation (all of pool 1 first, then all of
// pool 2, etc.) so a partial-failure leaves whole pools either locked or
// not-locked rather than a scattered pattern across pools. Within a pool,
// main positions lock before the bootstrap; the bootstrap is the smallest
// and most reliable lock target, so locking mains first surfaces the more
// likely failure cases earlier.
//
// Between pools, SOL-paired allocations are processed LAST — matching
// the Phase 2 bootstrap-open order. Locks don't change tradability (the
// positions already hold their liquidity), but mirroring the open order
// here keeps the on-chain action sequence and the activity-log display
// coherent: every flywheel/exotic pool's work finishes before the SOL
// pool's final lock. Stable sort preserves user-config order within
// each group, so results[] stays in user-config order for downstream
// consumers (launch report, UI) while iteration goes SOL-last.
//
// Mutates the results in place: each `mainPositions[i].locked` and
// `mainPositions[i].txIds.lock` get set, same for the bootstrap.
// ---------------------------------------------------------------------------
// Inter-tx pacing for Phase 3 (locks) and Phase 4 (transfers).
//
// sendAndConfirm is the natural floor between transactions because it
// blocks until the tx is finalized, which takes a couple of seconds at
// minimum. But on fast paid RPCs (Helius, Triton) confirmations can come
// back in <1s and back-to-back tx submissions can burst above per-second
// rate limits. A small explicit sleep between txs evens out the cadence
// and keeps us comfortably under most free-tier 429 thresholds without
// materially slowing real launches.
//
// 250ms = ~4 TPS, matching the airdrop's conservative-by-default
// philosophy. Same logic as walletHelpers.js: going at 75% speed is
// better than hitting a rate limit mid-launch and losing more time
// recovering than the slow pace would have cost.
const LOCK_TX_PACING_MS = 250;
const TRANSFER_TX_PACING_MS = 250;

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function lockAllPositions({ raydium, results, onProgress }) {
  const progress = (event) => onProgress && onProgress(event);
  const lockFailures = [];

  console.log('\n=== Phase 3: Locking positions ===');
  progress({ stage: 'phase3_start' });

  // Build iteration order: non-SOL allocations first (in user-config order),
  // then SOL allocations last (in their original relative order). results[]
  // itself is NOT reordered — downstream consumers depend on that ordering.
  const iterOrder = results
    .map((_, idx) => idx)
    .sort((a, b) => {
      const aIsSol = results[a].quoteAddress === WSOL_MINT;
      const bIsSol = results[b].quoteAddress === WSOL_MINT;
      return Number(aIsSol) - Number(bIsSol);
    });

  for (const allocIdx of iterOrder) {
    const r = results[allocIdx];
    const symbol = r.quoteSymbol || '(?)';

    // 3a. Lock each main position in order.
    for (let i = 0; i < (r.mainPositions || []).length; i++) {
      const pos = r.mainPositions[i];
      if (pos.locked) {
        // Resume: already locked in a prior attempt; skip.
        console.log(`[${symbol}] main slice ${i + 1}: already locked (skip)`);
        continue;
      }
      if (!pos.nftMint) {
        // Defensive: should not happen if Phase 1 completed cleanly,
        // but if a result entry somehow lacks an nftMint, skip rather
        // than crash. The fail-soft collector picks this up as a
        // failure with a clear message.
        console.log(`[${symbol}] main slice ${i + 1}: no nftMint - skip`);
        lockFailures.push({
          allocationIndex: allocIdx,
          positionType: 'main',
          sliceIndex: i,
          nftMint: null,
          error: 'no nftMint on result entry',
        });
        continue;
      }
      console.log(`[${symbol}] locking main slice ${i + 1}/${r.mainPositions.length}: nft=${pos.nftMint}`);
      try {
        const lockRes = await raydium.clmm.lockPosition({
          ownerPosition: { nftMint: new PublicKey(pos.nftMint) },
          txVersion: TxVersion.V0,
        });
        const lockTx = await lockRes.execute({ sendAndConfirm: true });
        pos.locked = true;
        pos.txIds.lock = lockTx.txId;
        pos.feeKeyNftMint = feeKeyMintFromLockResult(lockRes);
        console.log(`  locked: tx=${lockTx.txId}`);
        progress({
          stage: 'main_lock_done',
          allocationIndex: allocIdx,
          sliceIndex: i,
          txId: lockTx.txId,
          // Journaled so crash-resumed launches keep the Fee Key mint
          // (Phase 4 transfers it; the audit record publishes it).
          feeKeyNftMint: pos.feeKeyNftMint,
        });
      } catch (e) {
        // The lock may have actually landed despite this throw (a confirmation
        // timeout under congestion), or this is a resume re-locking a position
        // whose prior lock was never journaled — in which case re-locking
        // throws because the position NFT is already in the lock escrow. Ask
        // the lock program before recording a failure; if a lock exists, adopt
        // its Fee Key and treat it as recovered. Any scan error leaves the
        // failure intact.
        let recoveredFeeKey = null;
        try {
          recoveredFeeKey = await findLockFeeKeyForPosition(raydium, pos.nftMint);
        } catch (_) {
          recoveredFeeKey = null;
        }
        if (recoveredFeeKey) {
          pos.locked = true;
          pos.feeKeyNftMint = recoveredFeeKey;
          console.log(
            `  lock already on-chain (Fee Key ${recoveredFeeKey}); recovered`,
          );
          progress({
            stage: 'main_lock_recovered',
            allocationIndex: allocIdx,
            sliceIndex: i,
            feeKeyNftMint: recoveredFeeKey,
          });
        } else {
          console.error(`  lock FAILED: ${e.message}`);
          lockFailures.push({
            allocationIndex: allocIdx,
            positionType: 'main',
            sliceIndex: i,
            nftMint: pos.nftMint,
            error: e.message,
          });
          progress({
            stage: 'main_lock_failed',
            allocationIndex: allocIdx,
            sliceIndex: i,
            error: e.message,
          });
        }
      }
      // Inter-tx pacing — see LOCK_TX_PACING_MS rationale above.
      // Applies whether the lock succeeded or failed; the next lock
      // is going to hit the RPC regardless.
      await sleepMs(LOCK_TX_PACING_MS);
    }

    // 3b. Lock each ladder band in order. Ladder bands are independent
    //     of main slices and bootstrap; they just need locking.
    for (let bi = 0; bi < (r.ladderPositions || []).length; bi++) {
      const lp = r.ladderPositions[bi];
      if (lp.locked) {
        console.log(`[${symbol}] ladder band ${bi + 1}: already locked (skip)`);
        continue;
      }
      if (!lp.nftMint) {
        console.log(`[${symbol}] ladder band ${bi + 1}: no nftMint - skip`);
        lockFailures.push({
          allocationIndex: allocIdx,
          positionType: 'ladder',
          sliceIndex: bi,
          nftMint: null,
          error: 'no nftMint on ladder result entry',
        });
        continue;
      }
      console.log(`[${symbol}] locking ladder band ${bi + 1}/${r.ladderPositions.length}: nft=${lp.nftMint}`);
      try {
        const lockRes = await raydium.clmm.lockPosition({
          ownerPosition: { nftMint: new PublicKey(lp.nftMint) },
          txVersion: TxVersion.V0,
        });
        const lockTx = await lockRes.execute({ sendAndConfirm: true });
        lp.locked = true;
        lp.txIds.lock = lockTx.txId;
        lp.feeKeyNftMint = feeKeyMintFromLockResult(lockRes);
        console.log(`  locked: tx=${lockTx.txId}`);
        progress({
          stage: 'ladder_lock_done',
          feeKeyNftMint: lp.feeKeyNftMint,
          allocationIndex: allocIdx,
          bandIndex: bi,
          txId: lockTx.txId,
        });
      } catch (e) {
        // See the main-slice lock catch above for the rationale.
        let recoveredFeeKey = null;
        try {
          recoveredFeeKey = await findLockFeeKeyForPosition(raydium, lp.nftMint);
        } catch (_) {
          recoveredFeeKey = null;
        }
        if (recoveredFeeKey) {
          lp.locked = true;
          lp.feeKeyNftMint = recoveredFeeKey;
          console.log(
            `  lock already on-chain (Fee Key ${recoveredFeeKey}); recovered`,
          );
          progress({
            stage: 'ladder_lock_recovered',
            allocationIndex: allocIdx,
            bandIndex: bi,
            feeKeyNftMint: recoveredFeeKey,
          });
        } else {
          console.error(`  lock FAILED: ${e.message}`);
          lockFailures.push({
            allocationIndex: allocIdx,
            positionType: 'ladder',
            sliceIndex: bi,
            nftMint: lp.nftMint,
            error: e.message,
          });
          progress({
            stage: 'ladder_lock_failed',
            allocationIndex: allocIdx,
            bandIndex: bi,
            error: e.message,
          });
        }
      }
      // Inter-tx pacing — same rationale as the main-slice loop above.
      await sleepMs(LOCK_TX_PACING_MS);
    }

    // 3c. Lock each support position in order. Same lifecycle as ladder
    //     bands — independent positions, fee key stays with the launch
    //     wallet, no recipient. We lock them after main/ladder but
    //     before bootstrap so the on-chain ordering matches the open
    //     order from Phase 1.
    for (let si = 0; si < (r.supportPositions || []).length; si++) {
      const sp = r.supportPositions[si];
      if (sp.locked) {
        console.log(`[${symbol}] support position ${si + 1}: already locked (skip)`);
        continue;
      }
      if (!sp.nftMint) {
        console.log(`[${symbol}] support position ${si + 1}: no nftMint - skip`);
        lockFailures.push({
          allocationIndex: allocIdx,
          positionType: 'support',
          sliceIndex: si,
          nftMint: null,
          error: 'no nftMint on support result entry',
        });
        continue;
      }
      console.log(`[${symbol}] locking support position ${si + 1}/${r.supportPositions.length}: nft=${sp.nftMint}`);
      try {
        const lockRes = await raydium.clmm.lockPosition({
          ownerPosition: { nftMint: new PublicKey(sp.nftMint) },
          txVersion: TxVersion.V0,
        });
        const lockTx = await lockRes.execute({ sendAndConfirm: true });
        sp.locked = true;
        sp.txIds.lock = lockTx.txId;
        sp.feeKeyNftMint = feeKeyMintFromLockResult(lockRes);
        console.log(`  locked: tx=${lockTx.txId}`);
        progress({
          stage: 'support_lock_done',
          feeKeyNftMint: sp.feeKeyNftMint,
          allocationIndex: allocIdx,
          supportIndex: si,
          txId: lockTx.txId,
        });
      } catch (e) {
        // See the main-slice lock catch above for the rationale.
        let recoveredFeeKey = null;
        try {
          recoveredFeeKey = await findLockFeeKeyForPosition(raydium, sp.nftMint);
        } catch (_) {
          recoveredFeeKey = null;
        }
        if (recoveredFeeKey) {
          sp.locked = true;
          sp.feeKeyNftMint = recoveredFeeKey;
          console.log(
            `  lock already on-chain (Fee Key ${recoveredFeeKey}); recovered`,
          );
          progress({
            stage: 'support_lock_recovered',
            allocationIndex: allocIdx,
            supportIndex: si,
            feeKeyNftMint: recoveredFeeKey,
          });
        } else {
          console.error(`  lock FAILED: ${e.message}`);
          lockFailures.push({
            allocationIndex: allocIdx,
            positionType: 'support',
            sliceIndex: si,
            nftMint: sp.nftMint,
            error: e.message,
          });
          progress({
            stage: 'support_lock_failed',
            allocationIndex: allocIdx,
            supportIndex: si,
            error: e.message,
          });
        }
      }
      // Inter-tx pacing — same rationale as the main-slice loop above.
      await sleepMs(LOCK_TX_PACING_MS);
    }

    // 3d. Lock the bootstrap for this pool.
    const bs = r.bootstrap;
    if (bs && bs.nftMint && !bs.locked) {
      console.log(`[${symbol}] locking bootstrap: nft=${bs.nftMint}`);
      try {
        const lockRes = await raydium.clmm.lockPosition({
          ownerPosition: { nftMint: new PublicKey(bs.nftMint) },
          txVersion: TxVersion.V0,
        });
        const lockTx = await lockRes.execute({ sendAndConfirm: true });
        bs.locked = true;
        bs.txIds.lock = lockTx.txId;
        bs.feeKeyNftMint = feeKeyMintFromLockResult(lockRes);
        console.log(`  bootstrap locked: tx=${lockTx.txId}`);
        progress({
          stage: 'bootstrap_lock_done',
          feeKeyNftMint: bs.feeKeyNftMint,
          allocationIndex: allocIdx,
          txId: lockTx.txId,
        });
      } catch (e) {
        // See the main-slice lock catch above for the rationale.
        let recoveredFeeKey = null;
        try {
          recoveredFeeKey = await findLockFeeKeyForPosition(raydium, bs.nftMint);
        } catch (_) {
          recoveredFeeKey = null;
        }
        if (recoveredFeeKey) {
          bs.locked = true;
          bs.feeKeyNftMint = recoveredFeeKey;
          console.log(
            `  bootstrap lock already on-chain (Fee Key ${recoveredFeeKey}); recovered`,
          );
          progress({
            stage: 'bootstrap_lock_recovered',
            allocationIndex: allocIdx,
            feeKeyNftMint: recoveredFeeKey,
          });
        } else {
          console.error(`  bootstrap lock FAILED: ${e.message}`);
          lockFailures.push({
            allocationIndex: allocIdx,
            positionType: 'bootstrap',
            sliceIndex: null,
            nftMint: bs.nftMint,
            error: e.message,
          });
          progress({
            stage: 'bootstrap_lock_failed',
            allocationIndex: allocIdx,
            error: e.message,
          });
        }
      }
      // Inter-tx pacing — same rationale as the main-slice loop above.
      // This is also the last lock in this pool's iteration, so it paces
      // the transition into the next pool's main locks.
      await sleepMs(LOCK_TX_PACING_MS);
    } else if (bs && bs.locked) {
      console.log(`[${symbol}] bootstrap: already locked (skip)`);
    } else if (!bs || !bs.nftMint) {
      // No bootstrap to lock — Phase 2 must have failed for this pool.
      // The bootstrap failure was already reported via bootstrapFailures;
      // nothing to add here.
      console.log(`[${symbol}] bootstrap: no nftMint to lock (Phase 2 failure expected)`);
    }
  }

  console.log(`=== Phase 3 done: ${lockFailures.length} failure(s) ===\n`);
  progress({ stage: 'phase3_done', failureCount: lockFailures.length });
  return { lockFailures };
}

// ---------------------------------------------------------------------------
// Phase 4: Transfer Fee Key NFTs to external recipients.
//
// Runs after Phase 3. Only LOCKED positions have Fee Key NFTs to transfer —
// the Fee Key is the lock NFT the locker mints while moving the position
// NFT into the lock program's escrow, so an unlocked position has no
// Fee Key (and the position NFT itself is no longer in the wallet).
//
// Fail-soft like Phase 3. Failures collect into `transferFailures` and
// don't block other transfers. A transfer failure leaves the Fee Key NFT
// in the ephemeral wallet, where the final sweep step will pick it up
// and deliver it to the user's destination wallet — so a failed transfer
// at this phase isn't catastrophic, the user just ends up with the Fee
// Key in their primary wallet instead of the slice's recipient address.
//
// Mutates results in place: each transferring slice's `transferredTo`
// and `txIds.transfer` get populated.
// ---------------------------------------------------------------------------
async function transferFeeKeys({ raydium, ownerKeypair, results, onProgress }) {
  const progress = (event) => onProgress && onProgress(event);
  const connection = raydium.connection;
  const transferFailures = [];

  // Skip Phase 4 entirely if nothing has a recipient — cheap fast-path.
  const hasAnyRecipient = results.some((r) =>
    (r.mainPositions || []).some((p) => p.recipient && !p.transferredTo),
  );
  if (!hasAnyRecipient) {
    console.log('=== Phase 4: no Fee Key transfers needed (skip) ===\n');
    progress({ stage: 'phase4_skipped' });
    return { transferFailures };
  }

  console.log('\n=== Phase 4: Transferring Fee Key NFTs ===');
  progress({ stage: 'phase4_start' });

  for (let allocIdx = 0; allocIdx < results.length; allocIdx++) {
    const r = results[allocIdx];
    const symbol = r.quoteSymbol || '(?)';

    for (let i = 0; i < (r.mainPositions || []).length; i++) {
      const pos = r.mainPositions[i];
      if (!pos.recipient) continue;
      if (pos.transferredTo === pos.recipient) {
        // Resume: already transferred to this recipient; skip.
        console.log(`[${symbol}] main slice ${i + 1}: already transferred (skip)`);
        continue;
      }
      if (!pos.locked) {
        // No Fee Key to transfer — the position never locked. Push a
        // failure entry so the user knows the recipient didn't get
        // their NFT, and skip.
        console.log(`[${symbol}] main slice ${i + 1}: not locked, no Fee Key to transfer`);
        transferFailures.push({
          allocationIndex: allocIdx,
          sliceIndex: i,
          nftMint: pos.nftMint,
          recipient: pos.recipient,
          error: 'position not locked - no Fee Key NFT exists',
        });
        continue;
      }
      // The Fee Key is the lock NFT Burn & Earn minted in Phase 3 — the
      // original position NFT moved into the lock program's escrow when the
      // lock executed, so it's no longer in the wallet. Prefer the recorded
      // feeKeyNftMint; the pos.nftMint fallback only matters for journals
      // written before the field existed (those transfers fail into
      // transferFailures, same as they would have before).
      const feeKeyMint = pos.feeKeyNftMint || pos.nftMint;
      console.log(`[${symbol}] transferring Fee Key (slice ${i + 1}) nft=${feeKeyMint} to ${pos.recipient}...`);
      try {
        const txId = await transferNftToRecipient({
          connection,
          ownerKeypair,
          nftMint: feeKeyMint,
          recipient: pos.recipient,
        });
        pos.transferredTo = pos.recipient;
        pos.txIds.transfer = txId;
        console.log(`  transferred: tx=${txId}`);
        progress({
          stage: 'main_transfer_done',
          allocationIndex: allocIdx,
          sliceIndex: i,
          recipient: pos.recipient,
          txId,
        });
      } catch (e) {
        // The transfer may have actually landed despite this throw, or this is
        // a resume re-transferring a Fee Key that already left this wallet — in
        // which case re-transferring throws. Before recording a failure, check
        // whether the Fee Key is already sitting at the recipient; if so, record
        // it and treat it as recovered. feeKeyIsAtRecipient swallows scan errors
        // and returns false, so any uncertainty leaves the failure intact.
        if (await feeKeyIsAtRecipient(raydium, feeKeyMint, pos.recipient)) {
          pos.transferredTo = pos.recipient;
          console.log(`  Fee Key already at recipient on-chain; recovered`);
          progress({
            stage: 'main_transfer_recovered',
            allocationIndex: allocIdx,
            sliceIndex: i,
            recipient: pos.recipient,
          });
        } else {
          console.error(`  transfer FAILED: ${e.message}`);
          transferFailures.push({
            allocationIndex: allocIdx,
            sliceIndex: i,
            nftMint: pos.nftMint,
            recipient: pos.recipient,
            error: e.message,
          });
          progress({
            stage: 'main_transfer_failed',
            allocationIndex: allocIdx,
            sliceIndex: i,
            error: e.message,
          });
        }
      }
      // Inter-tx pacing — same rationale as Phase 3 locks. Phase 4 txs
      // are simpler (single SPL transfer, no Raydium SDK path) so the
      // pacing constant is separate for independent tuning later.
      await sleepMs(TRANSFER_TX_PACING_MS);
    }
  }

  console.log(`=== Phase 4 done: ${transferFailures.length} failure(s) ===\n`);
  progress({ stage: 'phase4_done', failureCount: transferFailures.length });
  return { transferFailures };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

// Shared helper: resolve the canonical quote-USD price for one
// allocation, enforcing the Milestone A rules from the price-safety
// plan. Called from both createPoolsAndPositions (the actual launch)
// and preflightCreatePoolsAndPositions (the pre-commit dry run that
// powers the Milestone C confirmation modal).
//
// Throws on any failure (no Raydium route, network error, drift >25%,
// non-positive price). Callers attach allocation context (index,
// failedAllocation, partialResults) and the pre_flight phase tag
// before propagating.
//
// On success returns { quoteUsd: Decimal, source: string, driftPct: number | null }
//   - quoteUsd: the price to use for initialPrice math
//   - source:   provenance label ('sol' | 'raydium-probe')
//   - driftPct: when an override was present, the measured drift between
//               probe and override (signed; positive means probe > override).
//               null when no override was set.
//
// `quoteToken` shape:  { address: base58, symbol: string, decimals: number }
// `alloc` shape:       { quoteUsdOverride?: number | string | null, ... }
async function resolveQuoteUsdForCreate({
  quoteToken,
  alloc,
  solUsd,
}) {
  let quoteUsd;
  let source;

  if (quoteToken.address === WSOL_MINT) {
    // SOL pool: caller already resolved (and validated) SOL/USD.
    quoteUsd = solUsd;
    source = 'sol';
  } else {
    // Non-SOL: probe Raydium fresh. The strict probe throws on any
    // failure with err.code; translate to a user-facing message.
    //
    // Policy on probe failures:
    //   - NO_ROUTE: Raydium has no pool for this token. Fall through
    //     to the aggregator price (Gecko → DexScreener via getUsdPrice).
    //     The aggregators index Meteora/Orca/other DEXes and produce
    //     a real market price; we trust them when Raydium itself has
    //     nothing to offer.
    //   - NETWORK_ERROR / HTTP_ERROR / BAD_RESPONSE: TRANSIENT Raydium
    //     issue. Don't silently fall back — the user should retry once
    //     Raydium recovers. Otherwise we'd be downgrading from the
    //     canonical source to a slower mirror on every Raydium hiccup,
    //     and the user wouldn't know.
    //   - Other / unknown: refuse, same reasoning.
    let probeResult;
    let probeFailedNoRoute = false;
    try {
      probeResult = await probeRaydiumPriceStrict({
        quoteMint: quoteToken.address,
        quoteDecimals: quoteToken.decimals,
        solUsd,
      });
    } catch (probeErr) {
      const code = probeErr.code || 'UNKNOWN';
      if (code === 'NO_ROUTE') {
        // Fall through to aggregator. We'll resolve price below.
        probeFailedNoRoute = true;
      } else {
        // Transient or unexpected — refuse with a user-facing message.
        const symbolHint =
          quoteToken.symbol && quoteToken.symbol !== quoteToken.address
            ? `${quoteToken.symbol} (${quoteToken.address})`
            : quoteToken.address;
        let userMsg;
        if (code === 'NETWORK_ERROR') {
          userMsg =
            `Couldn't reach the Raydium Trade API to verify the current ` +
            `price of ${symbolHint}. This is a temporary issue; please ` +
            `wait a moment and try again. No SOL was spent.`;
        } else if (code === 'HTTP_ERROR') {
          userMsg =
            `The Raydium Trade API returned an error (HTTP ${probeErr.status}) ` +
            `when verifying the price of ${symbolHint}. This is a temporary ` +
            `issue; please wait a moment and try again. No SOL was spent.`;
        } else if (code === 'BAD_RESPONSE') {
          userMsg =
            `The Raydium Trade API returned an unexpected response when ` +
            `verifying the price of ${symbolHint}. Please try again. If the ` +
            `problem persists, the API may be experiencing issues. No SOL ` +
            `was spent.`;
        } else {
          userMsg =
            `Couldn't verify the current Raydium price of ${symbolHint}: ` +
            `${probeErr.message}. No SOL was spent.`;
        }
        const userErr = new Error(userMsg);
        userErr.cause = probeErr;
        userErr.probeCode = code;
        throw userErr;
      }
    }

    if (probeFailedNoRoute) {
      // No Raydium route — fall back to the aggregator chain.
      // getUsdPrice cascades through Jupiter → Gecko → DexScreener,
      // which is the same chain that powered the price the user saw
      // at Step 2. If THIS fails too (all aggregators down or token
      // not indexed anywhere), we refuse — no price means no safe
      // launch. The user can still proceed via an explicit
      // quoteUsdOverride if they really want to, which the override
      // branch above handles.
      let aggregatorPrice = null;
      try {
        aggregatorPrice = await getUsdPrice(quoteToken.address);
      } catch (_) { /* handled below */ }
      if (!aggregatorPrice || !aggregatorPrice.gt(0)) {
        const symbolHint =
          quoteToken.symbol && quoteToken.symbol !== quoteToken.address
            ? `${quoteToken.symbol} (${quoteToken.address})`
            : quoteToken.address;
        throw new Error(
          `Raydium has no route for ${symbolHint}, and no aggregator ` +
          `(GeckoTerminal, DexScreener) could price it either. We can't ` +
          `safely set the initial pool price without a current market ` +
          `reference. Either set a price manually in the Advanced ` +
          `override field, or pick a different quote token. No SOL was spent.`,
        );
      }
      quoteUsd = aggregatorPrice;
      source = 'oracle';
    } else {
      quoteUsd = probeResult.effectiveQuoteUsd;
      source = 'raydium-probe';
    }
  }

  // Sanity floor BEFORE the drift check — a non-positive value never
  // passes the drift check anyway, but we want a specific error msg.
  if (!quoteUsd || !quoteUsd.isFinite() || !quoteUsd.gt(0)) {
    throw new Error(
      `Resolved quote USD price for ${quoteToken.symbol} is invalid ` +
      `(${quoteUsd?.toString() || 'null'}). This shouldn't happen - ` +
      `please report this as a bug. No SOL was spent.`,
    );
  }

  // Drift guard against the override (if any). The override carries the
  // price the user committed to at funding-estimate time, or what they
  // typed manually in customize mode. If it diverges from the live
  // probe by more than the configured threshold, abort. The drift
  // check itself is in lpMath.driftExceedsThreshold — pure, no SDK
  // dependencies, unit-tested. Decimal arithmetic stays for the
  // display percentage so the user sees precise numbers.
  let driftPct = null;
  if (
    alloc.quoteUsdOverride !== undefined &&
    alloc.quoteUsdOverride !== null
  ) {
    const override = new Decimal(alloc.quoteUsdOverride);
    if (override.gt(0)) {
      const probeNum = quoteUsd.toNumber();
      const overrideNum = override.toNumber();
      // Signed drift: positive when current Raydium price is higher
      // than the override (funding-estimate or user-typed value),
      // negative when lower. The modal uses this to render "X% higher"
      // or "X% lower" so the user knows which direction the price
      // moved. (The drift-exceeds-threshold check itself is symmetric
      // and uses driftExceedsThreshold separately.)
      driftPct = Number(driftPercent(probeNum, overrideNum).toFixed(2));
      // Coerce NaN to null so callers can do a clean nullish check.
      // (Shouldn't happen in practice — we guarded override.gt(0) and
      // the sanity floor on quoteUsd, but defense in depth.)
      if (!Number.isFinite(driftPct)) driftPct = null;
      if (driftExceedsThreshold(probeNum, overrideNum, PRICE_DRIFT_THRESHOLD)) {
        const symbolHint =
          quoteToken.symbol && quoteToken.symbol !== quoteToken.address
            ? quoteToken.symbol
            : quoteToken.address;
        // Display the absolute drift magnitude in the error message —
        // "27.3% difference" reads naturally regardless of direction,
        // and the over/under details are visible in the price values.
        throw new Error(
          `Price drift detected for ${symbolHint}: ` +
          `funding-estimate showed $${override.toString()} but current ` +
          `Raydium price is $${quoteUsd.toString()} (${Math.abs(driftPct).toFixed(2)}% ` +
          `difference, threshold is ` +
          `${((PRICE_DRIFT_THRESHOLD - 1) * 100).toFixed(0)}%). ` +
          `Refresh the funding estimate on Step 3 to recompute, then ` +
          `try Create Pools again. No SOL was spent.`,
        );
      }
    }
  }

  return { quoteUsd, source, driftPct };
}

/**
 * Pre-commit dry run: resolve quote-token prices for all allocations
 * and run drift checks WITHOUT touching chain. Powers the Milestone C
 * confirmation modal — the frontend calls this before /api/create-lp
 * so the user sees what initialPrice each pool will be created at and
 * can abort if anything looks wrong.
 *
 * Note: the resulting prices are NOT a guarantee of what the actual
 * launch will use. Pool creation re-runs the SAME helper (via
 * createPoolsAndPositions), getting a fresh probe at that moment. If
 * the price moves in the seconds between preflight and create-lp,
 * Milestone A's drift guard catches it on the second probe.
 *
 * Why the second probe still matters even after preflight: the modal
 * could sit open for tens of seconds while the user reads it. A thin
 * pool can move noticeably in that window. The drift guard on the
 * actual create-lp call uses the prices we returned here as the
 * override reference, so it measures movement during the confirmation
 * window. Tight window, tight tolerance — the 25% threshold catches
 * extreme moves but absorbs normal volatility.
 *
 * Inputs: same as createPoolsAndPositions (subset).
 *   - tokenMint, tokenTotalSupply, targetMarketCapUsd (for math context)
 *   - allocations (the user's pool config + any overrides)
 *
 * Returns:
 *   {
 *     resolvedPrices: [
 *       {
 *         allocationIndex, quoteMint, quoteSymbol,
 *         quoteUsd: string, source: string, driftPct: number | null,
 *         initialPrice: string,  // launched-token-USD / quoteUsd
 *       },
 *       ...
 *     ],
 *     solUsd: string,
 *   }
 *
 * Throws on any pre_flight failure with err.failedPhase='pre_flight'
 * and err.failedAllocationIndex set, same as createPoolsAndPositions.
 */
export async function preflightCreatePoolsAndPositions({
  tokenTotalSupply,
  targetMarketCapUsd,
  allocations,
}) {
  if (!Array.isArray(allocations) || allocations.length === 0) {
    const e = new Error('No allocations provided');
    e.failedPhase = 'pre_flight';
    throw e;
  }
  // Numeric inputs: must be positive finite numbers (or strings that
  // parse to positive finite numbers). Frontend gates this already in
  // updateContinueToFundingState, but defense in depth produces a
  // clear error here rather than letting Decimal math run with absurd
  // inputs and surfacing a confusing downstream failure.
  const supplyNum = Number(tokenTotalSupply);
  const mcapNum = Number(targetMarketCapUsd);
  if (!isFinite(supplyNum) || supplyNum <= 0) {
    const e = new Error(
      `tokenTotalSupply must be a positive number (got ${JSON.stringify(tokenTotalSupply)})`,
    );
    e.failedPhase = 'pre_flight';
    throw e;
  }
  if (!isFinite(mcapNum) || mcapNum <= 0) {
    const e = new Error(
      `targetMarketCapUsd must be a positive number (got ${JSON.stringify(targetMarketCapUsd)})`,
    );
    e.failedPhase = 'pre_flight';
    throw e;
  }

  // SOL/USD lookup — same hard-stop rule as createPoolsAndPositions.
  let solUsd = null;
  try {
    solUsd = await getUsdPrice(WSOL_MINT);
  } catch (e) {
    const err = new Error(
      `Couldn't resolve SOL/USD price (${e.message}). Check your network ` +
      `connection and try again. No SOL was spent.`,
    );
    err.failedPhase = 'pre_flight';
    err.cause = e;
    throw err;
  }
  if (!solUsd || !solUsd.gt(0)) {
    const err = new Error(
      `Couldn't resolve SOL/USD price. Check your network connection and ` +
      `try again. No SOL was spent.`,
    );
    err.failedPhase = 'pre_flight';
    throw err;
  }

  // Launched-token USD value at target market cap. Same formula the
  // actual launch uses to compute initialPrice.
  const launchedTokenUsd = new Decimal(targetMarketCapUsd).div(
    new Decimal(tokenTotalSupply),
  );

  // Open one RPC connection for any per-allocation quote-token lookups
  // resolveQuoteToken might need. Cheap — only used for fetching
  // decimals/symbol when the allocation didn't provide overrides.
  // Honors the test override so this preflight code path stays mockable
  // alongside initSdk.
  const { Connection } = await import('@solana/web3.js');
  const connection = __connectionFactoryOverride
    ? __connectionFactoryOverride()
    : new Connection(getRpcUrl(), 'confirmed');

  const resolvedPrices = [];
  for (let allocIdx = 0; allocIdx < allocations.length; allocIdx++) {
    const alloc = allocations[allocIdx];
    try {
      const quoteToken = await resolveQuoteToken(connection, alloc.quoteToken, {
        decimals: alloc.quoteDecimalsOverride,
        symbol: alloc.quoteSymbolOverride,
      });

      const { quoteUsd, source, driftPct } = await resolveQuoteUsdForCreate({
        quoteToken,
        alloc,
        solUsd,
      });

      // initialPrice = quote-per-launched = launchedTokenUsd / quoteUsd.
      // (Despite the look of the division: dividing the launched's USD
      // value by the quote's USD value yields how many WHOLE quote tokens
      // equal 1 launched. For a $0.001 launched paired with $200 SOL the
      // ratio is 5e-6, meaning 1 launched = 5e-6 SOL = $0.001 in SOL
      // terms.) Same formula createPoolsAndPositions uses; we precompute
      // it so the modal can show what the actual pool ratio will be.
      const initialPrice = launchedTokenUsd.div(quoteUsd);

      resolvedPrices.push({
        allocationIndex: allocIdx,
        quoteMint: quoteToken.address,
        quoteSymbol: quoteToken.symbol,
        quoteUsd: quoteUsd.toString(),
        source,
        driftPct,
        initialPrice: initialPrice.toString(),
      });
    } catch (err) {
      // Attach allocation context same way createPoolsAndPositions does.
      err.failedPhase = 'pre_flight';
      err.failedAllocationIndex = allocIdx;
      err.failedAllocation = alloc;
      throw err;
    }
  }

  return {
    resolvedPrices,
    solUsd: solUsd.toString(),
  };
}

/**
 * Top-level orchestrator. Creates one pool + all main positions (one per
 * distribution slice) + bootstrap, with locking, per allocation. Sequential
 * execution for clean failure recovery.
 *
 * @param {Object}   params
 * @param {number[]} params.tempWalletSecretKey  ephemeral wallet keypair (array form)
 * @param {string}   params.tokenMint            launched token mint address
 * @param {number}   params.tokenDecimals        launched token decimals (default 9)
 * @param {number}   params.tokenTotalSupply     total supply in WHOLE units
 * @param {number}   params.targetMarketCapUsd   USD market cap target at launch
 * @param {Array}    params.allocations          per-pool config (see below)
 * @param {boolean}  params.lockPositions        lock all positions? (default true)
 * @param {Function} [params.onProgress]         optional progress callback
 *
 * Each allocation: {
 *   quoteToken:    'SOL' | 'USDC' | 'USDT' | <mint address>,
 *   supplyPercent: number (0-100),
 *   ammConfigIndex?:        number (default DEFAULT_AMM_CONFIG_INDEX),
 *   quoteUsdOverride?:      number (drift-guard reference, NOT a bypass),
 *   quoteDecimalsOverride?: number (skip RPC mint lookup if set),
 *   quoteSymbolOverride?:   string (display only),
 *   distribution?: [
 *     { sharePercent: number, recipient?: string }, ...
 *   ]  // omitted = single 100% slice, NFT goes to dest wallet via sweep
 * }
 */
export async function createPoolsAndPositions({
  tempWalletSecretKey,
  tokenMint,
  tokenDecimals = 9,
  tokenTotalSupply,
  targetMarketCapUsd,
  allocations,
  lockPositions = true,
  onProgress,
  // When resuming a partially-completed launch, pass the partialResults
  // array from the failed attempt. The orchestrator will:
  //   - For each allocation whose index appears in priorResults with a
  //     poolId: skip createSinglePool, rebuild the bootstrap context from
  //     chain state, and use the existing result entry.
  //   - For other allocations: do the full create flow as if fresh.
  //   - In Phase 2: skip allocations whose bootstrap is already populated
  //     in priorResults.
  // This means a single failed launch can be retried any number of times,
  // each retry only attempting the work that didn't complete before.
  priorResults = [],
}) {
  console.log(`\n=== Creating pools and positions for ${tokenMint} ===`);
  console.log(`Total supply: ${tokenTotalSupply}, target MC: $${targetMarketCapUsd}`);
  console.log(`Allocations: ${allocations.length}, lock: ${lockPositions}`);
  if (priorResults.length > 0) {
    console.log(`Resume mode: ${priorResults.length} allocation(s) carried over from prior attempt`);
  }

  // -----------------------------------------------------------------------
  // 1. Initialize SDK with the ephemeral wallet
  // -----------------------------------------------------------------------
  const ownerKeypair = Keypair.fromSecretKey(Uint8Array.from(tempWalletSecretKey));
  const raydium = await initSdk(ownerKeypair);
  const connection = raydium.connection;

  // -----------------------------------------------------------------------
  // 2. Compute launch USD price for the token: target_mc / supply
  // -----------------------------------------------------------------------
  const launchedTokenUsd = new Decimal(targetMarketCapUsd).div(tokenTotalSupply);
  console.log(`Launched-token USD price target: $${launchedTokenUsd.toString()}`);

  // -----------------------------------------------------------------------
  // 3. Validate allocations as a whole
  // -----------------------------------------------------------------------
  const totalPct = allocations.reduce((s, a) => s + Number(a.supplyPercent), 0);
  if (totalPct > 100) {
    // Tagging as pre_flight so the orchestrator's caller (server) and the
    // frontend treat this the same way as the Token-2022 compat check —
    // nothing on-chain has happened yet, so the user can fix the config
    // and retry without sweeping. Without this tag the frontend's
    // failedPhase fallback defaults to 'main_positions' and incorrectly
    // tells the user that pools may have been created.
    const err = new Error(`Allocations sum to ${totalPct}% - must be <= 100%`);
    err.failedPhase = 'pre_flight';
    err.partialResults = priorResults;
    throw err;
  }

  const solPct = allocations
    .filter((a) => (a.quoteToken || '').toUpperCase() === 'SOL')
    .reduce((s, a) => s + Number(a.supplyPercent), 0);

  if (solPct > 0 && solPct < MIN_SOL_ALLOCATION_PCT) {
    const err = new Error(
      `SOL allocation is ${solPct}%, must be >= ${MIN_SOL_ALLOCATION_PCT}% ` +
        `(aggregator/scanner integration depends on a non-trivial SOL pool).`,
    );
    err.failedPhase = 'pre_flight';
    err.partialResults = priorResults;
    throw err;
  }

  // -----------------------------------------------------------------------
  // 3.5. Validate per-allocation bootstrap configuration.
  //
  // Each allocation may carry an optional `bootstrap` block:
  //   bootstrap: { mode: 'minimal' | 'custom', supplyPercent?: number }
  //
  // When `bootstrap` is absent or `mode === 'minimal'`, the orchestrator
  // uses the historical defaults — a 1-whole-token reserve and the narrow
  // tickSpacing-based range around currentTick. When `mode === 'custom'`,
  // the user has opted into adding meaningful support liquidity: the
  // bootstrap launched-side carves out of the pool's main supplyPercent
  // (so the pool's total commitment doesn't grow), and the bootstrap range
  // becomes full-range so the support is visible across the entire price
  // curve.
  //
  // Constraint: 0 ≤ bootstrap.supplyPercent ≤ allocation.supplyPercent.
  // The lower bound rejects negative or zero custom-mode configs (zero is
  // indistinguishable from minimal — the caller should send mode='minimal'
  // explicitly rather than custom-with-zero). The upper bound prevents an
  // allocation from owing more supply to bootstrap than the pool actually
  // has; equality is allowed and produces a bootstrap-only pool with no
  // main positions (a constant-product-style starting liquidity profile).
  // -----------------------------------------------------------------------
  for (let i = 0; i < allocations.length; i++) {
    const a = allocations[i];
    const bs = a.bootstrap;
    if (!bs) continue; // absent → treated as minimal, no further checks
    if (bs.mode !== 'minimal' && bs.mode !== 'custom') {
      const err = new Error(
        `Allocation ${i + 1}: bootstrap.mode must be 'minimal' or 'custom' ` +
          `(got '${bs.mode}')`,
      );
      err.failedPhase = 'pre_flight';
      err.failedAllocationIndex = i;
      err.failedAllocation = a;
      err.partialResults = priorResults;
      throw err;
    }
    if (bs.mode !== 'custom') continue; // minimal — supplyPercent ignored
    const bsPct = Number(bs.supplyPercent);
    if (!Number.isFinite(bsPct) || bsPct <= 0) {
      const err = new Error(
        `Allocation ${i + 1}: custom-mode bootstrap requires a positive ` +
          `supplyPercent (got ${bs.supplyPercent})`,
      );
      err.failedPhase = 'pre_flight';
      err.failedAllocationIndex = i;
      err.failedAllocation = a;
      err.partialResults = priorResults;
      throw err;
    }
    if (bsPct > Number(a.supplyPercent)) {
      const err = new Error(
        `Allocation ${i + 1}: bootstrap supplyPercent (${bsPct}%) exceeds ` +
          `pool's main supplyPercent (${a.supplyPercent}%). The bootstrap ` +
          `carves out of the pool's allocation - either reduce the bootstrap ` +
          `support or increase this pool's allocation.`,
      );
      err.failedPhase = 'pre_flight';
      err.failedAllocationIndex = i;
      err.failedAllocation = a;
      err.partialResults = priorResults;
      throw err;
    }
  }

  // -----------------------------------------------------------------------
  // 3.6. Validate per-allocation ladder configuration.
  //
  // The ladder block carves the pool's main allocation (everything not
  // reserved by the bootstrap) into a stack of single-sided positions at
  // discrete, log-spaced price bands above launch price, with gaps in
  // between. Each band acts as both resistance going up (limit sells in
  // the launched token) and support coming back down (the band's quote
  // tokens accumulated during the upward move). The remainder of main
  // supply not consumed by the ladder stays in a single wide position
  // covering the full [P_launch, MAX_TICK] range — current behaviour
  // for the entire main allocation, just downsized.
  //
  // Shape:
  //   ladder: {
  //     mode: 'off' | 'simple',
  //     supplyPercent: 50,        // % of pool's MAIN supply that goes
  //                               // to the ladder (i.e., what's left
  //                               // after bootstrap carve-out)
  //     bandCount: 5,             // number of bands
  //     ceilingMultiplier: 1000,  // top of highest band, as multiple
  //                               // of launch price
  //   }
  //
  // When ladder is absent or mode === 'off', current behaviour: all of
  // main goes to the single wide position.
  // -----------------------------------------------------------------------
  for (let i = 0; i < allocations.length; i++) {
    const a = allocations[i];
    const ld = a.ladder;
    if (!ld) continue;
    if (ld.mode !== 'off' && ld.mode !== 'simple' && ld.mode !== 'manual') {
      const err = new Error(
        `Allocation ${i + 1}: ladder.mode must be 'off', 'simple', or 'manual' ` +
          `(got '${ld.mode}')`,
      );
      err.failedPhase = 'pre_flight';
      err.failedAllocationIndex = i;
      err.failedAllocation = a;
      err.partialResults = priorResults;
      throw err;
    }
    if (ld.mode === 'off') continue;

    if (ld.mode === 'simple') {
      const ldPct = Number(ld.supplyPercent);
      if (!Number.isFinite(ldPct) || ldPct <= 0 || ldPct > 100) {
        const err = new Error(
          `Allocation ${i + 1}: ladder.supplyPercent must be in (0, 100] ` +
            `(got ${ld.supplyPercent})`,
        );
        err.failedPhase = 'pre_flight';
        err.failedAllocationIndex = i;
        err.failedAllocation = a;
        err.partialResults = priorResults;
        throw err;
      }
      const bandCount = Number(ld.bandCount);
      if (!Number.isInteger(bandCount) || bandCount < 2 || bandCount > 20) {
        const err = new Error(
          `Allocation ${i + 1}: ladder.bandCount must be an integer in [2, 20] ` +
            `(got ${ld.bandCount})`,
        );
        err.failedPhase = 'pre_flight';
        err.failedAllocationIndex = i;
        err.failedAllocation = a;
        err.partialResults = priorResults;
        throw err;
      }
      const ceiling = Number(ld.ceilingMultiplier);
      if (!Number.isFinite(ceiling) || ceiling <= 1) {
        const err = new Error(
          `Allocation ${i + 1}: ladder.ceilingMultiplier must be > 1 ` +
            `(got ${ld.ceilingMultiplier})`,
        );
        err.failedPhase = 'pre_flight';
        err.failedAllocationIndex = i;
        err.failedAllocation = a;
        err.partialResults = priorResults;
        throw err;
      }
    } else if (ld.mode === 'manual') {
      // Manual mode: explicit list of bands, each with its own
      // supplyPercent and lower/upper multipliers relative to launch.
      // Bands can overlap or have gaps — that's intentional. The only
      // requirement is each band is internally valid and the total
      // supplyPercent across bands doesn't exceed 100%.
      if (!Array.isArray(ld.bands) || ld.bands.length === 0) {
        const err = new Error(
          `Allocation ${i + 1}: ladder.bands must be a non-empty array ` +
            `when ladder.mode is 'manual'`,
        );
        err.failedPhase = 'pre_flight';
        err.failedAllocationIndex = i;
        err.failedAllocation = a;
        err.partialResults = priorResults;
        throw err;
      }
      if (ld.bands.length > 20) {
        const err = new Error(
          `Allocation ${i + 1}: ladder.bands has ${ld.bands.length} entries; ` +
            `maximum is 20`,
        );
        err.failedPhase = 'pre_flight';
        err.failedAllocationIndex = i;
        err.failedAllocation = a;
        err.partialResults = priorResults;
        throw err;
      }
      let total = 0;
      for (let b = 0; b < ld.bands.length; b++) {
        const band = ld.bands[b];
        const sp = Number(band.supplyPercent);
        const lo = Number(band.lowerMultiplier);
        const hi = Number(band.upperMultiplier);
        if (!Number.isFinite(sp) || sp <= 0 || sp > 100) {
          const err = new Error(
            `Allocation ${i + 1}, band ${b + 1}: supplyPercent must be in ` +
              `(0, 100] (got ${band.supplyPercent})`,
          );
          err.failedPhase = 'pre_flight';
          err.failedAllocationIndex = i;
          err.failedAllocation = a;
          err.partialResults = priorResults;
          throw err;
        }
        if (!Number.isFinite(lo) || lo < 1) {
          const err = new Error(
            `Allocation ${i + 1}, band ${b + 1}: lowerMultiplier must be ` +
              `>= 1 (got ${band.lowerMultiplier})`,
          );
          err.failedPhase = 'pre_flight';
          err.failedAllocationIndex = i;
          err.failedAllocation = a;
          err.partialResults = priorResults;
          throw err;
        }
        if (!Number.isFinite(hi) || hi <= lo) {
          const err = new Error(
            `Allocation ${i + 1}, band ${b + 1}: upperMultiplier (${band.upperMultiplier}) ` +
              `must be greater than lowerMultiplier (${band.lowerMultiplier})`,
          );
          err.failedPhase = 'pre_flight';
          err.failedAllocationIndex = i;
          err.failedAllocation = a;
          err.partialResults = priorResults;
          throw err;
        }
        total += sp;
      }
      if (total > 100.001) {
        // tiny FP slack: 100% exactly is allowed; floating-point summing
        // of 5 × 20.0 entries can drift to 100.00000001 or similar.
        const err = new Error(
          `Allocation ${i + 1}: ladder bands sum to ${total.toFixed(2)}% - ` +
            `must be <= 100%`,
        );
        err.failedPhase = 'pre_flight';
        err.failedAllocationIndex = i;
        err.failedAllocation = a;
        err.partialResults = priorResults;
        throw err;
      }
    }
  }

  // -----------------------------------------------------------------------
  // 3.7. Validate per-allocation support configuration.
  //
  // The support block (optional) opens a single-sided QUOTE position
  // adjacent to launch price, providing buy-side liquidity that any
  // preallocated supply (held outside LP, e.g. team/VC/presale tokens)
  // can sell into without needing token-side liquidity to back it.
  //
  // Shape:
  //   support: { mode: 'off' }                          // default
  //   support: { mode: 'custom', solValue: number }     // user-funded
  //
  // The position covers [launch - 10%, launch - 1 tickSpacing] for
  // mintA-side launches, mirrored above currentTick for mintB. Single-
  // sided in the quote — no launched-token supply is required, so
  // support is orthogonal to the pool's supplyPercent budget.
  //
  // We only validate the shape here; the per-pool quote-side funding
  // requirement is sized by estimateRequiredFunding and rolled into the
  // same SOL bucket (SOL pools) or auto-swap target (non-SOL pools) as
  // the bootstrap's quote-side cost.
  // -----------------------------------------------------------------------
  for (let i = 0; i < allocations.length; i++) {
    const a = allocations[i];
    const sp = a.support;
    if (!sp) continue; // absent → treated as off, no further checks
    if (sp.mode !== 'off' && sp.mode !== 'custom') {
      const err = new Error(
        `Allocation ${i + 1}: support.mode must be 'off' or 'custom' ` +
          `(got '${sp.mode}')`,
      );
      err.failedPhase = 'pre_flight';
      err.failedAllocationIndex = i;
      err.failedAllocation = a;
      err.partialResults = priorResults;
      throw err;
    }
    if (sp.mode !== 'custom') continue;
    const sv = Number(sp.solValue);
    if (!Number.isFinite(sv) || sv <= 0) {
      const err = new Error(
        `Allocation ${i + 1}: custom-mode support requires a positive ` +
          `solValue (got ${sp.solValue})`,
      );
      err.failedPhase = 'pre_flight';
      err.failedAllocationIndex = i;
      err.failedAllocation = a;
      err.partialResults = priorResults;
      throw err;
    }
    // depthPct is optional. Falls back to SUPPORT_DEPTH_PCT_DEFAULT
    // when absent — that's the historical hardcoded value. Bounds chosen
    // to keep the position useful: too small (below 1%) collapses on
    // high-tickSpacing fee tiers (computeSupportTicks has a guard, but
    // a position spanning just one tickSpacing is so thin it's almost
    // pointless). Too large (above 50%) covers so much price territory
    // that the per-tick liquidity density gets diluted to nothing.
    if (sp.depthPct !== undefined && sp.depthPct !== null) {
      const dp = Number(sp.depthPct);
      if (!Number.isFinite(dp) || dp < 1 || dp > 50) {
        const err = new Error(
          `Allocation ${i + 1}: support.depthPct must be in [1, 50] ` +
            `(got ${sp.depthPct})`,
        );
        err.failedPhase = 'pre_flight';
        err.failedAllocationIndex = i;
        err.failedAllocation = a;
        err.partialResults = priorResults;
        throw err;
      }
    }
  }

  // -----------------------------------------------------------------------
  // 4. Fetch CLMM AmmConfigs once (used per-pool)
  // -----------------------------------------------------------------------
  const allConfigs = await raydium.api.getClmmConfigs();
  console.log(`Loaded ${allConfigs.length} AmmConfigs from Raydium API`);

  // -----------------------------------------------------------------------
  // 5. Build the launched-token info object the SDK expects
  // -----------------------------------------------------------------------
  const launchedToken = {
    address: tokenMint,
    programId: TOKEN_PROGRAM_ID.toBase58(),
    decimals: tokenDecimals,
  };

  // -----------------------------------------------------------------------
  // 5.5. PRE-FLIGHT: resolve and validate every quote token BEFORE we
  //      touch the chain for pool creation. This catches:
  //        - typos / non-mint addresses
  //        - Token-2022 mints with Raydium-incompatible extensions
  //          (e.g. PermanentDelegate, NonTransferable, TransferHook,
  //          DefaultAccountState — any of these cause pool creation to
  //          revert with NotSupportMint or an Anchor constraint error
  //          AFTER we've already spent SOL on rent for the pool state)
  //
  //      Doing this upfront means we either commit to the full launch or
  //      reject the whole thing — never the half-broken middle state the
  //      previous Cm6f...pump failure left us in.
  //
  //      We hold onto the resolved tokens so the per-allocation loop
  //      below can use them directly without re-resolving.
  // -----------------------------------------------------------------------
  console.log('Pre-flight: validating quote-token compatibility...');
  const resolvedAllocs = [];
  for (let i = 0; i < allocations.length; i++) {
    const alloc = allocations[i];
    try {
      const quoteToken = await resolveQuoteToken(connection, alloc.quoteToken, {
        decimals: alloc.quoteDecimalsOverride,
        symbol: alloc.quoteSymbolOverride,
      });
      const programLabel = quoteToken.isToken2022 ? 'Token-2022' : 'SPL Token';
      const extLabel = quoteToken.isToken2022
        ? ` (extensions: ${quoteToken.extensions.length === 0 ? 'none' : quoteToken.extensions.join(',')})`
        : '';
      console.log(
        `  [${i}] ${quoteToken.symbol} -> ${programLabel}${extLabel} [ok]`,
      );
      resolvedAllocs.push({ alloc, quoteToken });
    } catch (err) {
      // Annotate with which allocation failed so the caller can highlight
      // the right row in the UI. partialResults preserves any priorResults
      // we were given (resume case) so the user doesn't lose the
      // already-completed pools' state in their lpResult.
      err.failedAllocationIndex = i;
      err.failedAllocation = alloc;
      err.failedPhase = 'pre_flight';
      err.partialResults = priorResults;
      throw err;
    }
  }
  console.log(`Pre-flight passed for all ${allocations.length} allocation(s).`);

  // -----------------------------------------------------------------------
  // 6. Phase 1: iterate allocations sequentially, creating each pool and its
  //    main positions. Bootstrap is skipped here (queued for phase 2 below)
  //    so no pool becomes tradable until every pool's main positions are in
  //    place. Otherwise a swap on an early-completed pool could move its
  //    price relative to later pools that were configured to launch at the
  //    same USD-equivalent price.
  // -----------------------------------------------------------------------
  const results = [];
  const bootstrapQueue = [];

  // SOL USD price — looked up once for the whole launch and used to:
  //   (1) Convert per-allocation support.solValue (denominated in SOL)
  //       into the equivalent USD value, which then gets converted to
  //       raw quote units inside each per-allocation loop iteration.
  //   (2) Provide the `solUsd` term for the just-in-time Raydium swap
  //       probe — the probe computes `effectiveQuoteUsd = (SOL spent
  //       in USD) / (tokens received)`, so a wrong SOL/USD propagates
  //       to every quote-token price we derive.
  //   (3) Compute initialPrice for any SOL-quote pool, since SOL itself
  //       can't be probed against itself.
  //
  // Failure here is a hard pre_flight abort, NOT a fallback-to-constant
  // (as it was previously). A launch that proceeds with a stale or
  // approximate SOL/USD will silently miss-size every downstream
  // calculation, and the user has no way to know they got a bad number.
  // SOL/USD is the easiest price to get — every aggregator covers it
  // and they all agree to within a fraction of a percent. If we can't
  // get it at all, something is fundamentally broken (network, all
  // aggregators down) and a launch shouldn't proceed.
  let solUsdForSupport = null;
  try {
    solUsdForSupport = await getUsdPrice(WSOL_MINT);
  } catch (e) {
    const err = new Error(
      `Couldn't resolve SOL/USD price (${e.message}). This is unusual - ` +
      `every price source we consult covers SOL. Check your network ` +
      `connection and try again. No SOL was spent.`,
    );
    err.failedPhase = 'pre_flight';
    err.partialResults = priorResults;
    err.cause = e;
    throw err;
  }
  if (!solUsdForSupport || !solUsdForSupport.gt(0)) {
    const err = new Error(
      `Couldn't resolve SOL/USD price (no price source returned a valid value). ` +
      `Check your network connection and try again. No SOL was spent.`,
    );
    err.failedPhase = 'pre_flight';
    err.partialResults = priorResults;
    throw err;
  }
  console.log(`SOL/USD used for support sizing: $${solUsdForSupport.toString()}`);

  for (let allocIdx = 0; allocIdx < allocations.length; allocIdx++) {
    const alloc = allocations[allocIdx];

    // RESUME CHECK: if this allocation completed Phase 1 in a prior attempt,
    // skip the create flow and just rebuild the bootstrap context from
    // on-chain state. The result entry from the prior attempt is reused
    // verbatim (poolId, mainPositions, txIds are all immutable once they
    // hit chain). Bootstrap context fields — poolInfo, poolKeys, current
    // tick, etc. — get re-fetched fresh because they may have drifted
    // between the prior attempt and this resume.
    const prior = priorResults.find(
      (p) => p.allocationIndex === allocIdx && p.poolId,
    );
    const phase1Recovery = prior && prior.phase1Incomplete ? prior : null;
    if (prior && !phase1Recovery) {
      const quoteToken = resolvedAllocs[allocIdx].quoteToken;
      console.log(`\n[${quoteToken.symbol}] resume: pool ${prior.poolId} already created, rebuilding bootstrap context`);
      try {
        const { poolInfo, poolKeys } = await raydium.clmm.getPoolInfoFromRpc(prior.poolId);
        const rpcData = await raydium.clmm.getRpcClmmPoolInfo({ poolId: prior.poolId });
        const tickSpacing = poolInfo.config.tickSpacing;
        const currentTick = rpcData.tickCurrent;
        const launchedIsMintA = poolInfo.mintA.address === launchedToken.address;
        // initialPrice for the bootstrap math = quote per launched.
        // Recompute from the live on-chain price rather than reusing the
        // value from the prior attempt — pool prices drift, especially
        // SOL/USD-pegged pools.
        const initialPrice = launchedIsMintA
          ? new Decimal(poolInfo.price)
          : new Decimal(1).div(poolInfo.price);

        // Mirror the bootstrap mode + size from the allocation we're resuming
        // against, not from the prior result. The allocation is what the user
        // is launching with right now; the prior result only carries main-
        // position info, not bootstrap config. If the user changed bootstrap
        // mode between attempts, the active resume uses the new mode.
        const bootstrapCfg = alloc.bootstrap || { mode: 'minimal' };
        const bootstrapMode = bootstrapCfg.mode === 'custom' ? 'custom' : 'minimal';
        const resumeBootstrapBaseRaw = bootstrapMode === 'custom'
          ? new BN(
              new Decimal(tokenTotalSupply)
                .mul(bootstrapCfg.supplyPercent)
                .div(100)
                .mul(new Decimal(10).pow(tokenDecimals))
                .toFixed(0),
            )
          : new BN(BOOTSTRAP_BASE_TOKENS_WHOLE).mul(
              new BN(10).pow(new BN(launchedToken.decimals)),
            );

        bootstrapQueue.push({
          allocationIndex: allocIdx,
          quoteSymbol: quoteToken.symbol,
          ctx: {
            poolId: prior.poolId,
            poolInfo,
            poolKeys,
            currentTickAtCreation: currentTick,
            tickSpacing,
            launchedIsMintA,
            bootstrapBaseRaw: resumeBootstrapBaseRaw,
            bootstrapMode,
            initialPrice,
            quoteToken,
          },
          // Stash any prior bootstrap result so Phase 2 can skip if done.
          // (Bootstrap-only retries reach here with prior.bootstrap === null;
          // main-positions-only retries that succeeded fully reach here
          // with bootstrap populated.)
          existingBootstrap: prior.bootstrap || null,
        });
        // Pushing the prior result verbatim carries per-position state
        // (locked, transferredTo, txIds) into the current results array.
        // Phase 3 (locks) and Phase 4 (transfers) inspect each position's
        // state and skip those already done — so a resume that picked up
        // after a partial Phase 3 only attempts the still-unlocked
        // positions, and similarly Phase 4 only attempts the un-transferred
        // recipients. No special resume code needed for those phases.
        results.push(prior);
        continue;
      } catch (err) {
        // Couldn't rebuild context — surface clearly so the user knows
        // which prior pool is the blocker. Most likely cause: RPC
        // unreachable when we tried to read the pool state.
        const e = new Error(
          `Resume failed: couldn't read prior pool ${prior.poolId} from RPC ` +
            `(${err.message}). Retry once RPC connectivity recovers, or ` +
            `sweep the wallet to start over.`,
        );
        e.partialResults = results;
        e.failedAllocationIndex = allocIdx;
        e.failedPhase = 'main_positions';
        throw e;
      }
    }

    try {
      // 6a. Use the quote token we already resolved + validated in the
      //     pre-flight pass above. (Pre-flight has already verified the
      //     mint exists, lives in a recognized token program, and has
      //     only Raydium-supported Token-2022 extensions if any.)
      const quoteToken = resolvedAllocs[allocIdx].quoteToken;

      // 6b. Determine USD price for the quote token via the shared
      // resolveQuoteUsdForCreate helper. The helper enforces the
      // Milestone A safety rules: probe is hard-required for non-SOL
      // quotes (no aggregator fallback), drift guard against override
      // at the configured threshold, sanity floor at the end.
      //
      // We wrap the call in a try/catch so we can attach the
      // failedPhase='pre_flight' tag. This is critical: at this point
      // NO on-chain action has been taken yet, so any failure should
      // route the frontend to the "fix config and retry" path rather
      // than the sweep path. The outer per-allocation try/catch
      // (around the rest of the pool-creation sequence below) would
      // otherwise tag the error as 'main_positions', which would be
      // wrong.
      let quoteUsd;
      let quoteUsdSource = null;
      try {
        const resolved = await resolveQuoteUsdForCreate({
          quoteToken,
          alloc,
          solUsd: solUsdForSupport,
        });
        quoteUsd = resolved.quoteUsd;
        quoteUsdSource = resolved.source;
      } catch (priceErr) {
        if (!priceErr.failedPhase) {
          priceErr.failedPhase = 'pre_flight';
          priceErr.failedAllocationIndex = allocIdx;
          priceErr.failedAllocation = alloc;
          priceErr.partialResults =
            priorResults && priorResults.length > 0 ? priorResults : results;
        }
        throw priceErr;
      }

      console.log(
        `pool-create: ${quoteToken.symbol} quote USD = $${quoteUsd.toString()} ` +
        `(source: ${quoteUsdSource})`,
      );

      // 6c. Validate distribution (defaults to single 100% slice)
      const distribution = normalizeDistribution(alloc.distribution);

      // 6c.5. Resolve bootstrap config. Defaults to minimal when the field
      //       is absent or explicitly set to mode='minimal'. The pre-flight
      //       check above has already validated supplyPercent bounds for
      //       custom-mode entries.
      const bootstrapCfg = alloc.bootstrap || { mode: 'minimal' };
      const bootstrapMode = bootstrapCfg.mode === 'custom' ? 'custom' : 'minimal';

      console.log(
        `\n[${quoteToken.symbol}] quote USD = $${quoteUsd.toString()}, ` +
          `allocation = ${alloc.supplyPercent}%, slices = ${distribution.length}, ` +
          `bootstrap = ${bootstrapMode}` +
          (bootstrapMode === 'custom'
            ? ` (${bootstrapCfg.supplyPercent}% of supply, full-range)`
            : ' (1 token, narrow range)'),
      );

      // 6d. Compute initial pool price = launched-in-terms-of-quote
      const initialPrice = launchedTokenUsd.div(quoteUsd);
      console.log(
        `  initialPrice (${quoteToken.symbol} per launched) = ${initialPrice.toString()}`,
      );

      // 6e. Compute the launched-token raw amounts: one for main positions,
      //     one reserved for the bootstrap. Both come out of the pool's
      //     allocation.supplyPercent (Option B "carve out" semantics):
      //
      //     - minimal mode: bootstrap = 1 whole token (current default);
      //       main gets the rest of the pool's allocation
      //     - custom mode:  bootstrap = bootstrap.supplyPercent of total supply;
      //       main gets (alloc.supplyPercent − bootstrap.supplyPercent)
      //
      //     For minimal mode, the 1-whole-token reserve carves out of the
      //     pool's allocation, same as the current behavior (the slicing
      //     loop in createSinglePool used to do this internally; we just
      //     hoisted it up). For custom mode, the bootstrap can be any
      //     fraction of the pool up to and including the entire pool —
      //     pre-flight already validated bootstrap.supplyPercent ≤
      //     alloc.supplyPercent.
      const oneTokenRaw = new BN(10).pow(new BN(tokenDecimals));
      const allocatedSupplyRaw = new BN(
        new Decimal(tokenTotalSupply)
          .mul(alloc.supplyPercent)
          .div(100)
          .mul(new Decimal(10).pow(tokenDecimals))
          .toFixed(0),
      );

      let bootstrapBaseRaw;
      let mainBaseRaw;
      if (bootstrapMode === 'custom') {
        bootstrapBaseRaw = new BN(
          new Decimal(tokenTotalSupply)
            .mul(bootstrapCfg.supplyPercent)
            .div(100)
            .mul(new Decimal(10).pow(tokenDecimals))
            .toFixed(0),
        );
        mainBaseRaw = allocatedSupplyRaw.sub(bootstrapBaseRaw);
      } else {
        // Minimal mode — match the historical 1-whole-token reserve.
        bootstrapBaseRaw = new BN(BOOTSTRAP_BASE_TOKENS_WHOLE).mul(oneTokenRaw);
        mainBaseRaw = allocatedSupplyRaw.sub(bootstrapBaseRaw);
      }

      // Split main supply between wide (covers full [launch, MAX_TICK])
      // and ladder bands (discrete bands within that range with gaps).
      // The wide always exists with the leftover supply; the ladder
      // exists only when ladder.mode is 'simple' or 'manual'.
      //
      // For 'simple' mode: ladder.supplyPercent is the total ladder share
      // of THIS pool's main allocation; equally split across bandCount
      // bands. Backwards-compatible with the original simple-mode wire
      // shape that ships from older clients.
      //
      // For 'manual' mode: each band carries its own supplyPercent and
      // its own price-multiplier range. This is what the customize-mode
      // UI produces, and is the canonical wire format from the trebuchet
      // frontend now.
      //
      // For 'off' (or no ladder field): wide gets the full mainBaseRaw,
      // no ladder positions opened — current behaviour for launches with
      // ladder disabled.
      const ladderCfg = alloc.ladder || { mode: 'off' };
      const ladderMode = ladderCfg.mode === 'simple' || ladderCfg.mode === 'manual'
        ? ladderCfg.mode
        : 'off';
      let ladderTotalBaseRaw = new BN(0);
      let wideBaseRaw = mainBaseRaw;
      // ladderBands is the per-band data the orchestrator passes to
      // createSinglePool. Each entry has the raw token amount for that
      // band, plus the tick range. For simple mode we compute uniform
      // bands here; for manual mode we use the band config directly
      // and compute per-band raw amounts from per-band supplyPercent.
      // createSinglePool consumes this uniformly regardless of how the
      // band list was constructed.
      let ladderBands = []; // [{ baseRaw, tickLower, tickUpper }] computed in createSinglePool

      if (ladderMode === 'simple') {
        const bandCount = Number(ladderCfg.bandCount);
        // ladderTotalBaseRaw = mainBaseRaw × ladder.supplyPercent / 100
        // Computed with BN arithmetic to avoid Number-precision loss
        // on large supplies.
        ladderTotalBaseRaw = mainBaseRaw
          .mul(new BN(Math.round(Number(ladderCfg.supplyPercent) * 100)))
          .div(new BN(10000));
        // Each band gets an equal slice. Any rounding remainder stays
        // in the wide position — a few tokens out of millions, dust.
        const perBandRaw = ladderTotalBaseRaw.div(new BN(bandCount));
        // Wide gets whatever's left after the ladder takes its share.
        // Using mul/div above rather than just multiplying by perBand
        // means rounding error accumulates in wide (not in any band),
        // keeping the bands exactly equal.
        wideBaseRaw = mainBaseRaw.sub(perBandRaw.mul(new BN(bandCount)));
        ladderBands = [];
        for (let bi = 0; bi < bandCount; bi++) {
          ladderBands.push({ baseRaw: perBandRaw });
        }
      } else if (ladderMode === 'manual') {
        // Each band's raw share = mainBaseRaw × band.supplyPercent / 100.
        // Same BN-arithmetic pattern as simple mode. We accumulate the
        // total separately so we can compute wide as the remainder.
        ladderBands = [];
        let totalLadderRaw = new BN(0);
        for (const b of ladderCfg.bands) {
          const bandRaw = mainBaseRaw
            .mul(new BN(Math.round(Number(b.supplyPercent) * 100)))
            .div(new BN(10000));
          ladderBands.push({
            baseRaw: bandRaw,
            // Pass multipliers through so createSinglePool can compute
            // ticks from them via computeLadderTicksManual.
            lowerMultiplier: Number(b.lowerMultiplier),
            upperMultiplier: Number(b.upperMultiplier),
          });
          totalLadderRaw = totalLadderRaw.add(bandRaw);
        }
        ladderTotalBaseRaw = totalLadderRaw;
        wideBaseRaw = mainBaseRaw.sub(totalLadderRaw);
      }

      console.log(
        `  raw split: total=${allocatedSupplyRaw.toString()}, ` +
          `wide=${wideBaseRaw.toString()}, ` +
          `bootstrap=${bootstrapBaseRaw.toString()}` +
          (ladderMode !== 'off'
            ? `, ladder=${ladderTotalBaseRaw.toString()} (${ladderBands.length} bands, ${ladderMode})`
            : ''),
      );

      // 6e.5. Resolve support config and compute the raw quote amount.
      //
      // Support is single-sided in quote, so it doesn't consume any
      // launched-token supply — the math here is purely quote-side. The
      // user enters a SOL value (canonical UI input), and we convert
      // through USD into raw units of THIS pool's quote token:
      //
      //   supportUsd     = solValue × solUsd
      //   supportWhole   = supportUsd / quoteUsd   (whole quote tokens)
      //   supportQuoteRaw = floor(supportWhole × 10^quoteDecimals)
      //
      // For SOL pools, quoteUsd === solUsd, so the formula collapses
      // cleanly to (solValue × LAMPORTS_PER_SOL). For non-SOL pools, the
      // user's intent ("X SOL of starting support") translates to the
      // equivalent USD value at current prices, then to that many quote
      // tokens — same conversion the funding estimator does to size the
      // auto-swap target.
      //
      // When support is off (or absent), we pass false/zero through to
      // createSinglePool which short-circuits the open call.
      const supportCfg = alloc.support || { mode: 'off' };
      const supportEnabled = supportCfg.mode === 'custom'
        && Number(supportCfg.solValue) > 0;
      let supportQuoteRaw = new BN(0);
      if (supportEnabled) {
        const solValueDec = new Decimal(Number(supportCfg.solValue));
        const supportUsdDec = solValueDec.mul(solUsdForSupport);
        const supportWholeDec = supportUsdDec.div(quoteUsd);
        // Floor to raw units — over-depositing isn't a concern, the
        // single-sided position math caps at the user's intended amount.
        const supportQuoteRawStr = supportWholeDec
          .mul(new Decimal(10).pow(quoteToken.decimals))
          .toFixed(0, Decimal.ROUND_FLOOR);
        supportQuoteRaw = new BN(supportQuoteRawStr);
        console.log(
          `  support: solValue=${solValueDec.toString()} SOL ` +
            `-> ~$${supportUsdDec.toFixed(2)} ` +
            `-> ${supportWholeDec.toFixed(6)} ${quoteToken.symbol} ` +
            `(${supportQuoteRaw.toString()} raw)`,
        );
      }

      // 6f. Pick the AmmConfig
      const cfgIdx = alloc.ammConfigIndex ?? DEFAULT_AMM_CONFIG_INDEX;
      const baseCfg = allConfigs.find((c) => c.index === cfgIdx);
      if (!baseCfg) {
        throw new Error(`AmmConfig index ${cfgIdx} not found in Raydium configs`);
      }
      const ammConfig = {
        ...baseCfg,
        id: new PublicKey(baseCfg.id),
        fundOwner: '',
        description: '',
      };

      // 6g. Phase 1: create the pool, open the wide main position(s)
      //     according to distribution, and open the ladder bands if
      //     any. Bootstrap is deliberately skipped here — see the
      //     long comment in createSinglePool for why. We gather the
      //     per-pool context in `bootstrapQueue` so phase 2 can open
      //     all bootstraps at the end.
      const poolResult = await createSinglePool({
        raydium,
        ownerKeypair,
        ammConfig,
        launchedToken,
        quoteToken,
        initialPrice,
        // wideBaseRaw is what the existing distribution-sliced main
        // positions get. It's the original mainBaseRaw minus whatever
        // the ladder took.
        wideBaseRaw,
        bootstrapBaseRaw,
        bootstrapMode,
        distribution,
        // Ladder config:
        //   ladderMode: 'off' | 'simple' | 'manual'
        //   ladderBands: per-band [{baseRaw, lowerMultiplier?, upperMultiplier?}]
        //                — empty when off; simple-mode entries have only
        //                baseRaw, manual-mode entries also carry the
        //                multipliers. createSinglePool decides which
        //                tick-math function to call based on what's present.
        //   ladderCeiling: ceiling multiplier for simple mode (unused
        //                  for manual). Passed for backward-compat.
        ladderMode,
        ladderBands,
        ladderCeiling: ladderMode === 'simple' ? Number(ladderCfg.ceilingMultiplier) : 0,
        supportEnabled,
        supportQuoteRaw,
        // Per-allocation depth, with a defensive fallback to the module
        // default. The pre-flight check above has already bounds-validated
        // any user-supplied value, so anything still on the supportCfg
        // here is safe to pass through.
        supportDepthPct: supportEnabled && Number.isFinite(Number(supportCfg.depthPct))
          ? Number(supportCfg.depthPct)
          : SUPPORT_DEPTH_PCT_DEFAULT,
        existingPool: phase1Recovery,
        onProgress: (event) =>
          onProgress && onProgress({ allocationIndex: allocIdx, ...event }),
      });

      // Strip the internal context out before exposing the result, but stash
      // it for phase 2 along with metadata we need for accurate progress events.
      const { _bootstrapContext: bsCtx, ...publicPoolResult } = poolResult;
      bootstrapQueue.push({
        allocationIndex: allocIdx,
        quoteSymbol: quoteToken.symbol,
        ctx: bsCtx,
      });

      const resultEntry = {
        allocationIndex: allocIdx,
        quoteSymbol: quoteToken.symbol,
        quoteAddress: quoteToken.address,
        supplyPercent: alloc.supplyPercent,
        ...publicPoolResult,
        // Bootstrap fields populated in phase 2. Predeclared as null so the
        // result shape is consistent if a bootstrap fails partway through.
        bootstrap: null,
      };
      results.push(resultEntry);
      onProgress && onProgress({
        allocationIndex: allocIdx,
        stage: 'phase1_pool_done',
        result: resultEntry,
      });
    } catch (err) {
      // Attach partial results to the error so the caller knows what
      // got created before the failure.
      //
      // Respect any pre-set failedPhase: an inner try/catch (e.g. the
      // price-resolution block above) may have already tagged the
      // error correctly as 'pre_flight' because the failure happened
      // before any on-chain action was taken. Overwriting it to
      // 'main_positions' here would route the user to the sweep
      // recovery path when they actually need the fix-and-retry path.
      if (!err.failedPhase) {
        err.failedPhase = 'main_positions';
      }
      if (err.phase1PartialResult?.poolId) {
        const partialEntry = {
          allocationIndex: allocIdx,
          quoteSymbol: resolvedAllocs[allocIdx]?.quoteToken?.symbol || alloc.quoteSymbolOverride || alloc.quoteToken,
          quoteAddress: resolvedAllocs[allocIdx]?.quoteToken?.address || alloc.quoteToken,
          supplyPercent: alloc.supplyPercent,
          ...err.phase1PartialResult,
          bootstrap: null,
        };
        const existingIdx = results.findIndex((r) => r.allocationIndex === allocIdx);
        if (existingIdx >= 0) {
          results[existingIdx] = partialEntry;
        } else {
          results.push(partialEntry);
          results.sort((a, b) => (a.allocationIndex ?? 0) - (b.allocationIndex ?? 0));
        }
      }
      if (err.partialResults === undefined) {
        err.partialResults = results;
      }
      if (err.failedAllocationIndex === undefined) {
        err.failedAllocationIndex = allocIdx;
      }
      if (err.failedAllocation === undefined) {
        err.failedAllocation = alloc;
      }
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // 7. Phase 2: bootstrap every pool, in order.
  //
  // At this point every pool's main positions are in place and locked, but
  // none of the pools is tradable yet (no in-range liquidity). Now we open
  // a bootstrap position in each pool. Once a bootstrap lands, that pool
  // becomes tradable — but every other pool's main positions are already
  // in their final ranges, so any subsequent swaps can't disturb them.
  //
  // Ordering within the queue: SOL-paired pools go LAST. Bots,
  // aggregators, and trade routers index SOL pairs more aggressively
  // than flywheel/exotic quotes, so flipping the SOL pool to tradable
  // before the flywheels are also tradable would let the first wave of
  // SOL-paired trades miss the cascading buy-pressure mechanism the
  // launch was designed for. Stable sort preserves user-config order
  // within each group; SOL items keep their relative order among
  // themselves, non-SOL items keep theirs.
  // -------------------------------------------------------------------------
  bootstrapQueue.sort((a, b) => {
    const aIsSol = a.ctx?.quoteToken?.address === WSOL_MINT;
    const bIsSol = b.ctx?.quoteToken?.address === WSOL_MINT;
    return Number(aIsSol) - Number(bIsSol);
  });

  console.log(`\n=== Phase 2: opening bootstrap positions for ${bootstrapQueue.length} pool(s) ===`);

  // Phase 1 ran many transactions that changed the wallet's token balances
  // and ATA inventory significantly. Refresh the SDK's cached token-account
  // info once before phase 2 so its assumptions match on-chain reality when
  // building the bootstrap-open instructions.
  try {
    await raydium.account.fetchWalletTokenAccounts({ forceUpdate: true });
    console.log('  refreshed SDK token account cache before phase 2');
  } catch (e) {
    console.warn('  cache refresh failed (non-fatal):', e.message);
  }
  // Brief settle so the last open tx from Phase 1 is fully visible to
  // the RPC before Phase 2 starts querying pool state for bootstrap
  // building. (Phase 1 no longer locks anything — locking is deferred
  // to Phase 3.)
  await new Promise((r) => setTimeout(r, 1500));

  // Phase 2 runs every bootstrap independently — a single failure does
  // not abort the remaining attempts. The premise is that an OPEN main
  // position whose pool just couldn't get a bootstrap is still better
  // off than a main position whose pool was never even attempted because
  // an earlier pool's bootstrap had a transient RPC error. (Mains are
  // still unlocked at this point — locking is Phase 3 — so a recovery
  // could even close-and-redo failed pools without burning anything.)
  // The caller reports per-pool success/failure to the user so they can
  // retry the failed ones (or manually open a Raydium position to make
  // them tradable) without losing the successful pools.
  const bootstrapFailures = [];

  for (const item of bootstrapQueue) {
    const { allocationIndex: allocIdx, quoteSymbol, ctx } = item;

    // RESUME CHECK: if this allocation already has a bootstrap from a
    // prior successful attempt (carried in via priorResults), don't redo
    // it — the on-chain bootstrap position is locked and immutable.
    // The result entry already has the bootstrap field populated; the
    // resume-path took care of that when populating `results`.
    if (item.existingBootstrap) {
      console.log(`\n[${quoteSymbol}] resume: bootstrap already done, skipping`);
      continue;
    }

    console.log(`\n[${quoteSymbol}] bootstrap`);
    try {
      // Gather the position NFTs already recorded for this pool so the
      // bootstrap reconciliation can exclude them when matching its range
      // (defensive; the straddling bootstrap range cannot collide with the
      // one-sided main/ladder/support ranges).
      const priorEntry = results.find((r) => r.allocationIndex === allocIdx);
      const priorNftMints = priorEntry
        ? [
            ...(priorEntry.mainPositions || []),
            ...(priorEntry.ladderPositions || []),
            ...(priorEntry.supportPositions || []),
          ]
            .map((p) => p && p.nftMint)
            .filter(Boolean)
        : [];
      const bootstrap = await openBootstrapPosition({
        raydium,
        ctx,
        priorNftMints,
        onProgress: (event) =>
          onProgress && onProgress({ allocationIndex: allocIdx, ...event }),
      });
      // Find the corresponding result entry and attach the bootstrap info.
      // (results was built in the same order as bootstrapQueue, so allocIdx
      // matches the entry's allocationIndex field.)
      const resultEntry = results.find((r) => r.allocationIndex === allocIdx);
      if (resultEntry) resultEntry.bootstrap = bootstrap;
    } catch (err) {
      // Record the failure, surface it via the progress callback, but keep
      // going — the next pool's bootstrap is independent.
      //
      // Be defensive about message extraction: the Raydium SDK sometimes
      // throws objects without a useful `.message` (e.g. simulation
      // failures where the error is the parsed sim-logs object, not a
      // standard Error). Fall back to String(err) so we don't end up
      // logging "(undefined)" and leaving the user with no information.
      // Also stringify the full error to the server console so we have
      // it for debugging even when the wire form is trimmed.
      const msg = (err && err.message)
        || (typeof err === 'string' ? err : null)
        || (err && err.toString && err.toString() !== '[object Object]' ? err.toString() : null)
        || 'unknown error (see server logs)';
      console.error(`  bootstrap FAILED for ${quoteSymbol}:`, msg);
      console.error(`  full error object:`, err);
      // If the error carries simulation logs (Raydium SDK convention),
      // dump them too — these are the only useful diagnostic when a tx
      // reverts inside the program.
      if (err && Array.isArray(err.logs)) {
        console.error(`  simulation logs:`, err.logs.join('\n'));
      }
      bootstrapFailures.push({
        allocationIndex: allocIdx,
        quoteSymbol,
        error: msg,
      });
      onProgress && onProgress({
        allocationIndex: allocIdx,
        stage: 'bootstrap_failed',
        error: msg,
      });
    }
  }

  if (bootstrapFailures.length > 0) {
    // Some bootstraps failed; throw a structured error so the caller can
    // present a partial-success result instead of an all-or-nothing.
    // Main positions are intact for every pool; only the bootstrap leg
    // is missing for the listed allocations.
    //
    // We deliberately do NOT proceed to Phase 3 (locks) when bootstrap
    // failures are present. The user needs to resolve the bootstrap
    // failures first (retry or manually open), and only then should we
    // lock everything. Locking the partial state now would leave the
    // user with locked main positions in pools that aren't tradable.
    const summary = bootstrapFailures
      .map((f) => `${f.quoteSymbol} (${f.error})`)
      .join('; ');
    const err = new Error(
      `${bootstrapFailures.length} of ${bootstrapQueue.length} bootstrap(s) ` +
        `failed: ${summary}. Main positions are in place for every pool; ` +
        `only the bootstrap leg is missing for the listed pools.`,
    );
    err.partialResults = results;
    err.bootstrapFailures = bootstrapFailures;
    err.failedPhase = 'bootstrap';
    throw err;
  }

  // -------------------------------------------------------------------------
  // 8. Phase 3: Lock every position across every pool.
  //
  // This is the irreversibility line. Every preceding phase produced state
  // that the ephemeral wallet can still walk back from (close positions,
  // sweep tokens). Locking escrows the position NFT inside the lock
  // program and mints a Fee Key NFT in its place, committing the LP'd
  // tokens for life — only the fee stream remains claimable, by whoever
  // holds the Fee Key.
  //
  // We only reach here if Phase 1 and Phase 2 both succeeded — so every
  // pool has its main positions AND its bootstrap open. Locking everything
  // at once means a partial Phase 3 failure leaves some pools fully locked
  // and others not; the caller can retry locks via the resume flow.
  //
  // When lockPositions is false (test/manual launches), Phase 3 and Phase 4
  // are skipped — results retain locked: false on every position.
  // -------------------------------------------------------------------------
  let lockFailures = [];
  let transferFailures = [];

  if (lockPositions) {
    const lockResult = await lockAllPositions({
      raydium,
      results,
      onProgress,
    });
    lockFailures = lockResult.lockFailures;

    if (lockFailures.length > 0) {
      // Don't proceed to Phase 4. Fee Key transfers depend on locks
      // having succeeded — there's nothing to transfer for an unlocked
      // position. The user needs to resolve the lock failures (retry)
      // before transfers can run.
      const summary = lockFailures
        .map((f) => `${f.positionType}${f.sliceIndex != null ? ` slice ${f.sliceIndex + 1}` : ''} (${f.error})`)
        .join('; ');
      const err = new Error(
        `${lockFailures.length} position(s) failed to lock: ${summary}. ` +
          `Pools are open and tradable; retry to complete the locks.`,
      );
      err.partialResults = results;
      err.lockFailures = lockFailures;
      err.failedPhase = 'locks';
      throw err;
    }

    // -----------------------------------------------------------------------
    // 9. Phase 4: Transfer Fee Key NFTs to external recipients.
    //
    // Fee Key NFTs only exist for locked positions, so this phase strictly
    // follows Phase 3. Each transfer is an independent NFT-move tx; failures
    // are fail-soft. The final wallet sweep at the end of the launch flow
    // will pick up any Fee Keys still in the ephemeral wallet (whether
    // because the slice had no recipient, or because the transfer here
    // failed) and deliver them to the user's destination wallet.
    // -----------------------------------------------------------------------
    const transferResult = await transferFeeKeys({
      raydium,
      ownerKeypair,
      results,
      onProgress,
    });
    transferFailures = transferResult.transferFailures;

    if (transferFailures.length > 0) {
      // Transfer failures are non-blocking conceptually — the Fee Key
      // NFTs end up in the user's destination wallet via sweep instead
      // of in the recipient's wallet. But we still surface this clearly
      // so the user knows which recipients didn't get their NFTs and
      // can manually re-send them if they want.
      const summary = transferFailures
        .map((f) => `slice ${(f.sliceIndex ?? 0) + 1} -> ${f.recipient} (${f.error})`)
        .join('; ');
      const err = new Error(
        `${transferFailures.length} Fee Key transfer(s) failed: ${summary}. ` +
          `Pools are fully created and locked; un-transferred Fee Keys remain ` +
          `in the launch wallet and will be swept to your destination wallet.`,
      );
      err.partialResults = results;
      err.transferFailures = transferFailures;
      err.failedPhase = 'transfers';
      throw err;
    }
  } else {
    console.log('\n=== Phase 3 + 4 skipped (lockPositions = false) ===');
  }

  console.log(`\n=== All ${results.length} pool(s) created, bootstrapped, locked, and transferred successfully ===`);
  return { results };
}

// ---------------------------------------------------------------------------
// Funding estimator (used by the funding step UI)
// ---------------------------------------------------------------------------
//
// Cost and sizing constants used below (COST_POOL_RENT_SOL, BS_BOOTSTRAP_USD,
// AUTOSWAP_*_MULTIPLIER, SAFETY_BUFFER_PCT, etc.) are imported from
// lpConstants.js. See that file for the rationale behind each value.

/**
 * Estimate funding required for the configured pools, with a per-line
 * breakdown the UI can render so the user can see exactly what each cost
 * covers.
 *
 * NOTE: this is now async. For each non-SOL allocation we look up
 * whether a usable Raydium SOL pool exists for the quote token. If yes,
 * the bootstrap quote-side cost is rolled into the SOL bucket (the user
 * funds extra SOL, and we'll auto-swap on their behalf during the
 * funding step). If no, the existing pre-fund flow stays in place for
 * that allocation — the user sends the quote token themselves.
 *
 * The returned `autoSwapPlan` array tells the funding-step UI and the
 * acquire-quote-tokens endpoint which allocations need a swap, with the
 * per-allocation pool ID already resolved so the swap step doesn't
 * have to repeat the lookup.
 *
 * Returns:
 *   {
 *     solLamports:   <integer total SOL needed in lamports>,
 *     byQuote:       { <mintAddr>: <raw amount> }   // non-SOL pre-fund tokens
 *     totalSol:      <number, total SOL in whole units>,
 *     subtotalSol:   <number, total before safety buffer>,
 *     bufferSol:     <number, the safety buffer line>,
 *     solBreakdown:  [ { label, sol }, ... ]        // line items in SOL
 *     quoteBreakdown:[ { label, symbol, amount, mint }, ... ]  // pre-fund items
 *     autoSwapPlan:  [ {
 *       allocationIndex, quoteMint, quoteSymbol, quoteDecimals,
 *       targetRaw, quoteUsd, solUsd, poolId, poolKind,
 *       estSolSpend,    // approximate SOL we'll spend acquiring it
 *     }, ... ]
 *   }
 */
// ---------------------------------------------------------------------------
// Estimator test seams (F15 de-fork)
// ---------------------------------------------------------------------------
//
// estimateRequiredFunding is the single, canonical funding estimator. It used
// to have a forked twin in lpEstimate.js that the tests pointed at while
// production called this one — the two had diverged (this version has the
// support-position handling, the buffered/unbuffered subtotal split, and the
// resolvedPrices output that the twin lacked). lpEstimate.js has been removed
// and test/lp-estimate.test.mjs now imports from here, so the tests exercise
// the code production actually runs.
//
// To keep the table-driven tests free of network/RPC, the estimator routes its
// two external lookups — the USD price oracle and Raydium route discovery —
// through these overridable seams. Production leaves the overrides null and the
// real implementations (getUsdPrice, discoverRaydiumRoute) are used; tests set
// them via the exported setters and clear them with resetTestFactories().
let __estPriceOracleForTests = null;
let __estRouteDiscoveryForTests = null;

export function setPriceOracleForTests(fn) { __estPriceOracleForTests = fn; }
export function setRouteDiscoveryForTests(fn) { __estRouteDiscoveryForTests = fn; }
// NOTE: these two overrides are also cleared by the shared resetTestFactories()
// defined near the SDK/connection seams above, so a single reset in afterEach
// returns the whole module to production behavior.

// Indirection used ONLY inside estimateRequiredFunding. Falls through to the
// real implementation unless a test has installed an override. Separate from
// the bare getUsdPrice/discoverRaydiumRoute so other callers in this module
// are unaffected by the test seams.
function _estGetUsdPrice(mint) {
  return __estPriceOracleForTests ? __estPriceOracleForTests(mint) : getUsdPrice(mint);
}
function _estDiscoverRaydiumRoute(opts) {
  return __estRouteDiscoveryForTests ? __estRouteDiscoveryForTests(opts) : discoverRaydiumRoute(opts);
}

function resolveTickSpacingForConfig(ammConfigIndex) {
  const idx = ammConfigIndex ?? DEFAULT_AMM_CONFIG_INDEX;
  const tier = FALLBACK_FEE_TIERS.find((t) => t.index === idx)
    || FALLBACK_FEE_TIERS.find((t) => t.index === DEFAULT_AMM_CONFIG_INDEX);
  return tier.tickSpacing;
}

// Estimate two counts for one pool: the distinct CLMM tick arrays its positions
// will initialize (which drives tick-array rent) and the number of positions
// (which the funding breakdown reports to the user, since "tick arrays" mean
// nothing to a launcher). Returns { tickArrayCount, positionCount }.
//
// Each open position touches the two arrays its [tickLower, tickUpper] bounds
// fall in, and the launch wallet pays rent for every array that doesn't yet
// exist. A laddered launch spreads positions across the whole price range
// (wide main, bootstrap, every ladder band, optional support), so the real
// count is far above the two arrays a lone mid-range position would need.
// Budgeting a flat two is what strands a launch mid-open: the wallet runs
// dry paying tick-array rent on a later ladder position.
//
// currentTick is unknown at estimate time (it only exists once the pool is
// on-chain), but every position bound is currentTick + a fixed offset, so the
// distinct-array count is periodic in the launch tick with period = one array
// span. We sweep one full span (reusing the exact range math the orchestrator
// uses) and take the true worst case per fee tier. On any malformed config we
// fall back to a provably-safe upper bound: a position can never initialize
// more than two arrays, so 2 x positions can never be too low.
function estimateTickArrayAndPositionCounts(alloc, tickSpacing) {
  const launchedIsMintA = true; // distinct-array count is symmetric in sort order

  const slices = (alloc.distribution && alloc.distribution.length > 0)
    ? alloc.distribution
    : [{ sharePercent: 100 }];
  const ladder = alloc.ladder || { mode: 'off' };
  const support = alloc.support || { mode: 'off' };
  const supportEnabled = support.mode === 'custom' && Number(support.solValue) > 0;
  const bootstrapMode = (alloc.bootstrap && alloc.bootstrap.mode === 'custom')
    ? 'custom'
    : 'minimal';

  let ladderBandCount = 0;
  if (ladder.mode === 'simple') ladderBandCount = Number(ladder.bandCount) || 0;
  else if (ladder.mode === 'manual') ladderBandCount = Array.isArray(ladder.bands) ? ladder.bands.length : 0;

  // main slices + one bootstrap + ladder bands + optional support. Note the
  // slices all share the wide-main range (and therefore its tick arrays), so
  // they add no distinct arrays — only the position TYPES contribute bounds.
  const positionCount = slices.length + 1 + ladderBandCount + (supportEnabled ? 1 : 0);
  // A position can never initialize more than the two arrays its [lower, upper]
  // bounds fall in, so 2 x positions is a hard ceiling the real count cannot
  // exceed. Used as the malformed-config fallback and as a final defensive clamp.
  const safeUpperBound = 2 * positionCount;

  // Every position bound for a hypothetical launch at `currentTick`, reusing the
  // exact range math the orchestrator uses at open time. A wide main and a
  // bootstrap always exist; ladder bands and support are added when configured.
  const boundsAtTick = (currentTick) => {
    const bounds = [];
    const main = computeMainTicks({ currentTick, tickSpacing, launchedIsMintA });
    bounds.push(main.tickLower, main.tickUpper);

    const boot = computeBootstrapTicks({ currentTick, tickSpacing, mode: bootstrapMode });
    bounds.push(boot.tickLower, boot.tickUpper);

    if (ladder.mode === 'simple' && ladderBandCount > 0) {
      computeLadderTicks({
        currentTick,
        tickSpacing,
        bandCount: ladderBandCount,
        ceilingMultiplier: Number(ladder.ceilingMultiplier),
        launchedIsMintA,
      }).forEach((b) => bounds.push(b.tickLower, b.tickUpper));
    } else if (ladder.mode === 'manual' && ladderBandCount > 0) {
      computeLadderTicksManual({
        currentTick,
        tickSpacing,
        bands: ladder.bands.map((b) => ({
          lowerMultiplier: Number(b.lowerMultiplier),
          upperMultiplier: Number(b.upperMultiplier),
        })),
        launchedIsMintA,
      }).forEach((b) => bounds.push(b.tickLower, b.tickUpper));
    }

    if (supportEnabled) {
      const sup = computeSupportTicks({
        currentTick,
        tickSpacing,
        launchedIsMintA,
        depthPct: SUPPORT_DEPTH_PCT_DEFAULT,
      });
      bounds.push(sup.tickLower, sup.tickUpper);
    }
    return bounds;
  };

  try {
    // The number of tick arrays a launch actually initializes is the count of
    // DISTINCT arrays its position bounds fall in. That count depends on the
    // on-chain launch tick — which doesn't exist yet at estimate time — but it
    // is periodic in the launch tick with period = one array span: every bound
    // is a fixed offset from the launch tick, so when the tick advances by a
    // full span every bound's array advances by one and the distinct COUNT is
    // unchanged. So we sweep the launch tick across exactly one span and take the
    // worst case — the true maximum over every possible launch price, computed
    // per fee tier rather than approximated by a hand-tuned pad.
    //
    // This is why a default two-position launch on the 1% / 120-spacing tier
    // resolves to three arrays, not four: across every launch tick the wide
    // main's lower bound and the bootstrap's upper bound land in the same array
    // straddling the launch price (they sit only ~1300 ticks apart, well inside
    // one 7200-tick array), so the four bounds only ever occupy three arrays.
    // Finer tiers (spacing 10, 1) have narrower arrays where those two bounds can
    // split, and the sweep correctly returns four there. Multi-slice mains stay
    // at three because the extra slices reuse the same range. The earlier
    // approach (reference tick + flat pad, clamped to 2 x positions) over-budgeted
    // both — a 2-slice pool clamped all the way up to six.
    const span = TICK_ARRAY_SIZE * tickSpacing;
    let maxDistinct = 0;
    for (let currentTick = 0; currentTick < span; currentTick++) {
      const distinct = new Set(
        boundsAtTick(currentTick).map((t) => tickArrayStartIndex(t, tickSpacing)),
      ).size;
      if (distinct > maxDistinct) maxDistinct = distinct;
    }
    // Floor at 2 (a lone mid-range position still needs its two arrays); the
    // upper clamp is defensive only — the sweep can never exceed it.
    const tickArrayCount = Math.min(Math.max(maxDistinct, 2), safeUpperBound);
    return { tickArrayCount, positionCount };
  } catch (e) {
    console.warn(
      `estimateRequiredFunding: tick-array count fell back to per-position bound (${e.message})`,
    );
    return { tickArrayCount: safeUpperBound, positionCount };
  }
}

export async function estimateRequiredFunding({
  allocations,
  // Required when any allocation has bootstrap.mode === 'custom'. The
  // estimator uses it to compute that allocation's bootstrap quote-side
  // USD value (= bootstrap.supplyPercent × targetMarketCapUsd / 100).
  // When omitted, custom-mode allocations fall back to the minimal-mode
  // budget — which is wrong if the user actually opted in to custom, but
  // safe (under-budgets so the launch flow surfaces an error rather than
  // proceeding with a half-funded bootstrap).
  targetMarketCapUsd,
  // When true, include a line for publishing the permanent launch report to
  // Arweave. The endpoint resolves the effective value from the request body
  // (live cost preview) or the saved preference; defaults off for direct callers.
  publishLaunchReport = false,
}) {
  const solBreakdown = [];
  const quoteBreakdown = [];
  const byQuote = {};
  const autoSwapPlan = [];
  // Per-allocation resolved USD prices. Tracks the canonical quote-token
  // USD value that funding-estimate sized everything against. Exposed
  // back to the frontend so the user sees the SAME price everywhere
  // (Step 2 display, Step 3 cost preview, Step 5 pool creation),
  // rather than seeing one number in Step 2 and another at create-pool.
  //
  // Entry shape:
  //   { allocationIndex, quoteMint, quoteUsd, source }
  // where source is one of:
  //   'sol'           — SOL pool, used the SOL/USD oracle
  //   'user-override' — user typed a value in customize mode
  //   'raydium-probe' — Trade API gave us an effective price
  //   'oracle'        — aggregator (Gecko/DexScreener) priced it
  //   'unresolved'    — funding-estimate couldn't get a price
  //                     (rare; would error out at funding-estimate
  //                     time too for non-SOL non-override cases)
  const resolvedPrices = [];
  // Buffered vs unbuffered cost tracking. The 20% safety buffer is there
  // to cover the things that can fluctuate between estimate time and
  // launch time:
  //   - swap slippage when buying quote tokens via auto-swap (price
  //     drift, partial fills, route changes)
  //   - on-chain fee variance (compute unit price changes, signature
  //     fees, rent for unexpected new accounts)
  //   - small rebalances during pool creation as ticks snap
  // Things that are EXACT deposits with no swap and no fee variance
  // don't need buffer padding — most importantly the support-position
  // SOL deposit on SOL pools (a precise transfer of a known amount to
  // a single-sided position). Non-SOL support also gets excluded since
  // its auto-swap branch already builds in a 1.5x spend multiplier to
  // cover slippage; layering another 20% on top is double-counting.
  let bufferedSubtotal = 0;
  let unbufferedSubtotal = 0;

  // Helper to add a SOL line to the breakdown and running total. The
  // optional `buffered` arg defaults to true (most costs) — passing
  // false routes the amount into the unbuffered bucket so the safety
  // buffer math skips it.
  const addSol = (label, sol, buffered = true) => {
    solBreakdown.push({ label, sol });
    if (buffered) bufferedSubtotal += sol;
    else unbufferedSubtotal += sol;
  };

  // Look up SOL price once. We use it for sizing the SOL equivalent of
  // every auto-swap line; one lookup per estimate call rather than per
  // allocation. Fallback constant if the price service is unavailable.
  let solUsd;
  try {
    // getUsdPrice returns a Decimal or null
    const p = await _estGetUsdPrice(WSOL_MINT);
    solUsd = p || new Decimal(FALLBACK_SOL_USD);
  } catch (e) {
    console.warn(`estimateRequiredFunding: SOL price fallback (${e.message})`);
    solUsd = new Decimal(FALLBACK_SOL_USD);
  }

  for (const [poolIdx, a] of allocations.entries()) {
    const slices = (a.distribution && a.distribution.length > 0)
      ? a.distribution
      : [{ sharePercent: 100 }];

    // Resolve the quote token's basics (used for the SOL-vs-non-SOL branch)
    const qSym = (a.quoteToken || '').toUpperCase();
    const known = KNOWN_QUOTES[qSym];
    const isSol = (known && known.address === WSOL_MINT) || qSym === 'SOL';
    const quoteSymbol = known
      ? known.symbol
      : (a.quoteSymbolOverride || (a.quoteToken || '').slice(0, 6));
    const quoteAddr = known ? known.address : a.quoteToken;
    const quoteDecimals = known
      ? known.decimals
      : (a.quoteDecimalsOverride !== undefined && a.quoteDecimalsOverride !== null
          ? Number(a.quoteDecimalsOverride)
          : 6);

    const poolLabel = `Pool ${poolIdx + 1} (${quoteSymbol})`;

    // Pool creation: just the pool state account. (Tick-array rent is the
    // separate line below; the pool-creation rent alone does not cover it.)
    addSol(`${poolLabel}: pool creation`, COST_POOL_RENT_SOL);
    // Tick-array rent, plus the position count for the breakdown label. Budget
    // the real number of distinct arrays this pool's positions initialize (wide
    // main + bootstrap + every ladder band + optional support), not a flat two;
    // see estimateTickArrayAndPositionCounts for why a flat two strands laddered
    // launches. The user-facing label is phrased in positions, not tick arrays
    // (which mean nothing to a launcher), but the COST still reflects the real
    // array count. Stays in the buffered bucket, so the 20% buffer applies.
    const { tickArrayCount, positionCount } = estimateTickArrayAndPositionCounts(
      a,
      resolveTickSpacingForConfig(a.ammConfigIndex),
    );
    addSol(
      `${poolLabel}: price-range rent (for ${positionCount} position${positionCount === 1 ? '' : 's'})`,
      tickArrayCount * COST_TICK_ARRAY_SOL,
    );

    // Per-slice costs
    for (let s = 0; s < slices.length; s++) {
      addSol(
        `${poolLabel}: main slice ${s + 1}/${slices.length} (NFT mint + lock)`,
        COST_POSITION_SOL + COST_LOCK_SOL,
      );
      if (slices[s].recipient) {
        addSol(
          `${poolLabel}: slice ${s + 1} transfer to recipient`,
          COST_TRANSFER_SOL,
        );
      }
    }

    // Bootstrap position (always one per pool — NFT mint + lock)
    addSol(
      `${poolLabel}: bootstrap position (NFT mint + lock)`,
      COST_POSITION_SOL + COST_LOCK_SOL,
    );

    // Ladder bands. Each band is its own position (NFT mint + lock,
    // no Fee Key transfer since ladder positions don't take recipients).
    // The launched-side supply for ladder bands comes out of the same
    // pool allocation as the wide main; it doesn't need any additional
    // funding from the user. Just the per-position SOL rent and lock fees.
    //
    // Both simple and manual modes contribute the same per-band cost.
    // Simple-mode count comes from ladderCfg.bandCount; manual-mode
    // count comes from the bands array length. Off contributes zero.
    const ladderCfg = a.ladder || { mode: 'off' };
    let ladderBandCount = 0;
    if (ladderCfg.mode === 'simple') {
      ladderBandCount = Number(ladderCfg.bandCount) || 0;
    } else if (ladderCfg.mode === 'manual') {
      ladderBandCount = Array.isArray(ladderCfg.bands) ? ladderCfg.bands.length : 0;
    }
    for (let b = 0; b < ladderBandCount; b++) {
      addSol(
        `${poolLabel}: ladder band ${b + 1}/${ladderBandCount} (NFT mint + lock)`,
        COST_POSITION_SOL + COST_LOCK_SOL,
      );
    }

    // Support position cost — only the NFT mint + lock fee. The
    // quote-side deposit itself is added later (it's either rolled into
    // the SOL bucket for SOL pools or added to the bootstrap auto-swap
    // target for non-SOL pools, both handled in the bootstrap-cost
    // section below).
    const supportCfg = a.support || { mode: 'off' };
    const supportEnabled = supportCfg.mode === 'custom'
      && Number(supportCfg.solValue) > 0;
    if (supportEnabled) {
      addSol(
        `${poolLabel}: support position (NFT mint + lock)`,
        COST_POSITION_SOL + COST_LOCK_SOL,
      );
    }

    // Determine the bootstrap mode and USD budget for the quote-side.
    //
    // Minimal mode: budget is the historical $1 (manual prefund) / $2
    //   (auto-swap acquire target). These are constants; the per-allocation
    //   need is dust regardless of pool size.
    //
    // Custom mode: budget is bootstrap.supplyPercent × targetMarketCapUsd / 100,
    //   the launched-side USD value the user is committing as starting
    //   liquidity. The quote-side need is ≈ equal in USD (1:1 ratio at
    //   current tick), so this same USD value gets converted to SOL,
    //   quote tokens, or auto-swap target depending on the pool.
    //
    // A custom-mode bootstrap with a real launched-side supply sizes its
    // quote-side deposit as supplyPercent x targetMarketCapUsd / 100, so the
    // target market cap is mandatory. If it is missing we cannot size the
    // deposit; silently falling back to the $1 minimal budget would undersize
    // the whole estimate, the user would fund too little, and the launch would
    // later fail at deposit time with a confusing "insufficient funds". Refuse
    // here instead, naming the fix, so the error surfaces before any spend.
    const bsCfg = a.bootstrap || { mode: 'minimal' };
    const bsIsCustom = bsCfg.mode === 'custom';
    if (bsIsCustom && Number(bsCfg.supplyPercent) > 0 && !(Number(targetMarketCapUsd) > 0)) {
      throw new Error(
        `${poolLabel} uses a custom bootstrap but no target market cap was provided. `
        + `Set a target market cap (it sizes the bootstrap's starting liquidity) before launching.`,
      );
    }
    let bsActualUsd; // the actual USD value the bootstrap quote-side needs
    if (bsIsCustom && Number(targetMarketCapUsd) > 0 && Number(bsCfg.supplyPercent) > 0) {
      bsActualUsd = (Number(bsCfg.supplyPercent) * Number(targetMarketCapUsd)) / 100;
    } else {
      // Minimal mode, or a degenerate custom bootstrap with zero launched-side
      // supply (no quote-side need, so no target market cap required).
      bsActualUsd = BS_BOOTSTRAP_USD; // $1
    }

    // Compute the support's USD-equivalent quote-side need. Support is
    // single-sided in quote and the user enters a SOL value; convert
    // through current SOL/USD to USD. Same path as the bootstrap-custom
    // quote-side, just routed through a different input. Zero when
    // support is disabled (mode='off' or absent).
    const supportActualUsd = supportEnabled
      ? Number(supportCfg.solValue) * Number(solUsd.toString())
      : 0;

    // Bootstrap quote-side requirement: three branches.
    //   (1) SOL pool       → SOL deposited directly (auto-wrapped at deposit).
    //   (2) Trade API can route SOL→quoteMint (typical case)
    //                      → roll cost into SOL bucket; we'll swap during funding.
    //   (3) No route from Trade API
    //                      → fall back to manual pre-fund.
    //
    // In minimal mode the USD value is dust ($1); in custom mode it's the
    // user's chosen support amount. The branch logic is identical otherwise.
    //
    // When a support position is also configured, its quote-side need
    // adds to the same bucket — it's just more of the same quote token
    // sitting in the same wallet at LP-creation time. We surface support
    // as its own breakdown line so the user sees what each piece costs.
    if (isSol) {
      // SOL pool: the canonical quote-USD is just the SOL/USD price we
      // resolved at the top of the function. Record it now so the
      // frontend has a complete picture regardless of pool composition.
      resolvedPrices.push({
        allocationIndex: poolIdx,
        quoteMint: WSOL_MINT,
        quoteUsd: solUsd.toString(),
        source: 'sol',
      });

      // (1) SOL pool — quote-side is just SOL.
      // For minimal mode we keep the historical dust constant (0.001 SOL,
      // which comfortably covers the 1-whole-token bootstrap's actual need).
      // For custom mode, we deposit the actual USD value worth of SOL.
      let solCost;
      let label;
      if (bsIsCustom) {
        solCost = bsActualUsd / Number(solUsd.toString());
        label = `${poolLabel}: bootstrap support (~$${bsActualUsd.toFixed(2)} as SOL)`;
      } else {
        solCost = COST_BS_QUOTE_SOL;
        label = `${poolLabel}: bootstrap quote-side (SOL, dust)`;
      }
      addSol(label, solCost);

      // Support deposit (only emitted when enabled). Its own line so the
      // user can see the support cost broken out — the SOL amount is
      // exactly solValue, no conversion math needed for a SOL pool.
      //
      // Marked unbuffered: this is an exact deposit of a known SOL
      // amount into a single-sided position, no swap involved, no fee
      // variance to insulate against. The 20% safety buffer would just
      // pad the user's funding requirement without serving any real
      // protective purpose.
      if (supportEnabled) {
        addSol(
          `${poolLabel}: support position (~$${supportActualUsd.toFixed(2)} as SOL)`,
          Number(supportCfg.solValue),
          false,
        );
      }
    } else {
      // Try Raydium Trade API for route discovery. The probe quote also
      // gives us the effective price (USD per whole quote token), which
      // matters for low-volume tokens whose USD oracles often have no
      // data. If the Trade API can route the swap at all, the route is
      // viable and we get a usable price in the same call.
      let route = null;
      try {
        route = await _estDiscoverRaydiumRoute({
          quoteMint: quoteAddr,
          quoteDecimals,
          solUsd,
        });
      } catch (e) {
        console.warn(
          `estimateRequiredFunding: route discovery failed for ${quoteAddr}: ${e.message}`,
        );
      }

      // Resolve a USD price for the quote token. Priority:
      //   1. Explicit override on the allocation config
      //   2. Effective price from Trade API probe (covers low-volume tokens)
      //   3. Standard USD oracle fallback (Coingecko/Jupiter)
      // Used for sizing both the auto-swap and manual-prefund branches.
      let quoteUsd = null;
      let quoteUsdSource = null;
      if (a.quoteUsdOverride !== undefined && a.quoteUsdOverride !== null) {
        quoteUsd = new Decimal(a.quoteUsdOverride);
        quoteUsdSource = 'user-override';
      } else if (route && route.effectiveQuoteUsd && route.effectiveQuoteUsd.gt(0)) {
        quoteUsd = route.effectiveQuoteUsd;
        quoteUsdSource = 'raydium-probe';
      } else {
        try {
          quoteUsd = await _estGetUsdPrice(quoteAddr);
          if (quoteUsd && quoteUsd.gt(0)) {
            quoteUsdSource = 'oracle';
          } else {
            quoteUsd = null;
            quoteUsdSource = 'unresolved';
          }
        } catch (e) {
          quoteUsd = null;
          quoteUsdSource = 'unresolved';
        }
      }

      // Record the canonical quote-USD for this allocation so the
      // frontend can show the same number everywhere (Step 2 display,
      // Step 3 cost preview, Step 5 pool creation).
      resolvedPrices.push({
        allocationIndex: poolIdx,
        quoteMint: quoteAddr,
        quoteUsd: quoteUsd ? quoteUsd.toString() : null,
        source: quoteUsdSource,
      });

      // Pick the acquire/prefund target USD. For minimal mode:
      //   auto-swap target = $2 (oversize the $1 actual need by 2x so a
      //                          partial fill still meets the need)
      //   manual prefund   = $1 (user can send the exact amount; no slippage)
      // For custom mode:
      //   auto-swap target = bsActualUsd × 1.15 (15% partial-fill buffer)
      //   manual prefund   = bsActualUsd × 1.0  (user can send exact)
      //
      // Custom-mode multipliers are dialed back from the minimal-mode
      // constants because the compound minimal-mode buffer (2× target ×
      // 2× SOL spend = 4× over need) was sized for $1 dust where $3
      // over-budget is irrelevant. For a user-funded $2000 bootstrap,
      // the same compound 4× becomes $8000 of SOL spend budgeted for
      // a swap that should land within a few percent of $2000 — that
      // asks the user to fund 4× what they're committing to LP, with
      // the bulk sweeping back at the end. See the multiplier-constant
      // comments above for the reasoning behind the chosen values.
      const isAutoSwap = !!(route && route.available);
      let targetUsd;
      if (bsIsCustom) {
        targetUsd = isAutoSwap
          ? bsActualUsd * AUTOSWAP_CUSTOM_TARGET_MULTIPLIER
          : bsActualUsd;
      } else {
        targetUsd = isAutoSwap ? AUTOSWAP_TARGET_USD : BS_BOOTSTRAP_USD;
      }

      // Support's contribution to the same quote-token target. Support
      // uses the custom-mode multiplier since it's also user-funded at
      // a meaningful scale (vs the minimal-mode dust target). When
      // support is disabled this is zero.
      const supportTargetUsd = supportEnabled
        ? (isAutoSwap
            ? supportActualUsd * AUTOSWAP_CUSTOM_TARGET_MULTIPLIER
            : supportActualUsd)
        : 0;

      // Compute the target raw amount: targetUsd worth of quote token if
      // we know the price, else fixed fallback. ceil() ensures we don't
      // round down below the requirement.
      let targetWhole;
      if (quoteUsd && quoteUsd.gt(0)) {
        targetWhole = new Decimal(targetUsd).div(quoteUsd).toNumber();
      } else {
        // Fallback: scale the fixed amount up for auto-swap to keep the
        // same 2x relative buffer. The fallback path is rare (no price
        // data anywhere); this keeps the behaviour proportional.
        targetWhole = isAutoSwap ? BS_FALLBACK_WHOLE * 2 : BS_FALLBACK_WHOLE;
      }
      const rawAmt = Math.ceil(targetWhole * Math.pow(10, quoteDecimals));

      // Support whole/raw for this quote, computed against the same
      // quoteUsd so the unit conversion is consistent with bootstrap.
      let supportWhole = 0;
      let supportRaw = 0;
      if (supportEnabled) {
        if (quoteUsd && quoteUsd.gt(0)) {
          supportWhole = new Decimal(supportTargetUsd).div(quoteUsd).toNumber();
        } else {
          // No price oracle data — fall back to a multiple of the
          // bootstrap fallback. Custom-scale launches without any price
          // data are an edge case the user must address by setting
          // quoteUsdOverride; this keeps the numbers proportional.
          supportWhole = BS_FALLBACK_WHOLE *
            Math.max(1, Math.ceil(supportTargetUsd / BS_BOOTSTRAP_USD));
        }
        supportRaw = Math.ceil(supportWhole * Math.pow(10, quoteDecimals));
      }

      if (isAutoSwap) {
        // (2) Auto-swap branch.
        // SOL spend scales with the acquire target × the sizing multiplier.
        // Minimal mode: $2 target × 2 = $4 spent for $2 acquired.
        // Custom mode: bsActualUsd × 1.15 target × 1.10 = ~27% over actual
        // need (compound 1.265× of bsActualUsd) spent for ~15% over need
        // acquired. Most of the buffer absorbs swap slippage; the small
        // acquire-side buffer absorbs partial fills.
        const spendMultiplier = (bsIsCustom || supportEnabled)
          ? AUTOSWAP_CUSTOM_SIZING_MULTIPLIER
          : AUTOSWAP_SIZING_MULTIPLIER;
        const estSolSpend = new Decimal(targetUsd)
          .mul(spendMultiplier)
          .div(solUsd)
          .toNumber();
        const label = bsIsCustom
          ? `${poolLabel}: bootstrap support (auto-swap -> ~$${bsActualUsd.toFixed(2)} ${quoteSymbol})`
          : `${poolLabel}: bootstrap quote-side (auto-swap -> ~$${targetUsd} ${quoteSymbol})`;
        addSol(label, estSolSpend);

        // Support's auto-swap spend, emitted as its own line. The
        // acquire job will pick up the per-mint cumulative target from
        // the per-mint plan items below — we don't need to sum here.
        //
        // Marked unbuffered: the spendMultiplier (1.5x) already pads the
        // SOL spend to cover swap slippage on the SOL→quote conversion.
        // Adding the 20% safety buffer on top would double-count
        // slippage protection. The bootstrap auto-swap line above stays
        // buffered because its multiplier is smaller and the bootstrap
        // amount is a hard floor (under-bootstrapping fails the launch).
        let supportSolSpend = 0;
        if (supportEnabled) {
          supportSolSpend = new Decimal(supportTargetUsd)
            .mul(spendMultiplier)
            .div(solUsd)
            .toNumber();
          addSol(
            `${poolLabel}: support position (auto-swap -> ~$${supportActualUsd.toFixed(2)} ${quoteSymbol})`,
            supportSolSpend,
            false,
          );
        }
        // Compute the actual bootstrap need (vs the ambitious acquire
        // target) so the frontend can mark a row "met" once we have
        // ENOUGH for the bootstrap, even if the swap underperformed
        // (e.g. 50% partial fill of a $2 target still leaves $1 — the
        // actual on-chain need). Without this, partial fills would
        // leave the row blocked even though the launch would succeed.
        let minWhole;
        if (quoteUsd && quoteUsd.gt(0)) {
          minWhole = new Decimal(bsActualUsd).div(quoteUsd).toNumber();
        } else {
          minWhole = BS_FALLBACK_WHOLE;
        }
        const minRaw = Math.ceil(minWhole * Math.pow(10, quoteDecimals));

        // The acquire-job expects a single target per (allocationIndex,
        // quoteMint) pair. Combine bootstrap + support raw amounts and
        // their min equivalents so a single swap call acquires both
        // pieces in one go.
        const combinedTargetRaw = rawAmt + supportRaw;
        const combinedMinRaw = minRaw + (supportEnabled
          ? Math.ceil(
              (quoteUsd && quoteUsd.gt(0)
                ? new Decimal(supportActualUsd).div(quoteUsd).toNumber()
                : BS_FALLBACK_WHOLE)
              * Math.pow(10, quoteDecimals),
            )
          : 0);
        autoSwapPlan.push({
          allocationIndex: poolIdx,
          quoteMint: quoteAddr,
          quoteSymbol,
          quoteDecimals,
          // targetRaw is what swapSolForQuote tries to acquire
          // (oversize for slippage buffer). minRaw is the actual
          // bootstrap requirement on-chain. Frontend uses minRaw for
          // the "met" check, targetRaw for the display "≈ N" amount.
          // Both now sum bootstrap + support so a single swap satisfies
          // both per-pool quote-side needs.
          targetRaw: String(combinedTargetRaw),
          minRaw: String(combinedMinRaw),
          // quoteUsd here is what swapSolForQuote uses to size the SOL
          // spend at swap time (re-computes the same formula). Pass the
          // effective price we used for the estimate so the budgets
          // stay consistent between estimate and swap.
          quoteUsd: quoteUsd.toString(),
          solUsd: solUsd.toString(),
          // poolId is informational only; the Trade API picks pools
          // internally (potentially multi-hop). 'trade-api' sentinel
          // makes that explicit in any logs the value flows into.
          poolId: 'trade-api',
          poolKind: 'route',
          estSolSpend: estSolSpend + supportSolSpend,
          // sizingMultiplier and bootstrapMode propagate the estimator's
          // mode-aware budget choices down to the actual swap execution.
          // The swap function (swapService.js) has its own slippage
          // oversize math and a hard MAX_SPEND cap that was sized for
          // dust targets. Without these fields, a custom-mode bootstrap
          // would get budgeted correctly by the estimator but then have
          // its actual swap silently floored to ~0.05 SOL by the cap,
          // delivering almost no quote tokens and failing the bootstrap.
          // server.js threads these through to swapSolForQuote.
          sizingMultiplier: (bsIsCustom || supportEnabled)
            ? AUTOSWAP_CUSTOM_SIZING_MULTIPLIER
            : AUTOSWAP_SIZING_MULTIPLIER,
          bootstrapMode: (bsIsCustom || supportEnabled) ? 'custom' : 'minimal',
        });
      } else {
        // (3) Manual pre-fund branch.
        byQuote[quoteAddr] = (byQuote[quoteAddr] || 0) + rawAmt;
        const label = bsIsCustom
          ? `${poolLabel}: bootstrap support (~$${bsActualUsd.toFixed(2)})`
          : `${poolLabel}: bootstrap quote-side`;
        quoteBreakdown.push({
          label,
          symbol: quoteSymbol,
          // Display-friendly: trim long decimals while keeping enough
          // precision to be unambiguous (e.g. 33333.3 not 33333.333334).
          // targetWhole is a JS Number; toPrecision returns a string.
          amount: Number(Number(targetWhole).toPrecision(6)),
          mint: quoteAddr,
        });

        // Support's contribution to manual prefund — emitted as its
        // own breakdown line so the user can see what each piece is.
        if (supportEnabled) {
          byQuote[quoteAddr] = (byQuote[quoteAddr] || 0) + supportRaw;
          quoteBreakdown.push({
            label: `${poolLabel}: support position (~$${supportActualUsd.toFixed(2)})`,
            symbol: quoteSymbol,
            amount: Number(Number(supportWhole).toPrecision(6)),
            mint: quoteAddr,
          });
        }
      }
    }

    // Per-pool transaction buffer (priority fees, retries, etc.)
    addSol(`${poolLabel}: network/priority fees`, COST_TX_BUFFER_SOL);
  }

  // Token creation cost (was previously added by the frontend; now part of
  // the breakdown so the user sees it).
  addSol('Token creation (mint + metadata)', COST_TOKEN_CREATE_SOL);

  // Permanent launch report (Arweave). Only when the user has the launch-report
  // option enabled (opt-out, default on). See COST_LAUNCH_REPORT_SOL.
  if (publishLaunchReport) {
    addSol('Launch report (permanent Arweave publish)', COST_LAUNCH_REPORT_SOL);
  }

  // Safety buffer applies only to the buffered subtotal — exact deposits
  // (support positions) live in the unbuffered subtotal and pass through
  // to the total without padding. See the bufferedSubtotal /
  // unbufferedSubtotal comment up top for the why.
  const buffer = bufferedSubtotal * SAFETY_BUFFER_PCT;
  solBreakdown.push({
    label: `Safety buffer (${(SAFETY_BUFFER_PCT * 100).toFixed(0)}% on slippage/fee variance)`,
    sol: buffer,
  });
  const subtotal = bufferedSubtotal + unbufferedSubtotal;
  const total = subtotal + buffer;

  return {
    solLamports: Math.ceil(total * LAMPORTS_PER_SOL),
    byQuote,
    totalSol: total,
    subtotalSol: subtotal,
    bufferSol: buffer,
    solBreakdown,
    quoteBreakdown,
    autoSwapPlan,
    resolvedPrices,
    // SOL's USD price used for this estimate (from the WSOL oracle, or
    // FALLBACK_SOL_USD if the oracle was unavailable). Exposed so the
    // frontend can value SOL-denominated airdrop contributions even when
    // the launch has no SOL-quoted pool to read a price from (e.g. a
    // flywheel-paired launch). Without this the airdrop allocation can't
    // be computed and the airdrop is silently skipped at launch.
    solUsd: Number(solUsd.toString()),
  };
}

// ---------------------------------------------------------------------------
// Test-only export of internal phase helpers
// ---------------------------------------------------------------------------
//
// Exposes the per-phase building blocks of the launch flow so the
// integration tests in test/launch-lifecycle.test.mjs can drive them
// directly with a mock Raydium SDK, without going through the full
// createPoolsAndPositions orchestrator (which interleaves tick math,
// USD price resolution, and quote-token lookups that aren't part of
// the phase being tested).
//
// Production code never reads from __testHooks. It always calls the
// public createPoolsAndPositions entry point above, which composes
// these helpers internally. The export exists solely so tests can
// reach in and exercise each phase in isolation.
//
// Function declarations are hoisted within the module, so it's fine
// for this object literal to reference functions that appear earlier
// in the file.
export const __testHooks = {
  createSinglePool,
  lockAllPositions,
  transferFeeKeys,
};
