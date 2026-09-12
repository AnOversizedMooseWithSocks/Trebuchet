import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Tests for userPrefs.js — the small JSON-backed store that holds
// user-toggleable settings (currently just checkForUpdatesOnStartup).
//
// Modelled on rpc-config.test.mjs:
//   - Each test gets a fresh temp dir as TREBUCHET_CONFIG_DIR.
//   - importFreshUserPrefs uses a query-string suffix so each test
//     gets a fresh module instance (Node caches dynamic imports by
//     URL, so the suffix forces a re-evaluation).
//   - t.after registers cleanup so even failing tests leave nothing
//     in /tmp.

let importCounter = 0;

function makeTempConfigDir(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'trebuchet-user-prefs-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function importFreshUserPrefs(configDir) {
  process.env.TREBUCHET_CONFIG_DIR = configDir;
  return import(new URL(`../userPrefs.js?case=${++importCounter}`, import.meta.url));
}

test('returns defaults when no preferences file exists', async (t) => {
  const configDir = makeTempConfigDir(t);
  const userPrefs = await importFreshUserPrefs(configDir);

  const prefs = userPrefs.get();
  // checkForUpdatesOnStartup defaults to true — opt-out, not opt-in.
  // If users had to opt in they'd never discover the feature exists.
  assert.equal(prefs.checkForUpdatesOnStartup, true);
  assert.equal(prefs.medievalCursor, false);
  assert.equal(prefs.medievalCursorOptIn, false);
  assert.equal(prefs.playBackgroundMusic, false);

  // Calling get() before any set() should not touch the disk. The
  // file is created lazily on the first set().
  assert.equal(existsSync(path.join(configDir, 'userPrefs.json')), false);
});

test('persists a single preference change to disk', async (t) => {
  const configDir = makeTempConfigDir(t);
  const userPrefs = await importFreshUserPrefs(configDir);

  const result = userPrefs.set({ checkForUpdatesOnStartup: false });
  assert.equal(result.checkForUpdatesOnStartup, false);

  // The returned object reflects the new state, and a re-read from
  // disk in this same process picks up the change too.
  assert.equal(userPrefs.get().checkForUpdatesOnStartup, false);

  // And the on-disk file matches.
  const onDisk = JSON.parse(readFileSync(path.join(configDir, 'userPrefs.json'), 'utf8'));
  assert.equal(onDisk.checkForUpdatesOnStartup, false);
});

test('round-trips multiple writes without losing or duplicating fields', async (t) => {
  const configDir = makeTempConfigDir(t);
  const userPrefs = await importFreshUserPrefs(configDir);

  userPrefs.set({ checkForUpdatesOnStartup: false });
  userPrefs.set({ checkForUpdatesOnStartup: true });
  userPrefs.set({ checkForUpdatesOnStartup: false });

  // The on-disk file should have exactly the schema keys — no leftover
  // state from previous writes, no duplicate entries. persist() always
  // writes the full DEFAULTS-shaped object, so we assert against the
  // current schema rather than just the one key we touched.
  const onDisk = JSON.parse(readFileSync(path.join(configDir, 'userPrefs.json'), 'utf8'));
  assert.deepEqual(
    Object.keys(onDisk).sort(),
    ['checkForUpdatesOnStartup', 'coinPreview', 'coinPreviewParked', 'demoMode', 'medievalCursor', 'medievalCursorOptIn', 'playIntroVideo', 'playSoundEffects', 'playBackgroundMusic', 'publishLaunchReport', 'showWelcomeCard'].sort(),
  );
  assert.equal(onDisk.checkForUpdatesOnStartup, false);
});

test('a separate process sees changes written by the first one', async (t) => {
  // Simulates: main.js reads prefs at startup, server.js writes them
  // via /api/user-prefs POST, app restarts, main.js reads the new
  // value. Each process gets its own module instance — we ape that
  // here with two fresh imports against the same temp dir.
  const configDir = makeTempConfigDir(t);
  const firstInstance = await importFreshUserPrefs(configDir);

  firstInstance.set({ checkForUpdatesOnStartup: false });

  const secondInstance = await importFreshUserPrefs(configDir);
  assert.equal(secondInstance.get().checkForUpdatesOnStartup, false);
});

test('rejects unknown keys without corrupting existing state', async (t) => {
  const configDir = makeTempConfigDir(t);
  const userPrefs = await importFreshUserPrefs(configDir);

  userPrefs.set({ checkForUpdatesOnStartup: false });
  userPrefs.set({ totallyMadeUpKey: 'evil', anotherFakeOne: 42 });

  const after = userPrefs.get();
  // Known key still holds the value we set.
  assert.equal(after.checkForUpdatesOnStartup, false);
  // Unknown keys never made it into the state.
  assert.equal('totallyMadeUpKey' in after, false);
  assert.equal('anotherFakeOne' in after, false);

  // And the on-disk file doesn't carry the junk forward either — it holds
  // exactly the schema keys.
  const onDisk = JSON.parse(readFileSync(path.join(configDir, 'userPrefs.json'), 'utf8'));
  assert.deepEqual(
    Object.keys(onDisk).sort(),
    ['checkForUpdatesOnStartup', 'coinPreview', 'coinPreviewParked', 'demoMode', 'medievalCursor', 'medievalCursorOptIn', 'playIntroVideo', 'playSoundEffects', 'playBackgroundMusic', 'publishLaunchReport', 'showWelcomeCard'].sort(),
  );
});

test('rejects type-mismatched values without corrupting existing state', async (t) => {
  const configDir = makeTempConfigDir(t);
  const userPrefs = await importFreshUserPrefs(configDir);

  // Seed a known good value.
  userPrefs.set({ checkForUpdatesOnStartup: true });

  // None of these should land — they're all wrong types for a boolean field.
  // Without the guard, a buggy client could write a string or number into
  // a place the rest of the app expects to find a boolean, and code that
  // does `if (prefs.x)` would have subtly wrong behaviour.
  userPrefs.set({ checkForUpdatesOnStartup: 'yes' });
  userPrefs.set({ checkForUpdatesOnStartup: 0 });
  userPrefs.set({ checkForUpdatesOnStartup: null });
  userPrefs.set({ checkForUpdatesOnStartup: undefined });
  userPrefs.set({ checkForUpdatesOnStartup: { nested: true } });

  assert.equal(userPrefs.get().checkForUpdatesOnStartup, true);
});

test('handles missing/garbage/non-object input gracefully', async (t) => {
  const configDir = makeTempConfigDir(t);
  const userPrefs = await importFreshUserPrefs(configDir);

  // None of these should throw, and none should change state from defaults.
  userPrefs.set();
  userPrefs.set(null);
  userPrefs.set(undefined);
  userPrefs.set('not an object');
  userPrefs.set(42);
  userPrefs.set(true);

  assert.equal(userPrefs.get().checkForUpdatesOnStartup, true);
});

test('tolerates a corrupted preferences file by falling back to defaults', async (t) => {
  const configDir = makeTempConfigDir(t);
  // Write garbage to the prefs file BEFORE loading the module, so the
  // initial load has to deal with it. Catches the case where a power-
  // cut or disk-full half-wrote the file.
  writeFileSync(path.join(configDir, 'userPrefs.json'), '{ this is not: valid json');

  const userPrefs = await importFreshUserPrefs(configDir);

  // We don't crash, we don't throw — we fall back to the defaults.
  // The corrupted file gets overwritten on the next successful set().
  const prefs = userPrefs.get();
  assert.equal(prefs.checkForUpdatesOnStartup, true);

  userPrefs.set({ checkForUpdatesOnStartup: false });
  const recovered = JSON.parse(readFileSync(path.join(configDir, 'userPrefs.json'), 'utf8'));
  assert.equal(recovered.checkForUpdatesOnStartup, false);
});

test('returns a fresh copy each time so callers cannot mutate internal state', async (t) => {
  const configDir = makeTempConfigDir(t);
  const userPrefs = await importFreshUserPrefs(configDir);

  const a = userPrefs.get();
  a.checkForUpdatesOnStartup = false;
  a.injectedField = 'evil';

  // A second get() should not see the mutation we made to the first
  // returned object. Otherwise, code that hangs onto a get() result
  // and mutates it would silently corrupt the prefs for everyone.
  const b = userPrefs.get();
  assert.equal(b.checkForUpdatesOnStartup, true);
  assert.equal('injectedField' in b, false);
});

test('fills missing keys from defaults when the file has partial data', async (t) => {
  const configDir = makeTempConfigDir(t);
  // An old version of the app (or a hand-edit) might have written a
  // prefs file with a subset of the current fields. Loading it should
  // not lose the missing fields — they should fall back to defaults.
  writeFileSync(path.join(configDir, 'userPrefs.json'), JSON.stringify({}));

  const userPrefs = await importFreshUserPrefs(configDir);
  const prefs = userPrefs.get();
  assert.equal(prefs.checkForUpdatesOnStartup, true);
  assert.equal(prefs.medievalCursor, false);
  assert.equal(prefs.medievalCursorOptIn, false);
  assert.equal(prefs.playBackgroundMusic, false);
});
