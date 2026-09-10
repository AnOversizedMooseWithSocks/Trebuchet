// test/on-chain-price.test.mjs
//
// Every branch of onChainPriceService.js, offline. The adapters that talk
// to the SDK are injected, so each test builds exactly the set of pools it
// needs and asserts on which one sets the price and why.

import test from 'node:test';
import assert from 'node:assert/strict';
import Decimal from 'decimal.js';
import {
  getOnChainPriceUsd, selectBestPool, evaluatePool,
  clmmPriceBPerA, reservePriceQuotePerBase,
  WSOL_MINT, USDC_MINT, MIN_LIQUIDITY_USD,
} from '../onChainPriceService.js';

const ASSET = '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr';
const SOL_USD = new Decimal(200);
const TWO64 = new Decimal(2).pow(64);

// sqrtPriceX64 for a given whole-unit price B-per-A and decimals.
function sqrtX64For(priceBPerA, decA, decB) {
  const raw = new Decimal(priceBPerA).mul(new Decimal(10).pow(decB - decA));
  return raw.sqrt().mul(TWO64).toFixed(0);
}

function clmmPool({ id, assetIsA = true, anchor = WSOL_MINT, anchorDec = 9, tvl }) {
  return {
    id, type: 'Concentrated',
    mintA: assetIsA ? { address: ASSET, decimals: 6 } : { address: anchor, decimals: anchorDec },
    mintB: assetIsA ? { address: anchor, decimals: anchorDec } : { address: ASSET, decimals: 6 },
    tvl,
  };
}
function stdPool({ id, assetIsA = true, anchor = WSOL_MINT, anchorDec = 9 }) {
  return { ...clmmPool({ id, assetIsA, anchor, anchorDec }), type: 'Standard' };
}

// --- math ---------------------------------------------------------------------

test('clmmPriceBPerA round-trips a known price', () => {
  // asset (6 dec) priced at 0.002 SOL (9 dec)
  const p = clmmPriceBPerA(sqrtX64For(0.002, 6, 9), 6, 9);
  assert.ok(p.sub(0.002).abs().lt(1e-9), `got ${p}`);
});

test('reservePriceQuotePerBase computes whole-unit price and rejects empty base', () => {
  // 1,000 asset (6 dec) vs 2 SOL (9 dec) -> 0.002 SOL per asset
  const p = reservePriceQuotePerBase('1000000000', '2000000000', 6, 9);
  assert.equal(p.toString(), '0.002');
  assert.equal(reservePriceQuotePerBase('0', '2000000000', 6, 9), null);
});

// --- selection ---------------------------------------------------------------

const cand = (o) => ({
  poolId: o.id, anchorMint: WSOL_MINT, anchorSymbol: 'SOL', kind: 'clmm',
  priceUsd: new Decimal(o.price), liquidityUsd: new Decimal(o.liq), inRange: o.inRange ?? true,
});

test('the deepest in-range pool sets the price', () => {
  const sel = selectBestPool([
    cand({ id: 'dust', price: 9.0, liq: 20 }),
    cand({ id: 'real', price: 0.40, liq: 50_000 }),
    cand({ id: 'mid', price: 0.41, liq: 5_000 }),
  ]);
  assert.equal(sel.best.poolId, 'real');
  assert.equal(sel.qualifying.length, 2, 'dust pool excluded by the $100 floor');
});

test('an out-of-range pool never sets the price, however deep it is', () => {
  const sel = selectBestPool([
    cand({ id: 'deep-but-empty', price: 5.0, liq: 1_000_000, inRange: false }),
    cand({ id: 'small-live', price: 0.40, liq: 500 }),
  ]);
  assert.equal(sel.best.poolId, 'small-live');
});

test('nothing qualifies -> null (caller turns this into a typed error)', () => {
  assert.equal(selectBestPool([cand({ id: 'x', price: 1, liq: 5 })]), null);
  assert.equal(selectBestPool([]), null);
  assert.equal(selectBestPool([cand({ id: 'x', price: 1, liq: 500, inRange: false })]), null);
});

test('spread is measured deepest-vs-median so one deep outlier is caught', () => {
  const sel = selectBestPool([
    cand({ id: 'deep', price: 1.00, liq: 100_000 }),
    cand({ id: 'a', price: 0.50, liq: 10_000 }),
    cand({ id: 'b', price: 0.50, liq: 10_000 }),
  ]);
  assert.equal(sel.best.poolId, 'deep');
  assert.equal(sel.spreadPct.toFixed(0), '100', 'deepest is 100% off the 0.50 median');
});

// --- evaluation --------------------------------------------------------------

test('evaluatePool: CLMM, asset as mintA, SOL anchor', async () => {
  const c = await evaluatePool(clmmPool({ id: 'p', tvl: 40_000 }), {
    mint: ASSET, solUsd: SOL_USD,
    readClmm: async () => ({ sqrtPriceX64: sqrtX64For(0.002, 6, 9), liquidity: '12345' }),
    readStandard: async () => { throw new Error('not called'); },
  });
  assert.equal(c.kind, 'clmm');
  assert.equal(c.inRange, true);
  assert.ok(c.priceUsd.sub(0.4).abs().lt(1e-9), '0.002 SOL * $200 = $0.40');
  assert.equal(c.liquidityUsd.toString(), '40000');
});

test('evaluatePool: CLMM with zero active liquidity is out of range', async () => {
  const c = await evaluatePool(clmmPool({ id: 'p', tvl: 40_000 }), {
    mint: ASSET, solUsd: SOL_USD,
    readClmm: async () => ({ sqrtPriceX64: sqrtX64For(0.002, 6, 9), liquidity: '0' }),
    readStandard: async () => null,
  });
  assert.equal(c.inRange, false, 'TVL alone must not make an empty-at-price pool usable');
});

test('evaluatePool: CLMM with asset as mintB inverts the price', async () => {
  const c = await evaluatePool(clmmPool({ id: 'p', assetIsA: false, tvl: 1000 }), {
    mint: ASSET, solUsd: SOL_USD,
    // pool price is B-per-A = asset per SOL = 500 (i.e. 0.002 SOL per asset)
    readClmm: async () => ({ sqrtPriceX64: sqrtX64For(500, 9, 6), liquidity: '1' }),
    readStandard: async () => null,
  });
  assert.ok(c.priceUsd.sub(0.4).abs().lt(1e-6), `expected $0.40, got ${c.priceUsd}`);
});

test('evaluatePool: standard pool derives depth from the anchor reserve, on-chain', async () => {
  const c = await evaluatePool(stdPool({ id: 'p' }), {
    mint: ASSET, solUsd: SOL_USD,
    readClmm: async () => null,
    // 1,000 asset vs 2 SOL -> $0.40; depth = 2 SOL * $200 * 2 = $800
    readStandard: async () => ({ baseReserve: '1000000000', quoteReserve: '2000000000' }),
  });
  assert.equal(c.kind, 'standard');
  assert.equal(c.priceUsd.toString(), '0.4');
  assert.equal(c.liquidityUsd.toString(), '800');
  assert.equal(c.inRange, true);
});

test('evaluatePool: USDC anchor prices at $1 with no SOL dependency', async () => {
  const c = await evaluatePool(stdPool({ id: 'p', anchor: USDC_MINT, anchorDec: 6 }), {
    mint: ASSET, solUsd: null,
    readClmm: async () => null,
    readStandard: async () => ({ baseReserve: '1000000000', quoteReserve: '400000000' }),
  });
  assert.equal(c.priceUsd.toString(), '0.4');
  assert.equal(c.anchorSymbol, 'USDC');
});

test('evaluatePool: pools not paired with a trusted anchor are ignored', async () => {
  const other = { id: 'p', type: 'Standard',
    mintA: { address: ASSET, decimals: 6 }, mintB: { address: 'SomeOtherMint111111111111111111111111111111', decimals: 6 } };
  const c = await evaluatePool(other, { mint: ASSET, solUsd: SOL_USD, readClmm: async () => null, readStandard: async () => null });
  assert.equal(c, null);
});

test('evaluatePool: a pool that fails to read is skipped, not fatal', async () => {
  const c = await evaluatePool(clmmPool({ id: 'p', tvl: 1 }), {
    mint: ASSET, solUsd: SOL_USD,
    readClmm: async () => { throw new Error('rpc down'); },
    readStandard: async () => null,
  });
  assert.equal(c, null);
});

// --- end to end ---------------------------------------------------------------

function depsWith({ pools, clmm = {}, standard = {} }) {
  return {
    fetchPoolsByMints: async (m, anchor) => pools.filter((p) =>
      [p.mintA.address, p.mintB.address].includes(anchor)),
    readClmm: async (id) => clmm[id] ?? null,
    readStandard: async (id) => standard[id] ?? null,
  };
}

test('end to end: dust CLMM pool ignored, real standard SOL pool sets the price', async () => {
  const r = await getOnChainPriceUsd({
    mint: ASSET, solUsd: SOL_USD,
    deps: depsWith({
      pools: [clmmPool({ id: 'dust', tvl: 15 }), stdPool({ id: 'real' })],
      clmm: { dust: { sqrtPriceX64: sqrtX64For(9.0, 6, 9), liquidity: '1' } },
      standard: { real: { baseReserve: '1000000000', quoteReserve: '2000000000' } },
    }),
  });
  assert.equal(r.poolId, 'real');
  assert.equal(r.priceUsd.toString(), '0.4');
  assert.equal(r.discoveredCount, 2);
  assert.equal(r.qualifyingCount, 1);
});

test('end to end: the same pool discovered under two anchors is counted once', async () => {
  const p = stdPool({ id: 'one' });
  const r = await getOnChainPriceUsd({
    mint: ASSET, solUsd: SOL_USD,
    deps: {
      fetchPoolsByMints: async () => [p], // returned for every anchor query
      readClmm: async () => null,
      readStandard: async () => ({ baseReserve: '1000000000', quoteReserve: '2000000000' }),
    },
  });
  assert.equal(r.discoveredCount, 1);
});

test('end to end: no pools -> NO_POOLS', async () => {
  await assert.rejects(
    () => getOnChainPriceUsd({ mint: ASSET, solUsd: SOL_USD, deps: depsWith({ pools: [] }) }),
    (e) => e.code === 'NO_POOLS',
  );
});

test('end to end: only thin/out-of-range pools -> NO_LIQUID_POOL naming the counts', async () => {
  await assert.rejects(
    () => getOnChainPriceUsd({
      mint: ASSET, solUsd: SOL_USD,
      deps: depsWith({
        pools: [clmmPool({ id: 'a', tvl: 20 }), clmmPool({ id: 'b', tvl: 90_000 })],
        clmm: {
          a: { sqrtPriceX64: sqrtX64For(0.002, 6, 9), liquidity: '1' },
          b: { sqrtPriceX64: sqrtX64For(0.002, 6, 9), liquidity: '0' }, // deep but empty here
        },
      }),
    }),
    (e) => {
      assert.equal(e.code, 'NO_LIQUID_POOL');
      assert.match(e.message, /2 on-chain pool/);
      assert.match(e.message, /1 in range but too thin/);
      return true;
    },
  );
});

test('end to end: qualifying pools that disagree -> POOL_SPREAD', async () => {
  await assert.rejects(
    () => getOnChainPriceUsd({
      mint: ASSET, solUsd: SOL_USD,
      deps: depsWith({
        pools: [stdPool({ id: 'deep' }), stdPool({ id: 'a' }), stdPool({ id: 'b' })],
        standard: {
          deep: { baseReserve: '1000000000', quoteReserve: '4000000000' }, // $0.80, $1600 deep
          a:    { baseReserve: '1000000000', quoteReserve: '2000000000' }, // $0.40
          b:    { baseReserve: '1000000000', quoteReserve: '2000000000' }, // $0.40
        },
      }),
    }),
    (e) => e.code === 'POOL_SPREAD' && /disagree/.test(e.message),
  );
});

test('end to end: a discovery failure for one anchor does not abort the others', async () => {
  const r = await getOnChainPriceUsd({
    mint: ASSET, solUsd: SOL_USD,
    deps: {
      fetchPoolsByMints: async (m, anchor) => {
        if (anchor === WSOL_MINT) throw new Error('index timeout');
        return anchor === USDC_MINT ? [stdPool({ id: 'u', anchor: USDC_MINT, anchorDec: 6 })] : [];
      },
      readClmm: async () => null,
      readStandard: async () => ({ baseReserve: '1000000000', quoteReserve: '400000000' }),
    },
  });
  assert.equal(r.anchorSymbol, 'USDC');
  assert.equal(r.priceUsd.toString(), '0.4');
});

test('MIN_LIQUIDITY_USD is the product rule: $100', () => {
  assert.equal(MIN_LIQUIDITY_USD, 100);
});

// --- reader dispatch by program (audit finding) ------------------------------
// The pool index labels BOTH AMM v4 and CPMM pools as type "Standard", but
// they have different account layouts. Dispatch must go by programId.

import { poolReaderKind, RAYDIUM_PROGRAMS } from '../onChainPriceService.js';

test('poolReaderKind dispatches on programId, falling back to type only when absent', () => {
  assert.equal(poolReaderKind({ programId: RAYDIUM_PROGRAMS.CLMM, type: 'Standard' }), 'clmm',
    'programId beats a contradictory type label');
  assert.equal(poolReaderKind({ programId: RAYDIUM_PROGRAMS.CPMM, type: 'Standard' }), 'cpmm');
  assert.equal(poolReaderKind({ programId: RAYDIUM_PROGRAMS.AMM_V4, type: 'Standard' }), 'amm');
  assert.equal(poolReaderKind({ programId: RAYDIUM_PROGRAMS.AMM_STABLE }), 'amm');
  assert.equal(poolReaderKind({ programId: 'SomeOtherProgram1111111111111111111111111111' }), null,
    'an unknown program has no reader — skip, do not guess');
  assert.equal(poolReaderKind({ type: 'Concentrated' }), 'clmm', 'type fallback when programId absent');
  assert.equal(poolReaderKind({ type: 'Standard' }), 'amm');
});

test('a CPMM pool is read with the CPMM reader, never the AMM v4 one', async () => {
  let ammCalls = 0; let cpmmCalls = 0;
  const pool = { ...stdPool({ id: 'c' }), programId: RAYDIUM_PROGRAMS.CPMM };
  const c = await evaluatePool(pool, {
    mint: ASSET, solUsd: SOL_USD,
    readClmm: async () => null,
    readStandard: async () => { ammCalls += 1; return { baseReserve: '1', quoteReserve: '1' }; },
    readCpmm: async () => { cpmmCalls += 1; return { baseReserve: '1000000000', quoteReserve: '2000000000' }; },
  });
  assert.equal(cpmmCalls, 1);
  assert.equal(ammCalls, 0, 'decoding a CPMM account with the AMM v4 layout yields garbage');
  assert.equal(c.kind, 'cpmm');
  assert.equal(c.priceUsd.toString(), '0.4');
});

test('a pool from an unknown program is skipped rather than misread', async () => {
  const pool = { ...stdPool({ id: 'x' }), programId: 'SomeOtherProgram1111111111111111111111111111' };
  const c = await evaluatePool(pool, {
    mint: ASSET, solUsd: SOL_USD,
    readClmm: async () => { throw new Error('must not be called'); },
    readStandard: async () => { throw new Error('must not be called'); },
    readCpmm: async () => { throw new Error('must not be called'); },
  });
  assert.equal(c, null);
});
