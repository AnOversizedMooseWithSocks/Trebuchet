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

// The first server import loads the Solana/Raydium dependency graph. Cold CI
// workers and busy developer machines can legitimately need more than 20s
// before the loopback listener is ready, so keep the smoke deterministic
// without weakening any of its readiness assertions.
async function waitForServer(timeoutMs = 60_000) {
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
  await page.click('.guided-advanced-shortcut');
  await page.waitForSelector('.sidebar', { state: 'visible' });
  await page.click('[data-view="wallet"]');
  await page.waitForSelector('#view-wallet.is-active');
  await page.click('#newVaultButton');
  await page.waitForSelector('#accountList .account-row', { timeout: 20_000 });
  const fundingAddress = (await page.textContent('#walletDetailPanel code'))?.trim() || '';
  assert.match(fundingAddress, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);

  await page.evaluate(() => {
    const publicKey = selectedLaunchWalletPublicKey();
    state.secretPin = { ...state.secretPin, configured: true, locked: true, unlocked: false };
    state.managedWallets = state.managedWallets.map((wallet) => (
      wallet.publicKey === publicKey ? { ...wallet, secretPinLocked: true } : wallet
    ));
    renderAll();
  });
  assert.match(await page.getAttribute('#walletButton', 'aria-label'), /Unlock .* Recovery PIN/i);
  await page.click('#walletButton');
  await page.waitForSelector('#recoveryPinGate:not([hidden])');
  assert.match(await page.locator('#recoveryPinGate').innerText(), /Enter Recovery PIN/i);
  await page.click('#recoveryPinCancel');
  await page.waitForSelector('#recoveryPinGate', { state: 'hidden' });
  await page.evaluate(() => {
    const publicKey = selectedLaunchWalletPublicKey();
    state.secretPin = { ...state.secretPin, configured: false, locked: false, unlocked: true };
    state.managedWallets = state.managedWallets.map((wallet) => (
      wallet.publicKey === publicKey ? { ...wallet, secretPinLocked: false } : wallet
    ));
    renderAll();
  });

  await page.click('[data-action="import-wallet"]');
  await page.waitForSelector('#operatorPromptGate:not([hidden])');
  assert.equal(await page.getAttribute('#operatorPromptInput', 'type'), 'password');
  const sentinelSecret = 'never-persist-this-e2e-secret';
  await page.fill('#operatorPromptInput', sentinelSecret);
  await page.keyboard.press('Escape');
  await page.waitForSelector('#operatorPromptGate', { state: 'hidden' });
  assert.equal(await page.inputValue('#operatorPromptInput'), '');
  assert.doesNotMatch(await page.locator('body').innerText(), new RegExp(sentinelSecret));

  await page.click('.nav-item[data-view="history"]');
  await page.waitForSelector('#view-history.is-active');
  await page.focus('#historyTabRecovery');
  await page.keyboard.press('ArrowRight');
  await page.waitForSelector('#historyPanelWallets:not([hidden])');
  assert.equal(await page.getAttribute('#historyTabWallets', 'aria-selected'), 'true');
  assert.equal(await page.getAttribute('#historyTabRecovery', 'tabindex'), '-1');
  await page.keyboard.press('End');
  await page.waitForSelector('#historyPanelJournal:not([hidden])');
  assert.equal(await page.getAttribute('#historyTabJournal', 'aria-selected'), 'true');

  await page.click('[data-view="launch"]');
  await page.click('.launch-workspace-tab[data-launch-workspace="wallet"]');
  await page.waitForFunction(() => document.body.dataset.launchWorkspace === 'wallet');
  assert.deepEqual(await page.evaluate(() => (
    [...document.querySelectorAll('[data-classic-workspace]')]
      .filter((panel) => !panel.hidden)
      .map((panel) => panel.dataset.classicWorkspace)
  )), ['wallet'], 'Phase 1 was not isolated before wallet selection');

  await page.click('.launch-wallet-choice');
  await page.waitForFunction(() => document.body.dataset.launchWorkspace === 'configure');
  assert.equal(await page.isVisible('#advancedLaunchControls .configure-step-guide'), true);
  assert.match(await page.locator('#advancedLaunchControls .configure-step-guide').innerText(), /Phase 2 of 6/i);
  assert.deepEqual(await page.evaluate(() => (
    [...document.querySelectorAll('[data-classic-workspace]')]
      .filter((panel) => !panel.hidden)
      .map((panel) => panel.dataset.classicWorkspace)
  )), [], 'Classic phases leaked into Phase 2');

  await page.click('#advancedLaunchControls button[data-launch-workspace="fund"]');
  await page.waitForFunction(() => document.body.dataset.launchWorkspace === 'fund');
  await page.click('[data-action="estimate-funding"]');
  await page.waitForSelector('.classic-workspace-fund .funding-task-address', { timeout: 30_000 });
  await page.evaluate(() => renderClassicBridge());
  assert.deepEqual(await page.evaluate(() => (
    [...document.querySelectorAll('[data-classic-workspace]')]
      .filter((panel) => !panel.hidden)
      .map((panel) => panel.dataset.classicWorkspace)
  )), ['fund'], 'An async funding refresh exposed multiple launch phases');
  assert.match(await page.locator('.classic-workspace-fund').innerText(), /Phase 3 of 6/i);
  assert.match(await page.locator('.classic-workspace-fund .funding-task').innerText(), /did not move funds/i);
  assert.equal(await page.isDisabled('.classic-workspace-fund button[data-launch-workspace="mint"]'), true);
  assert.match(await page.locator('.classic-workspace-fund .funding-wallet-hint').innerText(), /Return wallet not set/i);
  assert.match(await page.locator('.classic-workspace-fund .funding-wallet-hint').innerText(), /Set return wallet/i);

  await page.click('.classic-workspace-fund [data-action="edit-return-wallet"]');
  await page.waitForFunction(() => (
    document.body.dataset.launchWorkspace === 'configure'
    && document.activeElement?.id === 'sweepDestination'
  ));
  assert.equal(await page.getAttribute('#sweepDestination', 'placeholder'), 'Wallet receiving remaining assets');
  assert.equal(await page.getAttribute('#sweepDestination', 'aria-invalid'), null);
  assert.equal(await page.locator('#sweepDestination').evaluate((input) => input.closest('details')?.open), true);

  await page.fill('#sweepDestination', fundingAddress);
  await page.dispatchEvent('#sweepDestination', 'change');
  await page.evaluate(() => {
    const config = currentLaunchConfig();
    const walletPublicKey = selectedLaunchWalletPublicKey();
    state.demoActive = false;
    state.prefs.demoMode = false;
    state.managedWallets = state.managedWallets.map((wallet) => (
      wallet.publicKey === walletPublicKey
        ? { ...wallet, hasSecretKey: true, decryptionFailed: false }
        : wallet
    ));
    state.secretPin = { ...state.secretPin, configured: false, locked: false, unlocked: true };
    state.classicFundingEstimate = stampClassicFundingEstimate({
      totalSol: 0.46,
      autoSwapPlan: [],
      byQuote: {},
      quoteBreakdown: [],
    }, config);
    state.manualPrefund = {
      walletPublicKey,
      balance: { sol: 1, tokens: {} },
      polling: false,
      error: null,
      lastUpdatedAt: new Date().toISOString(),
    };
    state.executionReadiness = {
      status: 'ready',
      nextAction: 'Create token',
      nextEndpoint: '/api/create-token',
      blockers: [],
      warnings: [],
      phases: [],
    };
    state.lastRunEnvelope = null;
    applyLaunchPlan(fallbackLaunchPlan(), config, { openApproval: false });
    state.launchWorkspace = 'mint';
    renderAll();
  });
  await page.waitForFunction(() => document.body.dataset.launchWorkspace === 'mint');
  const mintWorkspace = page.locator('[data-classic-workspace="mint"]');
  assert.match(await mintWorkspace.innerText(), /Review and arm this launch/i);
  assert.match(await mintWorkspace.innerText(), /Review & arm launch/i);
  assert.doesNotMatch(await mintWorkspace.innerText(), /\/api\/create-token/i);

  await mintWorkspace.locator('[data-action="review-and-arm-run"]').click();
  await page.waitForSelector('#approvalFloating.is-open');
  assert.match(await page.locator('#approvalFloating').innerText(), /Review before creating/i);
  assert.match(await page.locator('#approvalFloating').innerText(), /Arming does not send a transaction/i);
  assert.match(await page.locator('#approvalFloating').innerText(), /Arm & return to Create token/i);
  await page.click('[data-action="close-approval"]');
  await page.evaluate(() => {
    state.lastRunEnvelope = { id: 'phase-4-e2e-envelope', status: 'armed' };
    renderAll();
  });
  await page.waitForSelector('[data-classic-workspace="mint"] [data-action="execute-next-run"]');
  assert.match(
    await page.locator('[data-classic-workspace="mint"] [data-action="execute-next-run"]').innerText(),
    /Create token/i,
  );

  await page.evaluate(() => {
    state.lastRunEnvelope = null;
    state.executionReadiness = {
      ...state.executionReadiness,
      nextAction: 'Finish interrupted token',
      nextEndpoint: '/api/finish-token-creation',
      completion: {
        ...(state.executionReadiness?.completion || {}),
        tokenCreated: false,
        tokenNeedsFinish: true,
      },
      phases: (state.executionReadiness?.phases || []).map((phase) => (
        phase.id === 'token'
          ? { ...phase, title: 'Finish token', endpoint: '/api/finish-token-creation', state: 'ready' }
          : phase
      )),
    };
    renderAll();
  });
  assert.match(await mintWorkspace.innerText(), /Finish interrupted token/i);
  assert.match(await mintWorkspace.innerText(), /Finish token safely/i);
  assert.doesNotMatch(await mintWorkspace.innerText(), /Resume missing work/i);

  await page.evaluate(() => {
    state.lastRunEnvelope = null;
    state.executionReadiness = null;
    state.transactions = [];
    state.demoActive = true;
    state.prefs.demoMode = true;
    state.launchWorkspace = 'configure';
    renderAll();
  });

  await page.click('[data-action="select-experience"][data-experience="guided"]');
  await page.click('[data-action="guided-next"]');
  await page.fill('[data-guided-field="name"]', 'First Launch');
  await page.fill('[data-guided-field="symbol"]', 'FIRST');
  await page.setInputFiles(
    '#tokenLogoFile',
    path.join(root, 'public', 'release-assets', 'frames', 'f01.png'),
  );
  await page.waitForSelector('.guided-logo-button .guided-logo-mark img');
  assert.match(
    await page.locator('.guided-logo-button').innerText(),
    /Logo attached/,
    'Guided Mode did not show the uploaded logo until a later navigation refresh',
  );
  await page.evaluate(() => {
    const symbol = document.querySelector('[data-guided-field="symbol"]');
    symbol.focus();
    symbol.setSelectionRange(2, 2);
    document.querySelector('[data-action="select-environment"][data-environment="live"]').click();
  });
  await page.waitForFunction(() => document.body.dataset.executionEnvironment === 'live');
  assert.deepEqual(await page.evaluate(() => ({
    field: document.activeElement?.dataset?.guidedField,
    cursor: document.activeElement?.selectionStart,
  })), { field: 'symbol', cursor: 2 }, 'environment refresh moved focus inside Guided Mode');
  await page.evaluate(() => {
    document.querySelector('[data-action="select-environment"][data-environment="practice"]').click();
  });
  await page.waitForFunction(() => document.body.dataset.executionEnvironment === 'practice');
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
  assert.match(guidedRunText, /The complete launch recipe worked/i);
  assert.match(guidedRunText, /Prepare live launch/i);
  assert.match(guidedRunText, /Review local practice record/i);
  assert.match(runText, /Run\s+\d+\/\d+ done \/ 0 queued/);
  assert.deepEqual(nativeDialogs, [], 'Trebuchet opened a native prompt/confirm dialog');
  assert.deepEqual(pageErrors, [], 'Trebuchet emitted page errors');
  assert.deepEqual(consoleErrors, [], 'Trebuchet emitted console errors');

  console.log('Trebuchet API-backed E2E passed: session, wallet, secure dialog, Guided launch');
} catch (error) {
  if (serverOutput) process.stderr.write(`\n--- Trebuchet E2E server output ---\n${serverOutput}\n`);
  throw error;
} finally {
  await browser?.close().catch(() => {});
  await stopServer();
}
