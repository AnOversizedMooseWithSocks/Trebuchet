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
