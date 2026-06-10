// Regression guard for the shipped public/app.js bundle.
//
// Two separate regressions shipped from rebuilding app.js out of stale module
// sources: (1) the public/api.js fetch wrapper was dropped, so every /api/*
// call was rejected with "invalid API session"; (2) the Advanced options,
// preallocation, and airdrop sections were dropped entirely, because
// public/modules/ is an INCOMPLETE extraction and the committed app.js is the
// real source of truth (it is thousands of lines ahead of the modules).
//
// These tests assert the load-bearing sections are present in the committed
// app.js, independent of how it was produced. They are coarse on purpose —
// they exist to catch a catastrophic "huge chunk of the app vanished" drift,
// not to test feature behavior. If a section here is ever intentionally
// removed, update the corresponding assertion.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appJs = readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');

test('app.js installs the API session fetch wrapper', () => {
  // Without these the client sends no x-trebuchet-session header and every
  // mutating API call (including wallet generation) returns "invalid API session".
  assert.ok(appJs.includes('window.fetch ='), 'fetch override missing');
  assert.ok(appJs.includes('x-trebuchet-session'), 'session header attachment missing');
  assert.ok(appJs.includes('getApiSessionToken'), 'getApiSessionToken missing');
});

test('app.js contains the Advanced options section', () => {
  assert.ok(
    appJs.includes('simpleAdvancedDetails'),
    'the collapsible Advanced options section is missing from app.js',
  );
});

test('app.js contains the preallocation feature', () => {
  assert.ok(
    appJs.toLowerCase().includes('preallocation'),
    'the preallocation feature is missing from app.js',
  );
});

test('app.js contains the airdrop feature', () => {
  assert.ok(
    appJs.toLowerCase().includes('airdrop'),
    'the airdrop feature is missing from app.js',
  );
});

test('app.js contains the Solflare browser wallet bridge', () => {
  assert.ok(
    appJs.includes('getSolflareProvider'),
    'the Solflare provider detection is missing from app.js',
  );
  assert.ok(
    appJs.includes('window.solana?.providers'),
    'the Solflare multi-provider detection is missing from app.js',
  );
  assert.ok(
    appJs.includes('wallet-standard:app-ready'),
    'the Solflare Wallet Standard discovery path is missing from app.js',
  );
  assert.ok(
    appJs.includes("standardWalletFeature(provider.wallet, 'standard:events')"),
    'the Solflare Wallet Standard account-change listener is missing from app.js',
  );
  assert.ok(
    appJs.includes('getSolflareSigner'),
    'the Solflare signer bridge is missing from app.js',
  );
});

test('app.js is not a truncated stale-module build', () => {
  // The full app.js is ~18k lines / ~830KB. A rebuild from the stale modules
  // produces ~12k lines / ~540KB. Guard against a regressed bundle slipping in.
  const bytes = Buffer.byteLength(appJs, 'utf8');
  assert.ok(
    bytes > 700 * 1024,
    `app.js is only ${Math.round(bytes / 1024)}KB — expected ~830KB. It may have ` +
    `been rebuilt from the incomplete public/modules/ extraction.`,
  );
});
