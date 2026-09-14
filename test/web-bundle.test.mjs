// test/web-bundle.test.mjs
//
// Proves the streamlined-launch core runs in a browser-like sandbox: no Node
// builtins (no require, no process, no Buffer, no node:crypto). We concatenate
// the four modules the web app needs, strip import/export syntax, evaluate
// them in an isolated vm context that only exposes web globals, and drive the
// plan builder there. Digests are computed with the pure-JS sha256 path.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const FILES = [
  'packages/core/src/sha256.js',
  'packages/core/src/lp-constants.js',
  'packages/core/src/validators.js',
  'packages/core/src/streamlined-launch.js',
];

function browserBody() {
  let body = '';
  for (const file of FILES) {
    body += readSource(file);
  }
  return body;
}

// Collapse imports (we concatenate all modules into one scope) and turn
// `export` declarations into plain declarations. `TOKEN_DECIMALS` is declared
// in both validators.js and streamlined-launch.js, so the latter copy is
// renamed before concatenation — the real browser builds keep module scope and
// never collide; this is only an artifact of the flat-bundle harness.
function readSource(file) {
  let source = fs.readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  if (file.endsWith('streamlined-launch.js')) {
    source = source.replace(/TOKEN_DECIMALS/g, 'STREAM_TOKEN_DECIMALS');
  }
  return source
    .replace(/^import\s[^;]+;\s*$/gm, '')
    .replace(/^\s*export\s+/gm, '') + '\n';
}

function loadBrowserCore() {
  const body = browserBody();
  assert.doesNotMatch(body, /^import\s.*?from\s+['"]node:/gm, 'core must not import Node builtins');
  assert.doesNotMatch(body, /require\s*\(/g, 'core must not use require()');
  const sandbox = {
    console,
    TextEncoder,
    TextDecoder,
    Uint8Array,
    ArrayBuffer,
    DataView,
    // Deliberately NO Buffer, no process, no node:crypto.
  };
  sandbox.globalThis = sandbox;
  const source = `(function () {\n${body}\nreturn { buildStreamlinedPlan, verifyStreamlinedPlan, buildStreamlinedLedger, buildStreamlinedPoolTopology };})()`;
  return vm.runInNewContext(source, sandbox, { filename: 'web://core-bundle.js' });
}

test('streamlined core loads and plans in a browser-only sandbox', () => {
  const core = loadBrowserCore();
  const plan = core.buildStreamlinedPlan({
    token: { name: 'Web Test', symbol: 'WEB' },
    solUsd: 150,
    fees: { buyBps: 100, sellBps: 50, transferBps: 0, treasury: '5K9eGhNM9NvjNpyBLk7EhWJ3WX8fC9eYp8N7k4RfJX9z' },
  });
  assert.equal(plan.topology.poolCount, 1);
  assert.equal(plan.ledger.totalSol, 0.12138);
  assert.equal(plan.fees.enabled, true);
  assert.equal(plan.fees.buyBps, 100);
  // Web digest (pure-JS sha256) is self-consistent in the sandbox too.
  assert.equal(core.verifyStreamlinedPlan(plan).valid, true);
});

test('native vs browser digests agree exactly', async () => {
  const core = loadBrowserCore();
  const native = await import('../packages/core/src/streamlined-launch.js');
  const input = { token: { name: 'Digest', symbol: 'DGT' }, poolCount: 2, quotes: ['SOL', 'USDC'] };
  const now = '2026-01-01T00:00:00.000Z';
  const browserPlan = core.buildStreamlinedPlan(input, { now });
  const nodePlan = native.buildStreamlinedPlan(input, { now });
  assert.equal(browserPlan.integrity.digest, nodePlan.integrity.digest);
});