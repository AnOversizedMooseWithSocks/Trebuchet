// test/sdk-surface.test.mjs
//
// Asserts, against the REAL Raydium SDK, that every method this app reads
// off it by name actually exists. Every other test injects fakes shaped by
// our own assumptions — which is precisely why a renamed SDK method would
// pass the whole suite and then fail quietly in production ("x is not a
// function", caught, logged at warn, fallback source used, app looks
// healthy). Raydium.load with a stub connection needs no network.

import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import { Raydium } from '@raydium-io/raydium-sdk-v2';
import { onChainPriceDeps } from '../lpService.js';

const stubConnection = {
  rpcEndpoint: 'http://127.0.0.1:1',
  getEpochInfo: async () => ({ epoch: 1 }),
  getAccountInfo: async () => null,
};

async function loadReal() {
  return Raydium.load({
    owner: Keypair.generate(), connection: stubConnection, cluster: 'mainnet',
    disableFeatureCheck: true, disableLoadToken: true, blockhashCommitment: 'finalized',
  });
}

// Every SDK method the app calls, grouped by the code that calls it.
const REQUIRED = {
  'on-chain price discovery (onChainPriceDeps)': [
    'api.fetchPoolByMints', 'clmm.getRpcClmmPoolInfo', 'liquidity.getRpcPoolInfos', 'cpmm.getRpcPoolInfos',
  ],
  'pool creation and positions (createSinglePool)': [
    'clmm.createPool', 'clmm.getPoolInfoFromRpc', 'clmm.openPositionFromBase', 'clmm.lockPosition',
  ],
  'retry / resume probes (fetchOwnerClmmPositionsForPool)': ['clmm.getOwnerPositionInfo'],
  'fee tiers': ['api.getClmmConfigs'],
  'token account cache refresh': ['account.fetchWalletTokenAccounts'],
};

const get = (obj, dotted) => dotted.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

test('the real SDK exposes every method the app calls by name', async () => {
  const raydium = await loadReal();
  const missing = [];
  for (const [where, methods] of Object.entries(REQUIRED)) {
    for (const m of methods) {
      if (typeof get(raydium, m) !== 'function') missing.push(`${m} (used by: ${where})`);
    }
  }
  assert.deepEqual(missing, [], 'SDK surface changed — these methods are gone or renamed');
});

test('onChainPriceDeps accepts the real SDK without a surface error', async () => {
  const raydium = await loadReal();
  assert.doesNotThrow(() => onChainPriceDeps(raydium));
});

test('onChainPriceDeps refuses an SDK missing the discovery method, LOUDLY', () => {
  // This is the exact shape the E2E harness fake used to have. The failure
  // must be unmistakable, not a per-anchor "discovery failed" warning.
  const stale = { api: { getClmmConfigs: async () => [] }, clmm: {}, liquidity: {}, cpmm: {} };
  assert.throws(() => onChainPriceDeps(stale), /SDK SURFACE MISMATCH[\s\S]*api\.fetchPoolByMints/);
});
