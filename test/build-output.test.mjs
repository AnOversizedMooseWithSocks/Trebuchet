// Regression guard for the shipped public/app.js bundle.
//
// Two separate regressions shipped from rebuilding app.js out of stale module
// sources: (1) the public/api.js fetch wrapper was dropped, so every /api/*
// call was rejected with "invalid API session"; (2) the Advanced options,
// preallocation, and airdrop sections were dropped entirely, because
// public/modules/ is an INCOMPLETE extraction and the committed app.js is the
// real source of truth (it is thousands of lines ahead of the modules).
//
// These tests assert the load-bearing sections are present in the committed
// app.js, independent of how it was produced. They are coarse on purpose —
// they exist to catch a catastrophic "huge chunk of the app vanished" drift,
// not to test feature behavior. If a section here is ever intentionally
// removed, update the corresponding assertion.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appJs = readFileSync(path.join(ROOT, 'public/app.js'), 'utf8');

test('app.js installs the API session fetch wrapper', () => {
  // Without these the client sends no x-trebuchet-session header and every
  // mutating API call (including wallet generation) returns "invalid API session".
  assert.ok(appJs.includes('window.fetch ='), 'fetch override missing');
  assert.ok(appJs.includes('x-trebuchet-session'), 'session header attachment missing');
  assert.ok(appJs.includes('getApiSessionToken'), 'getApiSessionToken missing');
});

test('app.js contains the Advanced options section', () => {
  assert.ok(
    appJs.includes('simpleAdvancedDetails'),
    'the collapsible Advanced options section is missing from app.js',
  );
});

test('app.js contains the preallocation feature', () => {
  assert.ok(
    appJs.toLowerCase().includes('preallocation'),
    'the preallocation feature is missing from app.js',
  );
});

test('app.js contains the airdrop feature', () => {
  assert.ok(
    appJs.toLowerCase().includes('airdrop'),
    'the airdrop feature is missing from app.js',
  );
});

test('app.js contains the concept-help glossary', () => {
  // help.js: the HELP_TOPICS dictionary plus the delegated [data-explain]
  // click handler. If either is missing, every "what's this?" link in the
  // markup silently does nothing — worse than no link at all.
  assert.ok(
    appJs.includes('HELP_TOPICS'),
    'the help glossary is missing from app.js',
  );
  assert.ok(
    appJs.includes('data-explain'),
    'the [data-explain] delegation is missing from app.js',
  );
});

test('app.js does not contain the removed Solflare wallet bridge', () => {
  // The Solflare browser-wallet connection was removed deliberately: it
  // never signed anything (the launch always executes from the temporary
  // wallet), so its only effect was pre-filling the destination field —
  // not worth the extra UI surface and user confusion. Scanning the QR /
  // pasting the address covers the same need. This pin keeps a stale
  // branch or an old-bundle rebuild from silently reintroducing it.
  assert.ok(
    !appJs.includes('getSolflareProvider'),
    'the removed Solflare provider detection has reappeared in app.js',
  );
  assert.ok(
    !appJs.includes('getSolflareSigner'),
    'the removed Solflare signer bridge has reappeared in app.js',
  );
  assert.ok(
    !appJs.includes('solflareWalletPanel'),
    'the removed Solflare panel wiring has reappeared in app.js',
  );
});

test('app.js is not a truncated stale-module build', () => {
  // The full app.js is ~18k lines / ~830KB. A rebuild from the stale modules
  // produces ~12k lines / ~540KB. Guard against a regressed bundle slipping in.
  const bytes = Buffer.byteLength(appJs, 'utf8');
  assert.ok(
    bytes > 700 * 1024,
    `app.js is only ${Math.round(bytes / 1024)}KB — expected ~830KB. It may have ` +
    `been rebuilt from the incomplete public/modules/ extraction.`,
  );
});

test('computed numeric inputs declare step="any" so the browser cannot snap them', () => {
  // "Values jump around" regression. Both of these fields hold values the
  // APP computes, not just ones the user types:
  //   - preallocation %: auto-fit ceils to one decimal (e.g. 12.5)
  //   - support SOL: auto-back derives from USD and renders to 3 decimals
  // Declaring a coarser step ("1" / "0.1") makes the browser treat those
  // values as :invalid AND makes the spinner arrows snap to the nearest
  // grid point rather than increment from the current value — clicking up
  // on an auto-fit 12.5% jumped to 13%, silently dropping below the floor
  // the airdrop needed. step="any" disables the grid.
  const preallocIdx = appJs.indexOf('id="simplePreallocPctInput"');
  assert.ok(preallocIdx > 0, 'preallocation input must exist');
  const preallocTag = appJs.slice(Math.max(0, preallocIdx - 300), preallocIdx);
  assert.match(preallocTag, /step="any"/,
    'preallocation % holds auto-fit decimals — it must not declare an integer step');

  const supportIdx = appJs.indexOf('id="simpleSupportSolInput"');
  assert.ok(supportIdx > 0, 'support SOL input must exist');
  const supportTag = appJs.slice(Math.max(0, supportIdx - 300), supportIdx);
  assert.match(supportTag, /step="any"/,
    'support SOL holds auto-back decimals — it must not declare a 0.1 step');
});

test('percent and SOL fields in the pool editor are not snapped to a coarse grid', () => {
  // Same class as above, in customize mode. These fields receive values the
  // app computes to FOUR decimals (fitPositionsTo100 and the supply-rounding
  // pass both use toFixed(4)), or raw unrounded SOL values. Declaring
  // step="0.01" made the browser snap the spinner to the 0.01 grid — on a
  // fee-split slice that silently reassigns Fee Key ownership percentages.
  for (const marker of [
    'data-field="supplyPercent"',
    'class="input is-small slice-share"',
    'data-support-sol-value',
    'data-bs-sol-value',
  ]) {
    let idx = appJs.indexOf(marker);
    assert.ok(idx > 0, `${marker} must exist in the bundle`);
    while (idx > 0) {
      const tag = appJs.slice(Math.max(0, idx - 220), idx + marker.length);
      assert.doesNotMatch(tag, /step="0\.0*1"/,
        `${marker} must not declare a coarse step — computed values fall off the grid`);
      idx = appJs.indexOf(marker, idx + 1);
    }
  }
});

test('ladder multiplier fields may keep a 0.01 step because they are formatted onto it', () => {
  // Deliberate contrast with the test above: formatBandMultiplierValue rounds
  // to 2dp below 10, 1dp below 1000, integer above — always on the 0.01 grid.
  // This pin records that the exemption is reasoned, not an oversight.
  const idx = appJs.indexOf('data-field="lowerMultiplier"');
  assert.ok(idx > 0);
  assert.match(appJs.slice(Math.max(0, idx - 220), idx), /step="0\.01"/);
});

test('index.html carries the current markup (catches a stale merge of the page)', () => {
  // index.html is large and conflict-prone, and a merge that keeps the
  // OLD side passes every app.js test while shipping stale markup. That
  // happened: the Solflare panel (whose JS was deleted) reappeared in a
  // build because index.html was merged from the wrong side, leaving a
  // dead "Connect Solflare" button on step 1. Each line below is a
  // feature whose markup lives ONLY in index.html; if any is missing, the
  // page is not the one this bundle was built for.
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

  // Removed markup must stay removed.
  assert.doesNotMatch(html, /solflareWalletPanel|Connect Solflare|connectSolflareBtn/,
    'the Solflare panel was removed; its markup must not be present');

  // Added markup must be present.
  for (const [marker, feature] of [
    ['id="welcomeCard"', 'first-launch welcome card'],
    ['id="rpcSectionAnchor"', 'RPC explainer / settings anchor'],
    ['id="settingsSetupPill"', 'RPC-setup-needed pill on the settings header'],
    ['class="demo-champion"', 'demo-mode champion styling in settings'],
    ['id="revokeMetadataToggle"', 'metadata-authority option'],
    ['data-explain="', 'concept-help links'],
    ['id="createLpConfirmRefreshBtn"', 'Refresh prices button on the pool-confirm modal'],
    ['max 200×200 px', 'logo size label'],
  ]) {
    assert.ok(html.includes(marker), `index.html is missing the ${feature} (${marker})`);
  }
});
