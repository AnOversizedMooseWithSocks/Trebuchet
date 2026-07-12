import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const serverSrc = readFileSync(path.join(REPO, 'server.js'), 'utf8');

// ---------------------------------------------------------------------------
// Per-wallet launch-operation mutex regression tests.
//
// Background: every chain-touching launch endpoint (token creation, quote
// acquisition, pool creation, resume, asset transfer) is long-running and
// mutates the same ephemeral wallet. The server runs in-process with
// Electron main, so a renderer reload mid-launch leaves the operation
// running invisibly — and a recovered UI could fire a second orchestrator
// (duplicate pools), a sweep (pulls funds out from under the launch), or a
// duplicate acquire (double SOL spend) against the same wallet.
//
// The fix is a per-wallet mutex: rejectOrClaimLaunchOp() returns HTTP 409
// with code 'OP_IN_FLIGHT' when any other operation holds the wallet, and
// each handler releases the lock in a finally guarded by claimedLaunchOp
// (so a 409-rejected duplicate never releases the running operation's
// lock). These tests are source-level (same pattern as the
// security-regressions suite) because server.js boots Express on import.
// ---------------------------------------------------------------------------

const ROUTE_HANDLERS = {
  '/api/create-token': 'createTokenHandler',
  '/api/create-lp': 'createLpHandler',
  '/api/resume-launch': 'resumeLaunchHandler',
  '/api/transfer-assets': 'transferAssetsHandler',
};

// Extract a single route handler's source. Some classic handlers are named so
// v2 can dispatch through the same production code path; older routes remain
// anonymous and are sliced from their app.post(...) registration.
function handlerSource(route) {
  const handlerName = ROUTE_HANDLERS[route];
  if (handlerName) {
    assert.ok(
      serverSrc.includes(`app.post('${route}', ${route === '/api/create-token' ? 'uploadLogo, ' : ''}${handlerName});`),
      `route ${route} must be registered to ${handlerName}`,
    );
    const start = serverSrc.indexOf(`async function ${handlerName}(`);
    assert.ok(start >= 0, `handler ${handlerName} must exist in server.js`);
    const rest = serverSrc.slice(start + 1);
    const next = rest.search(/\n(async function|function|app\.(get|post|put|delete)\()/);
    return serverSrc.slice(start, next >= 0 ? start + 1 + next : undefined);
  }
  const start = serverSrc.indexOf(`app.post('${route}'`);
  assert.ok(start >= 0, `route ${route} must exist in server.js`);
  const rest = serverSrc.slice(start + 1);
  const next = rest.search(/app\.(get|post|put|delete)\(/);
  return serverSrc.slice(start, next >= 0 ? start + 1 + next : undefined);
}

test('mutex infrastructure exists', () => {
  assert.ok(
    /const launchOpsInFlight = new Map\(\)/.test(serverSrc),
    'launchOpsInFlight map must exist',
  );
  assert.ok(
    /function rejectOrClaimLaunchOp\(/.test(serverSrc),
    'rejectOrClaimLaunchOp must exist',
  );
  assert.ok(
    /function clearLaunchOpInFlight\(/.test(serverSrc),
    'clearLaunchOpInFlight must exist',
  );
  // The 409 body must carry the machine-readable code the frontend keys on.
  assert.ok(
    /code:\s*'OP_IN_FLIGHT'/.test(serverSrc),
    "409 response must include code: 'OP_IN_FLIGHT'",
  );
  assert.ok(
    /status\(409\)/.test(serverSrc),
    'rejection must use HTTP 409',
  );
});

// Endpoints that claim the lock for the duration of the request and
// release it in a finally. Each must: (a) call the guard with its own op
// name, (b) release conditionally on claimedLaunchOp so a rejected
// duplicate never frees the running op's lock.
for (const [route, op] of [
  ['/api/create-token', 'create-token'],
  ['/api/create-lp', 'create-lp'],
  ['/api/resume-launch', 'resume-launch'],
  ['/api/transfer-assets', 'transfer-assets'],
]) {
  test(`${route} claims and releases the per-wallet mutex`, () => {
    const src = handlerSource(route);
    assert.ok(
      src.includes(`rejectOrClaimLaunchOp(res, walletPublicKey, '${op}')`),
      `${route} must guard with op name '${op}'`,
    );
    assert.ok(
      /claimedLaunchOp = true/.test(src),
      `${route} must record that it claimed the lock`,
    );
    assert.ok(
      /if \(claimedLaunchOp && walletPublicKey\)\s*\{\s*\r?\n\s*clearLaunchOpInFlight\(walletPublicKey\);/.test(src),
      `${route} must release the lock only when it was the claimer`,
    );
    assert.ok(
      /\} finally \{/.test(src),
      `${route} must release in a finally so errors still free the lock`,
    );
  });
}

// The acquire endpoint is different: the job runs in the background after
// the HTTP response returns, so the lock must outlive the handler and be
// released when the job finishes (success or failure).
test('/api/acquire-quote-tokens claims for the job lifetime and releases via onFinished', () => {
  const src = handlerSource('/api/acquire-quote-tokens');
  assert.ok(
    src.includes("rejectOrClaimLaunchOp(res, acquireWalletPk, 'acquire-quote-tokens')"),
    'acquire endpoint must guard before starting the job',
  );
  assert.ok(
    /onFinished:\s*\(\)\s*=>\s*clearLaunchOpInFlight\(acquireWalletPk\)/.test(src),
    'acquire endpoint must release the lock when the job finishes',
  );
  // startAcquireJob must actually invoke onFinished on completion paths.
  assert.ok(
    /function startAcquireJob\(\{ ownerKeypair, autoSwapPlan, onFinished = null \}\)/.test(serverSrc),
    'startAcquireJob must accept onFinished',
  );
  assert.ok(
    /\.finally\(\(\) => \{[\s\S]{0,400}?onFinished\(\)/.test(serverSrc),
    'startAcquireJob must call onFinished in a .finally so both success and failure release the lock',
  );
});

// The 409 rejection path must NOT claim/release: a rejected duplicate that
// nulls walletPublicKey before returning (create-lp / resume) guarantees
// the finally can't tear down the running op's progress tracker either.
test('create-lp and resume-launch null walletPublicKey on rejection to protect the running op', () => {
  for (const route of ['/api/create-lp', '/api/resume-launch']) {
    const src = handlerSource(route);
    const guardIdx = src.indexOf('rejectOrClaimLaunchOp(');
    const slice = src.slice(guardIdx, guardIdx + 400);
    assert.ok(
      /walletPublicKey = null/.test(slice),
      `${route} must null walletPublicKey before returning on 409`,
    );
  }
});

// Frontend contract: the modules that call these endpoints must recognize
// OP_IN_FLIGHT and avoid rendering it as a launch failure.
test('frontend modules handle 409 OP_IN_FLIGHT', () => {
  const modules = [
    'public/modules/lp-execution.js',
    'public/modules/transfer.js',
    'public/modules/cancel-flow.js',
    'public/modules/funding.js',
  ];
  for (const rel of modules) {
    const src = readFileSync(path.join(REPO, rel), 'utf8');
    assert.ok(
      /OP_IN_FLIGHT/.test(src),
      `${rel} must check for the OP_IN_FLIGHT code`,
    );
  }
});
