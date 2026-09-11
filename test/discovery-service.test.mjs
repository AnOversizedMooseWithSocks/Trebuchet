import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDiscoveryRecord,
  discoveryRpcCandidates,
  fetchDiscoveryMarketData,
  isMissingMintRpcError,
  parseDiscoveryMarketPool,
  parseDiscoveryOhlcv,
} from '../discoveryService.js';

const MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

test('discovery prefers a saved mainnet RPC when the active launch RPC is devnet', () => {
  const candidates = discoveryRpcCandidates({
    active: 'https://api.devnet.solana.com',
    saved: [
      { name: 'Public devnet', url: 'https://api.devnet.solana.com' },
      { name: 'Dedicated mainnet', url: 'https://mainnet.example.test' },
    ],
  });

  assert.equal(candidates[0].name, 'Dedicated mainnet');
  assert.equal(candidates[1].name, 'Public devnet');
});

test('discovery classifies missing mint RPC failures separately from upstream outages', () => {
  assert.equal(isMissingMintRpcError(new Error('Invalid param: could not find account')), true);
  assert.equal(isMissingMintRpcError(new Error(`Mint ${MINT} not found on-chain`)), true);
  assert.equal(isMissingMintRpcError(new Error('429 Too Many Requests')), false);
});

test('buildDiscoveryRecord turns live RPC facts into a ready evidence record', () => {
  const record = buildDiscoveryRecord({
    mint: MINT,
    metadata: {
      name: 'USD Coin',
      symbol: 'USDC',
      decimals: 6,
      priceUsd: '1.00',
      imageUrl: 'https://example.com/usdc.png',
    },
    compatibility: {
      compatible: true,
      isToken2022: false,
      extensions: [],
      disallowedNames: [],
      mintAuthorityRenounced: true,
      freezeAuthorityDisabled: true,
    },
    supply: { amount: '1000000000', decimals: 6, uiAmountString: '1000' },
    largestAccounts: [
      { amount: '100000000' },
      { amount: '50000000' },
      { amount: '25000000' },
    ],
    journal: {
      id: 'journal-1',
      status: 'completed',
      updatedAt: '2026-07-14T10:00:00.000Z',
      walletPublicKey: 'Wallet111',
      report: { jsonUri: 'https://arweave.net/report' },
    },
    inspectedAt: '2026-07-14T12:00:00.000Z',
    rpcName: 'Dedicated mainnet',
  });

  assert.equal(record.id, MINT);
  assert.equal(record.symbol, 'USDC');
  assert.equal(record.status, 'Ready');
  assert.equal(record.confidence, 'High');
  assert.equal(record.metrics.topTenPercent, 17.5);
  assert.equal(record.journal.status, 'completed');
  assert.match(record.source, /Dedicated mainnet/);
  assert.equal(record.evidence.find((row) => row.label === 'Mint authority').state, 'pass');
  assert.doesNotThrow(() => JSON.stringify(record));
});

test('buildDiscoveryRecord stays honest when authority and concentration evidence are risky', () => {
  const record = buildDiscoveryRecord({
    mint: MINT,
    metadata: { symbol: 'RISK', decimals: 6, priceUsd: null },
    compatibility: {
      compatible: false,
      isToken2022: true,
      extensions: ['TransferFeeConfig'],
      disallowedNames: ['TransferFeeConfig'],
      mintAuthorityRenounced: false,
      freezeAuthorityDisabled: false,
    },
    supply: { amount: '1000', decimals: 6, uiAmountString: '0.001' },
    largestAccounts: [{ amount: '900' }],
  });

  assert.equal(record.status, 'Watch');
  assert.equal(record.metrics.topTenPercent, 90);
  assert.equal(record.metrics.program, 'Token-2022');
  assert.equal(record.evidence.find((row) => row.label === 'Raydium CLMM compatibility').value, 'Blocked');
  assert.equal(record.evidence.find((row) => row.label === 'Top 10 token accounts').state, 'warn');
  assert.match(record.summary, /needs review/);
});

test('buildDiscoveryRecord labels unavailable evidence instead of inventing metrics', () => {
  const record = buildDiscoveryRecord({
    mint: MINT,
    supply: { amount: '1000000', decimals: 6, uiAmountString: '1' },
    largestAccounts: null,
    warnings: ['RPC concentration lookup failed'],
  });

  assert.equal(record.metrics.supply, '1');
  assert.equal(record.metrics.topTenPercent, null);
  assert.equal(record.priceUsd, null);
  assert.equal(record.journal, null);
  assert.deepEqual(record.warnings, ['RPC concentration lookup failed']);
  assert.equal(record.evidence.find((row) => row.label === 'Top 10 token accounts').value, 'Unavailable');
});

test('Brand Shield classifications override generic evidence status and cap the score', () => {
  const record = buildDiscoveryRecord({
    mint: MINT,
    metadata: { name: 'Copied Token', symbol: 'COPY', decimals: 9, priceUsd: '1' },
    compatibility: {
      compatible: true,
      mintAuthorityRenounced: true,
      freezeAuthorityDisabled: true,
    },
    supply: { amount: '1000000000', decimals: 9, uiAmountString: '1' },
    largestAccounts: [{ amount: '100000000' }],
    brandAssessment: {
      classification: 'Counterfeit',
      risk: 'critical',
      official: false,
      scoreCap: 15,
      matchedMint: 'OfficialMint111',
      evidence: [{ id: 'metadata-uri-reuse', severity: 'critical', detail: 'Exact URI reused.' }],
    },
  });

  assert.equal(record.status, 'Counterfeit');
  assert.equal(record.score, 15);
  assert.equal(record.brand.matchedMint, 'OfficialMint111');
  assert.equal(record.evidence[0].label, 'Identity provenance');
  assert.equal(record.evidence[0].state, 'danger');
});

test('parseDiscoveryMarketPool selects the requested token side and exposes useful pool metrics', () => {
  const market = parseDiscoveryMarketPool(MINT, {
    data: [{
      id: 'solana_Pool111',
      attributes: {
        address: 'Pool111',
        name: 'USDC / SOL',
        base_token_price_usd: '1.0004',
        quote_token_price_usd: '185.12',
        reserve_in_usd: '2400000',
        fdv_usd: '52000000000',
        market_cap_usd: '51000000000',
        price_change_percentage: { h1: '0.02', h24: '-0.11' },
        volume_usd: { h24: '930000' },
        transactions: { h24: { buys: 120, sells: 80, buyers: 92, sellers: 67 } },
        pool_created_at: '2023-01-01T00:00:00.000Z',
      },
      relationships: {
        base_token: { data: { id: `solana_${MINT}` } },
        quote_token: { data: { id: 'solana_So11111111111111111111111111111111111111112' } },
        dex: { data: { id: 'raydium-clmm' } },
      },
    }],
  });

  assert.equal(market.priceUsd, 1.0004);
  assert.equal(market.priceChange.h24, -0.11);
  assert.equal(market.liquidityUsd, 2400000);
  assert.equal(market.volume24hUsd, 930000);
  assert.equal(market.transactions24h.buys, 120);
  assert.equal(market.pool.dex, 'raydium-clmm');
});

test('parseDiscoveryOhlcv normalizes chronological 4-hour candles and derives the 7-day range', () => {
  const history = parseDiscoveryOhlcv({
    data: {
      attributes: {
        ohlcv_list: [
          [200, 1.1, 1.4, 1.0, 1.3, 80],
          [100, 1.0, 1.2, 0.9, 1.1, 20],
        ],
      },
    },
  });

  assert.equal(history.points.length, 2);
  assert.equal(history.points[0].open, 1);
  assert.equal(history.points[1].close, 1.3);
  assert.equal(history.highUsd, 1.4);
  assert.equal(history.lowUsd, 0.9);
  assert.equal(history.volumeUsd, 100);
  assert.ok(Math.abs(history.changePercent - 30) < 1e-10);
});

test('fetchDiscoveryMarketData joins the top pool snapshot with address-oriented OHLCV', async () => {
  const urls = [];
  const fetchImpl = async (input) => {
    const url = String(input);
    urls.push(url);
    if (url.includes('/ohlcv/hour')) {
      return {
        ok: true,
        json: async () => ({
          data: {
            attributes: {
              ohlcv_list: [
                [100, 1, 1.2, 0.9, 1.1, 20],
                [200, 1.1, 1.3, 1.0, 1.2, 30],
              ],
            },
          },
        }),
      };
    }
    return {
      ok: true,
      json: async () => ({
        data: [{
          id: 'solana_Pool222',
          attributes: {
            address: 'Pool222',
            base_token_price_usd: '1.2',
            reserve_in_usd: '250000',
            volume_usd: { h24: '42000' },
            price_change_percentage: { h24: '4.2' },
          },
          relationships: {
            base_token: { data: { id: `solana_${MINT}` } },
            quote_token: { data: { id: 'solana_Quote111' } },
          },
        }],
      }),
    };
  };

  const market = await fetchDiscoveryMarketData(MINT, { fetchImpl });

  assert.equal(urls.length, 2);
  assert.match(urls[0], new RegExp(`/tokens/${MINT}/pools`));
  assert.match(urls[1], /token=EPjFWdd5/);
  assert.equal(market.history.points.length, 2);
  assert.equal(market.url, 'https://www.geckoterminal.com/solana/pools/Pool222');
});
