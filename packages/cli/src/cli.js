import process from 'node:process';
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
        capabilities: ['plan-build', 'plan-verify', 'estimate', 'proof-verify'],
        transactionExecution: false,
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
    } else {
      throw commandError(TrebuchetCoreErrorCode.INVALID_INPUT, `Unknown command: ${command}`);
    }

    if (options.json) writeLine(stdout, JSON.stringify(resultEnvelope({ ok: true, command, data })));
    else humanOutput?.();
    return CliExitCode.SUCCESS;
  } catch (error) {
    const normalized = error instanceof TrebuchetCoreError
      ? error
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
