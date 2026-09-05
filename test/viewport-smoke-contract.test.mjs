import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { V2_VIEWPORT_SMOKE_REQUIRED_CHECKS } from '../viewportSmokeContract.js';

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

test('the required-checks list has exactly one definition', () => {
  // server.js validates a proof against this list; the smoke test writes it.
  // Private copies drifted once (server required 7, the test wrote 9), which
  // made every proof fail the order-and-length comparison silently.
  const server = read('server.js');
  const smoke = read('test/v2-viewport-smoke.mjs');

  assert.match(server, /import \{ V2_VIEWPORT_SMOKE_REQUIRED_CHECKS \} from '\.\/viewportSmokeContract\.js'/);
  assert.match(smoke, /import \{ V2_VIEWPORT_SMOKE_REQUIRED_CHECKS \} from '\.\.\/viewportSmokeContract\.js'/);

  // Neither may redeclare it.
  assert.doesNotMatch(server, /const V2_VIEWPORT_SMOKE_REQUIRED_CHECKS = \[/);
  assert.doesNotMatch(smoke, /const requiredChecks = \[/);
});

test('accessibility evidence is a required check, so a proof without it fails closed', () => {
  assert.ok(
    V2_VIEWPORT_SMOKE_REQUIRED_CHECKS.includes('keyboardWalkthrough'),
    'keyboard evidence must be required, not optional',
  );

  // Mirror server.js's missingViewportSmokeChecks: absent evidence is a
  // failure, not a pass. A proof row that simply omits the key must be caught.
  const missing = (row) => V2_VIEWPORT_SMOKE_REQUIRED_CHECKS
    .filter((check) => row?.checks?.[check] !== true);

  const noEvidence = { checks: Object.fromEntries(
    V2_VIEWPORT_SMOKE_REQUIRED_CHECKS
      .filter((check) => check !== 'keyboardWalkthrough')
      .map((check) => [check, true]),
  ) };
  assert.deepEqual(missing(noEvidence), ['keyboardWalkthrough']);

  const failedEvidence = { checks: { ...noEvidence.checks, keyboardWalkthrough: false } };
  assert.deepEqual(missing(failedEvidence), ['keyboardWalkthrough']);

  const complete = { checks: { ...noEvidence.checks, keyboardWalkthrough: true } };
  assert.deepEqual(missing(complete), []);
});

test('the review matrix covers wide, normal, and cramped desktop widths', () => {
  const smoke = read('test/v2-viewport-smoke.mjs');
  // A cramped-window fix is not complete until the wider tiers are checked too.
  for (const [width, height] of [[1440, 900], [1100, 720], [900, 650], [390, 844]]) {
    assert.match(
      smoke,
      new RegExp(`width: ${width}, height: ${height}`),
      `viewport ${width}x${height} is missing from the matrix`,
    );
  }
});

test('the browser mirror in app.js matches the shared contract exactly', () => {
  // public/v2/app.js is a classic script and cannot import the contract, so it
  // keeps a copy. That copy drifted to 7 checks while the contract held 10.
  // Parse the literal out of the source and compare element by element.
  const app = read('public/v2/app.js');
  const parseFrozenList = (name) => {
    const match = app.match(new RegExp(`const ${name} = Object\\.freeze\\(\\[([\\s\\S]*?)\\]\\);`));
    assert.ok(match, `${name} not found in public/v2/app.js`);
    return match[1].split(',').map((part) => part.trim().replace(/^'|'$/g, '')).filter(Boolean);
  };

  assert.deepEqual(
    parseFrozenList('V2_VIEWPORT_SMOKE_REQUIRED_CHECKS'),
    [...V2_VIEWPORT_SMOKE_REQUIRED_CHECKS],
    'app.js required-checks mirror has drifted from viewportSmokeContract.js',
  );
});
