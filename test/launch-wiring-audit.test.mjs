import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const serverSrc = readFileSync(path.join(REPO, 'server.js'), 'utf8');
const lpSrc = readFileSync(path.join(REPO, 'lpService.js'), 'utf8');
const journalSrc = readFileSync(path.join(REPO, 'launchJournal.js'), 'utf8');
const transferSrc = readFileSync(path.join(REPO, 'public', 'modules', 'transfer.js'), 'utf8');
const tokenConfigSrc = readFileSync(path.join(REPO, 'public', 'modules', 'token-config.js'), 'utf8');
const journalsSrc = readFileSync(path.join(REPO, 'public', 'modules', 'journals.js'), 'utf8');
const lpExecSrc = readFileSync(path.join(REPO, 'public', 'modules', 'lp-execution.js'), 'utf8');
const poolEditorSrc = readFileSync(path.join(REPO, 'public', 'modules', 'pool-editor.js'), 'utf8');

// ---------------------------------------------------------------------------
// Wiring-audit regression tests (ladder / prealloc / airdrop / support).
//
// Source-level assertions, matching the repo's test pattern (server.js
// boots Express on import, so importing it from tests is off the table).
// Each test pins a wiring contract whose absence was a real, found bug:
//
//   1. The journal's event-replay (applyLpEventToResults) must cover ALL
//      position types — support locks were missing, so a crash-resume
//      re-attempted locks against escrowed position NFTs.
//   2. Lock events must carry feeKeyNftMint so crash-resumed launches keep
//      the Fee Key (Phase 4 transfers it; the audit record publishes it).
//   3. The airdrop must be per-recipient idempotent across transfer
//      re-runs — the transfer endpoint is legitimately re-runnable after a
//      partial failure, and re-running used to re-pay every recipient.
//   4. The airdrop plan and result must survive an app restart via the
//      journal, or a resumed launch silently skips its configured airdrop
//      and loses the report's delivered/failed record.
// ---------------------------------------------------------------------------

test('journal replay covers support locks (and keys on supportIndex)', () => {
  assert.ok(
    /if \(event\.stage === 'support_lock_done'[^)]*\) \{\r?\n\s*const pos = result\.supportPositions\?\.\[event\.supportIndex\];/.test(serverSrc),
    'applyLpEventToResults must handle support_lock_done via supportIndex',
  );
});

test('lock events carry feeKeyNftMint end to end', () => {
  // Emitter side: all four lock_done events include the recorded mint.
  for (const [stage, v] of [
    ['main_lock_done', 'pos'],
    ['ladder_lock_done', 'lp'],
    ['support_lock_done', 'sp'],
    ['bootstrap_lock_done', 'bs'],
  ]) {
    const re = new RegExp(
      `stage: '${stage}',[\\s\\S]{0,300}?feeKeyNftMint: ${v}\\.feeKeyNftMint,`,
    );
    assert.ok(re.test(lpSrc), `${stage} event must carry feeKeyNftMint`);
  }
  // Journal side: every lock handler applies it (4 handlers).
  const applies = serverSrc.match(/feeKeyNftMint = event\.feeKeyNftMint \|\|/g) || [];
  assert.ok(applies.length >= 4, `journal handlers must apply feeKeyNftMint (found ${applies.length}/4)`);
});

test('bootstrap_open_done keeps the tick range through the journal', () => {
  assert.ok(
    /stage: 'bootstrap_open_done',[\s\S]{0,300}?tickLower: bsTicks\.tickLower,/.test(lpSrc),
    'bootstrap_open_done event must carry the tick range',
  );
  assert.ok(
    /event\.stage === 'bootstrap_open_done'[\s\S]{0,600}?tickLower: Number\.isFinite\(event\.tickLower\)/.test(serverSrc),
    'journal handler must keep the bootstrap tick range',
  );
});

test('airdrop is a first-class journal field (survives normalizeJournal)', () => {
  assert.ok(
    /airdrop: raw\.airdrop && typeof raw\.airdrop === 'object' \? raw\.airdrop : null,/.test(journalSrc),
    'normalizeJournal must preserve journal.airdrop — it whitelists keys, so an unknown key is dropped on the next load()',
  );
});

test('transfer-assets airdrop step skips recipients already delivered', () => {
  // Reads the journal record, filters by delivered wallet set, and runs
  // executeAirdrop with the pending subset only.
  assert.ok(
    /const priorAirdrop = launchJournal\.activeForWallet\(walletPublicKey\)\?\.airdrop \|\| null;[\s\S]{0,700}?const pendingRecipients = req\.body\.airdrop\.recipients\.filter\(/.test(serverSrc),
    'transfer airdrop must filter against the journal delivered record',
  );
  assert.ok(
    /recipients: pendingRecipients,[\s\S]{0,200}?onProgress: \(s\) => airdropProgressStep/.test(serverSrc),
    'executeAirdrop must receive the pending subset, not the raw request list',
  );
  // The persistent per-recipient record is written at completion.
  assert.ok(
    /\{ airdrop: airdropResult \},[\s\S]{0,200}?stage: 'airdrop_completed',/.test(serverSrc),
    'completion must persist the merged record on journal.airdrop',
  );
  // The all-delivered fast path skips execution entirely.
  assert.ok(
    /airdrop_skipped_already_delivered/.test(serverSrc),
    'a fully-delivered re-run must skip the airdrop with a journal event',
  );
});

test('retry-airdrop dedupes, merges, and returns the merged record', () => {
  // The handler was extracted to a named function when /api/run-airdrop
  // was added as an alias — anchor on the function, not the route line.
  const retryStart = serverSrc.indexOf('async function runAirdropHandler(');
  assert.ok(retryStart >= 0);
  const retry = serverSrc.slice(retryStart, retryStart + 7000);
  assert.ok(
    /const pendingRecipients = recipients\.filter\(\(r\) => !deliveredWallets\.has\(r\.wallet\)\);/.test(retry),
    'retry must drop wallets the journal already records as delivered',
  );
  assert.ok(
    /const mergedAirdrop = \{/.test(retry) && /\{ airdrop: mergedAirdrop \},/.test(retry),
    'retry must persist the merged record on journal.airdrop',
  );
  assert.ok(
    /airdrop: mergedAirdrop,\r?\n\s*\}\);/.test(retry),
    'retry response must return the merged record',
  );
});

test('frontend replaces lastAirdropResult wholesale from the merged response', () => {
  assert.ok(
    /lastAirdropResult = \{\r?\n\s*transferred: data\.airdrop\?\.transferred \|\| \[\],\r?\n\s*failed: data\.airdrop\?\.failed \|\| \[\],\r?\n\s*\};/.test(transferSrc),
    'retry handler must replace (not append) — the server already merged prior delivered rows',
  );
});

test('airdrop plan is journaled at create-lp and restored on resume', () => {
  // Frontend sends the plan with create-lp.
  assert.ok(
    /const plan = buildAirdropTransferPayload\(\);[\s\S]{0,100}?return plan \? \{ airdrop: plan \} : \{\};/.test(lpExecSrc),
    'create-lp request must carry the airdrop plan',
  );
  // Server stores it under poolPlan.airdropPlan.
  assert.ok(
    /airdropPlan: \(req\.body\.airdrop/.test(serverSrc),
    'create-lp handler must journal poolPlan.airdropPlan',
  );
  // Resume restores both the plan and the result record.
  assert.ok(
    /restoredAirdropPayload = journal\.poolPlan\?\.airdropPlan \|\| null;/.test(journalsSrc),
    'journal resume must restore the airdrop plan',
  );
  assert.ok(
    /lastAirdropResult = \(journal\.airdrop && typeof journal\.airdrop === 'object'\)/.test(journalsSrc),
    'journal resume must restore the per-recipient result record',
  );
  // The payload builder falls back to the restored plan, pinned to the mint.
  assert.ok(
    /restoredAirdropPayload\.tokenMint === createdTokenInfo\.mint/.test(tokenConfigSrc),
    'restored-plan fallback must be pinned to the current token mint',
  );
  // New-launch reset clears the restored plan.
  assert.ok(
    /lastAirdropResult = null;\r?\n\s*restoredAirdropPayload = null;/.test(poolEditorSrc),
    'launch reset must clear the restored plan',
  );
});

test('classic resume materializes recoverable Phase 1 pool events before retrying', () => {
  const resumeStart = serverSrc.indexOf("app.post('/api/resume-launch'");
  assert.ok(resumeStart >= 0, 'resume-launch route must exist');
  const resumeSrc = serverSrc.slice(resumeStart, resumeStart + 6500);
  assert.ok(
    /const activeJournal = launchJournal\.activeForWallet\(walletPublicKey\);/.test(resumeSrc),
    'resume-launch must inspect the active journal before starting another attempt',
  );
  assert.ok(
    /materializePhase1RecoveryResults\(\s*activeJournal \|\| \{\},\s*priorResults,\s*allocations,\s*\)/.test(resumeSrc),
    'resume-launch must materialize incomplete Phase 1 pool state from journal events',
  );
  assert.ok(
    /effectivePriorResults = mergePriorResults\(priorResults, phase1Recovery\.recoveredResults\)/.test(resumeSrc),
    'resume-launch must pass recovered Phase 1 entries as priorResults',
  );
  assert.ok(
    /lp_phase1_recovery_prepared/.test(resumeSrc),
    'resume-launch must journal that Phase 1 recovery was prepared',
  );
  assert.ok(
    /code: 'UNSAFE_PARTIAL_POOL_STATE'/.test(resumeSrc) &&
      /manualRecoveryRequired: true/.test(resumeSrc),
    'ambiguous partial pool state must still produce a structured non-retryable response',
  );
});

test('Phase 1 recovery materializer reconstructs opened slices and blocks duplicate pool ids', () => {
  assert.ok(
    /function materializePhase1RecoveryResults\(journal, priorResults, allocations\)/.test(serverSrc),
    'server must have a journal-event materializer for legacy Phase 1 failures',
  );
  assert.ok(
    /phase1Incomplete: true/.test(serverSrc) &&
      /recoveredFrom: 'journal_events'/.test(serverSrc),
    'materialized entries must be explicitly marked as incomplete Phase 1 recovery',
  );
  assert.ok(
    /latestEventsByIndex\(\s*journal\.events,\s*'main_open_done',\s*'sliceIndex',\s*allocationIndex,\s*\)/.test(serverSrc),
    'materializer must replay recorded main_open_done events by slice index',
  );
  assert.ok(
    /multiple created pools recorded for one allocation/.test(serverSrc),
    'materializer must block ambiguous duplicate pool creations',
  );
});

test('active LP failure UI stops offering resume for unsafe partial pool state', () => {
  assert.ok(
    /data\.manualRecoveryRequired \|\| data\.code === 'UNSAFE_PARTIAL_POOL_STATE'/.test(lpExecSrc),
    'resume handler must branch on the unsafe partial-pool response',
  );
  const unsafeBranchStart = lpExecSrc.indexOf("data.code === 'UNSAFE_PARTIAL_POOL_STATE'");
  assert.ok(unsafeBranchStart >= 0, 'unsafe partial-pool branch must exist');
  const unsafeBranch = lpExecSrc.slice(unsafeBranchStart, unsafeBranchStart + 2500);
  assert.ok(
    /btn\.classList\.add\('hidden'\)/.test(unsafeBranch),
    'unsafe partial-pool branch must hide the resume button',
  );
  assert.ok(
    /completed position state was recorded/.test(unsafeBranch),
    'unsafe partial-pool copy must explain why automatic retry stopped',
  );
});

test('report prefers result-recorded pool facts over live config', () => {
  const reportSrc = readFileSync(path.join(REPO, 'public', 'modules', 'launch-report.js'), 'utf8');
  assert.ok(
    /Number\(r\.supplyPercent \?\? userPool\.supplyPercent \?\? 0\)/.test(reportSrc),
    'supply percent must prefer the result-recorded value (live config does not survive a restart)',
  );
  assert.ok(
    /const qm = r\.quoteAddress \|\| userPool\.quoteToken;/.test(reportSrc),
    'quote mint must prefer the result-recorded address',
  );
});

// ---------------------------------------------------------------------------
// Step-6 ordering: airdrop -> publish report -> sweep.
//
// The permanent launch report must be written AFTER every on-chain
// token-setup transaction (pools, locks, transfers, airdrop) and BEFORE the
// sweep — so the Arweave record carries the real airdrop delivery results
// instead of a forever-"pending" section. These pin the orchestration and
// the idempotency that makes re-running it safe.
// ---------------------------------------------------------------------------

test('runTransfer orders airdrop -> publish -> sweep', () => {
  const fnStart = transferSrc.indexOf('async function runTransfer()');
  assert.ok(fnStart >= 0);
  const fn = transferSrc.slice(fnStart, fnStart + 12000);
  const airdropIdx = fn.indexOf("fetch('/api/run-airdrop'");
  const publishIdx = fn.indexOf('await publishLaunchReportToArweave()');
  const sweepIdx = fn.indexOf("fetch('/api/transfer-assets'");
  assert.ok(airdropIdx >= 0, 'step 6a must call /api/run-airdrop');
  assert.ok(publishIdx >= 0, 'step 6b must await the report publish');
  assert.ok(sweepIdx >= 0, 'step 6c must call /api/transfer-assets');
  assert.ok(airdropIdx < publishIdx, 'airdrop must run before the publish');
  assert.ok(publishIdx < sweepIdx, 'publish must run before the sweep');
  // The cached report rebuilds before publishing so the HTML includes the
  // airdrop section.
  const resetIdx = fn.indexOf('_resetCachedReport();');
  assert.ok(resetIdx >= 0 && resetIdx < publishIdx, 'report cache must reset before the publish');
  // The sweep request must NOT carry the airdrop (it already ran in 6a).
  const sweepBody = fn.slice(sweepIdx, fn.indexOf('});', sweepIdx));
  assert.ok(!/airdrop: airdropPayload/.test(sweepBody), 'sweep request must not include the airdrop payload');
});

test('step 5 no longer auto-publishes the report', () => {
  assert.ok(
    !/publishLaunchReportToArweave\(data\);/.test(lpExecSrc),
    'the step-5 publish trigger must be gone — the report publishes in step 6 after the airdrop',
  );
});

test('/api/run-airdrop aliases the idempotent airdrop handler', () => {
  assert.ok(
    /app\.post\('\/api\/run-airdrop', runAirdropHandler\);/.test(serverSrc.replace(/\//g, '\/'))
      || /app\.post\('\/api\/run-airdrop', runAirdropHandler\);/.test(serverSrc),
    'run-airdrop route must exist',
  );
  assert.ok(
    /app\.post\('\/api\/retry-airdrop', runAirdropHandler\);/.test(serverSrc),
    'retry-airdrop must share the same handler',
  );
});

test('publish endpoint is journal-idempotent (one report per mint)', () => {
  assert.ok(
    /reportPublish: raw\.reportPublish && typeof raw\.reportPublish === 'object' \? raw\.reportPublish : null,/.test(journalSrc),
    'normalizeJournal must preserve journal.reportPublish',
  );
  assert.ok(
    /const prior = launchJournal\.activeForWallet\(walletPublicKey\)\?\.reportPublish;/.test(serverSrc),
    'publish endpoint must check the journal before uploading',
  );
  assert.ok(
    /\{ reportPublish: \{ mint, jsonUri: result\.jsonUri/.test(serverSrc),
    'a successful publish must record the URIs in the journal',
  );
  assert.ok(
    /alreadyPublished: true/.test(serverSrc),
    're-requests must return the recorded URIs',
  );
});

test('large airdrop lists warn (no cap)', () => {
  assert.ok(
    /if \(n <= 1000\) return '';/.test(tokenConfigSrc),
    'the size warning must trigger above 1,000 recipients',
  );
  assert.ok(
    !/recipients\.length > \d+[\s\S]{0,120}?(throw|status\(400\))/.test(tokenConfigSrc),
    'there must be no recipient-count cap',
  );
});

test('journal resume restores the publish state', () => {
  assert.ok(
    /journal\.reportPublish && journal\.reportPublish\.jsonUri/.test(journalsSrc),
    'resume must restore _publishedReport from journal.reportPublish',
  );
});

// ---------------------------------------------------------------------------
// Sweep-round regressions: publish size safety, mutex coverage, UI dedupe.
// ---------------------------------------------------------------------------

test('published report HTML stays small (remote logo + capped airdrop tables)', () => {
  const reportSrc = readFileSync(path.join(REPO, 'public', 'modules', 'launch-report.js'), 'utf8');
  // The report cache (preview + publish) prefers the logo's Arweave URI
  // over the base64 data URL, which alone could exceed the ~100KB
  // sponsored-upload cap.
  assert.ok(
    /createdTokenInfo && createdTokenInfo\.imageUri/.test(reportSrc.replace(/\r/g, '')),
    '_getReportHtml must prefer the remote imageUri',
  );
  // Airdrop tables cap their rendered rows.
  assert.ok(
    /MAX_REPORT_AIRDROP_ROWS = 100;/.test(reportSrc),
    'airdrop tables must cap rendered rows',
  );
  assert.ok(
    (reportSrc.match(/slice\(0, MAX_REPORT_AIRDROP_ROWS\)/g) || []).length === 3,
    'all three tables (pending/delivered/failed) must apply the cap',
  );
  // imageUri propagates from token creation.
  const tokenSrc = readFileSync(path.join(REPO, 'tokenService.js'), 'utf8');
  assert.ok(/imageUri: imageUri \|\| null,/.test(tokenSrc), 'createTokenWithMetaplex must return imageUri');
});

test('publish service degrades gracefully on oversized HTML', () => {
  const svcSrc = readFileSync(path.join(REPO, 'launchReportService.js'), 'utf8');
  assert.ok(/HTML_UPLOAD_MAX_BYTES = 95 \* 1024;/.test(svcSrc), 'size guard constant must exist');
  assert.ok(
    /report_html_skipped_oversize/.test(svcSrc),
    'oversized HTML must skip the HTML upload (JSON record still publishes)',
  );
});

test('run-airdrop claims the per-wallet launch-op mutex', () => {
  const handlerStart = serverSrc.indexOf('async function runAirdropHandler(');
  const handler = serverSrc.slice(handlerStart, handlerStart + 9000);
  assert.ok(
    /rejectOrClaimLaunchOp\(res, walletPublicKey, 'run-airdrop'\)/.test(handler),
    'the airdrop must hold the same mutex as create/resume/transfer',
  );
  assert.ok(
    /if \(claimedLaunchOp && walletPublicKey\) \{\r?\n\s*clearLaunchOpInFlight\(walletPublicKey\);/.test(handler),
    'the mutex must release in finally, only when this handler claimed it',
  );
});

test('index.html has no duplicate element ids', () => {
  const html = readFileSync(path.join(REPO, 'public', 'index.html'), 'utf8');
  const ids = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
  const counts = new Map();
  for (const id of ids) counts.set(id, (counts.get(id) || 0) + 1);
  const dupes = [...counts.entries()].filter(([, c]) => c > 1).map(([id]) => id);
  assert.deepEqual(dupes, [], `duplicate ids found: ${dupes.join(', ')} — getElementById silently resolves the first, shadowing the rest`);
});

test('success modal hands the 3D coin back to the preview card on close', () => {
  const fundingSrc = readFileSync(path.join(REPO, 'public', 'modules', 'funding.js'), 'utf8');
  const hideStart = fundingSrc.indexOf('function hideLaunchSuccessModal()');
  assert.ok(hideStart >= 0);
  const hide = fundingSrc.slice(hideStart, hideStart + 2500);
  // The modal borrows the singleton WebGL renderer from the travelling
  // preview card (alive on step 6, behind the modal); destroying it on
  // close without re-rendering the card left the step-6 coin area empty.
  assert.ok(
    /window\.coinRenderer\.destroy\(\);/.test(hide),
    'close must still free the modal coin context',
  );
  assert.ok(
    /renderTokenPreview\(\);/.test(hide),
    'close must re-render the preview card so its coin re-initialises',
  );
  // And the destroy must come BEFORE the hand-back (one context at a time).
  assert.ok(
    hide.indexOf('coinRenderer.destroy()') < hide.indexOf('renderTokenPreview()'),
    'free the modal context before the card re-claims the singleton',
  );
});

test('parked-coin pose is wired end to end', () => {
  const renderer = readFileSync(new URL('../public/coinRenderer.js', import.meta.url), 'utf8');
  // The renderer exposes the switch and holds the documented pose.
  assert.match(renderer, /setParked,/, 'coinRenderer must export setParked');
  assert.match(renderer, /PARKED_YAW = -Math\.PI \/ 6/, 'parked pose is ~30° yaw, logo forward');
  // Render-on-demand: every texture lands in applyFace, which must kick
  // frames or parked mode would never show new faces.
  assert.match(renderer, /function applyFace\(material, content\) \{\n    \/\/ Parked mode renders on demand/,
    'applyFace must kick parked rendering');

  const preview = readFileSync(new URL('../public/modules/coin-preview.js', import.meta.url), 'utf8');
  // Prefs actually consumed (coinPreview was a dead pref before this).
  assert.match(preview, /data\.prefs\.coinPreview !== false/, 'coinPreview pref must be read');
  assert.match(preview, /data\.prefs\.coinPreviewParked === true/, 'coinPreviewParked pref must be read');

  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="coinPreviewToggle"/, 'settings panel must have the show-coin toggle');
  assert.match(html, /id="coinParkedToggle"/, 'settings panel must have the parked-pose toggle');

  const prefs = readFileSync(new URL('../userPrefs.js', import.meta.url), 'utf8');
  assert.match(prefs, /coinPreviewParked: false/, 'userPrefs must default coinPreviewParked off');
});

test('journal resume is gated on resolvability, not the mere presence of incomplete pools', () => {
  // Regression guard. The old gate disabled "Resume launch" for ANY recorded-
  // but-unfinished pool (unsafeCreatedPoolEvents().length === 0), which pre-
  // empted the on-chain reconciliation the server + orchestrator already run for
  // the common mid-flight-death case (recoveringPhase1 adopting landed-but-
  // unrecorded positions). canResume must defer to unsafePoolStateIsUnresolvable,
  // which mirrors the server's UNSAFE_PARTIAL_POOL_STATE conditions, and let
  // resolvable pools through.
  assert.ok(
    journalsSrc.includes('function unsafePoolStateIsUnresolvable(journal)'),
    'journals.js must define unsafePoolStateIsUnresolvable',
  );
  assert.ok(
    journalsSrc.includes('!unsafePoolStateIsUnresolvable(journal)'),
    'canResumeLaunchJournal must gate on resolvability',
  );
  assert.ok(
    !journalsSrc.includes('unsafeCreatedPoolEvents(journal).length === 0'),
    'the old blanket unsafe-pool veto must be gone',
  );
  const fnStart = journalsSrc.indexOf('function unsafePoolStateIsUnresolvable');
  const fnSrc = journalsSrc.slice(fnStart, fnStart + 700);
  assert.ok(
    fnSrc.includes('if (!event.poolId) return true'),
    'must treat a pool_create event with no poolId as unresolvable (nothing to read on-chain)',
  );
  assert.ok(
    fnSrc.includes('.size > 1'),
    'must treat two pools recorded for one allocation as unresolvable (ambiguous)',
  );
});
