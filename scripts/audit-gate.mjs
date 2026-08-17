#!/usr/bin/env node
// scripts/audit-gate.mjs
//
// Enforces the dependency-audit policy in CI.
//
// Why this exists: CI ran `npm audit --audit-level=critical` (blocking) plus
// `npm audit --audit-level=high` (non-blocking, continue-on-error). The
// non-blocking step's comment asserted "the sole finding is bigint-buffer" —
// an invariant nothing actually enforced. It drifted to SIXTEEN high-severity
// findings, including fixable ones in the Electron/electron-builder toolchain,
// and nobody noticed until an unrelated CRITICAL (node-tar) tripped the other
// gate. A documented invariant with no enforcement is just a comment.
//
// Policy:
//   - ANY critical  -> fail.
//   - Any high NOT in the allowlist below -> fail. These are, by definition,
//     new and unreviewed: either fix them or consciously add them here.
//   - Allowlisted highs -> reported, not fatal. Each needs a recorded reason.
//
// Keep the allowlist in sync with the residuals section of SECURITY.md.

import { execFileSync } from 'node:child_process';

// High-severity advisories accepted as unfixable-in-place. Every entry states
// why it cannot be fixed and what would let us drop it.
const ALLOWED_HIGH = new Map([
  ['bigint-buffer',
    'No patched release exists at any version (latest published, 1.1.5, is the '
    + 'vulnerable one). npm\'s force fix downgrades @solana/spl-token to 0.1.8, '
    + 'removing APIs this app needs. The advisory targets the NATIVE binding\'s '
    + 'toBigIntLE(); this app runs the pure-JS fallback. Drop when '
    + '@solana/buffer-layout-utils removes the dependency.'],
  ['@solana/buffer-layout-utils', 'Transitive carrier of bigint-buffer (see above).'],
  ['@solana/spl-token', 'Transitive carrier of bigint-buffer (see above).'],
  ['@raydium-io/raydium-sdk-v2', 'Transitive carrier of bigint-buffer (see above).'],
]);

function runAudit() {
  try {
    // npm audit exits non-zero when it finds anything; capture output either way.
    return execFileSync('npm', ['audit', '--json'], {
      encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    });
  } catch (err) {
    if (err.stdout) return err.stdout;
    throw err;
  }
}

const report = JSON.parse(runAudit());
const vulns = report.vulnerabilities || {};

const criticals = [];
const unexpectedHighs = [];
const acceptedHighs = [];

for (const [name, v] of Object.entries(vulns)) {
  if (v.severity === 'critical') criticals.push(name);
  else if (v.severity === 'high') {
    (ALLOWED_HIGH.has(name) ? acceptedHighs : unexpectedHighs).push(name);
  }
}

const counts = report.metadata?.vulnerabilities || {};
console.log(`audit totals: ${JSON.stringify(counts)}`);

if (acceptedHighs.length > 0) {
  console.log('\nAccepted high-severity residuals (documented in SECURITY.md):');
  for (const name of acceptedHighs.sort()) {
    console.log(`  - ${name}: ${ALLOWED_HIGH.get(name)}`);
  }
}

let failed = false;

if (criticals.length > 0) {
  console.error('\nFAIL: critical vulnerabilities present:');
  for (const name of criticals.sort()) console.error(`  - ${name}`);
  console.error('Criticals always block. Run `npm audit fix`, or bump the '
    + 'relevant override in package.json.');
  failed = true;
}

if (unexpectedHighs.length > 0) {
  console.error('\nFAIL: high-severity vulnerabilities that are not on the allowlist:');
  for (const name of unexpectedHighs.sort()) {
    const v = vulns[name];
    const fix = v.fixAvailable === true
      ? 'fixable with `npm audit fix`'
      : (v.fixAvailable && typeof v.fixAvailable === 'object'
          ? `fix requires ${v.fixAvailable.name}@${v.fixAvailable.version}`
            + (v.fixAvailable.isSemVerMajor ? ' (MAJOR — review before applying)' : '')
          : 'no fix currently available');
    console.error(`  - ${name} (${fix})`);
  }
  console.error('\nEither fix these, or — if genuinely unfixable — add them to '
    + 'ALLOWED_HIGH in scripts/audit-gate.mjs WITH a reason, and update the '
    + 'residuals section of SECURITY.md in the same commit.');
  failed = true;
}

if (failed) process.exit(1);
console.log('\nAudit gate passed: no criticals, no unreviewed high-severity findings.');
