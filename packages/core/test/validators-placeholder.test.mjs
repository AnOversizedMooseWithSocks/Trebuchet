import test from 'node:test';
import assert from 'node:assert/strict';
import { isPlaceholderSweepDestination } from '../src/validators.js';

test('placeholder sweep destinations are detected', () => {
  assert.equal(isPlaceholderSweepDestination('11111111111111111111111111111116'), true);
  assert.equal(isPlaceholderSweepDestination('11111111111111111111111111111112'), true);
  assert.equal(isPlaceholderSweepDestination('11111111111111111111111111111111'), true);
});

test('real destinations are not flagged', () => {
  assert.equal(isPlaceholderSweepDestination('AtPVyHp52LqHy1rnMu5fUx9eWpDMrr2DnC3C3mdFc54j'), false);
  assert.equal(isPlaceholderSweepDestination(''), false);
  assert.equal(isPlaceholderSweepDestination(null), false);
  assert.equal(isPlaceholderSweepDestination('FLY3ytMF4wyGQcVPo2RZ5FTFsf7JEBj4DrtucnRqrFLY'), false);
});
