#!/usr/bin/env node

import { spawn } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = path.resolve(process.argv[2] || path.join(root, 'artifacts', 'ux-walkthrough'));
const rawVideo = path.join(outputDir, 'trebuchet-complete-operations-walkthrough.webm');
const finalVideo = path.join(outputDir, 'trebuchet-complete-operations-walkthrough.mp4');
const poster = path.join(outputDir, 'trebuchet-complete-operations-poster.jpg');
const storyboard = path.join(outputDir, 'WALKTHROUGH.md');
const timelineFile = path.join(outputDir, 'TIMELINE.json');
const configDir = await mkdtemp(path.join(os.tmpdir(), 'trebuchet-walkthrough-config-'));
const recordingDir = await mkdtemp(path.join(os.tmpdir(), 'trebuchet-walkthrough-video-'));
const ffmpeg = process.env.FFMPEG || '/opt/homebrew/opt/ffmpeg-full/bin/ffmpeg';
const discoveryMint = '7GC5uBoR9YpQkLmXwN3vFj2HsTdA6cE1xZ8pW4yUqRmV';
const capturedAt = new Date().toISOString();
const timeline = [];
let captureStartedAt = 0;

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
    source: 'Walkthrough evidence snapshot',
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
          .map((close, index) => ({ time: `walkthrough-${index}`, close })),
      },
    },
  }],
};

const chapters = [
  ['01', 'Guided practice', 'Create a complete launch recipe with no transaction and no SOL spent.'],
  ['02', 'Wallet custody', 'Create and select the isolated local signer used by Trebuchet.'],
  ['03', 'Six launch phases', 'Inspect the detailed controls behind the Guided recipe.'],
  ['04', 'Token discovery', 'Review scored assets and the user-owned wallet graph.'],
  ['05', 'Recovery and history', 'Inspect resumable journals, wallets, audit evidence, and checkpoints.'],
  ['06', 'Runtime settings', 'Review RPC, security, release, and execution policy.'],
  ['07', 'CLI boundary', 'Use deterministic read-only planning, estimation, and proof verification.'],
];

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
    DEMO_TIME_SCALE: '0.12',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let serverOutput = '';
for (const stream of [server.stdout, server.stderr]) {
  stream.on('data', (chunk) => {
    serverOutput += chunk.toString();
    if (serverOutput.length > 40_000) serverOutput = serverOutput.slice(-40_000);
  });
}

const hold = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitForServer(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`Walkthrough server exited early.\n${serverOutput}`);
    try {
      const response = await fetch(`${baseUrl}/api/session`);
      if (response.ok) return;
    } catch {
      // The local server is still loading the Solana dependency graph.
    }
    await hold(200);
  }
  throw new Error(`Walkthrough server did not start.\n${serverOutput}`);
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited ${code}\n${stderr || stdout}`));
    });
  });
}

async function installTourLayer(page) {
  await page.addStyleTag({ content: `
    #treb-tour-caption,
    #treb-tour-chapter,
    #treb-tour-cursor,
    #treb-tour-cli { font-family: "JetBrains Mono", "SFMono-Regular", Consolas, monospace !important; }
    #treb-tour-caption {
      position: fixed; right: 24px; bottom: 20px; z-index: 2147483000;
      width: min(500px, calc(100vw - 48px)); padding: 13px 15px 14px;
      border: 1px solid #74f7a9; border-left-width: 4px; background: rgba(3, 7, 6, .96);
      color: #e5eee9; box-shadow: 0 14px 48px rgba(0,0,0,.48); pointer-events: none;
      opacity: 0; transform: translateY(12px); transition: opacity .22s ease, transform .22s ease;
    }
    #treb-tour-caption.show { opacity: 1; transform: translateY(0); }
    #treb-tour-caption small { display: block; margin-bottom: 5px; color: #74f7a9; font-size: 10px; font-weight: 800; letter-spacing: .12em; text-transform: uppercase; }
    #treb-tour-caption strong { display: block; color: #f4faf6; font-size: 18px; line-height: 1.2; letter-spacing: .02em; text-transform: uppercase; }
    #treb-tour-caption span { display: block; margin-top: 6px; color: #a5b4ac; font-size: 12px; line-height: 1.5; }
    #treb-tour-chapter,
    #treb-tour-cli {
      position: fixed; inset: 0; z-index: 2147483100; display: grid; place-items: center;
      padding: 70px; background: #030706; color: #e5eee9; pointer-events: none;
      opacity: 0; transition: opacity .25s ease;
    }
    #treb-tour-chapter.show,
    #treb-tour-cli.show { opacity: 1; }
    #treb-tour-chapter::before,
    #treb-tour-cli::before {
      content: ""; position: absolute; inset: 0; opacity: .32;
      background: linear-gradient(rgba(116,247,169,.08) 1px, transparent 1px), linear-gradient(90deg, rgba(116,247,169,.06) 1px, transparent 1px);
      background-size: 32px 32px;
    }
    #treb-tour-chapter > div,
    #treb-tour-cli > div { position: relative; width: min(920px, 100%); border-left: 4px solid #74f7a9; padding: 25px 30px; background: rgba(7,11,10,.92); }
    #treb-tour-chapter small { color: #74f7a9; font-size: 12px; font-weight: 800; letter-spacing: .15em; text-transform: uppercase; }
    #treb-tour-chapter h2 { margin: 8px 0 10px; font-size: 42px; line-height: 1.05; letter-spacing: .02em; text-transform: uppercase; }
    #treb-tour-chapter p { max-width: 68ch; margin: 0; color: #9bacA3; font-size: 16px; line-height: 1.55; }
    #treb-tour-cursor {
      position: fixed; z-index: 2147483200; width: 18px; height: 18px; margin: -9px 0 0 -9px;
      border: 2px solid #74f7a9; background: rgba(116,247,169,.22); pointer-events: none;
      transition: left .42s cubic-bezier(.2,.8,.2,1), top .42s cubic-bezier(.2,.8,.2,1), transform .12s ease;
    }
    #treb-tour-cursor.click { transform: scale(.62); background: #74f7a9; }
    .treb-tour-focus { outline: 2px solid #74f7a9 !important; outline-offset: 3px !important; box-shadow: 0 0 0 7px rgba(116,247,169,.12) !important; }
    #treb-tour-cli > div { display: grid; gap: 16px; }
    #treb-tour-cli h2 { margin: 0; color: #74f7a9; font-size: 26px; text-transform: uppercase; }
    #treb-tour-cli pre { margin: 0; padding: 20px; border: 1px solid #30433a; background: #050908; color: #dce9e2; font: 14px/1.65 "JetBrains Mono", monospace; white-space: pre-wrap; }
    #treb-tour-cli .cli-note { color: #91a199; font-size: 13px; line-height: 1.5; }
  ` });
  await page.evaluate(() => {
    const caption = document.createElement('aside');
    caption.id = 'treb-tour-caption';
    caption.innerHTML = '<small></small><strong></strong><span></span>';
    document.body.appendChild(caption);
    const chapter = document.createElement('section');
    chapter.id = 'treb-tour-chapter';
    chapter.innerHTML = '<div><small></small><h2></h2><p></p></div>';
    document.body.appendChild(chapter);
    const cursor = document.createElement('i');
    cursor.id = 'treb-tour-cursor';
    cursor.setAttribute('aria-hidden', 'true');
    cursor.style.left = '50vw';
    cursor.style.top = '50vh';
    document.body.appendChild(cursor);
    const cli = document.createElement('section');
    cli.id = 'treb-tour-cli';
    cli.innerHTML = '<div><h2></h2><pre></pre><span class="cli-note"></span></div>';
    document.body.appendChild(cli);
  });
}

async function caption(page, step, title, detail, duration = 1700) {
  await page.evaluate(({ step, title, detail }) => {
    const box = document.getElementById('treb-tour-caption');
    box.querySelector('small').textContent = step;
    box.querySelector('strong').textContent = title;
    box.querySelector('span').textContent = detail;
    box.classList.add('show');
  }, { step, title, detail });
  await hold(duration);
}

async function hideCaption(page) {
  await page.evaluate(() => document.getElementById('treb-tour-caption')?.classList.remove('show'));
  await hold(250);
}

async function chapter(page, number, title, detail, duration = 2400) {
  await hideCaption(page);
  if (captureStartedAt) {
    timeline.push({
      id: `chapter-${number}`,
      number,
      title,
      detail,
      startMs: Math.max(0, Date.now() - captureStartedAt - 450),
    });
  }
  await page.evaluate(({ number, title, detail }) => {
    const box = document.getElementById('treb-tour-chapter');
    box.querySelector('small').textContent = `Chapter ${number}`;
    box.querySelector('h2').textContent = title;
    box.querySelector('p').textContent = detail;
    box.classList.add('show');
  }, { number, title, detail });
  await hold(duration);
  await page.evaluate(() => document.getElementById('treb-tour-chapter')?.classList.remove('show'));
  await hold(450);
}

async function pointTo(page, locator) {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  if (!box) return;
  await page.evaluate(({ x, y }) => {
    const cursor = document.getElementById('treb-tour-cursor');
    cursor.style.left = `${x}px`;
    cursor.style.top = `${y}px`;
  }, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
  await locator.evaluate((element) => element.classList.add('treb-tour-focus'));
  await hold(520);
}

async function clearFocus(page) {
  await page.evaluate(() => document.querySelectorAll('.treb-tour-focus').forEach((element) => element.classList.remove('treb-tour-focus')));
}

async function clickStep(page, selector, step, title, detail, { after = 1100 } = {}) {
  const locator = page.locator(selector).first();
  await locator.waitFor({ state: 'visible', timeout: 25_000 });
  await caption(page, step, title, detail, 350);
  await pointTo(page, locator);
  await page.evaluate(() => document.getElementById('treb-tour-cursor')?.classList.add('click'));
  await locator.click();
  await hold(150);
  await page.evaluate(() => document.getElementById('treb-tour-cursor')?.classList.remove('click'));
  await clearFocus(page);
  await hold(after);
}

async function typeStep(page, selector, value, step, title, detail) {
  const locator = page.locator(selector).first();
  await locator.waitFor({ state: 'visible', timeout: 20_000 });
  await caption(page, step, title, detail, 300);
  await pointTo(page, locator);
  await locator.click();
  await locator.fill('');
  await locator.type(value, { delay: 55 });
  await clearFocus(page);
  await hold(650);
}

async function cliChapter(page) {
  const doctor = await run(process.execPath, ['packages/cli/bin/trebuchet.js', 'doctor', '--json']);
  const parsed = JSON.parse(doctor.stdout.trim());
  const lines = [
    '$ trebuchet doctor --json',
    `✓ CLI ${parsed.data.cliVersion} / Core ${parsed.data.coreVersion} / Node ${parsed.data.node.version}`,
    `✓ ${parsed.data.capabilities.join(' · ')}`,
    `transaction execution: ${parsed.data.transactionExecution ? 'enabled' : 'disabled'}`,
    '',
    '$ trebuchet plan build --config launch.json --out plan.json',
    '$ trebuchet plan verify plan.json',
    '$ trebuchet estimate --plan plan.json',
    '$ trebuchet proof verify proof.json',
  ];
  await hideCaption(page);
  await page.evaluate(({ lines }) => {
    const box = document.getElementById('treb-tour-cli');
    box.querySelector('h2').textContent = 'Stable automation surface';
    box.querySelector('pre').textContent = lines.join('\n');
    box.querySelector('.cli-note').textContent = 'The CLI is deliberately read-only today. Wallet custody and transaction execution stay in the guarded macOS application until the Core recovery contract is proven on funded devnet.';
    box.classList.add('show');
  }, { lines });
  await hold(6000);
  await page.evaluate(() => document.getElementById('treb-tour-cli')?.classList.remove('show'));
  await hold(400);
}

let browser;
let context;

try {
  await waitForServer();
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    recordVideo: {
      dir: recordingDir,
      size: { width: 1440, height: 900 },
    },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(25_000);
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
  ), null, { timeout: 60_000 });
  await installTourLayer(page);
  captureStartedAt = Date.now();
  timeline.push({
    id: 'intro',
    title: 'Trebuchet product walkthrough',
    startMs: 0,
  });

  await page.evaluate(() => {
    const chapterBox = document.getElementById('treb-tour-chapter');
    chapterBox.querySelector('small').textContent = 'Trebuchet product walkthrough';
    chapterBox.querySelector('h2').textContent = 'Launch locally. Verify every phase.';
    chapterBox.querySelector('p').textContent = 'A complete, transaction-free tour of Guided launch, the six Advanced phases, local wallet custody, discovery, recovery, settings, and the stable CLI boundary.';
    chapterBox.classList.add('show');
  });
  await hold(3400);
  await page.evaluate(() => document.getElementById('treb-tour-chapter')?.classList.remove('show'));
  await hold(500);

  await chapter(page, '01', 'Guided practice', 'Build and execute the minimal recipe in a local simulator. The same guarded operation graph runs, but no transaction is sent and no SOL is spent.');
  await caption(page, 'Guided · Welcome', 'One decision per screen', 'Guided mode hides the operator cockpit and begins with the smallest safe launch abstraction.', 1900);
  await clickStep(page, '[data-action="guided-next"]', 'Guided · Step 1', 'Start the tutorial', 'The four decisions are token identity, return wallet, starting value, and final review.');
  await typeStep(page, '[data-guided-field="name"]', 'Trebuchet Tour', 'Guided · Token', 'Name the token', 'Token identity becomes permanent when the mint is created.');
  await typeStep(page, '[data-guided-field="symbol"]', 'TBT', 'Guided · Token', 'Set the ticker', 'Trebuchet normalizes the ticker and enforces Solana metadata limits.');
  await caption(page, 'Guided · Token', 'Attach the token image', 'Images are validated and automatically compressed into the launch envelope.', 450);
  await page.setInputFiles('#tokenLogoFile', path.join(root, 'public', 'release-assets', 'frames', 'f01.png'));
  await page.waitForSelector('.guided-logo-button .guided-logo-mark img');
  await hold(1100);
  await clickStep(page, '[data-action="guided-next"]', 'Guided · Step 2', 'Choose the return wallet', 'This wallet never signs the launch. It receives Fee Keys, remaining tokens, and leftover SOL at the end.');
  await clickStep(page, '[data-action="guided-use-practice-wallet"]', 'Guided · Return wallet', 'Use the practice destination', 'The simulator supplies a safe destination so the full return step can be verified locally.');
  await clickStep(page, '[data-action="guided-next"]', 'Guided · Step 3', 'Choose value and liquidity', 'Starting market value derives the opening token price; liquidity budget selects Trebuchet’s minimal strategy.');
  await clickStep(page, '[data-action="guided-value-preset"][data-value="100000"]', 'Guided · Value', 'Select the starting target', 'The target guides the opening price. It is not a fee or a guaranteed valuation.');
  await clickStep(page, '[data-action="guided-budget-preset"][data-value="1"]', 'Guided · Liquidity', 'Use the lean 1 SOL recipe', 'One understandable core market keeps the launch minimal. Practice still spends zero SOL.');
  await clickStep(page, '[data-action="guided-next"]', 'Guided · Step 4', 'Review the complete recipe', 'The review translates every underlying operation into plain language before execution.');
  await caption(page, 'Guided · Review', 'Practice is transaction-free', 'Token creation, authority removal, liquidity, locks, return, and proof will all be simulated.', 1800);
  await clickStep(page, '[data-action="guided-practice"]', 'Guided · Execute', 'Run the practice launch', 'Trebuchet now checkpoints each guarded operation in order.', { after: 700 });
  await page.waitForFunction(() => document.querySelector('#guidedRunShell')?.textContent?.includes('Practice complete'), null, { timeout: 120_000 });
  await caption(page, 'Guided · Complete', 'The entire recipe passed', 'The simulator created the token, verified authorities, built and locked liquidity, returned assets, and saved a local record.', 3200);
  await clickStep(page, '[data-action="guided-edit-recipe"]', 'Guided · Complete', 'Return to the recipe', 'The completed practice record remains available while the recipe can be inspected or handed to Advanced mode.');

  await chapter(page, '02', 'Wallet custody', 'Trebuchet uses an isolated, app-managed signer. Personal wallets fund the launch and receive assets, but never sign launch execution.');
  await clickStep(page, '.guided-advanced-shortcut', 'Experience', 'Open Advanced mode', 'Advanced exposes the detailed controls underneath the same guarded plan.');
  await clickStep(page, '[data-view="wallet"]', 'Wallets', 'Open local custody', 'Wallet secrets stay on this Mac and can be protected by the Recovery PIN.');
  if (await page.locator('#accountList .account-row').count() === 0) {
    await clickStep(page, '#newVaultButton', 'Wallets', 'Create the launch wallet', 'Trebuchet generates and stores an isolated Solana signer locally.');
    await page.waitForSelector('#accountList .account-row');
  } else {
    await caption(page, 'Wallets', 'Practice wallet ready', 'The practice run created an isolated local signer and retained its recovery metadata.', 1800);
  }
  await clickStep(page, '#newVaultButton', 'Wallets', 'Create another local wallet', 'Trebuchet can manage multiple launch and recovery wallets without adding them to the public discovery limit.');
  await page.waitForFunction(() => document.querySelectorAll('#accountList .account-row').length >= 2);
  await caption(page, 'Wallets', 'Custody remains explicit', 'Copy the funding address, inspect balances, manage the Recovery PIN, or reveal a secret only during manual recovery.', 2200);

  await chapter(page, '03', 'Six launch phases', 'Advanced mode makes the full launch state machine visible: wallet, token and pools, funding, token creation, liquidity, and final proof.');
  await clickStep(page, '[data-view="launch"]', 'Phase 1 of 6', 'Choose the launch wallet', 'The selected Trebuchet wallet is the only signer for this run.');
  await clickStep(page, '.launch-workspace-tab[data-launch-workspace="wallet"]', 'Phase 1 of 6', 'Wallet', 'Unlocking the selected launch wallet advances directly to token and pool design.');
  await clickStep(page, '.launch-wallet-choice', 'Phase 1 → 2', 'Unlock and continue', 'A locked wallet opens the Recovery PIN gate; an already-ready wallet advances immediately.');
  await caption(page, 'Phase 2 of 6', 'Design token and pools', 'Set permanent identity, liquidity strategy, allocations, Fee Key recipients, and the final return wallet.', 2100);
  const recipeSummary = page.locator('.launch-design-details > summary');
  if (await recipeSummary.isVisible()) {
    await clickStep(page, '.launch-design-details > summary', 'Phase 2 · Advanced controls', 'Open liquidity and distribution', 'Optional controls remain grouped behind the simple default recipe.');
    await caption(page, 'Phase 2 · Return wallet', 'Every remaining asset has a destination', 'The Return wallet field receives Fee Keys, remaining tokens, and leftover SOL after launch.', 1800);
  }
  await clickStep(page, '.launch-workspace-tab[data-launch-workspace="fund"]', 'Phase 3 of 6', 'Estimate and fund', 'Trebuchet calculates rent, pool costs, liquidity SOL, and any quote-token requirements.');
  const estimateButton = page.locator('.classic-workspace-fund [data-action="estimate-funding"]');
  if (await estimateButton.count() && await estimateButton.first().isVisible()) {
    await clickStep(page, '.classic-workspace-fund [data-action="estimate-funding"]', 'Phase 3 · Estimate', 'Calculate the funding envelope', 'Only the isolated launch wallet should receive the estimated deposit.');
    await page.waitForSelector('.classic-workspace-fund .funding-task-address');
  }
  await caption(page, 'Phase 3 · Return wallet', 'Destination status is actionable', 'If history cannot infer the funding source, Set return wallet links directly back to the correct Phase 2 field.', 1900);
  await clickStep(page, '.launch-workspace-tab[data-launch-workspace="mint"]', 'Phase 4 of 6', 'Create token', 'Review the permanent mint facts, create metadata, and revoke mint, freeze, and update authorities.');
  await caption(page, 'Phase 4 · Guardrail', 'First irreversible phase', 'Trebuchet will not enable execution until the wallet, funding, destination, and preflight checks pass.', 2100);
  await clickStep(page, '.launch-workspace-tab[data-launch-workspace="liquidity"]', 'Phase 5 of 6', 'Create and lock liquidity', 'Create pools and positions, lock every required position, and deliver the resulting Fee Keys.');
  await caption(page, 'Phase 5 · Recovery', 'Every position is checkpointed', 'Interrupted runs resume from recorded pool, position, lock, and Fee Key evidence instead of repeating completed work.', 2100);
  await clickStep(page, '.launch-workspace-tab[data-launch-workspace="finish"]', 'Phase 6 of 6', 'Distribute, return, and prove', 'Run airdrops, transfer Fee Keys, sweep remaining assets, verify the launch wallet is empty, and save the dossier.');
  await caption(page, 'Phase 6 · Proof', 'Completion requires evidence', 'A launch is complete only after terminal sweep evidence, pool identities, authority facts, and the final report agree.', 2600);

  await chapter(page, '04', 'Token discovery', 'Discovery starts from wallets the user knows—including Trebuchet-managed wallets—then ranks the tokens found through that private graph.');
  await clickStep(page, '[data-view="discovery"]', 'Discovery', 'Open token intelligence', 'Saved token evidence combines Solana chain facts, market history, and the user’s wallet network.');
  await page.waitForSelector('#discoveryTable .discovery-row');
  await clickStep(page, '#discoveryTable .discovery-row', 'Discovery · Token', 'Inspect a scored asset', 'The evidence panel separates chain safety, confidence, concentration, liquidity, volume, and price motion.');
  await clickStep(page, '[data-discovery-pane="wallets"]', 'Discovery · Wallet tracking', 'Manage the seed network', 'There is no artificial wallet cap; scanning runs in visible concurrent batches.');
  await typeStep(page, '#discoveryWalletInput', '11111111111111111111111111111116', 'Discovery · Wallet tracking', 'Add a public wallet', 'Only the public address and optional local label are stored.');
  await typeStep(page, '#discoveryWalletLabelInput', 'Research wallet', 'Discovery · Wallet tracking', 'Give it a local label', 'Labels stay on this machine and make large tracking sets manageable.');
  await clickStep(page, '#discoveryWalletAddButton', 'Discovery · Wallet tracking', 'Track the wallet', 'Trebuchet-managed wallets remain automatic; watched wallets are explicit user choices.');
  await clickStep(page, '[data-discovery-pane="tokens"]', 'Discovery · Token feed', 'Return to discovered tokens', 'The scrollable feed can later be ranked by relevance, connections, or movement.');

  await chapter(page, '05', 'Recovery and history', 'Launch journals make interrupted work inspectable and resumable. Recovery never relies on a success toast alone.');
  await clickStep(page, '[data-view="history"]', 'History · Recovery', 'Open recovery', 'Trebuchet identifies active journals, unfinished wallets, and the next safe action.');
  await clickStep(page, '[data-history-pane="wallets"]', 'History · Wallets', 'Inspect recovery wallets', 'Wallet secrets, balances, reveal controls, and sweep actions remain tied to local custody.');
  await clickStep(page, '[data-history-pane="audit"]', 'History · Audit', 'Review guarded operations', 'The audit records what ran, what remains, and which evidence supports each phase.');
  await clickStep(page, '[data-history-pane="journal"]', 'History · Journal', 'Inspect checkpoints', 'The chronological journal is the durable source for resume and proof reconstruction.');

  await chapter(page, '06', 'Runtime settings', 'Execution policy, RPC health, local security, demo mode, release trust, and report preferences are visible in one place.');
  await clickStep(page, '[data-view="settings"]', 'Settings', 'Open runtime policy', 'Trebuchet distinguishes local custody and execution rules from display preferences.');
  await caption(page, 'Settings · RPC', 'Use a dedicated mainnet RPC for live pools', 'RPC health is checked locally. Public endpoints are suitable for reading but unreliable for CLMM creation.', 2200);
  await caption(page, 'Settings · Safety', 'Practice and live remain visually distinct', 'Practice spends zero SOL. Live execution stays guarded until funding, custody, and readiness checks pass.', 2200);

  await chapter(page, '07', 'CLI boundary', 'The stable headless surface handles deterministic plans, estimates, integrity checks, and proof verification—without wallet custody or transaction execution.');
  await cliChapter(page);

  timeline.push({
    id: 'outro',
    title: 'Walkthrough complete',
    startMs: Math.max(0, Date.now() - captureStartedAt - 450),
  });
  await page.evaluate(() => {
    const box = document.getElementById('treb-tour-chapter');
    box.querySelector('small').textContent = 'Walkthrough complete';
    box.querySelector('h2').textContent = 'One recipe. Six guarded phases.';
    box.querySelector('p').textContent = 'Guided mode provides the minimal path. Advanced mode exposes every control and proof. Practice validates the entire operation graph before any live funding is placed under Trebuchet control.';
    box.classList.add('show');
  });
  await hold(4200);

  await context.close();
  context = null;
  const recordings = (await readdir(recordingDir)).filter((file) => file.endsWith('.webm'));
  if (recordings.length !== 1) throw new Error(`Expected one browser recording, found ${recordings.length}.`);
  await rm(rawVideo, { force: true });
  await rename(path.join(recordingDir, recordings[0]), rawVideo);

  await run(ffmpeg, [
    '-y',
    '-ss', '0.45',
    '-i', rawVideo,
    '-c:v', 'libx264',
    '-preset', 'medium',
    '-crf', '19',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '-an',
    finalVideo,
  ]);
  await run(ffmpeg, [
    '-y',
    '-ss', '2.0',
    '-i', finalVideo,
    '-frames:v', '1',
    '-q:v', '2',
    poster,
  ]);
  await writeFile(storyboard, `# Trebuchet complete operations walkthrough\n\n${chapters.map(([number, title, detail]) => `${number}. **${title}** — ${detail}`).join('\n')}\n\nThe capture runs entirely in Trebuchet Practice/Demo mode. It sends no transaction and spends no SOL.\n`);
  await writeFile(timelineFile, `${JSON.stringify({
    capturedAt,
    trimOffsetMs: 450,
    events: timeline,
  }, null, 2)}\n`);
  console.log(finalVideo);
} catch (error) {
  if (serverOutput) process.stderr.write(`\n--- walkthrough server output ---\n${serverOutput}\n`);
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
