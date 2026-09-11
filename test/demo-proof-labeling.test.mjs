import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
const app = read('public/v2/app.js');

// Pull the canonical helper out of the browser bundle and run it directly.
const extract = (name) => {
  const match = app.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n\\}`));
  assert.ok(match, `${name} not found in public/v2/app.js`);
  const ctx = vm.createContext({});
  vm.runInContext(`${match[0]}\nthis.fn = ${name};`, ctx);
  return ctx.fn;
};

test('isDemoLaunchProof recognises the shape proofFromDemoRun actually returns', () => {
  const isDemoLaunchProof = extract('isDemoLaunchProof');

  // proofFromDemoRun() stamps `source` and `stage` but never `demo`.
  // A check reading only `proof.demo` labelled this run "Verified".
  assert.equal(isDemoLaunchProof({ source: 'demo-run', stage: 'demo_completed' }), true);

  // Each signal alone is sufficient.
  assert.equal(isDemoLaunchProof({ source: 'demo-run' }), true);
  assert.equal(isDemoLaunchProof({ stage: 'demo_completed' }), true);
  assert.equal(isDemoLaunchProof({ demo: true }), true);

  // A real proof, and absent input, are not demo.
  assert.equal(isDemoLaunchProof({ source: 'launch-journal', stage: 'completed' }), false);
  assert.equal(isDemoLaunchProof(null), false);
  assert.equal(isDemoLaunchProof(undefined), false);
});

test('proofFromDemoRun output is classified as demo end to end', () => {
  const isDemoLaunchProof = extract('isDemoLaunchProof');
  const demoRunFields = app.match(/function proofFromDemoRun\(\)[\s\S]*?\n\}/);
  assert.ok(demoRunFields, 'proofFromDemoRun not found');

  // Guard the invariant the bug depended on: if proofFromDemoRun ever stops
  // emitting both markers, the helper above must still catch what remains.
  assert.match(demoRunFields[0], /source: 'demo-run'/);
  assert.match(demoRunFields[0], /stage: 'demo_completed'/);
  assert.equal(isDemoLaunchProof({ source: 'demo-run', stage: 'demo_completed' }), true);
});

test('no launch asset row hardcodes a Verified state', () => {
  const block = app.match(/const proofAssets = proof \? \[[\s\S]*?\]\.filter\(Boolean\) : \[\];/);
  assert.ok(block, 'proofAssets block not found');

  // Every row must derive its state; a literal 'Verified' here is the defect.
  assert.doesNotMatch(block[0], /state: 'Verified'/);
  assert.match(app, /const proofAssetState = proofIsDemo \? 'Demo' : 'Verified';/);
  assert.equal((block[0].match(/state: proofAssetState,/g) || []).length, 3);
});

test('the proof inventory heading does not claim verification for a practice run', () => {
  const heading = app.match(/<div class="wallet-proof-heading">[\s\S]*?<\/div>/);
  assert.ok(heading, 'wallet-proof-heading not found');
  assert.match(heading[0], /proofIsDemo \?/);
  assert.doesNotMatch(heading[0], /<small>Verified launch assets<\/small>/);
});

test('demo classification has a single definition', () => {
  // The defect was six near-duplicate expressions answering one question.
  // Keep the full three-signal test in exactly one place.
  const inlined = app.match(/proof\?\.source === 'demo-run'\s*\|\|\s*proof\?\.demo === true/g) || [];
  assert.equal(inlined.length, 1, 'demo detection should live only in isDemoLaunchProof');

  // And the broken single-signal check must not come back.
  assert.doesNotMatch(app, /state: proof\?\.demo \?/);
});
