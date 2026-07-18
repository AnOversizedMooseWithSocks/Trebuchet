import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import { evaluateAuditReport } from '../scripts/audit-policy.mjs';
import { redactSensitiveLogArgs, redactSensitiveText, redactUrl } from '../logRedaction.js';

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

test('server log redaction removes URL credentials and secret-bearing fields', () => {
  const url = redactUrl('https://rpc.example.test/path?api-key=super-secret&token=abc');
  assert.doesNotMatch(url, /super-secret|token=abc/);
  assert.match(url, /REDACTED/);
  assert.doesNotMatch(redactSensitiveText('Authorization: Bearer abc.def'), /abc\.def/);
  const [record] = redactSensitiveLogArgs([{ wallet: 'public', secretKey: [1, 2, 3], nested: { mnemonic: 'words' } }]);
  assert.deepEqual(record, { wallet: 'public', secretKey: '[REDACTED]', nested: { mnemonic: '[REDACTED]' } });
});

test('audit policy permits only the documented upstream bigint-buffer high advisory', () => {
  const allowed = evaluateAuditReport({
    vulnerabilities: {
      'bigint-buffer': { severity: 'high', via: [{ severity: 'high', url: 'https://github.com/advisories/GHSA-3gc7-fjrx-p6mg' }] },
      '@solana/buffer-layout-utils': { severity: 'high', via: ['bigint-buffer'] },
    },
  });
  assert.equal(allowed.blocked.length, 0);
  assert.equal(allowed.allowed.length, 2);

  const blocked = evaluateAuditReport({
    vulnerabilities: {
      dangerous: { severity: 'high', via: [{ severity: 'high', url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc' }] },
    },
  });
  assert.equal(blocked.blocked.length, 1);
});

test('v2 runtime state derives wallet/network/funding truth from authoritative inputs', () => {
  const sandbox = { window: {} };
  vm.runInNewContext(read('public/v2/runtime-state.js'), sandbox);
  const runtime = sandbox.window.TrebuchetV2RuntimeState;
  assert.equal(runtime.walletUnlocked({ wallet: null }), false);
  assert.equal(runtime.walletUnlocked({ wallet: { hasSecretKey: true }, secretPin: { configured: true, locked: true } }), false);
  assert.equal(runtime.walletUnlocked({ wallet: { hasSecretKey: true }, secretPin: { configured: true, unlocked: true } }), true);
  assert.equal(runtime.networkLabel({ demoActive: true, rpcName: 'Mainnet' }), 'Demo');
  assert.deepEqual({ ...runtime.fundingEstimate({ estimateMatches: false, estimatedSol: 6.33 }) }, {
    available: false,
    value: null,
    label: 'Estimate required',
  });
});

test('v2 removes cosmetic controls, native confirms, and false completion', () => {
  const app = read('public/v2/app.js');
  const server = read('server.js');
  const e2e = read('test/e2e/ui-flows.mjs');
  assert.doesNotMatch(app, /window\.confirm|data-action="noop"|state\.network\s*=|state\.connected\s*=/);
  assert.match(app, /RPC changes are made in authoritative settings/);
  assert.match(app, /new URLSearchParams\(\{ token, client: 'v2' \}\)/);
  assert.match(app, /Local run armed; execute only after readiness passes/);
  assert.match(app, /Funding estimate<\/span><strong>\$\{currentEstimate\.available \? fmtSol\(currentEstimate\.value\) : 'Run estimator first'\}/);
  assert.doesNotMatch(app, /Estimated envelope/);
  assert.doesNotMatch(app, /Static funding estimate staged/);
  assert.match(server, /client === 'v2' \? \{\} : \{/);
  assert.match(server, /executedOperationCount: 0/);
  assert.match(server, /requiresUserAction: 'check-readiness-and-execute'/);
  assert.match(server, /priceSource: 'demo-ledger'/);
  assert.doesNotMatch(e2e, /disabled\s*=\s*false|forceClick/);
  assert.match(e2e, /demoFundBtn/);
  assert.match(e2e, /createLpConfirmProceedBtn/);
});
