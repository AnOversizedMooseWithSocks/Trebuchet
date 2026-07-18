#!/usr/bin/env node
// scripts/visual-diff.mjs — pixelmatch-based visual regression comparison.
//
// Runs the E2E test suite in screenshot mode, then compares each captured
// screenshot against the golden image in test/ui/golden/.  Exits 0 when
// all diffs are within threshold; exits 1 when any diff exceeds it.
//
// Usage:
//   node scripts/visual-diff.mjs                  # capture + compare
//   node scripts/visual-diff.mjs --golden         # update golden images
//   node scripts/visual-diff.mjs --threshold 0.01 # custom threshold

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const goldenDir = join(root, 'test', 'ui', 'golden');
const diffDir = join(root, 'test', 'ui', 'diffs');

const goldenMode = process.argv.includes('--golden');
const thresholdIdx = process.argv.indexOf('--threshold');
const threshold = thresholdIdx >= 0
  ? parseFloat(process.argv[thresholdIdx + 1]) || 0.005
  : 0.005;

if (goldenMode) {
  console.log('Regenerating golden screenshots...');
  try { execSync(`rm -rf "${goldenDir}"`, { stdio: 'ignore' }); } catch {}
  mkdirSync(goldenDir, { recursive: true });
  execSync(`node test/e2e/ui-flows.mjs --golden`, {
    cwd: root, stdio: 'inherit',
  });
  console.log('Golden screenshots updated in test/ui/golden/');
  process.exit(0);
}

// Capture screenshots to a temp directory
const tmpDir = join(tmpdir(), 'treb-visual-' + Date.now());
mkdirSync(tmpDir, { recursive: true });

console.log('Capturing UI screenshots...');
execSync(`node test/e2e/ui-flows.mjs --screenshots ${tmpDir}`, {
  cwd: root, stdio: 'inherit',
});

// Compare each screenshot against its golden counterpart
const [{ default: pixelmatch }, { PNG }] = await Promise.all([
  import('pixelmatch'),
  import('pngjs'),
]);

const goldenFiles = readdirSync(goldenDir).filter(f => f.endsWith('.png')).sort();
let passed = 0, failed = 0;

// Diff images are run artifacts, not durable evidence. Clear stale failures
// before comparison so a later green run (and CI artifact upload) cannot
// accidentally report diffs from an older build.
mkdirSync(diffDir, { recursive: true });
for (const filename of readdirSync(diffDir).filter((file) => file.endsWith('.png'))) {
  unlinkSync(join(diffDir, filename));
}

if (goldenFiles.length === 0) {
  console.error('No golden images found. Run: node scripts/visual-diff.mjs --golden');
  process.exit(1);
}

for (const filename of goldenFiles) {
  const goldenPath = join(goldenDir, filename);
  const capturedPath = join(tmpDir, filename);

  if (!existsSync(capturedPath)) {
    console.log(`  ${filename}: MISSING (not captured)`);
    failed++;
    continue;
  }

  const golden = PNG.sync.read(readFileSync(goldenPath));
  const captured = PNG.sync.read(readFileSync(capturedPath));

  if (golden.width !== captured.width || golden.height !== captured.height) {
    console.log(`  ${filename}: SIZE MISMATCH (golden ${golden.width}x${golden.height}, captured ${captured.width}x${captured.height})`);
    failed++;
    continue;
  }

  const diff = new PNG({ width: golden.width, height: golden.height });
  const mismatched = pixelmatch(
    golden.data, captured.data, diff.data,
    golden.width, golden.height,
    { threshold: 0.1 }
  );

  const ratio = mismatched / (golden.width * golden.height);
  const status = ratio <= threshold ? 'PASS' : 'FAIL';

  if (ratio > threshold) {
    mkdirSync(diffDir, { recursive: true });
    const diffPath = join(diffDir, filename);
    writeFileSync(diffPath, PNG.sync.write(diff));
    console.log(`  ${filename}: ${status} (${(ratio * 100).toFixed(2)}% diff, threshold ${(threshold * 100).toFixed(1)}%)`);
    failed++;
  } else {
    console.log(`  ${filename}: ${status} (${(ratio * 100).toFixed(2)}% diff)`);
    passed++;
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
