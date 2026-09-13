#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = path.resolve(process.argv[2] || path.join(root, 'artifacts', 'launch-video', 'raw'));
const configDir = await mkdtemp(path.join(os.tmpdir(), 'trebuchet-launch-footage-'));
const recordingDir = await mkdtemp(path.join(os.tmpdir(), 'trebuchet-browser-video-'));
const destination = path.join(outputDir, 'trebuchet-product-demo.webm');
const discoveryMint = '7GC5uBoR9YpQkLmXwN3vFj2HsTdA6cE1xZ8pW4yUqRmV';
const capturedAt = new Date().toISOString();
const discoveryPreview = {
  version: 1,
  selectedId: discoveryMint,
  records: [{
    id: discoveryMint,
    mint: discoveryMint,
    name: 'MoonKit',
    symbol: 'MKT',
    score: 92,
    status: 'Ready',
    confidence: 'High',
    inspectedAt: capturedAt,
    source: 'Demo evidence snapshot',
    priceUsd: 0.00428,
    metrics: { supply: 1_000_000_000, topTenPercent: 24.8 },
    evidence: [
      { label: 'Token program', value: 'Token-2022', state: 'pass' },
      { label: 'Metadata', value: 'Verified', state: 'pass' },
      { label: 'Mint authority', value: 'Renounced', state: 'pass' },
      { label: 'Freeze authority', value: 'Disabled', state: 'pass' },
      { label: 'Holder concentration', value: '24.8% top 10', state: 'pass' },
    ],
    warnings: [],
    market: {
      priceUsd: 0.00428,
      liquidityUsd: 184_600,
      volume24hUsd: 72_400,
      marketCapUsd: 4_280_000,
      priceChange: { h24: 8.42 },
      transactions24h: { buys: 421, sells: 308 },
      pool: { dex: 'raydium', address: '8xHy2YFkvBQrFcNWRyEh7FZQNMJQPbVB1LxrVExRCMFm' },
      history: {
        timeframe: '7 day',
        changePercent: 14.31,
        lowUsd: 0.00371,
        highUsd: 0.00444,
        asOf: capturedAt,
        points: [0.00374, 0.00382, 0.00378, 0.00393, 0.00402, 0.00397, 0.00411, 0.00408, 0.00425, 0.00419, 0.00436, 0.00428]
          .map((close, index) => ({ time: `preview-${index}`, close })),
      },
    },
  }],
};

const port = await new Promise((resolve, reject) => {
  const probe = net.createServer();
  probe.unref();
  probe.on('error', reject);
  probe.listen(0, '127.0.0.1', () => {
    const address = probe.address();
    probe.close(() => resolve(address.port));
  });
});
const baseUrl = `http://127.0.0.1:${port}`;

await mkdir(outputDir, { recursive: true });
await writeFile(path.join(configDir, 'userPrefs.json'), `${JSON.stringify({
  demoMode: true,
  playIntroVideo: false,
  playSoundEffects: false,
  playBackgroundMusic: false,
  coinPreview: false,
}, null, 2)}\n`);

const server = spawn(process.execPath, ['server.js'], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    TREBUCHET_CONFIG_DIR: configDir,
    DEMO_TIME_SCALE: '0.02',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let serverOutput = '';
for (const stream of [server.stdout, server.stderr]) {
  stream.on('data', (chunk) => {
    serverOutput += chunk.toString();
    if (serverOutput.length > 30_000) serverOutput = serverOutput.slice(-30_000);
  });
}

async function waitForServer() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Capture server exited early.\n${serverOutput}`);
    try {
      const response = await fetch(`${baseUrl}/api/session`);
      if (response.ok) return;
    } catch {
      // Keep polling while the local app starts.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Capture server did not start.\n${serverOutput}`);
}

const hold = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
let browser;
let context;

try {
  await waitForServer();
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({
    viewport: { width: 1600, height: 900 },
    deviceScaleFactor: 1,
    recordVideo: {
      dir: recordingDir,
      size: { width: 1600, height: 900 },
    },
  });
  const page = await context.newPage();
  await page.addInitScript(({ key, preview }) => {
    window.localStorage.setItem(key, JSON.stringify(preview));
  }, {
    key: 'trebuchet:v2:discovery-registry:v1',
    preview: discoveryPreview,
  });

  await page.goto(`${baseUrl}/v2/`, { waitUntil: 'load' });
  await page.waitForFunction(() => (
    document.querySelector('#globalStrip')?.textContent?.includes('Local API connected')
    && document.querySelector('#networkLabel')?.textContent?.trim() === 'Demo'
  ));
  await page.waitForSelector('#view-launch.is-active');
  await hold(1800);

  await page.click('[data-view="wallet"]');
  await hold(900);
  await page.click('#newVaultButton');
  await page.waitForSelector('#accountList .account-row', { timeout: 20_000 });
  await hold(1200);

  await page.click('[data-view="launch"]');
  await page.waitForSelector('#view-launch.is-active');
  await hold(1500);
  await page.click('.launch-workspace-tab[data-launch-workspace="fund"]');
  await hold(1400);
  await page.click('.launch-workspace-tab[data-launch-workspace="execute"]');
  await hold(1400);

  const runDemo = page.locator('[data-action="run-demo-launch"]');
  await runDemo.waitFor({ state: 'visible', timeout: 20_000 });
  await runDemo.click();
  await page.waitForFunction(() => (
    !document.querySelector('[data-action="run-demo-launch"]')?.hasAttribute('disabled')
    && /Run demo/i.test(document.querySelector('[data-action="run-demo-launch"]')?.textContent || '')
  ), null, { timeout: 60_000 });
  await hold(1800);

  await page.click('.launch-workspace-tab[data-launch-workspace="verify"]');
  await hold(1800);
  await page.click('[data-view="discovery"]');
  await page.waitForSelector('#view-discovery.is-active');
  await page.waitForSelector('#discoveryTable .discovery-row');
  await hold(2200);
  await page.click('[data-view="history"]');
  await page.waitForSelector('#view-history.is-active');
  await hold(1800);

  await context.close();
  context = null;
  const recordings = (await readdir(recordingDir)).filter((file) => file.endsWith('.webm'));
  if (recordings.length !== 1) throw new Error(`Expected one browser recording, found ${recordings.length}.`);
  await rm(destination, { force: true });
  await rename(path.join(recordingDir, recordings[0]), destination);
  console.log(destination);
} catch (error) {
  if (serverOutput) process.stderr.write(`\n--- capture server output ---\n${serverOutput}\n`);
  throw error;
} finally {
  await context?.close().catch(() => {});
  await browser?.close().catch(() => {});
  server.kill('SIGTERM');
  await Promise.all([
    rm(configDir, { recursive: true, force: true }),
    rm(recordingDir, { recursive: true, force: true }),
  ]);
}
