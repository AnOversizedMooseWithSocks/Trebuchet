// Launch packet verification for the sealed runner.
//
// A launch packet (trebuchet-launch-packet/v1, produced by
// scripts/build-launch-packet.mjs) is the ONLY accepted launch input.
// Every file is hash-pinned by manifest.json; the runner recomputes each
// hash and refuses to execute anything that does not match exactly.
// The embedded launch plan is additionally verified against the Core
// launch-plan integrity contract.
//
// No extraction into shared state: packets unpack into a per-packet
// temp directory inside the runner's ephemeral state dir.

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  TREBUCHET_PLAN_SCHEMA,
  verifyLaunchPlan,
} from '@trebuchet/core/launch-plan';

export const PACKET_MANIFEST_SCHEMA = 'trebuchet-launch-packet/v1';

export class PacketError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PacketError';
  }
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/**
 * Extract a packet archive (tar.gz) into targetDir. Rejects on a
 * non-zero tar exit so a truncated or tampered archive never reaches
 * verification.
 */
export function extractPacketArchive(archivePath, targetDir) {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', ['-xzf', archivePath, '-C', targetDir]);
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => reject(new PacketError(`archive extraction failed: ${error.message}`)));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new PacketError(`archive extraction failed (tar exit ${code}): ${stderr.trim()}`));
    });
  });
}

/**
 * Locate the packet root inside an extracted archive. Packets built by
 * scripts/build-launch-packet.mjs contain exactly one top-level directory
 * (the packet name); verifyPacketDir expects the manifest at the root we
 * return. Ambiguous layouts (zero or multiple candidates) are refused.
 */
export function locatePacketRoot(dir) {
  const direct = path.join(dir, 'manifest.json');
  try {
    fs.accessSync(direct);
    return dir;
  } catch {
    // fall through: look for a single wrapping directory
  }
  const entries = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'));
  if (entries.length === 1 && fs.existsSync(path.join(dir, entries[0].name, 'manifest.json'))) {
    return path.join(dir, entries[0].name);
  }
  throw new PacketError('archive does not contain a recognizable packet (manifest.json not found at a single root)');
}

/**
 * Verify an extracted packet directory against its own manifest.
 * Returns { manifest, plan } on success; throws PacketError otherwise.
 */
export async function verifyPacketDir(dir) {
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path.join(dir, 'manifest.json'), 'utf8'));
  } catch {
    throw new PacketError('packet is missing manifest.json or it is not valid JSON');
  }
  if (manifest.schema !== PACKET_MANIFEST_SCHEMA) {
    throw new PacketError(`unsupported packet schema: ${manifest.schema || 'missing'}`);
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new PacketError('manifest lists no files');
  }
  if (manifest.security?.containsPrivateKeys === true) {
    throw new PacketError('manifest claims to contain private keys; refusing');
  }

  const seen = new Set();
  for (const entry of manifest.files) {
    if (!entry?.path || typeof entry.path !== 'string') throw new PacketError('manifest file entry is missing a path');
    // Reject path traversal: every entry must be a plain relative path.
    const resolved = path.resolve(dir, entry.path);
    if (resolved !== path.join(dir, entry.path)) {
      throw new PacketError(`manifest path escapes the packet: ${entry.path}`);
    }
    if (seen.has(entry.path)) throw new PacketError(`duplicate manifest entry: ${entry.path}`);
    seen.add(entry.path);

    let contents;
    try {
      contents = await readFile(resolved);
    } catch {
      throw new PacketError(`packet file missing: ${entry.path}`);
    }
    if (contents.length !== entry.bytes) {
      throw new PacketError(`packet file size mismatch: ${entry.path}`);
    }
    const digest = sha256(contents);
    if (digest !== entry.sha256) {
      throw new PacketError(`packet file hash mismatch: ${entry.path}`);
    }
  }

  // The launch plan itself must pass the Core integrity contract and its
  // digest must match what the manifest pinned.
  let plan;
  try {
    plan = JSON.parse(await readFile(path.join(dir, 'plan.json'), 'utf8'));
  } catch {
    throw new PacketError('packet is missing plan.json or it is not valid JSON');
  }
  if (plan.schema !== TREBUCHET_PLAN_SCHEMA) {
    throw new PacketError(`plan has unexpected schema: ${plan.schema || 'missing'}`);
  }
  const verification = verifyLaunchPlan(plan);
  if (!verification.valid) {
    throw new PacketError('embedded launch plan failed Core integrity verification');
  }
  if (manifest.planDigest && verification.digest !== manifest.planDigest) {
    throw new PacketError('manifest plan digest does not match the embedded plan');
  }

  let launchConfig = null;
  try {
    launchConfig = JSON.parse(await readFile(path.join(dir, 'launch.json'), 'utf8'));
  } catch {
    throw new PacketError('packet is missing launch.json or it is not valid JSON');
  }

  return {
    manifest,
    plan,
    launchConfig,
    digest: verification.digest,
    files: [...seen].sort(),
  };
}