import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDiscoveryRecord,
  discoveryRpcCandidates,
  isMissingMintRpcError,
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
