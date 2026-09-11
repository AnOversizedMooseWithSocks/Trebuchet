import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  DEFAULT_MEME_FLYWHEEL_MINTS,
  createFlywheelPoolStore,
  pickFlywheelMint,
} from '../src/flywheel-pools.js';

const FLYBRAIN = 'FLY3ytMF4wyGQcVPo2RZ5FTFsf7JEBj4DrtucnRqrFLY';

function makeStore(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'trebuchet-flywheel-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return createFlywheelPoolStore({ filePath: path.join(dir, 'flywheelPools.json') });
}

test('the seeded meme pool contains the sample memecoins', () => {
  assert.ok(DEFAULT_MEME_FLYWHEEL_MINTS.includes('HipYKXiDh3Kjd1jb7ji6jCEsKQMSGWiFJMdtvH8yb5r'));
  assert.ok(DEFAULT_MEME_FLYWHEEL_MINTS.includes('FLFLJp1XTPrY7iLoKXZ9ZVZHGfxZMQMdPZtZCxfjHtsm'));
  assert.ok(DEFAULT_MEME_FLYWHEEL_MINTS.includes('2vGfseKJFt6iakqFrWoeDdSz8dweWYk5xPXV9uvVXRAT'));
  assert.ok(DEFAULT_MEME_FLYWHEEL_MINTS.includes(FLYBRAIN));
  assert.equal(DEFAULT_MEME_FLYWHEEL_MINTS.length, 4);
});

test('picking is random, bounded, and avoids the last pick when it can', () => {
  const mints = ['A'.repeat(32), 'B'.repeat(32), 'C'.repeat(32)];
  assert.equal(pickFlywheelMint(mints, { random: () => 0 }), 'A'.repeat(32));
  assert.equal(pickFlywheelMint(mints, { random: () => 0.99 }), 'C'.repeat(32));
  const avoided = pickFlywheelMint(mints, { random: () => 0, last: 'A'.repeat(32) });
  assert.notEqual(avoided, 'A'.repeat(32));
  assert.equal(pickFlywheelMint([], {}), null);
});

test('the store starts from defaults and persists edits', (t) => {
  const store = makeStore(t);
  assert.equal(store.get('meme').length, 4);

  store.add('meme', 'D'.repeat(32));
  assert.ok(store.get('meme').includes('D'.repeat(32)));

  // A fresh store over the same file (app restart) sees the edit.
  const restarted = createFlywheelPoolStore({ filePath: store.filePath });
  assert.ok(restarted.get('meme').includes('D'.repeat(32)));

  assert.equal(restarted.remove('meme', 'D'.repeat(32)), true);
  assert.equal(restarted.remove('meme', 'D'.repeat(32)), false);
  assert.throws(() => restarted.add('meme', 'not-a-mint'), /valid Solana mint/);
});

test('pick remembers the last selection so shuffles vary', (t) => {
  const store = makeStore(t);
  const first = store.pick('meme', { random: () => 0 });
  assert.equal(store.lastPick('meme'), first);
  const second = store.pick('meme', { random: () => 0, last: first });
  assert.notEqual(second, first);
});

test('a pool can never be emptied', (t) => {
  const store = makeStore(t);
  const mints = store.get('meme');
  for (const mint of mints.slice(1)) store.remove('meme', mint);
  assert.throws(() => store.remove('meme', mints[0]), /at least one mint/);
});
