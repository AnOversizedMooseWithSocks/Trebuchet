import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

let importCounter = 0;

function makeTempConfigDir(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'trebuchet-personal-discovery-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function importFreshStore(configDir) {
  process.env.TREBUCHET_CONFIG_DIR = configDir;
  return import(new URL(`../discoveryStore.js?case=${++importCounter}`, import.meta.url));
}

test('personal Discovery store tracks public wallets without secret material', async (t) => {
  const configDir = makeTempConfigDir(t);
  const store = await importFreshStore(configDir);
  const address = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

  const added = store.upsertWallet(address, { label: '  Treasury   wallet  ' });
  assert.equal(added.label, 'Treasury wallet');
  assert.equal(added.source, 'watch-only');
  assert.equal(added.enabled, true);

  const promoted = store.upsertWallet(address, { source: 'managed', label: 'Imported wallet' });
  assert.equal(promoted.source, 'managed');
  assert.equal(store.listWallets().length, 1);

  const disk = JSON.parse(readFileSync(path.join(configDir, 'personalDiscovery.json'), 'utf8'));
  assert.equal(disk.wallets[0].publicKey, address);
  assert.equal(JSON.stringify(disk).includes('secret'), false);
});

test('personal Discovery stores thousands of watched and managed wallets without an artificial cap', async (t) => {
  const configDir = makeTempConfigDir(t);
  const rows = [
    ...Array.from({ length: 1_250 }, (_, index) => ({
      publicKey: `watch-${index}`,
      source: 'watch-only',
      label: `Watch ${index}`,
    })),
    ...Array.from({ length: 80 }, (_, index) => ({
      publicKey: `managed-${index}`,
      source: 'managed',
      label: `Managed ${index}`,
    })),
  ];
  writeFileSync(path.join(configDir, 'personalDiscovery.json'), JSON.stringify({ version: 1, wallets: rows, snapshot: null }));
  const store = await importFreshStore(configDir);

  const wallets = store.listWallets();
  assert.equal(wallets.filter((wallet) => wallet.source === 'watch-only').length, 1_250);
  assert.equal(wallets.filter((wallet) => wallet.source === 'managed').length, 80);
  assert.equal(store.PERSONAL_DISCOVERY_MAX_WATCH_ONLY_WALLETS, null);
});

test('load preserves every managed and watched wallet row', async (t) => {
  const configDir = makeTempConfigDir(t);
  const rows = [
    ...Array.from({ length: 32 }, (_, index) => ({ publicKey: `managed-${index}`, source: 'managed' })),
    ...Array.from({ length: 29 }, (_, index) => ({ publicKey: `watch-${index}`, source: 'watch-only' })),
  ];
  writeFileSync(path.join(configDir, 'personalDiscovery.json'), JSON.stringify({ version: 1, wallets: rows, snapshot: null }));
  const store = await importFreshStore(configDir);
  const wallets = store.listWallets();

  assert.equal(wallets.filter((wallet) => wallet.source === 'managed').length, 32);
  assert.equal(wallets.filter((wallet) => wallet.source === 'watch-only').length, 29);
});

test('promoting a watched wallet to managed preserves unique tracking', async (t) => {
  const configDir = makeTempConfigDir(t);
  const store = await importFreshStore(configDir);
  for (let index = 0; index < 25; index += 1) store.upsertWallet(`watch-${index}`);

  store.upsertWallet('watch-0', { source: 'managed' });
  assert.equal(store.upsertWallet('replacement-watch').source, 'watch-only');
  assert.equal(store.listWallets().filter((wallet) => wallet.source === 'watch-only').length, 25);
  assert.equal(store.listWallets().filter((wallet) => wallet.source === 'managed').length, 1);
});

test('personal Discovery store pauses, removes, and restores a bounded snapshot', async (t) => {
  const configDir = makeTempConfigDir(t);
  const store = await importFreshStore(configDir);
  const address = 'So11111111111111111111111111111111111111112';
  store.upsertWallet(address, { label: 'Main wallet' });

  assert.equal(store.setWalletEnabled(address, false).enabled, false);
  const snapshot = store.saveSnapshot({
    schema: 'trebuchet-personal-discovery/v1',
    completedAt: '2026-08-09T10:00:00.000Z',
    knownTokens: [{ mint: 'Known111' }],
    candidates: Array.from({ length: 12 }, (_, index) => ({ mint: `Candidate${index}` })),
    warnings: [],
  });
  assert.equal(snapshot.candidates.length, 10);
  assert.equal(store.getSnapshot().knownTokens[0].mint, 'Known111');
  assert.equal(store.removeWallet(address), true);
  assert.equal(store.getSnapshot(), null);
  assert.equal(store.removeWallet(address), false);
  assert.deepEqual(store.listWallets(), []);
});

test('personal Discovery store tolerates malformed disk state', async (t) => {
  const configDir = makeTempConfigDir(t);
  writeFileSync(path.join(configDir, 'personalDiscovery.json'), '{broken');
  const originalWarn = console.warn;
  console.warn = () => {};
  t.after(() => { console.warn = originalWarn; });
  const store = await importFreshStore(configDir);

  assert.deepEqual(store.listWallets(), []);
  assert.equal(store.getSnapshot(), null);
  assert.equal(existsSync(path.join(configDir, 'personalDiscovery.json')), true);
});
