// sha256.js
//
// Dependency-free synchronous SHA-256 (FIPS 180-4) so Trebuchet Core's
// integrity digests work identically in Node, browsers, and no-bundler web
// apps. `node:crypto` produces byte-identical output for the same input; this
// module exists so the streamlined-launch path can run client-side on a static
// host without any Node-only imports.
//
// The digest is only used for tamper-evidence and local plan identity — never
// for secrets — so a compact, auditable pure-JS implementation is the right
// trade here.

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

const H0 = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];

function rotr(value, bits) {
  return (value >>> bits) | (value << (32 - bits));
}

function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (typeof input === 'string') return new TextEncoder().encode(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new TypeError('sha256 input must be a string, Uint8Array, or ArrayBuffer view.');
}

function sha256(input) {
  const message = toBytes(input);
  const bitLength = message.length * 8;

  // Padding: 0x80, zeros, then a 64-bit big-endian bit length.
  const paddedLength = Math.ceil((message.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(message);
  padded[message.length] = 0x80;
  const dataView = new DataView(padded.buffer);
  dataView.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);
  dataView.setUint32(paddedLength - 4, (bitLength >>> 0), false);

  let h0 = H0[0], h1 = H0[1], h2 = H0[2], h3 = H0[3];
  let h4 = H0[4], h5 = H0[5], h6 = H0[6], h7 = H0[7];

  const w = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    const block = new DataView(padded.buffer, padded.byteOffset + offset, 64);
    for (let i = 0; i < 16; i++) w[i] = block.getUint32(i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }

    let a = h0, b = h1, c = h2, d = h3;
    let e = h4, f = h5, g = h6, h = h7;
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + K[i] + w[i]) | 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) | 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) | 0;
    }

    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
    h5 = (h5 + f) | 0;
    h6 = (h6 + g) | 0;
    h7 = (h7 + h) | 0;
  }

  return new Uint32Array([h0, h1, h2, h3, h4, h5, h6, h7]);
}

function toHex(bytes) {
  let output = '';
  for (let i = 0; i < bytes.length; i++) {
    output += (bytes[i] >>> 4).toString(16);
    output += (bytes[i] & 0x0f).toString(16);
  }
  return output;
}

/** SHA-256 hex digest of a string or byte buffer. Synchronous and pure JS. */
export function sha256Hex(input) {
  const digest = sha256(input);
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 8; i++) {
    bytes[i * 4] = (digest[i] >>> 24) & 0xff;
    bytes[i * 4 + 1] = (digest[i] >>> 16) & 0xff;
    bytes[i * 4 + 2] = (digest[i] >>> 8) & 0xff;
    bytes[i * 4 + 3] = digest[i] & 0xff;
  }
  return toHex(bytes);
}