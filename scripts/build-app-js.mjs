#!/usr/bin/env node
// Builds public/app.js by concatenating public/modules/* in a fixed order.
//
// app.js is a GENERATED artifact — edit the module sources, never app.js
// directly. The build is a pure byte-for-byte concatenation: each module file
// already carries its own leading banner and trailing blank line exactly as it
// should appear in app.js, so the modules are simply joined in order with no
// added header or separators. (The file-level header comment and the inline
// API-session fetch wrapper both live at the top of preamble.js, which is why
// there is no separate prelude file here anymore — the old public/api.js was a
// parallel artifact that never actually produced the shipped app.js.)
//
// This module is also imported by nothing at runtime; test/build-output.test.mjs
// guards the shipped app.js by content. Run `npm run build:js` after editing a
// module, and commit the regenerated app.js.
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

// Concatenation order — this is the canonical structure of app.js. Each module
// owns a contiguous slice of the original hand-written app.js.
export const moduleNames = [
  'preamble.js',          // file header, bind(), API-session fetch wrapper, state, constants, flywheels
  'activity-log.js',      // log(), startServerLogStream(), setLoading(), withRunState()
  'confirm-dialog.js',    // confirmDialog()
  'release-notes.js',     // renderReleaseNotes() — update check UI
  'step-orchestrator.js', // setStepState(), activateStep(), bindStepHeaders()
  'cancel-flow.js',       // openCancelConfirm(), showCancelledPanel()
  'rpc-panel.js',         // loadRpcConfig(), renderRpcConfig(), selectRpc()
  'wallet-gen.js',        // wallet generation UI, mnemonic grid
  'solflare-wallet.js',   // Solflare browser wallet connection + signer bridge
  'token-config.js',      // addPool(), renderSimpleConfig() incl. Advanced options section
  'coin-preview.js',      // updateCoinPreview(), flywheel explainer modal
  'depth-chart.js',       // computeDepthProfile(), renderDepthChartSvg() — per-pool liquidity depth
  'pool-editor.js',       // renderTokenPreview(), renderPools(), cost preview, allocations, preallocation arcs
  'tokenomics.js',        // showTokenomicsModal(), donut chart
  'launch-report.js',     // buildLaunchReportHtml() incl. airdrop section, downloadLaunchReport()
  'funding.js',           // renderFundingRequirements(), startBalancePolling(), acquire flow
  'lp-execution.js',      // LP creation, phase progress, lock summary, base58 decoder
  'transfer.js',          // runTransfer(), airdrop result rendering (Step 6)
  'journals.js',          // loadLaunchJournals(), resume
  'pending-wallets.js',   // loadPendingWallets()
  'startup.js',           // setupDisclaimer(), setupSplashScreen(), startup gates
  'audio.js',             // click sound effects + looping background music
];

// Absolute paths, in concatenation order, of every source that goes into the
// bundle. Exported so tooling/tests can reference them.
export const modulePaths = moduleNames.map((n) => join(root, 'public/modules', n));
export const sourcePaths = modulePaths;

export const APP_JS_PATH = join(root, 'public/app.js');

// Concatenate all module sources into the app.js string (no file write). Pure
// concatenation — the modules tile app.js exactly, so nothing is inserted
// between them.
export function buildAppJsString() {
  let out = '';
  for (const p of modulePaths) {
    out += readFileSync(p, 'utf8');
  }
  return out;
}

// Write the bundle to disk. Returns the byte length written.
//
// SAFETY GUARD: refuse to overwrite app.js when a rebuild would shrink it
// dramatically. A >15% shrink almost always means a module went missing or was
// truncated (the failure mode that once dropped the Advanced/preallocation/
// airdrop sections and the session wrapper). Set TREBUCHET_ALLOW_SHRINK=1 to
// override when a large reduction is genuinely intended.
export function buildAppJs() {
  const out = buildAppJsString();
  let existing = '';
  try { existing = readFileSync(APP_JS_PATH, 'utf8'); } catch { /* first build */ }
  const allowShrink = process.env.TREBUCHET_ALLOW_SHRINK === '1';
  if (existing && !allowShrink && out.length < existing.length * 0.85) {
    const pct = Math.round((1 - out.length / existing.length) * 100);
    throw new Error(
      `Refusing to write public/app.js: the rebuilt bundle is ${pct}% smaller ` +
      `than the existing file (${existing.length} → ${out.length} bytes). ` +
      `A module is probably missing or truncated. Set TREBUCHET_ALLOW_SHRINK=1 ` +
      `if this shrink is genuinely intended.`,
    );
  }
  writeFileSync(APP_JS_PATH, out);
  return out.length;
}

// CLI entry: only write when run directly (not when imported).
const invokedDirectly = process.argv[1] && process.argv[1].endsWith('build-app-js.mjs');
if (invokedDirectly) {
  const bytes = buildAppJs();
  const kb = (bytes / 1024).toFixed(0);
  console.log(`Built public/app.js from ${moduleNames.length} modules (${kb} KB)`);
}
