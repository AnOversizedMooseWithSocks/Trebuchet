import test from 'node:test';
import assert from 'node:assert/strict';

import {
  detectLogoImageDimensions,
  detectLogoImageMime,
  invalidBase58Characters,
  normalizeTokenDescription,
  normalizeLogoImageMime,
  normalizeTokenName,
  normalizeTokenSymbol,
  normalizeVanityTargetBase58,
  normalizeWholeTokenSupply,
} from '../validators.js';

test('normalizes token metadata fields', () => {
  assert.equal(normalizeTokenName('  Test Token  '), 'Test Token');
  assert.equal(normalizeTokenSymbol(' tok '), 'tok');
  assert.equal(normalizeTokenDescription('  hello  '), 'hello');
});

test('rejects token metadata fields that exceed on-chain limits', () => {
  assert.throws(() => normalizeTokenName('x'.repeat(33)), /32 UTF-8 bytes/);
  assert.throws(() => normalizeTokenSymbol('x'.repeat(11)), /10 UTF-8 bytes/);
  assert.throws(() => normalizeTokenDescription('x'.repeat(1001)), /1000 UTF-8 bytes/);
});

test('enforces metadata limits by UTF-8 byte length, not character count', () => {
  assert.equal(normalizeTokenName('é'.repeat(16)), 'é'.repeat(16));
  assert.throws(() => normalizeTokenName('é'.repeat(17)), /32 UTF-8 bytes/);
  assert.equal(normalizeTokenSymbol('é'.repeat(5)), 'é'.repeat(5));
  assert.throws(() => normalizeTokenSymbol('é'.repeat(6)), /10 UTF-8 bytes/);
});

test('keeps token supply as an integer string and strips commas', () => {
  assert.equal(normalizeWholeTokenSupply('1,000,000,000'), '1000000000');
});

test('rejects invalid and u64-overflowing token supplies', () => {
  assert.throws(() => normalizeWholeTokenSupply('0'), /positive whole number/);
  assert.throws(() => normalizeWholeTokenSupply('1.5'), /positive whole number/);
  assert.throws(() => normalizeWholeTokenSupply('18446744074'), /too large/);
});

test('normalizes maximum SPL supply at alternate decimal precision', () => {
  assert.equal(normalizeWholeTokenSupply('18446744073709551615', 0), '18446744073709551615');
  assert.throws(
    () => normalizeWholeTokenSupply('18446744073709551616', 0),
    /too large/,
  );
});

test('normalizes Vanity CA Base58 targets before grinding', () => {
  assert.deepEqual(normalizeVanityTargetBase58(' MKT ', ' K1T '), { prefix: 'MKT', suffix: 'K1T' });
  assert.deepEqual(invalidBase58Characters('0OIl0'), ['0', 'O', 'I', 'l']);
  assert.throws(
    () => normalizeVanityTargetBase58('MOON', ''),
    /invalid Base58/,
  );
});

test('sniffs uploaded logo image bytes instead of trusting MIME labels', () => {
  const png = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  ]);
  const jpeg = Buffer.from([
    0xff, 0xd8,
    0xff, 0xc0,
    0x00, 0x11,
    0x08,
    0x00, 0x40,
    0x00, 0x40,
    0x03,
    0x01, 0x11, 0x00,
    0x02, 0x11, 0x00,
    0x03, 0x11, 0x00,
  ]);
  const html = Buffer.from('<script>alert(1)</script>');

  assert.equal(detectLogoImageMime(png), 'image/png');
  assert.equal(detectLogoImageMime(jpeg), 'image/jpeg');
  assert.deepEqual(detectLogoImageDimensions(png), { width: 1, height: 1 });
  assert.deepEqual(detectLogoImageDimensions(jpeg), { width: 64, height: 64 });
  assert.equal(detectLogoImageDimensions(html), null);
  assert.equal(detectLogoImageMime(html), null);
  assert.throws(() => normalizeLogoImageMime(html), /PNG or JPG/);
});

test('rejects non-buffer and truncated logo image inputs', () => {
  assert.equal(detectLogoImageMime(null), null);
  assert.equal(detectLogoImageMime('not bytes'), null);
  assert.equal(detectLogoImageMime(Buffer.from([0x89, 0x50, 0x4e, 0x47])), null);
  assert.equal(detectLogoImageMime(Buffer.from([0xff, 0xd8])), null);
});
