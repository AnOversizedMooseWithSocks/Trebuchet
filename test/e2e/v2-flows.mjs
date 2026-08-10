#!/usr/bin/env node
// API-backed Trebuchet browser smoke.
//
// Unlike the file:// viewport proof, this boots the real local Express app,
// lets the Trebuchet client establish its authenticated API session, creates a
// Trebuchet-managed demo wallet, verifies the secure import dialog, and runs
// the complete demo token/liquidity/sweep contract.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const configDir = mkdtempSync(path.join(tmpdir(), 'trebuchet-v2-e2e-'));
const port = await new Promise((resolve, reject) => {
  const socket = net.createServer();
  socket.unref();
  socket.on('error', reject);
  socket.listen(0, '127.0.0.1', () => {
    const address = socket.address();
    socket.close(() => resolve(address.port));
  });
});
const baseUrl = `http://127.0.0.1:${port}`;

writeFileSync(path.join(configDir, 'userPrefs.json'), JSON.stringify({
  demoMode: true,
  playIntroVideo: false,
  playSoundEffects: false,
  playBackgroundMusic: false,
  coinPreview: false,
}, null, 2));

const server = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    TREBUCHET_CONFIG_DIR: configDir,
    DEMO_TIME_SCALE: '0.01',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let serverOutput = '';
let serverExited = null;
const collectServerOutput = (chunk) => {
  serverOutput += chunk.toString();
  if (serverOutput.length > 30_000) serverOutput = serverOutput.slice(-30_000);
};
server.stdout.on('data', collectServerOutput);
server.stderr.on('data', collectServerOutput);
server.on('exit', (code, signal) => {
  serverExited = { code, signal };
});

async function waitForServer(timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (serverExited) {
      throw new Error(`v2 E2E server exited early (${JSON.stringify(serverExited)})\n${serverOutput}`);
    }
    try {
      const response = await fetch(`${baseUrl}/api/session`);
      const body = await response.json();
      if (response.ok && body?.token) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(`v2 E2E server did not start: ${lastError?.message || 'timeout'}\n${serverOutput}`);
}

async function stopServer() {
  if (serverExited) return;
  server.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => server.once('exit', resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (!serverExited) server.kill('SIGKILL');
}

let browser = null;
try {
  await waitForServer();
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const pageErrors = [];
  const consoleErrors = [];
  const nativeDialogs = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('dialog', async (dialog) => {
    nativeDialogs.push(`${dialog.type()}: ${dialog.message()}`);
    await dialog.dismiss();
  });

  await page.goto(`${baseUrl}/v2/`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await page.waitForFunction(() => (
    document.querySelector('#globalStrip')?.textContent?.includes('Local API connected')
    && document.querySelector('#networkLabel')?.textContent?.trim() === 'Demo'
  ), null, { timeout: 30_000 });
  assert.equal(new URL(page.url()).pathname, '/v2/');

  const session = await page.evaluate(async () => {
    const response = await fetch('/api/session');
    return response.json();
  });
  assert.equal(session.success, true);
  assert.ok(session.token, 'Trebuchet did not receive a local API session token');

  assert.equal(await page.getAttribute('body', 'data-experience-mode'), 'guided');
  assert.equal(await page.isVisible('.sidebar'), false, 'Guided Mode should start as a focused tutorial');
  await page.click('[data-action="select-experience"][data-experience="advanced"]');
  await page.waitForSelector('.sidebar', { state: 'visible' });
  await page.click('[data-view="wallet"]');
  await page.waitForSelector('#view-wallet.is-active');
  await page.click('#newVaultButton');
  await page.waitForSelector('#accountList .account-row', { timeout: 20_000 });
  const fundingAddress = (await page.textContent('#walletDetailPanel code'))?.trim() || '';
  assert.match(fundingAddress, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);

  await page.click('[data-action="import-wallet"]');
  await page.waitForSelector('#operatorPromptGate:not([hidden])');
  assert.equal(await page.getAttribute('#operatorPromptInput', 'type'), 'password');
  const sentinelSecret = 'never-persist-this-e2e-secret';
  await page.fill('#operatorPromptInput', sentinelSecret);
  await page.keyboard.press('Escape');
  await page.waitForSelector('#operatorPromptGate', { state: 'hidden' });
  assert.equal(await page.inputValue('#operatorPromptInput'), '');
  assert.doesNotMatch(await page.locator('body').innerText(), new RegExp(sentinelSecret));

  await page.click('[data-view="launch"]');
  await page.click('[data-action="select-experience"][data-experience="guided"]');
  await page.click('[data-action="guided-next"]');
  await page.fill('[data-guided-field="name"]', 'First Launch');
  await page.fill('[data-guided-field="symbol"]', 'FIRST');
  await page.click('[data-action="guided-next"]');
  await page.click('[data-action="guided-use-practice-wallet"]');
  await page.click('[data-action="guided-next"]');
  await page.click('[data-action="guided-value-preset"][data-value="100000"]');
  await page.click('[data-action="guided-next"]');
  await page.click('[data-action="guided-practice"]');
  await page.waitForFunction(() => (
    document.querySelector('#guidedRunShell')?.textContent?.includes('Practice complete')
  ), null, { timeout: 60_000 });

  const guidedRunText = await page.locator('#guidedRunShell').innerText();
  const runText = await page.locator('#globalStrip').innerText();
  assert.match(guidedRunText, /The complete launch recipe worked/);
  assert.match(guidedRunText, /Review practice proof/);
  assert.match(runText, /Run\s+\d+\/\d+ done \/ 0 queued/);
  assert.deepEqual(nativeDialogs, [], 'Trebuchet opened a native prompt/confirm dialog');
  assert.deepEqual(pageErrors, [], 'Trebuchet emitted page errors');
  assert.deepEqual(consoleErrors, [], 'Trebuchet emitted console errors');

  console.log('Trebuchet API-backed E2E passed: session, wallet, secure dialog, Guided practice launch');
} catch (error) {
  if (serverOutput) process.stderr.write(`\n--- Trebuchet E2E server output ---\n${serverOutput}\n`);
  throw error;
} finally {
  await browser?.close().catch(() => {});
  await stopServer();
}
