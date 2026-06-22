import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import * as secretStore from '../secretStore.js';

let importCounter = 0;

function makeTempConfigDir(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'trebuchet-vanity-ca-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function importFreshStore(configDir) {
  process.env.TREBUCHET_CONFIG_DIR = configDir;
  return import(new URL(`../vanityCaStore.js?case=${++importCounter}`, import.meta.url));
}

function storeFile(configDir) {
  return path.join(configDir, 'vanityCAs.json');
}

async function withMutedConsole(fn) {
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.warn = originalWarn;
  }
}

test('persists vanity CA candidates without exposing secret metadata in listMetadata', async (t) => {
  await withMutedConsole(async () => {
    const configDir = makeTempConfigDir(t);
    secretStore.lockSecretPin();
    secretStore.setSafeStorage(null);
    const store = await importFreshStore(configDir);

    store.add({
      publicKey: 'Vanity111111111111111111111111111111111',
      secretKey: [1, 2, 3],
      rarity: 'Common',
      attempts: 42,
      epochs: 0.7,
      target: 'Van...111',
      prefix: 'Van',
      suffix: '111',
      mode: 'both',
    });

    assert.deepEqual(store.get('Vanity111111111111111111111111111111111').secretKey, [1, 2, 3]);
    assert.deepEqual(store.listMetadata(), [
      {
        publicKey: 'Vanity111111111111111111111111111111111',
        createdAt: store.list()[0].createdAt,
        rarity: 'Common',
        epochs: 0.7,
        attempts: 42,
        expectedAttempts: null,
        target: 'Van...111',
        prefix: 'Van',
        suffix: '111',
        mode: 'both',
        hasSecretKey: true,
        decryptionFailed: false,
        persisted: true,
      },
    ]);

    const disk = JSON.parse(readFileSync(storeFile(configDir), 'utf8'));
    assert.equal(disk[0].secretKey, undefined);
    assert.equal(disk[0].secretKeyEnc, 'plain:[1,2,3]');

    store.remove('Vanity111111111111111111111111111111111');
    assert.deepEqual(store.list(), []);
  });
});

test('stores vanity CA secrets with the configured Recovery PIN', async (t) => {
  await withMutedConsole(async () => {
    const configDir = makeTempConfigDir(t);
    process.env.TREBUCHET_CONFIG_DIR = configDir;
    secretStore.setSafeStorage(null);
    secretStore.setupSecretPin('1357');
    t.after(() => secretStore.lockSecretPin());
    const store = await importFreshStore(configDir);

    store.add({
      publicKey: 'PinVanity1111111111111111111111111111111',
      secretKey: [9, 8, 7],
      rarity: 'Rare',
    });

    const disk = JSON.parse(readFileSync(storeFile(configDir), 'utf8'));
    assert.match(disk[0].secretKeyEnc, /^pin:/);
    assert.deepEqual(store.get('PinVanity1111111111111111111111111111111').secretKey, [9, 8, 7]);

    secretStore.lockSecretPin();
    assert.equal(store.get('PinVanity1111111111111111111111111111111').secretKey, undefined);
    assert.equal(store.listMetadata()[0].decryptionFailed, true);

    assert.equal(secretStore.unlockSecretPin('1357'), true);
    assert.deepEqual(store.get('PinVanity1111111111111111111111111111111').secretKey, [9, 8, 7]);
  });
});
