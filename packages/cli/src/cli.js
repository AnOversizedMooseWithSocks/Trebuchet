import process from 'node:process';
import path from 'node:path';
import {
  createTrebuchetCore,
  TREBUCHET_CORE_VERSION,
  TrebuchetCoreError,
  TrebuchetCoreErrorCode,
} from '@trebuchet/core';
import { parseCliArguments, CliArgumentError } from './arguments.js';
import { CliExitCode, exitCodeForError } from './exit-codes.js';
import { readJsonFile, writeJsonFileAtomic } from './files.js';
import { CLI_HELP } from './help.js';
import { runDemoExecute } from './execute.js';
import {
  CONFIRMATION_NETWORKS,
  secretKeyToEd25519Material,
  signConfirmation,
  verifyConfirmation,
} from '@trebuchet/core/confirmation';
import {
  CustodyError,
  decryptCustodyKeyfile,
  encryptCustodyKeyfile,
  openCustodySession,
  readCustodyKeyfileMeta,
} from '@trebuchet/core/custody';
import { createLaunchStore } from '@trebuchet/core/launch-store';
import { createFlywheelPoolStore, isValidFlywheelMint } from '@trebuchet/core/flywheel-pools';
import { isPlaceholderSweepDestination } from '@trebuchet/core/validators';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import fs from 'node:fs';

export const TREBUCHET_CLI_VERSION = '0.1.0';
export const TREBUCHET_CLI_RESULT_SCHEMA = 'trebuchet-cli-result/v1';

function writeLine(stream, value = '') {
  stream.write(`${value}\n`);
}

function commandName(positionals = []) {
  return positionals.join(' ') || 'help';
}

function resultEnvelope({ ok, command, data = null, error = null }) {
  return {
    schema: TREBUCHET_CLI_RESULT_SCHEMA,
    ok,
    command,
    data,
    error,
  };
}

function parseNodeVersion(version = process.versions.node) {
  const [major = 0, minor = 0, patch = 0] = String(version).split('.').map(Number);
  return { version: `${major}.${minor}.${patch}`, major, minor, patch };
}

function nodeVersionSupported(node) {
  return node.major > 22 || (node.major === 22 && node.minor >= 12);
}

function commandError(code, message, details = null) {
  return new TrebuchetCoreError(code, message, { details });
}

// Saved-launch store resolution: explicit --config-dir, then the app's
// TREBUCHET_CONFIG_DIR, then the current directory (matching the fallback the
// root compat entrypoints use).
function cliFlywheelStore(configDirOption) {
  const dir = configDirOption || process.env.TREBUCHET_CONFIG_DIR || process.cwd();
  return createFlywheelPoolStore({
    filePath: path.join(dir, 'flywheelPools.json'),
    onWarn: () => {},
    onError: (message) => { throw new Error(message); },
  });
}

function cliLaunchStore(configDirOption) {
  const dir = configDirOption || process.env.TREBUCHET_CONFIG_DIR || process.cwd();
  return createLaunchStore({
    filePath: path.join(dir, 'launches.json'),
    onWarn: () => {},
    onError: (message) => { throw new Error(message); },
  });
}

function requirePositionals(positionals, expected, usage) {
  if (positionals.length !== expected.length || expected.some((value, index) => positionals[index] !== value)) {
    throw commandError(TrebuchetCoreErrorCode.INVALID_INPUT, `Usage: ${usage}`);
  }
}

function requireOptions(options, allowed, usage) {
  const unexpected = Object.keys(options).filter((key) => !allowed.includes(key));
  if (unexpected.length) {
    throw commandError(
      TrebuchetCoreErrorCode.INVALID_INPUT,
      `Option --${unexpected[0]} is not valid here. Usage: ${usage}`,
    );
  }
}

function humanVerification(label, result, stdout, stderr) {
  const output = result.valid ? stdout : stderr;
  writeLine(output, `${label}: ${result.valid ? 'valid' : 'invalid'}`);
  if (result.digest) writeLine(output, `Digest: ${result.digest}`);
  if (result.fingerprint) writeLine(output, `Fingerprint: ${result.fingerprint}`);
  for (const error of result.errors || []) writeLine(output, `- ${error.message}`);
}

export async function runCli(argv = [], {
  stdout = process.stdout,
  stderr = process.stderr,
  platform = process.platform,
  nodeVersion = process.versions.node,
  core = createTrebuchetCore(),
} = {}) {
  const jsonRequested = argv.includes('--json');
  let parsed;
  try {
    parsed = parseCliArguments(argv);
  } catch (error) {
    const cliError = commandError(TrebuchetCoreErrorCode.INVALID_INPUT, error.message);
    if (jsonRequested) {
      writeLine(stdout, JSON.stringify(resultEnvelope({
        ok: false,
        command: 'unknown',
        error: { code: cliError.code, message: cliError.message },
      })));
    } else {
      writeLine(stderr, cliError.message);
      writeLine(stderr, 'Run `trebuchet --help` for usage.');
    }
    return CliExitCode.INVALID_INPUT;
  }

  const { options, positionals } = parsed;
  const command = commandName(positionals);
  try {
    if (options.help || positionals.length === 0) {
      if (options.json) {
        writeLine(stdout, JSON.stringify(resultEnvelope({ ok: true, command: 'help', data: { text: CLI_HELP } })));
      } else {
        writeLine(stdout, CLI_HELP);
      }
      return CliExitCode.SUCCESS;
    }
    if (options.version) {
      const data = { cliVersion: TREBUCHET_CLI_VERSION, coreVersion: TREBUCHET_CORE_VERSION };
      if (options.json) writeLine(stdout, JSON.stringify(resultEnvelope({ ok: true, command: 'version', data })));
      else writeLine(stdout, `Trebuchet CLI ${data.cliVersion} · Core ${data.coreVersion}`);
      return CliExitCode.SUCCESS;
    }

    let data;
    let humanOutput = null;
    if (positionals[0] === 'doctor') {
      requirePositionals(positionals, ['doctor'], 'trebuchet doctor [--json]');
      requireOptions(options, ['json'], 'trebuchet doctor [--json]');
      const node = parseNodeVersion(nodeVersion);
      const platformSupported = ['darwin', 'linux', 'win32'].includes(platform);
      data = {
        cliVersion: TREBUCHET_CLI_VERSION,
        coreVersion: core.version,
        protocolVersion: core.protocolVersion,
        node: { ...node, supported: nodeVersionSupported(node) },
        platform: { name: platform, supported: platformSupported },
        capabilities: ['plan-build', 'plan-verify', 'estimate', 'proof-verify', 'demo-execute'],
        transactionExecution: false,
        demoExecution: true,
      };
      if (!data.node.supported || !data.platform.supported) {
        throw commandError(TrebuchetCoreErrorCode.NOT_READY, 'This runtime is not supported by the experimental CLI.', data);
      }
      humanOutput = () => {
        writeLine(stdout, `Trebuchet CLI ${data.cliVersion} · Core ${data.coreVersion}`);
        writeLine(stdout, `Node ${data.node.version}: ready`);
        writeLine(stdout, `${data.platform.name}: ready`);
        writeLine(stdout, 'Transaction execution: unavailable (read-only release)');
      };
    } else if (positionals[0] === 'plan' && positionals[1] === 'build') {
      requirePositionals(positionals, ['plan', 'build'], 'trebuchet plan build --config <launch.json> [--out <plan.json>]');
      requireOptions(options, ['config', 'out', 'json'], 'trebuchet plan build --config <launch.json> [--out <plan.json>] [--json]');
      if (!options.config) throw commandError(TrebuchetCoreErrorCode.INVALID_INPUT, '--config is required.');
      const input = await readJsonFile(options.config, 'Launch config');
      const plan = core.planLaunch(input.value);
      const verification = core.verifyPlan(plan);
      if (!verification.valid) {
        throw commandError(TrebuchetCoreErrorCode.INTEGRITY_MISMATCH, 'Generated plan failed verification.', verification.errors);
      }
      const outputPath = options.out ? await writeJsonFileAtomic(options.out, plan) : null;
      data = {
        inputPath: input.path,
        outputPath,
        digest: verification.digest,
        plan: outputPath ? null : plan,
      };
      humanOutput = () => {
        if (outputPath) {
          writeLine(stdout, `Plan written: ${outputPath}`);
          writeLine(stdout, `Digest: ${verification.digest}`);
        } else {
          writeLine(stdout, JSON.stringify(plan, null, 2));
        }
      };
    } else if (positionals[0] === 'plan' && positionals[1] === 'verify') {
      if (positionals.length !== 3) {
        throw commandError(TrebuchetCoreErrorCode.INVALID_INPUT, 'Usage: trebuchet plan verify <plan.json> [--json]');
      }
      requireOptions(options, ['json'], 'trebuchet plan verify <plan.json> [--json]');
      const input = await readJsonFile(positionals[2], 'Launch plan');
      data = { path: input.path, ...core.verifyPlan(input.value) };
      if (!data.valid) {
        throw commandError(TrebuchetCoreErrorCode.INTEGRITY_MISMATCH, 'Launch plan is invalid.', data);
      }
      humanOutput = () => humanVerification('Launch plan', data, stdout, stderr);
    } else if (positionals[0] === 'estimate') {
      requirePositionals(positionals, ['estimate'], 'trebuchet estimate (--plan <plan.json> | --config <launch.json>)');
      requireOptions(options, ['plan', 'config', 'json'], 'trebuchet estimate (--plan <plan.json> | --config <launch.json>) [--json]');
      if (Boolean(options.plan) === Boolean(options.config)) {
        throw commandError(TrebuchetCoreErrorCode.INVALID_INPUT, 'Provide exactly one of --plan or --config.');
      }
      const input = await readJsonFile(options.plan || options.config, options.plan ? 'Launch plan' : 'Launch config');
      data = { inputPath: input.path, ...core.estimateLaunch(input.value) };
      humanOutput = () => {
        writeLine(stdout, `Estimated staged cost: ${data.estimatedSolCost.toFixed(6)} SOL`);
        writeLine(stdout, `Launch liquidity: ${data.launchSol.toFixed(6)} SOL`);
        writeLine(stdout, `Operations: ${data.operationCount}`);
        writeLine(stdout, `Plan digest: ${data.planDigest}`);
      };
    } else if (positionals[0] === 'proof' && positionals[1] === 'verify') {
      if (positionals.length !== 3) {
        throw commandError(TrebuchetCoreErrorCode.INVALID_INPUT, 'Usage: trebuchet proof verify <proof.json> [--json]');
      }
      requireOptions(options, ['json'], 'trebuchet proof verify <proof.json> [--json]');
      const input = await readJsonFile(positionals[2], 'Trebuchet proof');
      data = { path: input.path, ...core.verifyProof(input.value) };
      if (!data.valid) {
        throw commandError(TrebuchetCoreErrorCode.INTEGRITY_MISMATCH, 'Trebuchet proof is invalid.', data);
      }
      humanOutput = () => humanVerification('Trebuchet proof', data, stdout, stderr);
    } else if (positionals[0] === 'execute') {
      const usage = 'trebuchet execute --config <launch.json> [--network demo] [--out <run.json>] [--server <server.js>] [--timeout <seconds>] [--json]';
      requirePositionals(positionals, ['execute'], usage);
      requireOptions(options, ['config', 'network', 'out', 'server', 'timeout', 'json'], usage);
      if (!options.config) throw commandError(TrebuchetCoreErrorCode.INVALID_INPUT, '--config is required.');
      const network = options.network || 'demo';
      if (network !== 'demo') {
        throw commandError(
          TrebuchetCoreErrorCode.NOT_READY,
          `Live execution (${network}) is not available. The CLI can run demo-runtime launches only; mainnet/devnet execution stays blocked until custody, journal, idempotency, and non-interactive confirmation contracts move into Core and pass a funded devnet recovery cycle.`,
        );
      }
      const timeoutMs = options.timeout
        ? Math.max(5, Number(options.timeout)) * 1000
        : 300_000;
      if (!Number.isFinite(timeoutMs)) {
        throw commandError(TrebuchetCoreErrorCode.INVALID_INPUT, '--timeout must be a number of seconds.');
      }
      const summary = await runDemoExecute({
        configPath: options.config,
        outPath: options.out || null,
        serverPath: options.server || null,
        timeoutMs,
        onLog: (message) => {
          if (!options.json) writeLine(stdout, message);
        },
      });
      data = { network: 'demo', ...summary };
      humanOutput = () => {
        writeLine(stdout, 'Demo launch completed.');
        writeLine(stdout, `Run: ${data.runId}`);
        writeLine(stdout, `Wallet: ${data.walletPublicKey} (disposable — destroyed with the run)`);
        writeLine(stdout, `Token mint: ${data.tokenMint}`);
        writeLine(stdout, `Pools: ${data.poolCount}`);
        writeLine(stdout, `Swept to: ${data.sweepDestination}`);
        if (data.outputPath) writeLine(stdout, `Run result: ${data.outputPath}`);
      };
    } else if (positionals[0] === 'launch' && positionals[1] === 'save') {
      const usage = 'trebuchet launch save --config <launch.json> [--name <label>] [--id <id>] [--config-dir <dir>] [--json]';
      requirePositionals(positionals, ['launch', 'save'], usage);
      requireOptions(options, ['config', 'name', 'id', 'config-dir', 'json'], usage);
      if (!options.config) throw commandError(TrebuchetCoreErrorCode.INVALID_INPUT, '--config is required.');
      const input = await readJsonFile(options.config, 'Launch config');
      const store = cliLaunchStore(options['config-dir']);
      const saved = store.save({
        id: options.id || null,
        name: options.name || null,
        config: input.value,
        source: 'cli',
      });
      data = { id: saved.id, name: saved.name, createdAt: saved.createdAt, updatedAt: saved.updatedAt, storePath: store.filePath };
      humanOutput = () => {
        writeLine(stdout, `Saved launch: ${saved.name}`);
        writeLine(stdout, `Id: ${saved.id}`);
        writeLine(stdout, `Store: ${store.filePath}`);
        writeLine(stdout, 'The app shows saved launches the same way it shows saved vanity addresses.');
      };
    } else if (positionals[0] === 'launch' && positionals[1] === 'list') {
      const usage = 'trebuchet launch list [--config-dir <dir>] [--json]';
      requirePositionals(positionals, ['launch', 'list'], usage);
      requireOptions(options, ['config-dir', 'json'], usage);
      const store = cliLaunchStore(options['config-dir']);
      const launches = store.list().map((entry) => ({
        id: entry.id,
        name: entry.name,
        symbol: entry.config?.token?.symbol ?? null,
        supply: entry.config?.token?.supply ?? null,
        pools: Array.isArray(entry.config?.poolTopology?.pools) ? entry.config.poolTopology.pools.length : 0,
        vanity: entry.config?.vanity?.selectedPublicKey || null,
        source: entry.source,
        updatedAt: entry.updatedAt,
      }));
      data = { storePath: store.filePath, launches };
      humanOutput = () => {
        if (!launches.length) {
          writeLine(stdout, `No saved launches in ${store.filePath}`);
          return;
        }
        for (const entry of launches) {
          writeLine(stdout, `${entry.id}  ${entry.symbol || '?'}  ${entry.name}  (${entry.pools} pools${entry.vanity ? `, CA ${entry.vanity}` : ''})`);
        }
      };
    } else if (positionals[0] === 'launch' && positionals[1] === 'remove') {
      const usage = 'trebuchet launch remove --id <id> [--config-dir <dir>] [--json]';
      requirePositionals(positionals, ['launch', 'remove'], usage);
      requireOptions(options, ['id', 'config-dir', 'json'], usage);
      if (!options.id) throw commandError(TrebuchetCoreErrorCode.INVALID_INPUT, '--id is required.');
      const store = cliLaunchStore(options['config-dir']);
      const removed = store.remove(options.id);
      if (!removed) {
        throw commandError(TrebuchetCoreErrorCode.INVALID_INPUT, `No saved launch with id ${options.id}.`);
      }
      data = { id: options.id, removed: true };
      humanOutput = () => writeLine(stdout, `Removed saved launch ${options.id}`);
    } else if (positionals[0] === 'flywheel' && positionals[1] === 'list') {
      const usage = 'trebuchet flywheel list [--kind meme|reserve] [--config-dir <dir>] [--json]';
      requirePositionals(positionals, ['flywheel', 'list'], usage);
      requireOptions(options, ['kind', 'config-dir', 'json'], usage);
      const store = cliFlywheelStore(options['config-dir']);
      const kind = options.kind || 'meme';
      const pools = store.all();
      data = { storePath: store.filePath, kind, mints: pools[kind] || [], pools };
      humanOutput = () => {
        writeLine(stdout, `${kind} flywheel pool (${data.mints.length}):`);
        for (const mint of data.mints) writeLine(stdout, `  ${mint}`);
        writeLine(stdout, `Store: ${store.filePath}`);
      };
    } else if (positionals[0] === 'flywheel' && positionals[1] === 'pick') {
      const usage = 'trebuchet flywheel pick [--kind meme|reserve] [--last <mint>] [--config-dir <dir>] [--json]';
      requirePositionals(positionals, ['flywheel', 'pick'], usage);
      requireOptions(options, ['kind', 'last', 'config-dir', 'json'], usage);
      const store = cliFlywheelStore(options['config-dir']);
      const kind = options.kind || 'meme';
      const mint = store.pick(kind, { last: options.last || null });
      data = { kind, mint };
      humanOutput = () => writeLine(stdout, mint ? `Picked ${kind} flywheel: ${mint}` : `No ${kind} flywheel mints configured.`);
    } else if (positionals[0] === 'flywheel' && positionals[1] === 'add') {
      const usage = 'trebuchet flywheel add --mint <mint> [--kind meme|reserve] [--config-dir <dir>] [--json]';
      requirePositionals(positionals, ['flywheel', 'add'], usage);
      requireOptions(options, ['mint', 'kind', 'config-dir', 'json'], usage);
      if (!options.mint) throw commandError(TrebuchetCoreErrorCode.INVALID_INPUT, '--mint is required.');
      if (!isValidFlywheelMint(options.mint)) {
        throw commandError(TrebuchetCoreErrorCode.INVALID_INPUT, `Not a valid Solana mint address: ${options.mint}`);
      }
      const store = cliFlywheelStore(options['config-dir']);
      const kind = options.kind || 'meme';
      const mints = store.add(kind, options.mint);
      data = { kind, mints };
      humanOutput = () => {
        writeLine(stdout, `Added ${options.mint} to the ${kind} flywheel pool (${mints.length} mints).`);
      };
    } else if (positionals[0] === 'flywheel' && positionals[1] === 'remove') {
      const usage = 'trebuchet flywheel remove --mint <mint> [--kind meme|reserve] [--config-dir <dir>] [--json]';
      requirePositionals(positionals, ['flywheel', 'remove'], usage);
      requireOptions(options, ['mint', 'kind', 'config-dir', 'json'], usage);
      if (!options.mint) throw commandError(TrebuchetCoreErrorCode.INVALID_INPUT, '--mint is required.');
      const store = cliFlywheelStore(options['config-dir']);
      const kind = options.kind || 'meme';
      const removed = store.remove(kind, options.mint);
      if (!removed) throw commandError(TrebuchetCoreErrorCode.INVALID_INPUT, `Mint not in the ${kind} flywheel pool.`);
      data = { kind, removed, mints: store.get(kind) };
      humanOutput = () => writeLine(stdout, `Removed ${options.mint} from the ${kind} flywheel pool.`);
    } else if (positionals[0] === 'custody' && positionals[1] === 'create') {
      const usage = 'trebuchet custody create [--from <keypair.json>] --out <custody.json> [--passphrase <p>] [--json]';
      requirePositionals(positionals, ['custody', 'create'], usage);
      requireOptions(options, ['from', 'out', 'passphrase', 'json'], usage);
      if (!options.out) throw commandError(TrebuchetCoreErrorCode.INVALID_INPUT, '--out <custody.json> is required.');
      const passphrase = options.passphrase || process.env.TREBUCHET_CUSTODY_PASSPHRASE;
      if (!passphrase) {
        throw commandError(TrebuchetCoreErrorCode.CUSTODY_LOCKED, 'Provide --passphrase or set TREBUCHET_CUSTODY_PASSPHRASE.');
      }
      let secretKey;
      if (options.from) {
        const source = await readJsonFile(options.from, 'Source keypair');
        secretKey = Uint8Array.from(source.value?.secretKey || []);
        if (secretKey.length !== 64) {
          throw commandError(TrebuchetCoreErrorCode.INVALID_INPUT, 'Source keypair must contain a 64-byte secretKey array.');
        }
      } else {
        const seed = randomBytes(32);
        const { rawPublicKey } = secretKeyToEd25519Material(seed);
        secretKey = new Uint8Array([...seed, ...rawPublicKey]);
      }
      const keyfile = encryptCustodyKeyfile({ secretKey, passphrase });
      const outputPath = await writeJsonFileAtomic(options.out, keyfile);
      const publicKeyHex = Buffer.from(keyfile.publicKeyRaw).toString('hex');
      data = {
        outputPath,
        publicKeyRaw: keyfile.publicKeyRaw,
        publicKeyHex,
        imported: Boolean(options.from),
      };
      humanOutput = () => {
        writeLine(stdout, `Custody keyfile written: ${outputPath}`);
        writeLine(stdout, `Public key (raw hex): ${publicKeyHex}`);
        writeLine(stdout, data.imported ? 'Imported an existing keypair.' : 'Generated a fresh keypair.');
        writeLine(stdout, 'Keep the passphrase safe: without it the key is unrecoverable.');
      };
    } else if (positionals[0] === 'confirm') {
      const usage = 'trebuchet confirm --plan <plan.json> --keyfile <custody.json> --network <demo|devnet|mainnet> --max-spend-sol <n> [--wallet <pubkey>] [--expires-in <hours>] [--passphrase <p>] [--out <confirmation.json>] [--json]';
      requirePositionals(positionals, ['confirm'], usage);
      requireOptions(options, ['plan', 'keyfile', 'network', 'max-spend-sol', 'wallet', 'expires-in', 'passphrase', 'out', 'json'], usage);
      if (!options.plan) throw commandError(TrebuchetCoreErrorCode.INVALID_INPUT, '--plan is required.');
      if (!options.keyfile) throw commandError(TrebuchetCoreErrorCode.INVALID_INPUT, '--keyfile is required.');
      if (!options.network) throw commandError(TrebuchetCoreErrorCode.INVALID_INPUT, `--network is required (one of: ${[...CONFIRMATION_NETWORKS].join(', ')}).`);
      if (!options['max-spend-sol']) throw commandError(TrebuchetCoreErrorCode.INVALID_INPUT, '--max-spend-sol is required.');
      const passphrase = options.passphrase || process.env.TREBUCHET_CUSTODY_PASSPHRASE;
      if (!passphrase) {
        throw commandError(TrebuchetCoreErrorCode.CUSTODY_LOCKED, 'Provide --passphrase or set TREBUCHET_CUSTODY_PASSPHRASE.');
      }
      const planInput = await readJsonFile(options.plan, 'Launch plan');
      const verification = core.verifyPlan(planInput.value);
      if (!verification.valid) {
        throw commandError(TrebuchetCoreErrorCode.INTEGRITY_MISMATCH, 'Launch plan is invalid; refusing to sign a confirmation.', verification.errors);
      }
      // A placeholder sweep destination is unrecoverable: swept assets and the
      // Fee Key NFTs would be lost forever. Never sign one for a real network.
      const sweepDestination = planInput.value?.poolTopology?.sweepDestination;
      if (String(options.network).toLowerCase() !== 'demo'
        && isPlaceholderSweepDestination(sweepDestination)) {
        throw commandError(
          TrebuchetCoreErrorCode.INVALID_INPUT,
          `Refusing to sign: sweep destination ${sweepDestination} is a placeholder address. `
          + 'Swept SOL, tokens, and the Fee Key NFTs would be unrecoverable and trading fees could never be claimed. '
          + 'Point the plan at a wallet you control.',
        );
      }
      const keyfileInput = await readJsonFile(options.keyfile, 'Custody keyfile');
      let decrypted;
      try {
        decrypted = decryptCustodyKeyfile(keyfileInput.value, { passphrase });
      } catch (error) {
        throw commandError(TrebuchetCoreErrorCode.CUSTODY_LOCKED, error.message);
      }
      const session = openCustodySession(decrypted);
      const hours = options['expires-in'] ? Math.max(0.01, Number(options['expires-in'])) : 24;
      const expiresAt = new Date(Date.now() + hours * 3600_000).toISOString();
      let confirmation;
      try {
        confirmation = signConfirmation({
          planDigest: verification.digest,
          network: options.network,
          maxSpendSol: Number(options['max-spend-sol']),
          walletPublicKey: options.wallet || null,
          expiresAt,
          tool: `trebuchet-cli/${TREBUCHET_CLI_VERSION}`,
        }, session.getSecretKey());
      } finally {
        session.lock();
      }
      const outputPath = options.out ? await writeJsonFileAtomic(options.out, confirmation) : null;
      const signerHex = Buffer.from(confirmation.signerRawPublicKey).toString('hex');
      data = { confirmation, outputPath, signerHex, planDigest: verification.digest };
      humanOutput = () => {
        writeLine(stdout, 'Confirmation signed.');
        writeLine(stdout, `Plan digest: ${verification.digest}`);
        writeLine(stdout, `Network: ${confirmation.payload.network} · max spend: ${confirmation.payload.maxSpendSol} SOL`);
        writeLine(stdout, `Expires: ${confirmation.payload.expiresAt}`);
        writeLine(stdout, `Signer (raw hex): ${signerHex}`);
        if (outputPath) writeLine(stdout, `Confirmation: ${outputPath}`);
      };
    } else if (positionals[0] === 'confirmation' && positionals[1] === 'verify') {
      const usage = 'trebuchet confirmation verify <confirmation.json> [--expect-plan <plan.json>] [--json]';
      if (positionals.length !== 3) {
        throw commandError(TrebuchetCoreErrorCode.INVALID_INPUT, `Usage: ${usage}`);
      }
      requireOptions(options, ['expect-plan', 'json'], usage);
      const input = await readJsonFile(positionals[2], 'Confirmation');
      let expectPlanDigest;
      if (options['expect-plan']) {
        const planInput = await readJsonFile(options['expect-plan'], 'Launch plan');
        const planVerification = core.verifyPlan(planInput.value);
        if (!planVerification.valid) {
          throw commandError(TrebuchetCoreErrorCode.INTEGRITY_MISMATCH, 'Expected launch plan is invalid.');
        }
        expectPlanDigest = planVerification.digest;
      }
      const result = verifyConfirmation(input.value, { expectPlanDigest });
      data = { path: input.path, ...result };
      if (!result.valid) {
        throw commandError(TrebuchetCoreErrorCode.INTEGRITY_MISMATCH, 'Confirmation is invalid.', result.errors);
      }
      humanOutput = () => {
        writeLine(stdout, 'Confirmation: valid');
        writeLine(stdout, `Plan digest: ${result.payload.planDigest}`);
        writeLine(stdout, `Network: ${result.payload.network} · max spend: ${result.payload.maxSpendSol} SOL`);
        writeLine(stdout, `Expires: ${result.payload.expiresAt}`);
      };
    } else {
      throw commandError(TrebuchetCoreErrorCode.INVALID_INPUT, `Unknown command: ${command}`);
    }

    if (options.json) writeLine(stdout, JSON.stringify(resultEnvelope({ ok: true, command, data })));
    else humanOutput?.();
    return CliExitCode.SUCCESS;
  } catch (error) {
    const normalized = error instanceof TrebuchetCoreError
      ? error
      : error?.name === 'ExecuteError'
        ? commandError(TrebuchetCoreErrorCode.RETRYABLE_DEPENDENCY, error.message, error.serverLog ? [error.serverLog.slice(-4000)] : null)
      : error?.name === 'CustodyError'
        ? commandError(TrebuchetCoreErrorCode.CUSTODY_LOCKED, error.message)
      : error instanceof CliArgumentError || error instanceof TypeError || error?.code === 'ENOENT'
        ? commandError(TrebuchetCoreErrorCode.INVALID_INPUT, error.message)
        : commandError(TrebuchetCoreErrorCode.INTERNAL, error.message || 'Unexpected CLI failure.');
    const exitCode = exitCodeForError(normalized);
    const errorData = {
      code: normalized.code,
      message: normalized.message,
      details: normalized.details || null,
    };
    if (options.json) {
      writeLine(stdout, JSON.stringify(resultEnvelope({ ok: false, command, error: errorData })));
    } else {
      writeLine(stderr, normalized.message);
      if (Array.isArray(normalized.details)) {
        for (const detail of normalized.details) writeLine(stderr, `- ${detail.message || detail}`);
      }
    }
    return exitCode;
  }
}
