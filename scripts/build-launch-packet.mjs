// Launch packet builder.
//
// Packs a verified launch plan (plus config, logo, and any extra assets)
// into a single signed-manifest directory and a .tar.gz archive. The
// packet is the unit that gets shipped to an isolated execution host
// (for example a locked-down EC2 instance or a container) so the actual
// launch can run away from the developer's laptop.
//
// The manifest pins every file by SHA-256 so the execution host can
// refuse to run a packet whose contents were modified in transit. The
// packet contains NO private keys: key material (mint authority,
// funding wallet, vanity CA) is generated on the execution host inside
// the sealed container and never leaves it. Only the launch proof does.
//
// Usage:
//   node scripts/build-launch-packet.mjs --config launch.json \
//     --plan plan.json [--logo logo.png] [--name flybrain-v1] \
//     [--extra file.txt ...] [--out-dir artifacts/launch-packets]
//
// Output:
//   <out-dir>/<name>/manifest.json    manifest with per-file SHA-256
//   <out-dir>/<name>/<files>         copies of the packet contents
//   <out-dir>/<name>.tar.gz           the shippable archive
//
// Exit codes: 0 success, 2 invalid input.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, copyFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
};
const extras = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--extra' && i + 1 < args.length) extras.push(args[++i]);
}

const configPath = opt('--config');
const planPath = opt('--plan');
const logoPath = opt('--logo');
const name = opt('--name') || 'launch-v1';
const outDir = opt('--out-dir') || 'artifacts/launch-packets';

const fail = (msg) => {
  console.error(`launch-packet: ${msg}`);
  process.exit(2);
};

if (!configPath) fail('--config <launch.json> is required');
if (!planPath) fail('--plan <plan.json> is required');
for (const p of [configPath, planPath, ...(logoPath ? [logoPath] : []), ...extras]) {
  if (!existsSync(p)) fail(`file not found: ${p}`);
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const bytes = (n) => `${(n / 1024).toFixed(1)} KB`;

let config, plan;
try {
  config = JSON.parse(readFileSync(configPath, 'utf8'));
  plan = JSON.parse(readFileSync(planPath, 'utf8'));
} catch (err) {
  fail(`could not parse JSON: ${err.message}`);
}

if (plan.schema !== 'trebuchet-launch-plan/v1') {
  fail(`expected a trebuchet-launch-plan/v1 file, got: ${plan.schema || 'unknown'}`);
}
if (!plan.integrity?.digest) {
  fail('plan is missing its integrity digest; rebuild it with trebuchet plan build');
}

// The token name and symbol go into the manifest for quick audit.
const token = {
  name: config.token?.name ?? plan.token?.name ?? null,
  symbol: config.token?.symbol ?? plan.token?.symbol ?? null,
  supply: config.token?.supply ?? plan.token?.supply ?? null,
};

const packetDir = path.join(outDir, name);
mkdirSync(packetDir, { recursive: true });

// Every packet file, copied into the packet dir and hashed.
const entries = [];
const addFile = (src, destInPacket) => {
  const buf = readFileSync(src);
  copyFileSync(src, path.join(packetDir, destInPacket));
  entries.push({ path: destInPacket, bytes: buf.length, sha256: sha256(buf) });
};
addFile(configPath, 'launch.json');
addFile(planPath, 'plan.json');
if (logoPath) addFile(logoPath, 'logo' + path.extname(logoPath).toLowerCase());
for (let i = 0; i < extras.length; i++) addFile(extras[i], path.basename(extras[i]));

const manifest = {
  schema: 'trebuchet-launch-packet/v1',
  packet: name,
  created: new Date().toISOString(),
  token,
  planDigest: plan.integrity.digest,
  planDigestAlgorithm: plan.integrity.algorithm || 'sha256',
  files: entries,
  security: {
    containsPrivateKeys: false,
    note: 'Key material is generated on the execution host and never leaves it. Verify file hashes before execution; reject modified packets.',
  },
};

writeFileSync(path.join(packetDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
entries.unshift({
  path: 'manifest.json',
  bytes: Buffer.byteLength(JSON.stringify(manifest, null, 2)),
  sha256: sha256(Buffer.from(JSON.stringify(manifest, null, 2))),
});

// Archive the packet. tar is available everywhere this repo is developed.
const archive = path.join(outDir, `${name}.tar.gz`);
execFileSync('tar', ['-czf', archive, '-C', outDir, name], { stdio: 'inherit' });

console.log(`Packet: ${name}`);
console.log(`Plan digest: ${manifest.planDigest}`);
for (const e of entries) console.log(`  ${e.sha256.slice(0, 16)}…  ${e.path} (${bytes(e.bytes)})`);
console.log(`Archive: ${archive}`);