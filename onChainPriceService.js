// onChainPriceService.js
//
// Price a token from its liquidity pools ON-CHAIN, instead of from an
// indexer's opinion of them.
//
// Why: the aggregators (GeckoTerminal, DexScreener, Jupiter) return a price
// for almost any indexed token, and for unverified low-caps that price is
// routinely the last tiny trade in a near-empty pool. Making the aggregator
// selection liquidity-aware helped, but the number still came from an
// index. Reading the pool account directly gives two things the indexers
// can't: the price the pool will ACTUALLY trade at right now, and whether
// the pool's liquidity is in range at that price.
//
// Method:
//   1. Discover Raydium pools pairing the asset with an anchor whose USD
//      value we already trust: SOL (from the WSOL oracle) or a stablecoin
//      (USDC/USDT at $1). Discovery uses Raydium's pool index only to LIST
//      candidates — never for the price.
//   2. Read each candidate's state on-chain.
//        Concentrated (CLMM): price from sqrtPriceX64; in-range iff active
//        liquidity at the current tick is non-zero.
//        Standard / CPMM:     price from vault reserves; in-range iff both
//        reserves are non-zero.
//   3. Keep pools with at least MIN_LIQUIDITY_USD of depth that are in range.
//      Depth for constant-product pools is computed from the anchor-side
//      reserve (fully on-chain). For CLMM, on-chain "liquidity" is a virtual
//      curve parameter, not a USD amount, so depth uses Raydium's TVL figure
//      for that pool — used ONLY as a filter, and always alongside the
//      on-chain in-range check, so a stale TVL can't promote an empty pool.
//   4. The deepest qualifying pool sets the price. When several qualify,
//      the spread between the deepest and the median is reported so callers
//      can refuse a price the pools themselves disagree about.
//
// This module holds the selection logic as pure functions over plain data,
// with the SDK calls injected, so every branch is testable offline.

import Decimal from 'decimal.js';

export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';

// Raydium program IDs, used to pick the right on-chain reader for a pool.
// The pool index reports both AMM v4 and CPMM pools as type "Standard", so
// `type` alone cannot tell them apart — and they have DIFFERENT account
// layouts. Reading a CPMM pool with the AMM v4 decoder yields garbage.
// Values verified against the pinned SDK's exported constants.
export const RAYDIUM_PROGRAMS = Object.freeze({
  CLMM: 'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK',
  AMM_V4: '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8',
  AMM_STABLE: '5quBtoiQqxF9Jv6KYKctB59NT3gtJD2Y65kdnB1Uev3h',
  CPMM: 'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C',
});

// Which reader handles a pool. programId is authoritative; `type` is the
// fallback for index entries (or test fixtures) that omit it.
export function poolReaderKind(pool) {
  const pid = pool?.programId ? String(pool.programId) : null;
  if (pid === RAYDIUM_PROGRAMS.CLMM) return 'clmm';
  if (pid === RAYDIUM_PROGRAMS.CPMM) return 'cpmm';
  if (pid === RAYDIUM_PROGRAMS.AMM_V4 || pid === RAYDIUM_PROGRAMS.AMM_STABLE) return 'amm';
  if (pid) return null; // some other program — no reader for it
  const t = String(pool?.type || '').toLowerCase();
  if (t.startsWith('concentrated')) return 'clmm';
  if (t === 'standard') return 'amm';
  return null;
}

// Below this, a pool is dust: its "price" is whatever the last small trade
// left behind. $100 admits genuinely tiny-but-real markets.
export const MIN_LIQUIDITY_USD = 100;

// If the deepest qualifying pool and the median of qualifying pools differ
// by more than this, the market itself is inconsistent and no single number
// is trustworthy as a launch reference.
export const MAX_POOL_SPREAD_PCT = 10;

const TWO_POW_64 = new Decimal(2).pow(64);

// CLMM price: (sqrtPriceX64 / 2^64)^2 gives raw-unit B per raw-unit A;
// scale by 10^(decA - decB) to get whole-unit B per whole-unit A.
export function clmmPriceBPerA(sqrtPriceX64, decimalsA, decimalsB) {
  const sqrt = new Decimal(sqrtPriceX64.toString()).div(TWO_POW_64);
  return sqrt.mul(sqrt).mul(new Decimal(10).pow(decimalsA - decimalsB));
}

// Constant-product price: whole-unit quote per whole-unit base.
export function reservePriceQuotePerBase(baseReserveRaw, quoteReserveRaw, baseDecimals, quoteDecimals) {
  const base = new Decimal(baseReserveRaw.toString()).div(new Decimal(10).pow(baseDecimals));
  const quote = new Decimal(quoteReserveRaw.toString()).div(new Decimal(10).pow(quoteDecimals));
  if (!base.gt(0)) return null;
  return quote.div(base);
}

function anchorUsd(anchorMint, solUsd) {
  if (anchorMint === WSOL_MINT) return solUsd ? new Decimal(solUsd.toString()) : null;
  if (anchorMint === USDC_MINT || anchorMint === USDT_MINT) return new Decimal(1);
  return null;
}

/**
 * Pure selection over evaluated candidates. Each candidate:
 *   { poolId, anchorMint, anchorSymbol, priceUsd: Decimal, liquidityUsd: Decimal,
 *     inRange: boolean, kind: 'clmm'|'standard' }
 * Returns { best, qualifying, spreadPct } or null when nothing qualifies.
 */
export function selectBestPool(candidates, { minLiquidityUsd = MIN_LIQUIDITY_USD } = {}) {
  const qualifying = (candidates || []).filter((c) =>
    c && c.inRange
    && c.priceUsd && c.priceUsd.isFinite() && c.priceUsd.gt(0)
    && c.liquidityUsd && c.liquidityUsd.isFinite() && c.liquidityUsd.gte(minLiquidityUsd),
  );
  if (qualifying.length === 0) return null;

  const sorted = [...qualifying].sort((a, b) => b.liquidityUsd.cmp(a.liquidityUsd));
  const best = sorted[0];

  // Median of qualifying prices, as the "consensus" the deepest pool is
  // compared against. With one pool the spread is zero by construction.
  const prices = [...qualifying].map((c) => c.priceUsd).sort((a, b) => a.cmp(b));
  const mid = Math.floor(prices.length / 2);
  const median = prices.length % 2 === 1
    ? prices[mid]
    : prices[mid - 1].add(prices[mid]).div(2);
  const spreadPct = median.gt(0)
    ? best.priceUsd.sub(median).abs().div(median).mul(100)
    : new Decimal(0);

  return { best, qualifying: sorted, spreadPct };
}

/**
 * Evaluate one discovered pool into a candidate, reading its state on-chain
 * through the injected adapters. Returns null for pools that can't be read
 * or don't pair the asset with a trusted anchor.
 *
 * `pool` is a Raydium pool-index item: { id, type, mintA:{address,decimals},
 * mintB:{address,decimals}, tvl }.
 */
export async function evaluatePool(pool, { mint, solUsd, readClmm, readStandard, readCpmm }) {
  const a = pool?.mintA?.address; const b = pool?.mintB?.address;
  if (!a || !b) return null;
  const readerKind = poolReaderKind(pool);
  if (!readerKind) return null; // unknown program — nothing we can decode
  let assetIsA;
  if (a === mint) assetIsA = true; else if (b === mint) assetIsA = false; else return null;
  const anchorMint = assetIsA ? b : a;
  const anchorPrice = anchorUsd(anchorMint, solUsd);
  if (!anchorPrice) return null; // not paired with a trusted anchor

  const decA = Number(pool.mintA.decimals); const decB = Number(pool.mintB.decimals);

  try {
    if (readerKind === 'clmm') {
      const st = await readClmm(pool.id);
      if (!st) return null;
      const liquidity = new Decimal((st.liquidity ?? 0).toString());
      const inRange = liquidity.gt(0);
      const bPerA = clmmPriceBPerA(st.sqrtPriceX64, decA, decB);
      // Price of the asset in anchor units.
      const assetInAnchor = assetIsA ? bPerA : (bPerA.gt(0) ? new Decimal(1).div(bPerA) : null);
      if (!assetInAnchor) return null;
      return {
        poolId: pool.id, kind: 'clmm', anchorMint,
        anchorSymbol: anchorMint === WSOL_MINT ? 'SOL' : (anchorMint === USDC_MINT ? 'USDC' : 'USDT'),
        priceUsd: assetInAnchor.mul(anchorPrice),
        // CLMM depth: Raydium's TVL for the pool. Filter-only; see header.
        liquidityUsd: new Decimal(Number.isFinite(Number(pool.tvl)) ? Number(pool.tvl) : 0),
        inRange,
      };
    }
    // AMM v4 and CPMM both expose baseReserve/quoteReserve (verified
    // against AmmRpcData and CpmmRpcData in the SDK types) but decode from
    // different layouts, so each gets its own reader.
    const reader = readerKind === 'cpmm' ? (readCpmm || readStandard) : readStandard;
    const st = await reader(pool.id);
    if (!st) return null;
    const baseRes = st.baseReserve ?? st.mintAmountA; const quoteRes = st.quoteReserve ?? st.mintAmountB;
    if (baseRes === undefined || quoteRes === undefined) return null;
    const bPerA = reservePriceQuotePerBase(baseRes, quoteRes, decA, decB);
    if (!bPerA) return null;
    const assetInAnchor = assetIsA ? bPerA : new Decimal(1).div(bPerA);
    const anchorReserveWhole = new Decimal((assetIsA ? quoteRes : baseRes).toString())
      .div(new Decimal(10).pow(assetIsA ? decB : decA));
    return {
      poolId: pool.id, kind: readerKind === 'cpmm' ? 'cpmm' : 'standard', anchorMint,
      anchorSymbol: anchorMint === WSOL_MINT ? 'SOL' : (anchorMint === USDC_MINT ? 'USDC' : 'USDT'),
      priceUsd: assetInAnchor.mul(anchorPrice),
      // Constant-product depth, fully on-chain: anchor-side reserve is half
      // the pool's value at the current price.
      liquidityUsd: anchorReserveWhole.mul(anchorPrice).mul(2),
      inRange: new Decimal(baseRes.toString()).gt(0) && new Decimal(quoteRes.toString()).gt(0),
    };
  } catch (e) {
    console.warn(`on-chain price: could not read pool ${pool.id}: ${e.message}`);
    return null;
  }
}

/**
 * Top-level: price `mint` from its on-chain pools.
 *
 * deps:
 *   fetchPoolsByMints(mint1, mint2) -> pool-index items (see evaluatePool)
 *   readClmm(poolId)     -> { sqrtPriceX64, liquidity }
 *   readStandard(poolId) -> { baseReserve, quoteReserve }   (AMM v4 / stable)
 *   readCpmm(poolId)     -> { baseReserve, quoteReserve }   (CPMM; falls back to readStandard if absent)
 *
 * Resolves { priceUsd, poolId, anchorSymbol, kind, liquidityUsd, spreadPct,
 * qualifyingCount, discoveredCount }. Throws with `code`:
 *   'NO_POOLS'       — nothing paired with a trusted anchor
 *   'NO_LIQUID_POOL' — pools exist but none has >= minLiquidityUsd in range
 *   'POOL_SPREAD'    — qualifying pools disagree beyond maxSpreadPct
 */
export async function getOnChainPriceUsd({
  mint, solUsd, deps,
  minLiquidityUsd = MIN_LIQUIDITY_USD,
  maxSpreadPct = MAX_POOL_SPREAD_PCT,
}) {
  const { fetchPoolsByMints, readClmm, readStandard, readCpmm } = deps;
  const discovered = [];
  for (const anchor of [WSOL_MINT, USDC_MINT, USDT_MINT]) {
    try {
      const list = await fetchPoolsByMints(mint, anchor);
      for (const p of list || []) if (p && p.id) discovered.push(p);
    } catch (e) {
      console.warn(`on-chain price: pool discovery against ${anchor} failed: ${e.message}`);
    }
  }
  // Dedupe by pool id (the same pool can be listed under two anchors' queries).
  const seen = new Set();
  const unique = discovered.filter((p) => (seen.has(p.id) ? false : (seen.add(p.id), true)));

  if (unique.length === 0) {
    const err = new Error(`No on-chain Raydium pool pairs ${mint} with SOL, USDC, or USDT`);
    err.code = 'NO_POOLS';
    throw err;
  }

  const candidates = [];
  for (const p of unique) {
    const c = await evaluatePool(p, { mint, solUsd, readClmm, readStandard, readCpmm });
    if (c) candidates.push(c);
  }

  const sel = selectBestPool(candidates, { minLiquidityUsd });
  if (!sel) {
    const inRangeButThin = candidates.filter((c) => c.inRange).length;
    const err = new Error(
      `Found ${unique.length} on-chain pool(s) for ${mint}, but none has at least ` +
      `$${minLiquidityUsd} of liquidity in range at the current price` +
      (inRangeButThin ? ` (${inRangeButThin} in range but too thin)` : ' (none in range)') +
      '. A price from a pool that thin is the last small trade, not a rate.',
    );
    err.code = 'NO_LIQUID_POOL';
    err.discoveredCount = unique.length;
    throw err;
  }

  if (sel.spreadPct.gt(maxSpreadPct)) {
    const err = new Error(
      `On-chain pools for ${mint} disagree on price: the deepest pool ` +
      `(${sel.best.anchorSymbol} pair, $${sel.best.liquidityUsd.toFixed(0)} deep) is ` +
      `${sel.spreadPct.toFixed(1)}% from the median of ${sel.qualifying.length} qualifying ` +
      `pools (limit ${maxSpreadPct}%). No single number is a safe launch reference ` +
      'while the market itself is this inconsistent.',
    );
    err.code = 'POOL_SPREAD';
    err.spreadPct = Number(sel.spreadPct.toString());
    throw err;
  }

  return {
    priceUsd: sel.best.priceUsd,
    poolId: sel.best.poolId,
    anchorSymbol: sel.best.anchorSymbol,
    kind: sel.best.kind,
    liquidityUsd: sel.best.liquidityUsd,
    spreadPct: sel.spreadPct,
    qualifyingCount: sel.qualifying.length,
    discoveredCount: unique.length,
  };
}
