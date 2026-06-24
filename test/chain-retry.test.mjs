// Unit tests for chainRetry.js — error classification and the retry loop.
// No chain, no SDK: send() is a stub, sleep is a no-op, so these are fast and
// deterministic.

import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyChainError, isInsufficientFunds, landTxWithRetry } from '../chainRetry.js';

const noSleep = () => Promise.resolve();

// ---- classifyChainError ----

test('classifies lamport shortfalls as insufficient_funds', () => {
  for (const msg of [
    'Transfer: insufficient lamports 100, need 5000',
    'Error: insufficient funds',
    'Attempt to debit an account but found no record of a prior credit.',
    'Transaction simulation failed: insufficient funds for rent',
    'custom program error: 0x1771',
  ]) {
    assert.equal(classifyChainError(new Error(msg)), 'insufficient_funds', msg);
    assert.equal(isInsufficientFunds(new Error(msg)), true, msg);
  }
});

test('classifies cluster/RPC weather as transient', () => {
  for (const msg of [
    'Blockhash not found',
    'TransactionExpiredBlockheightExceededError: block height exceeded',
    'Transaction was not confirmed in 30.00 seconds',
    'failed to get recent blockhash: 429 Too Many Requests',
    'fetch failed',
    'socket hang up',
    'Node is behind by 152 slots',
    'server responded with 503 Service Unavailable',
  ]) {
    assert.equal(classifyChainError(new Error(msg)), 'transient', msg);
  }
});

test('classifies everything else as deterministic', () => {
  for (const msg of [
    'account already in use',
    'invalid tick range',
    'Provided owner is not allowed',
    'custom program error: 0x1786',
  ]) {
    assert.equal(classifyChainError(new Error(msg)), 'deterministic', msg);
  }
  assert.equal(classifyChainError(null), 'deterministic');
  assert.equal(classifyChainError(undefined), 'deterministic');
});

test('reads error detail from nested fields (logs, cause, error.message)', () => {
  const withLogs = Object.assign(new Error('Transaction failed'), {
    logs: ['Program log: Error', 'Program log: insufficient lamports for transfer'],
  });
  assert.equal(classifyChainError(withLogs), 'insufficient_funds');

  const withCause = Object.assign(new Error('send failed'), {
    cause: new Error('Blockhash not found'),
  });
  assert.equal(classifyChainError(withCause), 'transient');

  const withErrField = Object.assign(new Error('rpc error'), {
    error: { message: 'Node is behind' },
  });
  assert.equal(classifyChainError(withErrField), 'transient');
});

// ---- landTxWithRetry ----

test('returns the value on first-try success without retrying', async () => {
  let calls = 0;
  const { value, skipped, attempts } = await landTxWithRetry({
    send: async () => { calls += 1; return 'ok'; },
    sleep: noSleep,
  });
  assert.equal(value, 'ok');
  assert.equal(skipped, false);
  assert.equal(attempts, 1);
  assert.equal(calls, 1);
});

test('retries a transient failure then succeeds', async () => {
  let calls = 0;
  const retries = [];
  const { value, attempts } = await landTxWithRetry({
    send: async () => {
      calls += 1;
      if (calls < 3) throw new Error('Blockhash not found');
      return 'landed';
    },
    onRetry: async (attempt) => retries.push(attempt),
    sleep: noSleep,
  });
  assert.equal(value, 'landed');
  assert.equal(attempts, 3);
  assert.equal(calls, 3);
  assert.deepEqual(retries, [1, 2]); // onRetry fires after attempts 1 and 2
});

test('does NOT retry an insufficient_funds failure', async () => {
  let calls = 0;
  await assert.rejects(
    landTxWithRetry({
      send: async () => { calls += 1; throw new Error('insufficient lamports'); },
      sleep: noSleep,
    }),
    (err) => { assert.equal(err.kind, 'insufficient_funds'); return true; },
  );
  assert.equal(calls, 1); // stopped immediately, no wasted attempts
});

test('does NOT retry a deterministic failure', async () => {
  let calls = 0;
  await assert.rejects(
    landTxWithRetry({
      send: async () => { calls += 1; throw new Error('account already in use'); },
      sleep: noSleep,
    }),
    (err) => { assert.equal(err.kind, 'deterministic'); return true; },
  );
  assert.equal(calls, 1);
});

test('exhausts retries on a persistent transient and rethrows tagged', async () => {
  let calls = 0;
  await assert.rejects(
    landTxWithRetry({
      send: async () => { calls += 1; throw new Error('fetch failed'); },
      maxAttempts: 3,
      sleep: noSleep,
    }),
    (err) => { assert.equal(err.kind, 'transient'); return true; },
  );
  assert.equal(calls, 3);
});

test('alreadyDone short-circuits without sending (idempotency)', async () => {
  let calls = 0;
  const { skipped, value, attempts } = await landTxWithRetry({
    alreadyDone: async () => true,
    send: async () => { calls += 1; return 'should-not-run'; },
    sleep: noSleep,
  });
  assert.equal(skipped, true);
  assert.equal(value, null);
  assert.equal(attempts, 0);
  assert.equal(calls, 0); // never sent — prevents double-mint on a landed-but-threw tx
});

test('a throwing alreadyDone is treated as "not done" and the send proceeds', async () => {
  let calls = 0;
  const { skipped, value } = await landTxWithRetry({
    alreadyDone: async () => { throw new Error('mock connection has no getMint'); },
    send: async () => { calls += 1; return 'sent'; },
    sleep: noSleep,
  });
  assert.equal(skipped, false);
  assert.equal(value, 'sent');
  assert.equal(calls, 1); // defensive: unknown state -> proceed, matches today's behavior
});

test('alreadyDone re-checked between retries adopts a tx that landed mid-retry', async () => {
  let calls = 0;
  let landed = false;
  const { skipped, attempts } = await landTxWithRetry({
    alreadyDone: async () => landed,
    send: async () => {
      calls += 1;
      // First attempt "lands" on-chain but throws a confirm timeout. On the
      // next loop, alreadyDone sees it and skips re-sending.
      landed = true;
      throw new Error('Transaction was not confirmed in 30s');
    },
    sleep: noSleep,
  });
  assert.equal(skipped, true);
  assert.equal(calls, 1);   // sent once; the retry was short-circuited by the guard
  assert.equal(attempts, 1);
});
