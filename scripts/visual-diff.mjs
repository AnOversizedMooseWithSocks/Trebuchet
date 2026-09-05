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
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  unlinkSync,
  rmSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const platformIdx = process.argv.indexOf('--platform');
const visualPlatform = platformIdx >= 0 && process.argv[platformIdx + 1]
  ? process.argv[platformIdx + 1]
  : (process.env.TREBUCHET_VISUAL_PLATFORM || process.platform);
const goldenDir = join(
  root,
  'test',
  'ui',
  visualPlatform === 'linux' ? 'golden-linux' : 'golden',
);
const diffDir = join(root, 'test', 'ui', 'diffs');
const actualDir = join(root, 'test', 'ui', 'actual');

const goldenMode = process.argv.includes('--golden');
const thresholdIdx = process.argv.indexOf('--threshold');
const threshold = thresholdIdx >= 0
  ? parseFloat(process.argv[thresholdIdx + 1]) || 0.005
  : 0.005;

if (goldenMode) {
  console.log(`Regenerating ${visualPlatform} golden screenshots...`);
  rmSync(goldenDir, { recursive: true, force: true });
  mkdirSync(goldenDir, { recursive: true });
  execSync(`node test/e2e/ui-flows.mjs --golden --platform ${visualPlatform}`, {
    cwd: root, stdio: 'inherit',
    env: { ...process.env, TREBUCHET_VISUAL_PLATFORM: visualPlatform },
  });
  console.log(`Golden screenshots updated in ${goldenDir}`);
  process.exit(0);
}

// Keep captured screenshots in a stable ignored directory. CI uploads both
// these images and the pixel diffs when a comparison fails, which makes
// baseline drift diagnosable without reconstructing a runner.
rmSync(actualDir, { recursive: true, force: true });
mkdirSync(actualDir, { recursive: true });

console.log(`Capturing ${visualPlatform} UI screenshots...`);
execSync(`node test/e2e/ui-flows.mjs --screenshots ${actualDir} --platform ${visualPlatform}`, {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, TREBUCHET_VISUAL_PLATFORM: visualPlatform },
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
  const capturedPath = join(actualDir, filename);

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
