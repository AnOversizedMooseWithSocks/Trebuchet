import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CliExitCode,
  runCli,
  TREBUCHET_CLI_RESULT_SCHEMA,
} from '@trebuchet/cli';
import { v2LaunchProofFingerprint, v2TransferEvidenceHash } from '@trebuchet/core';

function captureStream() {
  let output = '';
  return {
    write(chunk) {
      output += String(chunk);
      return true;
    },
    text() {
      return output;
    },
  };
}

async function invoke(argv, dependencies = {}) {
  const stdout = captureStream();
  const stderr = captureStream();
  const exitCode = await runCli(argv, { stdout, stderr, ...dependencies });
  return { exitCode, stdout: stdout.text(), stderr: stderr.text() };
}

async function withTempDirectory(fn) {
  const directory = await mkdtemp(path.join(tmpdir(), 'trebuchet-cli-'));
  try {
    return await fn(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const launchIntent = {
  token: {
    name: 'CLI Launch',
    symbol: 'CLI',
    supply: '1000000000',
    description: 'CLI contract test',
  },
  mode: 'dry-run',
  launchSol: 1,
  walletPublicKey: '11111111111111111111111111111115',
  poolTopology: {
    targetMarketCapUsd: 250000,
    pools: [{
      quoteSymbol: 'SOL',
      quoteMint: 'So11111111111111111111111111111111111111112',
      supplyPercent: 100,
      distribution: [{ sharePercent: 100 }],
      ladder: { mode: 'off' },
      support: { mode: 'off' },
    }],
    sweepDestination: '11111111111111111111111111111116',
  },
};

function completeProof() {
  const proof = {
    status: 'completed',
    stage: 'transfer_completed',
    journalId: 'journal-cli-1',
    walletPublicKey: '11111111111111111111111111111115',
    token: {
      mint: '11111111111111111111111111111117',
      mintAuthorityRenounced: true,
      freezeAuthorityDisabled: true,
      metadataUpdateAuthorityRevoked: true,
      metadataImmutable: true,
    },
    liquidity: {
      poolIds: ['11111111111111111111111111111118'],
      results: [{
        poolId: '11111111111111111111111111111118',
        createPoolTx: 'create-pool-tx',
        mainPositions: [{
          positionNftMint: '11111111111111111111111111111119',
          feeKeyNftMint: '1111111111111111111111111111111A',
          locked: true,
          openTx: 'open-position-tx',
          lockTx: 'lock-position-tx',
        }],
      }],
    },
    airdrop: { plannedRecipientCount: 0, deliveredCount: 0, failedCount: 0 },
    transfer: {
      status: 'completed',
      destinationWallet: '11111111111111111111111111111116',
      walletEmpty: true,
      solTxId: 'sweep-sol-tx',
      tokenTransferErrors: [],
      nftTransferErrors: [],
    },
  };
  proof.terminalTransferEvidenceHash = v2TransferEvidenceHash(proof.transfer);
  return proof;
}

test('doctor emits one versioned JSON envelope and advertises read-only capability', async () => {
  const result = await invoke(['doctor', '--json'], { nodeVersion: '22.12.0', platform: 'linux' });
  assert.equal(result.exitCode, CliExitCode.SUCCESS);
  assert.equal(result.stderr, '');
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.schema, TREBUCHET_CLI_RESULT_SCHEMA);
  assert.equal(payload.ok, true);
  assert.equal(payload.command, 'doctor');
  assert.equal(payload.data.transactionExecution, false);
  assert.deepEqual(payload.data.capabilities, ['plan-build', 'plan-verify', 'estimate', 'proof-verify']);
});

test('plan build, verify, and estimate share the Core integrity contract', async () => withTempDirectory(async (directory) => {
  const configPath = path.join(directory, 'launch.json');
  const planPath = path.join(directory, 'plan.json');
  await writeFile(configPath, JSON.stringify(launchIntent));

  const built = await invoke(['plan', 'build', '--config', configPath, '--out', planPath, '--json']);
  assert.equal(built.exitCode, CliExitCode.SUCCESS);
  assert.equal(built.stderr, '');
  const builtPayload = JSON.parse(built.stdout);
  assert.equal(builtPayload.ok, true);
  assert.equal(builtPayload.data.outputPath, planPath);
  assert.equal(builtPayload.data.plan, null);

  const plan = JSON.parse(await readFile(planPath, 'utf8'));
  assert.equal(plan.schema, 'trebuchet-launch-plan/v1');
  assert.equal(plan.integrity.algorithm, 'sha256');

  const verified = await invoke(['plan', 'verify', planPath, '--json']);
  assert.equal(verified.exitCode, CliExitCode.SUCCESS);
  assert.equal(JSON.parse(verified.stdout).data.valid, true);

  const estimated = await invoke(['estimate', '--plan', planPath, '--json']);
  assert.equal(estimated.exitCode, CliExitCode.SUCCESS);
  const estimate = JSON.parse(estimated.stdout).data;
  assert.equal(estimate.schema, 'trebuchet-launch-estimate/v1');
  assert.equal(estimate.operationCount, 7);
  assert.equal(estimate.planDigest, plan.integrity.digest);
}));

test('tampered plans fail with the stable integrity exit code', async () => withTempDirectory(async (directory) => {
  const configPath = path.join(directory, 'launch.json');
  const planPath = path.join(directory, 'plan.json');
  await writeFile(configPath, JSON.stringify(launchIntent));
  assert.equal(
    (await invoke(['plan', 'build', '--config', configPath, '--out', planPath])).exitCode,
    CliExitCode.SUCCESS,
  );
  const plan = JSON.parse(await readFile(planPath, 'utf8'));
  plan.funding.estimatedSolCost += 1;
  await writeFile(planPath, JSON.stringify(plan));

  const result = await invoke(['plan', 'verify', planPath, '--json']);
  assert.equal(result.exitCode, CliExitCode.INTEGRITY_MISMATCH);
  assert.equal(result.stderr, '');
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.error.code, 'INTEGRITY_MISMATCH');
  assert.ok(payload.error.details.errors.some(({ code }) => code === 'INTEGRITY_MISMATCH'));
}));

test('proof verify independently accepts matching evidence and rejects stale fingerprints', async () => withTempDirectory(async (directory) => {
  const proof = completeProof();
  const payload = {
    schema: 'trebuchet-v2-proof',
    source: 'trebuchet-v2',
    proof,
    fieldVerification: { proofFingerprint: v2LaunchProofFingerprint(proof) },
  };
  const proofPath = path.join(directory, 'proof.json');
  await writeFile(proofPath, JSON.stringify(payload));

  const valid = await invoke(['proof', 'verify', proofPath, '--json']);
  assert.equal(valid.exitCode, CliExitCode.SUCCESS);
  assert.equal(JSON.parse(valid.stdout).data.valid, true);

  payload.fieldVerification.proofFingerprint = 'stale';
  await writeFile(proofPath, JSON.stringify(payload));
  const invalid = await invoke(['proof', 'verify', proofPath, '--json']);
  assert.equal(invalid.exitCode, CliExitCode.INTEGRITY_MISMATCH);
  assert.equal(JSON.parse(invalid.stdout).error.code, 'INTEGRITY_MISMATCH');
}));

test('invalid commands fail without prompts and keep JSON errors on stdout', async () => {
  const result = await invoke(['launch', 'run', '--json']);
  assert.equal(result.exitCode, CliExitCode.INVALID_INPUT);
  assert.equal(result.stderr, '');
  assert.equal(JSON.parse(result.stdout).error.code, 'INVALID_INPUT');

  const misplacedOption = await invoke(['doctor', '--config', 'launch.json', '--json']);
  assert.equal(misplacedOption.exitCode, CliExitCode.INVALID_INPUT);
  assert.match(JSON.parse(misplacedOption.stdout).error.message, /--config is not valid here/);
});

test('the workspace bin entry executes without Electron or the Local API', () => {
  const result = spawnSync(
    process.execPath,
    ['packages/cli/bin/trebuchet.js', 'doctor', '--json'],
    { cwd: new URL('..', import.meta.url), encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.data.transactionExecution, false);
});

test('the packed root package bundles Core and runs the published CLI in isolation', async () => withTempDirectory(async (directory) => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const npmCache = process.env.TREBUCHET_NPM_PACK_CACHE
    || path.join(tmpdir(), 'trebuchet-cli-pack-cache');
  const packed = spawnSync(
    npmCommand,
    ['pack', '--json', '--pack-destination', directory],
    {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, npm_config_cache: npmCache },
    },
  );
  assert.equal(packed.status, 0, packed.stderr);
  const [{ filename, bundled = [] }] = JSON.parse(packed.stdout);
  assert.ok(bundled.includes('@trebuchet/core'), 'packed package must bundle @trebuchet/core');

  const extractDirectory = path.join(directory, 'extract');
  await mkdir(extractDirectory);
  const extracted = spawnSync(
    'tar',
    ['-xf', path.join(directory, filename), '-C', extractDirectory],
    { encoding: 'utf8' },
  );
  assert.equal(extracted.status, 0, extracted.stderr);

  const result = spawnSync(
    process.execPath,
    ['packages/cli/bin/trebuchet.js', 'doctor', '--json'],
    { cwd: path.join(extractDirectory, 'package'), encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, true);
  assert.equal(payload.data.transactionExecution, false);
}));
