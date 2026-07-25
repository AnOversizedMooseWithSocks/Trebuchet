#!/usr/bin/env node
// test/e2e/ui-flows.mjs — E2E visual test suite, records video of each flow.
// Usage: node test/e2e/ui-flows.mjs [01 02 03 ...]

import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import net from 'node:net';

const TMP = fs.mkdtempSync(path.join(tmpdir(), 'treb-e2e-'));
process.env.TREBUCHET_CONFIG_DIR = TMP;
process.env.TREBUCHET_E2E_DETERMINISTIC = '1';
process.env.DEMO_TIME_SCALE = '0';
// Enable demo mode so token/LP creation uses the fast in-memory handler.
// Without this, fake test tokens can't resolve through Jupiter and the
// real token-creation path fails because the temp wallets have no SOL.
fs.writeFileSync(TMP + '/userPrefs.json', JSON.stringify({ demoMode: true, coinPreviewParked: true }));
process.env.PORT = String(await new Promise((res, rej) => {
  const s = net.createServer(); s.unref(); s.on('error', rej);
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
}));

const { Keypair, PublicKey, Transaction } = await import('@solana/web3.js');
const tokenService = await import('../../tokenService.js');
const lpService = await import('../../lpService.js');
const walletHelpers = await import('../../walletHelpers.js');
const swapService = await import('../../swapService.js');
const bip39 = await import('bip39');
const { derivePath } = await import('ed25519-hd-key');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VIDEOS = path.join(__dirname, 'videos');
fs.mkdirSync(VIDEOS, { recursive: true });
const visualPlatformArgIdx = process.argv.indexOf('--platform');
const VISUAL_PLATFORM = visualPlatformArgIdx >= 0 && process.argv[visualPlatformArgIdx + 1]
  ? process.argv[visualPlatformArgIdx + 1]
  : (process.env.TREBUCHET_VISUAL_PLATFORM || process.platform);
const SCREENSHOTS = path.join(
  __dirname,
  '..',
  '..',
  'test',
  'ui',
  VISUAL_PLATFORM === 'linux' ? 'golden-linux' : 'golden',
);
const GOLDEN_MODE = process.argv.includes('--golden');
const SCREENSHOT_MODE = process.argv.includes('--screenshots');
let tmpScreenshots = null;
if (GOLDEN_MODE) {
  try { fs.rmSync(SCREENSHOTS, { recursive: true }); } catch {}
  fs.mkdirSync(SCREENSHOTS, { recursive: true });
} else if (SCREENSHOT_MODE) {
  const screenshotsArgIdx = process.argv.indexOf('--screenshots');
  if (screenshotsArgIdx >= 0 && screenshotsArgIdx + 1 < process.argv.length) {
    tmpScreenshots = process.argv[screenshotsArgIdx + 1];
    fs.mkdirSync(tmpScreenshots, { recursive: true });
  } else {
    tmpScreenshots = fs.mkdtempSync(path.join(tmpdir(), 'treb-screenshots-'));
  }
}

let _pc = 0, _tc = 0;
const fB58 = () => { const b = new Uint8Array(32); let v = ++_pc + 1; for (let i = 0; i < 32 && v > 0; i++) { b[i] = v & 0xff; v = Math.floor(v / 256); } b[31] = b[31] || 1; return new PublicKey(b).toBase58(); };
const fC = () => ({ getBalance: async () => 5e9, getMinimumBalanceForRentExemption: async () => 890880, getAccountInfo: async () => ({ data: Buffer.alloc(0), owner: null }), getParsedAccountInfo: async () => ({ value: null }), getParsedTokenAccountsByOwner: async () => ({ value: [] }), getTokenAccountsByOwner: async () => ({ value: [] }), confirmTransaction: async () => ({ value: { err: null } }), sendTransaction: async () => 'f', getSignaturesForAddress: async () => [], getParsedTransaction: async () => null, getLatestBlockhash: async () => ({ blockhash: '1'.repeat(32), lastValidBlockHeight: 1 }) });
const fUmi = () => ({ identity: { publicKey: 'f' }, eddsa: { createKeypairFromSecretKey: () => ({ publicKey: 'f', secretKey: new Uint8Array(64) }) }, use() { return this; }, uploader: { async upload() { return ['https://a.test/i']; }, async uploadJson() { return 'https://a.test/m'; } } });
const mRay = () => ({ connection: fC(), clmm: { async createPool() { const id = fB58(); return { execute: async () => ({ txId: 't' + (++_tc) }), extInfo: { address: { id } } }; }, async getPoolInfoFromRpc(id) { return { poolInfo: { id, mintA: { address: fB58(), decimals: 9 }, mintB: { address: 'So11111111111111111111111111111111111111112', decimals: 9 }, config: { tickSpacing: 60 } }, poolKeys: { id } }; }, async getRpcClmmPoolInfo() { return { tickCurrent: 0, sqrtPriceX64: '79228162514264337593543950336', liquidity: '0' }; }, async openPositionFromBase() { return { execute: async () => ({ txId: 't' + (++_tc) }), extInfo: { nftMint: fB58() } }; }, async lockPosition() { return { execute: async () => ({ txId: 't' + (++_tc) }), extInfo: { nftMint: fB58() } }; } }, api: { async getClmmConfigs() { return [{ id: 'c1', index: 0, tickSpacing: 60, tradeFeeRate: 2500, protocolFeeRate: 120000, fundFeeRate: 40000 }]; } }, account: { async fetchWalletTokenAccounts() { return { tokenAccounts: [], tokenAccountRawInfos: [] }; } } });

tokenService.setConnectionFactoryForTests(() => fC());
tokenService.setTemporaryWalletGeneratorForTests(async () => {
  const mnemonic = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
  const seed = bip39.mnemonicToSeedSync(mnemonic);
  const derivedSeed = derivePath("m/44'/501'/0'/0'", seed.toString('hex')).key;
  const keypair = Keypair.fromSeed(derivedSeed);
  return {
    publicKey: keypair.publicKey.toBase58(),
    secretKey: Array.from(keypair.secretKey),
    mnemonic,
  };
});
tokenService.setUmiFactoryForTests(() => fUmi());
tokenService.setUploaderForTests(async () => 'https://a.test/i');
tokenService.refreshConnection();
lpService.setConnectionFactoryForTests(() => fC());
lpService.setSdkFactoryForTests(async () => mRay());
walletHelpers.setConnectionFactoryForTests(() => fC());
swapService.setConnectionFactoryForTests(() => fC());
swapService.setTradeApiForTests({
  async fetchQuote() { return { success: true, data: { inputAmount: '1000000', outputAmount: '500000' } }; },
  async fetchTransactions({ walletPubkey }) { const t = new Transaction(); t.feePayer = new PublicKey(walletPubkey); t.recentBlockhash = 'GfVcyD4kkTrj4bKc7WA9sZCYoRn3Qh8bBLqxMcV2mEr'; return [Buffer.from(t.compileMessage().serialize()).toString('base64')]; },
});

let SERVER = null;
const _o = console.log;
console.log = (...a) => { _o(...a); const m = a.join(' ').match(/Server running on (http:\/\/127\.0\.0\.1:\d+)/); if (m) SERVER = m[1]; };
await import('../../server.js');
for (let i = 0; i < 50 && !SERVER; i++) await new Promise(r => setTimeout(r, 100));
console.log = _o;
if (!SERVER) { console.error('Server did not start'); process.exit(1); }

const browser = await chromium.launch({
  headless: true,
  args: [
    '--font-render-hinting=none',
    '--force-device-scale-factor=1',
  ],
});
let passed = 0, failed = 0;

async function withPage(fn, size = 'desktop') {
  const vp = size === 'mobile' ? { width: 390, height: 844 } : { width: 1280, height: 900 };
  const ctx = await browser.newContext({
    viewport: vp,
    deviceScaleFactor: 1,
    colorScheme: 'light',
    reducedMotion: 'reduce',
    locale: 'en-US',
    timezoneId: 'UTC',
    recordVideo: { dir: VIDEOS, size: vp },
  });
  const p = await ctx.newPage();
  const shotLabel = withPage._shotLabel || '';
  try {
    // Intercept the HTML response and remove the splash screen markup
    // before the browser parses it — no video frames at all in the recording.
    await p.route('**/', async (route) => {
      try {
        const resp = await route.fetch();
        const ct = resp.headers()['content-type'] || '';
        if (ct.includes('text/html')) {
          let body = await resp.text();
          // Remove the splash screen div entirely (self-closing or paired tag)
          body = body.replace(/<div[^>]*id="splashScreen"[^>]*>[\s\S]*?<\/div>/i, '');
          await route.fulfill({ response: resp, body });
        } else {
          await route.fulfill({ response: resp });
        }
      } catch (e) {
        // CI occasionally closes a context while the next run's document
        // request is still being proxied. Let Playwright surface real
        // navigation failures through p.goto(), but do not let this async route
        // handler crash the entire E2E process with an uncaught ECONNRESET.
        try { await route.continue(); } catch {}
      }
    });

    await p.goto(SERVER, { waitUntil: 'domcontentloaded', timeout: 30000 });
    // Wait for the demo banner — confirms demo mode is active and the
    // page is fully loaded.  Without this, screenshots may capture a
    // half-loaded page mid-animation.
    try { await p.waitForSelector('#demoBanner', { state: 'visible', timeout: 15000 }); } catch {}

    // Dismiss the disclaimer modal as soon as it appears.
    try {
      await p.waitForSelector('#disclaimerAgreeCheck', { state: 'visible', timeout: 8000 });
      await p.click('#disclaimerAgreeCheck');
      await p.click('#disclaimerAgreeBtn');
    } catch {}

    // First real launch now requires a Recovery PIN before recoverable secrets
    // can be persisted. Later pages in the same E2E server session usually stay
    // unlocked, but this also handles an unlock prompt if one appears.
    await p.waitForFunction(() => {
      const modal = document.querySelector('#secretPinModal');
      const status = document.querySelector('#secretPinStatusText')?.textContent || '';
      return modal?.classList.contains('is-active') || status.startsWith('Unlocked');
    }, { timeout: 20000 });
    if (await p.locator('#secretPinModal.is-active #secretPinInput').count()) {
      await p.fill('#secretPinInput', '1234');
      if (await p.locator('#secretPinConfirmInput:visible').count()) {
        await p.fill('#secretPinConfirmInput', '1234');
      }
      await p.click('#secretPinSubmitBtn');
      await p.waitForFunction(() => {
        const modal = document.querySelector('#secretPinModal');
        return modal && !modal.classList.contains('is-active');
      }, { timeout: 15000 });
    }

    // Brief settle so the UI is interactive.
    await p.waitForTimeout(500);
    await fn(p);
    // Capture a screenshot after the flow for visual regression
    if (GOLDEN_MODE || SCREENSHOT_MODE) {
      const dest = GOLDEN_MODE ? SCREENSHOTS : tmpScreenshots;
      await p.addStyleTag({
        content: '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}',
      });
      await p.evaluate(() => window.scrollTo(0, 0));
      await p.evaluate(async () => {
        if (document.fonts?.ready) await document.fonts.ready;
      });
      await p.waitForTimeout(500);
      await p.screenshot({ path: path.join(dest, shotLabel + '.png'), fullPage: false });
    }
    return true;
  } catch (e) {
    console.error('  FAIL: ' + e.message.split('\n')[0]);
    return false;
  } finally {
    try { await p.close(); } catch {}
    await ctx.close();
  }
}

async function textOf(p, s) { return p.textContent(s).then(x => (x || '').trim()); }
async function stepIs(p, n) { await p.waitForSelector('#step' + n + '-card.is-active', { timeout: 15000 }); }
function ok(cond, msg) { if (!cond) throw new Error(msg); }

// Follow the same readiness contract as an operator: a flow fails if the app
// never enables the control. Demo endpoints are deterministic and offline.
async function clickWhenReady(p, selector) {
  await p.waitForSelector(selector, { state: 'visible', timeout: 30000 });
  await p.waitForFunction((sel) => {
    const button = document.querySelector(sel);
    return button instanceof HTMLButtonElement && button.disabled === false;
  }, selector, { timeout: 30000 });
  await p.click(selector);
}

// Shared: generate wallet and advance to step 2
async function genWallet(p) {
  await p.click('#generateWalletBtn'); await stepIs(p, 2);
}

async function fundDemoWallet(p) {
  await clickWhenReady(p, '#demoFundBtn');
  await p.waitForFunction(() => {
    const button = document.querySelector('#continueToTokenBtn');
    return button instanceof HTMLButtonElement && button.disabled === false;
  }, { timeout: 30000 });
}

async function createPoolsAfterReview(p) {
  await clickWhenReady(p, '#createLpBtn');
  await p.waitForSelector('#createLpConfirmModal.is-active', { state: 'visible', timeout: 30000 });
  await clickWhenReady(p, '#createLpConfirmProceedBtn');
}

const flows = {
  '01': {
    name: 'Wallet Generation',
    async run(p) {
      ok(await p.isVisible('#step1-card.is-active'), 'step 1 not active');
      ok(await p.isVisible('#generateWalletBtn'), 'gen btn missing');
      await p.click('#generateWalletBtn'); await stepIs(p, 2);
      const addr = await textOf(p, '#step1-summary');
      ok(addr.includes('…'), 'addr not in summary: ' + addr);
      // Verify the wallet address is a plausible Solana base58 pubkey
      const addrInput = await p.inputValue('#walletAddress');
      ok(addrInput.length >= 32 && addrInput.length <= 44, 'wallet addr bad length: ' + addrInput.length);
      ok(/^[1-9A-HJ-NP-Za-km-z]+$/.test(addrInput), 'wallet addr not base58');
      // Verify QR code is generated as a data URL
      const qrSrc = await p.getAttribute('#qrCode', 'src');
      ok(qrSrc && qrSrc.startsWith('data:image/'), 'QR code not data URL: ' + String(qrSrc).substring(0, 30));
    },
  },
  '02': {
    name: 'Pool Configuration',
    async run(p) {
      await genWallet(p);
      await p.fill('#tokenName', 'TestToken'); await p.fill('#tokenSymbol', 'TST');
      ok((await p.inputValue('#tokenName')) === 'TestToken', 'name not set');
      ok((await p.inputValue('#tokenSymbol')) === 'TST', 'symbol not set');
      // Wait for cost preview to become visible (debounced estimate on step 2)
      await p.waitForTimeout(2000);
      await p.waitForSelector('#costPreview:not(.hidden)', { timeout: 15000 });
      // Verify cost preview contains content
      const costText = await textOf(p, '#costPreview');
      ok(costText.length > 5, 'cost preview empty');
      // Verify the donut-chart visualization button exists
      ok(await p.isVisible('.button .fa-chart-pie'), 'donut chart btn missing');
    },
  },
  '03': {
    name: 'Funding',
    async run(p) {
      await genWallet(p);
      await p.fill('#tokenName', 'FundT'); await p.fill('#tokenSymbol', 'FND');
      await clickWhenReady(p, '#continueToFundingBtn'); await stepIs(p, 3);
      const addrText = await textOf(p, '#step3WalletAddr');
      ok(addrText.length > 20, 'addr missing');
      ok(/^[1-9A-HJ-NP-Za-km-z]+$/.test(addrText), 'step 3 addr not base58');
      ok(await p.isVisible('#step3QrCode'), 'QR missing');
      // Verify balance requirement rows are present
      ok(await p.isVisible('#balanceRows'), 'balance rows missing');
    },
  },
  '04': {
    name: 'Token Creation',
    async run(p) {
      await genWallet(p);
      await p.fill('#tokenName', 'MkToken'); await p.fill('#tokenSymbol', 'MKT');
      await clickWhenReady(p, '#continueToFundingBtn'); await stepIs(p, 3);
      await fundDemoWallet(p);
      await p.locator('#continueToTokenBtn').scrollIntoViewIfNeeded();
      await clickWhenReady(p, '#continueToTokenBtn'); await stepIs(p, 4);      await p.waitForTimeout(1000);
      await p.locator('#createTokenBtn').scrollIntoViewIfNeeded();
      await clickWhenReady(p, '#createTokenBtn');
      await p.waitForSelector('#tokenCreatedInfo', { state: 'visible', timeout: 60000 });
      ok((await textOf(p, '#tokenMintAddress')).length > 30, 'mint missing');
    },
  },
  '05': {
    name: 'LP Creation',
    async run(p) {
      await genWallet(p);
      await p.fill('#tokenName', 'LPToken'); await p.fill('#tokenSymbol', 'LPT');
      await clickWhenReady(p, '#continueToFundingBtn'); await stepIs(p, 3);
      await fundDemoWallet(p);
      await p.locator('#continueToTokenBtn').scrollIntoViewIfNeeded();
      await clickWhenReady(p, '#continueToTokenBtn'); await stepIs(p, 4);      await p.waitForTimeout(1000);
      await p.locator('#createTokenBtn').scrollIntoViewIfNeeded();
      await clickWhenReady(p, '#createTokenBtn');
      await p.waitForSelector('#tokenCreatedInfo', { state: 'visible', timeout: 60000 });
      try { await stepIs(p, 5); } catch {
        await p.locator('#continueToLpBtn').scrollIntoViewIfNeeded(); await clickWhenReady(p, '#continueToLpBtn'); await stepIs(p, 5);
      }
      await p.locator('#createLpBtn').scrollIntoViewIfNeeded(); await createPoolsAfterReview(p);
      const done = await Promise.race([
        p.waitForSelector('#lpDoneInfo', { state: 'visible', timeout: 60000 }).then(() => 'ok'),
        p.waitForSelector('#lpFailInfo', { state: 'visible', timeout: 60000 }).then(() => 'fail'),
      ]).catch(() => null);
      const failureDetail = done === 'fail' ? await textOf(p, '#lpFailInfo') : '';
      ok(done === 'ok', `LP did not complete successfully${failureDetail ? `: ${failureDetail}` : ''}`);
    },
  },
  '06': {
    name: 'Transfer UI',
    async run(p) {
      await genWallet(p);
      await p.fill('#tokenName', 'XferTkn'); await p.fill('#tokenSymbol', 'XFR');
      await clickWhenReady(p, '#continueToFundingBtn'); await stepIs(p, 3);
      await fundDemoWallet(p);
      await p.locator('#continueToTokenBtn').scrollIntoViewIfNeeded();
      await clickWhenReady(p, '#continueToTokenBtn'); await stepIs(p, 4);      await p.waitForTimeout(1000);
      await p.locator('#createTokenBtn').scrollIntoViewIfNeeded();
      await clickWhenReady(p, '#createTokenBtn');
      await p.waitForSelector('#tokenCreatedInfo', { state: 'visible', timeout: 60000 });
      try { await stepIs(p, 5); } catch {
        await p.locator('#continueToLpBtn').scrollIntoViewIfNeeded(); await clickWhenReady(p, '#continueToLpBtn'); await stepIs(p, 5);
      }
      await p.locator('#createLpBtn').scrollIntoViewIfNeeded(); await createPoolsAfterReview(p);
      await p.waitForSelector('#lpDoneInfo', { state: 'visible', timeout: 60000 });
      await clickWhenReady(p, '#continueToTransferBtn');
      await stepIs(p, 6);
    },
  },
  '07': {
    name: 'Cancel & Refund',
    async run(p) {
      await p.click('#generateWalletBtn');
      await p.waitForSelector('#step1-summary', { timeout: 15000 });
      ok(await p.isVisible('#cancelBtn'), 'cancel btn missing');
      // Cancel btn should be enabled after wallet generation
      ok(!(await p.isDisabled('#cancelBtn')), 'cancel btn should be enabled');
      await p.click('#cancelBtn');
      await p.waitForSelector('#cancelConfirmModal', { state: 'visible', timeout: 5000 });
      ok((await textOf(p, '#cancelConfirmTitle')).length > 0, 'cancel title empty');
      // Verify confirm + dismiss buttons exist in the modal
      ok(await p.isVisible('#cancelConfirmProceedBtn'), 'confirm btn missing');
      ok(await p.isVisible('#cancelConfirmDismissBtn'), 'dismiss btn missing');
      // Dismiss should close the modal
      await p.click('#cancelConfirmDismissBtn');
      await p.waitForSelector('#cancelConfirmModal', { state: 'hidden', timeout: 5000 });
      ok(await p.isHidden('#cancelConfirmModal'), 'modal still visible after dismiss');
    },
  },
  '08': {
    name: 'RPC Config',
    async run(p) {
      await p.click('#rpcSettingsToggle');
      await p.waitForSelector('#rpcSettingsPanel', { state: 'visible', timeout: 5000 });
      ok(await p.isVisible('#rpcSettingsPanel'), 'panel not open');
      ok(await p.isVisible('#addRpcBtn'), 'add btn missing');
      // Count existing rows
      const beforeRows = await p.locator('.rpc-row').count();
      // Remove an endpoint if one exists (test delete button)
      const delBtns = p.locator('.rpc-row button .fa-trash');
      if (await delBtns.count() > 0) {
        await delBtns.first().click();
        await p.waitForTimeout(300);
        const afterDel = await p.locator('.rpc-row').count();
        ok(afterDel < beforeRows, 'delete did not reduce row count');
      }
      // Test button should be visible on at least one row
      const testBtns = p.locator('.rpc-row button .fa-exchange-alt');
      if (await testBtns.count() > 0) {
        await testBtns.first().click();
        await p.waitForTimeout(2000);
      }
      await p.click('#rpcSettingsToggle');
      await p.waitForSelector('#rpcSettingsPanel', { state: 'hidden', timeout: 5000 });
    },
  },
  '09': {
    name: 'Startup',
    async run(p) {
      ok(await p.isVisible('#step1-card.is-active'), 'step 1 not active');
      ok(await p.isVisible('#activityLogHeader'), 'log missing');
      // Verify activity log has the ready message
      const logText = await textOf(p, '#activityLog');
      ok(logText.includes('Trebuchet'), 'log missing ready message');
      // Verify the launcher header is present
      ok(await p.isVisible('#rpcSettingsToggle'), 'RPC toggle missing');
      // Demo mode toggle lives inside the hidden RPC settings panel.
      // Open the panel so the toggle is visible, then close after.
      await p.click('#rpcSettingsToggle');
      await p.waitForSelector('#rpcSettingsPanel', { state: 'visible', timeout: 5000 });
      ok(await p.isVisible('#demoModeToggle'), 'demo toggle missing');
      await p.click('#rpcSettingsToggle');
    },
  },
};

const filter = process.argv.slice(2).filter(a => flows[a]);
const keys = filter.length ? filter : Object.keys(flows).sort();
const mobile = process.argv.includes('--mobile');
const sizes = mobile ? ['desktop', 'mobile'] : ['desktop'];

const total = keys.length * sizes.length;
console.log('\nTrebuchet E2E UI Flows — ' + total + ' recording(s)\n');

for (const size of sizes) {
  for (const key of keys) {
    const flow = flows[key];
    const label = size === 'mobile' ? key + '-mobile' : key;
    process.stdout.write('  [' + label + '] ' + flow.name + (size === 'mobile' ? ' (mobile)' : '') + ' ... ');
    // Tag screenshots with the flow label so they can be matched
    // against golden images by name.
    withPage._shotLabel = label;
    const ok_ = await withPage(flow.run, size);
    if (ok_) { passed++; console.log('PASS'); }
    else { failed++; }
  }
}

const allVids = fs.readdirSync(VIDEOS).filter(f => f.endsWith('.webm'))
  .map(f => ({ n: f, t: fs.statSync(path.join(VIDEOS, f)).mtimeMs }))
  .sort((a, b) => b.t - a.t);
const renames = [...allVids].reverse();
let ri = 0;
for (const size of sizes) {
  for (const key of keys) {
    if (ri >= renames.length) break;
    const flow = flows[key];
    const slug = flow.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const prefix = size === 'mobile' ? key + '-mobile-' : key + '-';
    try { fs.renameSync(path.join(VIDEOS, renames[ri].n), path.join(VIDEOS, prefix + slug + '.webm')); } catch {}
    ri++;
  }
}

await browser.close();

console.log('\n  ' + passed + ' passed, ' + failed + ' failed');
console.log('  Videos → ' + VIDEOS + '/\n');
// Convert videos to GIF if ffmpeg is available
const { execSync } = await import('node:child_process');
try {
  for (const f of fs.readdirSync(VIDEOS).filter(x => x.endsWith('.webm'))) {
    const name = path.join(VIDEOS, f.replace(/.webm$/, ''));
    const out = name + '.gif';
    execSync(`ffmpeg -y -ss 0.5 -i "${path.join(VIDEOS, f)}" -vf "fps=6,scale=640:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse" -loop 0 "${out}"`, { stdio: 'ignore' });
    console.log(`  gif → ${name}.gif`);
  }
} catch { /* ffmpeg not available */ }

process.exit(failed > 0 ? 1 : 0);
