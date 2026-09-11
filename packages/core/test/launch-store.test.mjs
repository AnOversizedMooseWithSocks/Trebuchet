import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLaunchStore, normalizeSavedLaunchConfig } from '../src/launch-store.js';

function makeStore(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'trebuchet-launch-store-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return createLaunchStore({ filePath: path.join(dir, 'launches.json') });
}

function validConfig(overrides = {}) {
  return {
    token: { name: 'Fly Brain Connectome', symbol: 'FLYBRAIN', supply: '54500000', description: 'one token per synapse' },
    mode: 'guarded',
    launchSol: 1,
    walletPublicKey: '11111111111111111111111111111115',
    poolTopology: {
      targetMarketCapUsd: 250000,
      pools: [{
        quoteSymbol: 'SOL',
        quoteMint: 'So11111111111111111111111111111111111111112',
        supplyPercent: 90,
        distribution: [{ sharePercent: 100 }],
        ladder: { mode: 'off' },
        support: { mode: 'off' },
      }, {
        quoteSymbol: 'MEME',
        quoteMint: 'HipYKXiDh3Kjd1jb7ji6jCEsKQMSGWiFJMdtvH8yb5r',
        supplyPercent: 10,
        distribution: [{ sharePercent: 100 }],
        ladder: { mode: 'off' },
        support: { mode: 'off' },
      }],
      sweepDestination: 'AtPVyHp52LqHy1rnMu5fUx9eWpDMrr2DnC3C3mdFc54j',
    },
    vanity: { prefix: 'FLY', suffix: 'FLY', selectedPublicKey: 'FLY3ytMF4wyGQcVPo2RZ5FTFsf7JEBj4DrtucnRqrFLY' },
    ...overrides,
  };
}

test('save persists a launch so it survives a fresh store instance (restart)', (t) => {
  const store = makeStore(t);
  const saved = store.save({ name: 'FLYBRAIN launch', config: validConfig() });
  assert.ok(saved.id);
  assert.equal(saved.name, 'FLYBRAIN launch');
  assert.equal(saved.schema, 'trebuchet-saved-launch/v1');
  assert.equal(saved.config.token.symbol, 'FLYBRAIN');
  assert.equal(saved.config.vanity.selectedPublicKey, 'FLY3ytMF4wyGQcVPo2RZ5FTFsf7JEBj4DrtucnRqrFLY');
  assert.equal(saved.config.poolTopology.pools.length, 2);

  // A brand-new store over the same file (i.e. after an app restart) sees it.
  const restarted = createLaunchStore({ filePath: store.filePath });
  const listed = restarted.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, saved.id);
  assert.equal(listed[0].config.token.name, 'Fly Brain Connectome');
  assert.deepEqual(listed[0].config.vanity, { prefix: 'FLY', suffix: 'FLY', selectedPublicKey: 'FLY3ytMF4wyGQcVPo2RZ5FTFsf7JEBj4DrtucnRqrFLY' });

  // The file itself is valid JSON with the entry.
  const raw = JSON.parse(readFileSync(store.filePath, 'utf8'));
  assert.equal(raw.length, 1);
});

test('save with an existing id updates in place and keeps createdAt', (t) => {
  const store = makeStore(t);
  const first = store.save({ name: 'Draft', config: validConfig() });
  const updated = store.save({ id: first.id, name: 'FLYBRAIN v2', config: validConfig({ launchSol: 2 }) });
  assert.equal(updated.id, first.id);
  assert.equal(updated.createdAt, first.createdAt);
  assert.equal(updated.name, 'FLYBRAIN v2');
  assert.equal(updated.config.launchSol, 2);
  assert.equal(store.list().length, 1);
});

test('secret-like fields are stripped from saved configs', (t) => {
  const store = makeStore(t);
  store.save({
    name: 'sneaky',
    config: validConfig({ secretKey: [1, 2, 3], wallet: { privateKey: 'nope' } }),
  });
  const raw = readFileSync(store.filePath, 'utf8');
  assert.equal(raw.includes('secretKey'), false);
  assert.equal(raw.includes('privateKey'), false);
  assert.equal(raw.includes('nope'), false);
});

test('remove deletes only the requested launch', (t) => {
  const store = makeStore(t);
  const a = store.save({ name: 'A', config: validConfig() });
  const b = store.save({ name: 'B', config: validConfig() });
  assert.equal(store.remove(a.id), true);
  assert.deepEqual(store.list().map((entry) => entry.id), [b.id]);
  assert.equal(store.remove('missing'), false);
});

test('invalid configs are rejected with a useful message', (t) => {
  const store = makeStore(t);
  assert.throws(() => store.save({ config: { token: { name: 'x' } } }), /symbol|Symbol/);
  assert.throws(() => store.save({ config: validConfig({ token: { name: '', symbol: 'X', supply: '1' } }) }), /name/);
  assert.throws(() => store.save({ config: validConfig({ poolTopology: { pools: [] } }) }), /pool/);
  assert.throws(() => store.save({ config: validConfig({ vanity: { prefix: 'Fl y' } }) }), /Base58/);
});

test('normalizeSavedLaunchConfig normalizes token fields and supply', () => {
  const config = normalizeSavedLaunchConfig(validConfig({
    token: { name: '  Trimmed  ', symbol: ' TRIM ', supply: '1,000,000', description: '' },
  }));
  assert.equal(config.token.name, 'Trimmed');
  assert.equal(config.token.symbol, 'TRIM');
  assert.equal(config.token.supply, '1000000');
});

test('corrupt entries are skipped without breaking the list', (t) => {
  const store = makeStore(t);
  store.save({ name: 'Good', config: validConfig() });
  const raw = JSON.parse(readFileSync(store.filePath, 'utf8'));
  raw.push({ id: 'broken', config: { token: {} } });
  writeFileSync(store.filePath, JSON.stringify(raw));
  const listed = store.list();
  assert.equal(listed.length, 1);
  assert.equal(listed[0].name, 'Good');
});


test('updates preserve fields the launch form does not model', (t) => {
  const store = makeStore(t);
  const stored = store.save({
    name: 'FLYBRAIN',
    config: validConfig({
      walletPublicKey: 'WalletPreserve11111111111111111111111111111',
      poolTopology: {
        targetMarketCapUsd: 250000,
        pools: [
          { quoteSymbol: 'SOL', quoteMint: 'So11111111111111111111111111111111111111112', supplyPercent: 80, ammConfigIndex: 8 },
          {
            quoteSymbol: 'HONEY',
            quoteMint: '4vMsoUT2BWatFweudnQM1xedRLfJgJ7hswhcpz4xgBTy',
            supplyPercent: 10,
            ammConfigIndex: 3,
            quoteUsdOverride: 0.001381717,
          },
          { quoteSymbol: 'MEME', quoteMint: 'HipYKXiDh3Kjd1jb7ji6jCEsKQMSGWiFJMdtvH8yb5r', supplyPercent: 10, ammConfigIndex: 5 },
        ],
        sweepDestination: 'AtPVyHp52LqHy1rnMu5fUx9eWpDMrr2DnC3C3mdFc54j',
      },
    }),
  });

  // Simulate an auto-save from the form: pools reordered, CA dropped,
  // quote override absent, and no walletPublicKey.
  const updated = store.save({
    id: stored.id,
    name: 'FLYBRAIN edited',
    config: validConfig({
      token: { name: 'FLYBRAIN edited', symbol: 'FLYBRAIN', supply: '54500000', description: '' },
      walletPublicKey: undefined,
      vanity: { prefix: 'FLY', suffix: 'FLY', selectedPublicKey: null },
      poolTopology: {
        targetMarketCapUsd: 250000,
        pools: [
          { quoteSymbol: 'MEME', quoteMint: 'HipYKXiDh3Kjd1jb7ji6jCEsKQMSGWiFJMdtvH8yb5r', supplyPercent: 10, ammConfigIndex: 5 },
          {
            quoteSymbol: 'HONEY',
            quoteMint: '4vMsoUT2BWatFweudnQM1xedRLfJgJ7hswhcpz4xgBTy',
            supplyPercent: 10,
            ammConfigIndex: 3,
          },
          { quoteSymbol: 'SOL', quoteMint: 'So11111111111111111111111111111111111111112', supplyPercent: 80, ammConfigIndex: 8 },
        ],
        sweepDestination: 'AtPVyHp52LqHy1rnMu5fUx9eWpDMrr2DnC3C3mdFc54j',
      },
    }),
  });

  assert.equal(updated.name, 'FLYBRAIN edited');
  assert.equal(updated.config.vanity.selectedPublicKey, 'FLY3ytMF4wyGQcVPo2RZ5FTFsf7JEBj4DrtucnRqrFLY');
  assert.equal(updated.config.walletPublicKey, 'WalletPreserve11111111111111111111111111111');
  const honey = updated.config.poolTopology.pools.find((pool) => pool.quoteSymbol === 'HONEY');
  assert.equal(honey.quoteUsdOverride, 0.001381717);
  assert.equal(updated.config.poolTopology.pools.length, 3);
});
