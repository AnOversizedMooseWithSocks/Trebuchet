import test from 'node:test';
import assert from 'node:assert/strict';

import { unrecordedPositionsAtRange } from '../lpService.js';

// unrecordedPositionsAtRange is the pure core of the resume-time on-chain
// reconciliation: given the positions the launch wallet actually holds and a
// target tick range, it returns the ones at that range that the journal does
// not already know about (by nftMint). Those are positions that landed on-chain
// but whose confirmation never made it into the journal, and must be adopted —
// not reopened — on resume.

test('returns an on-chain position at the range that is not recorded', () => {
  const onChain = [{ nftMint: 'A', tickLower: -100, tickUpper: 100 }];
  const out = unrecordedPositionsAtRange(onChain, -100, 100, new Set());
  assert.equal(out.length, 1);
  assert.equal(out[0].nftMint, 'A');
});

test('excludes a position whose nftMint is already recorded in the journal', () => {
  const onChain = [{ nftMint: 'A', tickLower: -100, tickUpper: 100 }];
  const out = unrecordedPositionsAtRange(onChain, -100, 100, new Set(['A']));
  assert.equal(out.length, 0);
});

test('excludes a position at a different tick range', () => {
  const onChain = [{ nftMint: 'A', tickLower: -100, tickUpper: 100 }];
  assert.equal(unrecordedPositionsAtRange(onChain, -120, 120, new Set()).length, 0);
  assert.equal(unrecordedPositionsAtRange(onChain, -100, 120, new Set()).length, 0);
  assert.equal(unrecordedPositionsAtRange(onChain, -120, 100, new Set()).length, 0);
});

test('tolerates an empty or missing on-chain list', () => {
  assert.equal(unrecordedPositionsAtRange([], -100, 100, new Set()).length, 0);
  assert.equal(unrecordedPositionsAtRange(undefined, -100, 100, new Set()).length, 0);
});

test('returns every unrecorded match at one range (main slices share a range)', () => {
  const onChain = [
    { nftMint: 'A', tickLower: -100, tickUpper: 100 },
    { nftMint: 'B', tickLower: -100, tickUpper: 100 },
    { nftMint: 'C', tickLower: -100, tickUpper: 100 },
  ];
  const out = unrecordedPositionsAtRange(onChain, -100, 100, new Set(['A']));
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((p) => p.nftMint), ['B', 'C']);
});

test('compares tick values numerically (string ticks still match)', () => {
  const onChain = [{ nftMint: 'A', tickLower: '-100', tickUpper: '100' }];
  assert.equal(unrecordedPositionsAtRange(onChain, -100, 100, new Set()).length, 1);
});

test('skips malformed entries (null, or missing nftMint)', () => {
  const onChain = [null, { tickLower: -100, tickUpper: 100 }, { nftMint: 'A', tickLower: -100, tickUpper: 100 }];
  const out = unrecordedPositionsAtRange(onChain, -100, 100, new Set());
  assert.equal(out.length, 1);
  assert.equal(out[0].nftMint, 'A');
});
