import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Keypair } from '@solana/web3.js';

import {
  DEVNET_GENESIS_HASH,
  assertDevnetGenesisHash,
  decodeWalletSecret,
  parseMaxSpendSol,
  runDevnetTransactionE2E,
} from './e2e/devnet-transactions.mjs';

test('devnet wallet secrets decode only from a valid base64 64-byte JSON array', () => {
  const keypair = Keypair.fromSeed(Uint8Array.from({ length: 32 }, (_, index) => index + 1));
  const encoded = Buffer.from(JSON.stringify(Array.from(keypair.secretKey))).toString('base64');

  assert.deepEqual(decodeWalletSecret(encoded), keypair.secretKey);
  assert.throws(
    () => decodeWalletSecret(Buffer.from(JSON.stringify([1, 2, 3])).toString('base64')),
    /64 bytes/,
  );
  assert.throws(() => decodeWalletSecret('not-json'), /base64-encoded JSON/);
});

test('devnet transaction budget is narrowly bounded', () => {
  assert.equal(parseMaxSpendSol('0.03'), 0.03);
  assert.throws(() => parseMaxSpendSol('0.001'), /between 0.01 and 0.1 SOL/);
  assert.throws(() => parseMaxSpendSol('0.5'), /between 0.01 and 0.1 SOL/);
  assert.throws(() => parseMaxSpendSol('not-a-number'), /finite number/);
});

test('devnet transaction harness refuses every non-devnet genesis hash', () => {
  assert.doesNotThrow(() => assertDevnetGenesisHash(DEVNET_GENESIS_HASH));
  assert.throws(
    () => assertDevnetGenesisHash('5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'),
    /not Solana devnet/,
  );
});

test('devnet transaction harness skips without secrets unless explicitly required', async () => {
  assert.deepEqual(await runDevnetTransactionE2E({}), { skipped: true });
  await assert.rejects(
    runDevnetTransactionE2E({ TREBUCHET_DEVNET_REQUIRED: '1' }),
    /missing required devnet configuration/,
  );
});

test('devnet workflow is manual, protected, serialized, and never pull_request_target', () => {
  const workflow = readFileSync(
    new URL('../.github/workflows/devnet-e2e.yml', import.meta.url),
    'utf8',
  );
  assert.match(workflow, /\bworkflow_dispatch\s*:/);
  assert.doesNotMatch(workflow, /\bpull_request(?:_target)?\s*:/);
  assert.match(workflow, /\benvironment:\s*devnet-e2e\b/);
  assert.match(workflow, /\bconcurrency:\s*\n\s+group:\s*devnet-e2e-funded-wallet\b/);
  assert.match(workflow, /secrets\.DEVNET_FUNDING_WALLET_SECRET_B64/);
  assert.match(workflow, /secrets\.DEVNET_RPC_URL/);
  assert.match(workflow, /vars\.DEVNET_FUNDING_WALLET_PUBLIC_KEY/);
});
