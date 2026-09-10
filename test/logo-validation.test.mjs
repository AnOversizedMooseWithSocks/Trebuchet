// test/logo-validation.test.mjs
//
// Unit tests for the logo constraint validators — the authoritative
// server-side rule behind two user complaints: oversized logos accepted
// (client capped at 1024px, server not at all) and logos missing from the
// launch report (oversized embeds blowing the publish budget). All buffers
// are built by hand from the format specs, so the parser is tested against
// exactly the bytes it reads.

import test from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import {
  readImageDimensions,
  assertLogoConstraints,
  LOGO_MAX_DIMENSION_PX,
  LOGO_MAX_BYTES,
} from '../validators.js';

// --- buffer builders --------------------------------------------------------

// Minimal PNG: signature + IHDR chunk carrying the given dimensions. The
// validators only read the header, so no pixel data is needed.
function pngOf(width, height) {
  const buf = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(buf, 0);
  buf.writeUInt32BE(13, 8);            // IHDR data length
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  buf[24] = 8;                          // bit depth
  buf[25] = 6;                          // color type RGBA
  return buf;
}

// Minimal JPEG: SOI, an APP0 segment to prove the SOF scan skips non-frame
// segments, then SOF0 carrying the dimensions.
function jpegOf(width, height, { sofMarker = 0xc0 } = {}) {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10,
    0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof = Buffer.alloc(11);
  sof[0] = 0xff; sof[1] = sofMarker;
  sof.writeUInt16BE(9, 2);              // segment length
  sof[4] = 8;                           // precision
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  sof[9] = 3;                           // component count
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0.subarray(0, 2 + 0x10), sof]);
}

// --- dimension parsing ------------------------------------------------------

test('readImageDimensions: PNG IHDR', () => {
  assert.deepEqual(readImageDimensions(pngOf(200, 200)), { width: 200, height: 200 });
  assert.deepEqual(readImageDimensions(pngOf(1, 1)), { width: 1, height: 1 });
  assert.deepEqual(readImageDimensions(pngOf(1024, 768)), { width: 1024, height: 768 });
});

test('readImageDimensions: JPEG SOF0 after non-frame segments', () => {
  assert.deepEqual(readImageDimensions(jpegOf(150, 90)), { width: 150, height: 90 });
});

test('readImageDimensions: progressive JPEG (SOF2)', () => {
  assert.deepEqual(
    readImageDimensions(jpegOf(200, 200, { sofMarker: 0xc2 })),
    { width: 200, height: 200 },
  );
});

test('readImageDimensions: DHT marker (0xC4) is not mistaken for a frame header', () => {
  // 0xC4 sits inside the SOF marker range but is a Huffman table, not a
  // frame. A parser that treats it as SOF reads garbage dimensions.
  const dht = Buffer.from([0xff, 0xc4, 0x00, 0x05, 0x00, 0x01, 0x02]);
  const sof = jpegOf(120, 80).subarray(2); // strip SOI, keep APP0+SOF
  const buf = Buffer.concat([Buffer.from([0xff, 0xd8]), dht, sof]);
  assert.deepEqual(readImageDimensions(buf), { width: 120, height: 80 });
});

test('readImageDimensions: corrupt inputs throw, never return garbage', () => {
  assert.throws(() => readImageDimensions(Buffer.from('not an image')),
    /PNG or JPG/);
  // JPEG with no SOF anywhere
  assert.throws(() => readImageDimensions(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00])),
    /no frame header/);
  // JPEG with a lying segment length (would loop forever without the guard)
  assert.throws(() => readImageDimensions(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x01, 0x00])),
    /corrupt/);
});

// --- the constraint rule ----------------------------------------------------

test('assertLogoConstraints: 200×200 exactly is allowed (limit is inclusive)', () => {
  const r = assertLogoConstraints(pngOf(200, 200));
  assert.equal(r.mime, 'image/png');
  assert.deepEqual({ w: r.width, h: r.height }, { w: 200, h: 200 });
});

test('assertLogoConstraints: 201px in EITHER dimension is rejected with actual size named', () => {
  assert.throws(() => assertLogoConstraints(pngOf(201, 100)), /201×100.*200×200/s);
  assert.throws(() => assertLogoConstraints(pngOf(100, 201)), /100×201/);
  // The old client limit must no longer pass anywhere.
  assert.throws(() => assertLogoConstraints(pngOf(1024, 1024)), /1024×1024/);
});

test('assertLogoConstraints: byte cap rejects a small-pixel, huge-byte file', () => {
  // A 50×50 JPEG stuffed past the byte cap with junk-metadata padding —
  // dimensions alone would pass; the byte cap must catch it.
  const base = jpegOf(50, 50);
  const padded = Buffer.concat([
    base.subarray(0, base.length),
    Buffer.alloc(LOGO_MAX_BYTES + 1024, 0x20),
  ]);
  assert.throws(() => assertLogoConstraints(padded), /KB/);
});

test('assertLogoConstraints: zero-dimension image is rejected as corrupt', () => {
  assert.throws(() => assertLogoConstraints(pngOf(0, 100)), /zero size|corrupt/);
});

test('constants: limits match the product rule and stay in sync with the frontend', () => {
  assert.equal(LOGO_MAX_DIMENSION_PX, 200, 'the product rule is 200×200 max');
  // The frontend's MAX_LOGO_DIMENSION / MAX_LOGO_BYTES (preamble.js) must
  // agree with the server's — a looser client doesn't bypass anything, it
  // just moves the rejection to a worse moment (after upload, with a less
  // friendly error). Pin both pairs together.
  const preamble = readFileSync(new URL('../public/modules/preamble.js', import.meta.url), 'utf8');
  const dimMatch = preamble.match(/const MAX_LOGO_DIMENSION = (\d+);/);
  const bytesMatch = preamble.match(/const MAX_LOGO_BYTES = (\d+) \* 1024;/);
  assert.ok(dimMatch, 'frontend MAX_LOGO_DIMENSION must exist');
  assert.ok(bytesMatch, 'frontend MAX_LOGO_BYTES must exist');
  assert.equal(Number(dimMatch[1]), LOGO_MAX_DIMENSION_PX,
    'frontend dimension cap must equal the server cap');
  assert.equal(Number(bytesMatch[1]) * 1024, LOGO_MAX_BYTES,
    'frontend byte cap must equal the server cap');
});
