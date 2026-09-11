import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';

import {
  registerWallet,
  handleCheckBalance,
  handleCheckBalanceDetailed,
  handleCreateToken,
  handleStatus,
  handleFindFunder,
  handleRpcHealth,
  handleInjectFunds,
  handleRetryAirdrop,
  handleResumeLaunch,
} from '../demoChainService.js';

function mockReq(body = {}, query = {}, path = '/') {
  return { body, query, path, get: () => undefined };
}

function mockRes() {
  const res = { _status: 200, _json: null, _ended: false };
  res.status = (code) => { res._status = code; return res; };
  res.json = (data) => { res._json = data; res._ended = true; };
  return res;
}

// ---------------------------------------------------------------------------
// registerWallet + lazy-init
// ---------------------------------------------------------------------------

test('registerWallet creates empty wallet with zero balances', () => {
  const kp = Keypair.generate();
  const pk = kp.publicKey.toBase58();
  registerWallet(pk);

  const res = mockRes();
  handleCheckBalance(mockReq({ publicKey: pk }), res);
  assert.equal(res._json.success, true);
  assert.equal(res._json.balance, 0);
});

test('lazy-init: unknown wallet returns 0 balance without crashing', () => {
  const pk = Keypair.generate().publicKey.toBase58();
  const res = mockRes();
  handleCheckBalance(mockReq({ publicKey: pk }), res);
  assert.equal(res._json.success, true);
  assert.equal(res._json.balance, 0);
});

test('handleCheckBalanceDetailed returns empty tokens map for new wallet', () => {
  const pk = Keypair.generate().publicKey.toBase58();
  const res = mockRes();
  handleCheckBalanceDetailed(mockReq({ publicKey: pk }), res);
  assert.equal(res._json.success, true);
  assert.equal(res._json.balance.sol, 0);
  assert.deepEqual(res._json.balance.tokens, {});
});

test('registerWallet resets an existing wallet to empty state', () => {
  const pk = Keypair.generate().publicKey.toBase58();
  registerWallet(pk);

  handleInjectFunds(mockReq({ publicKey: pk, sol: 5 }), mockRes());
  const b1 = mockRes(); handleCheckBalance(mockReq({ publicKey: pk }), b1);
  assert.equal(b1._json.balance, 5);

  registerWallet(pk);
  const b2 = mockRes(); handleCheckBalance(mockReq({ publicKey: pk }), b2);
  assert.equal(b2._json.balance, 0, 're-register should reset to empty');
});

// ---------------------------------------------------------------------------
// handleStatus / handleFindFunder / handleRpcHealth
// ---------------------------------------------------------------------------

test('handleStatus reflects active flag', () => {
  const r1 = mockRes(); handleStatus(mockReq(), r1, { active: true });
  assert.equal(r1._json.active, true);
  const r2 = mockRes(); handleStatus(mockReq(), r2, { active: false });
  assert.equal(r2._json.active, false);
});

test('handleFindFunder returns null (no real history in demo)', () => {
  const res = mockRes();
  handleFindFunder(mockReq(), res);
  assert.equal(res._json.success, true);
  assert.equal(res._json.result, null);
});

test('handleRpcHealth reports good health with 0ms latency', () => {
  const res = mockRes();
  handleRpcHealth(mockReq(), res);
  assert.equal(res._json.health, 'good');
  assert.equal(res._json.latencyMs, 0);
});

test('handleCreateToken synthesizes demo vanity mints with start and end targets', async () => {
  const kp = Keypair.generate();
  const res = mockRes();
  await handleCreateToken(mockReq({
    tempWalletSecretKey: Array.from(kp.secretKey),
    name: 'Demo Vanity',
    symbol: 'DVN',
    totalSupply: 1000,
    vanityPrefix: 'MO',
    vanitySuffix: 'ON',
  }), res);

  assert.equal(res._json.success, true);
  assert.match(res._json.tokenMint, /^MO/);
  assert.match(res._json.tokenMint, /ON$/);
});

// ---------------------------------------------------------------------------
// handleInjectFunds
// ---------------------------------------------------------------------------

test('handleInjectFunds sets SOL balance exactly (idempotent)', () => {
  const pk = Keypair.generate().publicKey.toBase58();
  registerWallet(pk);

  handleInjectFunds(mockReq({ publicKey: pk, sol: 2.5 }), mockRes());
  const b1 = mockRes(); handleCheckBalance(mockReq({ publicKey: pk }), b1);
  assert.equal(b1._json.balance, 2.5);

  handleInjectFunds(mockReq({ publicKey: pk, sol: 3 }), mockRes());
  const b2 = mockRes(); handleCheckBalance(mockReq({ publicKey: pk }), b2);
  assert.equal(b2._json.balance, 3, 'second inject should set, not add');
});

test('handleInjectFunds ignores negative sol (balance stays at previous value)', () => {
  const pk = Keypair.generate().publicKey.toBase58();
  registerWallet(pk);

  handleInjectFunds(mockReq({ publicKey: pk, sol: -1 }), mockRes());
  const b = mockRes(); handleCheckBalance(mockReq({ publicKey: pk }), b);
  assert.equal(b._json.balance, 0, 'negative sol should not set balance');
});

test('handleInjectFunds adds tokens to wallet', () => {
  const pk = Keypair.generate().publicKey.toBase58();
  registerWallet(pk);

  handleInjectFunds(mockReq({
    publicKey: pk,
    sol: 1,
    tokens: [{ mint: 'FakeMint1111111111111111111111111111111', decimals: 6, amountUi: 500 }],
  }), mockRes());

  const b = mockRes(); handleCheckBalanceDetailed(mockReq({ publicKey: pk }), b);
  assert.equal(b._json.balance.sol, 1);
  const tok = b._json.balance.tokens['FakeMint1111111111111111111111111111111'];
  assert.ok(tok, 'token balance missing');
  assert.equal(tok.amountUi, 500);
  assert.equal(tok.decimals, 6);
});

test('handleInjectFunds rejects missing publicKey with 400', () => {
  const res = mockRes();
  handleInjectFunds(mockReq({}), res);
  assert.equal(res._status, 400);
  assert.equal(res._json.success, false);
});

// ---------------------------------------------------------------------------
// handleResumeLaunch
// ---------------------------------------------------------------------------

test('handleResumeLaunch always returns success (no-op in demo)', () => {
  const res = mockRes();
  handleResumeLaunch(mockReq({ publicKey: 'anything' }), res);
  assert.equal(res._json.success, true);
  assert.deepEqual(res._json.results, []);
});

// ---------------------------------------------------------------------------
// handleRetryAirdrop — parameter validation (fast paths)
// ---------------------------------------------------------------------------

test('handleRetryAirdrop rejects when all params missing', async () => {
  const res = mockRes();
  await handleRetryAirdrop(mockReq({}), res);
  assert.equal(res._status, 400);
  assert.equal(res._json.success, false);
});

test('handleRetryAirdrop rejects when tokenMint is missing', async () => {
  const kp = Keypair.generate();
  const res = mockRes();
  await handleRetryAirdrop(mockReq({
    tempWalletSecretKey: JSON.stringify(Array.from(kp.secretKey)),
    tokenDecimals: 9,
    recipients: [{ wallet: 'Rcp11111111111111111111111111111111111', tokens: 100 }],
  }), res);
  assert.equal(res._status, 400);
  assert.equal(res._json.success, false);
});

test('handleRetryAirdrop rejects empty recipients array', async () => {
  const kp = Keypair.generate();
  const res = mockRes();
  await handleRetryAirdrop(mockReq({
    tempWalletSecretKey: JSON.stringify(Array.from(kp.secretKey)),
    tokenMint: 'FakeMint1111111111111111111111111111111',
    tokenDecimals: 9,
    recipients: [],
  }), res);
  assert.equal(res._status, 400);
  assert.equal(res._json.success, false);
});
