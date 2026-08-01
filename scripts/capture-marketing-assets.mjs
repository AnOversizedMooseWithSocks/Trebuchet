#!/usr/bin/env node

import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const websiteDir = path.join(root, 'website');
const appAssetsDir = path.join(websiteDir, 'assets');
const configDir = await mkdtemp(path.join(os.tmpdir(), 'trebuchet-marketing-'));
const discoveryMint = '7GC5uBoR9YpQkLmXwN3vFj2HsTdA6cE1xZ8pW4yUqRmV';
const discoveryCapturedAt = new Date().toISOString();
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
    inspectedAt: discoveryCapturedAt,
    source: 'Demo evidence snapshot',
    priceUsd: 0.00428,
    metrics: {
      supply: 1_000_000_000,
      topTenPercent: 24.8,
    },
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
        asOf: discoveryCapturedAt,
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
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let serverOutput = '';
for (const stream of [server.stdout, server.stderr]) {
  stream.on('data', (chunk) => {
    serverOutput += chunk.toString();
    if (serverOutput.length > 20_000) serverOutput = serverOutput.slice(-20_000);
  });
}

async function waitForServer() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`Marketing capture server exited early.\n${serverOutput}`);
    }
    try {
      await fetch(`http://127.0.0.1:${port}/`);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  throw new Error(`Marketing capture server did not start.\n${serverOutput}`);
}

let browser;
try {
  await waitForServer();
  browser = await chromium.launch({ headless: true });

  const appPage = await browser.newPage({
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 1,
  });
  await appPage.addInitScript(({ key, preview }) => {
    window.localStorage.setItem(key, JSON.stringify(preview));
  }, {
    key: 'trebuchet:v2:discovery-registry:v1',
    preview: discoveryPreview,
  });
  await appPage.emulateMedia({ reducedMotion: 'reduce' });
  await appPage.goto(`http://127.0.0.1:${port}/v2/`, { waitUntil: 'load' });
  await appPage.waitForSelector('body:not([data-treb-busy])');
  await appPage.waitForSelector('#view-launch.is-active');
  await appPage.waitForFunction(() => document.querySelector('#tokenomicsChart svg'));
  await appPage.waitForFunction(() => (
    document.querySelector('#globalStrip')?.textContent.includes('Local API connected')
    && document.querySelector('#networkLabel')?.textContent.trim().toLowerCase() === 'demo'
  ));
  await appPage.waitForFunction(() => document.querySelector('#toastStack')?.children.length === 0);
  await appPage.screenshot({ path: path.join(appAssetsDir, 'app-launch-console.png') });

  await appPage.click('[data-view="discovery"]');
  await appPage.waitForSelector('#view-discovery.is-active');
  await appPage.waitForSelector('#discoveryTable .discovery-row');
  await appPage.waitForSelector('#evidencePanel .market-card');
  await appPage.waitForFunction(() => (
    document.querySelector('#discoverySourceBanner')?.textContent.includes('Solana RPC chain facts')
  ));
  await appPage.screenshot({ path: path.join(appAssetsDir, 'app-discovery.png') });

  await appPage.click('[data-view="history"]');
  await appPage.waitForSelector('#view-history.is-active');
  await appPage.waitForSelector('.recovery-wizard-panel');
  await appPage.screenshot({ path: path.join(appAssetsDir, 'app-recovery-center.png') });
  await appPage.close();

  const sitePage = await browser.newPage({
    viewport: { width: 1200, height: 630 },
    deviceScaleFactor: 1,
  });
  await sitePage.emulateMedia({ reducedMotion: 'reduce' });
  await sitePage.goto(pathToFileURL(path.join(websiteDir, 'index.html')).href, { waitUntil: 'load' });
  await sitePage.screenshot({ path: path.join(websiteDir, 'og-image.png') });
  await sitePage.close();

  console.log('Captured current marketing screenshots and social preview.');
} finally {
  if (browser) await browser.close();
  server.kill();
  await rm(configDir, { recursive: true, force: true });
}
