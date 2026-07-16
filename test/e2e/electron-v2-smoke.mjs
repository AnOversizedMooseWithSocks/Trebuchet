#!/usr/bin/env node
// Electron runtime smoke for the v2-default desktop cutover.
//
// Source mode is useful locally. CI passes --packaged after electron-builder's
// Linux --dir build, so the same assertions cover the actual distributable
// file set and its bundled Express/v2 renderer integration.

import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { _electron as electron } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const packaged = process.argv.includes('--packaged');

function packagedExecutable() {
  const explicitIndex = process.argv.indexOf('--executable');
  if (explicitIndex >= 0 && process.argv[explicitIndex + 1]) {
    return path.resolve(process.argv[explicitIndex + 1]);
  }
  const candidates = [
    'dist/linux-unpacked/Trebuchet',
    'dist/linux-unpacked/trebuchet',
    'dist/mac-arm64/Trebuchet.app/Contents/MacOS/Trebuchet',
    'dist/mac/Trebuchet.app/Contents/MacOS/Trebuchet',
    'dist/win-unpacked/Trebuchet.exe',
    'dist/win-unpacked/trebuchet.exe',
  ].map((candidate) => path.join(root, candidate));
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) {
    throw new Error(`Packaged Trebuchet executable not found. Checked:\n${candidates.join('\n')}`);
  }
  return found;
}

async function launchRouteSmoke({ classic = false } = {}) {
  const profileDir = mkdtempSync(path.join(tmpdir(), `trebuchet-electron-${classic ? 'classic' : 'v2'}-`));
  const switches = [`--user-data-dir=${profileDir}`];
  if (classic) switches.push('--classic');
  if (process.platform === 'linux') switches.push('--no-sandbox');

  const env = { ...process.env, NODE_ENV: 'test' };
  delete env.TREBUCHET_UI;
  const options = packaged
    ? { executablePath: packagedExecutable(), args: switches, env }
    : { args: [root, ...switches], env };
  const electronApp = await electron.launch(options);
  try {
    const page = await electronApp.firstWindow({ timeout: 30_000 });
    const pageErrors = [];
    const nativeDialogs = [];
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('dialog', async (dialog) => {
      nativeDialogs.push(`${dialog.type()}: ${dialog.message()}`);
      await dialog.dismiss();
    });

    const expectedPath = classic ? '/' : '/v2/';
    await page.waitForFunction((pathname) => window.location.pathname === pathname, expectedPath, {
      timeout: 30_000,
    });
    assert.equal(new URL(page.url()).pathname, expectedPath);

    if (!classic) {
      await page.waitForFunction(() => (
        document.querySelector('#globalStrip')?.textContent?.includes('Local API connected')
      ), null, { timeout: 30_000 });
      await page.click('[data-view="wallet"]');
      await page.click('[data-action="import-wallet"]');
      await page.waitForSelector('#operatorPromptGate:not([hidden])');
      assert.equal(await page.getAttribute('#operatorPromptInput', 'type'), 'password');
      await page.fill('#operatorPromptInput', 'electron-smoke-secret');
      await page.keyboard.press('Escape');
      await page.waitForSelector('#operatorPromptGate', { state: 'hidden' });
      assert.equal(await page.inputValue('#operatorPromptInput'), '');
      assert.deepEqual(nativeDialogs, [], 'v2 Electron renderer opened a native dialog');
      assert.deepEqual(pageErrors, [], 'v2 Electron renderer emitted page errors');
    }
  } finally {
    await electronApp.close();
  }
}

await launchRouteSmoke();
await launchRouteSmoke({ classic: true });
console.log(`Electron route smoke passed (${packaged ? 'packaged' : 'source'}): v2 default, Classic fallback`);
