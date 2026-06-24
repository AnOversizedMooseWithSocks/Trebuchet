import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import { Keypair } from '@solana/web3.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let _binaryPath = null;

// Check whether the vanity_keygen binary is built and available. Returns
// { available: bool, reason?: string, path?: string }. Cheap to call —
// getBinaryPath uses fs.existsSync probes which take microseconds, and the
// successful result is cached in _binaryPath so repeat calls are O(1).
//
// Server uses this at startup to log a warning if missing, exposes the
// flag via /api/demo/status so the frontend can disable the vanity UI,
// and the vanity endpoints call it again at request time to short-circuit
// with a clear error if the binary still isn't there. Dev-only friction:
// the binary requires a C compiler to build (npm run build:c), and not
// every contributor has one. CI handles release builds, so end-user
// builds always include the binary.
export function isVanityAvailable() {
  try {
    const path = getBinaryPath();
    return { available: true, path };
  } catch (err) {
    return { available: false, reason: err.message };
  }
}

function getBinaryPath() {
  if (_binaryPath) return _binaryPath;

  // Platform-aware binary name. On Windows the C build produces
  // vanity_keygen.exe (mingw/MSVC append .exe automatically) and
  // child_process.spawn() requires the extension to launch the file
  // — Windows won't find a bare-named executable from a spawn call
  // the way it would from cmd.exe via PATHEXT. We try .exe first
  // and fall back to the bare name in case the user built with an
  // unusual toolchain that didn't append it.
  const binaryNames = process.platform === 'win32'
    ? ['vanity_keygen.exe', 'vanity_keygen']
    : ['vanity_keygen'];

  // Candidate root directories.
  //   1. unpackedDir: __dirname with '.asar' replaced by '.asar.unpacked'.
  //      In packaged builds, the C binary is asar.unpacked'd into a
  //      sibling folder. In dev mode this replacement is a no-op and
  //      unpackedDir === __dirname (which is why the previous code
  //      reported two identical paths in its error).
  //   2. __dirname: dev mode path, where 'c/build/vanity_keygen' lives
  //      next to this file in a regular working tree.
  //   3. altUnpackedDir: Electron sometimes unpacks to a Resources
  //      sibling of the asar archive rather than alongside it.
  const unpackedDir = __dirname.replace(/\.asar(\/|$)/, '.asar.unpacked$1');
  const altUnpackedDir = path.join(path.dirname(__dirname), 'app.asar.unpacked');
  const roots = [unpackedDir, __dirname, altUnpackedDir];

  // Build the candidate list as roots × names, deduped. Set tracks
  // membership; candidates preserves insertion order so the FIRST
  // candidate to exist is the one returned (deterministic across
  // restarts when multiple builds happen to be present).
  const seen = new Set();
  const candidates = [];
  for (const root of roots) {
    for (const name of binaryNames) {
      const candidate = path.join(root, 'c', 'build', name);
      if (!seen.has(candidate)) {
        seen.add(candidate);
        candidates.push(candidate);
      }
    }
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      _binaryPath = candidate;
      return _binaryPath;
    }
  }

  throw new Error(
    `vanity_keygen binary not found. Tried:\n  ${candidates.join('\n  ')}\n\n`
    + `To build it: run \`npm run build:c\` from the repo root. `
    + `Requires a C compiler (gcc or clang) on PATH. See the `
    + `"Building the vanity keygen binary" section in the README for `
    + `per-platform install instructions.`,
  );
}

/**
 * Generate a Solana keypair with a vanity prefix or suffix.
 *
 * Spawns the C vanity keygen binary and reads its JSON output.
 * The output includes the keypair, attempt count, and rarity tier.
 * The deterministic seed is NOT exposed — it equals the private key.
 */
let _inFlight = null;

// Track the currently-running child so cancelVanityGrind() can kill it,
// plus a flag the close handler uses to distinguish "user cancelled" from
// "binary crashed with a non-zero exit." We reset both on each new spawn
// so a prior cancellation doesn't taint the next grind.
let _activeChild = null;
let _cancelled = false;

/**
 * Kill any in-flight vanity grind. Returns true if a grind was actually
 * killed, false if there was nothing running. Safe to call when idle.
 *
 * The actual cleanup (clearing _inFlight, _activeChild, rejecting the
 * caller's promise) happens in the existing child.on('close') handler
 * once the OS finishes terminating the process — usually within a few
 * milliseconds of this call.
 */
export function cancelVanityGrind() {
  if (!_activeChild) return false;
  _cancelled = true;
  try {
    // child.kill() with no signal arg sends SIGTERM on Unix and calls
    // TerminateProcess on Windows. The vanity binary has no important
    // state to flush — it just sits in a tight keypair-generation loop —
    // so forceful termination is appropriate.
    _activeChild.kill();
  } catch (_) {
    // Already exited / already killed. The close handler will run
    // anyway with whatever exit code the OS reports, and the
    // _cancelled flag will cause it to surface as a CANCELLED error.
  }
  return true;
}

export function generateVanityKeypair({ prefix, suffix, threads, blockhash, onProgress } = {}) {
  // Single-flight guard: only one grind at a time.  If a grind is
  // already running, reject immediately to avoid spawning concurrent
  // native processes that would fight for CPU / memory.
  if (_inFlight) {
    return Promise.reject(new Error('A vanity grind is already in progress'));
  }

  let flightResolve, flightReject;
  _inFlight = new Promise((res, rej) => { flightResolve = res; flightReject = rej; });

  return new Promise((resolve, reject) => {
    // Reject + clear in-flight in one place. Without this, the early-throw
    // paths below (binary-path resolution, prefix/suffix validation) would
    // leak _inFlight and every subsequent grind attempt would fail with
    // "already in progress" — recoverable only by restarting the server.
    // The 'close' and 'error' event handlers also clear _inFlight, but
    // they only fire if spawn() reached an event loop tick. Calling
    // safeReject when those handlers already cleared the flag is a no-op
    // (null = null), so it's safe to use throughout.
    const safeReject = (err) => {
      _inFlight = null;
      if (flightResolve) flightResolve();
      reject(err);
    };

    let binary;
    try {
      binary = getBinaryPath();
    } catch (e) {
      safeReject(e);
      return;
    }

    const args = [];
    if (!prefix && !suffix) {
      safeReject(new Error('Must specify either prefix or suffix'));
      return;
    }
    if (prefix) {
      args.push('--prefix', prefix);
    }
    if (suffix) {
      args.push('--suffix', suffix);
    }

    if (threads && threads > 0) {
      args.push('--threads', String(threads));
    }
    if (blockhash) {
      args.push('--vrf-blockhash', blockhash);
    }

    // spawn() can throw synchronously (e.g. ENOENT before the 'error'
    // event would fire) on some platforms. Guard with try/catch so a
    // failed spawn also clears _inFlight.
    let child;
    try {
      child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (spawnErr) {
      safeReject(new Error(`Spawn failed: ${spawnErr.message}`));
      return;
    }

    // Register this child so cancelVanityGrind() can find and kill it.
    // Reset the cancellation flag — a stuck-true from a previous run
    // that was already cleaned up would otherwise cause this fresh
    // grind to surface as cancelled the moment it exits normally.
    _activeChild = child;
    _cancelled = false;

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => { stdout += data.toString(); });

    child.stderr.on('data', (data) => {
      const text = data.toString();
      stderr += text;
      if (onProgress) {
        const m = text.match(/Attempts:\s*(\d+)/);
        if (m) {
          const keyMatch = text.match(/Key:\s*(\S+)/);
          onProgress({ attempts: Number(m[1]), key: keyMatch ? keyMatch[1] : null });
        }
      }
    });

    child.on('close', (code) => {
      _inFlight = null;
      _activeChild = null;
      const wasCancelled = _cancelled;
      _cancelled = false;
      if (flightResolve) flightResolve();

      if (wasCancelled) {
        // User requested cancellation via cancelVanityGrind(). Surface
        // this as a structured error so the SSE-stream handler in
        // server.js can emit a {type:'cancelled'} event instead of a
        // generic error event. The exit code is whatever the OS
        // reported when the kill landed — usually a signal-ish value
        // on Unix or 1 on Windows; not interesting to callers.
        const err = new Error('Vanity grind cancelled by user');
        err.code = 'CANCELLED';
        reject(err);
        return;
      }

      if (code !== 0) {
        reject(new Error(`Vanity keygen exited ${code}: ${stderr}`));
        return;
      }
      try {
        const result = JSON.parse(stdout.trim());
        if (!result.secretKey || !result.publicKey) {
          reject(new Error('Output missing secretKey or publicKey'));
          return;
        }
        const keypair = Keypair.fromSecretKey(Uint8Array.from(result.secretKey));
        const vrfFields = {};
        if (result.vrfProof) {
          vrfFields.vrfProof = result.vrfProof;
          vrfFields.vrfPk = result.vrfPk;
          vrfFields.vrfBlockhash = result.vrfBlockhash;
        }
        resolve({
          publicKey: result.publicKey,
          secretKey: result.secretKey,
          keypair,
          attempts: result.attempts,
          rarity: result.rarity,
          epochs: result.epochs,
          expectedAttempts: result.expectedAttempts,
          elapsedSec: result.elapsedSec,
          target: result.target,
          prefix: result.prefix,
          suffix: result.suffix,
          targetLen: result.targetLen,
          ...vrfFields,
        });
      } catch (err) {
        reject(new Error(`Parse error: ${err.message}`));
      }
    });

    child.on('error', (err) => {
      _inFlight = null;
      _activeChild = null;
      const wasCancelled = _cancelled;
      _cancelled = false;
      if (flightResolve) flightResolve();
      if (wasCancelled) {
        const cancelErr = new Error('Vanity grind cancelled by user');
        cancelErr.code = 'CANCELLED';
        reject(cancelErr);
        return;
      }
      reject(new Error(`Spawn failed: ${err.message}`));
    });
  });
}
