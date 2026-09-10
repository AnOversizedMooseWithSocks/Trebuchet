#!/usr/bin/env node
// scripts/apply-deletions.mjs
//
// Extracting a delivered zip over an existing checkout can only ADD and
// OVERWRITE files — it can never remove one. Any file deleted upstream
// therefore survives in the target tree, where it keeps running in the
// test suite and keeps shipping. That is exactly how a deleted dead module
// (launchRecovery.js) and its retired test suite came back from the dead
// and failed CI's packaging-integrity check.
//
// This script reads DELETIONS.txt (one repo-relative path per line, '#'
// comments allowed) and removes any listed file that still exists. Run it
// once after extracting a delivery:
//
//     node scripts/apply-deletions.mjs
//
// It refuses paths that escape the repo root and never touches anything
// not listed. Safe to re-run; already-absent entries are reported as such.

import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const manifest = path.join(ROOT, 'DELETIONS.txt');

if (!existsSync(manifest)) {
  console.log('No DELETIONS.txt — nothing to apply.');
  process.exit(0);
}

const lines = readFileSync(manifest, 'utf8')
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'));

let removed = 0;
for (const rel of lines) {
  const abs = path.resolve(ROOT, rel);
  if (!abs.startsWith(ROOT + path.sep)) {
    console.error(`REFUSED (outside repo): ${rel}`);
    process.exitCode = 1;
    continue;
  }
  if (existsSync(abs)) {
    rmSync(abs, { force: true });
    removed += 1;
    console.log(`removed  ${rel}`);
  } else {
    console.log(`absent   ${rel}`);
  }
}
console.log(`\n${removed} file(s) removed.`);
