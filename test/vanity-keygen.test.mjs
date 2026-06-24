import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateVanityKeypair } from '../vanityKeygen.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const BINARY = path.join(REPO, 'c', 'build', 'vanity_keygen');

// Dependency-free base58 decode — used to detect any 32-byte secret hiding
// in the output under any field name.
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function b58decode(str) {
  let bytes = [0];
  for (const ch of str) {
    const v = B58.indexOf(ch);
    if (v < 0) return null;
    let carry = v;
    for (let i = 0; i < bytes.length; i++) {
      carry += bytes[i] * 58;
      bytes[i] = carry & 0xff;
      carry >>= 8;
    }
    while (carry) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  for (const ch of str) { if (ch === '1') bytes.push(0); else break; }
  return bytes.reverse();
}

before(() => {
  // The binary is built by `npm run build:c`. Build it if CI hasn't.
  if (!existsSync(BINARY)) {
    execFileSync('make', ['-C', 'c'], { cwd: REPO, stdio: 'inherit' });
  }
});

// THE critical invariant. The grinder is fully deterministic from its master
// seed, and `crypto_sign_keypair_from_seed` makes the secret key derivable from
// that seed. So any seed/master-seed value in the output reconstructs the mint's
// private key. A "provable rarity" proof that includes it is a fund-loss trapdoor.
// This test is RED until the seed is removed from the output. Do not "fix" it by
// renaming the field — the generic scan below catches that.
test('vanity keygen output never exposes a value that reconstructs the secret key', async () => {
  const result = await generateVanityKeypair({ prefix: 'R', threads: 2 });

  // 1. Named-field gate: no `seed`/`masterSeed` in the surfaced payload.
  assert.equal(result.seed, undefined, 'output must not include `seed` (it re-derives the private key)');
  assert.equal(result.masterSeed, undefined, 'output must not include `masterSeed`');

  // 2. Generic gate (survives renames): no string field other than publicKey
  //    decodes to a 32-byte value. A 32-byte base58 string is key material.
  for (const [k, v] of Object.entries(result)) {
    if (k === 'publicKey' || typeof v !== 'string') continue;
    const decoded = b58decode(v);
    assert.ok(
      !decoded || decoded.length !== 32,
      `field "${k}" base58-decodes to 32 bytes — that is key material and must not be in the output`,
    );
  }
});

test('grind returns a valid keypair matching the requested prefix', async () => {
  const result = await generateVanityKeypair({ prefix: 'R', threads: 2 });
  assert.ok(result.publicKey.startsWith('R'), `publicKey ${result.publicKey} should start with R`);
  assert.equal(result.secretKey.length, 64, 'secretKey should be 64 bytes');
});

test('grind returns a keypair matching both requested start and end', async () => {
  const result = await generateVanityKeypair({ prefix: 'R', suffix: '1', threads: 2 });
  assert.ok(result.publicKey.startsWith('R'), `publicKey ${result.publicKey} should start with R`);
  assert.ok(result.publicKey.endsWith('1'), `publicKey ${result.publicKey} should end with 1`);
  assert.equal(result.secretKey.length, 64, 'secretKey should be 64 bytes');
  assert.equal(result.prefix, 'R');
  assert.equal(result.suffix, '1');
});
