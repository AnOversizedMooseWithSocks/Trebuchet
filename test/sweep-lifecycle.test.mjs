// test/sweep-lifecycle.test.mjs
//
// Offline integration tests for walletHelpers.js sweep functions, driven
// through DI seams with NO network.
//
// Covers issue #4 acceptance criteria for the sweep/recovery leg:
//   - sweepSolToDestination: SOL dust threshold, rent-exemption safeguard
//   - sweepAllTokensToDestination: fail-soft, partial transfers collected
//   - Recovery invariants: after a partial sweep failure, recoverable state
//     is correctly reported (errors list, transferred list)

import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';

import * as walletHelpers from '../walletHelpers.js';
import { makeFakeConnection, makeFakeTokenAccountEntry } from './helpers/mockSolana.mjs';

const DEST_WALLET = 'So11111111111111111111111111111111111111112';

test.afterEach(() => {
  walletHelpers.resetConnectionFactoryForTests?.();
});

// ---------------------------------------------------------------------------
// Sweep SOL — dust threshold
// ---------------------------------------------------------------------------

test('sweepSolToDestination: transfers SOL above rent exemption', async () => {
  const solBalance = 0.5 * LAMPORTS_PER_SOL;
  const rentExemption = 890_880;

  walletHelpers.setConnectionFactoryForTests(() =>
    makeFakeConnection({
      getBalance: async () => solBalance,
      getMinimumBalanceForRentExemption: async () => rentExemption,
    }),
  );

  const kp = Keypair.generate();
  const result = await walletHelpers.sweepSolToDestination({
    tempWalletSecretKey: Array.from(kp.secretKey),
    destinationWallet: DEST_WALLET,
  });

  assert.ok(result.txId, 'txId should be returned');
  // Reserve = 5000 base fee + priority fee + flat safety pad. The fake
  // connection has no getRecentPrioritizationFees, so the sampler falls
  // back to the 50k uL/CU floor: ceil(20_000 CU * 50_000 uL / 1e6) = 1000,
  // plus SWEEP_FEE_PAD_LAMPORTS (10_000) = 16_000 total on top of rent.
  const expectedLamports = solBalance - rentExemption - 16_000;
  assert.equal(
    result.solTransferred,
    expectedLamports / LAMPORTS_PER_SOL,
    'transfers all SOL above rent + fee cushion',
  );
});

// ---------------------------------------------------------------------------
// Sweep SOL — below dust, no transfer needed
// ---------------------------------------------------------------------------

test('sweepSolToDestination: no transfer when balance <= rent + fee cushion', async () => {
  walletHelpers.setConnectionFactoryForTests(() =>
    makeFakeConnection({
      getBalance: async () => 890_880,
      getMinimumBalanceForRentExemption: async () => 890_880,
    }),
  );

  const kp = Keypair.generate();
  const result = await walletHelpers.sweepSolToDestination({
    tempWalletSecretKey: Array.from(kp.secretKey),
    destinationWallet: DEST_WALLET,
  });

  assert.equal(result.solTransferred, 0, 'no SOL transferred when at dust');
  assert.equal(result.txId, undefined, 'no txId when nothing transferred');
});

// ---------------------------------------------------------------------------
// Fail-soft: partial sweep — one transfer fails, others continue.
// Mock getParsedTokenAccountsByOwner to return two fungible token accounts,
// and make sendTransaction fail on the first call so the first transfer
// errors out while the second succeeds.
// ---------------------------------------------------------------------------

test('sweepAllTokensToDestination: fail-soft — one transfer fails, the other succeeds, errors collected', async () => {
  const kp = Keypair.generate();
  const ownerPk = kp.publicKey.toBase58();

  const mintA = '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr'; // valid base58, not a real mint
  const mintB = '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R';

  let sendCalls = 0;
  walletHelpers.setConnectionFactoryForTests(() =>
    makeFakeConnection({
      getBalance: async () => 1_000_000,
      getParsedTokenAccountsByOwner: async () => ({
        value: [
          makeFakeTokenAccountEntry({
            mint: mintA, owner: ownerPk,
            programId: TOKEN_PROGRAM_ID, amount: '500000', decimals: 6,
          }),
          makeFakeTokenAccountEntry({
            mint: mintB, owner: ownerPk,
            programId: TOKEN_PROGRAM_ID, amount: '200000', decimals: 3,
          }),
        ],
      }),
      getTokenAccountsByOwner: async () => ({ value: [] }),
      sendTransaction: async () => {
        sendCalls += 1;
        if (sendCalls === 1) {
          throw new Error('RPC timeout during sweep');
        }
        return `sweep-tx-${sendCalls}`;
      },
    }),
  );

  const result = await walletHelpers.sweepAllTokensToDestination({
    tempWalletSecretKey: Array.from(kp.secretKey),
    destinationWallet: DEST_WALLET,
    excludeMints: [],
  });

  // One transfer succeeded, one failed → errors collected, not thrown.
  assert.equal(result.transferred.length, 1, 'one token transferred successfully');
  assert.equal(result.errors.length, 1, 'one transfer error collected');
  assert.match(result.errors[0].error, /RPC timeout/);

  // The error entry names the mint so the caller knows what to retry.
  assert.ok(result.errors[0].mint, 'error entry names the mint');
  assert.equal(result.errors[0].mint, mintA, 'first mint (the one that failed) is recorded');
  assert.equal(result.transferred[0].mint, mintB, 'second mint succeeded');
});

// ---------------------------------------------------------------------------
// DI seam hygiene
// ---------------------------------------------------------------------------

test('walletHelpers exposes DI seams without affecting production defaults', () => {
  assert.equal(typeof walletHelpers.setConnectionFactoryForTests, 'function');
  assert.equal(typeof walletHelpers.resetConnectionFactoryForTests, 'function');
  assert.doesNotThrow(() => walletHelpers.resetConnectionFactoryForTests());
});
