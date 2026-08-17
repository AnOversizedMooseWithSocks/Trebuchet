// test/packaging-integrity.test.mjs
//
// Guards the asar packaging arrays. Root-level .js modules must be listed in
// BOTH package.json `files` and `build.files`, or electron-builder silently
// omits them and the packaged app crashes on import at runtime — while dev
// mode (which reads from disk) works perfectly. That failure mode has bitten
// this repo before and is invisible until someone installs a build.
//
// The check is derived, not hardcoded: it walks the actual import graph from
// the app's entry points, so a NEW module added in a future commit is covered
// automatically without anyone remembering to update a list.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

// Entry points: everything the packaged app can start from.
const ENTRY_POINTS = ['main.js', 'server.js'];

// Modules that intentionally ship unreferenced by the import graph.
// Anything listed here must have a reason recorded next to it.
const INTENTIONALLY_UNPACKAGED = new Set([
  // Superseded by the equivalent (and materially different) implementations
  // inline in server.js — mergePriorResults / materializePhase1RecoveryResults.
  // Imported only by test/launch-recovery.test.mjs. Kept on disk pending a
  // decision to delete it or re-adopt it; must NOT be treated as runtime code.
  'launchRecovery.js',
]);

// Resolve the set of root-level .js files reachable from the entry points by
// static `import ... from './x.js'` / `import('./x.js')` specifiers.
function reachableRootModules() {
  const seen = new Set();
  const queue = [...ENTRY_POINTS];
  while (queue.length > 0) {
    const file = queue.shift();
    if (seen.has(file)) continue;
    seen.add(file);
    let src;
    try {
      src = readFileSync(path.join(ROOT, file), 'utf8');
    } catch {
      continue; // not a root file (e.g. a subdirectory module) — ignore
    }
    // Match relative specifiers that resolve to a sibling root module.
    const re = /from\s+['"]\.\/([\w.-]+\.js)['"]|import\(\s*['"]\.\/([\w.-]+\.js)['"]/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const dep = m[1] || m[2];
      if (dep && !seen.has(dep)) queue.push(dep);
    }
  }
  return seen;
}

test('every runtime root module is listed in both packaging arrays', () => {
  const files = new Set(pkg.files || []);
  const buildFiles = new Set((pkg.build && pkg.build.files) || []);
  const reachable = reachableRootModules();

  const missingFromFiles = [];
  const missingFromBuildFiles = [];
  for (const mod of reachable) {
    if (!files.has(mod)) missingFromFiles.push(mod);
    if (!buildFiles.has(mod)) missingFromBuildFiles.push(mod);
  }

  assert.deepEqual(
    missingFromFiles, [],
    'these modules are imported at runtime but missing from package.json "files" — '
    + 'asar will omit them and the packaged app will crash on import',
  );
  assert.deepEqual(
    missingFromBuildFiles, [],
    'these modules are imported at runtime but missing from package.json "build.files"',
  );
});

test('no root module is silently unreferenced without being declared so', () => {
  // The inverse guard: a root .js file that nothing imports is either dead
  // code or an accidentally-orphaned module. Either way it should be a
  // deliberate, recorded decision rather than a silent state.
  const reachable = reachableRootModules();
  const rootJs = readdirSync(ROOT)
    .filter((f) => f.endsWith('.js'))
    .filter((f) => statSync(path.join(ROOT, f)).isFile());

  const orphans = rootJs
    .filter((f) => !reachable.has(f))
    .filter((f) => !INTENTIONALLY_UNPACKAGED.has(f));

  assert.deepEqual(
    orphans, [],
    'these root modules are imported by nothing — delete them, wire them up, or '
    + 'add them to INTENTIONALLY_UNPACKAGED with a reason',
  );
});

test('packaging arrays do not list files that no longer exist', () => {
  // A stale entry is harmless to electron-builder but misleads anyone reading
  // the manifest to understand what ships.
  const listed = new Set([...(pkg.files || []), ...((pkg.build && pkg.build.files) || [])]);
  const missing = [...listed]
    .filter((f) => f.endsWith('.js') && !f.includes('/') && !f.includes('*'))
    .filter((f) => {
      try { return !statSync(path.join(ROOT, f)).isFile(); } catch { return true; }
    });

  assert.deepEqual(missing, [], 'packaging arrays reference files that do not exist');
});
