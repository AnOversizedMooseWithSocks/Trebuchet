// test/user-reports-sept14.test.mjs
//
// Pins for four user reports (14 Sept 2026):
//   1. Linux AppImage "didn't even open" — Ubuntu 24.04+/Debian block the
//      user namespaces Chromium's sandbox needs; main.js must probe and
//      fall back to --no-sandbox rather than die before the first window.
//   2. Demo mode blocked tokens "because of risks" and had price fetch
//      issues — /api/quote-token-info must be demo-intercepted with a
//      synthetic, fully-compatible, instantly-priced response.
//   3. Users must be able to acknowledge a RISK (freeze authority) and
//      proceed; only technical impossibilities stay hard blocks.
//   4. Demo preallocation/airdrop accounting must hold end to end, and a
//      malformed airdrop amount must fail one recipient, not the request.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Keypair } from '@solana/web3.js';
import * as demo from '../demoChainService.js';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');
const res = () => ({ code: 200, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } });

// ---- 1. Linux sandbox probe ---------------------------------------------------

test('main.js probes user namespaces on Linux and falls back to --no-sandbox', () => {
  const main = read('main.js');
  assert.match(main, /process\.platform === 'linux'/);
  assert.match(main, /execFileSync\('unshare', \['-Ur', 'true'\]/, 'probes the kernel the way electron-builder\'s AppRun does');
  assert.match(main, /app\.commandLine\.appendSwitch\('no-sandbox'\)/, 'falls back so the app launches');
  // The probe must run at module top level, before app 'ready'.
  const probeIdx = main.indexOf("execFileSync('unshare'");
  const readyIdx = main.search(/app\.whenReady\(\)|app\.on\('ready'/);
  assert.ok(probeIdx > 0 && readyIdx > 0 && probeIdx < readyIdx, 'probe must precede app ready');
});

test('website tells Linux users about the .deb, libfuse2, and the execute bit', () => {
  const site = read('website/index.html');
  assert.match(site, /Ubuntu 24\.04\+ \/ Debian/);
  assert.match(site, /libfuse2t64/);
  assert.match(site, /chmod \+x/);
});

// ---- 2. Demo quote-token-info -------------------------------------------------

test('demo quote-token-info returns a compatible, priced token for ANY input, instantly', () => {
  const r = res();
  demo.handleQuoteTokenInfo({ body: { quoteToken: '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr' } }, r);
  assert.equal(r.code, 200);
  const info = r.body.info;
  assert.equal(r.body.success, true);
  assert.equal(info.compatible, true);
  assert.equal(info.freezeAuthorityBlock, false);
  assert.equal(info.mintAuthorityWarning, false);
  assert.equal(info.raydiumTradeable, 'yes');
  assert.ok(Number(info.priceUsd) > 0, 'always has a price');
  assert.equal(typeof info.decimals, 'number');
});

test('demo quote-token-info keeps canonical decimals for known quotes and is deterministic', () => {
  let r = res(); demo.handleQuoteTokenInfo({ body: { quoteToken: 'USDC' } }, r);
  assert.equal(r.body.info.decimals, 6);
  assert.equal(r.body.info.priceUsd, '1');
  r = res(); demo.handleQuoteTokenInfo({ body: { quoteToken: 'SOL' } }, r);
  assert.equal(r.body.info.decimals, 9);
  const a = res(); demo.handleQuoteTokenInfo({ body: { quoteToken: 'SomeMint111' } }, a);
  const b = res(); demo.handleQuoteTokenInfo({ body: { quoteToken: 'SomeMint111' } }, b);
  assert.equal(a.body.info.priceUsd, b.body.info.priceUsd, 'same input, same price');
});

test('demo quote-token-info mirrors the real response shape (report parity)', () => {
  // Every field the editor reads off the real endpoint must exist here too,
  // so the two modes render identically and a demo run explores the real UI.
  const server = read('server.js');
  const realFields = new Set([...server.matchAll(/infoOut\.([a-zA-Z]+) =/g)].map((m) => m[1]));
  const r = res(); demo.handleQuoteTokenInfo({ body: { quoteToken: 'AnyMint111' } }, r);
  const missing = [...realFields].filter((f) => !(f in r.body.info));
  assert.deepEqual(missing, [], 'demo response lacks fields the real endpoint sets');
});

test('server.js routes quote-token-info to the demo handler in demo mode', () => {
  const server = read('server.js');
  const idx = server.indexOf("app.post('/api/quote-token-info'");
  const head = server.slice(idx, idx + 400);
  assert.match(head, /if \(isDemoMode\(\)\) return demoChainService\.handleQuoteTokenInfo\(req, res\)/);
});

// ---- 3. Risk acknowledgement ----------------------------------------------------

test('freeze-authority risk is acknowledgeable in the editor, and resets when the token changes', () => {
  const src = read('public/modules/pool-editor.js');
  assert.match(src, /data-field="riskAcknowledged"/, 'the pool card renders an acknowledge checkbox');
  assert.match(src, /if \(p\.riskAcknowledged === true\) \{[\s\S]{0,400}warnings\.push/, 'acknowledged -> warning');
  assert.match(src, /Tick "I understand this risk"/, 'unacknowledged -> blocking reason that says how to proceed');
  assert.match(src, /pool\.riskAcknowledged = false;/, 'acknowledgement is tied to the token it was given for');
  // Token-2022 incompatibility stays a hard block — it is technical, not risk.
  assert.match(src, /if \(p\.resolvedCompatible === false\) \{[\s\S]{0,300}reasons\.push/);
});

// ---- 4. Demo accounting + airdrop hardening -------------------------------------

test('demo: preallocation stays in the wallet after LP, airdrop deducts, malformed amounts fail per-recipient', async () => {
  const kp = Keypair.generate(); const sk = Array.from(kp.secretKey); const pk = kp.publicKey.toBase58();
  const balance = () => { const r = res(); demo.handleCheckBalanceDetailed({ body: { publicKey: pk } }, r); const t = r.body.balance.tokens; return Object.values(t)[0]?.amountUi; };
  let r = res();
  await demo.handleCreateToken({ body: { tempWalletSecretKey: sk, name: 'T', symbol: 'T', totalSupply: 1000000 } }, r);
  const mint = r.body.tokenMint;
  r = res();
  await demo.handleCreateLp({ body: { tempWalletSecretKey: sk, tokenMint: mint, tokenDecimals: 9, tokenTotalSupply: 1000000, targetMarketCapUsd: 100000, lockPositions: true, allocations: [{ quoteToken: 'SOL', supplyPercent: 90 }] } }, r);
  assert.equal(r.body.success, true);
  assert.equal(balance(), 100000, '10% preallocation remains after a 90% LP');
  r = res();
  await demo.handleRetryAirdrop({ body: { tempWalletSecretKey: sk, tokenMint: mint, tokenDecimals: 9, recipients: [
    { wallet: Keypair.generate().publicKey.toBase58(), tokens: 1000 },
    { wallet: Keypair.generate().publicKey.toBase58(), tokens: 'not-a-number' }, // must not 500 the request
    { wallet: Keypair.generate().publicKey.toBase58(), tokens: 500 },
  ] } }, r);
  assert.equal(r.code, 200, 'a bad amount fails one recipient, not the whole airdrop');
  assert.equal(r.body.airdrop.transferred.length, 2);
  assert.equal(r.body.airdrop.failed.length, 1);
  assert.match(r.body.airdrop.failed[0].error, /Invalid token amount/);
  assert.equal(balance(), 98500, 'only delivered amounts are deducted');
});

test('real airdrop path also fails a malformed amount per-recipient, not with BigInt(NaN)', () => {
  const src = read('walletHelpers.js');
  assert.match(src, /const tokensNum = Number\(r\.tokens\);\s*if \(!Number\.isFinite\(tokensNum\) \|\| tokensNum <= 0\)/);
  assert.match(src, /error: 'Invalid token amount'/);
});
