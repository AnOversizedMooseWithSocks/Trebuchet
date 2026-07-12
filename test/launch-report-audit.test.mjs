import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const lpSrc = readFileSync(path.join(REPO, 'lpService.js'), 'utf8');
const reportSrc = readFileSync(path.join(REPO, 'public', 'modules', 'launch-report.js'), 'utf8');
const demoSrc = readFileSync(path.join(REPO, 'demoChainService.js'), 'utf8');

// ---------------------------------------------------------------------------
// Launch-report audit-record regression tests.
//
// The launch report is published permanently to Arweave so third parties can
// audit a launch against the Trebuchet principles (safe token contract,
// locked LP, concentrated LP). These tests pin the data plumbing that makes
// that audit possible:
//
//   1. The Fee Key NFT mint. Verified against the Raydium SDK source
//      (v0.1.144-alpha): lockPosition()'s extInfo carries lockNftMint — the
//      NEW NFT Burn & Earn mints while the position NFT moves into the lock
//      program's escrow. That lock NFT IS the Fee Key. It must be recorded
//      at lock time (it can't be cheaply recovered later) and it must be the
//      mint Phase 4 transfers (the escrowed position NFT is no longer in the
//      wallet).
//
//   2. Position tick ranges and pool parameters, which prove the
//      concentrated-LP shape without an RPC lookup.
//
//   3. The frontend's machine-readable launchData payload (dataVersion 5)
//      carrying per-position records, token-safety facts, airdrop rows, and
//      slice/ladder/support shape fields.
// ---------------------------------------------------------------------------

test('lpService records the Fee Key NFT mint at every lock site', () => {
  assert.ok(
    /function feeKeyMintFromLockResult\(/.test(lpSrc),
    'feeKeyMintFromLockResult helper must exist',
  );
  assert.ok(
    /lockRes\?\.extInfo\?\.lockNftMint/.test(lpSrc),
    'helper must read extInfo.lockNftMint (the SDK field verified against source)',
  );
  // One recording per position type: main (pos), ladder (lp), support (sp),
  // bootstrap (bs).
  for (const v of ['pos', 'lp', 'sp', 'bs']) {
    assert.ok(
      lpSrc.includes(`${v}.feeKeyNftMint = feeKeyMintFromLockResult(lockRes);`),
      `lock phase must record feeKeyNftMint on '${v}' records`,
    );
  }
});

test('Phase 4 transfers the Fee Key NFT, not the escrowed position NFT', () => {
  assert.ok(
    /const feeKeyMint = pos\.feeKeyNftMint \|\| pos\.nftMint;/.test(lpSrc),
    'transferFeeKeys must prefer the recorded Fee Key mint (position NFT is escrowed after lock)',
  );
  assert.ok(
    /nftMint: feeKeyMint,\r?\n\s*recipient: pos\.recipient,/.test(lpSrc),
    'the transfer call must use the Fee Key mint',
  );
});

test('lpService records concentration-proof fields', () => {
  // Main positions carry their tick range (ladder/support/bootstrap already
  // did or do now).
  assert.ok(
    /tickLower: mainTicks\.tickLower,\r?\n\s*tickUpper: mainTicks\.tickUpper,/.test(lpSrc),
    'main position records must include the tick range',
  );
  assert.ok(
    /tickLower: bsTicks\.tickLower,\r?\n\s*tickUpper: bsTicks\.tickUpper,/.test(lpSrc),
    'bootstrap record must include the tick range',
  );
  // Pool-level parameters on the public result entry.
  assert.ok(
    /tickSpacing,\r?\n\s*initialPrice: initialPrice\.toString\(\),/.test(lpSrc),
    'pool result must expose tickSpacing and initialPrice',
  );
});

test('buildLaunchReportData emits the v2 audit payload', () => {
  const fnStart = reportSrc.indexOf('function buildLaunchReportData(');
  assert.ok(fnStart >= 0, 'buildLaunchReportData must exist');
  const fn = reportSrc.slice(fnStart, fnStart + 9000);

  assert.ok(/dataVersion: 5,/.test(fn), 'payload must declare dataVersion 5');
  // Token-safety facts.
  for (const field of [
    'mintAuthorityRenounced',
    'freezeAuthorityDisabled',
    'metadataUpdateAuthorityRevoked',
    'metadataImmutable',
  ]) {
    assert.ok(fn.includes(field), `token authorities must include ${field}`);
  }
  assert.ok(/metadataUri/.test(fn), 'token facts must include metadataUri');
  // Per-position audit fields.
  for (const field of [
    'positionNftMint',
    'feeKeyNftMint',
    'tickLower',
    'tickUpper',
    'lockTx',
    'openTx',
    'sharePercent',
    'supplyPercent',
    'lowerMultiplier',
    'upperMultiplier',
    'depthPct',
  ]) {
    assert.ok(fn.includes(field), `position records must include ${field}`);
  }
  // Per-recipient airdrop audit fields.
  for (const field of ['lastAirdropResult', 'buildAirdropTransferPayload', 'plannedRecipientCount', 'deliveredCount', 'failedCount', 'transferred', 'failed']) {
    assert.ok(fn.includes(field), `airdrop records must include ${field}`);
  }
  // Planned final sweep evidence. The report publishes before sweep, so it
  // records the destination as planned transfer metadata rather than a
  // completed sweep claim.
  for (const field of ['getPlannedSweepDestinationWallet', 'destinationWallet', 'planned-before-sweep']) {
    assert.ok(fn.includes(field), `transfer metadata must include ${field}`);
  }
  // All four position types feed the array.
  for (const t of ["'main'", "'ladder'", "'support'", "'bootstrap'"]) {
    assert.ok(fn.includes(t), `positions must include type ${t}`);
  }
  // v1 compatibility: flat mint + pools[].poolId survive (the publish path
  // and the Arweave tags key off them).
  assert.ok(/mint: createdTokenInfo\?\.mint \|\| null,/.test(fn), 'flat mint field must remain');
  assert.ok(/poolId: r\.poolId \|\| null,/.test(fn), 'pools[].poolId must remain');
});

test('createdTokenInfo captures token-safety facts on both paths', () => {
  const lpExec = readFileSync(path.join(REPO, 'public', 'modules', 'lp-execution.js'), 'utf8');
  const journals = readFileSync(path.join(REPO, 'public', 'modules', 'journals.js'), 'utf8');
  for (const src of [lpExec, journals]) {
    for (const field of ['metadataUri', 'mintAuthorityRenounced', 'freezeAuthorityDisabled', 'metadataUpdateAuthorityRevoked']) {
      assert.ok(src.includes(field), `createdTokenInfo capture must include ${field}`);
    }
  }
});

test('HTML report renders Fee Key NFTs and the verification section', () => {
  assert.ok(
    (reportSrc.match(/renderAddressRow\('Fee Key NFT'/g) || []).length >= 4,
    'all four position types must render a Fee Key NFT row when recorded',
  );
  assert.ok(/Auditing this launch/.test(reportSrc), 'verification section must exist');
  assert.ok(/trebuchet-launch-report/.test(reportSrc), 'verification section must name the Arweave Data-Protocol tag');
  assert.ok(/Contract safety/.test(reportSrc), 'token section must include contract-safety facts');
  assert.ok(/Planned sweep destination/.test(reportSrc), 'token section must render the planned sweep destination when known');
});

test('demo mode mirrors the audit fields (report parity)', () => {
  assert.ok(
    (demoSrc.match(/feeKeyNftMint = demoAddress\(\)/g) || []).length >= 4,
    'demo locks must mint distinct Fee Key NFTs for all four position types',
  );
  assert.ok(
    /const demoFeeKeyMint = pos\.feeKeyNftMint \|\| pos\.nftMint;/.test(demoSrc),
    'demo Phase 4 must remove the Fee Key mint from the wallet',
  );
});
