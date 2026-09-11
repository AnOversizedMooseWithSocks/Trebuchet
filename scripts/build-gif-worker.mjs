#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = join(root, 'public', 'gif-optimizer.js');
const workerPath = join(root, 'public', 'gif-optimizer-worker.js');
const source = readFileSync(sourcePath, 'utf8');
const functionStart = source.indexOf('  function gifOptimizerWorker() {');
const nextFunction = source.indexOf('\n  async function optimizeAnimatedGif', functionStart);

if (functionStart < 0 || nextFunction < 0) {
  throw new Error('Could not locate gifOptimizerWorker in public/gif-optimizer.js');
}

const declaration = source.slice(functionStart, nextFunction).trim();
const bodyStart = declaration.indexOf('{') + 1;
const bodyEnd = declaration.lastIndexOf('}');
const body = declaration.slice(bodyStart, bodyEnd).replace(/^    /gm, '');
writeFileSync(workerPath, `'use strict';\n\n${body.trim()}\n`);
console.log(`Built ${workerPath.slice(root.length + 1)} from public/gif-optimizer.js`);
