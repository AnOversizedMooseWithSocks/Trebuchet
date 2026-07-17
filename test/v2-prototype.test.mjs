import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

import { launchPlanConfigFingerprint as serverLaunchPlanConfigFingerprint } from '../v2LaunchPlan.js';

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

const html = read('public/v2/index.html');
const css = read('public/v2/styles.css');
const js = read('public/v2/app.js');
const apiClientJs = read('public/v2/api-client.js');
const viewportSmokeJs = read('test/v2-viewport-smoke.mjs');
const v2BrowserE2eJs = read('test/e2e/v2-flows.mjs');
const v2ElectronSmokeJs = read('test/e2e/electron-v2-smoke.mjs');
const electronMainJs = read('main.js');
const packageJson = JSON.parse(read('package.json'));

function attrValues(source, attr) {
  return [...source.matchAll(new RegExp(`${attr}="([^"]+)"`, 'g'))].map((match) => match[1]);
}

function concreteDataActions(source) {
  return [...source.matchAll(/data-action=(?:"([^"]+)"|'([^']+)')/g)]
    .map((match) => match[1] || match[2])
    .filter((value) => value && !/[${}`]/.test(value) && !value.includes('escapeHtml'));
}

function handledClickActions(source) {
  const actions = new Set([...source.matchAll(/if \(action === '([^']+)'\)/g)].map((match) => match[1]));
  for (const match of source.matchAll(/if \(action === '([^']+)' \|\| action === '([^']+)'\)/g)) {
    actions.add(match[1]);
    actions.add(match[2]);
  }
  return actions;
}

function loadApiClient(extra = {}) {
  const sandbox = {
    console,
    URL,
    URLSearchParams,
    ArrayBuffer,
    AbortController,
    setTimeout,
    clearTimeout,
    ...extra,
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(apiClientJs, sandbox, { filename: 'public/v2/api-client.js' });
  return sandbox.TrebuchetV2Api;
}

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  };
}

function loadClassicComparisonHarness() {
  const statusSource = js.match(/function classicComparisonStatusFromCounts[\s\S]*?\n}\n/)?.[0];
  const proofCountStart = js.indexOf('function proofPositions');
  const proofCountEnd = js.indexOf('function buildV2ReportAirdropAudit');
  const comparisonStart = js.indexOf('function collectArtifactAddresses');
  const comparisonEnd = js.indexOf('function buildV2ReportParityAudit');
  const finalizeStart = js.indexOf('function proofReportArtifactFinalizesDestination');
  const finalizeEnd = js.indexOf('\nfunction mergeLaunchConfigSnapshot', finalizeStart);
  assert.ok(statusSource, 'classic comparison status helper should be extractable');
  assert.ok(proofCountStart >= 0 && proofCountEnd > proofCountStart, 'proof count helpers should be extractable');
  assert.ok(comparisonStart >= 0 && comparisonEnd > comparisonStart, 'classic comparison helpers should be extractable');
  assert.ok(finalizeStart >= 0 && finalizeEnd > finalizeStart, 'proof artifact finalization helper should be extractable');

  const sandbox = {
    console,
    Date,
    state: {
      lastReportPublish: null,
      lastLocalDossier: null,
      reportPublishing: false,
    },
    currentLaunchProof: () => null,
    currentLaunchConfig: () => sandbox.state.currentConfig || ({ poolTopology: {} }),
    selectedLaunchWalletPublicKey: () => null,
  };
  vm.runInNewContext(
    [
      statusSource,
      js.slice(finalizeStart, finalizeEnd),
      js.slice(proofCountStart, proofCountEnd),
      js.slice(comparisonStart, comparisonEnd),
      'globalThis.compareClassicReportArtifact = compareClassicReportArtifact;',
      'globalThis.classicComparisonProofFingerprint = classicComparisonProofFingerprint;',
      'globalThis.classicComparisonRequiredEvidence = classicComparisonRequiredEvidence;',
      'globalThis.classicComparisonRequiredRows = classicComparisonRequiredRows;',
      'globalThis.proofConfigForFingerprint = proofConfigForFingerprint;',
      'globalThis.launchProofFingerprint = launchProofFingerprint;',
      'globalThis.reportPublishMatchesProof = reportPublishMatchesProof;',
      'globalThis.reportArtifactMatchesTerminalSweep = reportArtifactMatchesTerminalSweep;',
      'globalThis.reportPublishHasPermanentEvidence = reportPublishHasPermanentEvidence;',
      'globalThis.currentReportPublish = currentReportPublish;',
      'globalThis.currentLocalDossier = currentLocalDossier;',
      'globalThis.staleReportPublishForProof = staleReportPublishForProof;',
      'globalThis.transferHasFinalSweepEvidence = transferHasFinalSweepEvidence;',
      'globalThis.transferHasWalletEmptyFinalSweepEvidence = transferHasWalletEmptyFinalSweepEvidence;',
      'globalThis.finalSweepProofState = finalSweepProofState;',
      'globalThis.proofEffectiveDestination = proofEffectiveDestination;',
      'globalThis.comparisonTransferEvidenceHash = comparisonTransferEvidenceHash;',
      'globalThis.comparisonAirdropDeliveryEvidenceState = comparisonAirdropDeliveryEvidenceState;',
      'globalThis.comparisonLiquidityEvidenceState = comparisonLiquidityEvidenceState;',
    ].join('\n'),
    sandbox,
    { filename: 'public/v2/app.js classic comparison harness' },
  );
  return sandbox;
}

function loadProofMergeHarness() {
  const mergeStart = js.indexOf('function proofTokenMint');
  const mergeEnd = js.indexOf('\nfunction proofPositions', mergeStart);
  assert.ok(mergeStart >= 0 && mergeEnd > mergeStart, 'proof merge helpers should be extractable');

  const sandbox = {
    reportPublishHasPermanentEvidence: (report = null) => Boolean(report?.htmlUri || report?.jsonUri),
    localDossierHasEvidence: (dossier = null) => Boolean(
      dossier
      && dossier.status === 'downloaded'
      && dossier.kind === 'local-dossier-html'
      && dossier.filename
      && dossier.downloadedAt
      && dossier.dataVersion
    ),
    transferHasFinalSweepEvidence: (transfer = null) => Boolean(
      transfer
      && transfer.destinationWallet
      && transfer.status !== 'planned-before-sweep'
      && transfer.walletEmpty === true
    ),
    reportPublishMatchesProof: (report = null, proof = {}) => Boolean(
      report?.proofFingerprint
      && report.proofFingerprint === proof.expectedFingerprint
    ),
    reportArtifactMatchesTerminalSweep: (report = null, proof = {}) => {
      if (!proof?.terminalSweepHash) return true;
      return report?.sweepEvidenceHash === proof.terminalSweepHash;
    },
    currentLaunchConfig: () => ({ poolTopology: {} }),
    reportPublishIsProofCurrent: (report = null, proof = {}) => Boolean(
      report
      && (report.htmlUri || report.jsonUri)
      && report.proofFingerprint === proof.expectedFingerprint
      && (!proof?.token?.mint || report.mint === proof.token.mint)
      && (!proof?.terminalSweepHash || report.sweepEvidenceHash === proof.terminalSweepHash)
    ),
    localDossierIsProofCurrent: (dossier = null, proof = {}) => Boolean(
      dossier
      && dossier.status === 'downloaded'
      && dossier.kind === 'local-dossier-html'
      && dossier.filename
      && dossier.downloadedAt
      && dossier.dataVersion
      && dossier.proofFingerprint === proof.expectedFingerprint
      && (!proof?.token?.mint || dossier.mint === proof.token.mint)
      && (!proof?.terminalSweepHash || dossier.sweepEvidenceHash === proof.terminalSweepHash)
    ),
    reportPublishFinalizationIssue: (report = null, proof = {}) => (
      report
      && (report.htmlUri || report.jsonUri)
      && report.proofFingerprint === proof.expectedFingerprint
      && (!proof?.token?.mint || report.mint === proof.token.mint)
      && (!proof?.terminalSweepHash || report.sweepEvidenceHash === proof.terminalSweepHash)
        ? null
        : 'report publish evidence mismatch'
    ),
    localDossierFinalizationIssue: (dossier = null, proof = {}) => (
      dossier
      && dossier.status === 'downloaded'
      && ['local-dossier-html', 'local-proof-json'].includes(String(dossier.kind || '').trim())
      && dossier.filename
      && dossier.downloadedAt
      && dossier.dataVersion
      && dossier.proofFingerprint === proof.expectedFingerprint
      && (!proof?.token?.mint || dossier.mint === proof.token.mint)
      && (!proof?.terminalSweepHash || dossier.sweepEvidenceHash === proof.terminalSweepHash)
        ? null
        : 'local dossier evidence mismatch'
    ),
    comparisonConfigCalls: [],
    classicComparisonMatchesProof: (comparison = null, proof = {}, config = null) => {
      sandbox.comparisonConfigCalls.push({ comparison, proof, config });
      return Boolean(
        (!comparison?.proofFingerprint || comparison.proofFingerprint === proof.expectedFingerprint)
        && (!proof?.launchConfig || config === proof.launchConfig)
      );
    },
  };
  vm.runInNewContext(
    [
      js.slice(mergeStart, mergeEnd),
      'globalThis.mergeLaunchProofEvidence = mergeLaunchProofEvidence;',
      'globalThis.mergeLaunchConfigSnapshot = mergeLaunchConfigSnapshot;',
    ].join('\n'),
    sandbox,
    { filename: 'public/v2/app.js proof merge harness' },
  );
  return sandbox;
}

function loadClassicComparisonPersistenceHarness() {
  const normalizeStart = js.indexOf('function normalizeClassicComparisonRow');
  const normalizeEnd = js.indexOf('\nfunction persistClassicReportComparison', normalizeStart);
  assert.ok(normalizeStart >= 0 && normalizeEnd > normalizeStart, 'classic comparison persistence helpers should be extractable');
  const sandbox = {
    Date,
    CLASSIC_REPORT_COMPARISON_INPUT_LIMIT: 1_000_000,
    CLASSIC_REPORT_COMPARISON_MAX_AGE_MS: 7 * 24 * 60 * 60 * 1000,
    CLASSIC_REPORT_COMPARISON_ROW_LIMIT: 80,
    compactLedgerText: (value, limit = 120) => String(value || '').slice(0, limit),
  };
  vm.runInNewContext(
    [
      js.slice(normalizeStart, normalizeEnd),
      'globalThis.normalizeClassicReportComparison = normalizeClassicReportComparison;',
      'globalThis.classicComparisonStatusFromCounts = classicComparisonStatusFromCounts;',
    ].join('\n'),
    sandbox,
    { filename: 'public/v2/app.js classic comparison persistence harness' },
  );
  return sandbox;
}

function loadStoredProofHarness() {
  const proofStorageStart = js.indexOf('function storedLaunchProofConfig');
  const proofStorageEnd = js.indexOf('\nfunction normalizeClassicComparisonRow', proofStorageStart);
  const comparisonShapeStart = js.indexOf('function classicComparisonResultObject');
  const comparisonShapeEnd = js.indexOf('\nfunction reportParityClassicComparison', comparisonShapeStart);
  const proofPruneStart = js.indexOf('function pruneLaunchProofReportParity');
  const proofPruneEnd = js.indexOf('\nfunction mergeLaunchProofEvidence', proofPruneStart);
  assert.ok(proofStorageStart >= 0 && proofStorageEnd > proofStorageStart, 'stored proof helpers should be extractable');
  assert.ok(comparisonShapeStart >= 0 && comparisonShapeEnd > comparisonShapeStart, 'classic comparison shape helper should be extractable');
  assert.ok(proofPruneStart >= 0 && proofPruneEnd > proofPruneStart, 'proof prune helpers should be extractable');

  const storage = new Map();
  const storageApi = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  };
  const fingerprintMatches = (record = null, proof = {}) => Boolean(
    record
    && typeof record === 'object'
    && record.proofFingerprint
    && record.proofFingerprint === (proof.expectedFingerprint || 'proof-bound')
  );
  const terminalSweepMatches = (record = null, proof = {}) => {
    const sweepHash = proof?.terminalSweepHash || proof?.transfer?.terminalSweepHash || null;
    if (!sweepHash) return true;
    return record?.sweepEvidenceHash === sweepHash;
  };
  const sandbox = {
    Date,
    JSON,
    LAUNCH_PROOF_MAX_AGE_MS: 7 * 24 * 60 * 60 * 1000,
    LAUNCH_PROOF_STORAGE_LIMIT: 250_000,
    LAUNCH_PROOF_STORAGE_KEY: 'trebuchet-v2-proof',
    state: {
      launchProof: null,
      currentConfig: { token: { symbol: 'FORM' }, poolTopology: { sweepDestination: 'FormDest11111111111111111111111111111111' } },
      lastReportPublish: { htmlUri: 'ar://previous-report', proofFingerprint: 'old-proof' },
      lastLocalDossier: { status: 'downloaded', kind: 'local-dossier-html', filename: 'old.html', downloadedAt: '2026-06-30T00:00:00.000Z', dataVersion: 1, proofFingerprint: 'old-proof' },
    },
    currentLaunchConfig: () => sandbox.state.currentConfig || ({ poolTopology: {} }),
    v2LocalStorage: () => storageApi,
    proofConfigForFingerprint: (proof = null, config = {}) => (
      proof?.launchConfig && typeof proof.launchConfig === 'object'
        ? { ...proof.launchConfig, proofBoundConfig: true }
        : config
    ),
    reportPublishIsProofCurrent: (report = null, proof = {}, config = {}) => Boolean(
      report
      && typeof report === 'object'
      && String(report.htmlUri || report.jsonUri || '').trim()
      && (report.requiresProofBoundConfig !== true || config?.proofBoundConfig === true)
      && fingerprintMatches(report, proof)
      && (!proof?.token?.mint || String(report.mint || '').trim() === proof.token.mint)
      && terminalSweepMatches(report, proof)
    ),
    localDossierIsProofCurrent: (dossier = null, proof = {}, config = {}) => Boolean(
      dossier
      && typeof dossier === 'object'
      && dossier.status === 'downloaded'
      && ['local-dossier-html', 'local-proof-json'].includes(String(dossier.kind || '').trim())
      && String(dossier.filename || '').trim()
      && String(dossier.downloadedAt || '').trim()
      && Number(dossier.dataVersion) > 0
      && (dossier.requiresProofBoundConfig !== true || config?.proofBoundConfig === true)
      && fingerprintMatches(dossier, proof)
      && (!proof?.token?.mint || String(dossier.mint || '').trim() === proof.token.mint)
      && terminalSweepMatches(dossier, proof)
    ),
    classicComparisonMatchesProof: (comparison = null, proof = {}) => Boolean(
      !comparison?.proofFingerprint || comparison.proofFingerprint === (proof.expectedFingerprint || 'proof-bound')
    ),
  };
  vm.runInNewContext(
    [
      js.slice(comparisonShapeStart, comparisonShapeEnd),
      js.slice(proofPruneStart, proofPruneEnd),
      js.slice(proofStorageStart, proofStorageEnd),
      'globalThis.storedLaunchProofConfig = storedLaunchProofConfig;',
      'globalThis.pruneLaunchProofReportParity = pruneLaunchProofReportParity;',
      'globalThis.pruneLaunchProofEvidenceArtifacts = pruneLaunchProofEvidenceArtifacts;',
      'globalThis.storedLaunchProofHasSignal = storedLaunchProofHasSignal;',
      'globalThis.pruneStoredLaunchProofArtifacts = pruneStoredLaunchProofArtifacts;',
      'globalThis.normalizeStoredLaunchProof = normalizeStoredLaunchProof;',
      'globalThis.persistLaunchProof = persistLaunchProof;',
      'globalThis.restoreLaunchProof = restoreLaunchProof;',
      'globalThis.clearStoredLaunchProof = clearStoredLaunchProof;',
    ].join('\n'),
    sandbox,
    { filename: 'public/v2/app.js stored proof harness' },
  );
  sandbox.storage = storage;
  return sandbox;
}

function loadClassicRetirementGateHarness() {
  const gateStart = js.indexOf('function demoRunHasCompletedReadiness');
  const gateEnd = js.indexOf('\nfunction replacementCriteriaById', gateStart);
  const demoConfigStart = js.indexOf('function demoRunLaunchConfig');
  const demoConfigEnd = js.indexOf('\nfunction proofFromDemoRun', demoConfigStart);
  const txEvidenceStart = js.indexOf('function v2LiquidityTransactionEvidenceCounts');
  const txEvidenceEnd = js.indexOf('\nfunction proofHasReportPublishEvidence', txEvidenceStart);
  const reportStart = js.indexOf('function reportNumber');
  const reportEnd = js.indexOf('\nfunction renderV2ReportAddressRow', reportStart);
  const heldAuditStart = js.indexOf('function buildV2ReportHeldReserveAudit');
  const heldAuditEnd = js.indexOf('\nfunction buildV2LaunchReportData', heldAuditStart);
  const comparisonSelectorStart = js.indexOf('function currentClassicComparisonForProof');
  const comparisonSelectorEnd = js.indexOf('\nfunction pruneLaunchProofReportParity', comparisonSelectorStart);
  assert.ok(gateStart >= 0 && gateEnd > gateStart, 'classic retirement gate helpers should be extractable');
  assert.ok(demoConfigStart >= 0 && demoConfigEnd > demoConfigStart, 'demo run config helper should be extractable');
  assert.ok(txEvidenceStart >= 0 && txEvidenceEnd > txEvidenceStart, 'liquidity tx evidence helper should be extractable');
  assert.ok(reportStart >= 0 && reportEnd > reportStart, 'report helper should be extractable');
  assert.ok(heldAuditStart >= 0 && heldAuditEnd > heldAuditStart, 'held reserve audit helper should be extractable');
  assert.ok(comparisonSelectorStart >= 0 && comparisonSelectorEnd > comparisonSelectorStart, 'comparison selector helper should be extractable');

  const harnessState = {
    classicReportComparison: {},
    lastDemoLaunchRun: null,
    managedWallets: [],
    selectedVanityPublicKey: '',
    vanityCandidates: [],
    vanityAvailable: true,
    selectedWalletPublicKey: '',
    secretPin: { locked: false },
    demoActive: false,
    viewportSmoke: null,
    apiStatus: 'connected',
    classicFundingEstimate: null,
    quoteAcquire: { job: null },
    quoteAcquireStale: false,
    fundingSnapshot: { missingSol: 0, hasWalletBalance: false, walletBalanceFresh: false },
    quoteRoutes: [],
    quoteProgress: { total: 0, completed: 0, failed: 0 },
    manualItems: [],
    manualSummary: { className: '', label: 'None' },
    launchPlan: null,
    recovery: { journalCount: 0 },
    currentConfig: null,
  };
  const harnessProofFingerprint = (proof = {}) => (
    proof?.token?.metadataImmutable === false ? 'proof-missing-authority' : 'proof-bound'
  );
  const harnessAudit = (proof = {}) => {
    const warning = proof?.token?.metadataImmutable === false;
    const items = Array.from({ length: 12 }, (_, index) => ({
      id: `audit-${index + 1}`,
      label: `Audit ${index + 1}`,
      state: warning && index === 0 ? 'warn' : 'pass',
      detail: warning && index === 0 ? 'Authority proof warning.' : 'Proof row attached.',
    }));
    return {
      version: 1,
      source: 'trebuchet-v2-report-parity-audit',
      status: warning ? 'warn' : 'pass',
      passCount: warning ? 11 : 12,
      warnCount: warning ? 1 : 0,
      missingCount: 0,
      itemCount: 12,
      proofFingerprint: harnessProofFingerprint(proof),
      items,
    };
  };
  const sandbox = {
    console,
    state: harnessState,
    V2_VIEWPORT_SMOKE_REQUIRED_ASSETS: ['index.html', 'styles.css', 'api-client.js', 'app.js'],
    V2_VIEWPORT_SMOKE_REQUIRED_CHECKS: [
      'launchVisible',
      'horizontalOverflow',
      'tokenomicsChart',
      'liquidityChart',
      'fundingMeter',
      'parityPanel',
      'firstViewportFit',
    ],
    CLASSIC_TOKEN_NAME_MAX_BYTES: 32,
    CLASSIC_TOKEN_SYMBOL_MAX_BYTES: 10,
    CLASSIC_TOKEN_DESCRIPTION_MAX_BYTES: 1000,
    CLASSIC_MAX_WHOLE_TOKEN_SUPPLY: 10_000_000_000n,
    CLASSIC_LOGO_MAX_BYTES: 100 * 1024,
    CLASSIC_LOGO_MAX_DIMENSION: 1024,
    CLASSIC_LOGO_MIN_DIMENSION: 64,
    V2_REQUIRED_LAUNCH_PLAN_OPERATION_IDS: [
      'v2-wallet-and-ca',
      'v2-funding-check',
      'v2-mint-metadata',
      'v2-revoke-authorities',
      'v2-create-liquidity-pools',
      'v2-lock-liquidity',
      'v2-report-sweep',
    ],
    currentLaunchProof: () => null,
    currentLaunchConfig: () => harnessState.currentConfig || ({ poolTopology: {} }),
    normalizeClassicReportComparison: (record = {}) => record?.result
      ? record
      : { result: record?.status ? record : null },
    reportParityClassicComparison: (reportParity = null) => (
      reportParity?.comparison || reportParity?.classicComparison || null
    ),
    launchProofFingerprint: harnessProofFingerprint,
    reportParityAuditMatchesProof: (audit = null, proof = {}) => {
      if (!audit || typeof audit !== 'object') return false;
      const expected = harnessAudit(proof);
      const expectedItems = Array.isArray(expected.items) ? expected.items : [];
      const items = Array.isArray(audit.items) ? audit.items : [];
      const itemCount = Number(audit.itemCount);
      const passCount = Number(audit.passCount || 0);
      const warnCount = Number(audit.warnCount || 0);
      const missingCount = Number(audit.missingCount || 0);
      return Boolean(
        audit.source === 'trebuchet-v2-report-parity-audit'
        && audit.proofFingerprint === harnessProofFingerprint(proof)
        && Number(audit.version) >= 1
        && items.length > 0
        && Number.isInteger(itemCount)
        && itemCount === items.length
        && itemCount === expectedItems.length
        && passCount === Number(expected.passCount || 0)
        && warnCount === Number(expected.warnCount || 0)
        && missingCount === Number(expected.missingCount || 0)
        && passCount + warnCount + missingCount === itemCount
        && audit.status === expected.status
        && items.every((item, index) => item?.id === expectedItems[index]?.id && item?.state === expectedItems[index]?.state)
      );
    },
    buildV2ReportParityAudit: harnessAudit,
    proofPositions: (results = []) => results
      .reduce((sum, pool) => sum + Number(pool?.positionCount || 0), 0),
    v2ReportPositionList: (pool = {}) => [
      ...(Array.isArray(pool.mainPositions) ? pool.mainPositions : []),
      ...(Array.isArray(pool.ladderPositions) ? pool.ladderPositions : []),
      ...(Array.isArray(pool.supportPositions) ? pool.supportPositions : []),
      ...(pool.bootstrap ? [pool.bootstrap] : []),
    ],
    comparisonLiquidityEvidenceState: (proof = {}, { plannedPoolCount = null, plannedPositionCount = null } = {}) => {
      const results = Array.isArray(proof?.liquidity?.results) ? proof.liquidity.results : [];
      const liquidity = proof?.liquidity || {};
      const poolIds = [
        ...(Array.isArray(liquidity.poolIds) ? liquidity.poolIds : []),
        ...results.map((pool) => pool?.poolId || pool?.id).filter(Boolean),
      ].filter((value, index, list) => value && list.indexOf(value) === index);
      const positionRows = results.reduce((sum, pool) => (
        sum
        + (Array.isArray(pool?.mainPositions) ? pool.mainPositions.length : 0)
        + (Array.isArray(pool?.ladderPositions) ? pool.ladderPositions.length : 0)
        + (Array.isArray(pool?.supportPositions) ? pool.supportPositions.length : 0)
        + (pool?.bootstrap ? 1 : 0)
      ), 0);
      const lockedRows = results.reduce((sum, pool) => {
        const positions = [
          ...(Array.isArray(pool?.mainPositions) ? pool.mainPositions : []),
          ...(Array.isArray(pool?.ladderPositions) ? pool.ladderPositions : []),
          ...(Array.isArray(pool?.supportPositions) ? pool.supportPositions : []),
          ...(pool?.bootstrap ? [pool.bootstrap] : []),
        ];
        return sum + positions.filter((position) => position?.locked === true).length;
      }, 0);
      const feeKeyRows = results.reduce((sum, pool) => {
        const positions = [
          ...(Array.isArray(pool?.mainPositions) ? pool.mainPositions : []),
          ...(Array.isArray(pool?.ladderPositions) ? pool.ladderPositions : []),
          ...(Array.isArray(pool?.supportPositions) ? pool.supportPositions : []),
          ...(pool?.bootstrap ? [pool.bootstrap] : []),
        ];
        return sum + positions.filter((position) => position?.feeKeyNftMint || position?.feeKeyMint).length;
      }, 0);
      const poolCount = Number.isFinite(Number(liquidity.poolCount)) ? Math.floor(Number(liquidity.poolCount)) : poolIds.length;
      const positionCount = Number.isFinite(Number(liquidity.positionCount)) ? Math.floor(Number(liquidity.positionCount)) : positionRows;
      const lockedPositionCount = Number.isFinite(Number(liquidity.lockedPositionCount)) ? Math.floor(Number(liquidity.lockedPositionCount)) : lockedRows;
      const feeKeyCount = Number.isFinite(Number(liquidity.feeKeyCount)) ? Math.floor(Number(liquidity.feeKeyCount)) : feeKeyRows;
      const missing = [];
      if (Number(plannedPoolCount || 0) > 0 && poolCount < Number(plannedPoolCount)) missing.push('pool count');
      if (Number(plannedPositionCount || 0) > 0 && positionCount < Number(plannedPositionCount)) missing.push('position count');
      if (positionRows < positionCount) missing.push('position records');
      if (positionCount > 0 && lockedPositionCount < positionCount) missing.push('lock count');
      if (lockedPositionCount > 0 && feeKeyCount < lockedPositionCount) missing.push('fee key count');
      return {
        poolCount,
        positionCount,
        lockedPositionCount,
        feeKeyCount,
        missing,
      };
    },
    reportPublishMatchesProof: (report = null) => Boolean(
      report
      && typeof report === 'object'
      && report.proofFingerprint === 'proof-bound'
    ),
    localDossierHasEvidence: (dossier = null) => Boolean(
      dossier
      && typeof dossier === 'object'
      && dossier.status === 'downloaded'
      && ['local-dossier-html', 'local-proof-json'].includes(String(dossier.kind || '').trim())
      && String(dossier.filename || '').trim()
      && String(dossier.downloadedAt || '').trim()
      && Number(dossier.dataVersion) > 0
    ),
    currentReportPublish: (proof = {}, _config = {}, options = {}) => {
      const report = proof.reportPublish || null;
      if (!report || typeof report !== 'object') return null;
      if (!String(report.htmlUri || report.jsonUri || '').trim()) return null;
      if (report.transientOnly === true && options?.allowTransient !== true) return null;
      return report.proofFingerprint === 'proof-bound' && sandbox.reportArtifactMatchesTerminalSweep(report, proof) ? report : null;
    },
    currentLocalDossier: (proof = {}) => {
      const dossier = proof.localDossier || null;
      if (!dossier || typeof dossier !== 'object') return null;
      const validKind = ['local-dossier-html', 'local-proof-json'].includes(String(dossier.kind || '').trim());
      if (dossier.status !== 'downloaded' || !validKind || !String(dossier.filename || '').trim()) return null;
      return dossier.proofFingerprint === 'proof-bound' && sandbox.reportArtifactMatchesTerminalSweep(dossier, proof) ? dossier : null;
    },
    staleReportPublishForProof: (proof = {}) => {
      proof = proof || {};
      if (proof.staleReport) return proof.staleReport;
      const report = proof.reportPublish || proof.localDossier || null;
      if (!report || typeof report !== 'object') return null;
      const hasReportUri = String(report.htmlUri || report.jsonUri || '').trim();
      const hasDossier = report.status === 'downloaded' && String(report.filename || '').trim();
      return (hasReportUri || hasDossier) && report.proofFingerprint && (
        report.proofFingerprint !== 'proof-bound' || !sandbox.reportArtifactMatchesTerminalSweep(report, proof)
      )
        ? report
        : null;
    },
    shortAddress: (value) => String(value || '').slice(0, 8),
    selectedLaunchWalletPublicKey: () => harnessState.selectedWalletPublicKey || harnessState.managedWallets[0]?.publicKey || null,
    selectedManagedWallet: () => {
      const publicKey = harnessState.selectedWalletPublicKey || harnessState.managedWallets[0]?.publicKey || null;
      return harnessState.managedWallets.find((wallet) => wallet.publicKey === publicKey) || null;
    },
    classicComparisonMatchesProof: (comparison = {}) => (
      comparison?.matchesProof !== false
      && comparison?.proofFingerprint === 'proof-bound'
    ),
    classicComparisonRequiredEvidence: (comparison = {}) => {
      const requiredRows = comparison?.requiredRows || [
        'mint',
        'launch-wallet',
        'pools',
        'authority-posture',
        'positionCount',
        'lockedPositionCount',
        'feeKeyCount',
        'destination',
      ];
      const rows = Array.isArray(comparison?.rows) ? comparison.rows : [];
      const missing = requiredRows.filter((id) => !rows.some((row) => row.id === id && row.state === 'pass'));
      const passCount = Number(comparison?.passCount || 0);
      const fieldCount = Number(comparison?.fieldCount || 0);
      const structuredEvidence = comparison?.structuredEvidence === true;
      return {
        pass: Boolean(comparison && structuredEvidence && missing.length === 0 && passCount >= requiredRows.length && fieldCount >= requiredRows.length),
        structuredEvidence,
        detail: !structuredEvidence
          ? 'Classic comparison is missing structured Classic report evidence; load a Classic JSON export or HTML dossier, not loose text.'
          : missing.length
          ? `Classic comparison is missing required passing rows: ${missing.join(', ')}.`
          : `${requiredRows.length}/${requiredRows.length} required Classic evidence rows are passing.`,
        missingRows: missing.map((id) => ({ id, label: id })),
      };
    },
    transferSweepErrorCount: (transfer = {}) => {
      const tokenErrors = Array.isArray(transfer?.tokenTransferErrors)
        ? transfer.tokenTransferErrors
        : Array.isArray(transfer?.tokenSweep?.errors) ? transfer.tokenSweep.errors : [];
      const nftErrors = Array.isArray(transfer?.nftTransferErrors)
        ? transfer.nftTransferErrors
        : Array.isArray(transfer?.nftSweep?.errors) ? transfer.nftSweep.errors : [];
      return tokenErrors.length + nftErrors.length + (transfer?.solSweepError ? 1 : 0);
    },
    transferSweptAssetCount: (transfer = {}) => {
      const tokenRows = Array.isArray(transfer?.tokenSweep?.transferred) ? transfer.tokenSweep.transferred.length : 0;
      const nftRows = Array.isArray(transfer?.nftSweep?.transferred) ? transfer.nftSweep.transferred.length : 0;
      const tokens = Number(transfer?.tokensTransferred || 0);
      const nfts = Number(transfer?.nftsTransferred || 0);
      const sol = Number(transfer?.solTransferred || 0);
      return (Number.isFinite(tokens) ? tokens : 0)
        + (Number.isFinite(nfts) ? nfts : 0)
        + tokenRows
        + nftRows
        + (Number.isFinite(sol) && sol > 0 ? 1 : 0);
    },
    transferHasFinalSweepEvidence: (transfer = null) => {
      if (!transfer || typeof transfer !== 'object') return false;
      if (!String(transfer.destinationWallet || '').trim()) return false;
      if (transfer.status === 'planned-before-sweep') return false;
      if (transfer.walletEmpty === true) return sandbox.transferSweepErrorCount(transfer) === 0;
      if (transfer.walletEmpty === false) return false;
      if (sandbox.transferSweepErrorCount(transfer) > 0) return false;
      return sandbox.transferSweptAssetCount(transfer) > 0;
    },
    transferHasWalletEmptyFinalSweepEvidence: (transfer = null) => Boolean(
      transfer
      && typeof transfer === 'object'
      && String(transfer.destinationWallet || '').trim()
      && transfer.status !== 'planned-before-sweep'
      && transfer.walletEmpty === true
      && sandbox.transferSweepErrorCount(transfer) === 0
    ),
    journalTransferHasTerminalSweepEvidence: (transfer = {}) => Boolean(
      sandbox.transferHasWalletEmptyFinalSweepEvidence(transfer)
    ),
    comparisonTransferEvidenceHash: (transfer = {}) => {
      if (!transfer || typeof transfer !== 'object' || Object.keys(transfer).length === 0) return null;
      const rows = [];
      const solAmount = transfer?.solSweep?.solTransferred ?? transfer?.solTransferred ?? null;
      const solTx = transfer?.solSweep?.txId || transfer?.solTxId || transfer?.txId || transfer?.signature || null;
      if (solAmount != null || solTx || transfer?.solSweepError) {
        rows.push({
          type: 'sol',
          asset: 'SOL',
          amount: solAmount == null ? null : Number(solAmount),
          txId: solTx,
          status: transfer?.solSweepError || null,
          error: Boolean(transfer?.solSweepError),
        });
      }
      (Array.isArray(transfer?.tokenSweep?.transferred) ? transfer.tokenSweep.transferred : []).forEach((row) => rows.push({
        type: 'token',
        asset: row.mint || row.tokenMint || null,
        amount: row.amount == null ? null : String(row.amount),
        decimals: row.decimals == null ? null : Number(row.decimals),
        txId: row.txId || row.signature || null,
        status: 'transferred',
        error: false,
      }));
      (Array.isArray(transfer?.nftSweep?.transferred) ? transfer.nftSweep.transferred : []).forEach((row) => rows.push({
        type: 'nft',
        asset: row.mint || row.nftMint || null,
        amount: '1',
        programName: row.programName || null,
        txId: row.txId || row.signature || null,
        status: 'transferred',
        error: false,
      }));
      rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      return JSON.stringify({
        destinationWallet: transfer.destinationWallet || null,
        status: transfer.status || null,
        walletEmpty: transfer.walletEmpty === true ? true : transfer.walletEmpty === false ? false : null,
        rows,
      });
    },
    reportArtifactMatchesTerminalSweep: (report = {}, proof = {}) => {
      if (!report || typeof report !== 'object') return false;
      const sweepHash = sandbox.transferHasWalletEmptyFinalSweepEvidence(proof?.transfer)
        ? sandbox.comparisonTransferEvidenceHash(proof.transfer)
        : null;
      if (!sweepHash) return true;
      return String(
        report.sweepEvidenceHash
        || report.transferEvidenceHash
        || report.finalSweep?.transferEvidenceHash
        || '',
      ).trim() === sweepHash;
    },
    proofTokenJournalEvidenceState: (proof = {}, journal = {}) => {
      const fields = [
        ['mintAuthorityRenounced', 'mint authority'],
        ['freezeAuthorityDisabled', 'freeze authority'],
        ['metadataUpdateAuthorityRevoked', 'metadata update authority'],
        ['metadataImmutable', 'metadata immutability'],
      ];
      const missing = [];
      const mismatches = [];
      const proofToken = proof?.token || {};
      const journalToken = journal?.token || {};
      fields.forEach(([field, label]) => {
        if (proofToken?.[field] !== true) return;
        if (!journalToken || typeof journalToken !== 'object' || typeof journalToken[field] !== 'boolean') {
          missing.push(`journal token authority ${label}`);
          return;
        }
        if (journalToken[field] !== true) mismatches.push(`token authority ${label}`);
      });
      return { missing, mismatches };
    },
    proofLiquidityJournalEvidenceState: (proof = {}, journal = {}) => {
      const results = (proof?.liquidity?.results && Array.isArray(proof.liquidity.results)) ? proof.liquidity.results : [];
      const journalResults = Array.isArray(journal?.lp?.results) && journal.lp.results.length
        ? journal.lp.results
        : (Array.isArray(journal?.lp?.partialResults) ? journal.lp.partialResults : []);
      const poolFingerprint = (items = []) => (Array.isArray(items) ? items : []).map((pool) => JSON.stringify({
        poolId: pool?.poolId || pool?.id || null,
        quoteMint: pool?.quoteMint || pool?.quoteAddress || null,
        supplyPercent: pool?.supplyPercent == null ? null : Number(pool.supplyPercent),
        tickSpacing: pool?.tickSpacing == null ? null : Number(pool.tickSpacing),
        initialPrice: pool?.initialPrice == null ? null : String(pool.initialPrice),
        launchedSide: pool?.launchedSide || null,
        createPoolTx: pool?.createPoolTx || pool?.txIds?.createPool || null,
      })).sort();
      const positions = (items = []) => (Array.isArray(items) ? items : []).flatMap((pool) => {
        const poolId = pool?.poolId || pool?.id || null;
        return [
          ...(Array.isArray(pool?.mainPositions) ? pool.mainPositions.map((position) => ({ ...position, type: 'main', poolId })) : []),
          ...(Array.isArray(pool?.ladderPositions) ? pool.ladderPositions.map((position) => ({ ...position, type: 'ladder', poolId })) : []),
          ...(Array.isArray(pool?.supportPositions) ? pool.supportPositions.map((position) => ({ ...position, type: 'support', poolId })) : []),
          ...(pool?.bootstrap ? [{ ...pool.bootstrap, type: 'bootstrap', poolId }] : []),
        ];
      });
      const positionCount = (items = [], fallback = 0) => Math.max(
        positions(items).length,
        (Array.isArray(items) ? items : []).reduce((sum, pool) => sum + Number(pool?.positionCount || pool?.totalPositions || 0), 0),
        Number(fallback || 0),
      );
      const fingerprint = (items = []) => positions(items).map((position) => JSON.stringify({
        poolId: position.poolId || null,
        type: position.type || null,
        sliceIndex: position.sliceIndex ?? null,
        bandIndex: position.bandIndex ?? null,
        supportIndex: position.supportIndex ?? null,
        positionNftMint: position.positionNftMint || position.nftMint || null,
        feeKeyNftMint: position.feeKeyNftMint || position.feeKeyMint || null,
        locked: position.locked === true,
        recipient: position.recipient || null,
        transferredTo: position.transferredTo || null,
        openTx: position.openTx || position.txIds?.open || null,
        lockTx: position.lockTx || position.txIds?.lock || null,
        transferTx: position.transferTx || position.txIds?.transfer || null,
      })).sort();
      const summary = (items = []) => {
        const rows = positions(items);
        const totalRecipient = rows.filter((position) => position.recipient).length;
        const transferred = rows.filter((position) => position.transferredTo || position.txIds?.transfer || position.transferTx).length;
        return {
          locked: rows.filter((position) => position.locked === true).length,
          feeKeys: rows.filter((position) => position.feeKeyNftMint || position.feeKeyMint).length,
          totalRecipient,
          transferred,
        };
      };
      const missing = [];
      const mismatches = [];
      const proofPoolRows = poolFingerprint(results);
      const journalPoolRows = poolFingerprint(journalResults);
      if (proofPoolRows.length && !journalPoolRows.length) missing.push('journal pool records');
      else if (proofPoolRows.length && journalPoolRows.length && (proofPoolRows.length !== journalPoolRows.length || proofPoolRows.some((row, index) => row !== journalPoolRows[index]))) {
        mismatches.push('pool records');
      }
      const proofPositionCount = positionCount(results, proof?.liquidity?.positionCount);
      const journalPositionCount = positionCount(journalResults);
      if (proofPositionCount > 0) {
        if (journalPositionCount <= 0) missing.push('journal positions');
        else if (journalPositionCount !== proofPositionCount) mismatches.push('position count');
      }
      const proofFingerprint = fingerprint(results);
      const journalFingerprint = fingerprint(journalResults);
      if (proofFingerprint.length && !journalFingerprint.length) missing.push('journal position records');
      else if (proofFingerprint.length && journalFingerprint.length && (proofFingerprint.length !== journalFingerprint.length || proofFingerprint.some((row, index) => row !== journalFingerprint[index]))) {
        mismatches.push('position records');
      }
      const proofSummary = summary(results);
      const journalSummary = summary(journalResults);
      if (proofSummary.locked > 0) {
        if (journalSummary.locked <= 0) missing.push('journal lock proof');
        else if (journalSummary.locked !== proofSummary.locked) mismatches.push('lock count');
      }
      if (proofSummary.feeKeys > 0) {
        if (journalSummary.feeKeys <= 0) missing.push('journal Fee Key proof');
        else if (journalSummary.feeKeys !== proofSummary.feeKeys) mismatches.push('Fee Key count');
      }
      if (proofSummary.totalRecipient > 0) {
        if (journalSummary.totalRecipient <= 0) missing.push('journal Fee Key recipients');
        else if (journalSummary.totalRecipient !== proofSummary.totalRecipient) mismatches.push('Fee Key recipient count');
        if (proofSummary.transferred > 0) {
          if (journalSummary.transferred <= 0) missing.push('journal Fee Key transfers');
          else if (journalSummary.transferred !== proofSummary.transferred) mismatches.push('Fee Key transfer count');
        }
      }
      return { missing, mismatches };
    },
    proofAirdropJournalEvidenceState: (proof = {}, journal = {}) => {
      const rows = (airdrop = {}, key = 'transferred') => (Array.isArray(airdrop?.[key]) ? airdrop[key] : []);
      const count = (airdrop = {}, key = 'deliveredCount', fallbackRows = []) => {
        const value = Number(airdrop?.[key]);
        return Number.isFinite(value) ? Math.max(0, value) : fallbackRows.length;
      };
      const set = (items = []) => [...new Set(items.filter(Boolean).map(String))].sort();
      const wallets = (items = []) => set(items.map((row) => row?.wallet || row?.recipient || row?.address));
      const txs = (items = []) => set(items.map((row) => row?.txId || row?.signature || row?.tx));
      const proofAirdrop = proof?.airdrop || {};
      const journalAirdrop = journal?.airdrop || {};
      const proofTransferred = rows(proofAirdrop, 'transferred');
      const proofFailedRows = rows(proofAirdrop, 'failed');
      const proofRecipients = rows(proofAirdrop, 'recipients');
      const proofDelivered = count(proofAirdrop, 'deliveredCount', proofTransferred);
      const proofFailed = count(proofAirdrop, 'failedCount', proofFailedRows);
      const planned = Math.max(
        count(proofAirdrop, 'plannedRecipientCount', proofRecipients),
        proofRecipients.length,
        proofDelivered + proofFailed,
      );
      const missing = [];
      const mismatches = [];
      if (planned <= 0) return { required: false, missing, mismatches };
      const journalTransferred = rows(journalAirdrop, 'transferred');
      const journalFailedRows = rows(journalAirdrop, 'failed');
      const journalDelivered = journalTransferred.length;
      const journalFailed = journalFailedRows.length;
      if (!journalAirdrop || typeof journalAirdrop !== 'object' || (!journalDelivered && !journalFailed)) {
        missing.push('journal airdrop');
        return { required: true, missing, mismatches };
      }
      if (proofDelivered !== journalDelivered || proofFailed !== journalFailed) mismatches.push('airdrop counts');
      const proofWallets = wallets(proofTransferred);
      const journalWallets = wallets(journalTransferred);
      if (proofWallets.length && !journalWallets.length) missing.push('journal airdrop recipients');
      else if (proofWallets.length && journalWallets.length && (proofWallets.length !== journalWallets.length || proofWallets.some((id, index) => id !== journalWallets[index]))) {
        mismatches.push('airdrop recipients');
      }
      const proofTxs = txs(proofTransferred);
      const journalTxs = txs(journalTransferred);
      if (proofTxs.length && !journalTxs.length) missing.push('journal airdrop transactions');
      else if (proofTxs.length && journalTxs.length && (proofTxs.length !== journalTxs.length || proofTxs.some((id, index) => id !== journalTxs[index]))) {
        mismatches.push('airdrop transactions');
      }
      return { required: true, missing, mismatches };
    },
    proofMatchingLocalLaunchJournal: (proof = {}) => {
      const journals = Array.isArray(harnessState.recovery?.journals) ? harnessState.recovery.journals : [];
      const journalId = String(proof?.journalId || '').trim();
      const wallet = String(proof?.walletPublicKey || '').trim();
      const mint = String(proof?.token?.mint || proof?.tokenMint || '').trim();
      if (!journalId) return null;
      return journals.find((journal) => {
        if (String(journal?.id || '').trim() !== journalId) return false;
        const journalWallet = String(journal?.walletPublicKey || '').trim();
        if (wallet && journalWallet && wallet !== journalWallet) return false;
        const journalMint = String(journal?.token?.mint || journal?.token?.tokenMint || journal?.poolPlan?.tokenMint || '').trim();
        if (mint && journalMint && mint !== journalMint) return false;
        return true;
      }) || null;
    },
    isTerminalJournal: (journal) => ['completed', 'archived'].includes(String(journal?.status || '').toLowerCase()),
    launchProofPoolIds: (proof = {}) => [...new Set([
      ...(Array.isArray(proof?.liquidity?.poolIds) ? proof.liquidity.poolIds : []),
      ...(Array.isArray(proof?.liquidity?.results) ? proof.liquidity.results.map((pool) => pool?.poolId || pool?.id) : []),
    ].filter(Boolean).map(String))].sort(),
    proofJournalEvidenceState: (proof = {}) => {
      const journal = sandbox.proofMatchingLocalLaunchJournal(proof);
      const missing = [];
      const mismatches = [];
      const proofPoolIds = sandbox.launchProofPoolIds(proof);
      const journalRows = Array.isArray(journal?.lp?.results) && journal.lp.results.length
        ? journal.lp.results
        : (Array.isArray(journal?.lp?.partialResults) ? journal.lp.partialResults : []);
      const journalPoolIds = [...new Set(journalRows.map((pool) => pool?.poolId || pool?.id).filter(Boolean).map(String))].sort();
      if (!proof?.journalId) missing.push('journal id');
      if (!journal) {
        if (proof?.journalId) missing.push('local journal');
        return { journal: null, backed: false, missing, mismatches, proofPoolIds, journalPoolIds };
      }
      if (proofPoolIds.length && !journalPoolIds.length) {
        missing.push('journal pool ids');
      } else if (
        proofPoolIds.length
        && journalPoolIds.length
        && (proofPoolIds.length !== journalPoolIds.length || proofPoolIds.some((id, index) => id !== journalPoolIds[index]))
      ) {
        mismatches.push('pool ids');
      }
	      const proofTransfer = proof?.transfer || null;
	      const journalTransfer = journal?.transfer || null;
	      const proofSweepComplete = sandbox.transferHasFinalSweepEvidence(proofTransfer);
	      const proofTerminalSweepComplete = sandbox.transferHasWalletEmptyFinalSweepEvidence(proofTransfer);
	      const journalTerminalSweepComplete = sandbox.journalTransferHasTerminalSweepEvidence(journalTransfer);
	      const proofDestination = String(proofTransfer?.destinationWallet || proof?.destinationWallet || '').trim();
	      const journalDestination = String(journalTransfer?.destinationWallet || '').trim();
	      if (proofSweepComplete) {
	        if (!journalTransfer || typeof journalTransfer !== 'object') {
	          missing.push('journal sweep transfer');
	        } else if (!journalTerminalSweepComplete) {
	          missing.push('terminal journal sweep');
	        }
        if (proofDestination && !journalDestination) missing.push('journal sweep destination');
        const tokenEvidence = sandbox.proofTokenJournalEvidenceState(proof, journal);
        missing.push(...tokenEvidence.missing);
        mismatches.push(...tokenEvidence.mismatches);
        const liquidityEvidence = sandbox.proofLiquidityJournalEvidenceState(proof, journal);
        missing.push(...liquidityEvidence.missing);
        mismatches.push(...liquidityEvidence.mismatches);
	        const airdropEvidence = sandbox.proofAirdropJournalEvidenceState(proof, journal);
	        missing.push(...airdropEvidence.missing);
	        mismatches.push(...airdropEvidence.mismatches);
	      }
	      if (
	        proofTerminalSweepComplete
	        && journalTerminalSweepComplete
	        && (!proofDestination || !journalDestination || proofDestination === journalDestination)
	      ) {
	        const proofHash = sandbox.comparisonTransferEvidenceHash(proofTransfer);
	        const journalHash = sandbox.comparisonTransferEvidenceHash(journalTransfer);
	        if (!journalHash) missing.push('journal sweep evidence hash');
	        else if (proofHash !== journalHash) mismatches.push('sweep evidence hash');
	      }
	      if (proofDestination && journalDestination && proofDestination !== journalDestination) {
	        mismatches.push('sweep destination');
	      }
      return {
        journal,
        backed: missing.length === 0 && mismatches.length === 0,
        missing,
        mismatches,
        proofPoolIds,
        journalPoolIds,
      };
    },
    proofHasTerminalLaunchJournal: (proof = {}) => {
      const evidence = sandbox.proofJournalEvidenceState(proof);
      const journal = evidence.journal;
      return proof?.status === 'completed'
        && proof?.stage === 'transfer_completed'
        && journal?.status === 'completed'
        && journal?.stage === 'transfer_completed'
        && evidence.backed;
    },
    proofConfigForFingerprint: (proof, config) => proof?.launchConfig || config || { poolTopology: {} },
    buildV2ReportPoolPlan: (config = {}, results = []) => {
      if (Array.isArray(config?.poolTopology?.pools) && config.poolTopology.pools.length) return config.poolTopology.pools;
      return results.map((pool) => ({
        id: pool?.poolId || 'pool',
        plannedPositionCount: Number(pool?.positionCount || 1),
      }));
    },
    customQuoteSafetySummary: (topology = {}) => {
      const pools = Array.isArray(topology.pools) ? topology.pools : [];
      const rowTotalPoolPercent = pools.reduce((sum, pool) => sum + Number(pool?.supplyPercent || 0), 0);
      const summaryTotalPoolPercent = Number.isFinite(Number(topology.totalPoolPercent))
        ? Number(topology.totalPoolPercent)
        : null;
      const totalPoolPercent = rowTotalPoolPercent > 0
        ? rowTotalPoolPercent
        : (summaryTotalPoolPercent || 0);
      const supplyUsed = totalPoolPercent
        + Number(topology.preallocation?.supplyPercent || 0)
        + Number(topology.airdrop?.supplyPercent || 0);
      const blockers = Array.isArray(topology.blockers) ? [...topology.blockers] : [];
      if (
        rowTotalPoolPercent > 0
        && summaryTotalPoolPercent != null
        && Math.abs(rowTotalPoolPercent - summaryTotalPoolPercent) > 0.01
      ) {
        blockers.push({ state: 'danger', title: 'Pool allocation mismatch' });
      }
      if (totalPoolPercent <= 0) blockers.push({ state: 'danger', title: 'No liquidity allocation' });
      if (supplyUsed > 100.0001) blockers.push({ state: 'danger', title: 'Supply overallocated' });
      return {
        blockers,
        warnings: Array.isArray(topology.warnings) ? topology.warnings : [],
      };
    },
    fundingMeterSnapshot: () => harnessState.fundingSnapshot,
    quoteAcquireRoutes: () => harnessState.quoteRoutes,
    quoteAcquireProgress: () => harnessState.quoteProgress,
    quoteAcquireStatus: () => {
      const routes = harnessState.quoteRoutes;
      const progress = harnessState.quoteProgress;
      const ready = !routes.length || Boolean(
        harnessState.quoteAcquire?.job?.status === 'done'
        && !harnessState.quoteAcquireStale
        && Number(progress.completed || 0) >= Number(progress.total || routes.length)
        && Number(progress.failed || 0) === 0
      );
      return {
        ready,
        stale: Boolean(harnessState.quoteAcquireStale),
        progress,
      };
    },
    quoteManualPrefundItems: () => harnessState.manualItems,
    manualPrefundSummary: () => harnessState.manualSummary,
    renderV2TokenomicsDonutSvg: () => '',
    liquidityDepthRows: () => [],
  };
  vm.runInNewContext(
    [
      js.slice(demoConfigStart, demoConfigEnd),
      js.slice(txEvidenceStart, txEvidenceEnd),
      js.slice(reportStart, reportEnd),
      js.slice(heldAuditStart, heldAuditEnd),
      js.slice(comparisonSelectorStart, comparisonSelectorEnd),
      js.slice(gateStart, gateEnd),
      'globalThis.currentClassicComparisonForProof = currentClassicComparisonForProof;',
      'globalThis.demoRunHasCompletedReadiness = demoRunHasCompletedReadiness;',
      'globalThis.launchPlanConfigFingerprint = launchPlanConfigFingerprint;',
      'globalThis.launchPlanWalletFingerprint = launchPlanWalletFingerprint;',
      'globalThis.stampLaunchPlanConfigFingerprint = stampLaunchPlanConfigFingerprint;',
      'globalThis.localApiLaunchPlanStatus = localApiLaunchPlanStatus;',
      'globalThis.localApiLaunchPlanStaleReason = localApiLaunchPlanStaleReason;',
      'globalThis.classicFundingEstimateFingerprint = classicFundingEstimateFingerprint;',
      'globalThis.stampClassicFundingEstimate = stampClassicFundingEstimate;',
      'globalThis.buildClassicRetirementGate = buildClassicRetirementGate;',
      'globalThis.buildV2ReplacementCriteriaAudit = buildV2ReplacementCriteriaAudit;',
    ].join('\n'),
    sandbox,
    { filename: 'public/v2/app.js classic retirement gate harness' },
  );
  return sandbox;
}

function loadProofImportHarness() {
  const statusSource = js.match(/function classicComparisonStatusFromCounts[\s\S]*?\n}\n/)?.[0];
  const proofCountStart = js.indexOf('function proofPositions');
  const proofCountEnd = js.indexOf('function buildV2ReportAirdropAudit');
  const comparisonStart = js.indexOf('function collectArtifactAddresses');
  const comparisonEnd = js.indexOf('function buildV2ReportParityAudit');
  const finalizeStart = js.indexOf('function proofReportArtifactFinalizesDestination');
  const finalizeEnd = js.indexOf('\nfunction mergeLaunchConfigSnapshot', finalizeStart);
  const importStart = js.indexOf('function exportableLaunchConfigSnapshot');
  const importEnd = js.indexOf('\nfunction restoreImportedProofComparison', importStart);
  assert.ok(statusSource, 'classic comparison status helper should be extractable');
  assert.ok(proofCountStart >= 0 && proofCountEnd > proofCountStart, 'proof count helpers should be extractable');
  assert.ok(comparisonStart >= 0 && comparisonEnd > comparisonStart, 'classic comparison helpers should be extractable');
  assert.ok(finalizeStart >= 0 && finalizeEnd > finalizeStart, 'proof artifact finalization helper should be extractable');
  assert.ok(importStart >= 0 && importEnd > importStart, 'proof import helpers should be extractable');

  const sandbox = {
    console,
    Date,
    JSON,
    Number,
    V2_HTML_PROOF_AIRDROP_SAMPLE_LIMIT: 100,
    currentLaunchProof: () => null,
    currentLaunchConfig: () => ({
      token: { name: 'Typed', symbol: 'TYPED', supply: '1' },
      launchSol: 1,
      mode: 'guarded',
      poolTopology: { sweepDestination: 'TypedDest11111111111111111111111111111111111' },
    }),
    selectedLaunchWalletPublicKey: () => null,
    normalizeStoredLaunchProof: (record = {}) => ({
      proof: JSON.parse(JSON.stringify(record.proof)),
      savedAt: Date.now(),
      savedIso: new Date().toISOString(),
    }),
    normalizeClassicReportComparison: () => ({
      input: '',
      result: null,
      comparedAt: null,
      error: null,
    }),
    classicComparisonResultObject: (comparison = null) => {
      if (!comparison || typeof comparison !== 'object') return null;
      if (
        comparison.status
        || comparison.proofFingerprint
        || Array.isArray(comparison.rows)
        || Number(comparison.fieldCount || 0) > 0
      ) {
        return comparison;
      }
      return null;
    },
    proofConfigForFingerprint: (proof, config) => proof?.launchConfig || config || { poolTopology: {} },
    pruneLaunchProofEvidenceArtifacts: (proof = null, config = {}) => {
      if (!proof || typeof proof !== 'object') return proof;
      const cleaned = JSON.parse(JSON.stringify(proof));
      if (cleaned.reportParity && typeof cleaned.reportParity === 'object') {
        const expectedFingerprint = sandbox.launchProofFingerprint(cleaned, config);
        for (const key of ['comparison', 'classicComparison']) {
          const comparison = cleaned.reportParity[key];
          if (
            !comparison
            || typeof comparison !== 'object'
            || !comparison.proofFingerprint
            || comparison.proofFingerprint !== expectedFingerprint
          ) {
            delete cleaned.reportParity[key];
          }
        }
        if (!cleaned.reportParity.comparison && !cleaned.reportParity.classicComparison) {
          cleaned.reportParity.classicArtifactCompared = false;
          cleaned.reportParity.comparedAt = null;
        }
      }
      return cleaned;
    },
    classicComparisonIsRetirementGrade: (comparison = null, proof = {}, config = {}) => Boolean(
      comparison
      && comparison.status === 'pass'
      && comparison.artifactSource !== 'trebuchet-v2'
      && comparison.proofFingerprint === sandbox.launchProofFingerprint(proof, config)
      && sandbox.classicComparisonRequiredEvidence(comparison, proof, config).pass
    ),
    reportParityAuditMatchesProof: (audit = null, proof = {}, config = {}) => {
      if (!audit || typeof audit !== 'object') return false;
      const expected = sandbox.buildV2ReportParityAudit(proof, config);
      const expectedItems = Array.isArray(expected.items) ? expected.items : [];
      const items = Array.isArray(audit.items) ? audit.items : [];
      const itemCount = Number(audit.itemCount);
      const passCount = Number(audit.passCount || 0);
      const warnCount = Number(audit.warnCount || 0);
      const missingCount = Number(audit.missingCount || 0);
      const sameGeneratedText = (row = {}, expectedRow = {}, keys = []) => keys.every((key) => (
        String(row?.[key] ?? '').trim() === String(expectedRow?.[key] ?? '').trim()
      ));
      return Boolean(
        audit.source === 'trebuchet-v2-report-parity-audit'
        && audit.proofFingerprint === sandbox.launchProofFingerprint(proof, config)
        && Number(audit.version) >= 1
        && items.length > 0
        && Number.isInteger(itemCount)
        && itemCount === items.length
        && itemCount === expectedItems.length
        && passCount === Number(expected.passCount || 0)
        && warnCount === Number(expected.warnCount || 0)
        && missingCount === Number(expected.missingCount || 0)
        && passCount + warnCount + missingCount === itemCount
        && audit.status === expected.status
        && items.every((item, index) => (
          item?.id === expectedItems[index]?.id
          && item?.state === expectedItems[index]?.state
          && sameGeneratedText(item, expectedItems[index], ['label', 'detail'])
        ))
      );
    },
    classicRetirementGateMatchesProof: (gate = null, proof = {}, audit = null, config = {}) => {
      if (!gate || typeof gate !== 'object') return false;
      const expected = sandbox.buildClassicRetirementGate(proof, audit, config);
      const requirements = Array.isArray(gate.requirements) ? gate.requirements : [];
      const expectedRequirements = Array.isArray(expected.requirements) ? expected.requirements : [];
      const criteria = Array.isArray(gate.replacementCriteria) ? gate.replacementCriteria : [];
      const expectedCriteria = Array.isArray(expected.replacementCriteria) ? expected.replacementCriteria : [];
      const sameGeneratedText = (row = {}, expectedRow = {}, keys = []) => keys.every((key) => (
        String(row?.[key] ?? '').trim() === String(expectedRow?.[key] ?? '').trim()
      ));
      const sameRows = (rows, expectedRows) => rows.length === expectedRows.length
        && rows.every((row, index) => (
          row?.id === expectedRows[index]?.id
          && row?.pass === expectedRows[index]?.pass
          && sameGeneratedText(row, expectedRows[index], ['label', 'detail', 'evidence'])
        ));
      return Boolean(
        gate.source === 'trebuchet-v2-classic-retirement-gate'
        && gate.proofFingerprint === sandbox.launchProofFingerprint(proof, config)
        && gate.state === expected.state
        && Number(gate.passCount || 0) === Number(expected.passCount || 0)
        && Number(gate.itemCount || 0) === Number(expected.itemCount || 0)
        && Number(gate.criteriaPassCount || 0) === Number(expected.criteriaPassCount || 0)
        && Number(gate.criteriaItemCount || 0) === Number(expected.criteriaItemCount || 0)
        && sameRows(requirements, expectedRequirements)
        && sameRows(criteria, expectedCriteria)
      );
    },
    fieldVerificationMatchesProof: (packet = null, proof = {}, config = {}, audit = null, retirementGate = null) => {
      if (!packet || typeof packet !== 'object') return false;
      const expected = sandbox.buildV2FieldVerification({ proof, config, audit, retirementGate });
      const requirements = Array.isArray(packet.requirements) ? packet.requirements : [];
      const expectedRequirements = Array.isArray(expected.requirements) ? expected.requirements : [];
      const criteria = Array.isArray(packet.replacementCriteria) ? packet.replacementCriteria : [];
      const expectedCriteria = Array.isArray(expected.replacementCriteria) ? expected.replacementCriteria : [];
      const sameGeneratedText = (row = {}, expectedRow = {}, keys = []) => keys.every((key) => (
        String(row?.[key] ?? '').trim() === String(expectedRow?.[key] ?? '').trim()
      ));
      const sameRows = (rows, expectedRows) => rows.length === expectedRows.length
        && rows.every((row, index) => (
          row?.id === expectedRows[index]?.id
          && row?.pass === expectedRows[index]?.pass
          && sameGeneratedText(row, expectedRows[index], ['label', 'action', 'detail'])
        ));
      return Boolean(
        packet.source === 'trebuchet-v2-field-verification'
        && packet.proofFingerprint === expected.proofFingerprint
        && packet.state === expected.state
        && packet.ready === expected.ready
        && Number(packet.passCount || 0) === Number(expected.passCount || 0)
        && Number(packet.itemCount || 0) === Number(expected.itemCount || 0)
        && Number(packet.criteriaPassCount || 0) === Number(expected.criteriaPassCount || 0)
        && Number(packet.criteriaItemCount || 0) === Number(expected.criteriaItemCount || 0)
        && Number(packet.blockerCount || 0) === Number(expected.blockerCount || 0)
        && Number(packet.criteriaBlockerCount || 0) === Number(expected.criteriaBlockerCount || 0)
        && packet.nextAction === expected.nextAction
        && sameRows(requirements, expectedRequirements)
        && sameRows(criteria, expectedCriteria)
      );
    },
    pruneLaunchProofEvidenceArtifactsForExport: (proof = null, config = {}) => {
      const cleaned = sandbox.pruneLaunchProofEvidenceArtifacts(proof, config);
      if (!cleaned || typeof cleaned !== 'object') return cleaned;
      if (cleaned.reportParity && typeof cleaned.reportParity === 'object') {
        for (const key of ['comparison', 'classicComparison']) {
          const comparison = cleaned.reportParity[key];
          if (comparison && !sandbox.classicComparisonIsRetirementGrade(comparison, cleaned, config)) {
            delete cleaned.reportParity[key];
          }
        }
        if (!cleaned.reportParity.comparison && !cleaned.reportParity.classicComparison) {
          cleaned.reportParity.classicArtifactCompared = false;
          cleaned.reportParity.comparedAt = null;
        }
      }
      return cleaned;
    },
    buildV2ReportParityAudit: (proof, config) => ({
      version: 1,
      source: 'trebuchet-v2-report-parity-audit',
      status: 'warn',
      proofFingerprint: sandbox.launchProofFingerprint(proof, config),
      passCount: 1,
      warnCount: 1,
      missingCount: 0,
      itemCount: 2,
      items: [
        { id: 'token-proof', label: 'Token proof', state: 'pass', detail: 'Token proof attached.' },
        { id: 'classic-comparison', label: 'Classic comparison', state: 'warn', detail: 'Classic artifact comparison pending.' },
      ],
    }),
    buildClassicRetirementGate: (proof, audit) => ({
      source: 'trebuchet-v2-classic-retirement-gate',
      proofFingerprint: sandbox.launchProofFingerprint(proof, proof?.launchConfig || sandbox.currentLaunchConfig()),
      state: 'danger',
      auditFingerprint: audit?.proofFingerprint || null,
      requirements: [{ id: 'live-proof', pass: false, detail: 'Run a real v2 launch.' }],
      replacementCriteria: [],
    }),
    buildV2FieldVerification: (input = {}) => ({
      version: 1,
      source: 'trebuchet-v2-field-verification',
      proofFingerprint: sandbox.launchProofFingerprint(input.proof, input.config),
      state: 'blocked',
      ready: false,
      blockerCount: 1,
      criteriaBlockerCount: 0,
      nextAction: 'run-non-demo-v2-launch',
      nextDetail: 'Run a real v2 launch.',
      requirements: [{ id: 'live-proof', label: 'Live launch', pass: false, detail: 'Run a real v2 launch.' }],
      blockers: [{ id: 'live-proof', label: 'Live launch', pass: false, detail: 'Run a real v2 launch.' }],
      replacementCriteria: [],
      criteriaBlockers: [],
    }),
    state: {
      classicReportComparison: {},
    },
  };
  vm.runInNewContext(
    [
      statusSource,
      js.slice(finalizeStart, finalizeEnd),
      js.slice(proofCountStart, proofCountEnd),
      js.slice(comparisonStart, comparisonEnd),
      js.slice(importStart, importEnd),
      'globalThis.exportableLaunchConfigSnapshot = exportableLaunchConfigSnapshot;',
      'globalThis.importedProofComparisonConfig = importedProofComparisonConfig;',
      'globalThis.buildV2ProofExportPayload = buildV2ProofExportPayload;',
      'globalThis.proofFromImportedPayload = proofFromImportedPayload;',
      'globalThis.proofPayloadFromImportText = proofPayloadFromImportText;',
      'globalThis.importedLocalDossierEvidence = importedLocalDossierEvidence;',
      'globalThis.launchProofFingerprint = launchProofFingerprint;',
      'globalThis.comparisonTransferEvidenceHash = comparisonTransferEvidenceHash;',
      'globalThis.classicComparisonRequiredRows = classicComparisonRequiredRows;',
      'globalThis.classicComparisonRequiredEvidence = classicComparisonRequiredEvidence;',
    ].join('\n'),
    sandbox,
    { filename: 'public/v2/app.js proof import harness' },
  );
  return sandbox;
}

function loadV2ReportPositionCardHarness() {
  const escapeStart = js.indexOf('function escapeHtml');
  const escapeEnd = js.indexOf('\nfunction walletAccounts', escapeStart);
  const shortStart = js.indexOf('function shortAddress');
  const shortEnd = js.indexOf('\nfunction solflarePublicKeyText', shortStart);
  const reportStart = js.indexOf('function reportNumber');
  const reportEnd = js.indexOf('\nfunction v2ReportPositionList', reportStart);
  const positionStart = js.indexOf('function v2ReportPositionRange');
  const positionEnd = js.indexOf('\nfunction buildV2ReportTokenomics', positionStart);
  assert.ok(escapeStart >= 0 && escapeEnd > escapeStart, 'escape helper should be extractable');
  assert.ok(shortStart >= 0 && shortEnd > shortStart, 'address helper should be extractable');
  assert.ok(reportStart >= 0 && reportEnd > reportStart, 'report row helpers should be extractable');
  assert.ok(positionStart >= 0 && positionEnd > positionStart, 'position card helpers should be extractable');

  const sandbox = {
    window: {},
    solscanAccountUrl: (value) => `https://solscan.io/account/${value}`,
    solscanTxUrl: (value) => `https://solscan.io/tx/${value}`,
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(
    [
      js.slice(escapeStart, escapeEnd),
      js.slice(shortStart, shortEnd),
      js.slice(reportStart, reportEnd),
      js.slice(positionStart, positionEnd),
      'globalThis.renderV2ReportPositionCard = renderV2ReportPositionCard;',
    ].join('\n'),
    sandbox,
    { filename: 'public/v2/app.js report position card harness' },
  );
  return sandbox;
}

function loadV2ReportFeeTierHarness(tiers = null) {
  const defaultStart = js.indexOf('const DEFAULT_CLMM_FEE_TIERS');
  const defaultEnd = js.indexOf('\n\nconst standards', defaultStart);
  const numberStart = js.indexOf('function numberOrNull');
  const numberEnd = js.indexOf('\nfunction stableHashString', numberStart);
  const normalizeStart = js.indexOf('function normalizeClmmFeeTier');
  const normalizeEnd = js.indexOf('\nfunction feeTierLabel', normalizeStart);
  const helperStart = js.indexOf('function v2ReportPoolFeeTierLabel');
  const helperEnd = js.indexOf('\nfunction v2ReportPositionRows', helperStart);
  assert.ok(defaultStart >= 0 && defaultEnd > defaultStart, 'default fee tiers should be extractable');
  assert.ok(numberStart >= 0 && numberEnd > numberStart, 'number helper should be extractable');
  assert.ok(normalizeStart >= 0 && normalizeEnd > normalizeStart, 'fee tier normalizers should be extractable');
  assert.ok(helperStart >= 0 && helperEnd > helperStart, 'report fee tier helper should be extractable');

  const sandbox = {
    Number,
    state: {
      clmmFeeTiers: tiers,
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(
    [
      js.slice(defaultStart, defaultEnd),
      js.slice(numberStart, numberEnd),
      js.slice(normalizeStart, normalizeEnd),
      js.slice(helperStart, helperEnd),
      'globalThis.v2ReportPoolFeeTierLabel = v2ReportPoolFeeTierLabel;',
    ].join('\n'),
    sandbox,
    { filename: 'public/v2/app.js report fee tier harness' },
  );
  return sandbox;
}

function loadV2ReportDepthChartHarness() {
  const constantsStart = js.indexOf('const CLASSIC_LADDER_DEFAULT_SUPPLY_PERCENT');
  const constantsEnd = js.indexOf('\nconst EXECUTION_LEDGER_STORAGE_KEY', constantsStart);
  const escapeStart = js.indexOf('function escapeHtml');
  const escapeEnd = js.indexOf('\nfunction walletAccounts', escapeStart);
  const numberStart = js.indexOf('function numberOrNull');
  const numberEnd = js.indexOf('\nfunction stableHashString', numberStart);
  const reportStart = js.indexOf('function reportNumber');
  const reportEnd = js.indexOf('\nfunction reportExplorerUrl', reportStart);
  const helperStart = js.indexOf('function v2ReportMultiplierLabel');
  const helperEnd = js.indexOf('\nfunction v2ReportPositionRows', helperStart);
  assert.ok(constantsStart >= 0 && constantsEnd > constantsStart, 'ladder constants should be extractable');
  assert.ok(escapeStart >= 0 && escapeEnd > escapeStart, 'escape helper should be extractable');
  assert.ok(numberStart >= 0 && numberEnd > numberStart, 'number helper should be extractable');
  assert.ok(reportStart >= 0 && reportEnd > reportStart, 'report number helpers should be extractable');
  assert.ok(helperStart >= 0 && helperEnd > helperStart, 'depth chart helpers should be extractable');

  const sandbox = { Number, Math };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(
    [
      js.slice(constantsStart, constantsEnd),
      js.slice(escapeStart, escapeEnd),
      js.slice(numberStart, numberEnd),
      js.slice(reportStart, reportEnd),
      js.slice(helperStart, helperEnd),
      'globalThis.renderV2ReportDepthChart = renderV2ReportDepthChart;',
      'globalThis.v2ReportLadderBands = v2ReportLadderBands;',
    ].join('\n'),
    sandbox,
    { filename: 'public/v2/app.js report depth chart harness' },
  );
  return sandbox;
}

function loadV2ReportAirdropSectionHarness() {
  const escapeStart = js.indexOf('function escapeHtml');
  const escapeEnd = js.indexOf('\nfunction walletAccounts', escapeStart);
  const shortStart = js.indexOf('function shortAddress');
  const shortEnd = js.indexOf('\nfunction solflarePublicKeyText', shortStart);
  const solscanStart = js.indexOf('function solscanAccountUrl');
  const solscanEnd = js.indexOf('\nfunction v2ReportPoolTopology', solscanStart);
  const topologyStart = js.indexOf('function v2ReportPoolTopology');
  const topologyEnd = js.indexOf('\nfunction buildV2ReportPoolPlan', topologyStart);
  const auditStart = js.indexOf('function buildV2ReportAirdropAudit');
  const auditEnd = js.indexOf('\nfunction buildV2ReportRecoveryAudit', auditStart);
  const reportStart = js.indexOf('function reportNumber');
  const reportEnd = js.indexOf('\nfunction renderV2ReportAddressRow', reportStart);
  const factStart = js.indexOf('function renderV2ReportFactRow');
  const factEnd = js.indexOf('\nfunction v2ReportPositionList', factStart);
  const sectionStart = js.indexOf('function buildV2ReportAirdropSection');
  const sectionEnd = js.indexOf('\nfunction buildV2ReportRecoverySection', sectionStart);
  assert.ok(escapeStart >= 0 && escapeEnd > escapeStart, 'escape helper should be extractable');
  assert.ok(shortStart >= 0 && shortEnd > shortStart, 'short address helper should be extractable');
  assert.ok(solscanStart >= 0 && solscanEnd > solscanStart, 'solscan helpers should be extractable');
  assert.ok(topologyStart >= 0 && topologyEnd > topologyStart, 'report topology helper should be extractable');
  assert.ok(auditStart >= 0 && auditEnd > auditStart, 'airdrop audit helper should be extractable');
  assert.ok(reportStart >= 0 && reportEnd > reportStart, 'report number helpers should be extractable');
  assert.ok(factStart >= 0 && factEnd > factStart, 'fact row helper should be extractable');
  assert.ok(sectionStart >= 0 && sectionEnd > sectionStart, 'airdrop section helper should be extractable');

  const sandbox = { Number, Math, URLSearchParams, window: {} };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(
    [
      js.slice(escapeStart, escapeEnd),
      js.slice(shortStart, shortEnd),
      js.slice(solscanStart, solscanEnd),
      js.slice(topologyStart, topologyEnd),
      js.slice(auditStart, auditEnd),
      js.slice(reportStart, reportEnd),
      js.slice(factStart, factEnd),
      js.slice(sectionStart, sectionEnd),
      'globalThis.buildV2ReportAirdropSection = buildV2ReportAirdropSection;',
    ].join('\n'),
    sandbox,
    { filename: 'public/v2/app.js report airdrop harness' },
  );
  return sandbox;
}

function loadV2ReportSweepTransferHarness() {
  const escapeStart = js.indexOf('function escapeHtml');
  const escapeEnd = js.indexOf('\nfunction walletAccounts', escapeStart);
  const shortStart = js.indexOf('function shortAddress');
  const shortEnd = js.indexOf('\nfunction solflarePublicKeyText', shortStart);
  const solscanStart = js.indexOf('function solscanAccountUrl');
  const solscanEnd = js.indexOf('\nfunction v2ReportPoolTopology', solscanStart);
  const reportStart = js.indexOf('function reportNumber');
  const reportEnd = js.indexOf('\nfunction renderV2ReportAddressRow', reportStart);
  const factStart = js.indexOf('function renderV2ReportFactRow');
  const factEnd = js.indexOf('\nfunction v2ReportPositionList', factStart);
  const heldAuditStart = js.indexOf('function buildV2ReportHeldReserveAuditSection');
  const heldAuditEnd = js.indexOf('\nfunction buildV2ReportTokenomics', heldAuditStart);
  assert.ok(escapeStart >= 0 && escapeEnd > escapeStart, 'escape helper should be extractable');
  assert.ok(shortStart >= 0 && shortEnd > shortStart, 'short address helper should be extractable');
  assert.ok(solscanStart >= 0 && solscanEnd > solscanStart, 'solscan helpers should be extractable');
  assert.ok(reportStart >= 0 && reportEnd > reportStart, 'report number helpers should be extractable');
  assert.ok(factStart >= 0 && factEnd > factStart, 'sweep transfer helpers should be extractable');
  assert.ok(heldAuditStart >= 0 && heldAuditEnd > heldAuditStart, 'held reserve audit helper should be extractable');

  const sandbox = { Number, URLSearchParams, window: {} };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(
    [
      js.slice(escapeStart, escapeEnd),
      js.slice(shortStart, shortEnd),
      js.slice(solscanStart, solscanEnd),
      js.slice(reportStart, reportEnd),
      js.slice(factStart, factEnd),
      js.slice(heldAuditStart, heldAuditEnd),
      'globalThis.renderV2ReportObservedSpend = renderV2ReportObservedSpend;',
      'globalThis.buildV2ReportHeldReserveAuditSection = buildV2ReportHeldReserveAuditSection;',
      'globalThis.buildV2ReportSweepTransferRows = buildV2ReportSweepTransferRows;',
    ].join('\n'),
    sandbox,
    { filename: 'public/v2/app.js report sweep transfer harness' },
  );
  return sandbox;
}

function loadV2FieldVerificationHarness() {
  const escapeStart = js.indexOf('function escapeHtml');
  const escapeEnd = js.indexOf('\nfunction walletAccounts', escapeStart);
  const factStart = js.indexOf('function renderV2ReportFactRow');
  const factEnd = js.indexOf('\nfunction v2ReportPositionList', factStart);
  const evidenceHelperStart = js.indexOf('function generatedEvidenceTextMatches');
  const evidenceHelperEnd = js.indexOf('\nfunction v2ReportAuditNumber', evidenceHelperStart);
  const fieldStart = js.indexOf('const V2_FIELD_VERIFICATION_REQUIREMENTS');
  const fieldEnd = js.indexOf('\nfunction buildV2LaunchReportData', fieldStart);
  const sectionStart = js.indexOf('function buildV2ReportFieldVerificationSection');
  const sectionEnd = js.indexOf('\nfunction buildV2ReportParityAuditSection', sectionStart);
  assert.ok(escapeStart >= 0 && escapeEnd > escapeStart, 'escape helper should be extractable');
  assert.ok(factStart >= 0 && factEnd > factStart, 'fact row helper should be extractable');
  assert.ok(evidenceHelperStart >= 0 && evidenceHelperEnd > evidenceHelperStart, 'evidence text matcher should be extractable');
  assert.ok(fieldStart >= 0 && fieldEnd > fieldStart, 'field verification helper should be extractable');
  assert.ok(sectionStart >= 0 && sectionEnd > sectionStart, 'field verification section should be extractable');

  const sandbox = {
    Date,
    Number,
    String,
    proofConfigForFingerprint: (proof, config) => config || {},
    launchProofFingerprint: () => 'proof-fingerprint-111',
    reportParityAuditMatchesProof: (audit = {}) => Boolean(
      audit?.source === 'trebuchet-v2-report-parity-audit'
      && audit?.proofFingerprint === 'proof-fingerprint-111'
      && audit?.status === 'missing'
      && audit?.passCount === 0
      && audit?.warnCount === 0
      && audit?.missingCount === 1
      && audit?.itemCount === 1
      && Array.isArray(audit.items)
      && audit.items.length === 1
      && audit.items[0]?.id === 'live-proof'
      && audit.items[0]?.state === 'missing'
    ),
    buildV2ReportParityAudit: () => ({
      version: 1,
      source: 'trebuchet-v2-report-parity-audit',
      status: 'missing',
      proofFingerprint: 'proof-fingerprint-111',
      passCount: 0,
      warnCount: 0,
      missingCount: 1,
      itemCount: 1,
      items: [{ id: 'live-proof', label: 'Live proof', state: 'missing', detail: 'Run a real v2 launch.' }],
    }),
    buildClassicRetirementGate: () => sandbox.generatedRetirementGate || ({
      source: 'trebuchet-v2-classic-retirement-gate',
      proofFingerprint: 'proof-fingerprint-111',
      state: 'danger',
      passCount: 0,
      itemCount: 1,
      criteriaPassCount: 0,
      criteriaItemCount: 0,
      requirements: [
        { id: 'live-proof', pass: false, detail: 'Run a real v2 launch through token, liquidity, and final sweep.' },
      ],
      replacementCriteria: [],
    }),
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(
    [
      js.slice(escapeStart, escapeEnd),
      js.slice(factStart, factEnd),
      js.slice(evidenceHelperStart, evidenceHelperEnd),
      js.slice(fieldStart, fieldEnd),
      js.slice(sectionStart, sectionEnd),
      'globalThis.buildV2FieldVerification = buildV2FieldVerification;',
      'globalThis.buildV2ReportFieldVerificationSection = buildV2ReportFieldVerificationSection;',
    ].join('\n'),
    sandbox,
    { filename: 'public/v2/app.js field verification harness' },
  );
  return sandbox;
}

function loadFieldRunbookHarness() {
  const stagesStart = js.indexOf('const launchStages = [');
  const stagesEnd = js.indexOf('\nconst baseTransactions', stagesStart);
  const helpersStart = js.indexOf('function fieldRunbookStageChecks');
  const helpersEnd = js.indexOf('\nfunction renderStages', helpersStart);
  assert.ok(stagesStart >= 0 && stagesEnd > stagesStart, 'launch stages should be extractable');
  assert.ok(helpersStart >= 0 && helpersEnd > helpersStart, 'field runbook helpers should be extractable');

  const sandbox = {
    Map,
    Array,
    Number,
    state: {
      secretPin: { locked: false },
      vanityGrinding: false,
      quoteAcquire: { running: false },
      manualPrefund: { polling: false },
      apiStatus: 'connected',
      demoActive: false,
      executionReadiness: { status: 'ready', nextEndpoint: '/api/create-token' },
      fullRunRunning: false,
      realExecutionRunning: false,
      reportPublishing: false,
      executionChecking: false,
      classicReportComparison: { input: '' },
    },
    document: {
      querySelector: () => ({ value: '' }),
    },
    selectedLaunchWalletPublicKey: () => null,
    selectedManagedWallet: () => null,
    currentLaunchConfig: () => sandbox.config || ({ poolTopology: {} }),
    proofConfigForFingerprint: (proof, config) => proof?.launchConfig || config || { poolTopology: {} },
    classicFundingEstimateStatus: () => ({ matchesConfig: false, stale: false }),
    quoteAcquireStatus: () => ({ ready: false }),
    quoteAcquireRoutes: () => [],
    quoteManualPrefundItems: () => [],
    currentLaunchProof: () => sandbox.proof || ({ token: { mint: 'Mint111' }, canPublishReport: false }),
    proofHasReportPublishEvidence: () => sandbox.reportEvidence === true,
    airdropCompletionStatus: () => sandbox.airdropStatus || ({ complete: true }),
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(
    [
      js.slice(stagesStart, stagesEnd),
      js.slice(helpersStart, helpersEnd),
      'globalThis.buildFieldRunbookStages = buildFieldRunbookStages;',
      'globalThis.renderFieldRunbookSummary = renderFieldRunbookSummary;',
      'globalThis.fieldRunbookActionControl = fieldRunbookActionControl;',
    ].join('\n'),
    sandbox,
    { filename: 'public/v2/app.js field runbook harness' },
  );
  return sandbox;
}

function loadProofShareSummaryHarness() {
  const start = js.indexOf('function buildProofShareSummary');
  const end = js.indexOf('\nfunction reportParityClass', start);
  assert.ok(start >= 0 && end > start, 'proof share summary helper should be extractable');
  const sandbox = {
    Number,
    proofConfigForFingerprint: (proof, config) => proof?.launchConfig || config || { poolTopology: {} },
    currentReportPublish: () => ({ htmlUri: 'https://ar.example/report.html' }),
    currentLocalDossier: () => null,
    airdropCompletionStatus: (proof = {}) => sandbox.mockAirdropStatus || ({
      configured: Boolean(proof?.airdrop),
      complete: !proof?.airdrop,
      delivered: Number(proof?.airdrop?.deliveredCount || 0),
      failed: Number(proof?.airdrop?.failedCount || 0),
      pending: 0,
      missing: proof?.airdrop ? ['recipient rows', 'transaction signatures'] : [],
    }),
    launchProofPoolIds: (proof = {}) => [...new Set([
      ...(Array.isArray(proof?.liquidity?.poolIds) ? proof.liquidity.poolIds : []),
      ...(Array.isArray(proof?.liquidity?.results) ? proof.liquidity.results.map((pool) => pool?.poolId || pool?.id) : []),
    ].filter(Boolean).map(String))],
    proofPositions: (results = []) => results.reduce((sum, pool) => (
      sum
      + (Array.isArray(pool.mainPositions) ? pool.mainPositions.length : 0)
      + (Array.isArray(pool.ladderPositions) ? pool.ladderPositions.length : 0)
      + (Array.isArray(pool.supportPositions) ? pool.supportPositions.length : 0)
      + (pool.bootstrap ? 1 : 0)
    ), 0),
    proofEffectiveDestination: () => 'Dest111111111111111111111111111111111111111',
    buildV2ReportParityAudit: () => ({ status: 'warn' }),
    buildClassicRetirementGate: () => ({ state: 'danger' }),
    buildV2FieldVerification: () => sandbox.mockFieldVerification || ({
      ready: false,
      passCount: 2,
      itemCount: 5,
      blockerCount: 3,
      criteriaBlockerCount: 0,
      nextAction: 'compare-classic-artifact',
      nextDetail: 'Compare a completed Classic artifact against the completed v2 proof.',
      blockers: [
        {
          label: 'Classic artifact',
          detail: 'Compare a completed Classic artifact against the completed v2 proof.',
        },
        {
          label: 'Report',
          detail: 'Publish or attach a proof-bound v2 launch report before replacing Classic.',
        },
      ],
      criteriaBlockers: [],
    }),
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(
    [
      js.slice(start, end),
      'globalThis.buildProofShareSummary = buildProofShareSummary;',
    ].join('\n'),
    sandbox,
    { filename: 'public/v2/app.js proof share summary harness' },
  );
  return sandbox;
}

function loadSliceParserHarness() {
  const start = js.indexOf('function parseNumericInput');
  const end = js.indexOf('\nfunction isProbablySolanaAddress', start);
  assert.ok(start >= 0 && end > start, 'slice parser helpers should be extractable');
  const sandbox = { console };
  vm.runInNewContext(
    [
      js.slice(start, end),
      'globalThis.parseSliceShares = parseSliceShares;',
      'globalThis.normalizedSliceText = normalizedSliceText;',
    ].join('\n'),
    sandbox,
    { filename: 'public/v2/app.js slice parser harness' },
  );
  return sandbox;
}

function loadManualPrefundHarness() {
  const start = js.indexOf('function formatManualPrefundAmount');
  const end = js.indexOf('\nfunction quoteManualPrefundItems', start);
  assert.ok(start >= 0 && end > start, 'manual prefund helpers should be extractable');
  const harnessState = {
    apiStatus: 'connected',
    manualPrefund: {
      walletPublicKey: 'Wallet111',
      balance: {
        tokens: {
          Quote111: { amountRaw: '1000', amountUi: 1000, decimals: 0 },
        },
      },
      polling: false,
      error: null,
      lastUpdatedAt: new Date().toISOString(),
    },
    selectedWalletPublicKey: 'Wallet111',
  };
  const sandbox = {
    console,
    Intl,
    BigInt,
    WALLET_BALANCE_FRESH_MS: 60 * 1000,
    state: harnessState,
    selectedLaunchWalletPublicKey: () => harnessState.selectedWalletPublicKey,
  };
  vm.runInNewContext(
    [
      js.slice(start, end),
      'globalThis.manualPrefundStatus = manualPrefundStatus;',
      'globalThis.manualPrefundSummary = manualPrefundSummary;',
    ].join('\n'),
    sandbox,
    { filename: 'public/v2/app.js manual prefund harness' },
  );
  return sandbox;
}

function loadQuoteAcquireHarness() {
  const stableStart = js.indexOf('function stableFundingFingerprintValue');
  const stableEnd = js.indexOf('\nfunction proofLaunchConfigSnapshotState', stableStart);
  const quoteStart = js.indexOf('function quoteAcquireRoutes');
  const quoteEnd = js.indexOf('\nfunction quoteAcquireRouteLabel', quoteStart);
  assert.ok(stableStart >= 0 && stableEnd > stableStart, 'funding fingerprint helpers should be extractable');
  assert.ok(quoteStart >= 0 && quoteEnd > quoteStart, 'quote acquire helpers should be extractable');
  const harnessState = {
    classicFundingEstimate: null,
    quoteAcquire: {
      jobId: null,
      job: null,
      fingerprint: null,
    },
    selectedWalletPublicKey: 'Wallet111',
    currentConfig: {
      token: { supply: '1000000', decimals: 9 },
      poolTopology: {
        pools: [{ quoteToken: 'SOL', supplyPercent: 100, distribution: [{ percent: 100 }] }],
        targetMarketCapUsd: 1000,
        report: { publish: true },
        airdrop: { enabled: false, recipientCount: 0, supplyPercent: 0, executionCostSol: 0 },
      },
    },
  };
  const sandbox = {
    console,
    Intl,
    BigInt,
    state: harnessState,
    currentLaunchConfig: () => harnessState.currentConfig,
    selectedLaunchWalletPublicKey: () => harnessState.selectedWalletPublicKey,
    clampPercent: (value) => Math.max(0, Math.min(100, Number(value) || 0)),
    shortAddress: (value) => String(value || '').slice(0, 8),
  };
  vm.runInNewContext(
    [
      js.slice(stableStart, stableEnd),
      js.slice(quoteStart, quoteEnd),
      'globalThis.classicFundingEstimateFingerprint = classicFundingEstimateFingerprint;',
      'globalThis.quoteAcquireFingerprint = quoteAcquireFingerprint;',
      'globalThis.quoteAcquireStatus = quoteAcquireStatus;',
      'globalThis.quoteAcquireBadge = quoteAcquireBadge;',
    ].join('\n'),
    sandbox,
    { filename: 'public/v2/app.js quote acquire harness' },
  );
  return sandbox;
}

function loadFundingMeterHarness() {
  const start = js.indexOf('function fundingMeterSnapshot');
  const end = js.indexOf('\nfunction liquidityDepthRows', start);
  const snapshotStart = js.indexOf('function manualPrefundBalanceSnapshotStatus');
  const snapshotEnd = js.indexOf('\nfunction manualPrefundTokenBalance', snapshotStart);
  assert.ok(start >= 0 && end > start, 'funding meter helpers should be extractable');
  assert.ok(snapshotStart >= 0 && snapshotEnd > snapshotStart, 'manual prefund balance status should be extractable');
  const harnessState = {
    apiStatus: 'connected',
    classicFundingEstimate: { totalSol: 2 },
    launchPlan: null,
    quoteAcquire: { job: null, error: null, running: false },
    manualPrefund: {
      walletPublicKey: null,
      balance: null,
      polling: false,
      error: null,
      lastUpdatedAt: null,
    },
    selectedWalletPublicKey: 'Wallet111',
  };
  const sandbox = {
    console,
    state: harnessState,
    baseTransactions: [{ cost: 0.2 }],
    selectedLaunchWalletPublicKey: () => harnessState.selectedWalletPublicKey,
    classicFundingEstimateStatus: () => ({ matchesConfig: true, stale: false, hasEstimate: true }),
    quoteAcquireRoutes: () => [],
    quoteAcquireStatus: () => ({ ready: true, stale: false, progress: { total: 0, completed: 0, failed: 0 } }),
    quoteManualPrefundItems: () => [],
    manualPrefundSummary: () => ({ label: 'None', className: '' }),
    observedExecutionSpendSummary: () => ({ measuredCount: 0, errorCount: 0, outflowSol: 0, inflowSol: 0 }),
    fmtSol: (value) => `${Number(value).toFixed(3)} SOL`,
    clampPercent: (value) => Math.max(0, Math.min(100, Number(value) || 0)),
    WALLET_BALANCE_FRESH_MS: 60 * 1000,
  };
  vm.runInNewContext(
    [
      js.slice(start, end),
      js.slice(snapshotStart, snapshotEnd),
      'globalThis.fundingMeterSnapshot = fundingMeterSnapshot;',
      'globalThis.selectedWalletDetailedBalance = selectedWalletDetailedBalance;',
    ].join('\n'),
    sandbox,
    { filename: 'public/v2/app.js funding meter harness' },
  );
  return sandbox;
}

test('v2 prototype has no duplicate element ids', () => {
  const counts = new Map();
  for (const id of attrValues(html, 'id')) counts.set(id, (counts.get(id) || 0) + 1);
  const duplicates = [...counts.entries()].filter(([, count]) => count > 1).map(([id]) => id);

  assert.deepEqual(duplicates, []);
});

test('v2 navigation and views stay wired together', () => {
  const navViews = attrValues(html, 'data-view').sort();
  const sectionViews = attrValues(html, 'id')
    .filter((id) => id.startsWith('view-'))
    .map((id) => id.replace(/^view-/, ''))
    .sort();
  const viewKeys = [...js.matchAll(/^\s{2}([a-z-]+): \{ eyebrow:/gm)]
    .map((match) => match[1])
    .sort();

  assert.deepEqual(navViews, ['discovery', 'history', 'launch', 'settings', 'wallet']);
  assert.deepEqual(sectionViews, navViews);
  assert.deepEqual(viewKeys, navViews);
});

test('v2 JavaScript render targets exist in the HTML shell', () => {
  const ids = new Set(attrValues(html, 'id'));
  const selectors = new Set([...js.matchAll(/\$\(['"]#([A-Za-z0-9_-]+)['"]\)/g)].map((match) => match[1]));
  const missing = [...selectors].filter((id) => !ids.has(id));

  assert.deepEqual(missing, []);
});

test('v2 delegated clicks do not confuse body state for navigation', () => {
  assert.doesNotMatch(js, /body\.dataset\.view/);
  assert.match(js, /body\.dataset\.activeView/);
  assert.match(js, /closest\('button\[data-launch-workspace\]'\)/);
  assert.doesNotMatch(js, /closest\('\[data-launch-workspace\]'\)/);
  assert.match(css, /body\[data-active-view="launch"\]/);
  assert.doesNotMatch(css, /body\[data-view=/);
});

test('v2 Recovery PIN unlock is a full-screen four-box security gate', () => {
  const gateHtml = html.match(/<section class="recovery-pin-gate"[\s\S]*?<\/section>/)?.[0] || '';
  const unlockSource = js.match(/async function unlockSecretPin\([\s\S]*?\n\}\n\nasync function changeSecretPin/)?.[0] || '';

  assert.ok(gateHtml, 'Recovery PIN gate should exist in the v2 shell');
  assert.equal((gateHtml.match(/<span><\/span>/g) || []).length, 4);
  assert.match(gateHtml, /id="recoveryPinInput"[^>]*maxlength="4"/);
  assert.match(gateHtml, /aria-modal="true"/);
  assert.match(css, /\.recovery-pin-gate\s*\{[\s\S]*?position:\s*fixed;[\s\S]*?inset:\s*0;/);
  assert.match(css, /data-status="success"[\s\S]*?#6feea9/);
  assert.match(css, /data-status="error"[\s\S]*?#ff5d65/);
  assert.match(js, /function openRecoveryPinGate/);
  assert.match(js, /function submitRecoveryPinGate/);
  assert.match(js, /Try again\. All four digits were cleared\./);
  assert.match(unlockSource, /return openRecoveryPinGate\(\{ reason \}\)/);
  assert.doesNotMatch(unlockSource, /promptRecoveryPin/);
});

test('v2 recovery sweep uses an in-app typed confirmation instead of native prompt', () => {
  const sweepSource = js.match(/async function sweepRecoveryWallet\([\s\S]*?\n\}\n\nasync function cancelRefundLaunch/)?.[0] || '';

  assert.match(html, /id="sweepConfirmGate"[^>]*role="dialog"[^>]*aria-modal="true"/);
  assert.match(html, /id="sweepConfirmDestination"/);
  assert.match(html, /id="sweepConfirmTypedAddress"/);
  assert.match(html, /data-action="cancel-sweep-confirm"/);
  assert.match(html, /data-action="submit-sweep-confirm"/);
  assert.match(js, /function openSweepConfirmation/);
  assert.match(js, /function submitSweepConfirmation/);
  assert.match(sweepSource, /await openSweepConfirmation\(\{ publicKey, defaultDestination \}\)/);
  assert.doesNotMatch(sweepSource, /window\.prompt|window\.confirm/);
  assert.match(css, /\.sweep-confirm-gate\s*\{[\s\S]*?position:\s*fixed;/);
  assert.match(css, /\.sweep-confirm-field input\[aria-invalid="true"\]/);
});

test('v2 renderer uses an in-app operator dialog instead of unsupported native prompts', () => {
  assert.doesNotMatch(js, /window\.prompt\s*\(/);
  assert.match(html, /id="operatorPromptGate"[^>]*role="dialog"[^>]*aria-modal="true"/);
  assert.match(html, /id="operatorPromptInput"[^>]*type="text"/);
  assert.match(html, /data-action="cancel-operator-prompt"/);
  assert.match(html, /data-action="submit-operator-prompt"/);
  assert.match(js, /function openOperatorPrompt/);
  assert.match(js, /function submitOperatorPrompt/);
  assert.match(js, /control\.value = '';/);
  assert.match(js, /async function importManagedWallet\([\s\S]*?await openOperatorPrompt/);
  assert.match(js, /async function resetSecretPin\([\s\S]*?await openOperatorPrompt/);
  assert.match(js, /async function discardSelectedWallet\([\s\S]*?await openOperatorPrompt/);
  assert.match(js, /async function cancelRefundLaunch\([\s\S]*?await openOperatorPrompt/);
  assert.match(css, /\.operator-prompt-gate\s*\{[\s\S]*?z-index:\s*1150/);
});

test('v2 concrete data-action controls have delegated handlers', () => {
  const actions = [...new Set(concreteDataActions(`${html}\n${js}`))].sort();
  const handled = handledClickActions(js);
  const missing = actions.filter((action) => !handled.has(action));

  assert.ok(actions.length > 70, 'expected the v2 action audit to cover rendered controls');
  assert.deepEqual(missing, []);
});

test('v2 is the Electron default with an explicit tested Classic fallback', () => {
  assert.equal(packageJson.scripts.start, 'electron .');
  assert.equal(packageJson.scripts['start:v2'], 'electron . --v2');
  assert.equal(packageJson.scripts['start:classic'], 'electron . --classic');
  assert.equal(packageJson.scripts['test:e2e:v2'], 'node test/e2e/v2-flows.mjs');
  assert.equal(packageJson.scripts['test:electron:v2:packaged'], 'node test/e2e/electron-v2-smoke.mjs --packaged');
  assert.match(electronMainJs, /process\.argv\.includes\('--classic'\)/);
  assert.match(electronMainJs, /requestedDesktopUi === 'classic'/);
  assert.match(electronMainJs, /requestedDesktopUi === 'v1'/);
  assert.match(electronMainJs, /const desktopUiPath = classicUiRequested \? '\/' : '\/v2\/'/);
  assert.match(electronMainJs, /win\.loadURL\(`http:\/\/127\.0\.0\.1:\$\{serverPort\}\$\{desktopUiPath\}`\)/);
  assert.match(v2BrowserE2eJs, /page\.goto\(`\$\{baseUrl\}\/v2\/`/);
  assert.match(v2BrowserE2eJs, /data-action=\"run-demo-launch\"/);
  assert.match(v2BrowserE2eJs, /Local API connected/);
  assert.match(v2ElectronSmokeJs, /await launchRouteSmoke\(\)/);
  assert.match(v2ElectronSmokeJs, /await launchRouteSmoke\(\{ classic: true \}\)/);
  assert.match(v2ElectronSmokeJs, /const expectedPath = classic \? '\/' : '\/v2\/'/);
});

test('v2 Discovery is a live, locally persisted evidence registry without social mechanics', () => {
  const combined = `${html}\n${css}\n${js}`;

  assert.match(combined, /Live Solana evidence/);
  assert.match(combined, /Token registry/);
  assert.match(combined, /inspectDiscoveryToken/);
  assert.match(combined, /Live RPC/);
  assert.match(combined, /top 10 accounts/i);
  assert.match(combined, /local launch journal/i);
  assert.match(combined, /DISCOVERY_STORAGE_KEY/);
  assert.match(combined, /confidence/i);
  assert.match(combined, /provenance/i);
  assert.match(js, /discoveryWarningSummary/);
  assert.match(js, /Concentration check delayed/);
  assert.match(js, /No local launch artifacts linked/);
  assert.match(js, /discovery-warning-line/);
  assert.match(js, /evidence-summary-strip/);
  assert.match(js, /evidence-facts/);
  assert.match(js, /Stored only in this browser profile/);
  assert.doesNotMatch(html, /selectedChatTitle|id="chatPanel"/);
  assert.match(js, /rawTopTen == null \? null : Number\(rawTopTen\)/);
  assert.match(js, /topTen != null && Number\.isFinite\(topTen\)/);
  assert.doesNotMatch(combined, /Mock dataset/);
  assert.doesNotMatch(combined, /Mock sample/);
  assert.doesNotMatch(combined, /Transaction Room/);
  assert.doesNotMatch(combined, /\bMy rating\b/i);
  assert.doesNotMatch(combined, /\bdata-rate\b/i);
  assert.doesNotMatch(combined, /\brenderRating\b/i);
  assert.doesNotMatch(combined, /\bbookmark/i);
  assert.doesNotMatch(combined, /\bsocial vote/i);
});

test('v2 removes the staged NFT collection product surface', () => {
  const combined = `${html}\n${css}\n${js}`;

  assert.doesNotMatch(combined, /NFT collection/i);
  assert.doesNotMatch(combined, /avatarCollection/);
  assert.doesNotMatch(combined, /avatar-collection/);
  assert.doesNotMatch(combined, /v2-avatar-collection/);
  assert.doesNotMatch(combined, /holder runtime/i);
  assert.match(combined, /data-action="select-discovery"/);
});

test('v2 applies Trebuchet branding from the v1 launch site', () => {
  const combined = `${html}\n${css}\n${js}`;

  assert.match(html, /T R E B U C H E T/);
  assert.match(combined, /makesometokens\.com/);
  assert.match(combined, /Launch Solana tokens\. No middleman\./);
  assert.match(combined, /Your machine \/ your keys \/ your launch/);
  assert.match(combined, /Token being launched/);
  assert.match(html, /topbar-brand/);
  assert.match(css, /\.brand-mark::before/);
  assert.match(css, /\.brand-mark::after/);
});

test('v2 launch page presents an agentic control panel instead of instruction walls', () => {
  const combined = `${html}\n${css}\n${js}`;

  assert.match(combined, /Trebuchet agent/);
  assert.match(html, /id="agentStatusTitle"/);
  assert.match(html, /id="agentNextTitle"/);
  assert.match(html, /id="agentNextDetail"/);
  assert.match(html, /data-agent-check="setup"/);
  assert.match(html, /data-agent-check="fund"/);
  assert.match(html, /data-agent-check="run"/);
  assert.match(html, /data-agent-check="recover"/);
  assert.match(combined, /Trebuchet wallet/);
  assert.match(combined, /App-managed wallets/);
  assert.match(combined, /Custody workspace/);
  assert.match(combined, /Wallet operations/);
  assert.match(combined, /Active signer/);
  assert.match(combined, /Recovery inventory/);
  assert.match(combined, /Separate recovery queue/);
  assert.match(html, /id="walletRecoveryInventory"/);
  assert.match(js, /data-action="inspect-recovery-record"/);
  assert.match(js, /data-recovery-pane=/);
  assert.match(css, /\.wallet-inventory-drawer\s*\{/);
  assert.match(css, /\.wallet-inventory-drawer\[open\]/);
  assert.match(combined, /External funding wallet/);
  assert.match(combined, /Solflare/);
  assert.match(combined, /Does not sign launch execution/);
  assert.match(combined, /Managed wallet import/);
  assert.match(combined, /Imported wallet support/);
  assert.match(combined, /Import mnemonic, base58, or JSON local wallets/);
  assert.match(html, /id="tokenLogoFile"/);
  assert.match(html, /id="tokenLogoPreview"/);
  assert.match(html, /accept="image\/png,image\/jpeg"/);
  assert.match(combined, /wallet-detail-panel/);
  assert.match(combined, /recoveryWizard/);
  assert.match(combined, /recoveryWalletWorkspace/);
  assert.match(combined, /Recovery PIN/);
  assert.match(combined, /data-action="import-wallet"/);
  assert.match(combined, /data-action="select-recovery-wallet"/);
  assert.match(combined, /reveal-recovery-wallet/);
  assert.match(combined, /sweep-recovery-wallet/);
  assert.match(combined, /data-action="discard-recovery-wallet"/);
  assert.match(combined, /setup-secret-pin/);
  assert.match(combined, /unlock-secret-pin/);
  assert.match(combined, /change-secret-pin/);
  assert.match(combined, /lock-secret-pin/);
  assert.match(combined, /reset-secret-pin/);
  assert.match(combined, /loadWalletQr/);
  assert.match(combined, /revealWalletSecret/);
  assert.match(combined, /discardSelectedWallet/);
  assert.match(combined, /selectRecoveryWallet/);
  assert.match(combined, /sweepRecoveryWallet/);
  assert.match(combined, /renderRecoverySweepResult/);
  assert.match(combined, /renderSecretPinResetAudit/);
  assert.match(combined, /Recovery PIN reset audit/);
  assert.match(combined, /use-recovery-wallet-for-launch/);
  assert.match(combined, /Use for launch/);
  assert.match(combined, /data-action="connect-solflare"/);
  assert.match(combined, /data-action="disconnect-solflare"/);
  assert.match(combined, /data-action="use-solflare-destination"/);
  assert.match(combined, /lastSecretPinReset/);
  assert.match(combined, /recoverySweepNextSteps/);
  assert.match(combined, /recoveryGuideModel/);
  assert.match(combined, /renderRecoveryGuide/);
  assert.match(combined, /Recovery guide/);
  assert.match(combined, /recoveryWizardModel/);
  assert.match(combined, /renderRecoveryWizard/);
  assert.match(combined, /currentRecoveryWizardModel/);
  assert.match(combined, /Recovery wizard/);
  assert.match(combined, /Recovery needs local app/);
  assert.match(combined, /Find failed launch state/);
  assert.match(combined, /Unlock recovery material/);
  assert.match(combined, /Resume only missing work/);
  assert.match(combined, /Manual recovery required/);
  assert.match(combined, /data-action="select-recovery-step"/);
  assert.match(combined, /recovery-wizard-prev/);
  assert.match(combined, /recovery-wizard-next/);
  assert.match(combined, /Retry sweep/);
  assert.match(combined, /No recovery action needed/);
  assert.match(combined, /renderRecoveryWalletWorkspace/);
  assert.match(combined, /setupSecretPin/);
  assert.match(combined, /unlockSecretPin/);
  assert.match(combined, /changeSecretPin/);
  assert.match(combined, /lockSecretPin/);
  assert.match(combined, /resetSecretPin/);
  assert.match(combined, /renderSolflarePanel/);
  assert.match(combined, /connectSolflareWallet/);
  assert.match(combined, /disconnectSolflareWallet/);
  assert.match(combined, /applySolflareAsSweepDestination/);
  assert.match(combined, /copy-wallet-address/);
  assert.match(combined, /data-action="discard-wallet"/);
  assert.match(combined, /Ready to build the launch plan/);
  assert.match(combined, /Next move/);
  assert.match(combined, /Step 1 of 6 · Setup/);
  assert.match(combined, /Trebuchet holds the launch key locally/);
  assert.match(combined, /Review run plan/);
  assert.match(combined, /Guided launch/);
  assert.match(combined, /Practice run/);
  assert.match(css, /agent-console/);
  assert.match(css, /agent-checks/);
  assert.doesNotMatch(html, /<section class="operator-guide"/);
});

test('v2 launch page ships a no-scroll parity cockpit with preview charts', () => {
  const combined = `${html}\n${css}\n${js}`;

  assert.match(html, /id="chartDeck"/);
  assert.match(html, /id="tokenomicsChart"/);
  assert.match(html, /id="tokenomicsState"/);
  assert.match(html, /id="liquidityChart"/);
  assert.match(html, /id="liquidityState"/);
  assert.match(html, /id="fundingMeter"/);
  assert.match(html, /id="parityPanel"/);
  assert.match(html, /id="classicBridge"/);
  assert.match(html, /id="liveOpsPanel"/);
  assert.match(html, /id="activityLogDrawer"/);
  assert.match(html, /id="launchWorkspaceTabs"/);
  assert.match(html, /id="launchWorkspaceViewport"/);
  for (const workspace of ['configure', 'fund', 'execute', 'verify', 'recover']) {
    assert.match(html, new RegExp(`data-launch-workspace="${workspace}"`));
  }
  assert.match(html, /id="poolEditorPanel"/);
  assert.match(html, /id="airdropCsvText"/);
  assert.match(html, /id="preallocationSupplyPercent"/);
  assert.match(html, /id="airdropSupplyPercent"/);
  assert.match(html, /id="airdropAutoFit"/);
  assert.match(html, /id="airdropBudgetPanel"/);
  assert.match(html, /id="reportPreview"/);
  assert.match(html, /Classic parity controls/);
  assert.match(html, /id="tokenSupply" type="text" value="1,000,000,000" inputmode="numeric" max="10000000000"/);
  assert.match(html, /id="mainPoolPercent"/);
  assert.match(html, /id="sliceShares"/);
  assert.match(html, /id="ladderBands" type="number" value="5" min="0" max="20"/);
  assert.match(html, /Round slices to 100%/);
  assert.match(html, /Starts &amp; Ends With/);
  assert.match(combined, /Diagnostics/);
  assert.match(combined, /System status/);
  assert.match(combined, /Custom Vanity CA grinder/);
  assert.match(css, /cockpit-board/);
  assert.match(css, /chart-deck/);
  assert.match(css, /scroll-snap-type: x mandatory/);
  assert.match(css, /max-height: 190px/);
  assert.match(css, /\.cockpit-board \.action-panel \.queue-list[\s\S]*display: none/);
  assert.match(css, /funding-row\.warn/);
  assert.match(css, /funding-row\.danger/);
  assert.match(css, /depth-band\.active/);
  assert.match(css, /depth-band\.complete/);
  assert.match(css, /classic-phase-grid/);
  assert.match(css, /live-ops-panel/);
  assert.match(css, /activity-drawer/);
  assert.match(css, /activity-filter-tabs/);
  assert.match(css, /body\[data-active-view="launch"\][\s\S]*overflow: hidden/);
  assert.match(css, /launch-workspace-viewport[\s\S]*overflow: hidden auto/);
  assert.match(css, /launch-workspace-tab\.is-selected/);
  assert.match(css, /journal-resume-plan/);
  assert.match(css, /token-logo-preview/);
  assert.match(css, /asset-mark\.has-logo/);
  assert.match(css, /manual-prefund-panel/);
  assert.match(css, /manual-prefund-status/);
  assert.match(css, /quote-info-panel/);
  assert.match(combined, /duplicatePoolRouteIssues/);
  assert.match(js, /function setLaunchWorkspace/);
  assert.match(js, /function renderLaunchWorkspace/);
  assert.match(js, /trebuchet-v2-launch-workspace/);
  assert.match(combined, /Raydium uses both to identify a pool/);
  assert.match(combined, /classicSimpleLadderConfig/);
  assert.match(combined, /CLASSIC_LADDER_DEFAULT_CEILING_MULTIPLIER/);
  assert.match(combined, /feeKeyRecipientIssues/);
  assert.match(combined, /Fee Key recipient does not look like a valid Solana address/);
  assert.match(combined, /sweepDestinationIssues/);
  assert.match(combined, /Sweep destination does not look like a valid Solana address/);
  assert.match(combined, /airdropRecipientIssues/);
  assert.match(combined, /Airdrop recipient/);
  assert.match(combined, /token amount must be greater than 0/);
  assert.match(css, /solflare-panel/);
  assert.match(css, /solflare-grid/);
  assert.match(css, /quote-guidance-panel/);
  assert.match(css, /quote-guidance-list/);
  assert.match(css, /cancel-refund-panel/);
  assert.match(css, /cancel-refund-grid/);
  assert.match(css, /rpc-settings-panel/);
  assert.match(css, /rpc-saved-list/);
  assert.match(css, /rpc-add-grid/);
  assert.match(css, /airdrop-budget-panel/);
  assert.match(css, /airdrop-budget-meter/);
  assert.match(css, /funding-wallet-hint/);
  assert.match(css, /vanity-status/);
  assert.match(css, /vanity-candidate-list/);
  assert.match(css, /finalize-panel/);
  assert.match(css, /finalize-grid/);
  assert.match(css, /parity-row/);
  assert.match(css, /field-proof-rail/);
  assert.match(css, /field-proof-steps/);
  assert.match(css, /field-proof-step/);
  assert.match(css, /criteria-strip/);
  assert.match(css, /criteria-chip/);
  assert.match(css, /signature-panel:not\(.is-staged\)/);
  assert.match(css, /signature-panel\.is-live/);
  assert.match(css, /signature-step\.blocked/);
  assert.match(css, /execution-ledger/);
  assert.match(css, /history-audit-panel/);
  assert.match(css, /history-audit-actions/);
  assert.match(js, /renderChartDeck/);
  assert.match(js, /chartEvidenceBadge/);
  assert.match(js, /setChartBadge/);
  assert.match(js, /setChartBadge\('#tokenomicsState', tokenomicsBadge\)/);
  assert.match(js, /setChartBadge\('#liquidityState', liquidityBadge\)/);
  assert.match(js, /renderAgentConsole/);
  assert.match(js, /agentCheckForStage/);
  assert.match(js, /#agentStatusTitle/);
  assert.match(js, /#agentNextTitle/);
  assert.match(js, /#agentNextDetail/);
  assert.match(js, /data-agent-check/);
  assert.match(js, /buildV2TokenomicsItems/);
  assert.match(js, /renderV2TokenomicsDonutSvg/);
  assert.match(js, /liquidityDepthRows/);
  assert.match(js, /open/);
  assert.match(js, /lock/);
  assert.match(js, /fundingMeterSnapshot/);
  assert.match(js, /const selectedWallet = selectedManagedWallet\(\)/);
  assert.match(js, /const walletSecretLocked = state\.secretPin\.locked \|\| selectedWallet\?\.secretPinLocked === true/);
  assert.match(js, /const walletSecretAvailable = state\.demoActive \|\| selectedWallet\?\.hasSecretKey === true/);
  assert.match(js, /const walletReady = Boolean\(selectedWalletPublicKey && selectedWallet && walletSecretAvailable && !walletSecretLocked && !selectedWallet\.decryptionFailed\)/);
  assert.match(js, /Unlock the Recovery PIN before Trebuchet can sign launch calls/);
  assert.match(js, /const proofWalletEvidence = Boolean\(proof\?\.walletPublicKey && hasCompletedLiveProof\)/);
  assert.doesNotMatch(js, /proof\?\.walletPublicKey && \(hasCompletedLiveProof \|\| demoRunComplete\)/);
  assert.match(js, /const walletRuntimeEvidence = Boolean\(/);
  assert.match(js, /state\.apiStatus === 'connected'\s*&& selectedWalletPublicKey/);
  assert.match(js, /selectedWallet\.hasSecretKey === true/);
  assert.match(js, /Connect the local app to verify this managed wallet signing secret/);
  assert.match(js, /Selected launch wallet is PIN locked/);
  assert.match(js, /state\.apiStatus === 'connected'\s*&& candidate\?\.persisted === true/);
  assert.match(js, /state\.apiStatus === 'connected' && state\.vanityAvailable/);
  assert.match(js, /Connect the local app to verify the native grinder/);
  assert.match(js, /const CLASSIC_TOKEN_NAME_MAX_BYTES = 32/);
  assert.match(js, /const CLASSIC_TOKEN_SYMBOL_MAX_BYTES = 10/);
  assert.match(js, /const CLASSIC_TOKEN_DESCRIPTION_MAX_BYTES = 1000/);
  assert.match(js, /const CLASSIC_MAX_WHOLE_TOKEN_SUPPLY = 10_000_000_000n/);
  assert.match(js, /function tokenConfigStatus\(config = currentLaunchConfig\(\)\)/);
  assert.match(js, /const tokenConfig = tokenConfigStatus\(hasCompletedLiveProof \? proofConfigForFingerprint\(proof, config\) : config\)/);
  assert.match(js, /const tokenConfigEvidence = Boolean\(/);
  assert.match(js, /id: 'token-config-parity'/);
  assert.match(js, /criteriaById\.get\('token-config-parity'\)/);
  assert.match(js, /\['wallet', 'grinder', 'token', 'pool-model', 'funding', 'execution', 'recovery'\]/);
  assert.match(js, /function renderClassicRetirementProofRail\(retirementGate = \{\}\)/);
  assert.match(js, /Classic retirement proof path/);
  assert.match(js, /'classic-comparison': 'Classic artifact'/);
  assert.match(js, /renderClassicRetirementProofRail\(retirementGate\)/);
  assert.match(js, /Token fields are valid; stage the launch plan through the local API before replacing Classic token creation/);
  assert.match(js, /const chartRendererEvidence = Boolean\(typeof renderV2TokenomicsDonutSvg === 'function' && typeof liquidityDepthRows === 'function'\)/);
  assert.match(js, /const V2_VIEWPORT_SMOKE_REQUIRED_ASSETS = Object\.freeze\(\['index\.html', 'styles\.css', 'api-client\.js', 'app\.js'\]\)/);
  assert.match(js, /const V2_VIEWPORT_SMOKE_REQUIRED_CHECKS = Object\.freeze\(\[/);
  assert.match(js, /function validatedLocalViewportSmokeProof\(\)/);
  assert.match(js, /proof\.passed !== true \|\| proof\.state !== 'valid'/);
  assert.match(js, /proof\.artifactVersion !== 1 \|\| proof\.kind !== 'trebuchet-v2-viewport-smoke'/);
  assert.match(js, /V2_VIEWPORT_SMOKE_REQUIRED_ASSETS\.every/);
  assert.match(js, /V2_VIEWPORT_SMOKE_REQUIRED_CHECKS\.every/);
  assert.match(js, /fundingMeter/);
  assert.match(js, /\['desktop', 'mobile'\]\.every/);
  assert.match(js, /const viewportSmokeProof = validatedLocalViewportSmokeProof\(\)/);
  assert.match(js, /const viewportSmokeApiConnected = state\.apiStatus === 'connected'/);
  assert.match(js, /const viewportSmokeEvidence = viewportSmokeApiConnected && Boolean\(viewportSmokeProof\)/);
  assert.match(js, /Connect the local app to verify viewport smoke proof against current v2 assets/);
  assert.match(js, /const viewportSmokeStatus = state\.viewportSmoke \|\| proof\?\.viewportSmoke \|\| proof\?\.reportParity\?\.viewportSmoke \|\| null/);
  assert.match(js, /state\.viewportSmoke = boot\.viewportSmoke \|\| null/);
  assert.match(js, /Run `npm run test:v2:viewport` to generate desktop\/mobile viewport-smoke proof/);
  assert.match(apiClientJs, /\/api\/v2\/viewport-smoke-proof/);
  assert.match(apiClientJs, /normalizeViewportSmokeProof/);
  assert.match(apiClientJs, /viewportSmoke,/);
  assert.match(viewportSmokeJs, /viewport-smoke-proof\.json/);
  assert.match(viewportSmokeJs, /const requiredChecks = \[/);
  assert.match(viewportSmokeJs, /requiredChecks,/);
  assert.match(viewportSmokeJs, /crypto\.createHash\('sha256'\)/);
  assert.match(viewportSmokeJs, /await fs\.rm\(proofPath, \{ force: true \}\)/);
  assert.match(viewportSmokeJs, /await fs\.writeFile\(proofPath/);
  assert.match(js, /const topologyIssues = typeof customQuoteSafetySummary === 'function'/);
  assert.match(js, /function topologyAllocationIssues\(topology = \{\}\)/);
  assert.match(js, /Pool rows add to \$\{rowTotalPoolPercent\.toFixed\(2\)\}%/);
  assert.match(js, /Pools, preallocation, and airdrop reserve \$\{supplyUsed\.toFixed\(2\)\}% of supply/);
  assert.match(js, /function launchPlanConfigFingerprint\(config = currentLaunchConfig\(\)\)/);
  assert.match(js, /function launchPlanWalletFingerprint\(walletPublicKey\)/);
  assert.match(js, /function stampLaunchPlanConfigFingerprint\(plan, config = currentLaunchConfig\(\), walletPublicKey = selectedLaunchWalletPublicKey\(\)\)/);
  assert.match(js, /const rawPlan = plan \|\| fallbackLaunchPlan\(\)/);
  assert.match(js, /rawPlan\?\.source === 'local-api'/);
  assert.doesNotMatch(js, /const effectivePlan = stampLaunchPlanConfigFingerprint\(plan \|\| fallbackLaunchPlan\(\), config\)/);
  assert.match(js, /const V2_REQUIRED_LAUNCH_PLAN_OPERATION_IDS = Object\.freeze/);
  assert.match(js, /'v2-wallet-and-ca'/);
  assert.match(js, /'v2-report-sweep'/);
  assert.match(js, /function launchPlanOperationSequenceStatus\(operations = \[\]\)/);
  assert.match(js, /function localApiLaunchPlanStatus\(plan = state\.launchPlan, config = currentLaunchConfig\(\)\)/);
  assert.match(js, /v2LaunchConfigFingerprint: launchPlanConfigFingerprint\(config\)/);
  assert.match(js, /v2LaunchWalletFingerprint: launchPlanWalletFingerprint\(walletPublicKey\)/);
  assert.doesNotMatch(js, /plan\?\.v2LaunchWalletFingerprint \|\| plan\?\.walletPublicKey/);
  assert.match(js, /operation\?\.kind === 'local-wallet-operation'/);
  assert.match(js, /operation\?\.source === 'v2-launch-plan'/);
  assert.match(js, /operation\?\.simulation\?\.decoded === true/);
  assert.match(js, /const operationSequenceEvidence = Boolean\(decodedOperationEvidence && sequence\.ready\)/);
  assert.match(js, /const matchesWallet = Boolean\(/);
  assert.match(js, /missingOperationIds: sequence\.missingOperationIds/);
  assert.match(js, /function localApiLaunchPlanStaleReason\(planStatus = localApiLaunchPlanStatus\(\)\)/);
  assert.match(js, /function localApiLaunchPlanIncompleteReason\(planStatus = localApiLaunchPlanStatus\(\)\)/);
  assert.match(js, /const localApiLaunchPlan = localApiLaunchPlanStatus\(state\.launchPlan, config\)/);
  assert.match(js, /const localApiLaunchPlanEvidence = localApiLaunchPlan\.ready/);
  assert.match(js, /const chartModelEvidence = Boolean\(hasCompletedLiveProof \|\| localApiLaunchPlanEvidence\)/);
  assert.match(js, /Chart renderers and viewport smoke are ready; stage the launch plan through the local API so charts are bound to the executable token\/pool model/);
  assert.match(js, /Chart renderers are wired against the executable launch model/);
  assert.match(js, /const poolConfigEvidence = Boolean\(\s*plannedPools\.length\s*&& poolBlockerCount === 0\s*&& \(hasCompletedLiveProof \|\| localApiLaunchPlanEvidence\)\s*\)/);
  assert.match(js, /localApiLaunchPlanStaleReason\(localApiLaunchPlan\)/);
  assert.match(js, /it is missing required operation/);
  assert.match(js, /Stage the launch plan through the local API before replacing Classic pool configuration/);
  assert.match(js, /if \(localApiLaunchPlanStatus\(\)\.ready\) return \{ label: 'Model', className: 'warn' \}/);
  assert.doesNotMatch(js, /\|\| config\?\.poolTopology\s*\)/);
  assert.match(js, /function classicFundingEstimateFingerprint\(config = currentLaunchConfig\(\)\)/);
  assert.match(js, /function stampClassicFundingEstimate\(estimate, config = currentLaunchConfig\(\)\)/);
  assert.match(js, /function fundingEstimateAllocationsForTopology\(topology = \{\}\)/);
  assert.match(js, /allocations: stableFundingFingerprintValue\(fundingEstimateAllocationsForTopology\(topology\)\)/);
  assert.doesNotMatch(js, /allocations: stableFundingFingerprintValue\(Array\.isArray\(topology\.allocations\)/);
  assert.match(js, /v2FundingFingerprint: classicFundingEstimateFingerprint\(config\)/);
  assert.match(js, /const fundingEstimateStatus = classicFundingEstimateStatus\(config\)/);
  assert.match(js, /const fundingEstimateEvidence = fundingEstimateStatus\.matchesConfig/);
  assert.match(js, /const estimate = fundingEstimateStatus\.matchesConfig \? state\.classicFundingEstimate : null/);
  assert.match(js, /Funding estimate is stale; rerun before execution/);
  assert.match(js, /function selectedWalletDetailedBalance\(\)/);
  assert.match(js, /const detailedBalance = selectedWalletDetailedBalance\(\)/);
  assert.doesNotMatch(js, /const walletSol = Number\(selectedWallet\?\.balanceSol\)/);
  assert.match(js, /walletPublicKey: selectedLaunchWalletPublicKey\(\)/);
  assert.match(js, /const fundingBalanceEvidence = state\.apiStatus === 'connected' && funding\.hasWalletBalance === true && funding\.walletBalanceFresh === true/);
  assert.match(js, /Selected Trebuchet launch-wallet balance is stale; wait for the local app refresh or click Check balance/);
  assert.match(js, /function quoteAcquireFingerprint\(config = currentLaunchConfig\(\), walletPublicKey = selectedLaunchWalletPublicKey\(\)\)/);
  assert.match(js, /function quoteAcquireResultMatchesRoute\(result, route\)/);
  assert.match(js, /function quoteAcquireSuccessEvidence\(routes, job\)/);
  assert.match(js, /function quoteAcquireStatus\(config = currentLaunchConfig\(\)\)/);
  assert.match(js, /v2QuoteAcquireFingerprint/);
  assert.match(js, /const successEvidence = quoteAcquireSuccessEvidence\(routes, job\)/);
  assert.match(js, /&& successEvidence\s*&& Number\(progress\.completed/);
  assert.match(js, /return status\.ready \? \{ label: 'Done', className: '' \} : \{ label: 'Verify', className: 'warn' \}/);
  assert.match(js, /const quoteAcquireEvidence = quoteStatus\.ready/);
  assert.match(js, /Quote acquire job is stale for the selected wallet or current launch model/);
  assert.match(js, /id: 'funding-and-quote'/);
  assert.match(js, /criteriaById\.get\('funding-and-quote'\)/);
  assert.match(js, /const fundingEstimateReady = fundingEstimateStatus\.matchesConfig/);
  assert.match(js, /const fundingBalanceReady = state\.apiStatus === 'connected' && funding\.hasWalletBalance === true && funding\.walletBalanceFresh === true/);
  assert.match(js, /const quoteAcquireReady = quoteAcquireStatus\(config\)\.ready/);
  assert.doesNotMatch(js, /state: state\.classicFundingEstimate \? 'pass' : 'warn'/);
  assert.doesNotMatch(js, /phase\.id === 'funding'\) return state\.classicFundingEstimate \? 'pass' : 'warn'/);
  assert.match(js, /const proofJournalEvidence = Boolean\(proof\?\.journalId\)/);
  assert.match(js, /const proofBackedPreterminalJournalEvidence = Boolean\(/);
  assert.match(js, /proofJournalEvidence\s*&& matchingLocalJournal/);
  assert.match(js, /&& !isTerminalJournal\(matchingLocalJournal\)/);
  assert.match(js, /&& journalHasRecoveryPlanningEvidence\(matchingLocalJournal\)/);
  assert.match(js, /Matching launch journal is terminal, but the proof is missing terminal final-sweep evidence/);
  assert.match(js, /lacks pool-plan or checkpoint evidence needed to prove resume safety/);
  assert.match(js, /function loadedRecoveryJournalEvidence\(\)/);
  assert.match(js, /function journalHasRecoveryPlanningEvidence\(journal = \{\}\)/);
  assert.match(js, /journalUnsafePoolEvents\(journal, priorResults\)/);
  assert.match(js, /const localRecoveryJournal = loadedRecoveryJournalEvidence\(\)/);
  assert.match(js, /const localJournalEvidence = localRecoveryJournal\.count > 0/);
  assert.match(js, /function recoveryResultHasResumeEvidence\(result = state\.lastRecoveryResult\)/);
  assert.match(js, /function recoveryResultHasDurableCheckpointRow\(row = \{\}\)/);
  assert.match(js, /row\.phase1Complete === true/);
  assert.match(js, /recoveryResultHasOpenedPositionEvidence\(row\)/);
  assert.match(js, /const recoveryResultJournalEvidence = recoveryResultHasResumeEvidence\(\)/);
  assert.match(js, /Local launch history is loaded, but no active or failed journal exercises resume safety yet/);
  assert.match(js, /Local API is connected, but no launch journal or proof has exercised resume safety yet/);
  assert.doesNotMatch(js, /state\.recovery\.journalCount > 0 \|\| state\.apiStatus === 'connected' \|\| proof\?\.journalId/);
  assert.match(js, /hasWalletBalance/);
  assert.match(js, /const quoteAcquireReady = quoteStatus\.ready/);
  assert.match(js, /const fundingBalanceKnown = state\.demoActive \|\| \(state\.apiStatus === 'connected' && funding\.hasWalletBalance === true && funding\.walletBalanceFresh === true\)/);
  assert.match(js, /&& quoteAcquireReady\s*\n\s*&& manualReady/);
  assert.match(js, /\|\| \(fundingEstimateStatus\.hasEstimate && \(!fundingEstimateStatus\.matchesConfig \|\| !fundingBalanceKnown \|\| !fundingSolReady \|\| !quoteAcquireReady \|\| !manualReady\)\)/);
  assert.match(js, /quote acquire route\$\{quoteRoutes\.length === 1 \? '' : 's'\} still need successful completion/);
  assert.match(js, /const fundingSolReady = Number\(funding\.missingSol \|\| 0\) <= 0\.001/);
  assert.match(js, /if \(phase\.id === 'pools'\) return topologyAllocationIssues\(config\.poolTopology\)\.length \? 'danger' : 'pass'/);
  assert.match(js, /Selected launch-wallet balance is stale; wait for the local app refresh or click Check balance/);
  assert.match(js, /Selected launch-wallet balance has not been verified yet/);
  assert.match(js, /Launch wallet is short \$\{funding\.missingSol\.toFixed\(3\)\} SOL/);
  assert.match(js, /liveRunProgressContext/);
  assert.match(js, /runProgressContext/);
  assert.match(js, /const context = runProgressContext\(\)/);
  assert.match(js, /isLive\s*\?/);
  assert.match(js, /Live checkpoint blocked/);
  assert.match(js, /v2 is watching launch proof and readiness evidence/);
  assert.match(js, /Source<\/span><strong>\$\{escapeHtml\(context\.source\)\}/);
  assert.match(js, /readinessPhaseState/);
  assert.match(js, /renderExecutionLedger/);
  assert.match(js, /startExecutionLedgerEntry/);
  assert.match(js, /finishExecutionLedgerEntry/);
  assert.match(js, /ledgerObservationFromExecution/);
  assert.match(js, /observedExecutionSpendSummary/);
  assert.match(js, /balanceDeltaSol/);
  assert.match(js, /observedOutflowSol/);
  assert.match(js, /executionLedgerDescriptor/);
  assert.match(js, /persistExecutionLedger/);
  assert.match(js, /restoreExecutionLedger/);
  assert.match(js, /normalizeExecutionLedgerEntry/);
  assert.match(js, /EXECUTION_LEDGER_STORAGE_KEY/);
  assert.match(js, /LAUNCH_PROOF_STORAGE_KEY/);
  assert.match(js, /LAUNCH_PROOF_STORAGE_LIMIT/);
  assert.match(js, /LAUNCH_PROOF_IMPORT_LIMIT/);
  assert.match(js, /normalizeStoredLaunchProof/);
  assert.match(js, /persistLaunchProof/);
  assert.match(js, /restoreLaunchProof/);
  assert.match(js, /clearStoredLaunchProof/);
  assert.match(js, /clearLaunchProof/);
  assert.match(js, /validateProofFile/);
  assert.match(js, /readFileAsText/);
  assert.match(js, /proofFromImportedPayload/);
  assert.match(js, /restoreImportedProofComparison/);
  assert.match(js, /loadV2ProofFile/);
  assert.match(js, /requestV2ProofImport/);
  assert.match(js, /rawProof\.source === 'demo-run'/);
  assert.match(js, /CLASSIC_REPORT_COMPARISON_STORAGE_KEY/);
  assert.match(js, /CLASSIC_ARTIFACT_IMPORT_LIMIT/);
  assert.match(js, /persistClassicReportComparison/);
  assert.match(js, /restoreClassicReportComparison/);
  assert.match(js, /normalizeClassicReportComparison/);
  assert.match(js, /validateClassicArtifactFile/);
  assert.match(js, /loadClassicArtifactFile/);
  assert.match(js, /requestClassicArtifactImport/);
  assert.match(js, /downloadTextFile/);
  assert.match(js, /localStorage/);
  assert.match(js, /Interrupted before completion/);
  assert.match(js, /executionLedgerAttemptLabel/);
  assert.match(js, /renderHistoryExecutionAudit/);
  assert.match(js, /Execution ledger/);
  assert.match(js, /Latest guarded operations/);
  assert.match(js, /Classic proof trail/);
  assert.match(js, /No guarded operations yet/);
  assert.match(js, /Guarded execution audit/);
  assert.match(js, /Observed SOL/);
  assert.match(js, /clear-execution-audit/);
  assert.match(js, /Live launch progress/);
  assert.match(js, /Wallet SOL/);
  assert.match(js, /Planned SOL/);
  assert.match(js, /Missing SOL/);
  assert.match(js, /Observed spend/);
  assert.match(js, /Acquired quotes/);
  assert.match(js, /vanityCandidateDetail/);
  assert.match(js, /vanityAvailabilityMeta/);
  assert.match(js, /vanityPatternEstimate/);
  assert.match(js, /vanityEstimateSummary/);
  assert.match(js, /VANITY_BASE58_ALPHABET/);
  assert.match(js, /VANITY_PLANNING_RATE/);
  assert.match(js, /Invalid Base58/);
  assert.match(js, /Expected/);
  assert.match(js, /50% by/);
  assert.match(js, /95% by/);
  assert.match(js, /vanityProgressStats/);
  assert.match(js, /removeVanityCandidateByPublicKey/);
  assert.match(js, /pruneHiddenVanityCandidates/);
  assert.match(js, /remove-selected-vanity/);
  assert.match(js, /prune-hidden-vanity/);
  assert.match(js, /Remove selected/);
  assert.match(js, /Prune hidden/);
  assert.match(js, /Native grinder ready/);
  assert.match(js, /Grinder unavailable/);
  assert.match(js, /Unlock to grind/);
  assert.match(js, /const unlocked = await unlockSecretPin\(\{ reason: 'vanity' \}\)/);
  assert.match(js, /state\.vanityInputError/);
  assert.match(js, /renderTokenLogoPreview/);
  assert.match(js, /selectTokenLogo/);
  assert.match(js, /validateLogoFile/);
  assert.match(js, /compressLogoFile/);
  assert.match(js, /logoCanvasBlob/);
  assert.match(js, /CLASSIC_LOGO_MAX_BYTES/);
  assert.match(js, /CLASSIC_LOGO_MAX_DIMENSION/);
  assert.match(js, /LOGO_SOURCE_MAX_BYTES/);
  assert.match(js, /AUTO-COMPRESSED/);
  assert.match(js, /Token logo auto-compressed and attached/);
  assert.match(js, /Logo must be a PNG or JPG image/);
  assert.match(html, /id="tokenLogoFile" type="file" accept="image\/png,image\/jpeg"/);
  assert.match(html, /Token logo \/ auto-compress/);
  assert.match(html, /class="logo-upload-control" for="tokenLogoFile"/);
  assert.match(html, /class="logo-upload-command"/);
  assert.match(html, /PNG\/JPG · ≤10MB/);
  assert.match(css, /\.logo-upload-control/);
  assert.match(css, /\.logo-upload-command/);
  assert.match(js, /enhanceNumberSteppers/);
  assert.match(js, /stepNumberInput/);
  assert.match(js, /dataset\.action = 'step-number'/);
  assert.match(js, /input\.stepUp\(\)/);
  assert.match(js, /input\.stepDown\(\)/);
  assert.match(css, /\.number-stepper/);
  assert.match(css, /\.number-stepper-button/);
  assert.match(js, /clear-token-logo/);
  assert.match(js, /renderClassicBridge/);
  assert.match(js, /renderLiveOpsPanel/);
  assert.match(js, /renderActivityLogDrawer/);
  assert.match(js, /journalResumePlan/);
  assert.match(js, /journalUnsafePoolEvents/);
  assert.match(js, /activityLogEntries/);
  assert.match(js, /airdropSnapshots/);
  assert.match(js, /airdropProgressLogLabel/);
  assert.match(js, /\{ id: 'airdrop', label: 'Airdrop'/);
  assert.match(js, /if \(filter === 'airdrop'\) return entry\.type === 'airdrop'/);
  assert.match(js, /\['all', 'progress', 'airdrop', 'log', 'warn', 'error'\]\.includes\(nextFilter\)/);
  assert.match(js, /rememberAirdropProgress\(value\)/);
  assert.match(js, /state\.liveOps\.airdropSnapshots = \[\]/);
  assert.match(js, /pollLiveOps/);
  assert.match(js, /renderQuoteAcquirePanel/);
  assert.match(js, /renderManualPrefundPanel/);
  assert.match(js, /renderCustomQuoteInfoPanel/);
  assert.match(js, /resolveCustomQuoteToken/);
  assert.match(js, /customQuoteSafetySummary/);
  assert.match(js, /DEFAULT_CLMM_FEE_TIERS/);
  assert.match(js, /normalizeClmmFeeTiers/);
  assert.match(js, /feeTierOptionsHtml/);
  assert.match(js, /resolve-custom-quote/);
  assert.match(js, /Verify quote/);
  assert.match(js, /freezeAuthorityBlock/);
  assert.match(js, /renderRpcSettingsPanel/);
  assert.match(js, /applyRpcConfig/);
  assert.match(js, /testRpcEndpoint/);
  assert.match(js, /addRpcEndpoint/);
  assert.match(js, /selectRpcEndpoint/);
  assert.match(js, /removeRpcEndpoint/);
  assert.match(js, /safeRpcUrl/);
  assert.match(js, /isPublicRpcUrl/);
  assert.match(js, /solana\.public-rpc\.com/);
  assert.match(js, /renderCancelRefundPanel/);
  assert.match(js, /cancelRefundLaunch/);
  assert.match(js, /cancel-refund-launch/);
  assert.match(js, /Classic cancel\/refund/);
  assert.match(js, /Cancel & Refund/);
  assert.match(js, /kind: 'cancel-refund'/);
  assert.match(js, /quoteManualPrefundItems/);
  assert.match(js, /manualPrefundStatus/);
  assert.match(js, /refreshManualPrefundBalance/);
  assert.match(js, /startQuoteAcquire/);
  assert.match(js, /Funding estimate is stale for this launch model; rerun it before acquiring quote tokens/);
  assert.match(js, /data-action="\$\{hasCurrentEstimate \? 'start-quote-acquire' : 'estimate-funding'\}"/);
  assert.match(js, /notify\(fundingEstimateStatus\.stale \? 'Rerun funding estimate first' : 'Run funding estimate first'\)/);
  assert.match(js, /if \(!classicFundingEstimateStatus\(currentLaunchConfig\(\)\)\.matchesConfig \|\| !items\.length\) return ''/);
  assert.match(js, /pollQuoteAcquire/);
  assert.match(js, /quotePoolGuidanceItems/);
  assert.match(js, /renderQuotePoolGuidance/);
  assert.match(js, /renderPoolEditorPanel/);
  assert.match(js, /renderAirdropPanel/);
  assert.match(js, /computeAirdropBudget/);
  assert.match(js, /computeAirdropExecutionCostSol/);
  assert.match(js, /fitAirdropBudget/);
  assert.match(js, /renderReportPanel/);
  assert.match(js, /renderFinalizationPanel/);
  assert.match(js, /finalizationNoticeRows/);
  assert.match(js, /buildClassicRetirementGate\(proof, reportParityAudit, config\)/);
  assert.match(js, /buildV2FieldVerification\(\{\s*proof,\s*config,\s*audit: reportParityAudit,\s*retirementGate,/);
  assert.match(js, /fieldHandoffRows/);
  assert.match(js, /field-handoff-list/);
  assert.match(js, /Report publish failed:/);
  assert.match(js, /Click Publish report to retry/);
  assert.match(js, /Download a fresh final dossier so the artifact carries the final sweep hash/);
  assert.match(css, /recovery-sweep-result/);
  assert.match(css, /recovery-sweep-grid/);
  assert.match(css, /recovery-wizard-panel/);
  assert.match(css, /recovery-wizard-steps/);
  assert.match(css, /recovery-wizard-screen/);
  assert.match(css, /recovery-wizard-actions/);
  assert.match(css, /recovery-guide/);
  assert.match(css, /recovery-guide-head/);
  assert.match(css, /report-parity-audit/);
  assert.match(css, /report-parity-list/);
  assert.match(css, /classic-compare-panel/);
  assert.match(css, /classic-compare-list/);
  assert.match(css, /field-handoff-list/);
  assert.match(css, /parity-gate/);
  assert.match(css, /finalize-notices/);
  assert.match(js, /proofExplorerItems/);
  assert.match(js, /buildProofShareSummary/);
  assert.match(js, /buildV2LaunchReportHtml/);
  assert.match(js, /buildV2LaunchReportData/);
  assert.match(js, /launchConfig: exportableLaunchConfigSnapshot\(config\),/);
  assert.match(js, /destinationWallet: proofEffectiveDestination\(proof, config\)/);
  assert.match(js, /destinationWallet: terminalTransferDestination \|\| proof\?\.destinationWallet \|\| config\?\.poolTopology\?\.sweepDestination \|\| null/);
  assert.match(js, /const finalDestination = proofEffectiveDestination\(proof, config\)/);
  assert.match(js, /function finalSweepProofState\(transfer = null\)/);
  assert.match(js, /finalSweep: \{/);
  assert.match(js, /status: terminal \? 'terminal' : hasRecord \? 'needs-proof' : 'not-recorded'/);
  assert.match(js, /renderV2ReportFactRow\('Sweep status', finalSweep\.label\)/);
  assert.match(js, /renderV2ReportFactRow\('Wallet empty'/);
  assert.match(js, /renderV2ReportAddressRow\('Planned sweep destination', finalDestination\)/);
  assert.match(js, /`Destination: \$\{proofEffectiveDestination\(proof, config\) \|\| 'pending'\}`/);
  assert.match(js, /quoteSymbol: pool\.quoteSymbol \|\| pool\.quoteSymbolOverride \|\| result\?\.quoteSymbol \|\| pool\.quoteToken \|\| null/);
  assert.match(js, /v2ClassicReportCss/);
  assert.match(js, /v2ClassicReportScript/);
  assert.match(js, /renderV2ReportStatusBanner/);
  assert.match(js, /renderV2ReportDemoBanner/);
  assert.match(js, /v2ReportLockSummary/);
  assert.match(js, /renderV2ReportAddressRow/);
  assert.match(js, /renderV2ReportPositionCard/);
  assert.match(js, /buildV2ReportTokenomics/);
  assert.match(js, /function v2ReportPoolTopology/);
  assert.match(js, /const reportPoolTopology = v2ReportPoolTopology\(proof, config\)/);
  assert.match(js, /poolPlan\?\.airdropPlan/);
  assert.match(js, /buildV2ReportPoolSections/);
  assert.match(js, /buildV2ReportPoolPlan/);
  assert.match(js, /buildV2ReportAirdropAudit/);
  assert.match(js, /buildV2ReportRecoveryAudit/);
  assert.match(js, /buildV2ReportRecoverySection/);
  assert.match(js, /buildV2ReportParityAudit/);
  assert.match(js, /buildClassicRetirementGate/);
  assert.match(js, /buildV2FieldVerification/);
  assert.match(js, /buildV2ReportFieldVerificationSection/);
  assert.match(js, /buildV2ReplacementCriteriaAudit/);
  assert.match(js, /renderReportParityAuditPanel/);
  assert.match(js, /buildV2ReportParityAuditSection/);
  assert.match(js, /compareClassicReportArtifact/);
  assert.match(js, /artifactAuthorityFlag/);
  assert.match(js, /authorityCount/);
  assert.match(js, /classicComparisonStatusFromCounts/);
  assert.match(js, /normalizeClassicReportArtifact/);
  assert.match(js, /classicArtifactSourceKind/);
  assert.match(js, /normalizeComparisonPool/);
  assert.match(js, /comparisonPoolFingerprint/);
  assert.match(js, /comparisonPoolParameterSummary/);
  assert.match(js, /comparisonPositionsFromPools/);
  assert.match(js, /comparisonPositionFingerprint/);
  assert.match(js, /classicComparisonPoolRows/);
  assert.match(js, /comparisonMatchedValues/);
  assert.match(js, /collectArtifactSignatures/);
  assert.match(js, /comparisonAirdropFingerprint/);
  assert.match(js, /comparisonMatchedAirdropWallets/);
  assert.match(js, /comparisonMatchedAirdropTxs/);
  assert.match(js, /comparisonAirdropNeedsFullRows/);
  assert.match(js, /classicComparisonProofFingerprint/);
  assert.match(js, /launchProofFingerprint/);
  assert.match(js, /classicComparisonMatchesProof/);
  assert.match(js, /classicComparisonRequiredEvidence/);
  assert.match(js, /Classic comparison is too thin/);
  assert.match(js, /structuredEvidence/);
  assert.match(js, /Classic comparison is missing structured Classic report evidence/);
  assert.match(js, /required Classic evidence rows are passing/);
  assert.match(js, /reportPublishMatchesProof/);
  assert.match(js, /terminalSweepEvidenceHashForProof/);
  assert.match(js, /reportArtifactMatchesTerminalSweep/);
  assert.match(js, /localDossierHasEvidence/);
  assert.match(js, /function localDossierFilenameMatchesKind\(filename, kind\)/);
  assert.match(js, /localDossierFilenameMatchesKind\(filename, kind\)/);
  assert.match(js, /importedLocalDossierEvidence/);
  assert.match(js, /currentLocalDossier/);
  assert.match(js, /currentReportArtifact/);
  assert.match(js, /proofWithLocalDossierEvidence/);
  assert.match(js, /mergeLaunchProofEvidence/);
  assert.match(js, /sameLaunchProofIdentity/);
  assert.match(js, /mergeProofAirdropEvidence/);
  assert.match(js, /proofAirdropHasDelivery/);
  assert.match(js, /state\.launchProof = mergeLaunchProofEvidence\(state\.launchProof, rawProof\)/);
  assert.match(js, /reportPublishFinalizationIssue\(existing\.reportPublish, merged, mergedConfig\)/);
  assert.match(js, /reportPublishFinalizationIssue\(merged\.reportPublish, merged, mergedConfig\)/);
  assert.match(js, /localDossierFinalizationIssue\(existing\.localDossier, merged, mergedConfig\)/);
  assert.match(js, /if \(!proofAirdropHasDelivery\(incoming\) && proofAirdropHasDelivery\(existing\)\)/);
  assert.match(js, /currentReportPublish/);
  assert.match(js, /staleReportPublishForProof/);
  assert.match(js, /transferHasWalletEmptyFinalSweepEvidence\(proof\?\.transfer\)/);
  assert.match(js, /reportArtifactMatchesTerminalSweep\(reportArtifactRecord, proof\)/);
  assert.match(js, /return \{ label: 'Final proof', className: 'warn' \}/);
  assert.match(js, /return \{ label: 'Needs sweep', className: 'warn' \}/);
  assert.match(js, /return \{ label: 'Proof ready', className: '' \}/);
  assert.doesNotMatch(js, /if \(reportArtifact \|\| report\?\.status === 'done'\) return \{ label: 'Proof ready'/);
  assert.match(js, /proofFingerprint/);
  assert.match(js, /runClassicArtifactComparison/);
  assert.match(js, /reportParityAudit/);
  assert.match(js, /classicRetirementGate/);
  assert.match(js, /classicReportComparison/);
  assert.match(js, /Classic report parity audit/);
  assert.match(js, /Classic artifact compare/);
  assert.match(js, /Live classic comparison/);
  assert.match(js, /artifact-source/);
  assert.match(js, /v2 proof or dossier/);
  assert.match(js, /Loaded artifact is v2-generated/);
  assert.match(js, /Comparison is for another v2 proof/);
  assert.match(js, /Classic comparison belongs to another v2 proof/);
  assert.match(js, /Report artifact belongs to another v2 proof/);
  assert.match(js, /'launch-wallet'/);
  assert.match(js, /Authority posture/);
  assert.match(js, /Pool quote mints/);
  assert.match(js, /Pool parameters/);
  assert.match(js, /Pool create transactions/);
  assert.match(js, /Position NFTs/);
  assert.match(js, /Fee Key NFTs/);
  assert.match(js, /Position transactions/);
  assert.match(js, /Airdrop delivery/);
  assert.match(js, /Airdrop recipients/);
  assert.match(js, /Airdrop transactions/);
  assert.match(js, /Classic retirement gate/);
  assert.match(js, /Classic retirement ready/);
  assert.match(js, /retirement checks passing/);
  assert.match(js, /Replacement criteria/);
  assert.match(js, /replacementCriteria/);
  assert.match(js, /criteriaPassCount/);
  assert.match(js, /proofFingerprint: launchProofFingerprint\(proof, config\)/);
  assert.match(js, /function reportParityAuditMatchesProof/);
  assert.match(js, /audit = reportParityAuditMatchesProof\(audit, proof, config\)/);
  assert.match(js, /demoRunHasCompletedReadiness/);
  assert.match(js, /terminal readiness proof/);
  assert.match(js, /completion\.terminalSweepEvidence === true/);
  assert.match(js, /demo-end-to-end/);
  assert.match(js, /wallet-lifecycle/);
  assert.match(js, /vanity-options/);
  assert.match(js, /charts-and-viewport/);
  assert.match(js, /pool-config-parity/);
  assert.match(js, /held-reserve-backing/);
  assert.match(js, /run-and-resume/);
  assert.match(js, /sweep-report-proof/);
  assert.match(js, /classic-artifact-comparison/);
  assert.match(js, /proof-audit/);
  assert.match(js, /npm run test:v2:viewport/);
  assert.match(js, /replacementCriteriaById/);
  assert.match(js, /parityFeatureFromCriterion/);
  assert.match(js, /Replacement evidence is not available for this feature yet/);
  assert.doesNotMatch(js, /state: feature\.real \? 'pass' : feature\.preview \? 'warn' : 'danger'/);
  assert.doesNotMatch(js, /badge: feature\.real \? 'Real' : feature\.preview \? 'Bridge' : 'Gap'/);
  assert.match(js, /renderReplacementCriteriaStrip/);
  assert.match(js, /criteria-chip/);
  assert.match(js, /aria-label="Replacement criteria"/);
  assert.match(js, /criteriaById\.get\('wallet-lifecycle'\)/);
  assert.match(js, /criteriaById\.get\('vanity-options'\)/);
  assert.match(js, /criteriaById\.get\('pool-config-parity'\)/);
  assert.match(js, /criteriaById\.get\('charts-and-viewport'\)/);
  assert.match(js, /criteriaById\.get\('held-reserve-backing'\)/);
  assert.match(js, /criteriaById\.get\('run-and-resume'\)/);
  assert.match(js, /criteriaById\.get\('sweep-report-proof'\)/);
  assert.doesNotMatch(js, /const hasLocalRecovery = state\.apiStatus === 'connected'/);
  assert.doesNotMatch(js, /const available = state\.apiStatus === 'connected' && state\.vanityAvailable/);
  assert.match(js, /function renderParityPanel\(\) \{\s*const proof = currentLaunchProof\(\);\s*const config = proofConfigForFingerprint\(proof, currentLaunchConfig\(\)\);\s*const reportAudit = buildV2ReportParityAudit\(proof, config\);\s*const retirementGate = buildClassicRetirementGate\(proof, reportAudit, config\);/);
  assert.match(js, /liveProofPassed/);
  assert.match(js, /Live proof/);
  assert.match(js, /Demo only/);
  assert.match(js, /needs proof/);
  assert.match(js, /Demo proof proves wiring only/);
  assert.match(js, /proof fields missing/);
  assert.match(js, /journals remain the source of truth/);
  assert.match(js, /renderFundingWalletHint/);
  assert.match(js, /detectFundingWallet/);
  assert.match(js, /applyFundingWalletAsSweepDestination/);
  assert.match(js, /function applyFundingWalletAsSweepDestination\(\)[\s\S]*invalidateClassicOutputs\(\)/);
  assert.match(js, /getConnectedSolflareWallet/);
  assert.match(js, /applySolflareDestinationWallet/);
  assert.match(js, /runFullLaunch/);
  assert.match(js, /renderParityPanel/);
});

test('v2 auto-compresses oversized logos into the Classic upload envelope', async () => {
  const start = js.indexOf('function loadLogoImage');
  const end = js.indexOf('\nfunction validateProofFile', start);
  assert.ok(start >= 0 && end > start, 'logo optimizer should be extractable');

  class FakeFile {
    constructor(parts, name, options = {}) {
      this.size = parts.reduce((total, part) => total + Number(part?.size || 0), 0);
      this.name = name;
      this.type = options.type || '';
      this.lastModified = options.lastModified || 0;
    }
  }

  const sandbox = {
    Date,
    File: FakeFile,
    CLASSIC_LOGO_MAX_BYTES: 100 * 1024,
    CLASSIC_LOGO_MAX_DIMENSION: 1024,
    CLASSIC_LOGO_MIN_DIMENSION: 64,
    LOGO_SOURCE_MAX_BYTES: 10 * 1024 * 1024,
    LOGO_SOURCE_MAX_DIMENSION: 8192,
    LOGO_JPEG_QUALITY_STEPS: [0.9, 0.82, 0.74, 0.66, 0.58, 0.5, 0.42],
    nextImageWidth: 1400,
    nextImageHeight: 1400,
    URL: {
      createObjectURL: () => 'blob:test-logo',
      revokeObjectURL: () => {},
    },
  };
  sandbox.Image = class {
    set src(_value) {
      this.naturalWidth = sandbox.nextImageWidth;
      this.naturalHeight = sandbox.nextImageHeight;
      queueMicrotask(() => this.onload());
    }
  };
  sandbox.document = {
    createElement: (tagName) => {
      assert.equal(tagName, 'canvas');
      return {
        width: 0,
        height: 0,
        getContext: () => ({
          drawImage: () => {},
          imageSmoothingEnabled: false,
          imageSmoothingQuality: 'low',
        }),
        toBlob(callback, mimeType, quality = 1) {
          const encodedSize = Math.ceil(this.width * this.height * 0.45 * quality);
          callback({ size: encodedSize, type: mimeType });
        },
      };
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(
    `${js.slice(start, end)}\nglobalThis.validateLogoFile = validateLogoFile;`,
    sandbox,
    { filename: 'public/v2/app.js logo optimizer harness' },
  );

  const source = new FakeFile([{ size: 2 * 1024 * 1024 }], 'oversized-logo.jpg', {
    type: 'image/jpeg',
    lastModified: 123,
  });
  const optimized = await sandbox.validateLogoFile(source);
  assert.equal(optimized.compressed, true);
  assert.equal(optimized.originalSizeBytes, source.size);
  assert.ok(optimized.file.size <= sandbox.CLASSIC_LOGO_MAX_BYTES);
  assert.ok(optimized.width <= sandbox.CLASSIC_LOGO_MAX_DIMENSION);
  assert.ok(optimized.height <= sandbox.CLASSIC_LOGO_MAX_DIMENSION);
  assert.ok(optimized.width >= sandbox.CLASSIC_LOGO_MIN_DIMENSION);
  assert.ok(optimized.height >= sandbox.CLASSIC_LOGO_MIN_DIMENSION);

  sandbox.nextImageWidth = 512;
  sandbox.nextImageHeight = 512;
  const alreadySafe = new FakeFile([{ size: 48 * 1024 }], 'safe-logo.png', {
    type: 'image/png',
  });
  const untouched = await sandbox.validateLogoFile(alreadySafe);
  assert.equal(untouched.compressed, false);
  assert.equal(untouched.file, alreadySafe);
  assert.equal(untouched.width, 512);
  assert.equal(untouched.height, 512);
});

test('v2 launch-plan fingerprints match the server builder for staged config', () => {
  const harness = loadClassicRetirementGateHarness();
  const config = {
    token: {
      name: 'MoonKit',
      symbol: 'MKT',
      supply: '1,000,000,000',
      description: 'Community token launch',
      logo: {
        name: 'moon.png',
        mimeType: 'image/png',
        sizeBytes: 4096,
      },
    },
    launchSol: 3.5,
    mode: 'guarded',
    vanity: {
      prefix: 'MKT',
      suffix: 'K1T',
      candidateCount: 2,
    },
    poolTopology: {
      targetMarketCapUsd: '250000',
      totalPoolPercent: 80,
      pools: [
        {
          id: 'sol-main',
          quoteToken: 'SOL',
          quoteSymbol: 'SOL',
          supplyPercent: 70,
          ammConfigIndex: 5,
          distribution: [{ sharePercent: 96 }, { sharePercent: 2 }, { sharePercent: 2 }],
          bootstrap: { mode: 'minimal' },
          ladder: { mode: 'simple', bandCount: 5 },
          support: { mode: 'custom', solValue: 0.35, depthPct: 12 },
        },
        {
          id: 'usdc-flywheel',
          quoteToken: 'USDC',
          quoteMint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
          quoteSymbol: 'USDC',
          quoteDecimals: 6,
          supplyPercent: 10,
          distribution: [{ sharePercent: 100 }],
          bootstrap: { mode: 'minimal' },
          ladder: { mode: 'off' },
          support: { mode: 'off' },
        },
      ],
      preallocation: { enabled: true, supplyPercent: 3, source: 'team-reserve' },
      airdrop: { enabled: true, recipientCount: 24, supplyPercent: 2 },
      report: { publish: true },
      sweepDestination: '11111111111111111111111111111115',
    },
    funding: {
      launchSol: 3.5,
      targetMarketCapUsd: '250000',
    },
  };

  assert.equal(harness.launchPlanConfigFingerprint(config), serverLaunchPlanConfigFingerprint(config));
});

test('v2 finalization badge does not call report artifacts ready before terminal sweep evidence', () => {
  const source = js.match(/function finalizationBadge\(proof\) \{[\s\S]*?\n\}\n/)?.[0];
  assert.ok(source, 'finalization badge helper should be extractable');
  const sandbox = {
    state: { reportPublishing: false },
    config: { poolTopology: {} },
    reportArtifact: { record: { id: 'report' } },
    report: null,
    staleReport: null,
    sweepBound: false,
    poolIdentity: false,
    publishEvidence: false,
    currentLaunchConfig: () => sandbox.config,
    proofConfigForFingerprint: (proof, config) => proof?.launchConfig || config || { poolTopology: {} },
    proofHasReportablePoolIdentity: () => sandbox.poolIdentity,
    proofHasReportPublishEvidence: () => sandbox.publishEvidence,
    currentReportArtifact: () => sandbox.reportArtifact,
    staleReportPublishForProof: () => sandbox.staleReport,
    currentReportPublish: () => sandbox.report,
    transferHasWalletEmptyFinalSweepEvidence: (transfer) => transfer?.walletEmpty === true,
    reportArtifactMatchesTerminalSweep: () => sandbox.sweepBound,
  };
  vm.runInNewContext(
    `${source}\nglobalThis.finalizationBadge = finalizationBadge;`,
    sandbox,
    { filename: 'public/v2/app.js finalization badge harness' },
  );
  const proof = {
    token: { mint: 'Mint11111111111111111111111111111111111' },
    liquidity: { poolCount: 1 },
  };

  assert.equal(sandbox.finalizationBadge(proof).label, 'Needs pools');
  sandbox.poolIdentity = true;
  assert.equal(sandbox.finalizationBadge(proof).label, 'Needs proof');
  sandbox.publishEvidence = true;
  assert.equal(sandbox.finalizationBadge(proof).label, 'Needs sweep');
  assert.equal(sandbox.finalizationBadge(proof).className, 'warn');
  assert.equal(sandbox.finalizationBadge({ ...proof, transfer: { walletEmpty: true } }).label, 'Final proof');
  assert.equal(sandbox.finalizationBadge({ ...proof, transfer: { walletEmpty: true } }).className, 'warn');
  sandbox.sweepBound = true;
  assert.equal(sandbox.finalizationBadge({ ...proof, transfer: { walletEmpty: true } }).label, 'Proof ready');
  assert.equal(sandbox.finalizationBadge({ ...proof, transfer: { walletEmpty: true } }).className, '');

  const phaseTreeSource = js.match(/function renderClassicPhaseTree\(topology\) \{[\s\S]*?\n\}\n\nfunction renderAirdropPanel/)?.[0];
  assert.ok(phaseTreeSource, 'classic phase tree helper should be extractable');
  assert.match(phaseTreeSource, /const proofConfig = proofConfigForFingerprint\(proof, currentLaunchConfig\(\)\)/);
  assert.match(phaseTreeSource, /currentReportPublish\(proof, proofConfig, \{ allowTransient: true \}\)/);
  assert.match(phaseTreeSource, /currentLocalDossier\(proof, proofConfig\)/);
  assert.match(phaseTreeSource, /const reportArtifactRecord = report \|\| localDossier/);
  assert.match(phaseTreeSource, /const sweepComplete = Boolean\(demoRunHasCompletedReadiness\(\) \|\| transferHasWalletEmptyFinalSweepEvidence\(proof\?\.transfer\)\)/);
  assert.match(phaseTreeSource, /reportArtifactMatchesTerminalSweep\(reportArtifactRecord, proof\)/);
  assert.doesNotMatch(phaseTreeSource, /const reportComplete = Boolean\(\s*report\?\.jsonUri/);
});

test('v2 classic parity bridge models v1 launch controls without firing irreversible work', () => {
  const combined = `${html}\n${css}\n${js}\n${apiClientJs}`;

  assert.match(combined, /Classic parity bridge/);
  assert.match(combined, /Wallet · CA · pools · funding · recovery/);
  assert.match(combined, /SOL pool %/);
  assert.match(combined, /Quote pool %/);
  assert.match(combined, /Quote venue/);
  assert.match(combined, /Meme flywheel/);
  assert.match(combined, /Reserve flywheel/);
  assert.match(combined, /Stable USDC/);
  assert.match(js, /CLASSIC_QUOTE_VENUES/);
  assert.match(js, /selectedClassicQuoteVenue/);
  assert.match(js, /HipYKXiDh3Kjd1jb7ji6jCEsKQMSGWiFJMdtvH8yb5r/);
  assert.match(combined, /Main slices/);
  assert.match(combined, /Ladder bands/);
  assert.match(combined, /Support SOL/);
  assert.match(combined, /Airdrop wallets/);
  assert.match(combined, /Budget %/);
  assert.match(combined, /Auto-fit/);
  assert.match(combined, /Fit budget/);
  assert.match(combined, /CSV recipients/);
  assert.match(combined, /Manual ladder bands/);
  assert.match(combined, /Pool topology map/);
  assert.match(combined, /Classic phase tree/);
  assert.match(combined, /Launch report export/);
  assert.match(combined, /Classic Step 6 parity/);
  assert.match(combined, /Report, airdrop, proof review/);
  assert.match(combined, /Proof review/);
  assert.match(combined, /Explorer bundle ready/);
  assert.match(js, /Launch Dossier/);
  assert.match(js, /Token launch report · permanent record/);
  assert.match(js, /const proofFingerprint = launchProofFingerprint\(proof, config\)/);
  assert.match(js, /proofFingerprint,/);
  assert.match(js, /const airdropStatus = airdropCompletionStatus\(proof, config\.poolTopology\)/);
  assert.match(js, /const plannedAirdropCount = Math\.max\(/);
  assert.match(js, /config\?\.poolTopology\?\.airdrop\?\.recipientCount/);
  assert.match(js, /plannedRecipientCount: plannedAirdropCount/);
  assert.match(js, /retry before publishing the launch report/);
  assert.match(js, /run airdrop before publishing the launch report/);
  assert.match(js, /airdropCompletionIssue\(airdropStatus\) \|\| 'Airdrop proof is incomplete; refresh or rerun airdrop before publishing the launch report\.'/);
  assert.match(js, /airdropIncomplete: true/);
  assert.match(js, /Existing launch report is not bound to the current proof/);
  assert.match(js, /Launch report publisher returned no permanent URI/);
  assert.match(js, /Report publishing did not return a jsonUri or htmlUri/);
  assert.match(js, /staleProof: true/);
  assert.match(js, /Theme - matches makesometokens\.com/);
  assert.match(js, /engineering-manuscript/);
  assert.match(js, /position-card::before/);
  assert.match(js, /banner-ok/);
  assert.match(js, /banner-demo/);
  assert.match(js, /pool-section-header/);
  assert.match(js, /position-header/);
  assert.match(js, /pool-addresses/);
  assert.match(js, /legacyCopy/);
  assert.match(js, /Supply distribution/);
  assert.match(js, /Liquidity pool breakdown/);
  assert.match(js, /Budget and source/);
  assert.match(js, /recipients: Array\.isArray\(proof\?\.airdrop\?\.recipients\)/);
  assert.match(js, /transferred: Array\.isArray\(proof\?\.airdrop\?\.transferred\) \? proof\.airdrop\.transferred : \[\]/);
  assert.match(js, /Launch journal and recovery state/);
  assert.match(js, /Resume evidence/);
  assert.match(js, /Auditing this launch/);
  assert.match(js, /copy-btn/);
  assert.match(js, /const V2_REPORT_DATA_VERSION = 15/);
  assert.match(js, /dataVersion: V2_REPORT_DATA_VERSION/);
  assert.match(js, /targetMarketCapUsd/);
  assert.match(js, /Launch market cap/);
  assert.match(js, /buildV2ReportPositionAuditRecord/);
  assert.match(js, /tokenProgram: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'/);
  assert.match(js, /allocatedToPoolsPercent/);
  assert.match(js, /preallocationPercent/);
  assert.match(js, /explicitPreallocationPercent/);
  assert.match(js, /unallocatedReservePercent/);
  assert.match(js, /heldReserveAudit: buildV2ReportHeldReserveAudit/);
  assert.match(js, /Held reserve audit/);
  assert.match(js, /Configured support/);
  assert.match(js, /Required support/);
  assert.match(js, /fundingEstimateMatched/);
  assert.match(js, /observedSpend: \{/);
  assert.match(js, /observedExecutionSpendSummary\(\)/);
  assert.match(js, /Observed launch spend/);
  assert.match(js, /renderV2ReportObservedSpend\(data\.observedSpend\)/);
  assert.match(js, /comparisonPositionShapeSummary/);
  assert.match(js, /Position liquidity shape/);
  assert.match(js, /quoteMint: pool\.quoteMint \|\| pool\.quoteAddress \|\| null/);
  assert.match(js, /createPoolTx: pool\.txIds\?\.createPool \|\| pool\.createPoolTx \|\| null/);
  assert.match(js, /positionNftMint/);
  assert.match(js, /feeKeyNftMint/);
  assert.match(js, /lockTx/);
  assert.match(js, /transferTx/);
  assert.match(js, /Data-Protocol: trebuchet-launch-report/);
  assert.match(js, /plannedPools: buildV2ReportPoolPlan\(config, results, proof\)/);
  assert.match(js, /airdropAudit: buildV2ReportAirdropAudit/);
  assert.match(js, /localDossier,/);
  assert.match(js, /poolTopology: reportPoolTopology/);
  assert.match(js, /recoveryAudit: buildV2ReportRecoveryAudit/);
  assert.match(js, /plannedPositionCount/);
  assert.match(js, /recordedPositionCount/);
  assert.match(js, /recipientsPreviewLimit/);
  assert.match(js, /relatedJournals/);
  assert.match(combined, /Fee Key recipient/);
  assert.match(combined, /Sweep destination/);
  assert.match(js, /currentClassicModel/);
  assert.match(js, /currentPreallocationPlan/);
  assert.match(js, /parseSliceShares/);
  assert.match(js, /parseManualLadderBands/);
  assert.match(js, /parseAirdropCsv/);
  assert.match(js, /preallocationSupplyPercent/);
  assert.match(js, /airdropSupplyPercent/);
  assert.match(js, /airdropAutoFit/);
  assert.match(js, /fit-airdrop-budget/);
  assert.match(js, /budgetTokens/);
  assert.match(js, /executionCostSol/);
  assert.match(js, /normalizeAllSlices/);
  assert.match(js, /addCustomPool/);
  assert.match(js, /estimateClassicFunding/);
  assert.match(js, /const quoteDecimalsOverride = Number\.isFinite\(Number\(pool\.quoteDecimals\)\)/);
  assert.match(js, /const quoteUsdOverride = Number\.isFinite\(Number\(pool\.quotePriceUsd\)\)/);
  assert.match(js, /quoteDecimalsOverride,/);
  assert.match(js, /quoteUsdOverride,/);
  assert.match(js, /start-quote-acquire/);
  assert.match(js, /poll-quote-acquire/);
  assert.match(js, /clear-quote-acquire/);
  assert.match(js, /copy-manual-prefund/);
  assert.match(js, /refresh-manual-prefund/);
  assert.match(js, /test-rpc/);
  assert.match(js, /add-rpc/);
  assert.match(js, /select-rpc/);
  assert.match(js, /remove-rpc/);
  assert.match(js, /Quote-token acquire/);
  assert.match(js, /Flywheel quote tokens/);
  assert.match(js, /Acquire map/);
  assert.match(js, /Auto acquire/);
  assert.match(js, /Manual prefund checklist/);
  assert.match(js, /Funding wallet detection/);
  assert.match(js, /detect-funding-wallet/);
  assert.match(js, /use-funding-wallet-sweep/);
  assert.match(js, /External funding wallet/);
  assert.match(js, /connect-solflare/);
  assert.match(js, /use-solflare-destination/);
  assert.match(js, /Check balance/);
  assert.match(js, /Funded/);
  assert.match(js, /Short/);
  assert.match(js, /Execution readiness/);
  assert.match(js, /check-readiness/);
  assert.match(js, /checkExecutionReadiness/);
  assert.match(js, /resume-journal/);
  assert.match(js, /Manual recovery required/);
  assert.match(js, /Next run skips recorded pools/);
  assert.match(js, /dismiss-journal/);
  assert.match(js, /open-activity-log/);
  assert.match(js, /filter-activity-log/);
  assert.match(js, /close-activity-log/);
  assert.match(js, /resumeLaunchJournal/);
  assert.match(js, /dismissLaunchJournal/);
  assert.match(js, /run-demo-launch/);
  assert.match(js, /runDemoLaunch/);
  assert.match(js, /execute-next-run/);
  assert.match(js, /executeNextRunOperation/);
  assert.match(js, /run-full-launch/);
  assert.match(js, /runFullLaunch/);
  assert.match(js, /fullRunStep/);
  assert.match(js, /airdropCompletionStatus/);
  assert.match(js, /retryRequired: evidence\.failed > 0/);
  assert.match(js, /missing: evidence\.missing \|\| \[\]/);
  assert.match(js, /fullRunPendingAirdropCount\(proof\) \{\s*const config = proofConfigForFingerprint\(proof, currentLaunchConfig\(\)\);\s*return airdropCompletionStatus\(proof, config\.poolTopology\)\.pending;/);
  const fullRunPendingBody = js.match(/function fullRunPendingAirdropCount\(proof\) \{([\s\S]*?)\n\}/)?.[1] || '';
  assert.doesNotMatch(fullRunPendingBody, /planned - delivered - failed/);
  assert.match(js, /state\.fullRunStep = 'Retrying airdrop'/);
  assert.match(js, /runV2Airdrop\(\{ retry: true, skipConfirm: true, quiet: true, refreshReadiness: false \}\)/);
  assert.match(js, /Airdrop still has/);
  assert.match(js, /Airdrop has \$\{airdropStatus\.failed\} failed recipient/);
  assert.match(js, /const airdropNeedsEvidenceRepair = Boolean\(/);
  assert.match(js, /&& \(airdropStatus\.pending > 0 \|\| airdropNeedsEvidenceRepair\)/);
  assert.match(js, /airdropNeedsEvidenceRepair \? 'Repair proof'/);
  assert.match(js, /airdropCompletionIssue\(airdropStatus, 'publishing the report or sweeping'\)/);
  assert.match(js, /const airdropIssue = airdropCompletionIssue\(airdropStatus\)/);
  assert.match(js, /airdropIssue\s*\|\| \(airdropComplete && airdropStatus\.configured/);
  assert.match(js, /fullRunCompletionAudit/);
  assert.match(js, /Run full launch/);
  assert.match(js, /publish-v2-report/);
  assert.match(js, /run-v2-airdrop/);
  assert.match(js, /retry-v2-airdrop/);
  assert.match(js, /load-v2-proof/);
  assert.match(js, /download-v2-dossier/);
  assert.match(js, /download-v2-proof/);
  assert.match(js, /copy-v2-proof-summary/);
  assert.match(js, /load-classic-artifact/);
  assert.match(js, /compare-classic-artifact/);
  assert.match(js, /clear-classic-artifact/);
  assert.match(js, /publishV2LaunchReport/);
  assert.match(js, /Refresh journal-backed launch proof before publishing a report/);
  assert.match(js, /launchJournalMissing: true/);
  assert.match(js, /runV2Airdrop/);
  assert.match(js, /downloadV2Proof/);
  assert.match(js, /downloadV2DossierHtml/);
  assert.match(js, /buildV2ProofExportPayload/);
  assert.match(js, /V2_HTML_PROOF_AIRDROP_SAMPLE_LIMIT = 100/);
  assert.match(js, /compactAirdropEvidenceForHtml/);
  assert.match(js, /compactLaunchConfigForHtml/);
  assert.match(js, /compactV2ProofPayloadForHtml/);
  assert.match(js, /fullAirdropRowsHashed: true/);
  assert.match(js, /proofPayloadFromImportText/);
  assert.match(js, /htmlScriptJson/);
  assert.match(js, /id="trebuchet-v2-proof" type="application\/json"/);
  assert.match(js, /compactForHtml: true/);
  assert.match(js, /input\.accept = 'application\/json,text\/html,\.json,\.html,\.htm'/);
  assert.match(js, /proofWithLocalDossierEvidence\(\{\s*proof,\s*config,\s*filename,\s*kind: 'local-proof-json'/);
  assert.match(js, /proofWithLocalDossierEvidence\(\{\s*proof,\s*config,\s*filename,\s*kind: 'local-dossier-html'/);
  assert.match(js, /const launchData = buildV2LaunchReportData\(proofForExport, config\)/);
  assert.match(js, /const payload = buildV2ProofExportPayload\(\{ proof: proofForExport, config, launchData \}\)/);
  assert.match(js, /const launchData = buildV2LaunchReportData\(proofForReport, config\)/);
  assert.match(js, /buildV2LaunchReportHtml\(\{ proof: proofForReport, config, launchData \}\)/);
  assert.match(js, /function buildV2LaunchReportHtml[\s\S]*?config = proofConfigForFingerprint\(proof, config\);[\s\S]*?buildV2ReportTokenomics\(data, config, results\)/);
  const reportHtmlSource = js.match(/function buildV2LaunchReportHtml\([\s\S]*?\n\}\n\nfunction renderReportPanel/)?.[0] || '';
  assert.ok(reportHtmlSource, 'v2 launch report HTML renderer should be extractable');
  assert.match(reportHtmlSource, /const rawData = launchData \|\| buildV2LaunchReportData\(proof, config\)/);
  assert.match(reportHtmlSource, /const parityBundle = proofExportParityBundle\(proof, config, rawData\)/);
  assert.match(reportHtmlSource, /const data = rawData && typeof rawData === 'object'\s*\?\s*\{ \.\.\.rawData, \.\.\.parityBundle \}\s*:\s*rawData/);
  assert.doesNotMatch(reportHtmlSource, /const data = launchData \|\| buildV2LaunchReportData/);
  assert.match(js, /Load proof/);
  assert.match(js, /Download dossier/);
  assert.match(js, /Launch dossier downloaded/);
  assert.match(js, /Launch proof loaded/);
  assert.match(js, /Load artifact/);
  assert.match(js, /Classic artifact loaded/);
  assert.match(js, /function proofExportParityBundle/);
  assert.match(js, /const expectedFingerprint = launchProofFingerprint\(proof, proofConfig\)/);
  assert.match(js, /reportParityAudit: parityBundle\.reportParityAudit/);
  assert.match(js, /classicRetirementGate: parityBundle\.classicRetirementGate/);
  assert.match(js, /fieldVerification: parityBundle\.fieldVerification/);
  assert.match(js, /classicReportComparison: classicReportComparisonForProofExport/);
  assert.match(js, /Launch proof summary/);
  assert.match(js, /complete demo token, LP, and sweep path/);
  assert.match(js, /startVanityGrind/);
  assert.match(js, /vanityCandidateDetail/);
  assert.match(js, /vanityAvailabilityMeta/);
  assert.match(apiClientJs, /\/api\/estimate-lp-funding/);
  assert.match(apiClientJs, /\/api\/clmm-fee-tiers/);
  assert.match(apiClientJs, /\/api\/quote-token-info/);
  assert.match(apiClientJs, /\/api\/acquire-quote-tokens/);
  assert.match(apiClientJs, /\/api\/check-balance-detailed/);
  assert.match(apiClientJs, /\/api\/find-funder/);
  assert.match(apiClientJs, /checkDetailedBalance/);
  assert.match(apiClientJs, /getClmmFeeTiers/);
  assert.match(apiClientJs, /getQuoteTokenInfo/);
  assert.match(apiClientJs, /findFundingWallet/);
  assert.match(apiClientJs, /\/api\/v2\/execution-readiness/);
  assert.match(apiClientJs, /\/api\/v2\/demo-launch\/run/);
  assert.match(apiClientJs, /\/api\/v2\/run-envelope\/execute-next/);
  assert.match(apiClientJs, /\/api\/publish-launch-report/);
  assert.match(apiClientJs, /proofFingerprint/);
  assert.match(apiClientJs, /\/api\/run-airdrop/);
  assert.match(apiClientJs, /\/api\/retry-airdrop/);
  assert.match(apiClientJs, /\/api\/transfer-assets/);
  assert.match(apiClientJs, /\/api\/rpc-config\/select/);
  assert.match(apiClientJs, /\/api\/rpc-config\/add/);
  assert.match(apiClientJs, /\/api\/rpc-config\/remove/);
  assert.match(apiClientJs, /\/api\/rpc-config\/test/);
  assert.match(apiClientJs, /publishLaunchReport/);
  assert.match(apiClientJs, /runAirdrop/);
  assert.match(apiClientJs, /retryAirdrop/);
  assert.match(apiClientJs, /sweepPendingWallet/);
  assert.match(apiClientJs, /cancelLaunchRefund/);
  assert.match(apiClientJs, /\/api\/launch-journals/);
  assert.match(apiClientJs, /\/api\/lp-progress/);
  assert.match(apiClientJs, /\/api\/airdrop-progress/);
  assert.match(apiClientJs, /\/api\/server-logs/);
  assert.match(apiClientJs, /\/api\/vanity-ca-candidates/);
  assert.match(apiClientJs, /\/api\/diagnose-launch/);
  assert.doesNotMatch(js, /request\(['"]\/api\/create-lp/);
  assert.doesNotMatch(js, /request\(['"]\/api\/transfer-assets/);
  assert.doesNotMatch(js, /request\(['"]\/api\/resume-launch/);
});

test('v2 slice parser accepts chat-style percentage ladders', () => {
  const { parseSliceShares, normalizedSliceText } = loadSliceParserHarness();

  assert.deepEqual([...parseSliceShares('48% - 1% - 1%')], [96, 2, 2]);
  assert.deepEqual([...parseSliceShares('48 - 1 - 1')], [96, 2, 2]);
  assert.deepEqual([...parseSliceShares('48 / 1 / 1')], [96, 2, 2]);
  assert.equal(normalizedSliceText('48% - 1% - 1%'), '96,2,2');
});

test('v2 manual prefund evidence is bound to the selected wallet', () => {
  const harness = loadManualPrefundHarness();
  const item = { mint: 'Quote111', rawAmount: '1000', amount: 1000, symbol: 'QUOTE', rows: [] };

  assert.equal(harness.manualPrefundStatus(item).label, 'Funded');
  assert.equal(harness.manualPrefundSummary([item]).className, '');

  harness.state.selectedWalletPublicKey = 'Wallet222';
  const staleStatus = harness.manualPrefundStatus(item);
  const staleSummary = harness.manualPrefundSummary([item]);

  assert.equal(staleStatus.label, 'Check balance');
  assert.equal(staleStatus.className, 'warn');
  assert.match(staleStatus.detail, /another Trebuchet wallet/);
  assert.equal(staleSummary.className, 'warn');

  harness.state.selectedWalletPublicKey = 'Wallet111';
  harness.state.manualPrefund.lastUpdatedAt = '2000-01-01T00:00:00.000Z';
  const oldStatus = harness.manualPrefundStatus(item);
  const oldSummary = harness.manualPrefundSummary([item]);

  assert.equal(oldStatus.label, 'Recheck');
  assert.equal(oldStatus.className, 'warn');
  assert.match(oldStatus.detail, /snapshot is stale/);
  assert.equal(oldSummary.className, 'warn');
});

test('v2 quote acquire evidence is bound to the selected wallet and route set', () => {
  const harness = loadQuoteAcquireHarness();
  const route = { allocationIndex: 0, quoteMint: 'Quote111', quoteSymbol: 'QUOTE', amountSol: 0.25 };
  harness.state.classicFundingEstimate = {
    totalSol: 2,
    autoSwapPlan: [route],
    v2FundingFingerprint: harness.classicFundingEstimateFingerprint(harness.state.currentConfig),
  };
  const fingerprint = harness.quoteAcquireFingerprint();
  harness.state.quoteAcquire = {
    jobId: 'job-1',
    fingerprint,
    job: {
      status: 'done',
      total: 1,
      completed: 1,
      results: [{ success: true, quoteMint: route.quoteMint }],
      v2QuoteAcquireFingerprint: fingerprint,
    },
  };

  assert.equal(harness.quoteAcquireStatus().ready, true);
  assert.equal(harness.quoteAcquireStatus().stale, false);
  assert.equal(harness.quoteAcquireStatus().successEvidence, true);

  harness.state.quoteAcquire.job.results = [];
  let status = harness.quoteAcquireStatus();
  assert.equal(status.ready, false);
  assert.equal(status.stale, false);
  assert.equal(status.successEvidence, false);
  let badge = harness.quoteAcquireBadge();
  assert.equal(badge.label, 'Verify');
  assert.equal(badge.className, 'warn');

  harness.state.quoteAcquire.job.results = [{ success: false, quoteMint: route.quoteMint }];
  status = harness.quoteAcquireStatus();
  assert.equal(status.ready, false);
  assert.equal(status.successEvidence, false);

  harness.state.quoteAcquire.job.results = [{ success: true, allocationIndex: 0, quoteMint: 'WrongQuote111' }];
  status = harness.quoteAcquireStatus();
  assert.equal(status.ready, false);
  assert.equal(status.successEvidence, false);

  harness.state.quoteAcquire.job.results = [{ success: true, quoteMint: route.quoteMint }];
  status = harness.quoteAcquireStatus();
  assert.equal(status.ready, true);
  assert.equal(status.successEvidence, true);
  badge = harness.quoteAcquireBadge();
  assert.equal(badge.label, 'Done');
  assert.equal(badge.className, '');

  harness.state.selectedWalletPublicKey = 'Wallet222';
  assert.equal(harness.quoteAcquireStatus().ready, false);
  assert.equal(harness.quoteAcquireStatus().stale, true);

  harness.state.selectedWalletPublicKey = 'Wallet111';
  harness.state.classicFundingEstimate.autoSwapPlan = [
    route,
    { allocationIndex: 1, quoteMint: 'Quote222', quoteSymbol: 'QUOTE2', amountSol: 0.1 },
  ];
  assert.equal(harness.quoteAcquireStatus().ready, false);
  assert.equal(harness.quoteAcquireStatus().stale, true);
});

test('v2 funding meter requires a selected-wallet detailed balance snapshot', () => {
  const harness = loadFundingMeterHarness();
  const config = { launchSol: 5 };

  let snapshot = harness.fundingMeterSnapshot(config);
  assert.equal(snapshot.hasWalletBalance, false);
  assert.equal(snapshot.availableSol, 5);
  assert.equal(snapshot.availableLabel, 'Planned SOL');

  harness.state.manualPrefund = {
    walletPublicKey: 'Wallet111',
    balance: { sol: 3.25, tokens: {} },
    polling: false,
    error: null,
    lastUpdatedAt: new Date().toISOString(),
  };
  snapshot = harness.fundingMeterSnapshot(config);
  assert.equal(snapshot.hasWalletBalance, true);
  assert.equal(snapshot.walletBalanceFresh, true);
  assert.equal(snapshot.availableSol, 3.25);
  assert.equal(snapshot.availableLabel, 'Wallet SOL');

  harness.state.manualPrefund.lastUpdatedAt = '2000-01-01T00:00:00.000Z';
  snapshot = harness.fundingMeterSnapshot(config);
  assert.equal(snapshot.hasWalletBalance, false);
  assert.equal(snapshot.walletBalanceFresh, false);
  assert.equal(snapshot.walletBalanceStale, true);
  assert.equal(snapshot.availableSol, 5);
  assert.equal(snapshot.availableLabel, 'Planned SOL');
  assert.equal(snapshot.badge.label, 'Stale balance');

  harness.state.selectedWalletPublicKey = 'Wallet222';
  snapshot = harness.fundingMeterSnapshot(config);
  assert.equal(snapshot.hasWalletBalance, false);
  assert.equal(snapshot.availableSol, 5);
});

test('v2 launch dossier position cards expose full Fee Key recipient delivery proof', () => {
  const { renderV2ReportPositionCard } = loadV2ReportPositionCardHarness();
  const recipient = 'FeeRecipientReport111111111111111111111111111';
  const deliveredTo = 'DeliveredRecipientReport111111111111111111111111';
  const transferTx = 'TransferReportTx111111111111111111111111111111';
  const htmlOut = renderV2ReportPositionCard({
    title: 'Main slice 1',
    kind: 'main',
    position: {
      locked: true,
      recipient,
      transferredTo: deliveredTo,
      sharePercent: 1,
      tickLower: -443640,
      tickUpper: 443640,
      nftMint: 'PositionReport111111111111111111111111111111',
      feeKeyNftMint: 'FeeKeyReport111111111111111111111111111111',
      txIds: {
        open: 'OpenReportTx111111111111111111111111111111111',
        lock: 'LockReportTx111111111111111111111111111111111',
        transfer: transferTx,
      },
    },
  });

  assert.match(htmlOut, /Fee Key recipient/);
  assert.match(htmlOut, /Fee Key delivered to/);
  assert.match(htmlOut, new RegExp(recipient));
  assert.match(htmlOut, new RegExp(deliveredTo));
  assert.match(htmlOut, new RegExp(transferTx));
  assert.match(htmlOut, new RegExp(`data-copy="${recipient}"`));
  assert.match(htmlOut, new RegExp(`data-copy="${deliveredTo}"`));
  assert.match(htmlOut, /Fee Key sent to/);
  assert.match(htmlOut, /Open TX/);
  assert.match(htmlOut, /Lock TX/);
  assert.match(htmlOut, /Fee Key transfer TX/);
  assert.doesNotMatch(htmlOut, />Transfer tx</);
});

test('v2 launch dossier pool headers render Classic fee tier and spacing summary', () => {
  const { v2ReportPoolFeeTierLabel } = loadV2ReportFeeTierHarness([
    { index: 0, tradeFeeRate: 2500, tickSpacing: 60 },
    { index: 3, tradeFeeRate: 10000, tickSpacing: 120 },
  ]);

  assert.equal(
    v2ReportPoolFeeTierLabel({ ammConfigIndex: 0, tickSpacing: 60 }, {}),
    '0.25% / spacing 60',
  );
  assert.equal(
    v2ReportPoolFeeTierLabel({}, { ammConfigIndex: 3 }),
    '1.00% / spacing 120',
  );
  assert.equal(
    v2ReportPoolFeeTierLabel({ ammConfigIndex: 9, tickSpacing: 44 }, {}),
    'index 9 / spacing 44',
  );
  assert.match(js, /<div class="pool-meta">[\s\S]*Fee tier/);
  assert.match(js, /renderV2ReportAddressRow\('Quote token mint'/);
  assert.match(js, /renderV2ReportAddressRow\('Create-pool TX'/);
});

test('v2 launch dossier renders portable pool depth charts for ladder and support topology', () => {
  const { renderV2ReportDepthChart, v2ReportLadderBands } = loadV2ReportDepthChartHarness();
  const userPool = {
    quoteSymbol: 'SOL',
    supplyPercent: 70,
    bootstrap: { mode: 'minimal' },
    ladder: {
      mode: 'manual',
      bands: [
        { supplyPercent: 5, lowerMultiplier: 1.1, upperMultiplier: 1.8 },
        { supplyPercent: 2.5, lowerMultiplier: 1.8, upperMultiplier: 4 },
      ],
    },
    support: { mode: 'custom', solValue: 0.35, depthPct: 12 },
  };
  const chart = renderV2ReportDepthChart({ quoteSymbol: 'SOL', supplyPercent: 70 }, userPool);

  assert.match(chart, /pool-depth-chart/);
  assert.match(chart, /Liquidity depth chart/);
  assert.match(chart, /Support wall/);
  assert.match(chart, /Wide \/ main/);
  assert.match(chart, /Ladder 1/);
  assert.match(chart, /1x launch/);
  assert.equal(v2ReportLadderBands({}, userPool).length, 2);
  assert.equal(renderV2ReportDepthChart({}, { ladder: { mode: 'off' }, support: { mode: 'off' } }), '');
  assert.match(js, /renderV2ReportDepthChart\(pool, userPool\)/);
  assert.match(js, /pool-depth-chart/);
});

test('v2 launch dossier airdrop tables disclose capped row overflow', () => {
  const { buildV2ReportAirdropSection } = loadV2ReportAirdropSectionHarness();
  const deliveredRows = Array.from({ length: 105 }, (_, index) => ({
    wallet: `DeliveredWallet${String(index).padStart(3, '0')}111111111111111111`,
    tokens: index + 1,
    txId: `DeliveredTx${String(index).padStart(3, '0')}111111111111111111111111111111111111111111`,
  }));
  const failedRows = Array.from({ length: 103 }, (_, index) => ({
    wallet: `FailedWallet${String(index).padStart(3, '0')}111111111111111111`,
    tokens: index + 1,
    error: 'rpc timeout',
  }));
  const executedHtml = buildV2ReportAirdropSection({
    airdrop: {
      plannedRecipientCount: deliveredRows.length + failedRows.length,
      deliveredCount: deliveredRows.length,
      failedCount: failedRows.length,
      transferred: deliveredRows,
      failed: failedRows,
    },
  }, {
    poolTopology: {
      airdrop: {
        enabled: true,
        recipientCount: deliveredRows.length + failedRows.length,
        supplyPercent: 1,
      },
    },
  });
  const pendingRows = Array.from({ length: 104 }, (_, index) => ({
    wallet: `PendingWallet${String(index).padStart(3, '0')}111111111111111111`,
    tokens: index + 1,
  }));
  const pendingHtml = buildV2ReportAirdropSection({
    airdrop: {
      plannedRecipientCount: pendingRows.length,
      deliveredCount: 0,
      failedCount: 0,
      transferred: [],
      failed: [],
    },
  }, {
    poolTopology: {
      airdrop: {
        enabled: true,
        recipientCount: pendingRows.length,
        recipients: pendingRows,
        supplyPercent: 1,
      },
    },
  });

  assert.match(executedHtml, /&hellip;and 5 more delivered recipients/);
  assert.match(executedHtml, /&hellip;and 3 more failed recipients/);
  assert.match(pendingHtml, /&hellip;and 4 more pending recipients/);
  assert.match(executedHtml, /full row evidence is retained in the JSON proof/);
  assert.match(js, /\.report-overflow-row/);
});

test('v2 launch dossier reports observed execution spend evidence', () => {
  const { renderV2ReportObservedSpend } = loadV2ReportSweepTransferHarness();
  const measuredHtml = renderV2ReportObservedSpend({
    source: 'execution-ledger',
    outflowSol: 1.234567,
    inflowSol: 0.25,
    measuredCount: 3,
    errorCount: 1,
  });
  const emptyHtml = renderV2ReportObservedSpend({});

  assert.match(measuredHtml, /Observed launch spend/);
  assert.match(measuredHtml, /Observed SOL outflow/);
  assert.match(measuredHtml, /1\.234567 SOL/);
  assert.match(measuredHtml, /0\.25 SOL/);
  assert.match(measuredHtml, /0\.984567 SOL/);
  assert.match(measuredHtml, /Measured operations/);
  assert.match(measuredHtml, /Guarded execution ledger/);
  assert.match(measuredHtml, /3 guarded wallet balance observations/);
  assert.match(measuredHtml, /1 operation could not record a wallet balance delta/);
  assert.match(emptyHtml, /No guarded wallet balance observations/);
  assert.match(emptyHtml, /Observation gaps/);
  assert.match(emptyHtml, />0<\/span>/);
  assert.match(js, /observed-spend-facts/);
  assert.match(js, /observed-spend-note/);
});

test('v2 launch dossier renders held reserve support audit evidence', () => {
  const { buildV2ReportHeldReserveAuditSection } = loadV2ReportSweepTransferHarness();
  const htmlOut = buildV2ReportHeldReserveAuditSection({
    state: 'danger',
    detail: 'Held reserve support is underbacked.',
    heldReservePercent: 7,
    explicitPreallocationPercent: 5,
    airdropReservePercent: 2,
    unallocatedReservePercent: 13,
    supportSol: 4.25,
    requiredSupportSol: 12.5,
    coverage: 0.34,
    solUsd: 100,
  });

  assert.match(htmlOut, /Held reserve audit/);
  assert.match(htmlOut, /danger/);
  assert.match(htmlOut, /Held reserve/);
  assert.match(htmlOut, /7%/);
  assert.match(htmlOut, /Explicit prealloc/);
  assert.match(htmlOut, /5%/);
  assert.match(htmlOut, /Airdrop reserve/);
  assert.match(htmlOut, /2%/);
  assert.match(htmlOut, /Configured support/);
  assert.match(htmlOut, /4\.25 SOL/);
  assert.match(htmlOut, /Required support/);
  assert.match(htmlOut, /12\.5 SOL/);
  assert.match(htmlOut, /Coverage/);
  assert.match(htmlOut, /34%/);
  assert.match(htmlOut, /Held reserve support is underbacked/);
  assert.match(js, /heldReserveAudit: buildV2ReportHeldReserveAudit/);
  assert.match(js, /buildV2ReportHeldReserveAuditSection\(data\.heldReserveAudit\)/);
});

test('v2 launch report exports a normalized field verification packet', () => {
  const harness = loadV2FieldVerificationHarness();
  const { buildV2FieldVerification, buildV2ReportFieldVerificationSection } = harness;
  const retirementGate = {
    source: 'trebuchet-v2-classic-retirement-gate',
    proofFingerprint: 'proof-fingerprint-111',
    state: 'danger',
    passCount: 1,
    itemCount: 3,
    criteriaPassCount: 1,
    criteriaItemCount: 2,
    requirements: [
      { id: 'live-proof', pass: false, detail: 'Run a real v2 launch through token, liquidity, and final sweep.' },
      { id: 'report-proof', pass: true, detail: 'Local dossier proof is attached.' },
      { id: 'classic-comparison', pass: false, detail: 'Paste and compare a completed classic artifact against the completed v2 proof.' },
    ],
    replacementCriteria: [
      { id: 'wallet-lifecycle', label: 'Wallet generation and recovery', pass: true, evidence: 'Selected wallet has a signing secret.' },
      { id: 'classic-artifact-comparison', label: 'Classic artifact comparison', pass: false, evidence: 'Compare a completed Classic artifact.' },
    ],
  };
  harness.generatedRetirementGate = retirementGate;
  const packet = buildV2FieldVerification({
    proof: { token: { mint: 'Mint111' } },
    config: { poolTopology: {} },
    audit: { status: 'missing' },
    retirementGate,
  });
  const htmlOut = buildV2ReportFieldVerificationSection(packet);

  assert.equal(packet.version, 1);
  assert.equal(packet.source, 'trebuchet-v2-field-verification');
  assert.equal(packet.proofFingerprint, 'proof-fingerprint-111');
  assert.equal(packet.state, 'blocked');
  assert.equal(packet.ready, false);
  assert.equal(packet.passCount, 1);
  assert.equal(packet.itemCount, 3);
  assert.equal(packet.blockerCount, 2);
  assert.equal(packet.criteriaBlockerCount, 1);
  assert.equal(packet.nextAction, 'run-non-demo-v2-launch');
  assert.match(packet.nextDetail, /Run a real v2 launch/);
  assert.equal(packet.requirements.find((item) => item.id === 'classic-comparison').action, 'compare-classic-artifact');
  assert.equal(packet.criteriaBlockers[0].action, 'compare-classic-artifact');
  assert.match(htmlOut, /Field parity packet blocked/);
  assert.match(htmlOut, /proof-fingerprint-111/);
  assert.match(htmlOut, /run-non-demo-v2-launch/);
  assert.match(htmlOut, /Replacement blockers/);
  assert.match(htmlOut, /compare-classic-artifact/);
  assert.match(htmlOut, /Classic artifact/);
  assert.match(js, /const expectedFingerprint = launchProofFingerprint\(proof, config\)/);
  assert.match(js, /classicRetirementGateMatchesProof\(retirementGate, proof, audit, config\)/);
  assert.match(js, /gateFingerprint === expectedFingerprint/);
  assert.match(js, /fieldVerification: parityBundle\.fieldVerification/);
  assert.match(js, /fieldVerification,/);
  assert.match(js, /buildV2ReportParityAuditSection\(data\.reportParityAudit, data\.classicRetirementGate, data\.fieldVerification\)/);
});

test('v2 field verification routes replacement-criterion blockers to concrete actions', () => {
  const harness = loadV2FieldVerificationHarness();
  const { buildV2FieldVerification, buildV2ReportFieldVerificationSection } = harness;
  const retirementGate = {
    source: 'trebuchet-v2-classic-retirement-gate',
    proofFingerprint: 'proof-fingerprint-111',
    state: 'danger',
    passCount: 2,
    itemCount: 2,
    criteriaPassCount: 1,
    criteriaItemCount: 3,
    requirements: [
      { id: 'live-proof', pass: true, detail: 'Live v2 proof is attached.' },
      { id: 'report-proof', pass: true, detail: 'Terminal report is attached.' },
    ],
    replacementCriteria: [
      { id: 'wallet-lifecycle', label: 'Wallet generation and recovery', pass: true, evidence: 'Wallet is unlocked.' },
      { id: 'funding-and-quote', label: 'Funding and quote readiness', pass: false, evidence: 'Classic funding estimate is stale.' },
      { id: 'charts-and-viewport', label: 'Charts and viewport smoke', pass: false, evidence: 'Viewport proof is stale.' },
    ],
  };
  harness.generatedRetirementGate = retirementGate;
  const packet = buildV2FieldVerification({
    proof: { token: { mint: 'Mint111' } },
    config: { poolTopology: {} },
    retirementGate,
  });
  const htmlOut = buildV2ReportFieldVerificationSection(packet);

  assert.equal(packet.ready, false);
  assert.equal(packet.passCount, 2);
  assert.equal(packet.itemCount, 2);
  assert.equal(packet.blockerCount, 0);
  assert.equal(packet.criteriaBlockerCount, 2);
  assert.equal(packet.nextAction, 'run-funding-and-quote-checks');
  assert.match(packet.nextDetail, /Classic funding estimate is stale/);
  assert.equal(packet.criteriaBlockers[0].action, 'run-funding-and-quote-checks');
  assert.equal(packet.criteriaBlockers[1].action, 'run-viewport-smoke');
  assert.match(htmlOut, /2 criterion blockers/);
  assert.match(htmlOut, /run-funding-and-quote-checks/);
  assert.match(htmlOut, /run-viewport-smoke/);
  assert.match(js, /const V2_FIELD_VERIFICATION_CRITERIA = Object\.freeze/);
  assert.match(js, /review-replacement-criterion/);
});

test('v2 field verification rejects stale pass-shaped retirement gates', () => {
  const { buildV2FieldVerification } = loadV2FieldVerificationHarness();
  const packet = buildV2FieldVerification({
    proof: { token: { mint: 'Mint111' } },
    config: { poolTopology: {} },
    retirementGate: {
      source: 'trebuchet-v2-classic-retirement-gate',
      proofFingerprint: 'stale-proof-fingerprint',
      state: 'pass',
      requirements: [
        { id: 'live-proof', pass: true, detail: 'Live v2 proof is attached.' },
      ],
      replacementCriteria: [
        { id: 'classic-artifact-comparison', pass: true, evidence: 'Classic comparison passed.' },
      ],
    },
  });

  assert.equal(packet.proofFingerprint, 'proof-fingerprint-111');
  assert.equal(packet.ready, false);
  assert.equal(packet.state, 'blocked');
  assert.equal(packet.blockerCount, 1);
  assert.equal(packet.nextAction, 'run-non-demo-v2-launch');
  assert.match(packet.nextDetail, /Run a real v2 launch/);

  const forgedCurrentPacket = buildV2FieldVerification({
    proof: { token: { mint: 'Mint111' } },
    config: { poolTopology: {} },
    retirementGate: {
      source: 'trebuchet-v2-classic-retirement-gate',
      proofFingerprint: 'proof-fingerprint-111',
      state: 'pass',
      passCount: 5,
      itemCount: 5,
      criteriaPassCount: 1,
      criteriaItemCount: 1,
      requirements: [
        { id: 'live-proof', pass: true, detail: 'Forged live proof.' },
        { id: 'report-proof', pass: true, detail: 'Forged report proof.' },
        { id: 'classic-comparison', pass: true, detail: 'Forged Classic comparison.' },
        { id: 'audit', pass: true, detail: 'Forged audit.' },
        { id: 'replacement-criteria', pass: true, detail: 'Forged criteria.' },
      ],
      replacementCriteria: [
        { id: 'classic-artifact-comparison', pass: true, evidence: 'Forged comparison.' },
      ],
    },
  });
  assert.equal(forgedCurrentPacket.ready, false);
  assert.equal(forgedCurrentPacket.state, 'blocked');
  assert.equal(forgedCurrentPacket.nextAction, 'run-non-demo-v2-launch');
  assert.match(js, /function classicRetirementGateMatchesProof/);
  assert.match(js, /function fieldVerificationMatchesProof/);
});

test('v2 launch runbook follows field verification blockers', () => {
  const harness = loadFieldRunbookHarness();
  const { buildFieldRunbookStages, renderFieldRunbookSummary, fieldRunbookActionControl } = harness;
  const context = {
    fieldVerification: {
      ready: false,
      blockerCount: 1,
      criteriaBlockerCount: 2,
      nextAction: 'run-funding-and-quote-checks',
    },
    requirementsById: new Map([
      ['live-proof', { id: 'live-proof', label: 'Live launch', pass: false, action: 'run-non-demo-v2-launch', detail: 'Run a real launch.' }],
      ['report-proof', { id: 'report-proof', label: 'Report', pass: false, action: 'attach-terminal-report', detail: 'Attach report.' }],
      ['classic-comparison', { id: 'classic-comparison', label: 'Classic artifact', pass: false, action: 'compare-classic-artifact', detail: 'Compare Classic.' }],
      ['audit', { id: 'audit', label: 'Audit', pass: false, action: 'resolve-proof-audit', detail: 'Resolve audit.' }],
      ['replacement-criteria', { id: 'replacement-criteria', label: 'Criteria', pass: false, action: 'complete-replacement-criteria', detail: 'Complete criteria.' }],
    ]),
    criteriaById: new Map([
      ['token-config-parity', { id: 'token-config-parity', label: 'Token config', pass: true, action: 'none', detail: 'Token staged.' }],
      ['pool-config-parity', { id: 'pool-config-parity', label: 'Pool config', pass: true, action: 'none', detail: 'Pools staged.' }],
      ['wallet-lifecycle', { id: 'wallet-lifecycle', label: 'Wallet', pass: true, action: 'none', detail: 'Wallet unlocked.' }],
      ['vanity-options', { id: 'vanity-options', label: 'Vanity', pass: true, action: 'none', detail: 'Vanity available.' }],
      ['funding-and-quote', { id: 'funding-and-quote', label: 'Funding', pass: false, action: 'run-funding-and-quote-checks', detail: 'Classic funding estimate is stale.' }],
      ['held-reserve-backing', { id: 'held-reserve-backing', label: 'Held reserve', pass: false, action: 'back-held-reserve', detail: 'Reserve needs support backing.' }],
      ['sweep-report-proof', { id: 'sweep-report-proof', label: 'Sweep report', pass: false, action: 'publish-report-and-sweep', detail: 'Report is missing.' }],
      ['classic-artifact-comparison', { id: 'classic-artifact-comparison', label: 'Classic artifact', pass: false, action: 'compare-classic-artifact', detail: 'Comparison missing.' }],
      ['proof-audit', { id: 'proof-audit', label: 'Proof audit', pass: false, action: 'resolve-proof-audit', detail: 'Audit missing.' }],
    ]),
  };
  const rows = buildFieldRunbookStages(context);

  assert.equal(rows.length, 6);
  assert.equal(rows[0].id, 'model');
  assert.equal(rows[0].state, 'done');
  assert.equal(rows[1].state, 'done');
  assert.equal(rows[2].id, 'fund');
  assert.equal(rows[2].state, 'active');
  assert.equal(rows[2].action, 'run-funding-and-quote-checks');
  assert.match(rows[2].detail, /Classic funding estimate is stale/);
  assert.equal(rows[3].state, 'queued');
  assert.match(renderFieldRunbookSummary(context, rows), /3 blockers · run-funding-and-quote-checks/);
  const fundingControl = fieldRunbookActionControl(rows[2].action, rows[2]);
  const walletControl = fieldRunbookActionControl('generate-or-unlock-wallet', rows[1]);
  const liveControl = fieldRunbookActionControl('run-non-demo-v2-launch', rows[3]);
  const loadClassicControl = fieldRunbookActionControl('compare-classic-artifact', rows[5]);
  harness.proof = { token: { mint: 'Mint111' }, canPublishReport: true };
  harness.reportEvidence = true;
  harness.airdropStatus = { complete: false };
  const reportBlockedControl = fieldRunbookActionControl('publish-report-and-sweep', rows[4]);
  harness.airdropStatus = { complete: true };
  const reportReadyControl = fieldRunbookActionControl('publish-report-and-sweep', rows[4]);
  harness.state.classicReportComparison.input = '{"classic":"artifact"}';
  const compareControl = fieldRunbookActionControl('compare-classic-artifact', rows[5]);
  assert.equal(fundingControl.dataAction, 'estimate-funding');
  assert.equal(fundingControl.label, 'Estimate');
  assert.equal(walletControl.dataAction, 'generate-wallet');
  assert.equal(walletControl.label, 'Generate wallet');
  assert.equal(liveControl.dataAction, 'run-full-launch');
  assert.equal(liveControl.label, 'Run live');
  assert.equal(reportBlockedControl.dataAction, 'download-v2-dossier');
  assert.equal(reportBlockedControl.disabled, true);
  assert.equal(reportReadyControl.dataAction, 'publish-v2-report');
  assert.equal(reportReadyControl.disabled, false);
  assert.equal(loadClassicControl.dataAction, 'load-classic-artifact');
  assert.equal(loadClassicControl.label, 'Load artifact');
  assert.equal(compareControl.dataAction, 'compare-classic-artifact');
  assert.equal(compareControl.label, 'Compare');
  assert.match(js, /Stage model/);
  assert.match(js, /Prepare wallet/);
  assert.match(js, /Compare and retire/);
  assert.match(js, /fieldRunbookActionControl/);
  assert.match(js, /stage-control/);
  assert.match(js, /data-action="\$\{escapeHtml\(control\.dataAction\)\}"/);
  assert.match(js, /buildFieldRunbookContext/);
  assert.match(js, /buildFieldRunbookStages/);
  assert.match(js, /renderFieldRunbookSummary/);
  assert.match(js, /stage-action/);
  assert.match(css, /stage-action/);
  assert.match(css, /stage-status-stack/);
  assert.match(css, /stage-control/);
  assert.match(css, /tx-state\.warn/);
});

test('v2 copied proof summary includes field parity next action', () => {
  const { buildProofShareSummary } = loadProofShareSummaryHarness();
  const summary = buildProofShareSummary({
    token: { mint: 'Mint111111111111111111111111111111111111111', symbol: 'MKT' },
    liquidity: {
      poolCount: 1,
      results: [{ mainPositions: [{}, {}], ladderPositions: [{}] }],
    },
    airdrop: {
      deliveredCount: 7,
      failedCount: 1,
    },
  }, {
    token: { symbol: 'MKT' },
    poolTopology: {},
  });

  assert.match(summary, /Trebuchet launch proof: MKT/);
  assert.match(summary, /Classic retirement: blocked/);
  assert.match(summary, /Field parity: 2\/5 checks passing; 3 blockers/);
  assert.match(summary, /Missing field proof: Classic artifact: Compare a completed Classic artifact/);
  assert.match(summary, /Report: Publish or attach a proof-bound v2 launch report/);
  assert.match(summary, /Airdrop: needs proof: recipient rows, transaction signatures/);
  assert.match(summary, /Next action: compare-classic-artifact - Compare a completed Classic artifact/);
  assert.match(js, /const airdropSummary = airdropStatus\.configured/);
  assert.match(js, /needs proof: \$\{\(airdropStatus\.missing \|\| \[\]\)\.join\(', '\)/);
  assert.match(js, /const fieldVerification = buildV2FieldVerification\(\{/);
  assert.match(js, /fieldVerificationHandoffLines\(fieldVerification\)/);
  assert.match(js, /Classic retirement: \$\{retirementGate\.state === 'pass' \? 'ready' : 'blocked'\}/);
  assert.match(js, /Field parity: \$\{fieldStatus\}/);
});

test('v2 copied proof summary counts replacement-criteria blockers', () => {
  const harness = loadProofShareSummaryHarness();
  harness.mockFieldVerification = {
    ready: false,
    passCount: 5,
    itemCount: 5,
    blockerCount: 0,
    criteriaBlockerCount: 2,
    nextAction: 'run-funding-and-quote-checks',
    nextDetail: 'Classic funding estimate is stale for this launch model.',
    blockers: [],
    criteriaBlockers: [
      {
        label: 'Funding and quote readiness',
        detail: 'Classic funding estimate is stale for this launch model.',
      },
      {
        label: 'Charts and viewport smoke',
        detail: 'Run the viewport smoke proof against current assets.',
      },
    ],
  };
  const summary = harness.buildProofShareSummary({
    token: { mint: 'Mint111111111111111111111111111111111111111', symbol: 'MKT' },
    liquidity: { poolCount: 1, results: [] },
  }, {
    token: { symbol: 'MKT' },
    poolTopology: {},
  });

  assert.match(summary, /Field parity: 5\/5 checks passing; 2 blockers \(2 criteria\)/);
  assert.match(summary, /Missing replacement criteria: Funding and quote readiness: Classic funding estimate is stale/);
  assert.match(summary, /Charts and viewport smoke: Run the viewport smoke proof/);
  assert.match(summary, /Next action: run-funding-and-quote-checks - Classic funding estimate is stale/);
});

test('v2 launch dossier renders final sweep transfer transaction evidence', () => {
  const { buildV2ReportSweepTransferRows } = loadV2ReportSweepTransferHarness();
  const htmlOut = buildV2ReportSweepTransferRows({
    solTransferred: 0.123456789,
    solSweep: {
      solTransferred: 0.123456789,
      txId: 'SolSweepTx1111111111111111111111111111111111',
    },
    tokenSweep: {
      transferred: [{
        mint: 'So11111111111111111111111111111111111111112',
        amount: '420.5',
        txId: 'TokenSweepTx22222222222222222222222222222222',
      }],
      errors: [{
        mint: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',
        error: 'ATA creation failed',
        signature: 'TokenFailSig4444444444444444444444444444444',
      }],
    },
    nftSweep: {
      transferred: [{
        mint: 'NftMint111111111111111111111111111111111111',
        programName: 'Token-2022',
        txId: 'NftSweepTx333333333333333333333333333333333',
      }],
      errors: [{
        mint: 'NftFailMint111111111111111111111111111111111',
        error: 'owner mismatch',
      }],
    },
  });

  assert.match(htmlOut, /Native SOL/);
  assert.match(htmlOut, /0\.123456789 SOL/);
  assert.match(htmlOut, /solscan\.io\/tx\/SolSweepTx111/);
  assert.match(htmlOut, /solscan\.io\/account\/So111/);
  assert.match(htmlOut, /Token-2022/);
  assert.match(htmlOut, /ATA creation failed/);
  assert.match(htmlOut, /owner mismatch/);
  assert.match(htmlOut, /report-error-row/);
  assert.match(buildV2ReportSweepTransferRows({}), /No final sweep transfer signatures recorded yet/);
  assert.match(js, /Final sweep transfer evidence/);
  assert.match(js, /buildV2ReportSweepTransferRows\(transfer\)/);
  assert.match(js, /\.report-error-row/);
});

test('v2 proof import re-runs Classic comparison from artifact text', () => {
  const restoreStart = js.indexOf('function restoreImportedProofComparison');
  const restoreEnd = js.indexOf('async function loadV2ProofFile');
  const loadStart = js.indexOf('async function loadV2ProofFile');
  const loadEnd = js.indexOf('\nfunction requestV2ProofImport', loadStart);
  assert.ok(restoreStart >= 0 && restoreEnd > restoreStart, 'restoreImportedProofComparison must be extractable');
  assert.ok(loadStart >= 0 && loadEnd > loadStart, 'loadV2ProofFile must be extractable');
  const restoreBody = js.slice(restoreStart, restoreEnd);
  const loadBody = js.slice(loadStart, loadEnd);

  assert.match(js, /function exportableLaunchConfigSnapshot/);
  assert.match(js, /function buildV2ProofExportPayload/);
  assert.match(js, /const exportLaunchConfig = exportableLaunchConfigSnapshot\(proofConfig\)/);
  assert.match(js, /const proofForPayload = proof && typeof proof === 'object'/);
  assert.match(js, /pruneLaunchProofEvidenceArtifactsForExport\(proof, proofConfig\)/);
  assert.match(js, /const exportProof = proofForPayload && typeof proofForPayload === 'object'/);
  assert.match(js, /proof: exportProof \|\| null,/);
  assert.match(js, /launchConfig: exportLaunchConfig,/);
  assert.match(js, /function downloadV2Proof\(\) \{[\s\S]*?const config = proofConfigForFingerprint\(proof, currentLaunchConfig\(\)\)/);
  assert.match(js, /const payload = buildV2ProofExportPayload\(\{ proof: proofForExport, config, launchData \}\)/);
  assert.match(js, /function downloadV2DossierHtml\(\) \{[\s\S]*?const config = proofConfigForFingerprint\(proof, currentLaunchConfig\(\)\)/);
  assert.match(js, /launchConfig: exportableLaunchConfigSnapshot\(proofConfigForFingerprint\(proof, config\)\),/);
  assert.match(js, /launchConfig: exportableLaunchConfigSnapshot\(config\),/);
  assert.match(js, /function importedProofComparisonConfig/);
  assert.match(js, /const proofLaunchConfig = proof\?\.launchConfig/);
  assert.match(js, /payload\?\.launchConfig/);
  assert.match(js, /launchData\.poolTopology/);
  assert.match(js, /function importedExplicitLaunchConfig/);
  assert.match(js, /function importedLaunchConfigSnapshotIsV2Export/);
  assert.match(js, /const explicitLaunchConfig = importedExplicitLaunchConfig\(payload\)/);
  assert.match(js, /if \(!importedLaunchConfigSnapshotIsV2Export\(explicitLaunchConfig\)\)/);
  assert.match(js, /if \(!importedExplicitLaunchConfig\(payload\)\) return null/);
  assert.doesNotMatch(js, /launchConfig: exportableLaunchConfigSnapshot\(currentLaunchConfig\(\)\)/);
  assert.match(js, /state\.launchProof = mergeLaunchProofEvidence\(state\.launchProof, rawProof\)/);
  assert.match(js, /classicReportComparison: classicReportComparisonForProofExport\(proofForPayload, proofConfig\),/);
  assert.match(loadBody, /const mergedProof = rememberLaunchProof\(proof\) \|\| proof/);
  assert.match(loadBody, /const mergedConfig = proofConfigForFingerprint\(mergedProof, currentLaunchConfig\(\)\)/);
  assert.match(loadBody, /reportPublishIsProofCurrent\(mergedProof\?\.reportPublish, mergedProof, mergedConfig\)/);
  assert.match(loadBody, /localDossierIsProofCurrent\(mergedProof\?\.localDossier, mergedProof, mergedConfig\)/);
  assert.match(loadBody, /restoreImportedProofComparison\(payload, mergedProof\)/);
  assert.doesNotMatch(loadBody, /if \(proof\.reportPublish\) state\.lastReportPublish = proof\.reportPublish/);
  assert.doesNotMatch(loadBody, /if \(localDossierHasEvidence\(proof\.localDossier\)\) state\.lastLocalDossier = proof\.localDossier/);
  assert.match(js, /classicArtifactCompared: false/);
  assert.match(js, /comparison: null/);
  assert.match(js, /importedComparisonRequiresArtifact: true/);
  assert.match(restoreBody, /comparisonWrapper\?\.input/);
  assert.match(restoreBody, /comparisonFrom\(comparisonWrapper\?\.result\)/);
  assert.match(restoreBody, /Imported proof comparison needs the original Classic artifact text/);
  assert.match(restoreBody, /compareClassicReportArtifact\(importedInput, proof, importedProofComparisonConfig\(payload\)\)/);
  assert.match(restoreBody, /classicComparisonIsRetirementGrade\(result, proof, importedProofComparisonConfig\(payload\)\)/);
  assert.doesNotMatch(restoreBody, /result:\s*importedComparison/);
});

test('v2 proof import does not resurrect artifacts pruned during merge', async () => {
  const loadStart = js.indexOf('async function loadV2ProofFile');
  const loadEnd = js.indexOf('\nfunction requestV2ProofImport', loadStart);
  assert.ok(loadStart >= 0 && loadEnd > loadStart, 'loadV2ProofFile must be extractable');
  const source = js.slice(loadStart, loadEnd);
  const rawProof = {
    id: 'raw',
    reportPublish: { htmlUri: 'ar://raw-import-report', proofFingerprint: 'proof-bound' },
    localDossier: {
      status: 'downloaded',
      kind: 'local-dossier-html',
      filename: 'raw-import.html',
      downloadedAt: '2026-06-30T00:00:00.000Z',
      dataVersion: 14,
      proofFingerprint: 'proof-bound',
    },
  };
  const mergedProof = {
    id: 'merged',
    token: { mint: 'MergedMint1111111111111111111111111111111' },
  };
  const sandbox = {
    state: {
      lastReportPublish: { htmlUri: 'ar://previous' },
      lastLocalDossier: { filename: 'previous.html' },
    },
    restoredProof: null,
    validateProofFile: (file) => file,
    readFileAsText: async () => '{"schema":"trebuchet-v2-proof"}',
    proofPayloadFromImportText: () => ({ schema: 'trebuchet-v2-proof' }),
    proofFromImportedPayload: () => rawProof,
    rememberLaunchProof: () => mergedProof,
    currentLaunchConfig: () => ({ token: { symbol: 'FORM' }, poolTopology: {} }),
    proofConfigForFingerprint: (proof, config) => ({ ...config, proofId: proof?.id || null }),
    reportPublishIsProofCurrent: (report, proof, config) => Boolean(
      report?.htmlUri
        && proof?.id === 'merged'
        && config?.proofId === 'merged'
        && report.htmlUri === 'ar://merged-report'
    ),
    localDossierIsProofCurrent: (dossier, proof, config) => Boolean(
      dossier?.filename
        && proof?.id === 'merged'
        && config?.proofId === 'merged'
        && dossier.filename === 'merged.html'
    ),
    restoreImportedProofComparison: (_payload, proof) => {
      sandbox.restoredProof = proof;
    },
    renderAll: () => {},
    notify: (message) => {
      sandbox.message = message;
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(`${source}\nglobalThis.loadV2ProofFile = loadV2ProofFile;`, sandbox, {
    filename: 'public/v2/app.js proof import harness',
  });

  await sandbox.loadV2ProofFile({ name: 'proof.json' });
  assert.equal(sandbox.state.lastReportPublish, null);
  assert.equal(sandbox.state.lastLocalDossier, null);
  assert.equal(sandbox.restoredProof, mergedProof);
  assert.equal(sandbox.message, 'Launch proof loaded');
});

test('v2 Classic comparison action uses proof-bound launch config', () => {
  const start = js.indexOf('function runClassicArtifactComparison');
  const end = js.indexOf('\nfunction clearClassicArtifactComparison', start);
  assert.ok(start >= 0 && end > start, 'runClassicArtifactComparison should be extractable');
  const source = js.slice(start, end);
  assert.match(source, /const config = proofConfigForFingerprint\(proof, currentLaunchConfig\(\)\)/);

  const sandbox = {
    state: {
      classicReportComparison: {
        input: '{"source":"classic"}',
      },
    },
    document: {
      querySelector: () => ({ value: '' }),
    },
    proof: {
      launchConfig: {
        token: { symbol: 'PROOF' },
        poolTopology: {
          pools: [{ id: 'proof-pool', quoteToken: 'SOL', supplyPercent: 100 }],
        },
      },
      reportParity: {},
    },
    capturedConfig: null,
    currentLaunchProof: () => sandbox.proof,
    currentLaunchConfig: () => ({
      token: { symbol: 'TYPED' },
      poolTopology: {
        pools: [{ id: 'typed-pool', quoteToken: 'SOL', supplyPercent: 1 }],
      },
    }),
    proofConfigForFingerprint: (proof, config) => proof?.launchConfig || config || { poolTopology: {} },
    compareClassicReportArtifact: (_input, _proof, config) => {
      sandbox.capturedConfig = config;
      return {
        status: 'pass',
        artifactSource: 'classic',
        proofFingerprint: 'proof-bound',
        structuredEvidence: true,
        passCount: 1,
        fieldCount: 1,
        rows: [{ id: 'mint', label: 'Token mint', state: 'pass' }],
        comparedAt: '2026-06-30T00:00:00.000Z',
      };
    },
    classicComparisonMatchesProof: (result) => result?.proofFingerprint === 'proof-bound',
    classicComparisonRequiredEvidence: (result) => ({
      pass: Boolean(result?.structuredEvidence && result?.rows?.some((row) => row.id === 'mint' && row.state === 'pass')),
    }),
    classicComparisonIsRetirementGrade: (result, proof, config) => Boolean(
      sandbox.classicComparisonMatchesProof(result, proof, config)
      && result?.status === 'pass'
      && result?.artifactSource !== 'trebuchet-v2'
      && sandbox.classicComparisonRequiredEvidence(result, proof, config).pass
    ),
    persistClassicReportComparison: () => {},
    rememberLaunchProof: (proof) => {
      sandbox.proof = proof;
      return proof;
    },
    renderAll: () => {},
    notify: () => {},
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(`${source}\nglobalThis.runClassicArtifactComparison = runClassicArtifactComparison;`, sandbox, {
    filename: 'public/v2/app.js classic comparison action harness',
  });

  sandbox.runClassicArtifactComparison();
  assert.equal(sandbox.capturedConfig.token.symbol, 'PROOF');
  assert.equal(sandbox.capturedConfig.poolTopology.pools[0].id, 'proof-pool');
  assert.equal(sandbox.proof.reportParity.classicArtifactCompared, true);
});

test('v2 Classic comparison panel checks staleness against proof-bound launch config', () => {
  const start = js.indexOf('function renderClassicArtifactComparisonPanel');
  const end = js.indexOf('\nfunction finalizationNoticeRows', start);
  assert.ok(start >= 0 && end > start, 'renderClassicArtifactComparisonPanel should be extractable');
  const source = js.slice(start, end);
  assert.match(source, /const config = proofConfigForFingerprint\(proof, currentLaunchConfig\(\)\)/);
  assert.match(source, /const selectedResult = currentClassicComparisonForProof\(proof, config\)/);
  assert.match(source, /classicComparisonMatchesProof\(result, proof, config\)/);
  assert.match(source, /Using the proof-saved Classic comparison/);
  assert.match(css, /\.classic-compare-note/);

  const sandbox = {
    state: {
      classicReportComparison: {
        input: '{"source":"classic"}',
        result: {
          status: 'pass',
          passCount: 1,
          fieldCount: 1,
          proofFingerprint: 'proof-bound',
          rows: [],
        },
      },
    },
    proof: {
      launchConfig: {
        token: { symbol: 'PROOF' },
        poolTopology: {
          pools: [{ id: 'proof-pool', quoteToken: 'SOL' }],
        },
      },
    },
    capturedConfig: null,
    currentLaunchProof: () => sandbox.proof,
    currentLaunchConfig: () => ({
      token: { symbol: 'TYPED' },
      poolTopology: {
        pools: [{ id: 'typed-pool', quoteToken: 'SOL' }],
      },
    }),
    proofConfigForFingerprint: (proof, config) => proof?.launchConfig || config || { poolTopology: {} },
    classicComparisonMatchesProof: (result, _proof, config) => {
      sandbox.capturedConfig = config;
      return result?.proofFingerprint === 'proof-bound';
    },
    currentClassicComparisonForProof: (proof, config) => {
      const inputResult = sandbox.state.classicReportComparison.result || null;
      const proofResult = proof?.reportParity?.comparison || null;
      if (inputResult && sandbox.classicComparisonMatchesProof(inputResult, proof, config)) return inputResult;
      if (proofResult && sandbox.classicComparisonMatchesProof(proofResult, proof, config)) return proofResult;
      return inputResult || proofResult || null;
    },
    reportParityClass: () => '',
    escapeHtml: (value) => String(value ?? ''),
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(`${source}\nglobalThis.renderClassicArtifactComparisonPanel = renderClassicArtifactComparisonPanel;`, sandbox, {
    filename: 'public/v2/app.js classic comparison panel harness',
  });

  const htmlOut = sandbox.renderClassicArtifactComparisonPanel();
  assert.equal(sandbox.capturedConfig.token.symbol, 'PROOF');
  assert.equal(sandbox.capturedConfig.poolTopology.pools[0].id, 'proof-pool');
  assert.match(htmlOut, /fields match/);
  assert.doesNotMatch(htmlOut, /stale/);

  sandbox.state.classicReportComparison.result = {
    status: 'pass',
    passCount: 1,
    fieldCount: 1,
    proofFingerprint: 'stale-proof',
    rows: [],
  };
  sandbox.state.classicReportComparison.error = 'Old import failed';
  sandbox.proof.reportParity = {
    comparison: {
      status: 'pass',
      passCount: 7,
      fieldCount: 7,
      proofFingerprint: 'proof-bound',
      rows: [{ id: 'mint', label: 'Token mint', state: 'pass', detail: 'Mint matched.' }],
    },
  };
  const fallbackHtml = sandbox.renderClassicArtifactComparisonPanel();
  assert.match(fallbackHtml, /7\/7 fields match/);
  assert.match(fallbackHtml, /risk-badge[^>]*>proof</);
  assert.match(fallbackHtml, /proof-saved Classic comparison/);
  assert.doesNotMatch(fallbackHtml, /Comparison is for another v2 proof/);
  assert.doesNotMatch(fallbackHtml, /Old import failed/);
});

test('v2 imported proof comparison uses the exported launch config snapshot', () => {
  const exportStart = js.indexOf('function exportableLaunchConfigSnapshot');
  const exportEnd = js.indexOf('\nfunction downloadV2Proof', exportStart);
  const importStart = js.indexOf('function importedExplicitLaunchConfig');
  const importEnd = js.indexOf('\nfunction restoreImportedProofComparison', importStart);
  assert.ok(exportStart >= 0 && exportEnd > exportStart, 'exportableLaunchConfigSnapshot must be extractable');
  assert.ok(importStart >= 0 && importEnd > importStart, 'importedProofComparisonConfig must be extractable');
  const sandbox = {
    Number,
    currentLaunchConfig: () => ({
      token: { name: 'Typed', symbol: 'TYPED', supply: '1' },
      launchSol: 1,
      mode: 'guarded',
      poolTopology: { sweepDestination: 'TypedDest11111111111111111111111111111111111' },
    }),
  };
  vm.runInNewContext(
    [
      js.slice(exportStart, exportEnd),
      js.slice(importStart, importEnd),
      'globalThis.exportableLaunchConfigSnapshot = exportableLaunchConfigSnapshot;',
      'globalThis.importedExplicitLaunchConfig = importedExplicitLaunchConfig;',
      'globalThis.importedProofComparisonConfig = importedProofComparisonConfig;',
    ].join('\n'),
    sandbox,
    { filename: 'public/v2/app.js imported proof config harness' },
  );

  const exported = sandbox.exportableLaunchConfigSnapshot({
    token: {
      name: 'Exported',
      symbol: 'EXP',
      supply: '1000000000',
      logo: { name: 'logo.png', type: 'image/png', size: 1024, dataUrl: 'data:image/png;base64,secretish' },
    },
    launchSol: 4.2,
    mode: 'operator',
    poolTopology: { sweepDestination: 'ExportedDest111111111111111111111111111111111' },
    funding: { targetMarketCapUsd: 25000 },
  });
  assert.equal(exported.schema, 'trebuchet-v2-launch-config');
  assert.equal(exported.source, 'trebuchet-v2');
  assert.equal(exported.token.logo.dataUrl, undefined);
  assert.equal(exported.poolTopology.sweepDestination, 'ExportedDest111111111111111111111111111111111');

  const imported = sandbox.importedProofComparisonConfig({
    launchConfig: exported,
    launchData: {
      name: 'Report Name',
      symbol: 'RPT',
      totalSupply: '999',
      decimals: 9,
      destinationWallet: 'ReportDest1111111111111111111111111111111111',
    },
  });
  assert.equal(imported.token.name, 'Report Name');
  assert.equal(imported.token.symbol, 'RPT');
  assert.equal(imported.token.supply, '999');
  assert.equal(imported.poolTopology.sweepDestination, 'ExportedDest111111111111111111111111111111111');

  const fallback = sandbox.importedProofComparisonConfig({
    launchData: {
      poolTopology: {},
      destinationWallet: 'ReportDest1111111111111111111111111111111111',
    },
  });
  assert.equal(fallback.poolTopology.sweepDestination, 'ReportDest1111111111111111111111111111111111');
  assert.equal(sandbox.importedExplicitLaunchConfig({
    launchData: {
      poolTopology: {},
      destinationWallet: 'ReportDest1111111111111111111111111111111111',
    },
  }), null);

  const proofBound = sandbox.importedProofComparisonConfig({
    launchConfig: {
      poolTopology: { sweepDestination: 'StaleEnvelopeDest111111111111111111111111111' },
    },
    proof: {
      launchConfig: {
        poolTopology: { sweepDestination: 'ProofBoundDest11111111111111111111111111111' },
      },
    },
  });
  assert.equal(proofBound.poolTopology.sweepDestination, 'ProofBoundDest11111111111111111111111111111');
  assert.doesNotMatch(js, /importedLaunchConfigSnapshotHasV2Provenance\(importedExplicitLaunchConfig\(payload\)\)/);
});

test('v2 proof import only restores fingerprint-matched local dossier evidence', () => {
  const sandbox = loadProofImportHarness();
  const launchConfig = {
    token: { name: 'Import Token', symbol: 'IMP', supply: '1000000000' },
    launchSol: 3,
    mode: 'guarded',
    poolTopology: {
      sweepDestination: 'ImportedDest11111111111111111111111111111111',
    },
  };
  const payloadForConfig = { launchConfig: sandbox.exportableLaunchConfigSnapshot(launchConfig) };
  const importedConfig = sandbox.importedProofComparisonConfig(payloadForConfig);
  const proof = {
    walletPublicKey: 'ImportedWallet111111111111111111111111111111',
    token: {
      mint: 'ImportedMint11111111111111111111111111111111',
      symbol: 'IMP',
      mintAuthorityRenounced: true,
      freezeAuthorityDisabled: true,
      metadataUpdateAuthorityRevoked: true,
      metadataImmutable: true,
    },
    liquidity: {
      poolCount: 1,
      poolIds: ['ImportedPool11111111111111111111111111111111'],
      lockedPositionCount: 0,
      feeKeyCount: 0,
      results: [{
        poolId: 'ImportedPool11111111111111111111111111111111',
        totalPositions: 0,
      }],
    },
    airdrop: {
      plannedRecipientCount: 0,
      deliveredCount: 0,
      failedCount: 0,
    },
  };
  const proofForFingerprint = {
    ...proof,
    launchConfig: sandbox.exportableLaunchConfigSnapshot(importedConfig),
  };
  const classicReportJson = {
    source: 'classic',
    token: {
      mint: proof.token.mint,
      symbol: proof.token.symbol,
    },
    liquidity: proof.liquidity,
    transfer: {
      destinationWallet: launchConfig.poolTopology.sweepDestination,
    },
  };
  const classicReportWithGenericLaunchConfig = {
    ...classicReportJson,
    launchConfig,
  };
  const classicReportWithV2MarkedLaunchConfig = {
    ...classicReportJson,
    launchConfig: sandbox.exportableLaunchConfigSnapshot(launchConfig),
  };
  const externalReportWithV2MarkedLaunchConfig = {
    token: {
      mint: proof.token.mint,
      symbol: proof.token.symbol,
    },
    liquidity: proof.liquidity,
    launchConfig: sandbox.exportableLaunchConfigSnapshot(launchConfig),
  };
  const classicReportWithSpoofedV2Envelope = {
    ...classicReportJson,
    schema: 'trebuchet-v2-proof',
    launchConfig: sandbox.exportableLaunchConfigSnapshot(launchConfig),
  };
  const externalReportWithSpoofedV2Envelope = {
    schema: 'trebuchet-v2-proof',
    source: 'trebuchet-v2',
    token: {
      mint: proof.token.mint,
      symbol: proof.token.symbol,
    },
    liquidity: proof.liquidity,
    launchConfig: sandbox.exportableLaunchConfigSnapshot(launchConfig),
  };
  const fieldVerificationOnlyProofPacket = {
    fieldVerification: {
      source: 'trebuchet-v2-field-verification',
      proofFingerprint: sandbox.launchProofFingerprint(proofForFingerprint, importedConfig),
    },
    proof,
    launchConfig: sandbox.exportableLaunchConfigSnapshot(launchConfig),
  };
  const retirementGateOnlyProofPacket = {
    classicRetirementGate: {
      source: 'trebuchet-v2-classic-retirement-gate',
      proofFingerprint: sandbox.launchProofFingerprint(proofForFingerprint, importedConfig),
    },
    proof,
    launchConfig: sandbox.exportableLaunchConfigSnapshot(launchConfig),
  };
  const v2PayloadForConfig = {
    schema: 'trebuchet-v2-proof',
    source: 'trebuchet-v2',
    ...payloadForConfig,
  };
  const snapshotlessV2Payload = {
    schema: 'trebuchet-v2-proof',
    source: 'trebuchet-v2',
    proof,
  };
  const unmarkedConfigV2Payload = {
    schema: 'trebuchet-v2-proof',
    source: 'trebuchet-v2',
    proof,
    launchConfig,
  };
  const mixedMarkedEnvelopeUnmarkedProofPayload = {
    ...v2PayloadForConfig,
    proof: {
      ...proof,
      launchConfig,
    },
  };
  const localDossier = {
    status: 'downloaded',
    kind: 'local-dossier-html',
    filename: 'trebuchet-imp-dossier.html',
    mint: proof.token.mint,
    downloadedAt: '2026-06-30T00:00:00.000Z',
    dataVersion: 13,
    proofFingerprint: sandbox.launchProofFingerprint(proofForFingerprint, importedConfig),
  };
  const reportPublish = {
    status: 'done',
    htmlUri: 'ar://trebuchet-imp-report',
    mint: proof.token.mint,
    proofFingerprint: sandbox.launchProofFingerprint(proofForFingerprint, importedConfig),
  };

  assert.throws(
    () => sandbox.proofFromImportedPayload(classicReportJson),
    /not a v2 proof export/,
  );
  assert.throws(
    () => sandbox.proofFromImportedPayload(classicReportWithGenericLaunchConfig),
    /not a v2 proof export/,
  );
  assert.throws(
    () => sandbox.proofFromImportedPayload(classicReportWithV2MarkedLaunchConfig),
    /not a v2 proof export/,
  );
  assert.throws(
    () => sandbox.proofFromImportedPayload(externalReportWithV2MarkedLaunchConfig),
    /not a v2 proof export/,
  );
  assert.throws(
    () => sandbox.proofFromImportedPayload(classicReportWithSpoofedV2Envelope),
    /Classic artifact/,
  );
  assert.throws(
    () => sandbox.proofFromImportedPayload(externalReportWithSpoofedV2Envelope),
    /does not contain a v2 launch proof/,
  );
  assert.throws(
    () => sandbox.proofFromImportedPayload(fieldVerificationOnlyProofPacket),
    /not a v2 proof export/,
  );
  assert.throws(
    () => sandbox.proofFromImportedPayload(retirementGateOnlyProofPacket),
    /not a v2 proof export/,
  );
  assert.throws(
    () => sandbox.proofFromImportedPayload(snapshotlessV2Payload),
    /launch-config snapshot/,
  );
  assert.throws(
    () => sandbox.proofFromImportedPayload(unmarkedConfigV2Payload),
    /launch-config snapshot/,
  );
  assert.throws(
    () => sandbox.proofFromImportedPayload(mixedMarkedEnvelopeUnmarkedProofPayload),
    /launch-config snapshot/,
  );

  const imported = sandbox.proofFromImportedPayload({
    ...v2PayloadForConfig,
    proof,
    launchData: { localDossier },
  });
  assert.deepEqual(imported.localDossier, localDossier);

  const importedWithMintlessDossier = sandbox.proofFromImportedPayload({
    ...v2PayloadForConfig,
    proof: { ...proof, localDossier: { ...localDossier, mint: undefined } },
    launchData: { localDossier: { ...localDossier, mint: undefined } },
  });
  assert.equal(importedWithMintlessDossier.localDossier, undefined);

  const importedWithReport = sandbox.proofFromImportedPayload({
    ...v2PayloadForConfig,
    proof: { ...proof, reportPublish },
    launchData: { reportPublish },
  });
  assert.deepEqual(importedWithReport.reportPublish, reportPublish);

  const importedWithMintlessReport = sandbox.proofFromImportedPayload({
    ...v2PayloadForConfig,
    proof: { ...proof, reportPublish: { ...reportPublish, mint: undefined } },
    launchData: { reportPublish: { ...reportPublish, mint: undefined } },
  });
  assert.equal(importedWithMintlessReport.reportPublish, undefined);

  const htmlPayload = {
    ...v2PayloadForConfig,
    proof: {
      ...proof,
      launchConfig: sandbox.exportableLaunchConfigSnapshot(importedConfig),
    },
    launchData: {
      name: 'Import <Token>',
      localDossier,
    },
  };
  const htmlText = `<html><body><script id="trebuchet-v2-proof" type="application/json">${JSON.stringify(htmlPayload).replace(/</g, '\\u003c')}</script></body></html>`;
  const payloadFromHtml = sandbox.proofPayloadFromImportText(htmlText);
  const importedFromHtml = sandbox.proofFromImportedPayload(payloadFromHtml);
  assert.deepEqual(importedFromHtml.localDossier, localDossier);
  assert.equal(importedFromHtml.launchConfig.poolTopology.sweepDestination, 'ImportedDest11111111111111111111111111111111');

  assert.throws(
    () => sandbox.proofFromImportedPayload({
      proof,
      launchData: {
        name: 'Import Token',
        poolTopology: launchConfig.poolTopology,
        localDossier,
      },
    }),
    /not a v2 proof export/,
  );
  assert.match(js, /function importedProofPayloadHasV2Provenance/);
  assert.match(js, /importedProofPayloadHasV2Provenance\(payload\)/);
  assert.match(js, /function importedProofPayloadHasClassicSource/);
  assert.match(js, /importedProofPayloadHasClassicSource\(payload, proof\)/);
  assert.match(js, /reportPublishFinalizationIssue\(record, proofWithCandidate \|\| proof, config\)/);
  assert.match(js, /localDossierFinalizationIssue\(record, proofWithCandidate \|\| proof, config\)/);

  const largeRows = Array.from({ length: 1205 }, (_, index) => ({
    wallet: `AirdropWallet${String(index).padStart(4, '0')}111111111111111111111111`,
    tokens: 100 + index,
    amountRaw: String((100 + index) * 1000000),
    txId: `AirdropTx${String(index).padStart(4, '0')}111111111111111111111111111`,
  }));
  const largeProof = {
    ...proof,
    launchConfig: sandbox.exportableLaunchConfigSnapshot({
      ...importedConfig,
      poolTopology: {
        ...(importedConfig.poolTopology || {}),
        airdrop: {
          enabled: true,
          recipientCount: largeRows.length,
          recipients: largeRows.map(({ txId, ...row }) => row),
        },
      },
    }),
    airdrop: {
      plannedRecipientCount: largeRows.length,
      deliveredCount: largeRows.length,
      failedCount: 0,
      recipients: largeRows.map(({ txId, ...row }) => row),
      transferred: largeRows,
      failed: [],
    },
  };
  const largeLaunchData = {
    dataVersion: 10,
    generatedAt: '2026-06-30T00:00:00.000Z',
    symbol: 'IMP',
    reportParityAudit: { status: 'pass', proofFingerprint: 'stale-proof' },
    classicRetirementGate: { state: 'pass', stale: true },
    fieldVerification: {
      source: 'trebuchet-v2-field-verification',
      proofFingerprint: 'stale-proof',
      ready: true,
      state: 'pass',
    },
    classicReportComparison: {
      status: 'pass',
      proofFingerprint: 'stale-proof',
      artifactSource: 'classic',
      fieldCount: 1,
      passCount: 1,
      rows: [{ id: 'mint', label: 'Token mint', state: 'pass' }],
    },
    proof: {
      ...largeProof,
      reportParity: {
        classicArtifactCompared: true,
        comparison: {
          status: 'pass',
          proofFingerprint: 'stale-proof',
          artifactSource: 'classic',
        },
      },
    },
    airdrop: largeProof.airdrop,
    poolTopology: {
      airdrop: {
        enabled: true,
        recipientCount: largeRows.length,
        recipients: largeRows.map(({ txId, ...row }) => row),
      },
    },
  };
  const fullPayload = sandbox.buildV2ProofExportPayload({
    proof: largeProof,
    config: importedConfig,
    launchData: largeLaunchData,
  });
  const compactPayload = sandbox.buildV2ProofExportPayload({
    proof: largeProof,
    config: importedConfig,
    launchData: largeLaunchData,
    compactForHtml: true,
  });
  const fullFingerprint = sandbox.launchProofFingerprint(largeProof, importedConfig);
  assert.equal(fullPayload.reportParityAudit.proofFingerprint, fullFingerprint);
  assert.equal(fullPayload.reportParityAudit.source, 'trebuchet-v2-report-parity-audit');
  assert.equal(fullPayload.launchData.reportParityAudit.proofFingerprint, fullFingerprint);
  assert.equal(fullPayload.fieldVerification.proofFingerprint, fullFingerprint);
  assert.equal(fullPayload.fieldVerification.ready, false);
  assert.equal(fullPayload.launchData.fieldVerification.proofFingerprint, fullFingerprint);
  assert.equal(fullPayload.classicRetirementGate.proofFingerprint, fullFingerprint);
  assert.equal(fullPayload.classicRetirementGate.state, 'danger');
  assert.equal(fullPayload.launchData.classicRetirementGate.proofFingerprint, fullFingerprint);
  assert.equal(fullPayload.launchData.classicRetirementGate.state, 'danger');
  assert.equal(fullPayload.classicReportComparison, null);
  assert.equal(fullPayload.launchData.classicReportComparison, undefined);
  assert.equal(fullPayload.launchData.proof, undefined);
  const forgedPassAuditPayload = sandbox.buildV2ProofExportPayload({
    proof: largeProof,
    config: importedConfig,
    launchData: {
      ...largeLaunchData,
      reportParityAudit: {
        version: 1,
        source: 'trebuchet-v2-report-parity-audit',
        status: 'pass',
        proofFingerprint: fullFingerprint,
        passCount: 1,
        warnCount: 0,
        missingCount: 0,
        itemCount: 1,
        items: [{ id: 'token-proof', label: 'Token proof', state: 'pass', detail: 'Forged pass row.' }],
      },
    },
  });
  assert.equal(forgedPassAuditPayload.reportParityAudit.status, 'warn');
  assert.equal(forgedPassAuditPayload.reportParityAudit.itemCount, 2);
  assert.equal(forgedPassAuditPayload.launchData.reportParityAudit.status, 'warn');
  assert.equal(forgedPassAuditPayload.classicRetirementGate.state, 'danger');
  const forgedAuditCopyPayload = sandbox.buildV2ProofExportPayload({
    proof: largeProof,
    config: importedConfig,
    launchData: {
      ...largeLaunchData,
      reportParityAudit: {
        ...fullPayload.reportParityAudit,
        items: fullPayload.reportParityAudit.items.map((item) => ({
          ...item,
          detail: `Forged canonical detail for ${item.id}.`,
        })),
      },
    },
  });
  assert.doesNotMatch(JSON.stringify(forgedAuditCopyPayload.reportParityAudit), /Forged canonical detail/);
  assert.doesNotMatch(JSON.stringify(forgedAuditCopyPayload.launchData.reportParityAudit), /Forged canonical detail/);
  const forgedReadyGatePayload = sandbox.buildV2ProofExportPayload({
    proof: largeProof,
    config: importedConfig,
    launchData: {
      ...largeLaunchData,
      reportParityAudit: fullPayload.reportParityAudit,
      classicRetirementGate: {
        source: 'trebuchet-v2-classic-retirement-gate',
        proofFingerprint: fullFingerprint,
        state: 'pass',
        passCount: 5,
        itemCount: 5,
        criteriaPassCount: 1,
        criteriaItemCount: 1,
        requirements: [
          { id: 'live-proof', pass: true, detail: 'Forged live proof.' },
          { id: 'report-proof', pass: true, detail: 'Forged report.' },
          { id: 'classic-comparison', pass: true, detail: 'Forged comparison.' },
          { id: 'audit', pass: true, detail: 'Forged audit.' },
          { id: 'replacement-criteria', pass: true, detail: 'Forged criteria.' },
        ],
        replacementCriteria: [{ id: 'classic-artifact-comparison', pass: true, evidence: 'Forged comparison.' }],
      },
      fieldVerification: {
        version: 1,
        source: 'trebuchet-v2-field-verification',
        proofFingerprint: fullFingerprint,
        state: 'pass',
        ready: true,
        passCount: 5,
        itemCount: 5,
        criteriaPassCount: 1,
        criteriaItemCount: 1,
        blockerCount: 0,
        criteriaBlockerCount: 0,
        nextAction: 'none',
        requirements: [{ id: 'live-proof', pass: true, detail: 'Forged live proof.' }],
        replacementCriteria: [{ id: 'classic-artifact-comparison', pass: true, detail: 'Forged comparison.' }],
      },
    },
  });
  assert.equal(forgedReadyGatePayload.classicRetirementGate.state, 'danger');
  assert.equal(forgedReadyGatePayload.launchData.classicRetirementGate.state, 'danger');
  assert.equal(forgedReadyGatePayload.fieldVerification.ready, false);
  assert.equal(forgedReadyGatePayload.launchData.fieldVerification.ready, false);
  const forgedGateCopyPayload = sandbox.buildV2ProofExportPayload({
    proof: largeProof,
    config: importedConfig,
    launchData: {
      ...largeLaunchData,
      reportParityAudit: fullPayload.reportParityAudit,
      classicRetirementGate: {
        ...fullPayload.classicRetirementGate,
        requirements: fullPayload.classicRetirementGate.requirements.map((item) => ({
          ...item,
          detail: `Forged canonical gate detail for ${item.id}.`,
        })),
        replacementCriteria: fullPayload.classicRetirementGate.replacementCriteria.map((item) => ({
          ...item,
          evidence: `Forged canonical gate evidence for ${item.id}.`,
          detail: `Forged canonical gate detail for ${item.id}.`,
        })),
      },
      fieldVerification: {
        ...fullPayload.fieldVerification,
        requirements: fullPayload.fieldVerification.requirements.map((item) => ({
          ...item,
          detail: `Forged canonical field detail for ${item.id}.`,
        })),
        replacementCriteria: fullPayload.fieldVerification.replacementCriteria.map((item) => ({
          ...item,
          detail: `Forged canonical field detail for ${item.id}.`,
        })),
      },
    },
  });
  assert.doesNotMatch(JSON.stringify(forgedGateCopyPayload.classicRetirementGate), /Forged canonical gate/);
  assert.doesNotMatch(JSON.stringify(forgedGateCopyPayload.launchData.classicRetirementGate), /Forged canonical gate/);
  assert.doesNotMatch(JSON.stringify(forgedGateCopyPayload.fieldVerification), /Forged canonical field/);
  assert.doesNotMatch(JSON.stringify(forgedGateCopyPayload.launchData.fieldVerification), /Forged canonical field/);
  assert.match(js, /function generatedEvidenceTextMatches/);
  assert.match(js, /generatedEvidenceTextMatches\(item, expectedItems\[index\], \['label', 'detail'\]\)/);
  assert.match(js, /generatedEvidenceTextMatches\(row, expectedRows\[index\], \['label', 'detail', 'evidence'\]\)/);
  assert.match(js, /generatedEvidenceTextMatches\(row, expectedRows\[index\], \['label', 'action', 'detail'\]\)/);
  sandbox.normalizeClassicReportComparison = (comparison = {}) => ({
    input: String(comparison.input || ''),
    result: comparison.result || null,
    comparedAt: comparison.comparedAt || comparison.result?.comparedAt || null,
    error: comparison.error || null,
  });
  sandbox.state.classicReportComparison = {
    input: '{"source":"classic","mint":"stale"}',
    result: {
      status: 'pass',
      proofFingerprint: 'stale-proof-fingerprint',
      artifactSource: 'classic',
      fieldCount: 1,
      passCount: 1,
      rows: [{ id: 'mint', label: 'Token mint', state: 'pass' }],
    },
  };
  const staleComparisonPayload = sandbox.buildV2ProofExportPayload({
    proof: largeProof,
    config: importedConfig,
    launchData: largeLaunchData,
  });
  assert.equal(staleComparisonPayload.classicReportComparison, null);
  const exportRequiredRows = sandbox.classicComparisonRequiredRows(largeProof, importedConfig).map((row) => ({
    ...row,
    state: 'pass',
  }));
  sandbox.state.classicReportComparison = {
    input: '{"schema":"trebuchet-v2-proof"}',
    result: {
      status: 'pass',
      proofFingerprint: fullFingerprint,
      artifactSource: 'trebuchet-v2',
      structuredEvidence: true,
      fieldCount: exportRequiredRows.length,
      passCount: exportRequiredRows.length,
      rows: exportRequiredRows,
    },
  };
  const selfArtifactComparisonPayload = sandbox.buildV2ProofExportPayload({
    proof: largeProof,
    config: importedConfig,
    launchData: largeLaunchData,
  });
  assert.equal(selfArtifactComparisonPayload.classicReportComparison, null);
  sandbox.state.classicReportComparison = {
    input: '{"source":"classic","mint":"thin"}',
    result: {
      status: 'pass',
      proofFingerprint: fullFingerprint,
      artifactSource: 'classic',
      structuredEvidence: true,
      fieldCount: 1,
      passCount: 1,
      rows: [{ id: 'mint', label: 'Token mint', state: 'pass' }],
    },
  };
  const thinComparisonPayload = sandbox.buildV2ProofExportPayload({
    proof: largeProof,
    config: importedConfig,
    launchData: largeLaunchData,
  });
  assert.equal(thinComparisonPayload.classicReportComparison, null);
  sandbox.state.classicReportComparison = {
    input: '{"source":"classic","mint":"current"}',
    comparedAt: '2026-06-30T00:00:00.000Z',
    result: {
      status: 'pass',
      proofFingerprint: fullFingerprint,
      artifactSource: 'classic',
      structuredEvidence: true,
      fieldCount: exportRequiredRows.length,
      passCount: exportRequiredRows.length,
      comparedAt: '2026-06-30T00:00:00.000Z',
      rows: exportRequiredRows,
    },
  };
  const matchingComparisonPayload = sandbox.buildV2ProofExportPayload({
    proof: largeProof,
    config: importedConfig,
    launchData: largeLaunchData,
  });
  assert.equal(matchingComparisonPayload.classicReportComparison.input, '{"source":"classic","mint":"current"}');
  assert.equal(matchingComparisonPayload.classicReportComparison.result.proofFingerprint, fullFingerprint);
  assert.equal(matchingComparisonPayload.launchData.classicReportComparison, undefined);
  const matchingLaunchDataComparisonPayload = sandbox.buildV2ProofExportPayload({
    proof: largeProof,
    config: importedConfig,
    launchData: {
      ...largeLaunchData,
      classicReportComparison: {
        status: 'pass',
        proofFingerprint: fullFingerprint,
        artifactSource: 'classic',
        structuredEvidence: true,
        fieldCount: exportRequiredRows.length,
        passCount: exportRequiredRows.length,
        rows: exportRequiredRows,
      },
      proof: {
        ...largeProof,
        reportParity: {
          classicArtifactCompared: true,
          comparison: {
            status: 'pass',
            proofFingerprint: 'stale-proof-fingerprint',
            artifactSource: 'classic',
          },
        },
      },
    },
  });
  assert.equal(matchingLaunchDataComparisonPayload.launchData.classicReportComparison.proofFingerprint, fullFingerprint);
  assert.equal(matchingLaunchDataComparisonPayload.launchData.proof, undefined);
  const staleProofComparisonPayload = sandbox.buildV2ProofExportPayload({
    proof: {
      ...largeProof,
      reportParity: {
        viewportSmoke: { passed: true },
        classicArtifactCompared: true,
        comparedAt: '2026-06-30T00:00:00.000Z',
        comparison: {
          status: 'pass',
          proofFingerprint: 'stale-proof-fingerprint',
          artifactSource: 'classic',
        },
        classicComparison: {
          status: 'pass',
          proofFingerprint: 'stale-proof-fingerprint',
          artifactSource: 'classic',
        },
      },
    },
    config: importedConfig,
    launchData: largeLaunchData,
  });
  assert.equal(staleProofComparisonPayload.proof.reportParity.viewportSmoke.passed, true);
  assert.equal(staleProofComparisonPayload.proof.reportParity.comparison, undefined);
  assert.equal(staleProofComparisonPayload.proof.reportParity.classicComparison, undefined);
  assert.equal(staleProofComparisonPayload.proof.reportParity.classicArtifactCompared, false);
  const selfProofComparisonPayload = sandbox.buildV2ProofExportPayload({
    proof: {
      ...largeProof,
      reportParity: {
        viewportSmoke: { passed: true },
        classicArtifactCompared: true,
        comparison: {
          status: 'pass',
          proofFingerprint: fullFingerprint,
          artifactSource: 'trebuchet-v2',
          structuredEvidence: true,
          fieldCount: exportRequiredRows.length,
          passCount: exportRequiredRows.length,
          rows: exportRequiredRows,
        },
      },
    },
    config: importedConfig,
    launchData: largeLaunchData,
  });
  assert.equal(selfProofComparisonPayload.proof.reportParity.comparison, undefined);
  assert.equal(selfProofComparisonPayload.proof.reportParity.classicArtifactCompared, false);
  const thinProofComparisonPayload = sandbox.buildV2ProofExportPayload({
    proof: {
      ...largeProof,
      reportParity: {
        viewportSmoke: { passed: true },
        classicArtifactCompared: true,
        comparison: {
          status: 'pass',
          proofFingerprint: fullFingerprint,
          artifactSource: 'classic',
          structuredEvidence: true,
          fieldCount: 1,
          passCount: 1,
          rows: [{ id: 'mint', label: 'Token mint', state: 'pass' }],
        },
      },
    },
    config: importedConfig,
    launchData: largeLaunchData,
  });
  assert.equal(thinProofComparisonPayload.proof.reportParity.comparison, undefined);
  assert.equal(thinProofComparisonPayload.proof.reportParity.classicArtifactCompared, false);
  const matchingProofComparisonPayload = sandbox.buildV2ProofExportPayload({
    proof: {
      ...largeProof,
      reportParity: {
        viewportSmoke: { passed: true },
        classicArtifactCompared: true,
        comparison: {
          status: 'pass',
          proofFingerprint: fullFingerprint,
          artifactSource: 'classic',
          structuredEvidence: true,
          fieldCount: exportRequiredRows.length,
          passCount: exportRequiredRows.length,
          rows: exportRequiredRows,
        },
      },
    },
    config: importedConfig,
    launchData: largeLaunchData,
  });
  assert.equal(matchingProofComparisonPayload.proof.reportParity.comparison.proofFingerprint, fullFingerprint);
  assert.equal(matchingProofComparisonPayload.proof.reportParity.classicArtifactCompared, true);
  assert.match(js, /function proofExportParityBundle/);
  assert.match(js, /function classicReportComparisonForProofExport/);
  assert.match(js, /function pruneLaunchProofEvidenceArtifactsForExport/);
  assert.match(js, /classicComparisonIsRetirementGrade\(normalized\.result, proof, config\)/);
  assert.match(js, /classicRetirementGateMatchesProof\(dataGate, proof, audit, proofConfig\)/);
  assert.match(js, /dataGate\?\.proofFingerprint === expectedFingerprint/);
  assert.match(js, /fieldVerificationMatchesProof\(dataFieldVerification, proof, proofConfig, audit, retirementGate\)/);
  assert.match(js, /fieldVerification: parityBundle\.fieldVerification/);
  assert.equal(compactPayload.proof.airdrop.recipients.length, 0);
  assert.equal(compactPayload.proof.airdrop.recipientsSample.length, 100);
  assert.equal(compactPayload.proof.airdrop.transferred.length, 0);
  assert.equal(compactPayload.proof.airdrop.transferredSample.length, 100);
  assert.equal(compactPayload.proof.launchConfig.poolTopology.airdrop.recipients.length, 0);
  assert.equal(compactPayload.proof.launchConfig.poolTopology.airdrop.recipientsSample.length, 100);
  assert.equal(compactPayload.launchConfig.poolTopology.airdrop.recipients.length, 0);
  assert.equal(compactPayload.launchConfig.poolTopology.airdrop.recipientsSample.length, 100);
  assert.equal(compactPayload.launchData.poolTopology.airdrop.recipients.length, 0);
  assert.equal(compactPayload.launchData.poolTopology.airdrop.recipientsSample.length, 100);
  assert.equal(sandbox.launchProofFingerprint(compactPayload.proof, importedConfig), fullFingerprint);
  assert.ok(JSON.stringify(compactPayload).length < JSON.stringify(fullPayload).length / 3);

  const staleDossier = {
    ...localDossier,
    filename: 'trebuchet-stale-dossier.html',
    proofFingerprint: 'stale-proof-fingerprint',
  };
  const staleImport = sandbox.proofFromImportedPayload({
    ...v2PayloadForConfig,
    proof: { ...proof, localDossier: staleDossier },
    launchData: { localDossier: staleDossier },
  });
  assert.equal(staleImport.localDossier, undefined);

  const staleReport = {
    ...reportPublish,
    htmlUri: 'ar://trebuchet-stale-report',
    proofFingerprint: 'stale-proof-fingerprint',
  };
  const staleReportImport = sandbox.proofFromImportedPayload({
    ...v2PayloadForConfig,
    proof: { ...proof, reportPublish: staleReport },
    launchData: { reportPublish: staleReport },
  });
  assert.equal(staleReportImport.reportPublish, undefined);

  const uriLessReport = {
    ...reportPublish,
    htmlUri: undefined,
    jsonUri: undefined,
  };
  const uriLessReportImport = sandbox.proofFromImportedPayload({
    ...v2PayloadForConfig,
    proof: { ...proof, reportPublish: uriLessReport },
    launchData: { reportPublish: uriLessReport },
  });
  assert.equal(uriLessReportImport.reportPublish, undefined);

  const metadataThinDossier = {
    ...localDossier,
    downloadedAt: undefined,
  };
  const metadataThinImport = sandbox.proofFromImportedPayload({
    ...v2PayloadForConfig,
    proof: { ...proof, localDossier: metadataThinDossier },
    launchData: { localDossier: metadataThinDossier },
  });
  assert.equal(metadataThinImport.localDossier, undefined);

  const mismatchedExtensionDossier = {
    ...localDossier,
    kind: 'local-proof-json',
    filename: 'trebuchet-imp-dossier.html',
  };
  const mismatchedExtensionImport = sandbox.proofFromImportedPayload({
    ...v2PayloadForConfig,
    proof: { ...proof, localDossier: mismatchedExtensionDossier },
    launchData: { localDossier: mismatchedExtensionDossier },
  });
  assert.equal(mismatchedExtensionImport.localDossier, undefined);

  const terminalTransfer = {
    destinationWallet: launchConfig.poolTopology.sweepDestination,
    walletEmpty: true,
    solSweep: {
      solTransferred: 0.001,
      txId: 'SolSweepImport111111111111111111111111111111',
    },
  };
  const terminalProof = {
    ...proof,
    status: 'completed',
    stage: 'transfer_completed',
    launchConfig: sandbox.exportableLaunchConfigSnapshot(importedConfig),
    transfer: terminalTransfer,
  };
  const terminalConfig = sandbox.importedProofComparisonConfig({
    ...v2PayloadForConfig,
    proof: terminalProof,
  });
  const terminalDossier = {
    ...localDossier,
    proofFingerprint: sandbox.launchProofFingerprint(terminalProof, terminalConfig),
  };
  const terminalReport = {
    ...reportPublish,
    htmlUri: 'ar://trebuchet-terminal-report',
    proofFingerprint: sandbox.launchProofFingerprint(terminalProof, terminalConfig),
  };
  const terminalImportWithoutSweepHash = sandbox.proofFromImportedPayload({
    ...v2PayloadForConfig,
    proof: { ...terminalProof, localDossier: terminalDossier, reportPublish: terminalReport },
    launchData: { localDossier: terminalDossier, reportPublish: terminalReport },
  });
  assert.equal(terminalImportWithoutSweepHash.localDossier, undefined);
  assert.equal(terminalImportWithoutSweepHash.reportPublish, undefined);

  const terminalDossierWithSweepHash = {
    ...terminalDossier,
    sweepEvidenceHash: sandbox.comparisonTransferEvidenceHash(terminalTransfer),
  };
  const terminalReportWithSweepHash = {
    ...terminalReport,
    sweepEvidenceHash: sandbox.comparisonTransferEvidenceHash(terminalTransfer),
  };
  const terminalImportWithSweepHash = sandbox.proofFromImportedPayload({
    ...v2PayloadForConfig,
    proof: { ...terminalProof, localDossier: terminalDossierWithSweepHash, reportPublish: terminalReportWithSweepHash },
    launchData: { localDossier: terminalDossierWithSweepHash, reportPublish: terminalReportWithSweepHash },
  });
  assert.deepEqual(terminalImportWithSweepHash.localDossier, terminalDossierWithSweepHash);
  assert.deepEqual(terminalImportWithSweepHash.reportPublish, terminalReportWithSweepHash);
});

test('v2 proof merge drops stale report artifacts after terminal sweep evidence changes', () => {
  const sandbox = loadProofMergeHarness();
  const baseProof = {
    walletPublicKey: 'MergeWallet11111111111111111111111111111111',
    token: { mint: 'MergeMint111111111111111111111111111111111' },
    expectedFingerprint: 'proof-bound',
    launchConfig: {
      poolTopology: {
        sweepDestination: 'MergeDest11111111111111111111111111111111',
      },
    },
  };
  const preSweepReport = {
    status: 'done',
    htmlUri: 'ar://merge-pre-sweep-report',
    mint: baseProof.token.mint,
    proofFingerprint: 'proof-bound',
  };
  const preSweepDossier = {
    status: 'downloaded',
    kind: 'local-dossier-html',
    filename: 'trebuchet-merge-dossier.html',
    mint: baseProof.token.mint,
    downloadedAt: '2026-06-30T00:00:00.000Z',
    dataVersion: 13,
    proofFingerprint: 'proof-bound',
  };
  const terminalProof = {
    ...baseProof,
    status: 'completed',
    stage: 'transfer_completed',
    terminalSweepHash: 'terminal-sweep-hash',
    transfer: {
      destinationWallet: 'MergeDest11111111111111111111111111111111',
      walletEmpty: true,
    },
  };

  const retainedPreSweep = sandbox.mergeLaunchProofEvidence({
    ...baseProof,
    reportPublish: preSweepReport,
    localDossier: preSweepDossier,
  }, terminalProof);
  assert.equal(retainedPreSweep.reportPublish, undefined);
  assert.equal(retainedPreSweep.localDossier, undefined);

  const wrongIncoming = sandbox.mergeLaunchProofEvidence(baseProof, {
    ...terminalProof,
    reportPublish: {
      ...preSweepReport,
      htmlUri: 'ar://merge-wrong-sweep-report',
      sweepEvidenceHash: 'wrong-sweep-hash',
    },
    localDossier: {
      ...preSweepDossier,
      sweepEvidenceHash: 'wrong-sweep-hash',
    },
  });
  assert.equal(wrongIncoming.reportPublish, undefined);
  assert.equal(wrongIncoming.localDossier, undefined);

  const mintlessIncoming = sandbox.mergeLaunchProofEvidence(baseProof, {
    ...terminalProof,
    reportPublish: {
      ...preSweepReport,
      htmlUri: 'ar://merge-mintless-report',
      mint: undefined,
      sweepEvidenceHash: 'terminal-sweep-hash',
    },
    localDossier: {
      ...preSweepDossier,
      mint: undefined,
      sweepEvidenceHash: 'terminal-sweep-hash',
    },
  });
  assert.equal(mintlessIncoming.reportPublish, undefined);
  assert.equal(mintlessIncoming.localDossier, undefined);

  const boundIncoming = sandbox.mergeLaunchProofEvidence(baseProof, {
    ...terminalProof,
    reportPublish: {
      ...preSweepReport,
      htmlUri: 'ar://merge-terminal-report',
      sweepEvidenceHash: 'terminal-sweep-hash',
    },
    localDossier: {
      ...preSweepDossier,
      sweepEvidenceHash: 'terminal-sweep-hash',
    },
  });
  assert.equal(boundIncoming.reportPublish.htmlUri, 'ar://merge-terminal-report');
  assert.equal(boundIncoming.localDossier.sweepEvidenceHash, 'terminal-sweep-hash');

  sandbox.comparisonConfigCalls.length = 0;
  const retainedExistingComparison = sandbox.mergeLaunchProofEvidence({
    ...baseProof,
    reportParity: {
      classicArtifactCompared: true,
      comparison: {
        status: 'pass',
        proofFingerprint: 'proof-bound',
      },
    },
  }, {
    ...baseProof,
    liquidity: { complete: true },
  });
  assert.equal(retainedExistingComparison.reportParity?.comparison?.proofFingerprint, 'proof-bound');
  assert.ok(
    sandbox.comparisonConfigCalls.some((call) => call.config === call.proof.launchConfig),
    'proof merge should validate preserved Classic comparison evidence against the merged proof config',
  );

  const newIdentityIncoming = sandbox.mergeLaunchProofEvidence(baseProof, {
    ...terminalProof,
    token: { mint: 'NewMergeMint111111111111111111111111111111' },
    expectedFingerprint: 'new-proof-bound',
    reportPublish: {
      ...preSweepReport,
      htmlUri: 'ar://merge-new-identity-stale-report',
      sweepEvidenceHash: 'terminal-sweep-hash',
    },
    localDossier: {
      ...preSweepDossier,
      sweepEvidenceHash: 'terminal-sweep-hash',
    },
    reportParity: {
      viewportSmoke: { passed: true },
      comparison: {
        status: 'pass',
        proofFingerprint: 'proof-bound',
      },
      classicComparison: {
        status: 'pass',
        proofFingerprint: 'proof-bound',
      },
    },
  });
  assert.equal(newIdentityIncoming.reportPublish, undefined);
  assert.equal(newIdentityIncoming.localDossier, undefined);
  assert.equal(newIdentityIncoming.reportParity?.viewportSmoke?.passed, true);
  assert.equal(newIdentityIncoming.reportParity?.comparison, undefined);
  assert.equal(newIdentityIncoming.reportParity?.classicComparison, undefined);

  const legacyAliasIncoming = sandbox.mergeLaunchProofEvidence(null, {
    ...terminalProof,
    reportParity: {
      classicArtifactCompared: true,
      comparedAt: '2026-06-30T00:00:00.000Z',
      classicComparison: {
        status: 'pass',
        proofFingerprint: 'proof-bound',
      },
    },
  });
  assert.equal(legacyAliasIncoming.reportParity?.comparison?.status, 'pass');
  assert.equal(legacyAliasIncoming.reportParity?.classicComparison?.status, 'pass');

  const mixedAliasIncoming = sandbox.mergeLaunchProofEvidence(null, {
    ...terminalProof,
    reportParity: {
      classicArtifactCompared: true,
      comparison: {
        status: 'pass',
        proofFingerprint: 'proof-bound',
      },
      classicComparison: {
        status: 'pass',
        proofFingerprint: 'stale-proof',
      },
    },
  });
  assert.equal(mixedAliasIncoming.reportParity?.comparison?.proofFingerprint, 'proof-bound');
  assert.equal(mixedAliasIncoming.reportParity?.classicComparison, undefined);

  assert.match(js, /reportPublishFinalizationIssue\(existing\.reportPublish, merged, mergedConfig\)/);
  assert.match(js, /localDossierFinalizationIssue\(existing\.localDossier, merged, mergedConfig\)/);
  assert.match(js, /function reportParityClassicComparison/);
  assert.match(js, /function pruneLaunchProofEvidenceArtifacts/);
  assert.match(js, /classicComparisonMatchesProof\(comparison, merged, mergedConfig\)/);
  assert.match(js, /return pruneLaunchProofEvidenceArtifacts\(incoming, incomingConfig\)/);
  assert.match(js, /return pruneLaunchProofEvidenceArtifacts\(merged, mergedConfig\)/);
  assert.match(js, /delete merged\.reportPublish/);
  assert.match(js, /delete merged\.localDossier/);
});

test('v2 stored proof restore prunes stale terminal report artifacts', () => {
  const sandbox = loadStoredProofHarness();
  const savedAt = Date.now();
  const staleReport = {
    status: 'done',
    htmlUri: 'ar://stored-stale-report',
    proofFingerprint: 'proof-bound',
  };
  const staleDossier = {
    status: 'downloaded',
    kind: 'local-dossier-html',
    filename: 'trebuchet-stale-dossier.html',
    downloadedAt: '2026-06-30T00:00:00.000Z',
    dataVersion: 13,
    proofFingerprint: 'proof-bound',
  };
  const terminalProof = {
    expectedFingerprint: 'proof-bound',
    token: { mint: 'StoredMint11111111111111111111111111111111' },
    terminalSweepHash: 'stored-terminal-sweep',
    transfer: {
      destinationWallet: 'StoredDest111111111111111111111111111111',
      walletEmpty: true,
    },
    reportPublish: staleReport,
    localDossier: staleDossier,
  };

  const staleOnly = sandbox.normalizeStoredLaunchProof({
    proof: {
      expectedFingerprint: 'proof-bound',
      terminalSweepHash: 'stored-terminal-sweep',
      reportPublish: staleReport,
      localDossier: staleDossier,
    },
    savedAt,
  });
  assert.equal(staleOnly, null);

  sandbox.storage.set(sandbox.LAUNCH_PROOF_STORAGE_KEY, JSON.stringify({ proof: { token: { mint: 'OldStoredMint11111111111111111111111111111' } }, savedAt }));
  sandbox.persistLaunchProof({
    expectedFingerprint: 'proof-bound',
    terminalSweepHash: 'stored-terminal-sweep',
    reportPublish: staleReport,
    localDossier: staleDossier,
  });
  assert.equal(sandbox.storage.has(sandbox.LAUNCH_PROOF_STORAGE_KEY), false);

  const normalized = sandbox.normalizeStoredLaunchProof({ proof: terminalProof, savedAt });
  assert.ok(normalized);
  assert.equal(normalized.proof.reportPublish, undefined);
  assert.equal(normalized.proof.localDossier, undefined);
  assert.equal(normalized.proof.token.mint, terminalProof.token.mint);

  sandbox.storage.set(sandbox.LAUNCH_PROOF_STORAGE_KEY, JSON.stringify({ proof: terminalProof, savedAt }));
  sandbox.restoreLaunchProof();
  assert.equal(sandbox.state.launchProof.reportPublish, undefined);
  assert.equal(sandbox.state.launchProof.localDossier, undefined);
  assert.equal(sandbox.state.lastReportPublish, null);
  assert.equal(sandbox.state.lastLocalDossier, null);

  const boundReport = {
    ...staleReport,
    htmlUri: 'ar://stored-bound-report',
    mint: terminalProof.token.mint,
    sweepEvidenceHash: 'stored-terminal-sweep',
  };
  const boundDossier = {
    ...staleDossier,
    mint: terminalProof.token.mint,
    sweepEvidenceHash: 'stored-terminal-sweep',
  };
  const boundProof = {
    ...terminalProof,
    reportPublish: boundReport,
    localDossier: boundDossier,
  };
  sandbox.storage.set(sandbox.LAUNCH_PROOF_STORAGE_KEY, JSON.stringify({ proof: boundProof, savedAt }));
  sandbox.restoreLaunchProof();
  assert.deepEqual(sandbox.state.launchProof.reportPublish, boundReport);
  assert.deepEqual(sandbox.state.launchProof.localDossier, boundDossier);
  assert.deepEqual(sandbox.state.lastReportPublish, boundReport);
  assert.deepEqual(sandbox.state.lastLocalDossier, boundDossier);

  assert.match(js, /function storedLaunchProofConfig/);
  assert.match(js, /function storedLaunchProofHasSignal/);
  assert.match(js, /function pruneStoredLaunchProofArtifacts/);
  assert.match(js, /storage\.removeItem\(LAUNCH_PROOF_STORAGE_KEY\)/);
  assert.match(js, /state\.lastReportPublish = reportPublishIsProofCurrent\(normalized\.proof\?\.reportPublish, normalized\.proof, proofConfig\)/);
  assert.match(js, /state\.lastLocalDossier = localDossierIsProofCurrent\(normalized\.proof\?\.localDossier, normalized\.proof, proofConfig\)/);
  assert.match(js, /state\.lastReportPublish = reportPublishIsProofCurrent\(state\.launchProof\?\.reportPublish, state\.launchProof, proofConfig\)/);
  assert.match(js, /state\.lastLocalDossier = localDossierIsProofCurrent\(state\.launchProof\?\.localDossier, state\.launchProof, proofConfig\)/);
  assert.match(js, /state\.lastReportPublish = null/);
});

test('v2 stored proof restore uses the proof-bound launch config', () => {
  const sandbox = loadStoredProofHarness();
  const savedAt = Date.now();
  const proofMint = 'ProofConfigMint111111111111111111111111111111';
  const report = {
    status: 'done',
    htmlUri: 'ar://stored-proof-bound-report',
    mint: proofMint,
    proofFingerprint: 'proof-bound',
    requiresProofBoundConfig: true,
  };
  const dossier = {
    status: 'downloaded',
    kind: 'local-dossier-html',
    filename: 'trebuchet-proof-bound-dossier.html',
    mint: proofMint,
    downloadedAt: '2026-06-30T00:00:00.000Z',
    dataVersion: 14,
    proofFingerprint: 'proof-bound',
    requiresProofBoundConfig: true,
  };
  const proof = {
    expectedFingerprint: 'proof-bound',
    launchConfig: {
      token: { symbol: 'PROOF' },
      poolTopology: { sweepDestination: 'ProofDest111111111111111111111111111111' },
    },
    token: { mint: proofMint },
    reportPublish: report,
    localDossier: dossier,
  };

  assert.equal(sandbox.storedLaunchProofConfig(proof).proofBoundConfig, true);
  assert.equal(sandbox.state.currentConfig.token.symbol, 'FORM');

  const normalized = sandbox.normalizeStoredLaunchProof({ proof, savedAt });
  assert.ok(normalized);
  assert.deepEqual(normalized.proof.reportPublish, report);
  assert.deepEqual(normalized.proof.localDossier, dossier);

  sandbox.storage.set(sandbox.LAUNCH_PROOF_STORAGE_KEY, JSON.stringify({ proof, savedAt }));
  sandbox.restoreLaunchProof();
  assert.deepEqual(sandbox.state.launchProof.reportPublish, report);
  assert.deepEqual(sandbox.state.launchProof.localDossier, dossier);
  assert.deepEqual(sandbox.state.lastReportPublish, report);
  assert.deepEqual(sandbox.state.lastLocalDossier, dossier);

  assert.match(js, /const rawProofConfig = storedLaunchProofConfig\(rawProof\)/);
  assert.match(js, /const proofConfig = storedLaunchProofConfig\(parsedProof, rawProofConfig\)/);
  assert.match(js, /pruneStoredLaunchProofArtifacts\(parsedProof, proofConfig\)/);
});

test('v2 report fingerprints stay bound to the proof launch config snapshot', () => {
  const {
    launchProofFingerprint,
    proofConfigForFingerprint,
    currentReportPublish,
    currentLocalDossier,
    staleReportPublishForProof,
    reportPublishMatchesProof,
    reportPublishHasPermanentEvidence,
    reportArtifactMatchesTerminalSweep,
    comparisonTransferEvidenceHash,
  } = loadClassicComparisonHarness();
  const proof = {
    walletPublicKey: 'WalletSnapshot1111111111111111111111111111111',
    launchConfig: {
      poolTopology: {
        sweepDestination: 'ExportedDest111111111111111111111111111111111',
      },
    },
    token: {
      mint: 'MintSnapshot1111111111111111111111111111111111',
      mintAuthorityRenounced: true,
      freezeAuthorityDisabled: true,
      metadataUpdateAuthorityRevoked: true,
      metadataImmutable: true,
    },
    liquidity: {
      poolIds: ['PoolSnapshot1111111111111111111111111111111111'],
      lockedPositionCount: 0,
      feeKeyCount: 0,
      results: [{
        poolId: 'PoolSnapshot1111111111111111111111111111111111',
      }],
    },
    airdrop: {
      plannedRecipientCount: 0,
      deliveredCount: 0,
      failedCount: 0,
    },
    reportPublish: {
      status: 'done',
      htmlUri: 'ar://snapshot-report',
      proofFingerprint: 'stored-report-fingerprint',
    },
  };
  const currentTypedConfig = {
    poolTopology: {
      sweepDestination: 'TypedDest11111111111111111111111111111111111',
    },
  };
  const typedOnlyProof = { ...proof, launchConfig: null };
  const uriLessReportProof = {
    ...proof,
    reportPublish: { status: 'done', proofFingerprint: 'uri-less-fingerprint' },
  };
  const draftProof = {
    ...proof,
    reportPublish: null,
    transfer: null,
    launchConfig: {
      poolTopology: {
        sweepDestination: 'DraftDest1111111111111111111111111111111111',
      },
    },
  };
  const plannedTransferProof = {
    ...draftProof,
    transfer: {
      status: 'planned-before-sweep',
      destinationWallet: 'PlannedDest11111111111111111111111111111111',
    },
  };
  const sweptTransferProof = {
    ...draftProof,
    transfer: {
      destinationWallet: currentTypedConfig.poolTopology.sweepDestination,
      walletEmpty: true,
      solTransferred: 0.42,
      solSweep: {
        solTransferred: 0.42,
        txId: 'SweepTxSnapshot1111111111111111111111111111111',
      },
      tokenSweep: {
        transferred: [{
          mint: 'TokenSweepMint111111111111111111111111111111',
          amount: '1000',
          txId: 'TokenSweepTxSnapshot11111111111111111111111',
        }],
        errors: [],
      },
      nftSweep: { transferred: [], errors: [] },
    },
  };
  const partialTransferProof = {
    ...draftProof,
    transfer: {
      destinationWallet: 'PartialTransferDest1111111111111111111111111',
      tokenSweep: {
        transferred: [{
          mint: 'TokenSweepMint111111111111111111111111111111',
          amount: '1000',
          txId: 'PartialTokenSweepTxSnapshot11111111111111111111',
        }],
        errors: [],
      },
    },
  };
  const proofBoundSnapshotProof = {
    ...proof,
    reportPublish: { ...proof.reportPublish, mint: proof.token.mint },
  };
  proofBoundSnapshotProof.reportPublish.proofFingerprint = launchProofFingerprint(
    proofBoundSnapshotProof,
    proofBoundSnapshotProof.launchConfig,
  );
  const snapshotFingerprint = launchProofFingerprint(proof, currentTypedConfig);
  const proofBoundSnapshotFingerprint = launchProofFingerprint(proofBoundSnapshotProof, currentTypedConfig);
  const typedFingerprint = launchProofFingerprint(typedOnlyProof, currentTypedConfig);
  const uriLessReportFingerprint = launchProofFingerprint(uriLessReportProof, currentTypedConfig);
  const draftFingerprint = launchProofFingerprint(draftProof, currentTypedConfig);
  const plannedTransferFingerprint = launchProofFingerprint(plannedTransferProof, currentTypedConfig);
  const sweptTransferFingerprint = launchProofFingerprint(sweptTransferProof, currentTypedConfig);
  const partialTransferFingerprint = launchProofFingerprint(partialTransferProof, currentTypedConfig);
  const plannedTransferEvidenceHash = comparisonTransferEvidenceHash(plannedTransferProof.transfer);
  const sweptTransferEvidenceHash = comparisonTransferEvidenceHash(sweptTransferProof.transfer);
  const partialTransferEvidenceHash = comparisonTransferEvidenceHash(partialTransferProof.transfer);
  const currentTypedFullConfig = {
    token: { name: 'Typed Token', symbol: 'TYPED', supply: '1' },
    poolTopology: {
      sweepDestination: currentTypedConfig.poolTopology.sweepDestination,
      pools: [{ quoteMint: 'TypedQuote1111111111111111111111111111111', supplyPercent: 1 }],
    },
  };
  const snapshotConfigProof = {
    ...proof,
    reportPublish: null,
    launchConfig: {
      token: { name: 'Snapshot Token', symbol: 'SNAP', supply: '1000' },
      poolTopology: {
        sweepDestination: 'SnapshotDest1111111111111111111111111111111',
        pools: [{ quoteMint: 'SnapshotQuote111111111111111111111111111', supplyPercent: 100 }],
      },
    },
  };
  const boundDraftConfig = proofConfigForFingerprint(snapshotConfigProof, currentTypedFullConfig);
  assert.equal(boundDraftConfig.token.symbol, 'SNAP');
  assert.equal(boundDraftConfig.poolTopology.pools[0].quoteMint, 'SnapshotQuote111111111111111111111111111');
  assert.equal(boundDraftConfig.poolTopology.sweepDestination, currentTypedConfig.poolTopology.sweepDestination);
  const unboundReportMissingDestinationConfig = proofConfigForFingerprint({
    ...snapshotConfigProof,
    reportPublish: { status: 'done', htmlUri: 'ar://snapshot-report' },
    launchConfig: {
      token: snapshotConfigProof.launchConfig.token,
      poolTopology: { pools: snapshotConfigProof.launchConfig.poolTopology.pools },
    },
  }, currentTypedFullConfig);
  assert.equal(unboundReportMissingDestinationConfig.poolTopology.sweepDestination, currentTypedConfig.poolTopology.sweepDestination);
  const proofBoundMissingDestinationProof = {
    ...snapshotConfigProof,
    launchConfig: {
      token: snapshotConfigProof.launchConfig.token,
      poolTopology: { pools: snapshotConfigProof.launchConfig.poolTopology.pools },
    },
    reportPublish: { status: 'done', htmlUri: 'ar://snapshot-report' },
  };
  proofBoundMissingDestinationProof.reportPublish.proofFingerprint = launchProofFingerprint(
    proofBoundMissingDestinationProof,
    proofBoundMissingDestinationProof.launchConfig,
  );
  const mintlessFinalizedMissingDestinationConfig = proofConfigForFingerprint(
    proofBoundMissingDestinationProof,
    currentTypedFullConfig,
  );
  assert.equal(mintlessFinalizedMissingDestinationConfig.poolTopology.sweepDestination, currentTypedConfig.poolTopology.sweepDestination);

  const proofBoundMintedMissingDestinationProof = {
    ...proofBoundMissingDestinationProof,
    reportPublish: {
      ...proofBoundMissingDestinationProof.reportPublish,
      mint: proofBoundMissingDestinationProof.token.mint,
    },
  };
  proofBoundMintedMissingDestinationProof.reportPublish.proofFingerprint = launchProofFingerprint(
    proofBoundMintedMissingDestinationProof,
    proofBoundMintedMissingDestinationProof.launchConfig,
  );
  const finalizedMissingDestinationConfig = proofConfigForFingerprint(
    proofBoundMintedMissingDestinationProof,
    currentTypedFullConfig,
  );
  assert.equal(finalizedMissingDestinationConfig.poolTopology.sweepDestination, undefined);

  assert.equal(snapshotFingerprint, typedFingerprint);
  assert.notEqual(proofBoundSnapshotFingerprint, typedFingerprint);
  assert.notEqual(sweptTransferFingerprint, draftFingerprint);
  assert.equal(partialTransferFingerprint, draftFingerprint);
  assert.notEqual(plannedTransferEvidenceHash, sweptTransferEvidenceHash);
  assert.notEqual(partialTransferEvidenceHash, sweptTransferEvidenceHash);
  assert.ok(sweptTransferEvidenceHash);
  assert.ok(partialTransferEvidenceHash);
  assert.match(sweptTransferFingerprint, new RegExp(sweptTransferEvidenceHash));
  assert.match(sweptTransferFingerprint, /"terminalTransferEvidenceHash"/);
  assert.match(draftFingerprint, /"terminalTransferEvidenceHash":null/);
  assert.match(snapshotFingerprint, /TypedDest11111111111111111111111111111111111/);
  assert.doesNotMatch(snapshotFingerprint, /ExportedDest111111111111111111111111111111111/);
  assert.match(proofBoundSnapshotFingerprint, /ExportedDest111111111111111111111111111111111/);
  assert.match(typedFingerprint, /TypedDest11111111111111111111111111111111111/);
  assert.match(uriLessReportFingerprint, /TypedDest11111111111111111111111111111111111/);
  assert.doesNotMatch(uriLessReportFingerprint, /ExportedDest111111111111111111111111111111111/);
  assert.match(draftFingerprint, /TypedDest11111111111111111111111111111111111/);
  assert.doesNotMatch(draftFingerprint, /DraftDest1111111111111111111111111111111111/);
  assert.match(plannedTransferFingerprint, /TypedDest11111111111111111111111111111111111/);
  assert.doesNotMatch(plannedTransferFingerprint, /PlannedDest11111111111111111111111111111111/);
  assert.match(partialTransferFingerprint, /TypedDest11111111111111111111111111111111111/);
  assert.doesNotMatch(partialTransferFingerprint, /PartialTransferDest1111111111111111111111111/);
  assert.equal(reportPublishHasPermanentEvidence({ status: 'done' }), false);
  assert.equal(reportPublishHasPermanentEvidence({ status: 'done', htmlUri: 'ar://report' }), true);
  assert.match(js, /sweepEvidenceHash/);
  assert.match(js, /reportArtifactMatchesTerminalSweep\(reportArtifactRecord, proof\)/);
  assert.match(js, /const terminalTransferDestination = transferHasWalletEmptyFinalSweepEvidence\(transfer\)/);
  assert.match(js, /const terminalTransferEvidenceHash = transferHasWalletEmptyFinalSweepEvidence\(transfer\)/);
  assert.match(js, /destinationWallet: terminalTransferDestination \|\| proof\?\.destinationWallet \|\| config\?\.poolTopology\?\.sweepDestination \|\| null/);
  assert.match(js, /terminalTransferEvidenceHash,/);
  assert.match(js, /\|\| transferHasWalletEmptyFinalSweepEvidence\(proof\?\.transfer\)/);
  assert.match(js, /function comparisonTransferEvidenceHash\(transfer = \{\}\)/);
  assert.match(js, /renderV2ReportFactRow\('Sweep evidence hash', transferEvidenceHash \|\| '-'\)/);
  assert.doesNotMatch(js, /token:\s*\{\s*\.\.\.\(config\?\.token \|\| \{\}\),/);
  assert.doesNotMatch(js, /poolTopology:\s*\{\s*\.\.\.\(config\?\.poolTopology \|\| \{\}\),/);
  assert.equal(reportPublishMatchesProof({ proofFingerprint: snapshotFingerprint }, proof, currentTypedConfig), true);
  assert.equal(reportPublishMatchesProof({ proofFingerprint: proofBoundSnapshotFingerprint }, proofBoundSnapshotProof, currentTypedConfig), true);
  assert.equal(reportPublishMatchesProof({ proofFingerprint: typedFingerprint }, proofBoundSnapshotProof, currentTypedConfig), false);

  const terminalReportMissingSweep = {
    ...sweptTransferProof,
    reportPublish: {
      status: 'done',
      mint: sweptTransferProof.token.mint,
      htmlUri: 'ar://terminal-report-missing-sweep',
      proofFingerprint: sweptTransferFingerprint,
    },
  };
  const terminalReportWrongSweep = {
    ...sweptTransferProof,
    reportPublish: {
      status: 'done',
      mint: sweptTransferProof.token.mint,
      htmlUri: 'ar://terminal-report-wrong-sweep',
      proofFingerprint: sweptTransferFingerprint,
      sweepEvidenceHash: partialTransferEvidenceHash,
    },
  };
  const terminalReportWithSweep = {
    ...sweptTransferProof,
    reportPublish: {
      status: 'done',
      mint: sweptTransferProof.token.mint,
      htmlUri: 'ar://terminal-report-with-sweep',
      proofFingerprint: sweptTransferFingerprint,
      sweepEvidenceHash: sweptTransferEvidenceHash,
    },
  };
  const terminalDossierWrongSweep = {
    ...sweptTransferProof,
    localDossier: {
      status: 'downloaded',
      kind: 'local-dossier-html',
      filename: 'trebuchet-terminal-dossier.html',
      mint: sweptTransferProof.token.mint,
      downloadedAt: '2026-06-30T00:00:00.000Z',
      dataVersion: 13,
      proofFingerprint: sweptTransferFingerprint,
      sweepEvidenceHash: partialTransferEvidenceHash,
    },
  };
  const terminalDossierWithSweep = {
    ...sweptTransferProof,
    localDossier: {
      ...terminalDossierWrongSweep.localDossier,
      sweepEvidenceHash: sweptTransferEvidenceHash,
    },
  };

  assert.equal(reportArtifactMatchesTerminalSweep(terminalReportMissingSweep.reportPublish, sweptTransferProof), false);
  assert.equal(reportArtifactMatchesTerminalSweep(terminalReportWrongSweep.reportPublish, sweptTransferProof), false);
  assert.equal(reportArtifactMatchesTerminalSweep(terminalReportWithSweep.reportPublish, sweptTransferProof), true);
  assert.equal(currentReportPublish(terminalReportMissingSweep, currentTypedConfig), null);
  assert.equal(currentReportPublish(terminalReportWrongSweep, currentTypedConfig), null);
  assert.deepEqual(currentReportPublish(terminalReportWithSweep, currentTypedConfig), terminalReportWithSweep.reportPublish);
  assert.equal(currentReportPublish({
    ...terminalReportWithSweep,
    reportPublish: { ...terminalReportWithSweep.reportPublish, mint: undefined },
  }, currentTypedConfig), null);
  assert.equal(currentReportPublish({
    ...terminalReportWithSweep,
    reportPublish: { ...terminalReportWithSweep.reportPublish, mint: 'WrongMint111111111111111111111111111111111' },
  }, currentTypedConfig), null);
  assert.equal(staleReportPublishForProof(terminalReportWrongSweep, currentTypedConfig).htmlUri, 'ar://terminal-report-wrong-sweep');
  assert.equal(currentLocalDossier(terminalDossierWrongSweep, currentTypedConfig), null);
  assert.deepEqual(currentLocalDossier(terminalDossierWithSweep, currentTypedConfig), terminalDossierWithSweep.localDossier);
  assert.equal(currentLocalDossier({
    ...terminalDossierWithSweep,
    localDossier: { ...terminalDossierWithSweep.localDossier, mint: undefined },
  }, currentTypedConfig), null);
  assert.equal(currentLocalDossier({
    ...terminalDossierWithSweep,
    localDossier: { ...terminalDossierWithSweep.localDossier, mint: 'WrongMint111111111111111111111111111111111' },
  }, currentTypedConfig), null);
  assert.match(js, /function reportPublishFinalizationIssue/);
  assert.match(js, /if \(proofMint && !reportMint\) return 'token mint missing'/);
  assert.match(js, /if \(proofMint && reportMint !== proofMint\) return 'token mint mismatch'/);
  assert.match(js, /const dossierMint = String\(dossier\.mint \|\| ''\)\.trim\(\)/);
  assert.match(js, /if \(proofMint && !dossierMint\) return 'token mint missing'/);
  assert.match(js, /if \(proofMint && dossierMint !== proofMint\) return 'token mint mismatch'/);
});

test('v2 proof config snapshots fill sweep destination until proof-bound report finalization', () => {
  const start = js.indexOf('function proofReportArtifactFinalizesDestination');
  const end = js.indexOf('\nfunction mergeLaunchProofEvidence', start);
  const helperStart = js.indexOf('function transferSweepErrorCount');
  const helperEnd = js.indexOf('\nfunction buildV2ReportParityAudit', helperStart);
  const reportHelperStart = js.indexOf('function terminalSweepEvidenceHashForProof');
  const reportHelperEnd = js.indexOf('\nfunction currentReportPublish', reportHelperStart);
  assert.ok(start >= 0 && end > start, 'launch config snapshot merge helpers must be extractable');
  assert.ok(helperStart >= 0 && helperEnd > helperStart, 'terminal sweep helpers must be extractable');
  assert.ok(reportHelperStart >= 0 && reportHelperEnd > reportHelperStart, 'report publish evidence helper must be extractable');
  const sandbox = {
    String,
    currentLaunchConfig: () => ({}),
    launchProofFingerprint: (proof = {}, config = {}) => String(
      proof?.proofFingerprint
        || proof?.expectedFingerprint
        || `${proof?.token?.mint || ''}:${config?.poolTopology?.sweepDestination || ''}`,
    ),
    reportPublishMatchesProof: (artifact = {}, proof = {}) => (
      Boolean(artifact?.proofFingerprint)
        && artifact.proofFingerprint === proof.proofFingerprint
    ),
    reportArtifactMatchesTerminalSweep: (artifact = {}, proof = {}) => {
      if (!proof?.transfer?.walletEmpty) return true;
      return artifact?.sweepEvidenceHash === proof.transfer.sweepEvidenceHash;
    },
  };
  vm.runInNewContext(
    [
      js.slice(reportHelperStart, reportHelperEnd),
      js.slice(helperStart, helperEnd),
      js.slice(start, end),
      'globalThis.mergeLaunchConfigSnapshot = mergeLaunchConfigSnapshot;',
    ].join('\n'),
    sandbox,
    { filename: 'public/v2/app.js launch config snapshot harness' },
  );

  const existingConfig = { poolTopology: { sweepDestination: null }, token: { symbol: 'OLD' } };
  const firstFill = sandbox.mergeLaunchConfigSnapshot(
    existingConfig,
    { poolTopology: { sweepDestination: 'FirstDest1111111111111111111111111111111111' } },
    {},
    {},
  );
  assert.equal(firstFill.poolTopology.sweepDestination, 'FirstDest1111111111111111111111111111111111');

  const editableBeforeReport = sandbox.mergeLaunchConfigSnapshot(
    firstFill,
    { poolTopology: { sweepDestination: 'EditedDest111111111111111111111111111111111' } },
    {},
    {},
  );
  assert.equal(editableBeforeReport.poolTopology.sweepDestination, 'EditedDest111111111111111111111111111111111');

  const editableAfterUriLessReport = sandbox.mergeLaunchConfigSnapshot(
    editableBeforeReport,
    { poolTopology: { sweepDestination: 'ChangedDest11111111111111111111111111111111' } },
    { reportPublish: { status: 'done' } },
    {},
  );
  assert.equal(editableAfterUriLessReport.poolTopology.sweepDestination, 'ChangedDest11111111111111111111111111111111');

  const editableAfterUnboundReport = sandbox.mergeLaunchConfigSnapshot(
    editableBeforeReport,
    { poolTopology: { sweepDestination: 'ChangedDest11111111111111111111111111111111' } },
    { reportPublish: { status: 'done', jsonUri: 'ar://published-report' } },
    {},
  );
  assert.equal(editableAfterUnboundReport.poolTopology.sweepDestination, 'ChangedDest11111111111111111111111111111111');

  const proofBoundReportMint = 'ReportFinalMint111111111111111111111111111111';
  const mintlessProofBoundReportProof = {
    proofFingerprint: 'proof-bound-report',
    token: { mint: proofBoundReportMint },
    launchConfig: editableBeforeReport,
    reportPublish: {
      status: 'done',
      jsonUri: 'ar://published-report',
      proofFingerprint: 'proof-bound-report',
    },
  };
  const editableAfterMintlessReport = sandbox.mergeLaunchConfigSnapshot(
    editableBeforeReport,
    { poolTopology: { sweepDestination: 'ChangedDest11111111111111111111111111111111' } },
    mintlessProofBoundReportProof,
    {},
  );
  assert.equal(editableAfterMintlessReport.poolTopology.sweepDestination, 'ChangedDest11111111111111111111111111111111');

  const proofBoundReportProof = {
    ...mintlessProofBoundReportProof,
    reportPublish: {
      ...mintlessProofBoundReportProof.reportPublish,
      mint: proofBoundReportMint,
    },
  };
  const frozenAfterReport = sandbox.mergeLaunchConfigSnapshot(
    editableBeforeReport,
    { poolTopology: { sweepDestination: 'ChangedDest11111111111111111111111111111111' } },
    proofBoundReportProof,
    {},
  );
  assert.equal(frozenAfterReport.poolTopology.sweepDestination, 'EditedDest111111111111111111111111111111111');

  const editableAfterUnboundLocalDossier = sandbox.mergeLaunchConfigSnapshot(
    editableBeforeReport,
    { poolTopology: { sweepDestination: 'ChangedDest11111111111111111111111111111111' } },
    { localDossier: { status: 'downloaded', kind: 'local-dossier-html', filename: 'trebuchet-mkt-dossier.html', downloadedAt: '2026-06-30T00:00:00.000Z', dataVersion: 13, proofFingerprint: 'fingerprint-1' } },
    {},
  );
  assert.equal(editableAfterUnboundLocalDossier.poolTopology.sweepDestination, 'ChangedDest11111111111111111111111111111111');

  const proofBoundDossierMint = 'DossierFinalMint11111111111111111111111111111';
  const mintlessProofBoundLocalDossier = {
    proofFingerprint: 'proof-bound-dossier',
    token: { mint: proofBoundDossierMint },
    launchConfig: editableBeforeReport,
    localDossier: { status: 'downloaded', kind: 'local-dossier-html', filename: 'trebuchet-mkt-dossier.html', downloadedAt: '2026-06-30T00:00:00.000Z', dataVersion: 13, proofFingerprint: 'proof-bound-dossier' },
  };
  const editableAfterMintlessLocalDossier = sandbox.mergeLaunchConfigSnapshot(
    editableBeforeReport,
    { poolTopology: { sweepDestination: 'ChangedDest11111111111111111111111111111111' } },
    mintlessProofBoundLocalDossier,
    {},
  );
  assert.equal(editableAfterMintlessLocalDossier.poolTopology.sweepDestination, 'ChangedDest11111111111111111111111111111111');

  const frozenAfterLocalDossier = sandbox.mergeLaunchConfigSnapshot(
    editableBeforeReport,
    { poolTopology: { sweepDestination: 'ChangedDest11111111111111111111111111111111' } },
    {
      ...mintlessProofBoundLocalDossier,
      localDossier: { ...mintlessProofBoundLocalDossier.localDossier, mint: proofBoundDossierMint },
    },
    {},
  );
  assert.equal(frozenAfterLocalDossier.poolTopology.sweepDestination, 'EditedDest111111111111111111111111111111111');

  const plannedTransferEvidence = sandbox.mergeLaunchConfigSnapshot(
    frozenAfterReport,
    { poolTopology: { sweepDestination: 'ChangedDest11111111111111111111111111111111' } },
    proofBoundReportProof,
    { transfer: { status: 'planned-before-sweep', destinationWallet: 'TransferDest1111111111111111111111111111111' } },
  );
  assert.equal(plannedTransferEvidence.poolTopology.sweepDestination, 'EditedDest111111111111111111111111111111111');

  const transferEvidence = sandbox.mergeLaunchConfigSnapshot(
    frozenAfterReport,
    { poolTopology: { sweepDestination: 'ChangedDest11111111111111111111111111111111' } },
    proofBoundReportProof,
    { transfer: { destinationWallet: 'TransferDest1111111111111111111111111111111', walletEmpty: true } },
  );
  assert.equal(transferEvidence.poolTopology.sweepDestination, 'TransferDest1111111111111111111111111111111');

  const reportPublishEvidence = sandbox.mergeLaunchConfigSnapshot(
    { poolTopology: { sweepDestination: 'DraftDest1111111111111111111111111111111111' } },
    { poolTopology: { sweepDestination: 'ReportDest111111111111111111111111111111111' } },
    {},
    {
      proofFingerprint: 'incoming-proof-bound-report',
      token: { mint: 'IncomingReportMint11111111111111111111111111' },
      launchConfig: { poolTopology: { sweepDestination: 'ReportDest111111111111111111111111111111111' } },
      reportPublish: { status: 'done', htmlUri: 'ar://incoming-report', mint: 'IncomingReportMint11111111111111111111111111', proofFingerprint: 'incoming-proof-bound-report' },
    },
  );
  assert.equal(reportPublishEvidence.poolTopology.sweepDestination, 'ReportDest111111111111111111111111111111111');
  assert.match(js, /proofReportArtifactFinalizesDestination\(existingProof, existing\)/);
  assert.match(js, /proofReportArtifactFinalizesDestination\(incomingProof, incoming\)/);
  assert.match(js, /proofReportArtifactFinalizesDestination\(proof, proofConfig\)/);
  assert.match(js, /reportPublishFinalizationIssue\(report, proof, proofConfig\)/);
  assert.match(js, /localDossierFinalizationIssue\(localDossier, proof, proofConfig\)/);
});

test('v2 manual run-next preserves classic finalization before sweep', () => {
  const helperStart = js.indexOf('function executeNextTransferFinalizationIssue');
  const helperEnd = js.indexOf('\nfunction fullRunPendingAirdropCount', helperStart);
  const helper = js.slice(helperStart, helperEnd);
  const runNextStart = js.indexOf('async function executeNextRunOperation()');
  const runNextEnd = js.indexOf('\nfunction executeNextTransferFinalizationIssue', runNextStart);
  const runNext = js.slice(runNextStart, runNextEnd);

  assert.ok(helperStart >= 0, 'manual sweep finalization helper missing');
  assert.match(helper, /readiness\?\.nextEndpoint !== '\/api\/transfer-assets'/);
  assert.match(helper, /const safeConfig = proofConfigForFingerprint\(proof, config\)/);
  assert.match(helper, /airdropCompletionStatus\(proof, safeConfig\.poolTopology\)/);
  assert.match(helper, /const airdropIssue = airdropCompletionIssue\(airdropStatus\)/);
  assert.match(helper, /if \(airdropIssue\) return airdropIssue/);
  assert.doesNotMatch(helper, /if \(state\.prefs\.publishLaunchReport === false\) return null/);
  assert.match(helper, /!report\?\.jsonUri && !report\?\.htmlUri && !localDossier/);
  assert.match(helper, /Report publishing is off; download the local dossier before final sweep/);
  assert.match(helper, /staleReportPublishForProof\(proof, safeConfig\)/);
  assert.match(helper, /currentReportPublish\(proof, safeConfig\)/);
  assert.match(helper, /currentLocalDossier\(proof, safeConfig\)/);
  assert.match(helper, /localDossierFinalizationIssue\(staleLocalDossier, proof, safeConfig\)/);
  assert.match(helper, /Local dossier proof is stale or incomplete/);
  assert.match(helper, /Publish or download the launch report before final sweep/);

  const sandbox = {
    state: { prefs: { publishLaunchReport: false }, lastLocalDossier: null },
    proof: { canPublishReport: false },
    localDossier: null,
    currentLaunchProof: () => sandbox.proof,
    proofConfigForFingerprint: (proof, config) => proof?.launchConfig || config || { poolTopology: {} },
    airdropCompletionStatus: (_proof, topology = {}) => sandbox.airdropStatus || (topology?.airdrop?.enabled
      ? { configured: true, complete: false, retryRequired: false, failed: 0, pending: Number(topology.airdrop.recipientCount || 1), missing: [] }
      : { configured: false, complete: true, retryRequired: false, failed: 0, pending: 0 }),
    airdropCompletionIssue: (status = {}) => status.complete ? null : 'Airdrop proof is incomplete (transaction signatures); refresh or rerun airdrop before final sweep.',
    staleReportPublishForProof: () => null,
    currentReportPublish: () => null,
    currentLocalDossier: () => sandbox.localDossier?.valid === true ? sandbox.localDossier : null,
    localDossierFinalizationIssue: (dossier) => dossier?.valid === true ? null : 'proof fingerprint mismatch',
  };
  vm.runInNewContext(`${helper}\nglobalThis.executeNextTransferFinalizationIssue = executeNextTransferFinalizationIssue;`, sandbox, {
    filename: 'public/v2/app.js final sweep guard harness',
  });
  let issue = sandbox.executeNextTransferFinalizationIssue(
    { nextEndpoint: '/api/transfer-assets' },
    { poolTopology: {} },
  );
  assert.match(issue, /download the local dossier before final sweep/);
  sandbox.airdropStatus = {
    configured: true,
    complete: false,
    retryRequired: false,
    failed: 0,
    pending: 0,
    missing: ['transaction signatures'],
  };
  issue = sandbox.executeNextTransferFinalizationIssue(
    { nextEndpoint: '/api/transfer-assets' },
    { poolTopology: {} },
  );
  assert.match(issue, /Airdrop proof is incomplete/);
  sandbox.airdropStatus = null;
  sandbox.proof = {
    canPublishReport: false,
    localDossier: {
      status: 'downloaded',
      kind: 'local-dossier-html',
      filename: 'trebuchet-pre-sweep-dossier.html',
      proofFingerprint: 'stale-proof',
    },
  };
  issue = sandbox.executeNextTransferFinalizationIssue(
    { nextEndpoint: '/api/transfer-assets' },
    { poolTopology: {} },
  );
  assert.match(issue, /Local dossier proof is stale or incomplete/);
  assert.match(issue, /proof fingerprint mismatch/);
  sandbox.proof = { canPublishReport: false };
  sandbox.localDossier = {
    valid: true,
    status: 'downloaded',
    kind: 'local-dossier-html',
    filename: 'trebuchet-pre-sweep-dossier.html',
    downloadedAt: '2026-06-30T00:00:00.000Z',
    dataVersion: 13,
    proofFingerprint: 'proof-bound',
  };
  issue = sandbox.executeNextTransferFinalizationIssue(
    { nextEndpoint: '/api/transfer-assets' },
    { poolTopology: {} },
  );
  assert.equal(issue, null);
  sandbox.proof = {
    launchConfig: {
      poolTopology: {
        airdrop: { enabled: true, recipientCount: 1 },
      },
    },
  };
  issue = sandbox.executeNextTransferFinalizationIssue(
    { nextEndpoint: '/api/transfer-assets' },
    { poolTopology: { airdrop: { enabled: false, recipientCount: 0 } } },
  );
  assert.match(issue, /Airdrop proof is incomplete/);
  sandbox.proof = { canPublishReport: false };

  const guardIdx = runNext.indexOf('executeNextTransferFinalizationIssue(readiness, config)');
  const notifyIdx = runNext.indexOf('notify(finalizationIssue)');
  const confirmIdx = runNext.indexOf('window.confirm');
  const apiIdx = runNext.indexOf('state.apiClient.executeNextRunOperation');
  assert.ok(guardIdx >= 0, 'Run next must check finalization before sweeping');
  assert.ok(notifyIdx > guardIdx, 'Run next must show the finalization issue');
  assert.ok(guardIdx < confirmIdx, 'Run next must block before irreversible confirmation');
  assert.ok(guardIdx < apiIdx, 'Run next must block before executing transfer-assets');
  assert.match(runNext, /const dossierProof = currentLaunchProof\(\)/);
  assert.match(runNext, /const dossierConfig = proofConfigForFingerprint\(dossierProof, config\)/);
  assert.match(runNext, /localDossier: currentLocalDossier\(dossierProof, dossierConfig\)/);
});

test('v2 full launch runner requires proof before marking completion', () => {
  const helperStart = js.indexOf('function fullRunCompletionAudit');
  const helperEnd = js.indexOf('\nfunction fullRunEndpointLabel', helperStart);
  const helper = js.slice(helperStart, helperEnd);
  const runnerStart = js.indexOf('async function runFullLaunch()');
  const runnerEnd = js.indexOf('\nasync function runLaunchEnvelope', runnerStart);
  const runner = js.slice(runnerStart, runnerEnd);

  assert.ok(helperStart >= 0, 'full run completion audit helper missing');
  assert.ok(helperEnd > helperStart, 'full run completion audit helper should be bounded');
  assert.ok(runnerStart >= 0 && runnerEnd > runnerStart, 'full run runner should be extractable');
  assert.match(helper, /const tokenAuthorityFields = \['mintAuthorityRenounced', 'freezeAuthorityDisabled', 'metadataUpdateAuthorityRevoked', 'metadataImmutable'\]/);
  assert.match(helper, /const safeConfig = proofConfigForFingerprint\(proof, config && typeof config === 'object' \? config : \{ poolTopology: \{\} \}\)/);
  assert.match(helper, /buildV2ReportPoolPlan\(safeConfig, results, proof\)/);
  assert.match(helper, /const txEvidence = v2LiquidityTransactionEvidenceCounts\(results\)/);
  assert.match(helper, /Pool-create transaction proof is \$\{poolCreateTxCount\}\/\$\{plannedPoolCount\}/);
  assert.match(helper, /Position-open transaction proof is \$\{openTxCount\}\/\$\{recordedPositionCount\}/);
  assert.match(helper, /Burn & Earn lock transaction proof is \$\{lockTxCount\}\/\$\{recordedPositionCount\}/);
  assert.match(helper, /Fee Key recipient transfer proof is \$\{feeKeyRecipientTransferred\}\/\$\{feeKeyRecipientTarget\}/);
  assert.match(helper, /airdropCompletionStatus\(proof, topology\)/);
  assert.match(helper, /airdropCompletionIssue\(airdropStatus\) \|\| 'Airdrop proof is incomplete\.'/);
  assert.match(helper, /currentLocalDossier\(proof, safeConfig\)/);
  assert.match(helper, /const report = currentReportPublish\(proof, safeConfig\)/);
  assert.doesNotMatch(helper, /currentReportPublish\(proof, safeConfig, \{ allowTransient: true \}\)/);
  assert.match(helper, /state\.prefs\.publishLaunchReport === false/);
  assert.match(helper, /!reportUri && !localDossier/);
  assert.doesNotMatch(helper, /proof\?\.canPublishReport && !reportUri && !localDossier/);
  assert.match(helper, /const proofLaunchConfigSnapshot = proofLaunchConfigSnapshotState\(proof\)/);
  assert.match(helper, /Frozen launch-config snapshot proof is missing/);
  assert.match(helper, /Frozen launch-config snapshot is incomplete/);
  assert.match(helper, /Frozen launch-config snapshot does not match launch evidence/);
  assert.match(helper, /transferHasWalletEmptyFinalSweepEvidence\(proof\?\.transfer\)/);
  assert.match(helper, /reportArtifactMatchesTerminalSweep\(reportArtifactRecord, proof\)/);
  assert.match(helper, /Launch report artifact is missing terminal final-sweep evidence; download a fresh proof artifact after final sweep/);
  assert.match(helper, /proofHasTerminalLaunchJournal\(proof\)/);
  assert.match(helper, /Wallet-empty final-sweep proof is missing/);
  assert.match(helper, /Matching launch journal is not loaded from the local recovery store/);
  assert.match(helper, /Launch journal has not reached transfer_completed/);

  const verifyIdx = runner.indexOf("state.fullRunStep = 'Verifying launch proof'");
  const refreshRecoveryIdx = runner.indexOf('await refreshLocalApiState()');
  const auditIdx = runner.indexOf('const completion = fullRunCompletionAudit(currentLaunchProof(), config)');
  const lastRunIdx = runner.indexOf('state.lastFullRun = {');
  assert.ok(verifyIdx >= 0, 'full run must enter explicit proof verification');
  assert.ok(refreshRecoveryIdx > verifyIdx, 'full run must refresh local recovery state after final proof refresh');
  assert.ok(refreshRecoveryIdx < auditIdx, 'full run must refresh local recovery state before completion audit');
  assert.ok(auditIdx > verifyIdx, 'proof audit must run after final readiness refresh');
  assert.ok(lastRunIdx > auditIdx, 'lastFullRun must be derived from the proof audit');
  assert.match(runner, /const fullRunStatus = completion\.complete \? 'complete' : 'needs-proof'/);
  assert.match(runner, /status: fullRunStatus/);
  assert.match(runner, /completion,/);
  assert.match(runner, /completedAt: completion\.complete \? new Date\(\)\.toISOString\(\) : null/);
  assert.match(runner, /if \(!reportDone && state\.prefs\.publishLaunchReport === false\)/);
  assert.match(runner, /throw new Error\('Report publishing is off; download the local dossier before final sweep\.'\)/);
  assert.match(runner, /let proofConfig = proofConfigForFingerprint\(proof, config\)/);
  assert.match(runner, /airdropCompletionStatus\(proof, proofConfig\.poolTopology\)/);
  assert.match(runner, /const reportConfig = proofConfigForFingerprint\(reportProof, config\)/);
  assert.match(runner, /currentReportPublish\(reportProof, reportConfig\)/);
  assert.match(runner, /currentLocalDossier\(reportProof, reportConfig\)/);
  assert.match(runner, /if \(!reportDone && reportProof\?\.canPublishReport && proofHasReportPublishEvidence\(reportProof, reportConfig\)\)/);
  assert.match(runner, /const dossierProof = currentLaunchProof\(\)/);
  assert.match(runner, /const dossierConfig = proofConfigForFingerprint\(dossierProof, config\)/);
  assert.match(runner, /localDossier: currentLocalDossier\(dossierProof, dossierConfig\)/);
  assert.doesNotMatch(runner, /state\.prefs\.publishLaunchReport !== false && reportProof\?\.canPublishReport && !reportDone/);
  assert.match(runner, /Full launch needs proof/);
  assert.match(js, /const reportNeedsFinalArtifact = Boolean\(/);
  assert.match(js, /Download final dossier/);
  assert.match(js, /Terminal sweep is recorded; download a fresh proof dossier so the artifact carries the final sweep hash/);

  const sandbox = {
    state: { prefs: { publishLaunchReport: true } },
    proofConfigForFingerprint: (proof, config) => proof?.launchConfig || config || { poolTopology: {} },
    buildV2ReportPoolPlan: (config = {}) => (
      Array.isArray(config?.poolTopology?.pools) && config.poolTopology.pools.length
        ? config.poolTopology.pools.map((pool) => ({
          ...pool,
          plannedPositionCount: Number(pool.plannedPositionCount || 1),
        }))
        : [{ plannedPositionCount: 1 }]
    ),
    comparisonLiquidityEvidenceState: () => ({
      missing: [],
      positionCount: 1,
      lockedPositionCount: 1,
      feeKeyCount: 1,
    }),
    v2LiquidityTransactionEvidenceCounts: () => sandbox.txEvidence || ({
      poolCreateTxCount: 1,
      openTxCount: 1,
      lockTxCount: 1,
      feeKeyRecipientRows: [],
      feeKeyRecipientTransferred: 0,
    }),
    airdropCompletionStatus: () => sandbox.airdropStatus || ({ configured: false, complete: true, retryRequired: false, failed: 0, pending: 0 }),
    airdropCompletionIssue: (status = {}) => status.complete ? null : 'Airdrop proof is incomplete (transaction signatures); refresh or rerun airdrop before final sweep.',
    currentReportPublish: (_proof, _config, options = {}) => (
      sandbox.report?.transientOnly === true && options?.allowTransient !== true
        ? null
        : sandbox.report
    ),
    currentLocalDossier: () => sandbox.localDossier,
    staleReportPublishForProof: () => null,
    transferHasWalletEmptyFinalSweepEvidence: () => true,
    reportArtifactMatchesTerminalSweep: () => sandbox.reportSweepBound === true,
    launchProofPoolIds: (proof = {}) => [
      ...(Array.isArray(proof?.liquidity?.poolIds) ? proof.liquidity.poolIds : []),
      ...(Array.isArray(proof?.liquidity?.results) ? proof.liquidity.results.map((pool) => pool?.poolId) : []),
    ].filter(Boolean),
    proofJournalEvidenceState: () => ({ journal: {}, mismatches: [], missing: [] }),
    proofHasTerminalLaunchJournal: () => true,
    proofLaunchConfigSnapshotState: (proof = {}) => {
      const launchConfig = proof?.launchConfig && typeof proof.launchConfig === 'object' ? proof.launchConfig : null;
      if (!launchConfig) return { state: 'missing', complete: false, missing: ['snapshot'], mismatches: [] };
      const missing = [];
      if (launchConfig.schema !== 'trebuchet-v2-launch-config' || launchConfig.source !== 'trebuchet-v2') {
        missing.push('v2 snapshot marker');
      }
      if (!launchConfig.token) missing.push('token');
      if (!launchConfig.poolTopology?.pools?.length) missing.push('planned pools');
      return { state: missing.length ? 'incomplete' : 'complete', complete: missing.length === 0, missing, mismatches: [] };
    },
  };
  vm.runInNewContext(`${helper}\nglobalThis.fullRunCompletionAudit = fullRunCompletionAudit;`, sandbox, {
    filename: 'public/v2/app.js full run completion harness',
  });
  const completeProof = {
    token: {
      mint: 'Mint111',
      mintAuthorityRenounced: true,
      freezeAuthorityDisabled: true,
      metadataUpdateAuthorityRevoked: true,
      metadataImmutable: true,
      name: 'Complete',
      symbol: 'CMP',
      totalSupply: '1000',
      decimals: 9,
    },
    liquidity: {
      poolCount: 1,
      results: [{ poolId: 'Pool111' }],
    },
    launchConfig: {
      schema: 'trebuchet-v2-launch-config',
      source: 'trebuchet-v2',
      token: { name: 'Complete', symbol: 'CMP', supply: '1000', decimals: 9 },
      poolTopology: {
        pools: [{ id: 'sol', quoteToken: 'SOL', plannedPositionCount: 1 }],
      },
    },
    transfer: { walletEmpty: true },
    journalId: 'journal-1',
    canPublishReport: false,
  };
  const completeConfig = { poolTopology: { pools: [{ id: 'sol', quoteToken: 'SOL' }] } };
  let completion = sandbox.fullRunCompletionAudit(completeProof, completeConfig);
  assert.equal(completion.complete, false);
  assert.match(completion.blockers.join('\n'), /Launch report artifact proof is missing/);

  sandbox.state.prefs.publishLaunchReport = false;
  completion = sandbox.fullRunCompletionAudit(completeProof, completeConfig);
  assert.equal(completion.complete, false);
  assert.match(completion.blockers.join('\n'), /download or attach the local dossier/);

  sandbox.localDossier = { filename: 'trebuchet-final-proof.html' };
  sandbox.reportSweepBound = true;
  completion = sandbox.fullRunCompletionAudit(completeProof, completeConfig);
  assert.equal(completion.complete, true);

  sandbox.state.prefs.publishLaunchReport = true;
  sandbox.localDossier = null;
  sandbox.report = { htmlUri: 'ar://transient-report', transientOnly: true };
  sandbox.reportSweepBound = true;
  completion = sandbox.fullRunCompletionAudit(completeProof, completeConfig);
  assert.equal(completion.complete, false);
  assert.match(completion.blockers.join('\n'), /Launch report artifact proof is missing/);
  sandbox.report = null;

  completion = sandbox.fullRunCompletionAudit({
    ...completeProof,
    launchConfig: {
      token: { name: 'Complete', symbol: 'CMP', supply: '1000', decimals: 9 },
      poolTopology: {
        pools: [{ id: 'sol', quoteToken: 'SOL', plannedPositionCount: 1 }],
      },
    },
  }, completeConfig);
  assert.equal(completion.complete, false);
  assert.match(completion.blockers.join('\n'), /v2 snapshot marker/);
  completion = sandbox.fullRunCompletionAudit({
    ...completeProof,
    launchConfig: {
      ...completeProof.launchConfig,
      poolTopology: {
        pools: [
          { id: 'sol', quoteToken: 'SOL', plannedPositionCount: 1 },
          { id: 'seige', quoteToken: 'seige', plannedPositionCount: 1 },
        ],
      },
    },
  }, completeConfig);
  assert.equal(completion.complete, false);
  assert.match(completion.blockers.join('\n'), /Pool proof is 1\/2/);

  sandbox.txEvidence = {
    poolCreateTxCount: 0,
    openTxCount: 0,
    lockTxCount: 0,
    feeKeyRecipientRows: [],
    feeKeyRecipientTransferred: 0,
  };
  completion = sandbox.fullRunCompletionAudit(completeProof, completeConfig);
  assert.equal(completion.complete, false);
  assert.match(completion.blockers.join('\n'), /Pool-create transaction proof is 0\/1/);
  assert.match(completion.blockers.join('\n'), /Position-open transaction proof is 0\/1/);
  assert.match(completion.blockers.join('\n'), /Burn & Earn lock transaction proof is 0\/1/);
  sandbox.txEvidence = null;

  sandbox.airdropStatus = {
    configured: true,
    complete: false,
    retryRequired: false,
    failed: 0,
    pending: 0,
    missing: ['transaction signatures'],
  };
  completion = sandbox.fullRunCompletionAudit(completeProof, completeConfig);
  assert.equal(completion.complete, false);
  assert.match(completion.blockers.join('\n'), /Airdrop proof is incomplete/);
  sandbox.airdropStatus = null;

  const missingPoolIdsProof = {
    ...completeProof,
    liquidity: {
      poolCount: 1,
      positionCount: 1,
      lockedPositionCount: 1,
      feeKeyCount: 1,
      results: [{ mainPositions: [{ positionNftMint: 'Position111', locked: true, feeKeyNftMint: 'FeeKey111' }] }],
    },
  };
  completion = sandbox.fullRunCompletionAudit(missingPoolIdsProof, completeConfig);
  assert.equal(completion.complete, false);
  assert.match(completion.blockers.join('\n'), /Pool proof is 0\/1/);
  assert.match(completion.blockers.join('\n'), /Pool count proof does not match recorded pool IDs/);
});

test('v2 launch mechanism stages one Trebuchet-managed local wallet run', () => {
  const combined = `${html}\n${css}\n${js}`;

  assert.match(html, /id="signaturePanel"/);
  assert.match(combined, /Local wallet run/);
  assert.match(combined, /Live launch progress/);
  assert.match(combined, /signature-progress/);
  assert.match(combined, /signature-track/);
  assert.match(combined, /Current operation/);
  assert.match(combined, /Next checkpoint/);
  assert.match(combined, /Execution ledger/);
  assert.match(combined, /Latest guarded operations/);
  assert.match(combined, /historyExecutionAudit/);
  assert.match(combined, /Retries/);
  assert.match(combined, /attempt/);
  assert.match(combined, /variable/);
  assert.match(combined, /operations complete/);
  assert.match(combined, /phases complete/);
  assert.match(combined, /Review run plan first/);
  assert.match(combined, /trebuchet-managed-launch-wallet/);
  assert.match(combined, /Start local run/);
  assert.match(combined, /run-launch/);
  assert.match(js, /tx-config/);
  assert.match(js, /tx-funding/);
});

test('v2 Vanity CA candidates use a compact terminal list and Signal grade colors', () => {
  const renderStart = js.indexOf('function renderVanityCandidates()');
  const renderEnd = js.indexOf('function poolLadderCount', renderStart);
  const renderSource = js.slice(renderStart, renderEnd);

  assert.ok(renderStart >= 0 && renderEnd > renderStart);
  assert.match(js, /const VANITY_VISIBLE_CANDIDATE_LIMIT = 4/);
  assert.match(js, /function vanityRarityGrade/);
  assert.match(renderSource, /vanity-candidate-list/);
  assert.doesNotMatch(renderSource, /vanity-candidate-grid/);
  assert.match(renderSource, /vanity-ca-address[^\n]+\$\{escapeHtml\(shortAddress\(candidate\.publicKey\)\)\}/);
  assert.match(js, /return `\$\{text\.slice\(0, 4\)\}\.\.\.\$\{text\.slice\(-4\)\}`/);
  assert.match(renderSource, /vanity-candidate-meta/);
  assert.match(renderSource, /aria-pressed/);
  assert.match(renderSource, /aria-label="Select random CA"/);
  assert.match(css, /--rarity-common: #c8dce6/);
  assert.match(css, /--rarity-fine: #8cdcff/);
  assert.match(css, /--rarity-rare: #be82ff/);
  assert.match(css, /--rarity-rati: #ffc85a/);
  assert.match(css, /--rarity-commissioned: #fff082/);
  assert.match(css, /\.vanity-candidate-list\s*\{[\s\S]*?display: flex;[\s\S]*?flex-direction: column;/);
  assert.match(css, /#view-launch \.vanity-candidate\s*\{[\s\S]*?font-family: inherit;/);
});

test('v2 active wallet identity uses its rarity color without replacing status colors', () => {
  const renderStart = js.indexOf('function renderWallet()');
  const renderEnd = js.indexOf('function renderDiscovery()', renderStart);
  const renderSource = js.slice(renderStart, renderEnd);

  assert.ok(renderStart >= 0 && renderEnd > renderStart);
  assert.match(html, /id="activeWalletRarityBadge"/);
  assert.match(js, /rarityGrade: vanityRarityGrade\(rarity\)/);
  assert.match(renderSource, /wallet-rarity-\$\{escapeHtml\(item\.rarityGrade\)\}/);
  assert.match(renderSource, /wallet-rarity-label/);
  assert.match(renderSource, /activeWalletRarityBadge/);
  for (const grade of ['common', 'fine', 'rare', 'rati', 'commissioned']) {
    assert.match(css, new RegExp(`\\.wallet-rarity-${grade}\\s*\\{`));
  }
  assert.match(css, /#view-wallet \.account-row\.is-active[\s\S]*?border-left-color: var\(--wallet-rarity\)/);
  assert.match(css, /\.wallet-button\[class\*="wallet-rarity-"\] \.wallet-led\.is-on[\s\S]*?background: var\(--wallet-rarity\)/);
  assert.match(css, /\.wallet-rarity-badge\[class\*="wallet-rarity-"\][\s\S]*?color: var\(--wallet-rarity\)/);
  assert.match(css, /\.risk-badge\.danger[\s\S]*?color: var\(--red\)/);
});

test('v2 primary views share framed terminal workspaces and tabbed History panes', () => {
  for (const pane of ['recovery', 'wallets', 'audit', 'journal']) {
    assert.match(html, new RegExp(`data-history-pane="${pane}"`));
    assert.match(html, new RegExp(`data-history-pane-panel="${pane}"`));
  }
  assert.match(html, /id="historyPaneTabs" role="tablist"/);
  assert.match(js, /activeHistoryPane: 'recovery'/);
  assert.match(js, /function renderHistoryPanes/);
  assert.match(js, /action === 'select-history-pane'/);
  assert.match(js, /panel\.hidden = !selected/);
  assert.match(css, /\.history-pane-tabs\s*\{[\s\S]*?display: flex;/);
  assert.match(css, /\.history-pane-stage\s*\{[\s\S]*?overflow: hidden;/);
  assert.match(css, /#view-history \.surface-main\s*\{[\s\S]*?grid-template-rows: auto auto minmax\(0, 1fr\)/);
  assert.match(css, /#view-wallet \.surface,[\s\S]*?#view-settings \.surface[\s\S]*?border: 1px solid var\(--line-strong\)/);
  assert.match(css, /#view-settings \.release-panel \.secret-pin-actions\s*\{[\s\S]*?grid-column: 1 \/ -1/);
  assert.match(css, /body:not\(\[data-active-view="launch"\]\) \.view\.is-active,[\s\S]*?overflow: hidden/);
});

test('v2 prototype keeps assets local and JavaScript unobtrusive', () => {
  assert.match(html, /vendor\/fontawesome\/css\/all\.min\.css/);
  assert.match(html, /styles\.css\?v=65/);
  assert.match(html, /api-client\.js\?v=32/);
  assert.match(html, /app\.js\?v=151/);
  assert.doesNotMatch(html, /app\.js\?v=151" type="module"/);
  assert.ok(html.indexOf('api-client.js') < html.indexOf('app.js'), 'API client must load before app.js');
  assert.doesNotMatch(html, /cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com|unpkg\.com|https?:\/\//);
  assert.doesNotMatch(`${html}\n${js}\n${apiClientJs}`, /\bon(?:click|load|error)=["']/i);
  assert.doesNotMatch(`${html}\n${js}\n${apiClientJs}`, /javascript:/i);
});

test('v2 retirement gate requires terminal final sweep evidence', () => {
  const {
    transferHasFinalSweepEvidence,
    transferHasWalletEmptyFinalSweepEvidence,
    finalSweepProofState,
    proofEffectiveDestination,
  } = loadClassicComparisonHarness();
  const destinationConfig = {
    poolTopology: {
      sweepDestination: 'ConfigDest111111111111111111111111111111111',
    },
  };

  assert.equal(transferHasFinalSweepEvidence(null), false);
  assert.deepEqual(JSON.parse(JSON.stringify(finalSweepProofState(null))), {
    terminal: false,
    status: 'not-recorded',
    label: 'Not recorded',
    walletEmpty: null,
    sweptAssetCount: 0,
    errorCount: 0,
  });
  assert.equal(transferHasFinalSweepEvidence({}), false);
  assert.equal(finalSweepProofState({ status: 'planned-before-sweep', destinationWallet: 'Dest111111111111111111111111111111111111111' }).status, 'needs-proof');
  assert.equal(transferHasFinalSweepEvidence({
    status: 'planned-before-sweep',
    destinationWallet: 'Dest111111111111111111111111111111111111111',
  }), false);
  assert.equal(transferHasFinalSweepEvidence({
    destinationWallet: 'Dest111111111111111111111111111111111111111',
    walletEmpty: false,
    solTransferred: 1,
  }), false);
  assert.equal(transferHasFinalSweepEvidence({
    destinationWallet: 'Dest111111111111111111111111111111111111111',
    walletEmpty: true,
    tokenTransferErrors: [{ mint: 'Mint111' }],
  }), false);
  assert.equal(transferHasFinalSweepEvidence({
    destinationWallet: 'Dest111111111111111111111111111111111111111',
    walletEmpty: true,
    solTransferred: 0,
    tokensTransferred: 0,
  }), true);
  assert.equal(finalSweepProofState({
    destinationWallet: 'Dest111111111111111111111111111111111111111',
    walletEmpty: true,
  }).status, 'terminal');
  assert.equal(transferHasFinalSweepEvidence({
    destinationWallet: 'Dest111111111111111111111111111111111111111',
    solTransferred: 0.01,
  }), true);
  assert.equal(transferHasFinalSweepEvidence({
    destinationWallet: 'Dest111111111111111111111111111111111111111',
    tokenSweep: { transferred: [{ mint: 'Mint111' }], errors: [] },
  }), true);
  assert.equal(transferHasWalletEmptyFinalSweepEvidence({
    destinationWallet: 'Dest111111111111111111111111111111111111111',
    tokenSweep: { transferred: [{ mint: 'Mint111' }], errors: [] },
  }), false);
  assert.equal(finalSweepProofState({
    destinationWallet: 'Dest111111111111111111111111111111111111111',
    tokenSweep: { transferred: [{ mint: 'Mint111' }], errors: [] },
  }).status, 'needs-proof');
  assert.equal(transferHasWalletEmptyFinalSweepEvidence({
    destinationWallet: 'Dest111111111111111111111111111111111111111',
    walletEmpty: true,
    tokenSweep: { transferred: [{ mint: 'Mint111' }], errors: [] },
  }), true);
  assert.equal(proofEffectiveDestination({
    transfer: {
      status: 'planned-before-sweep',
      destinationWallet: 'PlannedDest11111111111111111111111111111111',
    },
  }, destinationConfig), 'ConfigDest111111111111111111111111111111111');
  assert.equal(proofEffectiveDestination({
    transfer: {
      destinationWallet: 'TerminalDest111111111111111111111111111111',
      walletEmpty: true,
    },
  }, destinationConfig), 'TerminalDest111111111111111111111111111111');
  assert.match(js, /const sweepComplete = transferHasWalletEmptyFinalSweepEvidence\(transfer\)/);
  assert.match(js, /const finalSweepComplete = transferHasWalletEmptyFinalSweepEvidence\(proof\?\.transfer\)/);
  assert.match(js, /function proofLaunchConfigSnapshotState/);
  assert.match(js, /const proofLaunchConfigSnapshot = proofLaunchConfigSnapshotState\(proof\)/);
  assert.match(js, /&& proofLaunchConfigSnapshot\.complete\s*\n\s*&& proofJournalEvidence/);
  assert.match(js, /const proofJournalEvidence = Boolean\(proof\?\.journalId\)/);
  assert.match(js, /function proofMatchingLocalLaunchJournal\(proof = currentLaunchProof\(\)\)/);
  assert.match(js, /function proofJournalEvidenceState\(proof = currentLaunchProof\(\)\)/);
  assert.match(js, /function transferHasWalletEmptyFinalSweepEvidence\(transfer = null\)/);
  assert.match(js, /const finalSweepComplete = transferHasWalletEmptyFinalSweepEvidence\(proof\?\.transfer\)/);
  assert.match(js, /const proofFinalSweepEvidence = transferHasWalletEmptyFinalSweepEvidence\(proof\?\.transfer\)/);
  assert.match(js, /function journalTransferHasTerminalSweepEvidence\(transfer = null\)/);
  assert.match(js, /journalTransferHasTerminalSweepEvidence\(journalTransfer\)/);
  assert.match(js, /return transferHasWalletEmptyFinalSweepEvidence\(transfer\)/);
  assert.match(js, /function proofTransferJournalEvidenceState\(proofTransfer = null, journalTransfer = null\)/);
  assert.match(js, /proofTransferJournalEvidenceState\(proofTransfer, journalTransfer\)/);
  assert.match(js, /mismatches\.push\('sweep evidence hash'\)/);
  assert.match(js, /function proofTokenJournalEvidenceState\(proof = \{\}, journal = \{\}\)/);
  assert.match(js, /proofTokenJournalEvidenceState\(proof, journal\)/);
  assert.match(js, /function proofLiquidityJournalEvidenceState\(proof = \{\}, journal = \{\}\)/);
  assert.match(js, /proofLiquidityJournalEvidenceState\(proof, journal\)/);
  assert.match(js, /function launchPoolFingerprints\(results = \[\]\)/);
  assert.match(js, /mismatches\.push\('pool records'\)/);
  assert.match(js, /function proofAirdropJournalEvidenceState\(proof = \{\}, journal = \{\}\)/);
  assert.match(js, /proofAirdropJournalEvidenceState\(proof, journal\)/);
  assert.match(js, /function comparisonAirdropDeliveryEvidenceState\(airdrop = \{\}\)/);
  assert.match(js, /const airdropProofEvidence = comparisonAirdropDeliveryEvidenceState/);
  assert.match(js, /const localJournalEvidenceState = proofJournalEvidenceState\(proof\)/);
  assert.match(js, /const matchingLocalJournal = localJournalEvidenceState\.journal/);
  assert.match(js, /const proofTerminalJournalEvidence = proofHasTerminalLaunchJournal\(proof\)/);
  assert.match(js, /&& journalEvidence\.backed/);
  assert.match(js, /const proofWalletEvidence = Boolean\(proof\?\.walletPublicKey\)/);
  assert.match(js, /const liveTokenAuthorityFields = \['mintAuthorityRenounced', 'freezeAuthorityDisabled', 'metadataUpdateAuthorityRevoked', 'metadataImmutable'\]/);
  assert.match(js, /&& proofJournalEvidence\s*\n\s*&& proofTerminalJournalEvidence/);
  assert.match(js, /&& proofTerminalJournalEvidence\s*\n\s*&& proofWalletEvidence/);
  assert.match(js, /&& proofWalletEvidence\s*\n\s*&& proof\?\.token\?\.mint/);
  assert.match(js, /const livePoolIdentityComplete = Boolean\(/);
  assert.match(js, /recordedPoolIds\.length === plannedPoolCount/);
  assert.match(js, /const livePositionProofComplete = Boolean\(/);
  assert.match(js, /const liveLockProofComplete = Boolean\(/);
  assert.match(js, /const liveLiquidityProofComplete = Boolean\(livePoolIdentityComplete && livePositionProofComplete && liveLockProofComplete\)/);
  assert.match(js, /&& liveTokenAuthorityComplete\s*\n\s*&& liveLiquidityProofComplete/);
  assert.match(js, /Pool identity proof is \$\{recordedPoolIds\.length\}\/\$\{plannedPoolCount\}/);
  assert.match(js, /Completed proof is missing its launch journal id/);
  assert.match(js, /not loaded from the local launch-journal store/);
  assert.match(js, /Loaded launch journal does not match proof/);
  assert.match(js, /Local launch journal does not match proof/);
  assert.match(js, /local launch journal is missing proof backing/);
  assert.match(js, /Launch journal is not terminal/);
  assert.match(js, /Completed proof is missing its frozen launch-config snapshot/);
  assert.match(js, /Completed proof has an incomplete frozen launch-config snapshot/);
  assert.match(js, /Completed proof has a mismatched frozen launch-config snapshot/);
  assert.match(js, /Proof launch-config snapshot is incomplete/);
  assert.match(js, /Proof launch-config snapshot does not match launch evidence/);
  assert.match(js, /Completed proof is missing its launch wallet/);
  assert.match(js, /Token authority proof is \$\{liveTokenAuthorityPassCount\}\/\$\{liveTokenAuthorityFields\.length\}/);
  assert.match(js, /launch-config-proof/);
  assert.match(js, /Proof carries the frozen non-secret launch configuration snapshot/);
  assert.match(js, /const tokenAuthorityFields = \['mintAuthorityRenounced', 'freezeAuthorityDisabled', 'metadataUpdateAuthorityRevoked', 'metadataImmutable'\]/);
  assert.match(js, /const tokenAuthorityPassCount = tokenAuthorityFields\.filter/);
  assert.match(js, /const completedDemoRun = demoRunHasCompletedReadiness\(\)/);
  assert.match(js, /const tokenComplete = Boolean\(completedDemoRun \|\| \(tokenMint && tokenAuthorityComplete\)\)/);
  assert.match(js, /authority proof is \$\{tokenAuthorityPassCount\}\/\$\{tokenAuthorityFields\.length\}/);
  assert.doesNotMatch(js, /const tokenComplete = Boolean\(proof\?\.token\?\.mint\) \|\| isReadinessPhaseComplete\('token'\)/);
  assert.match(js, /function demoRunLaunchConfig\(run = state\.lastDemoLaunchRun\)/);
  assert.match(js, /const config = demoRunLaunchConfig\(state\.lastDemoLaunchRun\)/);
  assert.match(js, /const config = demoRunLaunchConfig\(run\)/);
  assert.match(js, /const localDossier = currentLocalDossier\(proof, config\)/);
  assert.match(js, /const reportDone = Boolean\(reportUri \|\| localDossier\)/);
  assert.match(js, /const proofConfig = proofConfigForFingerprint\(proof, config\)/);
  assert.match(js, /const proofTopology = proofConfig\.poolTopology \|\| topology/);
  assert.match(js, /const plannedPools = buildV2ReportPoolPlan\(proofConfig, proofResults, proof\)/);
  assert.match(js, /const poolTarget = Math\.max\(1, plannedPools\.length \|\| proofTopology\.pools\?\.length \|\| topology\.pools\.length\)/);
  assert.match(js, /const airdropStatus = airdropCompletionStatus\(proof, proofTopology\)/);
  assert.match(js, /const airdropComplete = liveAirdropComplete\(proofTopology, proof\)/);
  assert.match(js, /const report = currentReportPublish\(proof, proofConfig, \{ allowTransient: true \}\)/);
  assert.match(js, /const localDossier = currentLocalDossier\(proof, proofConfig\)/);
  assert.match(js, /const reportPublishEvidence = proofHasReportPublishEvidence\(proof, proofConfig\)/);
  assert.match(js, /const reportReady = Boolean\(\s*airdropStatus\.complete\s*&& \(\(proof\?\.canPublishReport && reportPublishEvidence\) \|\| \(reportLocalOnly && reportPublishEvidence\)\)\s*\)/);
  assert.match(js, /const reportProofReady = proofHasReportPublishEvidence\(proof, config\) && airdropStatus\.complete/);
  assert.match(js, /const canDownloadDossier = canDownload && \(!proof\?\.token\?\.mint \|\| reportProofReady \|\| reportNeedsFinalArtifact\)/);
  assert.match(js, /const airdropIssue = airdropCompletionIssue\(\s*airdropCompletionStatus\(proof, config\.poolTopology\),\s*'downloading the launch dossier',\s*\)/);
  assert.match(js, /function airdropCompletionStatus\(proof = currentLaunchProof\(\), topology = currentClassicModel\(\)\)/);
  assert.match(js, /const evidence = comparisonAirdropDeliveryEvidenceState\(\{/);
  assert.match(js, /complete: evidence\.complete/);
  assert.match(js, /function airdropCompletionIssue\(status = \{\}, actionLabel = 'final sweep'\)/);
  assert.match(js, /Airdrop proof is incomplete \(\$\{missing\}\); refresh or rerun airdrop before \$\{actionLabel\}/);
  assert.match(js, /function liveAirdropComplete\(topology, proof\) \{\s*const status = airdropCompletionStatus\(proof, topology\);\s*return status\.complete;\s*\}/);
  assert.doesNotMatch(js, /liveDone >= liveTotal && liveFailed === 0/);
  assert.match(js, /function proofHasReportablePoolIdentity\(proof = \{\}, config = currentLaunchConfig\(\)\)/);
  assert.match(js, /function v2LiquidityTransactionEvidenceCounts\(results = \[\]\)/);
  assert.match(js, /function proofHasReportPublishEvidence\(proof = \{\}, config = currentLaunchConfig\(\)\)/);
  assert.match(js, /recordedPoolIds\.length === plannedPoolCount\s*&& liquidityEvidence\.poolCount === recordedPoolIds\.length/);
  assert.match(js, /const txEvidence = v2LiquidityTransactionEvidenceCounts\(results\)/);
  assert.match(js, /txEvidence\.poolCreateTxCount >= plannedPoolCount/);
  assert.match(js, /txEvidence\.openTxCount >= recordedPositionCount/);
  assert.match(js, /txEvidence\.lockTxCount >= recordedPositionCount/);
  assert.match(js, /txEvidence\.feeKeyRecipientTransferred >= feeKeyRecipientTarget/);
  assert.match(js, /if \(!proof\?\.token\?\.mint \|\| !proofHasReportPublishEvidence\(proof, config\)\) return null/);
  assert.match(js, /if \(!proofHasReportPublishEvidence\(proof, config\)\) \{/);
  assert.match(js, /Complete liquidity proof before publishing a report/);
  assert.match(js, /poolIds: recordedPoolIds/);
  assert.match(js, /Report publishing is off; download the local HTML\/JSON dossier before review/);
  assert.doesNotMatch(js, /state\.prefs\.publishLaunchReport === false,\s*\)/);
  assert.match(js, /const terminalSweepComplete = Boolean\(completedDemoRun \|\| transferHasWalletEmptyFinalSweepEvidence\(proof\?\.transfer\)\)/);
  assert.match(js, /const sweepNeedsProof = sweepReadinessComplete && !terminalSweepComplete/);
  assert.doesNotMatch(js, /state\.lastDemoLaunchRun\s*\|\|\s*transferHasFinalSweepEvidence\(proof\?\.transfer\)\s*\|\|\s*isReadinessPhaseComplete\('sweep'\)/);
  assert.match(js, /complete: terminalSweepComplete/);
  assert.match(js, /wallet-empty, error-free final-sweep proof is still missing/);
  assert.match(js, /const plannedPositionCount = plannedPools\.reduce/);
  assert.match(js, /const liquidityEvidence = comparisonLiquidityEvidenceState\(proof, \{/);
  assert.match(js, /const recordedPoolIds = launchProofPoolIds\(proof\)/);
  assert.match(js, /const recordedPoolIdCount = recordedPoolIds\.length/);
  assert.match(js, /const recordedPositionCount = liquidityEvidence\.positionCount/);
  assert.match(js, /const liquidityTxEvidence = v2LiquidityTransactionEvidenceCounts\(proofResults\)/);
  assert.match(js, /const poolsRecorded = recordedPoolIdCount === poolTarget\s*&& reportedPoolCount === recordedPoolIdCount\s*&& poolCreateTxCount >= poolTarget\s*&& !liquidityEvidence\.missing\.includes\('pool count'\)/);
  assert.match(js, /poolCreateTxCount >= poolTarget/);
  assert.match(js, /openTxCount >= recordedPositionCount/);
  assert.match(js, /lockTxCount >= recordedPositionCount/);
  assert.match(js, /recordedPoolCount === plannedPoolCount\s*&& liquidityEvidence\.poolCount === recordedPoolCount\s*&& poolTxCount >= plannedPoolCount\s*&& !liquidityEvidence\.missing\.includes\('pool count'\)/);
  assert.match(js, /const liquidityComplete = Boolean\(completedDemoRun \|\| \(poolsRecorded && positionsRecorded\)\)/);
  assert.match(js, /const liquidityNeedsPositionProof = Boolean\(\(liquidityPhaseComplete \|\| poolsRecorded\) && !liquidityComplete\)/);
  assert.match(js, /const locksRecorded = recordedPositionCount > 0\s*&& lockedPositionCount >= recordedPositionCount\s*&& lockTxCount >= recordedPositionCount\s*&& !liquidityEvidence\.missing\.includes\('lock count'\)/);
  assert.match(js, /const feeKeysRecorded = locksRecorded\s*&& feeKeyCount >= lockedPositionCount\s*&& !liquidityEvidence\.missing\.includes\('fee key count'\)/);
  assert.match(js, /const feeKeyRecipientTarget = liquidityTxEvidence\.feeKeyRecipientRows\.length/);
  assert.match(js, /const feeKeyRecipientsDelivered = feeKeyRecipientTarget <= 0 \|\| feeKeyRecipientTransferred >= feeKeyRecipientTarget/);
  assert.match(js, /const lockComplete = Boolean\(\s*completedDemoRun\s*\|\|\s*\(locksRecorded && feeKeysRecorded && feeKeyRecipientsDelivered\)\s*\)/);
  assert.match(js, /Fee Key recipient transfer\$\{feeKeyRecipientTarget === 1 \? '' : 's'\} recorded; retry or forward from sweep destination before completion/);
  assert.match(js, /pool-create tx proof is \$\{poolCreateTxCount\}\/\$\{poolTarget\}, position-open tx proof is \$\{openTxCount\}\/\$\{recordedPositionCount \|\| plannedPositionCount \|\| '\?'\}/);
  assert.match(js, /const liveLiquidityProofComplete = Boolean\(livePoolIdentityComplete && livePositionProofComplete && liveLockProofComplete\)/);
  assert.match(js, /Pool-create transaction proof is \$\{txEvidence\.poolCreateTxCount\}\/\$\{plannedPoolCount\}/);
  assert.match(js, /Position-open transaction proof is \$\{txEvidence\.openTxCount\}\/\$\{recordedPositionCount\}/);
  assert.match(js, /Burn & Earn lock transaction proof is \$\{txEvidence\.lockTxCount\}\/\$\{recordedPositionCount\}/);
  assert.match(js, /if \(demoRunHasCompletedReadiness\(\) && state\.lastDemoLaunchRun\?\.liquidity\) return true/);
  assert.match(js, /const sweepComplete = Boolean\(demoRunHasCompletedReadiness\(\) \|\| transferHasWalletEmptyFinalSweepEvidence\(proof\?\.transfer\)\)/);
  assert.match(js, /finalSweepComplete \? 'Recorded' : proof\?\.transfer \? 'Needs proof'/);
  assert.match(js, /Final sweep record is not terminal/);
  assert.match(js, /proof\?\.journalId \? 'pass' : proof \? 'warn' : state\.recovery\?\.journalCount \? 'warn' : 'missing'/);
  assert.match(js, /attach the completed launch journal id to the proof before retiring Classic/);
  assert.match(js, /const hasProofLaunchWallet = Boolean\(proof\?\.walletPublicKey\)/);
  assert.match(js, /Mint \$\{shortAddress\(token\.mint\)\} is recorded, but launch wallet proof is missing/);
});

test('v2 local terminal journal proof binds pool records, not only pool ids', () => {
  const harness = loadClassicRetirementGateHarness();
  const transfer = {
    destinationWallet: 'Dest111111111111111111111111111111111111111',
    walletEmpty: true,
    tokenSweep: {
      transferred: [{ mint: 'Mint111111111111111111111111111111111111', amount: '1', txId: 'SweepTx11111111111111111111111111111111' }],
      errors: [],
    },
    nftSweep: { transferred: [], errors: [] },
  };
  const pool = {
    poolId: 'Pool111111111111111111111111111111111111',
    quoteMint: 'So11111111111111111111111111111111111111112',
    supplyPercent: 80,
    tickSpacing: 60,
    initialPrice: '0.001',
    launchedSide: 'base',
    createPoolTx: 'CreatePoolTx111111111111111111111111111111',
    mainPositions: [{
      sliceIndex: 0,
      positionNftMint: 'Position111111111111111111111111111111111',
      feeKeyNftMint: 'FeeKey1111111111111111111111111111111111',
      locked: true,
      openTx: 'OpenTx111111111111111111111111111111111',
      lockTx: 'LockTx111111111111111111111111111111111',
    }],
  };
  const proof = {
    status: 'completed',
    stage: 'transfer_completed',
    journalId: 'journal-pool-record',
    walletPublicKey: 'Wallet11111111111111111111111111111111111',
    token: {
      mint: 'Mint111111111111111111111111111111111111',
      mintAuthorityRenounced: true,
      freezeAuthorityDisabled: true,
      metadataUpdateAuthorityRevoked: true,
      metadataImmutable: true,
    },
    liquidity: {
      poolCount: 1,
      poolIds: [pool.poolId],
      positionCount: 1,
      lockedPositionCount: 1,
      feeKeyCount: 1,
      results: [pool],
    },
    transfer,
  };
  const journal = {
    id: proof.journalId,
    walletPublicKey: proof.walletPublicKey,
    status: 'completed',
    stage: 'transfer_completed',
    token: { ...proof.token },
    poolPlan: { allocations: [{ quoteToken: 'SOL', supplyPercent: 80 }] },
    lp: {
      results: [{
        ...pool,
        createPoolTx: 'DifferentCreatePoolTx1111111111111111111111',
      }],
    },
    transfer,
  };
  harness.state.recovery = { journals: [journal], journalCount: 1 };

  const mismatch = harness.proofJournalEvidenceState(proof);
  assert.equal(mismatch.backed, false);
  assert.match([...mismatch.mismatches].join(','), /pool records/);
  assert.equal(harness.proofHasTerminalLaunchJournal(proof), false);

  harness.state.recovery.journals[0].lp.results[0].createPoolTx = pool.createPoolTx;
  const backed = harness.proofJournalEvidenceState(proof);
  assert.equal(backed.backed, true);
  assert.deepEqual([...backed.mismatches], []);
  assert.equal(harness.proofHasTerminalLaunchJournal(proof), true);
});

test('v2 retirement gate only passes completed live proof compared to Classic', () => {
  const gateStart = js.indexOf('function buildClassicRetirementGate');
  const gateEnd = js.indexOf('\nfunction loadedRecoveryJournalEvidence', gateStart);
  assert.ok(gateStart >= 0 && gateEnd > gateStart, 'classic retirement gate should be extractable');
  const gateBody = js.slice(gateStart, gateEnd);
  assert.match(gateBody, /const report = currentReportPublish\(proof, config\)/);
  assert.doesNotMatch(gateBody, /currentReportPublish\(proof, config, \{ allowTransient: true \}\)/);

  const harness = loadClassicRetirementGateHarness();
  const audit = { status: 'pass', passCount: 12, itemCount: 12, missingCount: 0, warnCount: 0, proofFingerprint: 'proof-bound' };
  const classicEvidenceRows = [
    'mint',
    'launch-wallet',
    'pools',
    'authority-posture',
    'positionCount',
    'lockedPositionCount',
    'feeKeyCount',
    'destination',
  ].map((id) => ({ id, label: id, state: 'pass' }));
  const classicComparison = {
    status: 'pass',
    artifactSource: 'classic',
    structuredEvidence: true,
    passCount: classicEvidenceRows.length,
    fieldCount: classicEvidenceRows.length,
    proofFingerprint: 'proof-bound',
    rows: classicEvidenceRows,
  };
  const proof = {
    journalId: 'journal-gate-proof-1',
    status: 'completed',
    stage: 'transfer_completed',
    walletPublicKey: 'WalletGate111111111111111111111111111111111',
    launchConfig: {
      schema: 'trebuchet-v2-launch-config',
      source: 'trebuchet-v2',
      token: { name: 'Gate', symbol: 'GATE', supply: '1000', decimals: 9 },
      poolTopology: {
        sweepDestination: 'DestGate111111111111111111111111111111111',
        totalPoolPercent: 100,
        pools: [{ id: 'pool-1', quoteToken: 'SOL', supplyPercent: 100, plannedPositionCount: 1 }],
        airdrop: { enabled: false, supplyPercent: 0 },
      },
    },
    token: {
      mint: 'MintGate11111111111111111111111111111111111',
      name: 'Gate',
      symbol: 'GATE',
      totalSupply: '1000',
      decimals: 9,
      mintAuthorityRenounced: true,
      freezeAuthorityDisabled: true,
      metadataUpdateAuthorityRevoked: true,
      metadataImmutable: true,
    },
    liquidity: {
      poolCount: 1,
      positionCount: 1,
      lockedPositionCount: 1,
      feeKeyCount: 1,
      results: [{
        poolId: 'PoolGate111111111111111111111111111111111',
        txIds: { createPool: 'CreatePoolTxGate11111111111111111111111111' },
        positionCount: 1,
        mainPositions: [{
          sliceIndex: 0,
          sharePercent: 100,
          positionNftMint: 'PositionGate111111111111111111111111111111',
          locked: true,
          recipient: 'FeeRecipientGate11111111111111111111111111',
          transferredTo: 'FeeRecipientGate11111111111111111111111111',
          feeKeyNftMint: 'FeeKeyGate1111111111111111111111111111111',
          txIds: {
            open: 'OpenTxGate111111111111111111111111111111111',
            lock: 'LockTxGate111111111111111111111111111111111',
            transfer: 'FeeTransferTxGate11111111111111111111111111',
          },
        }],
      }],
    },
    transfer: {
      walletEmpty: true,
      destinationWallet: 'DestGate111111111111111111111111111111111',
    },
    reportPublish: { htmlUri: 'ar://proof-bound-report', proofFingerprint: 'proof-bound' },
    reportParity: {
      viewportSmoke: { passed: true },
    },
  };
  proof.reportPublish.sweepEvidenceHash = harness.comparisonTransferEvidenceHash(proof.transfer);
  const airdropProof = {
    ...proof,
    airdrop: {
      plannedRecipientCount: 1,
      deliveredCount: 1,
      failedCount: 0,
      recipients: [{ wallet: 'AirdropWalletGate11111111111111111111111111', tokens: 25 }],
      transferred: [{
        wallet: 'AirdropWalletGate11111111111111111111111111',
        tokens: 25,
        txId: 'AirdropTxGate111111111111111111111111111111',
      }],
      failed: [],
    },
  };
  const matchingJournalLpResult = {
    ...proof.liquidity.results[0],
    allocationIndex: 0,
    phase1Complete: true,
  };
  const matchingJournalToken = {
    mint: proof.token.mint,
    mintAuthorityRenounced: true,
    freezeAuthorityDisabled: true,
    metadataUpdateAuthorityRevoked: true,
    metadataImmutable: true,
  };
  const replacementViewportChecks = {
    launchVisible: true,
    horizontalOverflow: true,
    tokenomicsChart: true,
    liquidityChart: true,
    fundingMeter: true,
    parityPanel: true,
    firstViewportFit: true,
  };
  const validViewportSmoke = {
    artifactVersion: 1,
    kind: 'trebuchet-v2-viewport-smoke',
    passed: true,
    state: 'valid',
    generatedAt: '2026-06-30T00:00:00.000Z',
    viewports: [
      { name: 'desktop', passed: true, checks: replacementViewportChecks },
      { name: 'mobile', passed: true, checks: replacementViewportChecks },
    ],
    assetHashes: {
      'index.html': 'a'.repeat(64),
      'styles.css': 'b'.repeat(64),
      'api-client.js': 'c'.repeat(64),
      'app.js': 'd'.repeat(64),
    },
  };

  harness.state.classicReportComparison = { result: classicComparison };
  harness.state.viewportSmoke = validViewportSmoke;
  harness.state.recovery = {
    journalCount: 1,
    journals: [{
      id: proof.journalId,
      walletPublicKey: proof.walletPublicKey,
      status: 'completed',
      stage: 'transfer_completed',
      token: matchingJournalToken,
      lp: { results: [matchingJournalLpResult] },
      transfer: {
        destinationWallet: proof.transfer.destinationWallet,
        walletEmpty: true,
      },
    }],
  };
  const liveGate = harness.buildClassicRetirementGate(proof, audit);
  assert.equal(liveGate.state, 'pass');
  assert.equal(liveGate.requirements.find((item) => item.id === 'live-proof').pass, true);
  assert.equal(liveGate.requirements.find((item) => item.id === 'classic-comparison').pass, true);
  assert.equal(liveGate.requirements.find((item) => item.id === 'replacement-criteria').pass, true);
  assert.equal(liveGate.replacementCriteria.find((item) => item.id === 'held-reserve-backing')?.pass, true);

  const transientReportGate = harness.buildClassicRetirementGate({
    ...proof,
    reportPublish: { ...proof.reportPublish, transientOnly: true },
  }, audit);
  assert.equal(transientReportGate.state, 'danger');
  assert.equal(transientReportGate.requirements.find((item) => item.id === 'report-proof').pass, false);
  assert.match(transientReportGate.requirements.find((item) => item.id === 'report-proof').detail, /Publish or attach a proof-bound/);
  assert.equal(transientReportGate.requirements.find((item) => item.id === 'replacement-criteria').pass, false);
  assert.match(transientReportGate.replacementCriteria.find((item) => item.id === 'sweep-report-proof').evidence, /Publish or download/);

  harness.state.currentConfig = {
    poolTopology: {
      pools: [{ id: 'typed-only-pool', quoteToken: 'SOL', plannedPositionCount: 1 }],
      airdrop: { enabled: false, supplyPercent: 0 },
    },
  };
  const partialTwoPoolProof = {
    ...proof,
    launchConfig: {
      ...proof.launchConfig,
      poolTopology: {
        ...proof.launchConfig.poolTopology,
        pools: [
          { id: 'pool-1', quoteToken: 'SOL', supplyPercent: 50, plannedPositionCount: 1 },
          { id: 'pool-2', quoteToken: 'seige', supplyPercent: 50, plannedPositionCount: 1 },
        ],
      },
    },
  };
  const staleTypedConfigGate = harness.buildClassicRetirementGate(partialTwoPoolProof, audit);
  assert.equal(staleTypedConfigGate.state, 'danger');
  assert.equal(staleTypedConfigGate.requirements.find((item) => item.id === 'live-proof').pass, false);
  assert.match(staleTypedConfigGate.requirements.find((item) => item.id === 'live-proof').detail, /Pool identity proof is 1\/2/);
  harness.state.currentConfig = null;

  const missingPoolIdentityProof = {
    ...proof,
    liquidity: {
      ...proof.liquidity,
      poolIds: [],
      results: proof.liquidity.results.map((pool) => {
        const { poolId: _poolId, ...rest } = pool;
        return rest;
      }),
    },
  };
  harness.state.recovery.journals[0].lp.results = missingPoolIdentityProof.liquidity.results.map((pool) => ({
    ...pool,
    allocationIndex: 0,
    phase1Complete: true,
  }));
  const missingPoolIdentityGate = harness.buildClassicRetirementGate(missingPoolIdentityProof, audit);
  assert.equal(missingPoolIdentityGate.state, 'danger');
  assert.equal(missingPoolIdentityGate.requirements.find((item) => item.id === 'live-proof').pass, false);
  assert.match(missingPoolIdentityGate.requirements.find((item) => item.id === 'live-proof').detail, /Pool identity proof is 0\/1/);
  harness.state.recovery.journals[0].lp.results = [matchingJournalLpResult];

  const missingPoolTxProof = {
    ...proof,
    liquidity: {
      ...proof.liquidity,
      results: proof.liquidity.results.map((pool) => {
        const { txIds: _txIds, createPoolTx: _createPoolTx, ...rest } = pool;
        return rest;
      }),
    },
  };
  harness.state.recovery.journals[0].lp.results = missingPoolTxProof.liquidity.results.map((pool) => ({
    ...pool,
    allocationIndex: 0,
    phase1Complete: true,
  }));
  const missingPoolTxGate = harness.buildClassicRetirementGate(missingPoolTxProof, audit);
  assert.equal(missingPoolTxGate.state, 'danger');
  assert.equal(missingPoolTxGate.requirements.find((item) => item.id === 'live-proof').pass, false);
  assert.match(missingPoolTxGate.requirements.find((item) => item.id === 'live-proof').detail, /Pool-create transaction proof is 0\/1/);
  harness.state.recovery.journals[0].lp.results = [matchingJournalLpResult];

  const missingPositionTxProof = {
    ...proof,
    liquidity: {
      ...proof.liquidity,
      results: proof.liquidity.results.map((pool) => ({
        ...pool,
        mainPositions: pool.mainPositions.map((position) => ({
          ...position,
          txIds: {
            ...position.txIds,
            open: '',
          },
        })),
      })),
    },
  };
  harness.state.recovery.journals[0].lp.results = missingPositionTxProof.liquidity.results.map((pool) => ({
    ...pool,
    allocationIndex: 0,
    phase1Complete: true,
  }));
  const missingPositionTxGate = harness.buildClassicRetirementGate(missingPositionTxProof, audit);
  assert.equal(missingPositionTxGate.state, 'danger');
  assert.equal(missingPositionTxGate.requirements.find((item) => item.id === 'live-proof').pass, false);
  assert.match(missingPositionTxGate.requirements.find((item) => item.id === 'live-proof').detail, /Position-open transaction proof is 0\/1/);
  harness.state.recovery.journals[0].lp.results = [matchingJournalLpResult];

  const missingLockTxProof = {
    ...proof,
    liquidity: {
      ...proof.liquidity,
      results: proof.liquidity.results.map((pool) => ({
        ...pool,
        mainPositions: pool.mainPositions.map((position) => ({
          ...position,
          txIds: {
            ...position.txIds,
            lock: '',
          },
        })),
      })),
    },
  };
  harness.state.recovery.journals[0].lp.results = missingLockTxProof.liquidity.results.map((pool) => ({
    ...pool,
    allocationIndex: 0,
    phase1Complete: true,
  }));
  const missingLockTxGate = harness.buildClassicRetirementGate(missingLockTxProof, audit);
  assert.equal(missingLockTxGate.state, 'danger');
  assert.equal(missingLockTxGate.requirements.find((item) => item.id === 'live-proof').pass, false);
  assert.match(missingLockTxGate.requirements.find((item) => item.id === 'live-proof').detail, /Burn & Earn lock transaction proof is 0\/1/);
  harness.state.recovery.journals[0].lp.results = [matchingJournalLpResult];

  harness.state.classicReportComparison = {};
  const legacyAliasGate = harness.buildClassicRetirementGate({
    ...proof,
    reportParity: {
      ...proof.reportParity,
      classicComparison,
    },
  }, audit);
  assert.equal(legacyAliasGate.requirements.find((item) => item.id === 'classic-comparison').pass, true);
  assert.match(js, /reportParityClassicComparison\(proof\?\.reportParity\)/);
  harness.state.classicReportComparison = { result: classicComparison };

  const heldReserveProof = {
    ...proof,
    launchConfig: {
      ...proof.launchConfig,
      poolTopology: {
        ...proof.launchConfig.poolTopology,
        totalPoolPercent: 90,
        reservePercent: 5,
        pools: [{ ...proof.launchConfig.poolTopology.pools[0], supplyPercent: 90 }],
        preallocation: { enabled: true, supplyPercent: 5, source: 'team-reserve' },
        airdrop: { enabled: false, supplyPercent: 0 },
      },
    },
    reportPublish: { ...proof.reportPublish },
  };
  const heldReserveMissingAuditGate = harness.buildClassicRetirementGate(heldReserveProof, audit);
  assert.equal(heldReserveMissingAuditGate.state, 'danger');
  assert.equal(heldReserveMissingAuditGate.requirements.find((item) => item.id === 'replacement-criteria').pass, false);
  assert.match(
    heldReserveMissingAuditGate.replacementCriteria.find((item) => item.id === 'held-reserve-backing').evidence,
    /missing the held-reserve audit/,
  );

  const heldReserveStaleDossierAuditProof = {
    ...heldReserveProof,
    localDossier: {
      status: 'downloaded',
      kind: 'local-dossier-html',
      filename: 'trebuchet-stale-held-reserve.html',
      mint: heldReserveProof.token.mint,
      downloadedAt: '2026-06-30T00:00:00.000Z',
      dataVersion: 14,
      proofFingerprint: 'proof-bound',
      sweepEvidenceHash: 'wrong-sweep-hash',
      heldReserveAudit: {
        state: 'pass',
        detail: 'Stale local dossier claims held reserve is backed.',
        heldReservePercent: 5,
        supportSol: 12.5,
        requiredSupportSol: 12.5,
        coverage: 1,
      },
    },
  };
  const heldReserveStaleDossierAuditGate = harness.buildClassicRetirementGate(heldReserveStaleDossierAuditProof, audit);
  assert.equal(heldReserveStaleDossierAuditGate.state, 'danger');
  assert.equal(heldReserveStaleDossierAuditGate.replacementCriteria.find((item) => item.id === 'held-reserve-backing')?.pass, false);
  assert.match(
    heldReserveStaleDossierAuditGate.replacementCriteria.find((item) => item.id === 'held-reserve-backing').evidence,
    /missing the held-reserve audit/,
  );

  const heldReserveBackedProof = {
    ...heldReserveProof,
    reportPublish: {
      ...heldReserveProof.reportPublish,
      dataVersion: 14,
      heldReserveAudit: {
        state: 'pass',
        detail: 'Held reserve is backed by equal-value support liquidity.',
        heldReservePercent: 5,
        explicitPreallocationPercent: 5,
        airdropReservePercent: 0,
        unallocatedReservePercent: 5,
        supportSol: 12.5,
        requiredSupportSol: 12.5,
        coverage: 1,
      },
    },
  };
  const heldReserveBackedGate = harness.buildClassicRetirementGate(heldReserveBackedProof, audit);
  assert.equal(heldReserveBackedGate.state, 'pass');
  assert.equal(heldReserveBackedGate.replacementCriteria.find((item) => item.id === 'held-reserve-backing')?.pass, true);

  const sweptAssetOnlyProof = {
    ...proof,
    transfer: {
      destinationWallet: proof.transfer.destinationWallet,
      tokenSweep: {
        transferred: [{ mint: proof.token.mint, txId: 'ThinSweepTxGate111111111111111111111111111' }],
        errors: [],
      },
    },
  };
  const sweptAssetOnlyProofGate = harness.buildClassicRetirementGate(sweptAssetOnlyProof, audit);
  assert.equal(sweptAssetOnlyProofGate.state, 'danger');
  assert.equal(sweptAssetOnlyProofGate.requirements.find((item) => item.id === 'live-proof').pass, false);
  assert.match(sweptAssetOnlyProofGate.requirements.find((item) => item.id === 'live-proof').detail, /Final sweep record is not terminal/);
  assert.match(sweptAssetOnlyProofGate.requirements.find((item) => item.id === 'live-proof').detail, /wallet-empty, error-free/);
  assert.equal(sweptAssetOnlyProofGate.requirements.find((item) => item.id === 'replacement-criteria').pass, false);
  assert.match(sweptAssetOnlyProofGate.replacementCriteria.find((item) => item.id === 'sweep-report-proof').evidence, /terminal final-sweep evidence is still required/);

  harness.state.recovery = {
    journalCount: 1,
    journals: [{
      id: proof.journalId,
      walletPublicKey: proof.walletPublicKey,
      status: 'completed',
      stage: 'transfer_completed',
      token: { mint: proof.token.mint },
      lp: { results: [matchingJournalLpResult] },
      transfer: {
        destinationWallet: proof.transfer.destinationWallet,
        walletEmpty: true,
      },
    }],
  };
  const weakAuthorityJournalGate = harness.buildClassicRetirementGate(proof, audit);
  assert.equal(weakAuthorityJournalGate.state, 'danger');
  assert.equal(weakAuthorityJournalGate.requirements.find((item) => item.id === 'live-proof').pass, false);
  assert.match(weakAuthorityJournalGate.requirements.find((item) => item.id === 'live-proof').detail, /missing proof backing/);
  assert.match(weakAuthorityJournalGate.requirements.find((item) => item.id === 'live-proof').detail, /journal token authority/);
  assert.equal(weakAuthorityJournalGate.requirements.find((item) => item.id === 'replacement-criteria').pass, false);

  harness.state.recovery = {
    journalCount: 1,
    journals: [{
      id: proof.journalId,
      walletPublicKey: proof.walletPublicKey,
      status: 'completed',
      stage: 'transfer_completed',
      token: {
        ...matchingJournalToken,
        freezeAuthorityDisabled: false,
      },
      lp: { results: [matchingJournalLpResult] },
      transfer: {
        destinationWallet: proof.transfer.destinationWallet,
        walletEmpty: true,
      },
    }],
  };
  const mismatchedAuthorityJournalGate = harness.buildClassicRetirementGate(proof, audit);
  assert.equal(mismatchedAuthorityJournalGate.state, 'danger');
  assert.equal(mismatchedAuthorityJournalGate.requirements.find((item) => item.id === 'live-proof').pass, false);
  assert.match(mismatchedAuthorityJournalGate.requirements.find((item) => item.id === 'live-proof').detail, /does not match proof/);
  assert.match(mismatchedAuthorityJournalGate.requirements.find((item) => item.id === 'live-proof').detail, /token authority/);
  assert.equal(mismatchedAuthorityJournalGate.requirements.find((item) => item.id === 'replacement-criteria').pass, false);

  harness.state.recovery = {
    journalCount: 1,
    journals: [{
      id: proof.journalId,
      walletPublicKey: proof.walletPublicKey,
      status: 'completed',
      stage: 'transfer_completed',
      token: matchingJournalToken,
      lp: {
        results: [{
          ...matchingJournalLpResult,
          mainPositions: [],
          ladderPositions: [],
          supportPositions: [],
          bootstrap: null,
        }],
      },
      transfer: {
        destinationWallet: proof.transfer.destinationWallet,
        walletEmpty: true,
      },
    }],
  };
  const weakPositionJournalGate = harness.buildClassicRetirementGate(proof, audit);
  assert.equal(weakPositionJournalGate.state, 'danger');
  assert.equal(weakPositionJournalGate.requirements.find((item) => item.id === 'live-proof').pass, false);
  assert.match(weakPositionJournalGate.requirements.find((item) => item.id === 'live-proof').detail, /missing proof backing/);
  assert.match(weakPositionJournalGate.requirements.find((item) => item.id === 'live-proof').detail, /journal position records/);
  assert.match(weakPositionJournalGate.requirements.find((item) => item.id === 'live-proof').detail, /journal lock proof/);
  assert.equal(weakPositionJournalGate.requirements.find((item) => item.id === 'replacement-criteria').pass, false);

  harness.state.recovery = {
    journalCount: 1,
    journals: [{
      id: proof.journalId,
      walletPublicKey: proof.walletPublicKey,
      status: 'completed',
      stage: 'transfer_completed',
      token: matchingJournalToken,
      lp: {
        results: [{
          ...matchingJournalLpResult,
          mainPositions: [{
            ...matchingJournalLpResult.mainPositions[0],
            transferredTo: 'WrongFeeRecipientGate111111111111111111111',
          }],
        }],
      },
      transfer: {
        destinationWallet: proof.transfer.destinationWallet,
        walletEmpty: true,
      },
    }],
  };
  const mismatchedPositionJournalGate = harness.buildClassicRetirementGate(proof, audit);
  assert.equal(mismatchedPositionJournalGate.state, 'danger');
  assert.equal(mismatchedPositionJournalGate.requirements.find((item) => item.id === 'live-proof').pass, false);
  assert.match(mismatchedPositionJournalGate.requirements.find((item) => item.id === 'live-proof').detail, /does not match proof/);
  assert.match(mismatchedPositionJournalGate.requirements.find((item) => item.id === 'live-proof').detail, /position records/);
  assert.equal(mismatchedPositionJournalGate.requirements.find((item) => item.id === 'replacement-criteria').pass, false);

  harness.state.recovery = {
    journalCount: 1,
    journals: [{
      id: proof.journalId,
      walletPublicKey: proof.walletPublicKey,
      status: 'completed',
      stage: 'transfer_completed',
      token: matchingJournalToken,
      lp: { results: [matchingJournalLpResult] },
      airdrop: {
        transferred: airdropProof.airdrop.transferred,
        failed: [],
      },
      transfer: {
        destinationWallet: proof.transfer.destinationWallet,
        walletEmpty: true,
      },
    }],
  };
  const airdropBackedGate = harness.buildClassicRetirementGate(airdropProof, audit);
  assert.equal(airdropBackedGate.state, 'pass');
  assert.equal(airdropBackedGate.requirements.find((item) => item.id === 'live-proof').pass, true);

  harness.state.recovery = {
    journalCount: 1,
    journals: [{
      id: proof.journalId,
      walletPublicKey: proof.walletPublicKey,
      status: 'completed',
      stage: 'transfer_completed',
      token: matchingJournalToken,
      lp: { results: [matchingJournalLpResult] },
      airdrop: {
        transferred: [{
          wallet: 'OtherAirdropWalletGate111111111111111111111',
          tokens: 25,
          txId: 'AirdropTxGate111111111111111111111111111111',
        }],
        failed: [],
      },
      transfer: {
        destinationWallet: proof.transfer.destinationWallet,
        walletEmpty: true,
      },
    }],
  };
  const mismatchedAirdropJournalGate = harness.buildClassicRetirementGate(airdropProof, audit);
  assert.equal(mismatchedAirdropJournalGate.state, 'danger');
  assert.equal(mismatchedAirdropJournalGate.requirements.find((item) => item.id === 'live-proof').pass, false);
  assert.match(mismatchedAirdropJournalGate.requirements.find((item) => item.id === 'live-proof').detail, /does not match proof/);
  assert.match(mismatchedAirdropJournalGate.requirements.find((item) => item.id === 'live-proof').detail, /airdrop recipients/);
  assert.equal(mismatchedAirdropJournalGate.requirements.find((item) => item.id === 'replacement-criteria').pass, false);

  harness.state.recovery = {
    journalCount: 1,
    journals: [{
      id: proof.journalId,
      walletPublicKey: proof.walletPublicKey,
      status: 'completed',
      stage: 'transfer_completed',
      token: matchingJournalToken,
      lp: { results: [matchingJournalLpResult] },
      airdrop: {
        transferred: [{ wallet: airdropProof.airdrop.transferred[0].wallet, tokens: 25 }],
        failed: [],
      },
      transfer: {
        destinationWallet: proof.transfer.destinationWallet,
        walletEmpty: true,
      },
    }],
  };
  const weakAirdropTxJournalGate = harness.buildClassicRetirementGate(airdropProof, audit);
  assert.equal(weakAirdropTxJournalGate.state, 'danger');
  assert.equal(weakAirdropTxJournalGate.requirements.find((item) => item.id === 'live-proof').pass, false);
  assert.match(weakAirdropTxJournalGate.requirements.find((item) => item.id === 'live-proof').detail, /missing proof backing/);
  assert.match(weakAirdropTxJournalGate.requirements.find((item) => item.id === 'live-proof').detail, /journal airdrop transactions/);
  assert.equal(weakAirdropTxJournalGate.requirements.find((item) => item.id === 'replacement-criteria').pass, false);

  harness.state.recovery = { journalCount: 0, journals: [] };
  const missingLocalJournalGate = harness.buildClassicRetirementGate(proof, audit);
  assert.equal(missingLocalJournalGate.state, 'danger');
  assert.equal(missingLocalJournalGate.requirements.find((item) => item.id === 'live-proof').pass, false);
  assert.match(missingLocalJournalGate.requirements.find((item) => item.id === 'live-proof').detail, /not loaded from the local launch-journal store/);
  assert.equal(missingLocalJournalGate.requirements.find((item) => item.id === 'replacement-criteria').pass, false);
  assert.match(missingLocalJournalGate.replacementCriteria.find((item) => item.id === 'run-and-resume').evidence, /matching launch journal is not loaded locally/);
  harness.state.recovery = {
    journalCount: 1,
    journals: [{
      id: proof.journalId,
      walletPublicKey: proof.walletPublicKey,
      status: 'completed',
      stage: 'transfer_completed',
      token: matchingJournalToken,
      lp: { results: [{ poolId: 'WrongPoolGate11111111111111111111111111111', allocationIndex: 0, phase1Complete: true }] },
      transfer: {
        destinationWallet: proof.transfer.destinationWallet,
        walletEmpty: true,
      },
    }],
  };
  const mismatchedPoolJournalGate = harness.buildClassicRetirementGate(proof, audit);
  assert.equal(mismatchedPoolJournalGate.state, 'danger');
  assert.equal(mismatchedPoolJournalGate.requirements.find((item) => item.id === 'live-proof').pass, false);
  assert.match(mismatchedPoolJournalGate.requirements.find((item) => item.id === 'live-proof').detail, /does not match proof/);
  assert.match(mismatchedPoolJournalGate.requirements.find((item) => item.id === 'live-proof').detail, /pool ids/);
  assert.equal(mismatchedPoolJournalGate.requirements.find((item) => item.id === 'replacement-criteria').pass, false);
  assert.match(mismatchedPoolJournalGate.replacementCriteria.find((item) => item.id === 'run-and-resume').evidence, /does not match it: pool ids/);

  harness.state.recovery = {
    journalCount: 1,
    journals: [{
      id: proof.journalId,
      walletPublicKey: proof.walletPublicKey,
      status: 'completed',
      stage: 'transfer_completed',
      token: matchingJournalToken,
      lp: { results: [matchingJournalLpResult] },
      transfer: {
        destinationWallet: 'OtherDestGate111111111111111111111111111111',
        walletEmpty: true,
      },
    }],
  };
  const mismatchedSweepJournalGate = harness.buildClassicRetirementGate(proof, audit);
  assert.equal(mismatchedSweepJournalGate.state, 'danger');
  assert.equal(mismatchedSweepJournalGate.requirements.find((item) => item.id === 'live-proof').pass, false);
  assert.match(mismatchedSweepJournalGate.requirements.find((item) => item.id === 'live-proof').detail, /does not match proof/);
  assert.match(mismatchedSweepJournalGate.requirements.find((item) => item.id === 'live-proof').detail, /sweep destination/);
  assert.equal(mismatchedSweepJournalGate.requirements.find((item) => item.id === 'replacement-criteria').pass, false);
  assert.match(mismatchedSweepJournalGate.replacementCriteria.find((item) => item.id === 'run-and-resume').evidence, /does not match it: sweep destination/);

  const proofWithSweepRow = {
    ...proof,
    transfer: {
      ...proof.transfer,
      tokenSweep: {
        transferred: [{
          mint: proof.token.mint,
          amount: '1',
          decimals: 9,
          txId: 'ProofSweepTxGate1111111111111111111111111111',
        }],
        errors: [],
      },
    },
  };
  harness.state.recovery = {
    journalCount: 1,
    journals: [{
      id: proof.journalId,
      walletPublicKey: proof.walletPublicKey,
      status: 'completed',
      stage: 'transfer_completed',
      token: matchingJournalToken,
      lp: { results: [matchingJournalLpResult] },
      transfer: {
        ...proof.transfer,
        tokenSweep: {
          transferred: [{
            mint: proof.token.mint,
            amount: '1',
            decimals: 9,
            txId: 'JournalSweepTxGate11111111111111111111111111',
          }],
          errors: [],
        },
      },
    }],
  };
  const mismatchedSweepEvidenceGate = harness.buildClassicRetirementGate(proofWithSweepRow, audit);
  assert.equal(mismatchedSweepEvidenceGate.state, 'danger');
  assert.equal(mismatchedSweepEvidenceGate.requirements.find((item) => item.id === 'live-proof').pass, false);
  assert.match(mismatchedSweepEvidenceGate.requirements.find((item) => item.id === 'live-proof').detail, /does not match proof/);
  assert.match(mismatchedSweepEvidenceGate.requirements.find((item) => item.id === 'live-proof').detail, /sweep evidence hash/);
  assert.equal(mismatchedSweepEvidenceGate.requirements.find((item) => item.id === 'replacement-criteria').pass, false);
  assert.match(mismatchedSweepEvidenceGate.replacementCriteria.find((item) => item.id === 'run-and-resume').evidence, /does not match it: sweep evidence hash/);

  harness.state.recovery = {
    journalCount: 1,
    journals: [{
      id: proof.journalId,
      walletPublicKey: proof.walletPublicKey,
      status: 'completed',
      stage: 'transfer_completed',
      token: matchingJournalToken,
      lp: { results: [matchingJournalLpResult] },
      transfer: {
        destinationWallet: proof.transfer.destinationWallet,
        tokenSweep: { transferred: [{ mint: proof.token.mint, txId: 'WeakSweepTx11111111111111111111111111111111' }], errors: [] },
      },
    }],
  };
  const weakSweepJournalGate = harness.buildClassicRetirementGate(proof, audit);
  assert.equal(weakSweepJournalGate.state, 'danger');
  assert.equal(weakSweepJournalGate.requirements.find((item) => item.id === 'live-proof').pass, false);
  assert.match(weakSweepJournalGate.requirements.find((item) => item.id === 'live-proof').detail, /missing proof backing/);
  assert.match(weakSweepJournalGate.requirements.find((item) => item.id === 'live-proof').detail, /terminal journal sweep/);
  assert.equal(weakSweepJournalGate.requirements.find((item) => item.id === 'replacement-criteria').pass, false);
  assert.match(weakSweepJournalGate.replacementCriteria.find((item) => item.id === 'run-and-resume').evidence, /missing proof backing: terminal journal sweep/);

  harness.state.recovery = {
    journalCount: 1,
    journals: [{
      id: proof.journalId,
      walletPublicKey: proof.walletPublicKey,
      status: 'completed',
      stage: 'transfer_completed',
      token: matchingJournalToken,
      lp: { results: [matchingJournalLpResult] },
      transfer: {
        destinationWallet: proof.transfer.destinationWallet,
        walletEmpty: true,
        tokenSweep: {
          transferred: [],
          errors: [{ mint: proof.token.mint, error: 'RPC timeout during sweep' }],
        },
      },
    }],
  };
  const erroredSweepJournalGate = harness.buildClassicRetirementGate(proof, audit);
  assert.equal(erroredSweepJournalGate.state, 'danger');
  assert.equal(erroredSweepJournalGate.requirements.find((item) => item.id === 'live-proof').pass, false);
  assert.match(erroredSweepJournalGate.requirements.find((item) => item.id === 'live-proof').detail, /missing proof backing/);
  assert.match(erroredSweepJournalGate.requirements.find((item) => item.id === 'live-proof').detail, /terminal journal sweep/);
  assert.equal(erroredSweepJournalGate.requirements.find((item) => item.id === 'replacement-criteria').pass, false);
  assert.match(erroredSweepJournalGate.replacementCriteria.find((item) => item.id === 'run-and-resume').evidence, /missing proof backing: terminal journal sweep/);

  harness.state.recovery = {
    journalCount: 1,
    journals: [{
      id: proof.journalId,
      walletPublicKey: proof.walletPublicKey,
      status: 'completed',
      stage: 'transfer_completed',
      token: matchingJournalToken,
      lp: { results: [matchingJournalLpResult] },
      transfer: {
        destinationWallet: proof.transfer.destinationWallet,
        walletEmpty: true,
      },
    }],
  };

  const uriLessReportGate = harness.buildClassicRetirementGate({
    ...proof,
    reportPublish: { status: 'done', proofFingerprint: 'proof-bound' },
  }, audit);
  assert.equal(uriLessReportGate.state, 'danger');
  assert.equal(uriLessReportGate.requirements.find((item) => item.id === 'report-proof').pass, false);
  assert.match(uriLessReportGate.requirements.find((item) => item.id === 'report-proof').detail, /Publish or attach a proof-bound/);
  assert.equal(uriLessReportGate.requirements.find((item) => item.id === 'replacement-criteria').pass, false);
  assert.match(uriLessReportGate.requirements.find((item) => item.id === 'replacement-criteria').detail, /Sweep and report proof/);

  const staleReportGate = harness.buildClassicRetirementGate({
    ...proof,
    reportPublish: { htmlUri: 'ar://stale-report', proofFingerprint: 'stale-proof' },
  }, audit);
  assert.equal(staleReportGate.state, 'danger');
  assert.equal(staleReportGate.requirements.find((item) => item.id === 'report-proof').pass, false);
  assert.match(staleReportGate.requirements.find((item) => item.id === 'report-proof').detail, /belongs to another v2 proof/);

  const missingConfigGate = harness.buildClassicRetirementGate({
    ...proof,
    launchConfig: null,
  }, audit);
  assert.equal(missingConfigGate.state, 'danger');
  assert.equal(missingConfigGate.requirements.find((item) => item.id === 'live-proof').pass, false);
  assert.match(missingConfigGate.requirements.find((item) => item.id === 'live-proof').detail, /frozen launch-config snapshot/);

  const incompleteConfigGate = harness.buildClassicRetirementGate({
    ...proof,
    launchConfig: { token: {}, poolTopology: {} },
  }, audit);
  assert.equal(incompleteConfigGate.state, 'danger');
  assert.equal(incompleteConfigGate.requirements.find((item) => item.id === 'live-proof').pass, false);
  assert.match(incompleteConfigGate.requirements.find((item) => item.id === 'live-proof').detail, /incomplete frozen launch-config snapshot/);
  assert.match(incompleteConfigGate.requirements.find((item) => item.id === 'live-proof').detail, /v2 snapshot marker/);
  assert.match(incompleteConfigGate.requirements.find((item) => item.id === 'live-proof').detail, /token identity/);
  assert.match(incompleteConfigGate.requirements.find((item) => item.id === 'live-proof').detail, /planned pools/);

  const unmarkedConfigGate = harness.buildClassicRetirementGate({
    ...proof,
    launchConfig: {
      token: { name: 'Gate', symbol: 'GATE', supply: '1000', decimals: 9 },
      poolTopology: {
        sweepDestination: 'DestGate111111111111111111111111111111111',
        pools: [{ quoteToken: 'SOL', supplyPercent: 100, ammConfigIndex: 8 }],
      },
    },
  }, audit);
  assert.equal(unmarkedConfigGate.state, 'danger');
  assert.equal(unmarkedConfigGate.requirements.find((item) => item.id === 'live-proof').pass, false);
  assert.match(unmarkedConfigGate.requirements.find((item) => item.id === 'live-proof').detail, /v2 snapshot marker/);

  const mismatchedConfigGate = harness.buildClassicRetirementGate({
    ...proof,
    token: {
      ...proof.token,
      name: 'Actual Gate',
      symbol: 'AGT',
      totalSupply: '1000',
      decimals: 9,
    },
    poolPlan: {
      allocations: [{ quoteToken: 'SOL', supplyPercent: 90, ammConfigIndex: 8 }],
    },
    launchConfig: {
      schema: 'trebuchet-v2-launch-config',
      source: 'trebuchet-v2',
      token: { name: 'Stale Gate', symbol: 'OLD', supply: '42', decimals: 6 },
      poolTopology: {
        sweepDestination: 'DestGate111111111111111111111111111111111',
        pools: [{ quoteToken: 'USDC', supplyPercent: 10, ammConfigIndex: 5 }],
      },
    },
  }, audit);
  assert.equal(mismatchedConfigGate.state, 'danger');
  assert.equal(mismatchedConfigGate.requirements.find((item) => item.id === 'live-proof').pass, false);
  assert.match(mismatchedConfigGate.requirements.find((item) => item.id === 'live-proof').detail, /mismatched frozen launch-config snapshot/);
  assert.match(mismatchedConfigGate.requirements.find((item) => item.id === 'live-proof').detail, /token name/);
  assert.match(mismatchedConfigGate.requirements.find((item) => item.id === 'live-proof').detail, /planned pool 1/);

  const localDossierGate = harness.buildClassicRetirementGate({
    ...proof,
    reportPublish: null,
    localDossier: {
      status: 'downloaded',
      kind: 'local-dossier-html',
      filename: 'trebuchet-proof.html',
      mint: proof.token.mint,
      downloadedAt: '2026-06-30T00:00:00.000Z',
      dataVersion: 13,
      proofFingerprint: 'proof-bound',
      sweepEvidenceHash: harness.comparisonTransferEvidenceHash(proof.transfer),
    },
  }, audit);
  assert.equal(localDossierGate.state, 'pass');
  assert.equal(localDossierGate.requirements.find((item) => item.id === 'report-proof').pass, true);

  const preFinalSweepReportGate = harness.buildClassicRetirementGate({
    ...proof,
    transfer: null,
    reportPublish: { htmlUri: 'ar://pre-final-sweep-report', proofFingerprint: 'proof-bound' },
  }, audit);
  assert.equal(preFinalSweepReportGate.state, 'danger');
  assert.equal(preFinalSweepReportGate.requirements.find((item) => item.id === 'report-proof').pass, false);
  assert.match(preFinalSweepReportGate.requirements.find((item) => item.id === 'report-proof').detail, /terminal sweep evidence hash/);
  assert.equal(preFinalSweepReportGate.requirements.find((item) => item.id === 'replacement-criteria').pass, false);
  assert.match(preFinalSweepReportGate.replacementCriteria.find((item) => item.id === 'sweep-report-proof').evidence, /terminal final-sweep evidence is still required/);

  const preSweepReportGate = harness.buildClassicRetirementGate({
    ...proof,
    reportPublish: { htmlUri: 'ar://pre-sweep-report', proofFingerprint: 'proof-bound' },
  }, audit);
  assert.equal(preSweepReportGate.state, 'danger');
  assert.equal(preSweepReportGate.requirements.find((item) => item.id === 'report-proof').pass, false);
  assert.match(preSweepReportGate.requirements.find((item) => item.id === 'report-proof').detail, /terminal sweep evidence hash/);
  assert.equal(preSweepReportGate.requirements.find((item) => item.id === 'replacement-criteria').pass, false);
  assert.match(preSweepReportGate.replacementCriteria.find((item) => item.id === 'sweep-report-proof').evidence, /missing the terminal sweep evidence hash/);

  const preSweepDossierGate = harness.buildClassicRetirementGate({
    ...proof,
    reportPublish: null,
    localDossier: {
      status: 'downloaded',
      kind: 'local-dossier-html',
      filename: 'trebuchet-pre-sweep-proof.html',
      mint: proof.token.mint,
      downloadedAt: '2026-06-30T00:00:00.000Z',
      dataVersion: 13,
      proofFingerprint: 'proof-bound',
    },
  }, audit);
  assert.equal(preSweepDossierGate.state, 'danger');
  assert.equal(preSweepDossierGate.requirements.find((item) => item.id === 'report-proof').pass, false);
  assert.match(preSweepDossierGate.requirements.find((item) => item.id === 'report-proof').detail, /terminal sweep evidence hash/);

  const missingJournalGate = harness.buildClassicRetirementGate({
    ...proof,
    journalId: null,
  }, audit);
  assert.equal(missingJournalGate.state, 'danger');
  assert.equal(missingJournalGate.requirements.find((item) => item.id === 'live-proof').pass, false);
  assert.match(missingJournalGate.requirements.find((item) => item.id === 'live-proof').detail, /missing its launch journal id/);
  assert.equal(missingJournalGate.requirements.find((item) => item.id === 'replacement-criteria').pass, false);
  const missingJournalCriterion = missingJournalGate.replacementCriteria.find((item) => item.id === 'run-and-resume');
  assert.equal(missingJournalCriterion.pass, false);
  assert.match(missingJournalCriterion.evidence, /missing its launch journal id/);

  const nonTerminalJournalGate = harness.buildClassicRetirementGate({
    ...proof,
    status: 'active',
    stage: 'transfer_partial',
  }, audit);
  assert.equal(nonTerminalJournalGate.state, 'danger');
  assert.equal(nonTerminalJournalGate.requirements.find((item) => item.id === 'live-proof').pass, false);
  assert.match(nonTerminalJournalGate.requirements.find((item) => item.id === 'live-proof').detail, /not terminal/);
  assert.equal(nonTerminalJournalGate.requirements.find((item) => item.id === 'replacement-criteria').pass, false);
  assert.match(nonTerminalJournalGate.replacementCriteria.find((item) => item.id === 'run-and-resume').evidence, /has not reached transfer_completed/);

  const missingWalletGate = harness.buildClassicRetirementGate({
    ...proof,
    walletPublicKey: null,
  }, audit);
  assert.equal(missingWalletGate.state, 'danger');
  assert.equal(missingWalletGate.requirements.find((item) => item.id === 'live-proof').pass, false);
  assert.match(missingWalletGate.requirements.find((item) => item.id === 'live-proof').detail, /missing its launch wallet/);
  assert.equal(missingWalletGate.requirements.find((item) => item.id === 'replacement-criteria').pass, false);

  const missingAuthorityGate = harness.buildClassicRetirementGate({
    ...proof,
    token: {
      ...proof.token,
      metadataImmutable: false,
    },
  }, audit);
  assert.equal(missingAuthorityGate.state, 'danger');
  assert.equal(missingAuthorityGate.requirements.find((item) => item.id === 'live-proof').pass, false);
  assert.match(missingAuthorityGate.requirements.find((item) => item.id === 'live-proof').detail, /Token authority proof is 3\/4/);

  const stalePassAuditGate = harness.buildClassicRetirementGate({
    ...proof,
    token: {
      ...proof.token,
      metadataImmutable: false,
    },
  }, {
    status: 'pass',
    passCount: 12,
    itemCount: 12,
    missingCount: 0,
    warnCount: 0,
    proofFingerprint: 'proof-bound',
  });
  assert.equal(stalePassAuditGate.state, 'danger');
  assert.equal(stalePassAuditGate.requirements.find((item) => item.id === 'audit').pass, false);
  assert.match(stalePassAuditGate.requirements.find((item) => item.id === 'audit').detail, /Proof audit is warn/);

  harness.state.classicReportComparison = {
    result: {
      ...classicComparison,
      proofFingerprint: null,
    },
  };
  const unboundComparisonGate = harness.buildClassicRetirementGate(proof, audit);
  assert.equal(unboundComparisonGate.state, 'danger');
  assert.equal(unboundComparisonGate.requirements.find((item) => item.id === 'classic-comparison').pass, false);
  assert.match(unboundComparisonGate.requirements.find((item) => item.id === 'classic-comparison').detail, /belongs to another v2 proof/);

  const proofComparisonFallbackGate = harness.buildClassicRetirementGate({
    ...proof,
    reportParity: {
      ...(proof.reportParity || {}),
      comparison: classicComparison,
    },
  }, audit);
  assert.equal(proofComparisonFallbackGate.requirements.find((item) => item.id === 'classic-comparison').pass, true);
  assert.match(
    proofComparisonFallbackGate.requirements.find((item) => item.id === 'classic-comparison').detail,
    /Classic artifact comparison passed/,
  );
  assert.match(js, /function currentClassicComparisonForProof/);
  assert.match(js, /if \(normalizedComparison && classicComparisonMatchesProof\(normalizedComparison, proof, config\)\)/);
  assert.match(js, /if \(proofComparison && classicComparisonMatchesProof\(proofComparison, proof, config\)\)/);
  assert.match(js, /const classicComparison = currentClassicComparisonForProof\(proof, config\)/);
  assert.match(js, /const comparison = currentClassicComparisonForProof\(proof, config\)/);
  harness.state.classicReportComparison = { result: classicComparison };

  harness.state.classicReportComparison = {
    result: {
      ...classicComparison,
      passCount: 1,
      fieldCount: 1,
      rows: [{ id: 'mint', label: 'Token mint', state: 'pass' }],
    },
  };
  const thinComparisonGate = harness.buildClassicRetirementGate(proof, audit);
  assert.equal(thinComparisonGate.state, 'danger');
  assert.equal(thinComparisonGate.requirements.find((item) => item.id === 'classic-comparison').pass, false);
  assert.match(thinComparisonGate.requirements.find((item) => item.id === 'classic-comparison').detail, /missing required passing rows/);
  assert.equal(thinComparisonGate.requirements.find((item) => item.id === 'replacement-criteria').pass, false);
  assert.match(thinComparisonGate.replacementCriteria.find((item) => item.id === 'classic-artifact-comparison').evidence, /missing required passing rows/);
  harness.state.classicReportComparison = { result: classicComparison };

  harness.state.viewportSmoke = null;
  const missingSmokeGate = harness.buildClassicRetirementGate({ ...proof, reportParity: {} }, audit);
  assert.equal(missingSmokeGate.state, 'danger');
  assert.equal(missingSmokeGate.requirements.find((item) => item.id === 'replacement-criteria').pass, false);
  assert.match(missingSmokeGate.requirements.find((item) => item.id === 'replacement-criteria').detail, /Charts and viewport smoke/);
  harness.state.viewportSmoke = validViewportSmoke;

  harness.state.managedWallets = [{ publicKey: proof.walletPublicKey, hasSecretKey: false }];
  harness.state.selectedWalletPublicKey = proof.walletPublicKey;
  let walletCriterion = harness.buildV2ReplacementCriteriaAudit({
    proof: null,
    audit,
    hasCompletedLiveProof: false,
    demoRunComplete: false,
  }).find((item) => item.id === 'wallet-lifecycle');
  assert.equal(walletCriterion.pass, false);
  assert.match(walletCriterion.evidence, /missing a usable signing secret/);

  harness.state.managedWallets = [{ publicKey: proof.walletPublicKey, hasSecretKey: true, secretPinLocked: true }];
  walletCriterion = harness.buildV2ReplacementCriteriaAudit({
    proof: null,
    audit,
    hasCompletedLiveProof: false,
    demoRunComplete: false,
  }).find((item) => item.id === 'wallet-lifecycle');
  assert.equal(walletCriterion.pass, false);
  assert.match(walletCriterion.evidence, /PIN locked/);

  harness.state.managedWallets = [{ publicKey: proof.walletPublicKey, hasSecretKey: true }];
  walletCriterion = harness.buildV2ReplacementCriteriaAudit({
    proof: null,
    audit,
    hasCompletedLiveProof: false,
    demoRunComplete: false,
  }).find((item) => item.id === 'wallet-lifecycle');
  assert.equal(walletCriterion.pass, true);
  assert.match(walletCriterion.evidence, /available local signing secret/);

  harness.state.apiStatus = 'static';
  walletCriterion = harness.buildV2ReplacementCriteriaAudit({
    proof: null,
    audit,
    hasCompletedLiveProof: false,
    demoRunComplete: false,
  }).find((item) => item.id === 'wallet-lifecycle');
  assert.equal(walletCriterion.pass, false);
  assert.match(walletCriterion.evidence, /Connect the local app to verify this managed wallet signing secret/);

  harness.state.managedWallets = [];
  harness.state.selectedWalletPublicKey = '';
  walletCriterion = harness.buildV2ReplacementCriteriaAudit({
    proof: { walletPublicKey: proof.walletPublicKey, source: 'demo-run' },
    audit,
    hasCompletedLiveProof: false,
    demoRunComplete: true,
  }).find((item) => item.id === 'wallet-lifecycle');
  assert.equal(walletCriterion.pass, false);
  assert.match(walletCriterion.evidence, /Generate, import, or load a Trebuchet-managed wallet/);

  walletCriterion = harness.buildV2ReplacementCriteriaAudit({
    proof: { walletPublicKey: proof.walletPublicKey },
    audit,
    hasCompletedLiveProof: true,
    demoRunComplete: false,
  }).find((item) => item.id === 'wallet-lifecycle');
  assert.equal(walletCriterion.pass, true);
  assert.match(walletCriterion.evidence, /attached to completed proof/);

  harness.state.apiStatus = 'static';

  harness.state.vanityAvailable = false;
  harness.state.vanityCandidates = [{ publicKey: 'StaticVanity1111111111111111111111111111111', persisted: false, hasSecretKey: true }];
  harness.state.selectedVanityPublicKey = 'StaticVanity1111111111111111111111111111111';
  let vanityCriterion = harness.buildV2ReplacementCriteriaAudit({
    proof: null,
    audit,
    hasCompletedLiveProof: false,
    demoRunComplete: false,
  }).find((item) => item.id === 'vanity-options');
  assert.equal(vanityCriterion.pass, false);
  assert.match(vanityCriterion.evidence, /preview-only or missing its saved secret/);

  harness.state.vanityCandidates = [{ publicKey: 'StaticPersistedVanity1111111111111111111111111', persisted: true, hasSecretKey: true }];
  harness.state.selectedVanityPublicKey = 'StaticPersistedVanity1111111111111111111111111';
  vanityCriterion = harness.buildV2ReplacementCriteriaAudit({
    proof: null,
    audit,
    hasCompletedLiveProof: false,
    demoRunComplete: false,
  }).find((item) => item.id === 'vanity-options');
  assert.equal(vanityCriterion.pass, false);
  assert.match(vanityCriterion.evidence, /preview-only or missing its saved secret/);

  harness.state.vanityCandidates = [];
  harness.state.selectedVanityPublicKey = '';
  vanityCriterion = harness.buildV2ReplacementCriteriaAudit({
    proof: null,
    audit,
    hasCompletedLiveProof: false,
    demoRunComplete: false,
  }).find((item) => item.id === 'vanity-options');
  assert.equal(vanityCriterion.pass, false);
  assert.match(vanityCriterion.evidence, /Connect the local app/);

  harness.state.apiStatus = 'connected';
  harness.state.vanityCandidates = [{ publicKey: 'PersistedVanity111111111111111111111111111', persisted: true, hasSecretKey: true }];
  harness.state.selectedVanityPublicKey = 'PersistedVanity111111111111111111111111111';
  vanityCriterion = harness.buildV2ReplacementCriteriaAudit({
    proof: null,
    audit,
    hasCompletedLiveProof: false,
    demoRunComplete: false,
  }).find((item) => item.id === 'vanity-options');
  assert.equal(vanityCriterion.pass, true);
  assert.match(vanityCriterion.evidence, /Selected persisted Vanity CA/);

  harness.state.vanityCandidates = [];
  harness.state.selectedVanityPublicKey = '';
  harness.state.vanityAvailable = true;
  vanityCriterion = harness.buildV2ReplacementCriteriaAudit({
    proof: null,
    audit,
    hasCompletedLiveProof: false,
    demoRunComplete: false,
  }).find((item) => item.id === 'vanity-options');
  assert.equal(vanityCriterion.pass, true);
  assert.match(vanityCriterion.evidence, /Native grinder is available/);

  harness.state.managedWallets = [{ publicKey: proof.walletPublicKey, hasSecretKey: true }];
  harness.state.selectedWalletPublicKey = proof.walletPublicKey;

  const tokenReadyConfig = {
    token: {
      name: 'Token Parity',
      symbol: 'TPAR',
      supply: '1000',
      description: 'Classic-compatible token metadata.',
      logo: { type: 'image/png', sizeBytes: 2048, width: 128, height: 128 },
    },
    poolTopology: {
      totalPoolPercent: 100,
      pools: [{ id: 'sol-pool', quoteToken: 'SOL', supplyPercent: 100, plannedPositionCount: 1 }],
      airdrop: { enabled: false, supplyPercent: 0 },
    },
  };
  const completePlanOperations = [
    'v2-wallet-and-ca',
    'v2-funding-check',
    'v2-mint-metadata',
    'v2-revoke-authorities',
    'v2-create-liquidity-pools',
    'v2-lock-liquidity',
    'v2-report-sweep',
  ].map((id) => ({
    id,
    kind: 'local-wallet-operation',
    source: 'v2-launch-plan',
    signer: 'trebuchet-managed-launch-wallet',
    simulation: { decoded: true },
  }));
  harness.state.tokenLogoError = null;
  harness.state.currentConfig = {
    ...tokenReadyConfig,
    token: { ...tokenReadyConfig.token, symbol: 'TOO_LONG_SYMBOL' },
  };
  let tokenCriterion = harness.buildV2ReplacementCriteriaAudit({
    proof: null,
    audit,
    hasCompletedLiveProof: false,
    demoRunComplete: false,
  }).find((item) => item.id === 'token-config-parity');
  assert.equal(tokenCriterion.pass, false);
  assert.match(tokenCriterion.evidence, /Token symbol must be 10 UTF-8 bytes or fewer/);

  harness.state.currentConfig = tokenReadyConfig;
  harness.state.launchPlan = null;
  tokenCriterion = harness.buildV2ReplacementCriteriaAudit({
    proof: null,
    audit,
    hasCompletedLiveProof: false,
    demoRunComplete: false,
  }).find((item) => item.id === 'token-config-parity');
  assert.equal(tokenCriterion.pass, false);
  assert.match(tokenCriterion.evidence, /stage the launch plan through the local API/);

  harness.state.launchPlan = {
    source: 'local-api',
    v2LaunchConfigFingerprint: harness.launchPlanConfigFingerprint(tokenReadyConfig),
    v2LaunchWalletFingerprint: proof.walletPublicKey,
    operations: [{
      id: 'v2-mint-metadata',
      kind: 'local-wallet-operation',
      source: 'v2-launch-plan',
      signer: 'trebuchet-managed-launch-wallet',
      simulation: { decoded: true },
    }],
  };
  tokenCriterion = harness.buildV2ReplacementCriteriaAudit({
    proof: null,
    audit,
    hasCompletedLiveProof: false,
    demoRunComplete: false,
  }).find((item) => item.id === 'token-config-parity');
  assert.equal(tokenCriterion.pass, false);
  assert.match(tokenCriterion.evidence, /missing required operation v2-wallet-and-ca/);

  harness.state.launchPlan = {
    source: 'local-api',
    v2LaunchConfigFingerprint: harness.launchPlanConfigFingerprint(tokenReadyConfig),
    v2LaunchWalletFingerprint: proof.walletPublicKey,
    operations: completePlanOperations,
  };
  tokenCriterion = harness.buildV2ReplacementCriteriaAudit({
    proof: null,
    audit,
    hasCompletedLiveProof: false,
    demoRunComplete: false,
  }).find((item) => item.id === 'token-config-parity');
  assert.equal(tokenCriterion.pass, true);
  assert.match(tokenCriterion.evidence, /Token Token Parity \/ TPAR \/ 1000 is staged/);
  assert.match(tokenCriterion.evidence, /validated logo handoff/);
  harness.state.currentConfig = {
    ...tokenReadyConfig,
    token: { ...tokenReadyConfig.token, symbol: 'TOO_LONG_SYMBOL' },
  };
  const explicitConfigGate = harness.buildClassicRetirementGate({}, audit, tokenReadyConfig);
  const explicitTokenCriterion = explicitConfigGate.replacementCriteria.find((item) => item.id === 'token-config-parity');
  assert.equal(explicitTokenCriterion.pass, true);
  assert.match(explicitTokenCriterion.evidence, /Token Token Parity \/ TPAR \/ 1000 is staged/);
  assert.match(js, /function buildClassicRetirementGate\(proof = currentLaunchProof\(\), audit = null, config = currentLaunchConfig\(\)\)/);
  assert.match(js, /config = proofConfigForFingerprint\(proof, config\)/);
  harness.state.launchPlan = null;
  harness.state.currentConfig = null;

  harness.state.viewportSmoke = null;
  let chartCriterion = harness.buildV2ReplacementCriteriaAudit({
    proof: { ...proof, reportParity: null },
    audit,
    hasCompletedLiveProof: true,
    demoRunComplete: false,
  }).find((item) => item.id === 'charts-and-viewport');
  assert.equal(chartCriterion.pass, false);
  assert.match(chartCriterion.evidence, /generate desktop\/mobile viewport-smoke proof/);

  chartCriterion = harness.buildV2ReplacementCriteriaAudit({
    proof: { ...proof, reportParity: { viewportSmoke: { passed: true } } },
    audit,
    hasCompletedLiveProof: true,
    demoRunComplete: false,
  }).find((item) => item.id === 'charts-and-viewport');
  assert.equal(chartCriterion.pass, false);
  assert.match(chartCriterion.evidence, /generate desktop\/mobile viewport-smoke proof/);

  const viewportChecks = {
    launchVisible: true,
    horizontalOverflow: true,
    tokenomicsChart: true,
    liquidityChart: true,
    fundingMeter: true,
    parityPanel: true,
    firstViewportFit: true,
  };
  harness.state.viewportSmoke = {
    artifactVersion: 1,
    kind: 'trebuchet-v2-viewport-smoke',
    passed: true,
    state: 'valid',
    generatedAt: '2026-06-30T00:00:00.000Z',
    viewports: [
      { name: 'desktop', passed: true, checks: viewportChecks },
      { name: 'mobile', passed: true, checks: viewportChecks },
    ],
    assetHashes: {
      'index.html': 'a'.repeat(64),
      'styles.css': 'b'.repeat(64),
      'api-client.js': 'c'.repeat(64),
      'app.js': 'd'.repeat(64),
    },
  };
  harness.state.apiStatus = 'static';
  chartCriterion = harness.buildV2ReplacementCriteriaAudit({
    proof: { ...proof, reportParity: { viewportSmoke: { passed: true } } },
    audit,
    hasCompletedLiveProof: true,
    demoRunComplete: false,
  }).find((item) => item.id === 'charts-and-viewport');
  assert.equal(chartCriterion.pass, false);
  assert.match(chartCriterion.evidence, /Connect the local app to verify viewport smoke proof/);

  harness.state.apiStatus = 'connected';
  chartCriterion = harness.buildV2ReplacementCriteriaAudit({
    proof: { ...proof, reportParity: { viewportSmoke: { passed: true } } },
    audit,
    hasCompletedLiveProof: true,
    demoRunComplete: false,
  }).find((item) => item.id === 'charts-and-viewport');
  assert.equal(chartCriterion.pass, true);
  assert.match(chartCriterion.evidence, /Viewport smoke passed/);

  harness.state.viewportSmoke = {
    ...harness.state.viewportSmoke,
    viewports: [
      { name: 'desktop', passed: true, checks: replacementViewportChecks },
      { name: 'mobile', passed: true, checks: { ...replacementViewportChecks, fundingMeter: false } },
    ],
  };
  chartCriterion = harness.buildV2ReplacementCriteriaAudit({
    proof: { ...proof, reportParity: { viewportSmoke: { passed: true } } },
    audit,
    hasCompletedLiveProof: true,
    demoRunComplete: false,
  }).find((item) => item.id === 'charts-and-viewport');
  assert.equal(chartCriterion.pass, false);
  assert.match(js, /V2_VIEWPORT_SMOKE_REQUIRED_CHECKS\.every\(\(check\) => checks\[check\] === true\)/);
  harness.state.viewportSmoke.viewports[1].checks.fundingMeter = true;

  chartCriterion = harness.buildV2ReplacementCriteriaAudit({
    proof: null,
    audit,
    hasCompletedLiveProof: false,
    demoRunComplete: false,
  }).find((item) => item.id === 'charts-and-viewport');
  assert.equal(chartCriterion.pass, false);
  assert.match(chartCriterion.evidence, /stage the launch plan through the local API/);

  harness.state.currentConfig = tokenReadyConfig;
  harness.state.launchPlan = {
    source: 'local-api',
    v2LaunchConfigFingerprint: harness.launchPlanConfigFingerprint(tokenReadyConfig),
    v2LaunchWalletFingerprint: 'OtherWallet111111111111111111111111111111',
    operations: completePlanOperations,
  };
  tokenCriterion = harness.buildV2ReplacementCriteriaAudit({
    proof: null,
    audit,
    hasCompletedLiveProof: false,
    demoRunComplete: false,
  }).find((item) => item.id === 'token-config-parity');
  assert.equal(tokenCriterion.pass, false);
  assert.match(tokenCriterion.evidence, /stale for the selected launch wallet/);

  harness.state.launchPlan = {
    source: 'local-api',
    v2LaunchConfigFingerprint: harness.launchPlanConfigFingerprint(tokenReadyConfig),
    v2LaunchWalletFingerprint: proof.walletPublicKey,
    operations: completePlanOperations,
  };
  chartCriterion = harness.buildV2ReplacementCriteriaAudit({
    proof: null,
    audit,
    hasCompletedLiveProof: false,
    demoRunComplete: false,
  }).find((item) => item.id === 'charts-and-viewport');
  assert.equal(chartCriterion.pass, true);
  assert.match(chartCriterion.evidence, /executable launch model/);
  harness.state.launchPlan = null;
  harness.state.currentConfig = null;

  harness.state.viewportSmoke = {
    ...harness.state.viewportSmoke,
    viewports: [{ name: 'desktop', passed: true }],
  };
  chartCriterion = harness.buildV2ReplacementCriteriaAudit({
    proof: { ...proof, reportParity: { viewportSmoke: { passed: true } } },
    audit,
    hasCompletedLiveProof: true,
    demoRunComplete: false,
  }).find((item) => item.id === 'charts-and-viewport');
  assert.equal(chartCriterion.pass, false);
  assert.match(chartCriterion.evidence, /generate desktop\/mobile viewport-smoke proof/);
  harness.state.viewportSmoke = null;

  const blockedPoolCriterion = harness.buildV2ReplacementCriteriaAudit({
    proof: null,
    audit,
    hasCompletedLiveProof: false,
    demoRunComplete: false,
  }).find((item) => item.id === 'pool-config-parity');
  assert.equal(blockedPoolCriterion.pass, false);
  assert.match(blockedPoolCriterion.evidence, /No planned pool rows/);

  harness.state.currentConfig = {
    poolTopology: {
      totalPoolPercent: 100,
      pools: [{ id: 'sol-pool', quoteToken: 'SOL', supplyPercent: 100, plannedPositionCount: 1 }],
      airdrop: { enabled: false, supplyPercent: 0 },
    },
  };
  harness.state.launchPlan = null;
  let stagedPoolCriterion = harness.buildV2ReplacementCriteriaAudit({
    proof: null,
    audit,
    hasCompletedLiveProof: false,
    demoRunComplete: false,
  }).find((item) => item.id === 'pool-config-parity');
  assert.equal(stagedPoolCriterion.pass, false);
  assert.match(stagedPoolCriterion.evidence, /Stage the launch plan through the local API/);

  harness.state.launchPlan = { source: 'local-api' };
  stagedPoolCriterion = harness.buildV2ReplacementCriteriaAudit({
    proof: null,
    audit,
    hasCompletedLiveProof: false,
    demoRunComplete: false,
  }).find((item) => item.id === 'pool-config-parity');
  assert.equal(stagedPoolCriterion.pass, false);
  assert.match(stagedPoolCriterion.evidence, /stale for the current token\/pool model or selected launch wallet/);

  harness.state.launchPlan = {
    source: 'local-api',
    operations: completePlanOperations,
  };
  stagedPoolCriterion = harness.buildV2ReplacementCriteriaAudit({
    proof: null,
    audit,
    hasCompletedLiveProof: false,
    demoRunComplete: false,
  }).find((item) => item.id === 'pool-config-parity');
  assert.equal(stagedPoolCriterion.pass, false);
  assert.match(stagedPoolCriterion.evidence, /stale for the current token\/pool model or selected launch wallet/);

  harness.state.launchPlan = {
    source: 'local-api',
    v2LaunchConfigFingerprint: harness.launchPlanConfigFingerprint(harness.state.currentConfig),
    walletPublicKey: proof.walletPublicKey,
    operations: completePlanOperations,
  };
  stagedPoolCriterion = harness.buildV2ReplacementCriteriaAudit({
    proof: null,
    audit,
    hasCompletedLiveProof: false,
    demoRunComplete: false,
  }).find((item) => item.id === 'pool-config-parity');
  assert.equal(stagedPoolCriterion.pass, false);
  assert.match(stagedPoolCriterion.evidence, /stale for the selected launch wallet/);

  harness.state.launchPlan = {
    source: 'local-api',
    v2LaunchConfigFingerprint: harness.launchPlanConfigFingerprint(harness.state.currentConfig),
    v2LaunchWalletFingerprint: proof.walletPublicKey,
  };
  stagedPoolCriterion = harness.buildV2ReplacementCriteriaAudit({
    proof: null,
    audit,
    hasCompletedLiveProof: false,
    demoRunComplete: false,
  }).find((item) => item.id === 'pool-config-parity');
  assert.equal(stagedPoolCriterion.pass, false);
  assert.match(stagedPoolCriterion.evidence, /local-wallet operation rows are not fully decoded/);

  harness.state.launchPlan = {
    source: 'local-api',
    v2LaunchConfigFingerprint: harness.launchPlanConfigFingerprint(harness.state.currentConfig),
    v2LaunchWalletFingerprint: proof.walletPublicKey,
    operations: [{
      id: 'v2-create-liquidity-pools',
      kind: 'local-wallet-operation',
      source: 'v2-launch-plan',
      signer: 'trebuchet-managed-launch-wallet',
      simulation: { decoded: true },
    }],
  };
  stagedPoolCriterion = harness.buildV2ReplacementCriteriaAudit({
    proof: null,
    audit,
    hasCompletedLiveProof: false,
    demoRunComplete: false,
  }).find((item) => item.id === 'pool-config-parity');
  assert.equal(stagedPoolCriterion.pass, false);
  assert.match(stagedPoolCriterion.evidence, /missing required operation v2-wallet-and-ca/);

  harness.state.launchPlan = {
    source: 'local-api',
    v2LaunchConfigFingerprint: harness.launchPlanConfigFingerprint(harness.state.currentConfig),
    v2LaunchWalletFingerprint: proof.walletPublicKey,
    operations: completePlanOperations,
  };
  stagedPoolCriterion = harness.buildV2ReplacementCriteriaAudit({
    proof: null,
    audit,
    hasCompletedLiveProof: false,
    demoRunComplete: false,
  }).find((item) => item.id === 'pool-config-parity');
  assert.equal(stagedPoolCriterion.pass, true);
  assert.match(stagedPoolCriterion.evidence, /planned pool/);
  harness.state.launchPlan = null;
  harness.state.currentConfig = null;

  const poolCriterion = harness.buildV2ReplacementCriteriaAudit({
    proof,
    audit,
    hasCompletedLiveProof: true,
    demoRunComplete: false,
  }).find((item) => item.id === 'pool-config-parity');
  assert.equal(poolCriterion.pass, true);
  assert.match(poolCriterion.evidence, /planned pool/);

  harness.state.currentConfig = {
    poolTopology: {
      totalPoolPercent: 100,
      pools: [{ id: 'bad-pool', quoteToken: 'SOL', supplyPercent: 100, plannedPositionCount: 1 }],
      airdrop: { enabled: false, supplyPercent: 0 },
      blockers: [{ state: 'danger', title: 'Duplicate route' }],
    },
  };
  const poolBlockerCriterion = harness.buildV2ReplacementCriteriaAudit({
    proof: null,
    audit,
    hasCompletedLiveProof: false,
    demoRunComplete: false,
  }).find((item) => item.id === 'pool-config-parity');
  assert.equal(poolBlockerCriterion.pass, false);
  assert.match(poolBlockerCriterion.evidence, /1 blocking pool\/topology issue/);

  harness.state.currentConfig = {
    poolTopology: {
      totalPoolPercent: 80,
      pools: [{ id: 'sol-pool', quoteToken: 'SOL', supplyPercent: 80, plannedPositionCount: 1 }],
      airdrop: { enabled: true, supplyPercent: 30 },
    },
  };
  const overallocatedPoolCriterion = harness.buildV2ReplacementCriteriaAudit({
    proof: null,
    audit,
    hasCompletedLiveProof: false,
    demoRunComplete: false,
  }).find((item) => item.id === 'pool-config-parity');
  assert.equal(overallocatedPoolCriterion.pass, false);
  assert.match(overallocatedPoolCriterion.evidence, /1 blocking pool\/topology issue/);

  harness.state.currentConfig = {
    poolTopology: {
      totalPoolPercent: 80,
      pools: [
        { id: 'sol-pool', quoteToken: 'SOL', supplyPercent: 60, plannedPositionCount: 1 },
        { id: 'usdc-pool', quoteToken: 'USDC', supplyPercent: 30, plannedPositionCount: 1 },
      ],
      airdrop: { enabled: false, supplyPercent: 0 },
    },
  };
  const mismatchedAllocationCriterion = harness.buildV2ReplacementCriteriaAudit({
    proof: null,
    audit,
    hasCompletedLiveProof: false,
    demoRunComplete: false,
  }).find((item) => item.id === 'pool-config-parity');
  assert.equal(mismatchedAllocationCriterion.pass, false);
  assert.match(mismatchedAllocationCriterion.evidence, /1 blocking pool\/topology issue/);
  harness.state.currentConfig = null;

  harness.state.classicFundingEstimate = null;
  harness.state.fundingSnapshot = { missingSol: 0, hasWalletBalance: true, walletBalanceFresh: true };
  let fundingCriterion = harness.buildV2ReplacementCriteriaAudit({
    proof: null,
    audit,
    hasCompletedLiveProof: false,
    demoRunComplete: false,
  }).find((item) => item.id === 'funding-and-quote');
  assert.equal(fundingCriterion.pass, false);
  assert.match(fundingCriterion.evidence, /Run the Classic funding estimate/);

  harness.state.classicFundingEstimate = { totalSol: 2 };
  harness.state.fundingSnapshot = { missingSol: 0, hasWalletBalance: true, walletBalanceFresh: true };
  fundingCriterion = harness.buildV2ReplacementCriteriaAudit({
    proof: null,
    audit,
    hasCompletedLiveProof: false,
    demoRunComplete: false,
  }).find((item) => item.id === 'funding-and-quote');
  assert.equal(fundingCriterion.pass, false);
  assert.match(fundingCriterion.evidence, /funding estimate is stale/i);

  harness.state.classicFundingEstimate = harness.stampClassicFundingEstimate(
    { totalSol: 2 },
    harness.state.currentConfig || { poolTopology: {} },
  );
  harness.state.fundingSnapshot = { missingSol: 0, hasWalletBalance: false, walletBalanceFresh: false };
  fundingCriterion = harness.buildV2ReplacementCriteriaAudit({
    proof: null,
    audit,
    hasCompletedLiveProof: false,
    demoRunComplete: false,
  }).find((item) => item.id === 'funding-and-quote');
  assert.equal(fundingCriterion.pass, false);
  assert.match(fundingCriterion.evidence, /Verify the selected Trebuchet launch-wallet balance/);

  harness.state.fundingSnapshot = {
    missingSol: 0,
    hasWalletBalance: true,
    walletBalanceFresh: false,
    walletBalanceStale: true,
  };
  fundingCriterion = harness.buildV2ReplacementCriteriaAudit({
    proof: null,
    audit,
    hasCompletedLiveProof: false,
    demoRunComplete: false,
  }).find((item) => item.id === 'funding-and-quote');
  assert.equal(fundingCriterion.pass, false);
  assert.match(fundingCriterion.evidence, /launch-wallet balance is stale/);

  harness.state.fundingSnapshot = { missingSol: 0.5, hasWalletBalance: true, walletBalanceFresh: true };
  fundingCriterion = harness.buildV2ReplacementCriteriaAudit({
    proof: null,
    audit,
    hasCompletedLiveProof: false,
    demoRunComplete: false,
  }).find((item) => item.id === 'funding-and-quote');
  assert.equal(fundingCriterion.pass, false);
  assert.match(fundingCriterion.evidence, /short 0\.500 SOL/);

  harness.state.fundingSnapshot = { missingSol: 0, hasWalletBalance: true, walletBalanceFresh: true };
  harness.state.quoteRoutes = [{ quoteMint: 'Quote111' }];
  harness.state.quoteProgress = { total: 1, completed: 0, failed: 0 };
  harness.state.quoteAcquire = { job: { status: 'running' } };
  harness.state.quoteAcquireStale = false;
  fundingCriterion = harness.buildV2ReplacementCriteriaAudit({
    proof: null,
    audit,
    hasCompletedLiveProof: false,
    demoRunComplete: false,
  }).find((item) => item.id === 'funding-and-quote');
  assert.equal(fundingCriterion.pass, false);
  assert.match(fundingCriterion.evidence, /quote acquire route/);

  harness.state.quoteProgress = { total: 1, completed: 1, failed: 0 };
  harness.state.quoteAcquire = { job: { status: 'done' } };
  harness.state.quoteAcquireStale = true;
  fundingCriterion = harness.buildV2ReplacementCriteriaAudit({
    proof: null,
    audit,
    hasCompletedLiveProof: false,
    demoRunComplete: false,
  }).find((item) => item.id === 'funding-and-quote');
  assert.equal(fundingCriterion.pass, false);
  assert.match(fundingCriterion.evidence, /Quote acquire job is stale/);

  harness.state.quoteRoutes = [];
  harness.state.quoteProgress = { total: 0, completed: 0, failed: 0 };
  harness.state.quoteAcquire = { job: null };
  harness.state.quoteAcquireStale = false;
  harness.state.manualItems = [{ mint: 'Manual111' }];
  harness.state.manualSummary = { className: 'warn', label: '1 verify' };
  fundingCriterion = harness.buildV2ReplacementCriteriaAudit({
    proof: null,
    audit,
    hasCompletedLiveProof: false,
    demoRunComplete: false,
  }).find((item) => item.id === 'funding-and-quote');
  assert.equal(fundingCriterion.pass, false);
  assert.match(fundingCriterion.evidence, /Manual quote prefund is 1 verify/);

  harness.state.manualItems = [];
  harness.state.manualSummary = { className: '', label: 'None' };
  harness.state.currentConfig = {
    token: { supply: '999', decimals: 9 },
    poolTopology: {
      allocations: [],
      targetMarketCapUsd: 42,
      report: { publish: true },
      airdrop: { enabled: false, recipientCount: 0, supplyPercent: 0, executionCostSol: 0 },
    },
  };
  fundingCriterion = harness.buildV2ReplacementCriteriaAudit({
    proof: null,
    audit,
    hasCompletedLiveProof: false,
    demoRunComplete: false,
  }).find((item) => item.id === 'funding-and-quote');
  assert.equal(fundingCriterion.pass, false);
  assert.match(fundingCriterion.evidence, /funding estimate is stale/i);
  harness.state.currentConfig = null;
  harness.state.classicFundingEstimate = harness.stampClassicFundingEstimate(
    { totalSol: 2 },
    harness.state.currentConfig || { poolTopology: {} },
  );
  fundingCriterion = harness.buildV2ReplacementCriteriaAudit({
    proof: null,
    audit,
    hasCompletedLiveProof: false,
    demoRunComplete: false,
  }).find((item) => item.id === 'funding-and-quote');
  assert.equal(fundingCriterion.pass, true);
  assert.match(fundingCriterion.evidence, /wallet SOL, quote acquire, and manual prefund checks are ready/);

  harness.state.classicFundingEstimate = null;
  harness.state.fundingSnapshot = { missingSol: 0, hasWalletBalance: false, walletBalanceFresh: false };
  harness.state.quoteRoutes = [];
  harness.state.quoteProgress = { total: 0, completed: 0, failed: 0 };
  harness.state.quoteAcquire = { job: null };
  harness.state.manualItems = [];
  harness.state.manualSummary = { className: '', label: 'None' };
  harness.state.recovery = { journalCount: 0 };
  let resumeCriterion = harness.buildV2ReplacementCriteriaAudit({
    proof: null,
    audit,
    hasCompletedLiveProof: false,
    demoRunComplete: false,
  }).find((item) => item.id === 'run-and-resume');
  assert.equal(resumeCriterion.pass, false);
  assert.match(resumeCriterion.evidence, /no launch journal or proof/);

  harness.state.recovery = { journalCount: 1, journals: [{ id: 'done-journal', status: 'completed', stage: 'transfer_completed' }] };
  resumeCriterion = harness.buildV2ReplacementCriteriaAudit({
    proof: null,
    audit,
    hasCompletedLiveProof: false,
    demoRunComplete: false,
  }).find((item) => item.id === 'run-and-resume');
  assert.equal(resumeCriterion.pass, false);
  assert.match(resumeCriterion.evidence, /no active or failed journal/);

  harness.state.recovery = { journalCount: 1, journals: [{ id: 'failed-journal', status: 'failed', stage: 'main_positions_failed', token: { mint: 'Mint111' } }] };
  resumeCriterion = harness.buildV2ReplacementCriteriaAudit({
    proof: null,
    audit,
    hasCompletedLiveProof: false,
    demoRunComplete: false,
  }).find((item) => item.id === 'run-and-resume');
  assert.equal(resumeCriterion.pass, false);
  assert.match(resumeCriterion.evidence, /no active or failed journal/);

  harness.state.recovery = {
    journalCount: 1,
    journals: [{
      id: 'failed-journal',
      status: 'failed',
      stage: 'main_positions_failed',
      token: { mint: 'Mint111' },
      poolPlan: {
        tokenMint: 'Mint111',
        allocations: [{ quoteToken: 'SOL', supplyPercent: 100 }],
      },
    }],
  };
  resumeCriterion = harness.buildV2ReplacementCriteriaAudit({
    proof: null,
    audit,
    hasCompletedLiveProof: false,
    demoRunComplete: false,
  }).find((item) => item.id === 'run-and-resume');
  assert.equal(resumeCriterion.pass, true);
  assert.match(resumeCriterion.evidence, /1 active or failed launch journal with pool-plan or checkpoint evidence loaded/);

  harness.state.recovery = { journalCount: 0, journals: [] };
  resumeCriterion = harness.buildV2ReplacementCriteriaAudit({
    proof: { journalId: 'journal-proof-1' },
    audit,
    hasCompletedLiveProof: false,
    demoRunComplete: false,
  }).find((item) => item.id === 'run-and-resume');
  assert.equal(resumeCriterion.pass, false);
  assert.match(resumeCriterion.evidence, /matching local journal is not loaded/);

  harness.state.recovery = {
    journalCount: 1,
    journals: [{ id: 'journal-proof-1', status: 'failed', stage: 'main_positions_failed', token: { mint: 'Mint111' } }],
  };
  resumeCriterion = harness.buildV2ReplacementCriteriaAudit({
    proof: { journalId: 'journal-proof-1' },
    audit,
    hasCompletedLiveProof: false,
    demoRunComplete: false,
  }).find((item) => item.id === 'run-and-resume');
  assert.equal(resumeCriterion.pass, false);
  assert.match(resumeCriterion.evidence, /lacks pool-plan or checkpoint evidence/);

  harness.state.recovery = {
    journalCount: 1,
    journals: [{
      id: 'journal-proof-1',
      status: 'failed',
      stage: 'main_positions_failed',
      token: { mint: 'Mint111' },
      poolPlan: {
        tokenMint: 'Mint111',
        allocations: [{ quoteToken: 'SOL', supplyPercent: 100 }],
      },
    }],
  };
  resumeCriterion = harness.buildV2ReplacementCriteriaAudit({
    proof: { journalId: 'journal-proof-1' },
    audit,
    hasCompletedLiveProof: false,
    demoRunComplete: false,
  }).find((item) => item.id === 'run-and-resume');
  assert.equal(resumeCriterion.pass, true);
  assert.match(resumeCriterion.evidence, /loaded for the launch proof/);

  harness.state.recovery = {
    journalCount: 1,
    journals: [{ id: 'journal-proof-1', status: 'completed', stage: 'transfer_completed', token: { mint: 'Mint111' } }],
  };
  resumeCriterion = harness.buildV2ReplacementCriteriaAudit({
    proof: { journalId: 'journal-proof-1' },
    audit,
    hasCompletedLiveProof: false,
    demoRunComplete: false,
  }).find((item) => item.id === 'run-and-resume');
  assert.equal(resumeCriterion.pass, false);
  assert.match(resumeCriterion.evidence, /terminal final-sweep evidence/);

  harness.state.recovery = { journalCount: 0, journals: [] };
  harness.state.lastRecoveryResult = { journalId: 'loose-journal-id' };
  resumeCriterion = harness.buildV2ReplacementCriteriaAudit({
    proof: null,
    audit,
    hasCompletedLiveProof: false,
    demoRunComplete: false,
  }).find((item) => item.id === 'run-and-resume');
  assert.equal(resumeCriterion.pass, false);
  assert.match(resumeCriterion.evidence, /no launch journal or proof/);

  harness.state.lastRecoveryResult = { success: true, results: [{ poolId: 'PoolRecovered111111111111111111111111111' }] };
  resumeCriterion = harness.buildV2ReplacementCriteriaAudit({
    proof: null,
    audit,
    hasCompletedLiveProof: false,
    demoRunComplete: false,
  }).find((item) => item.id === 'run-and-resume');
  assert.equal(resumeCriterion.pass, false);
  assert.match(resumeCriterion.evidence, /no launch journal or proof/);

  harness.state.lastRecoveryResult = {
    success: true,
    results: [{ poolId: 'PoolRecovered111111111111111111111111111', phase1Complete: true }],
  };
  resumeCriterion = harness.buildV2ReplacementCriteriaAudit({
    proof: null,
    audit,
    hasCompletedLiveProof: false,
    demoRunComplete: false,
  }).find((item) => item.id === 'run-and-resume');
  assert.equal(resumeCriterion.pass, true);
  assert.match(resumeCriterion.evidence, /successful journal resume\/recovery result/);

  harness.state.lastRecoveryResult = {
    success: true,
    results: [{
      poolId: 'PoolRecovered222222222222222222222222222',
      mainPositions: [{ nftMint: 'PositionRecovered2222222222222222222222222' }],
    }],
  };
  resumeCriterion = harness.buildV2ReplacementCriteriaAudit({
    proof: null,
    audit,
    hasCompletedLiveProof: false,
    demoRunComplete: false,
  }).find((item) => item.id === 'run-and-resume');
  assert.equal(resumeCriterion.pass, true);
  assert.match(resumeCriterion.evidence, /successful journal resume\/recovery result/);
  harness.state.lastRecoveryResult = null;

  const demoGate = harness.buildClassicRetirementGate({ ...proof, source: 'demo-run' }, audit);
  assert.equal(demoGate.state, 'danger');
  assert.equal(demoGate.requirements.find((item) => item.id === 'live-proof').pass, false);
  assert.match(demoGate.requirements.find((item) => item.id === 'live-proof').detail, /Demo proof proves wiring only/);

  harness.state.classicReportComparison = {
    result: { ...classicComparison, artifactSource: 'trebuchet-v2' },
  };
  const selfArtifactGate = harness.buildClassicRetirementGate(proof, audit);
  assert.equal(selfArtifactGate.state, 'danger');
  assert.equal(selfArtifactGate.requirements.find((item) => item.id === 'classic-comparison').pass, false);
  assert.match(selfArtifactGate.requirements.find((item) => item.id === 'classic-comparison').detail, /v2-generated/);

  harness.state.classicReportComparison = {
    result: { ...classicComparison, matchesProof: false },
  };
  const staleGate = harness.buildClassicRetirementGate(proof, audit);
  assert.equal(staleGate.state, 'danger');
  assert.equal(staleGate.requirements.find((item) => item.id === 'classic-comparison').pass, false);
  assert.match(staleGate.requirements.find((item) => item.id === 'classic-comparison').detail, /belongs to another v2 proof/);
});

test('v2 demo completion requires airdrop and Fee Key recipient evidence', () => {
  const harness = loadClassicRetirementGateHarness();
  const clone = (value) => JSON.parse(JSON.stringify(value));
  harness.state.currentConfig = {
    poolTopology: {
      airdrop: {
        enabled: true,
        recipientCount: 1,
        recipients: [{ wallet: 'AirdropDemo11111111111111111111111111111', tokens: 25 }],
      },
    },
  };

  const completedDemoRun = {
    token: { tokenMint: 'MintDemo111111111111111111111111111111111' },
    liquidity: {
      results: [{
        poolId: 'PoolDemo111111111111111111111111111111111',
        mainPositions: [{
          sliceIndex: 0,
          locked: true,
          feeKeyNftMint: 'FeeKeyDemo111111111111111111111111111111',
          recipient: 'FeeRecipientDemo1111111111111111111111111',
          transferredTo: 'FeeRecipientDemo1111111111111111111111111',
          txIds: {
            open: 'OpenDemo111111111111111111111111111111111',
            lock: 'LockDemo111111111111111111111111111111111',
            transfer: 'TransferDemo11111111111111111111111111111',
          },
        }],
        ladderPositions: [],
        supportPositions: [],
      }],
    },
    transfer: {
      destinationWallet: 'DestDemo111111111111111111111111111111111',
      walletEmpty: true,
      tokenSweep: { transferred: [], errors: [] },
      nftSweep: { transferred: [], errors: [] },
      airdrop: {
        transferred: [{
          wallet: 'AirdropDemo11111111111111111111111111111',
          tokens: 25,
          txId: 'AirdropTxDemo1111111111111111111111111111',
        }],
        failed: [],
      },
    },
    readiness: {
      completed: true,
      completionStatus: 'complete',
      completion: { terminalSweepEvidence: true },
      nextEndpoint: null,
      phases: [{ id: 'sweep', state: 'complete' }],
      plan: {
        token: { name: 'Demo', symbol: 'DEMO', supply: '1000', decimals: 9 },
        poolTopology: {
          sweepDestination: 'DestDemo111111111111111111111111111111111',
          airdrop: {
            enabled: true,
            recipientCount: 1,
            recipients: [{ wallet: 'AirdropDemo11111111111111111111111111111', tokens: 25 }],
          },
        },
      },
    },
  };

  assert.equal(harness.demoRunHasCompletedReadiness(completedDemoRun), true);

  harness.state.currentConfig = {
    poolTopology: {
      airdrop: {
        enabled: false,
        recipientCount: 0,
        recipients: [],
      },
    },
  };

  const missingAirdropTx = clone(completedDemoRun);
  missingAirdropTx.transfer.airdrop.transferred[0].txId = '';
  assert.equal(harness.demoRunHasCompletedReadiness(missingAirdropTx), false);

  const missingFeeKeyTransfer = clone(completedDemoRun);
  missingFeeKeyTransfer.liquidity.results[0].mainPositions[0].txIds.transfer = '';
  assert.equal(harness.demoRunHasCompletedReadiness(missingFeeKeyTransfer), false);
});

test('v2 classic artifact comparison matches authority fields by name', () => {
  const { compareClassicReportArtifact, classicComparisonProofFingerprint } = loadClassicComparisonHarness();
  const proof = {
    walletPublicKey: 'Wallet1111111111111111111111111111111111111',
    token: {
      mint: 'Mint111111111111111111111111111111111111111',
      mintAuthorityRenounced: true,
      freezeAuthorityDisabled: true,
    },
    liquidity: {
      poolIds: ['Pool111111111111111111111111111111111111111'],
      lockedPositionCount: 1,
      feeKeyCount: 1,
      results: [{
        poolId: 'Pool111111111111111111111111111111111111111',
        mainPositions: [{ locked: true, feeKeyNftMint: 'Fee1111111111111111111111111111111111111111' }],
      }],
    },
    transfer: {
      destinationWallet: 'Dest111111111111111111111111111111111111111',
    },
    airdrop: {
      plannedRecipientCount: 0,
      deliveredCount: 0,
      failedCount: 0,
    },
  };
  const config = { poolTopology: { sweepDestination: proof.transfer.destinationWallet } };
  const mismatchedArtifact = {
    source: 'classic',
    launch: {
      mint: proof.token.mint,
      walletPublicKey: proof.walletPublicKey,
      transfer: proof.transfer,
      token: {
        authorities: {
          mintAuthorityRenounced: false,
          freezeAuthorityDisabled: true,
          metadataUpdateAuthorityRevoked: true,
        },
      },
      liquidity: {
        positionCount: 1,
        lockedPositionCount: 1,
        feeKeyCount: 1,
        poolIds: proof.liquidity.poolIds,
      },
      pools: [{ poolId: proof.liquidity.poolIds[0] }],
    },
  };

  const result = compareClassicReportArtifact(JSON.stringify(mismatchedArtifact), proof, config);
  const authorityRow = result.rows.find((row) => row.id === 'authority-posture');
  const fingerprint = classicComparisonProofFingerprint({
    mint: proof.token.mint,
    launchWallet: proof.walletPublicKey,
    destinationWallet: proof.transfer.destinationWallet,
    poolIds: proof.liquidity.poolIds,
    positionCount: 1,
    lockedPositionCount: 1,
    feeKeyCount: 1,
    authorities: {
      mintAuthorityRenounced: true,
      freezeAuthorityDisabled: true,
    },
    airdrop: proof.airdrop,
  });

  assert.equal(result.status, 'mismatch');
  assert.equal(authorityRow.state, 'mismatch');
  assert.match(authorityRow.detail, /Mismatched: Mint authority/);
  assert.match(fingerprint, /"authorities"/);
  assert.match(fingerprint, /"mintAuthorityRenounced":true/);
});

test('v2 classic artifact comparison verifies per-position proof records', () => {
  const { compareClassicReportArtifact, classicComparisonProofFingerprint, classicComparisonRequiredEvidence } = loadClassicComparisonHarness();
  const proof = {
    walletPublicKey: 'Wallet2222222222222222222222222222222222222',
    token: {
      mint: 'Mint222222222222222222222222222222222222222',
      mintAuthorityRenounced: true,
      freezeAuthorityDisabled: true,
    },
    liquidity: {
      poolIds: ['Pool222222222222222222222222222222222222222'],
      lockedPositionCount: 1,
      feeKeyCount: 1,
      results: [{
        poolId: 'Pool222222222222222222222222222222222222222',
        mainPositions: [{
          locked: true,
          recipient: 'FeeRecipient222222222222222222222222222222',
          transferredTo: 'FeeRecipient222222222222222222222222222222',
          tickLower: -443640,
          tickUpper: 443640,
          nftMint: 'Pos2222222222222222222222222222222222222222',
          feeKeyNftMint: 'Fee2222222222222222222222222222222222222222',
          txIds: {
            open: 'OpenTx2222222222222222222222222222222222222',
            lock: 'LockTx2222222222222222222222222222222222222',
            transfer: 'TransferTx222222222222222222222222222222222',
          },
        }],
      }],
    },
    transfer: {
      destinationWallet: 'Dest222222222222222222222222222222222222222',
    },
    airdrop: {
      plannedRecipientCount: 0,
      deliveredCount: 0,
      failedCount: 0,
    },
  };
  const matchingArtifact = {
    source: 'classic',
    launch: {
      mint: proof.token.mint,
      walletPublicKey: proof.walletPublicKey,
      transfer: proof.transfer,
      token: {
        authorities: {
          mintAuthorityRenounced: true,
          freezeAuthorityDisabled: true,
        },
      },
      liquidity: {
        positionCount: 1,
        lockedPositionCount: 1,
        feeKeyCount: 1,
        poolIds: proof.liquidity.poolIds,
      },
      pools: [{
        poolId: proof.liquidity.poolIds[0],
        positions: [{
          type: 'main',
          locked: true,
          recipient: 'FeeRecipient222222222222222222222222222222',
          transferredTo: 'FeeRecipient222222222222222222222222222222',
          tickLower: -443640,
          tickUpper: 443640,
          positionNftMint: 'Pos2222222222222222222222222222222222222222',
          feeKeyNftMint: 'Fee2222222222222222222222222222222222222222',
          openTx: 'OpenTx2222222222222222222222222222222222222',
          lockTx: 'LockTx2222222222222222222222222222222222222',
          transferTx: 'TransferTx222222222222222222222222222222222',
        }],
      }],
    },
  };
  const missingFeeKeyArtifact = structuredClone(matchingArtifact);
  missingFeeKeyArtifact.launch.pools[0].positions[0].feeKeyNftMint = null;
  const mismatchedRecipientArtifact = structuredClone(matchingArtifact);
  mismatchedRecipientArtifact.launch.pools[0].positions[0].transferredTo = 'WrongRecipient22222222222222222222222222222';
  const extraPositionArtifact = structuredClone(matchingArtifact);
  extraPositionArtifact.launch.liquidity.positionCount = 2;
  extraPositionArtifact.launch.liquidity.lockedPositionCount = 2;
  extraPositionArtifact.launch.liquidity.feeKeyCount = 2;
  extraPositionArtifact.launch.pools[0].positions.push({
    type: 'ladder',
    locked: true,
    tickLower: 443640,
    tickUpper: 887280,
    positionNftMint: 'ExtraPos22222222222222222222222222222222222222',
    feeKeyNftMint: 'ExtraFee22222222222222222222222222222222222222',
    openTx: 'ExtraOpenTx22222222222222222222222222222222222',
    lockTx: 'ExtraLockTx22222222222222222222222222222222222',
  });

  const passResult = compareClassicReportArtifact(JSON.stringify(matchingArtifact), proof, { poolTopology: {} });
  const failResult = compareClassicReportArtifact(JSON.stringify(missingFeeKeyArtifact), proof, { poolTopology: {} });
  const recipientResult = compareClassicReportArtifact(JSON.stringify(mismatchedRecipientArtifact), proof, { poolTopology: {} });
  const extraResult = compareClassicReportArtifact(JSON.stringify(extraPositionArtifact), proof, { poolTopology: {} });
  const requiredEvidence = classicComparisonRequiredEvidence(passResult, proof, { poolTopology: {} });
  const thinRequiredEvidence = classicComparisonRequiredEvidence({
    ...passResult,
    passCount: 1,
    fieldCount: 1,
    rows: passResult.rows.filter((row) => row.id === 'mint'),
  }, proof, { poolTopology: {} });
  const feeKeyRow = failResult.rows.find((row) => row.id === 'fee-key-nfts');
  const recipientRow = recipientResult.rows.find((row) => row.id === 'fee-key-recipients');
  const extraCountRow = extraResult.rows.find((row) => row.id === 'positionCount');
  const extraPositionRow = extraResult.rows.find((row) => row.id === 'position-nfts');

  assert.equal(passResult.status, 'pass');
  assert.equal(requiredEvidence.pass, true);
  assert.equal(thinRequiredEvidence.pass, false);
  assert.match(thinRequiredEvidence.detail, /Classic comparison is missing required passing row/);
  assert.equal(passResult.rows.find((row) => row.id === 'position-nfts').state, 'pass');
  assert.equal(passResult.rows.find((row) => row.id === 'fee-key-nfts').state, 'pass');
  assert.equal(passResult.rows.find((row) => row.id === 'fee-key-recipients').state, 'pass');
  assert.equal(passResult.rows.find((row) => row.id === 'position-transactions').state, 'pass');
  assert.equal(failResult.status, 'missing');
  assert.equal(feeKeyRow.state, 'missing');
  assert.match(feeKeyRow.detail, /0\/1 current Fee Key NFT mints/);
  assert.equal(recipientResult.status, 'mismatch');
  assert.equal(recipientRow.state, 'mismatch');
  assert.match(recipientRow.detail, /sets must match exactly/);
  assert.equal(extraResult.status, 'mismatch');
  assert.equal(extraCountRow.state, 'mismatch');
  assert.equal(extraPositionRow.state, 'mismatch');
  assert.match(extraPositionRow.detail, /sets must match exactly/);
  assert.match(classicComparisonProofFingerprint(passResult.rows ? {
    mint: proof.token.mint,
    launchWallet: proof.walletPublicKey,
    destinationWallet: proof.transfer.destinationWallet,
    poolIds: proof.liquidity.poolIds,
    positionCount: 1,
    lockedPositionCount: 1,
    feeKeyCount: 1,
    positions: [{
      type: 'main',
      positionNftMint: 'Pos2222222222222222222222222222222222222222',
      feeKeyNftMint: 'Fee2222222222222222222222222222222222222222',
      locked: true,
      tickLower: -443640,
      tickUpper: 443640,
    }],
    authorities: {
      mintAuthorityRenounced: true,
      freezeAuthorityDisabled: true,
    },
    airdrop: proof.airdrop,
  } : {}), /"positions"/);
});

test('v2 classic artifact comparison verifies position liquidity shape fields', () => {
  const { compareClassicReportArtifact, classicComparisonProofFingerprint } = loadClassicComparisonHarness();
  const proof = {
    walletPublicKey: 'WalletShape222222222222222222222222222222222',
    token: {
      mint: 'MintShape22222222222222222222222222222222222',
      mintAuthorityRenounced: true,
      freezeAuthorityDisabled: true,
    },
    liquidity: {
      poolIds: ['PoolShape22222222222222222222222222222222222'],
      results: [{
        poolId: 'PoolShape22222222222222222222222222222222222',
        quoteAddress: 'QuoteShape2222222222222222222222222222222222',
        ladderPositions: [{
          bandIndex: 0,
          supplyPercent: 4.5,
          lowerMultiplier: 1.1,
          upperMultiplier: 1.8,
          nftMint: 'LadderShapePos222222222222222222222222222222',
          feeKeyNftMint: 'LadderShapeFee222222222222222222222222222222',
          locked: true,
        }],
        supportPositions: [{
          supportIndex: 0,
          depthPct: 12,
          nftMint: 'SupportShapePos22222222222222222222222222222',
          feeKeyNftMint: 'SupportShapeFee22222222222222222222222222222',
          locked: true,
        }],
      }],
    },
    transfer: {
      destinationWallet: 'DestShape2222222222222222222222222222222222',
    },
    airdrop: {
      plannedRecipientCount: 0,
      deliveredCount: 0,
      failedCount: 0,
    },
  };
  const matchingArtifact = {
    source: 'classic',
    launch: {
      mint: proof.token.mint,
      walletPublicKey: proof.walletPublicKey,
      transfer: proof.transfer,
      token: {
        authorities: {
          mintAuthorityRenounced: true,
          freezeAuthorityDisabled: true,
        },
      },
      liquidity: {
        positionCount: 2,
        lockedPositionCount: 2,
        feeKeyCount: 2,
        poolIds: proof.liquidity.poolIds,
      },
      pools: [{
        poolId: proof.liquidity.poolIds[0],
        quoteMint: 'QuoteShape2222222222222222222222222222222222',
        positions: [{
          type: 'ladder',
          bandIndex: 0,
          supplyPercent: 4.5,
          lowerMultiplier: 1.1,
          upperMultiplier: 1.8,
          positionNftMint: 'LadderShapePos222222222222222222222222222222',
          feeKeyNftMint: 'LadderShapeFee222222222222222222222222222222',
          locked: true,
        }, {
          type: 'support',
          supportIndex: 0,
          depthPct: 12,
          positionNftMint: 'SupportShapePos22222222222222222222222222222',
          feeKeyNftMint: 'SupportShapeFee22222222222222222222222222222',
          locked: true,
        }],
      }],
    },
  };
  const mismatchedArtifact = structuredClone(matchingArtifact);
  mismatchedArtifact.launch.pools[0].positions[0].upperMultiplier = 2.4;
  mismatchedArtifact.launch.pools[0].positions[1].depthPct = 18;

  const passResult = compareClassicReportArtifact(JSON.stringify(matchingArtifact), proof, { poolTopology: {} });
  const mismatchResult = compareClassicReportArtifact(JSON.stringify(mismatchedArtifact), proof, { poolTopology: {} });
  const passRow = passResult.rows.find((row) => row.id === 'position-liquidity-shape');
  const mismatchRow = mismatchResult.rows.find((row) => row.id === 'position-liquidity-shape');
  const fingerprint = classicComparisonProofFingerprint({
    mint: proof.token.mint,
    launchWallet: proof.walletPublicKey,
    destinationWallet: proof.transfer.destinationWallet,
    poolIds: proof.liquidity.poolIds,
    pools: [],
    positionCount: 2,
    lockedPositionCount: 2,
    feeKeyCount: 2,
    positions: [{
      poolId: proof.liquidity.poolIds[0],
      type: 'ladder',
      bandIndex: 0,
      supplyPercent: 4.5,
      lowerMultiplier: 1.1,
      upperMultiplier: 1.8,
    }, {
      poolId: proof.liquidity.poolIds[0],
      type: 'support',
      supportIndex: 0,
      depthPct: 12,
    }],
    authorities: {
      mintAuthorityRenounced: true,
      freezeAuthorityDisabled: true,
    },
    airdrop: proof.airdrop,
  });

  assert.equal(passResult.status, 'pass');
  assert.equal(passRow.state, 'pass');
  assert.equal(passRow.expected, '4/4');
  assert.equal(mismatchResult.status, 'mismatch');
  assert.equal(mismatchRow.state, 'mismatch');
  assert.match(mismatchRow.detail, /upper multiplier/);
  assert.match(mismatchRow.detail, /support depth/);
  assert.match(fingerprint, /"upperMultiplier":1\.8/);
  assert.match(fingerprint, /"depthPct":12/);
});

test('v2 classic artifact comparison extracts structured pool and position proof from Classic HTML', () => {
  const { compareClassicReportArtifact } = loadClassicComparisonHarness();
  const proof = {
    walletPublicKey: 'HtmlWallet111111111111111111111111111111111',
    token: {
      mint: 'HtmlMint1111111111111111111111111111111111',
      mintAuthorityRenounced: true,
      freezeAuthorityDisabled: true,
      metadataUpdateAuthorityRevoked: true,
      metadataImmutable: true,
    },
    liquidity: {
      poolIds: ['HtmlPool1111111111111111111111111111111111'],
      lockedPositionCount: 1,
      feeKeyCount: 1,
      results: [{
        poolId: 'HtmlPool1111111111111111111111111111111111',
        quoteAddress: 'HtmlQuote111111111111111111111111111111111',
        txIds: {
          createPool: 'HtmlCreatePoolTx111111111111111111111111111111',
        },
        mainPositions: [{
          locked: true,
          recipient: 'HtmlRecipient11111111111111111111111111111',
          transferredTo: 'HtmlRecipient11111111111111111111111111111',
          nftMint: 'HtmlPosition11111111111111111111111111111111',
          feeKeyNftMint: 'HtmlFeeKey1111111111111111111111111111111',
          txIds: {
            open: 'HtmlOpenTx111111111111111111111111111111111',
            lock: 'HtmlLockTx111111111111111111111111111111111',
            transfer: 'HtmlTransferTx1111111111111111111111111111',
          },
        }],
      }],
    },
    transfer: {
      destinationWallet: 'HtmlDest1111111111111111111111111111111111',
      walletEmpty: true,
    },
    airdrop: {
      plannedRecipientCount: 0,
      deliveredCount: 0,
      failedCount: 0,
    },
  };
  const pool = proof.liquidity.results[0];
  const position = pool.mainPositions[0];
  const classicHtml = `
    <html><body>
      <h1>Classic launch report</h1>
      <p>
        Mint authority renounced.
        Freeze authority disabled.
        Metadata update authority revoked.
        Metadata immutability immutable.
      </p>
      <div class="addr-row"><span class="addr-label">Token mint</span><code class="addr-value">${proof.token.mint}</code></div>
      <div class="addr-row"><span class="addr-label">Launch wallet</span><code class="addr-value">${proof.walletPublicKey}</code></div>
      <div class="addr-row"><span class="addr-label">Planned sweep destination</span><code class="addr-value">${proof.transfer.destinationWallet}</code></div>
      <div class="addr-row"><span class="addr-label">Pool ID</span><code class="addr-value">${pool.poolId}</code></div>
      <div class="addr-row"><span class="addr-label">Quote token mint</span><code class="addr-value">${pool.quoteAddress}</code></div>
      <div class="addr-row"><span class="addr-label">Create-pool TX</span><code class="addr-value">${pool.txIds.createPool}</code></div>
      <div class="addr-row"><span class="addr-label">Position NFT</span><code class="addr-value">${position.nftMint}</code></div>
      <div class="addr-row"><span class="addr-label">Fee Key NFT</span><code class="addr-value">${position.feeKeyNftMint}</code></div>
      <div class="addr-row"><span class="addr-label">Open TX</span><code class="addr-value">${position.txIds.open}</code></div>
      <div class="addr-row"><span class="addr-label">Lock TX</span><code class="addr-value">${position.txIds.lock}</code></div>
      <div class="addr-row"><span class="addr-label">Fee Key recipient</span><code class="addr-value">${position.recipient}</code></div>
      <div class="addr-row"><span class="addr-label">Fee Key delivered to</span><code class="addr-value">${position.transferredTo}</code></div>
      <div class="addr-row"><span class="addr-label">Fee Key transfer TX</span><code class="addr-value">${position.txIds.transfer}</code></div>
    </body></html>
  `;

  const result = compareClassicReportArtifact(classicHtml, proof, {
    poolTopology: { sweepDestination: proof.transfer.destinationWallet },
  });
  const mismatchedDestination = 'HtmlWrongDest11111111111111111111111111111';
  const mismatchResult = compareClassicReportArtifact(
    classicHtml.replace(proof.transfer.destinationWallet, mismatchedDestination),
    proof,
    { poolTopology: { sweepDestination: proof.transfer.destinationWallet } },
  );
  const extraPoolResult = compareClassicReportArtifact(
    classicHtml.replace(
      '</body></html>',
      '<div class="addr-row"><span class="addr-label">Pool ID</span><code class="addr-value">HtmlExtraPool11111111111111111111111111111</code></div></body></html>',
    ),
    proof,
    { poolTopology: { sweepDestination: proof.transfer.destinationWallet } },
  );
  const deliveredMismatchResult = compareClassicReportArtifact(
    classicHtml.replace(
      `<span class="addr-label">Fee Key delivered to</span><code class="addr-value">${position.transferredTo}</code>`,
      '<span class="addr-label">Fee Key delivered to</span><code class="addr-value">HtmlWrongRecipient111111111111111111111111111</code>',
    ),
    proof,
    { poolTopology: { sweepDestination: proof.transfer.destinationWallet } },
  );
  const rowState = (id) => result.rows.find((row) => row.id === id)?.state;
  const destinationRow = mismatchResult.rows.find((row) => row.id === 'destination');
  const extraPoolRow = extraPoolResult.rows.find((row) => row.id === 'pools');
  const deliveredMismatchRow = deliveredMismatchResult.rows.find((row) => row.id === 'fee-key-recipients');

  assert.equal(result.status, 'pass');
  assert.equal(rowState('mint'), 'pass');
  assert.equal(rowState('launch-wallet'), 'pass');
  assert.equal(rowState('pools'), 'pass');
  assert.equal(rowState('pool-quote-mints'), 'pass');
  assert.equal(rowState('pool-create-transactions'), 'pass');
  assert.equal(rowState('positionCount'), 'pass');
  assert.equal(rowState('lockedPositionCount'), 'pass');
  assert.equal(rowState('feeKeyCount'), 'pass');
  assert.equal(rowState('position-nfts'), 'pass');
  assert.equal(rowState('fee-key-nfts'), 'pass');
  assert.equal(rowState('fee-key-recipients'), 'pass');
  assert.equal(rowState('position-transactions'), 'pass');
  assert.equal(rowState('authority-posture'), 'pass');
  assert.equal(rowState('destination'), 'pass');
  assert.equal(mismatchResult.status, 'mismatch');
  assert.equal(destinationRow.state, 'mismatch');
  assert.equal(destinationRow.actual, mismatchedDestination);
  assert.equal(extraPoolResult.status, 'mismatch');
  assert.equal(extraPoolRow.state, 'mismatch');
  assert.match(extraPoolRow.detail, /counts must match exactly/);
  assert.equal(deliveredMismatchResult.status, 'mismatch');
  assert.equal(deliveredMismatchRow.state, 'mismatch');
  assert.match(deliveredMismatchRow.detail, /sets must match exactly/);
});

test('v2 proof fingerprints bind Fee Key recipient delivery evidence', () => {
  const { launchProofFingerprint } = loadClassicComparisonHarness();
  const recipient = 'Recipient333333333333333333333333333333333';
  const proof = {
    walletPublicKey: 'Wallet3333333333333333333333333333333333333',
    token: {
      mint: 'Mint333333333333333333333333333333333333333',
      mintAuthorityRenounced: true,
      freezeAuthorityDisabled: true,
      metadataUpdateAuthorityRevoked: true,
      metadataImmutable: true,
    },
    liquidity: {
      poolIds: ['Pool333333333333333333333333333333333333333'],
      lockedPositionCount: 1,
      feeKeyCount: 1,
      results: [{
        poolId: 'Pool333333333333333333333333333333333333333',
        mainPositions: [{
          locked: true,
          recipient,
          transferredTo: null,
          tickLower: -443640,
          tickUpper: 443640,
          nftMint: 'Pos3333333333333333333333333333333333333333',
          feeKeyNftMint: 'Fee3333333333333333333333333333333333333333',
          txIds: {
            open: 'OpenTx333333333333333333333333333333333333',
            lock: 'LockTx333333333333333333333333333333333333',
            transfer: null,
          },
        }],
      }],
    },
    transfer: {
      destinationWallet: 'Dest333333333333333333333333333333333333333',
      walletEmpty: true,
    },
    airdrop: {
      plannedRecipientCount: 0,
      deliveredCount: 0,
      failedCount: 0,
    },
  };
  const config = { poolTopology: { sweepDestination: proof.transfer.destinationWallet } };
  const before = launchProofFingerprint(proof, config);
  const delivered = structuredClone(proof);
  delivered.liquidity.results[0].mainPositions[0].transferredTo = recipient;
  delivered.liquidity.results[0].mainPositions[0].txIds.transfer = 'TransferTx3333333333333333333333333333333333';
  const after = launchProofFingerprint(delivered, config);

  assert.notEqual(after, before);
  assert.match(after, /"recipient":"Recipient333333333333333333333333333333333"/);
  assert.match(after, /"transferredTo":"Recipient333333333333333333333333333333333"/);
  assert.match(after, /"transferTx":"TransferTx3333333333333333333333333333333333"/);
});

test('v2 proof fingerprints bind explicit liquidity count mismatches', () => {
  const { launchProofFingerprint, comparisonLiquidityEvidenceState } = loadClassicComparisonHarness();
  const proof = {
    walletPublicKey: 'WalletCount111111111111111111111111111111111',
    token: {
      mint: 'MintCount1111111111111111111111111111111111',
      mintAuthorityRenounced: true,
      freezeAuthorityDisabled: true,
    },
    liquidity: {
      poolIds: ['PoolCount1111111111111111111111111111111111'],
      poolCount: 1,
      positionCount: 1,
      lockedPositionCount: 1,
      feeKeyCount: 1,
      results: [{
        poolId: 'PoolCount1111111111111111111111111111111111',
        mainPositions: [{
          locked: true,
          nftMint: 'PosCount111111111111111111111111111111111',
          feeKeyNftMint: 'FeeCount111111111111111111111111111111111',
          txIds: {
            open: 'OpenCount11111111111111111111111111111111',
            lock: 'LockCount11111111111111111111111111111111',
          },
        }],
      }],
    },
    transfer: {
      destinationWallet: 'DestCount111111111111111111111111111111111',
      walletEmpty: true,
    },
    airdrop: {
      plannedRecipientCount: 0,
      deliveredCount: 0,
      failedCount: 0,
    },
  };
  const zeroCounts = {
    ...proof,
    liquidity: {
      ...proof.liquidity,
      poolCount: 0,
      positionCount: 0,
      lockedPositionCount: 0,
      feeKeyCount: 0,
    },
  };
  const config = { poolTopology: { sweepDestination: proof.transfer.destinationWallet } };
  const before = launchProofFingerprint(proof, config);
  const after = launchProofFingerprint(zeroCounts, config);
  const evidence = comparisonLiquidityEvidenceState(zeroCounts);

  assert.notEqual(after, before);
  assert.match(after, /"positionCount":0/);
  assert.equal(evidence.complete, false);
  assert.deepEqual([...evidence.missing], [
    'pool count',
    'position count',
    'lock count',
    'fee key count',
  ]);
});

test('v2 classic artifact comparison verifies pool topology facts', () => {
  const {
    compareClassicReportArtifact,
    classicComparisonProofFingerprint,
    classicComparisonRequiredEvidence,
  } = loadClassicComparisonHarness();
  const proof = {
    walletPublicKey: 'Wallet3333333333333333333333333333333333333',
    token: {
      mint: 'Mint333333333333333333333333333333333333333',
      mintAuthorityRenounced: true,
      freezeAuthorityDisabled: true,
    },
    liquidity: {
      poolIds: ['Pool333333333333333333333333333333333333333'],
      results: [{
        poolId: 'Pool333333333333333333333333333333333333333',
        quoteSymbol: 'BONK',
        quoteAddress: 'Quote33333333333333333333333333333333333333',
        supplyPercent: 42.5,
        tickSpacing: 60,
        initialPrice: '0.00042',
        launchedSide: 'base',
        txIds: {
          createPool: 'CreatePoolTx333333333333333333333333333333333',
        },
      }],
    },
    transfer: {
      destinationWallet: 'Dest333333333333333333333333333333333333333',
    },
    airdrop: {
      plannedRecipientCount: 0,
      deliveredCount: 0,
      failedCount: 0,
    },
  };
  const matchingArtifact = {
    source: 'classic',
    launch: {
      mint: proof.token.mint,
      walletPublicKey: proof.walletPublicKey,
      transfer: proof.transfer,
      token: {
        authorities: {
          mintAuthorityRenounced: true,
          freezeAuthorityDisabled: true,
        },
      },
      liquidity: {
        poolIds: proof.liquidity.poolIds,
      },
      pools: [{
        poolId: proof.liquidity.poolIds[0],
        quote: 'BONK',
        quoteMint: 'Quote33333333333333333333333333333333333333',
        supplyPercent: 42.5,
        tickSpacing: 60,
        initialPrice: '0.00042',
        launchedSide: 'base',
        createPoolTx: 'CreatePoolTx333333333333333333333333333333333',
      }],
    },
  };
  const mismatchedArtifact = structuredClone(matchingArtifact);
  mismatchedArtifact.launch.pools[0].tickSpacing = 120;
  const structuredWrongPoolWithTextArtifact = structuredClone(matchingArtifact);
  structuredWrongPoolWithTextArtifact.launch.liquidity.poolIds = ['WrongPool33333333333333333333333333333333333'];
  structuredWrongPoolWithTextArtifact.launch.pools[0].poolId = 'WrongPool33333333333333333333333333333333333';
  structuredWrongPoolWithTextArtifact.launch.notes = `Diagnostic text mentions ${proof.liquidity.poolIds[0]} but the structured pool row is wrong.`;
  const extraPoolArtifact = structuredClone(matchingArtifact);
  extraPoolArtifact.launch.liquidity.poolIds = [
    ...proof.liquidity.poolIds,
    'ExtraPool33333333333333333333333333333333333333',
  ];
  extraPoolArtifact.launch.pools.push({
    poolId: 'ExtraPool33333333333333333333333333333333',
    quote: 'USDC',
    quoteMint: 'ExtraQuote333333333333333333333333333333333333',
    supplyPercent: 1,
    tickSpacing: 60,
    initialPrice: '1',
    launchedSide: 'base',
    createPoolTx: 'ExtraCreatePoolTx3333333333333333333333333333',
  });
  const htmlProof = structuredClone(proof);
  delete htmlProof.liquidity.results[0].initialPrice;
  delete htmlProof.liquidity.results[0].launchedSide;
  const classicPoolHtml = `
    <html><body>
      <div class="addr-row"><span class="addr-label">Token mint</span><code class="addr-value">${htmlProof.token.mint}</code></div>
      <div class="addr-row"><span class="addr-label">Launch wallet</span><code class="addr-value">${htmlProof.walletPublicKey}</code></div>
      <div class="addr-row"><span class="addr-label">Destination wallet</span><code class="addr-value">${htmlProof.transfer.destinationWallet}</code></div>
      <p>Mint authority renounced. Freeze authority disabled.</p>
      <section class="pool-section">
        <div class="pool-section-header">
          <div class="enum-badge">POOL · 01</div>
          <h2 class="pool-title">BONK pool</h2>
          <div class="pool-meta">42.50% of token supply &nbsp;·&nbsp; Fee tier 0.25% / spacing 60</div>
        </div>
        <div class="pool-addresses">
          <div class="addr-row"><span class="addr-label">Pool ID</span><code class="addr-value">${proof.liquidity.poolIds[0]}</code></div>
          <div class="addr-row"><span class="addr-label">Quote token mint</span><code class="addr-value">Quote33333333333333333333333333333333333333</code></div>
          <div class="addr-row"><span class="addr-label">Create-pool TX</span><code class="addr-value">CreatePoolTx333333333333333333333333333333333</code></div>
        </div>
      </section>
    </body></html>
  `;

  const passResult = compareClassicReportArtifact(JSON.stringify(matchingArtifact), proof, { poolTopology: {} });
  const mismatchResult = compareClassicReportArtifact(JSON.stringify(mismatchedArtifact), proof, { poolTopology: {} });
  const structuredWrongPoolWithTextResult = compareClassicReportArtifact(JSON.stringify(structuredWrongPoolWithTextArtifact), proof, { poolTopology: {} });
  const extraPoolResult = compareClassicReportArtifact(JSON.stringify(extraPoolArtifact), proof, { poolTopology: {} });
  const htmlPoolResult = compareClassicReportArtifact(classicPoolHtml, htmlProof, { poolTopology: {} });
  const sparseProof = {
    ...proof,
    liquidity: {
      poolIds: proof.liquidity.poolIds,
      results: [{ poolId: proof.liquidity.poolIds[0] }],
    },
  };
  const sparseConfig = {
    poolTopology: {
      sweepDestination: proof.transfer.destinationWallet,
      pools: [{
        quoteToken: 'BONK',
        quoteSymbol: 'BONK',
        quoteMint: 'Quote33333333333333333333333333333333333333',
        supplyPercent: 42.5,
        distribution: [{ sharePercent: 100 }],
      }],
      airdrop: { enabled: false, recipientCount: 0, supplyPercent: 0 },
    },
  };
  const sparseMissingPlanArtifact = structuredClone(matchingArtifact);
  delete sparseMissingPlanArtifact.launch.pools[0].supplyPercent;
  const sparsePassResult = compareClassicReportArtifact(JSON.stringify(matchingArtifact), sparseProof, sparseConfig);
  const sparseMissingPlanResult = compareClassicReportArtifact(JSON.stringify(sparseMissingPlanArtifact), sparseProof, sparseConfig);
  const poolParameterRow = mismatchResult.rows.find((row) => row.id === 'pool-parameters');
  const structuredWrongPoolRow = structuredWrongPoolWithTextResult.rows.find((row) => row.id === 'pools');
  const extraPoolRow = extraPoolResult.rows.find((row) => row.id === 'pools');
  const htmlPoolParameterRow = htmlPoolResult.rows.find((row) => row.id === 'pool-parameters');
  const sparsePoolParameterRow = sparsePassResult.rows.find((row) => row.id === 'pool-parameters');
  const sparseMissingPoolParameterRow = sparseMissingPlanResult.rows.find((row) => row.id === 'pool-parameters');
  const sparseEvidence = classicComparisonRequiredEvidence(sparsePassResult, sparseProof, sparseConfig);
  const sparseMissingEvidence = classicComparisonRequiredEvidence(sparseMissingPlanResult, sparseProof, sparseConfig);
  const fingerprint = classicComparisonProofFingerprint({
    mint: proof.token.mint,
    launchWallet: proof.walletPublicKey,
    destinationWallet: proof.transfer.destinationWallet,
    poolIds: proof.liquidity.poolIds,
    pools: [{
      poolId: proof.liquidity.poolIds[0],
      quoteMint: 'Quote33333333333333333333333333333333333333',
      supplyPercent: 42.5,
      tickSpacing: 60,
      initialPrice: '0.00042',
      launchedSide: 'base',
      createPoolTx: 'CreatePoolTx333333333333333333333333333333333',
    }],
    positionCount: 0,
    lockedPositionCount: 0,
    feeKeyCount: 0,
    positions: [],
    authorities: {
      mintAuthorityRenounced: true,
      freezeAuthorityDisabled: true,
    },
    airdrop: proof.airdrop,
  });

  assert.equal(passResult.status, 'pass');
  assert.equal(passResult.rows.find((row) => row.id === 'pool-quote-mints').state, 'pass');
  assert.equal(passResult.rows.find((row) => row.id === 'pool-parameters').state, 'pass');
  assert.equal(passResult.rows.find((row) => row.id === 'pool-create-transactions').state, 'pass');
  assert.equal(mismatchResult.status, 'mismatch');
  assert.equal(poolParameterRow.state, 'mismatch');
  assert.match(poolParameterRow.detail, /Mismatched: Pool333333333333333333333333333333333333333 tick spacing/);
  assert.notEqual(structuredWrongPoolWithTextResult.status, 'pass');
  assert.equal(structuredWrongPoolRow.state, 'missing');
  assert.match(structuredWrongPoolRow.detail, /0\/1 current v2 pool IDs matched/);
  assert.equal(extraPoolResult.status, 'mismatch');
  assert.equal(extraPoolRow.state, 'mismatch');
  assert.match(extraPoolRow.detail, /counts must match exactly/);
  assert.equal(htmlPoolResult.status, 'pass');
  assert.equal(htmlPoolParameterRow.state, 'pass');
  assert.match(htmlPoolParameterRow.detail, /2\/2 pool parameters match/);
  assert.equal(sparsePassResult.status, 'pass');
  assert.equal(sparsePoolParameterRow.state, 'pass');
  assert.equal(sparseEvidence.pass, true);
  assert.notEqual(sparseMissingPlanResult.status, 'pass');
  assert.equal(sparseMissingPoolParameterRow.state, 'missing');
  assert.equal(sparseMissingEvidence.pass, false);
  assert.match(sparseMissingEvidence.detail, /Pool parameters/);
  assert.match(fingerprint, /"pools"/);
  assert.match(fingerprint, /"tickSpacing":60/);
});

test('v2 classic artifact comparison verifies airdrop recipient and transaction evidence', () => {
  const {
    compareClassicReportArtifact,
    classicComparisonProofFingerprint,
    comparisonAirdropDeliveryEvidenceState,
  } = loadClassicComparisonHarness();
  const recipientOne = '5'.repeat(32);
  const recipientTwo = '6'.repeat(32);
  const recipientThree = 'A'.repeat(32);
  const txOne = '3'.repeat(88);
  const txTwo = '4'.repeat(88);
  const txThree = 'B'.repeat(88);
  const proof = {
    walletPublicKey: '9'.repeat(32),
    token: {
      mint: '8'.repeat(32),
      mintAuthorityRenounced: true,
      freezeAuthorityDisabled: true,
    },
    liquidity: {
      poolIds: [],
      results: [],
    },
    transfer: {
      destinationWallet: '7'.repeat(32),
    },
    airdrop: {
      plannedRecipientCount: 2,
      deliveredCount: 2,
      failedCount: 0,
      recipients: [
        { wallet: recipientOne, tokens: 100 },
        { wallet: recipientTwo, tokens: 50 },
      ],
      transferred: [
        { wallet: recipientOne, tokens: 100, txId: txOne },
        { wallet: recipientTwo, tokens: 50, txId: txTwo },
      ],
      failed: [],
    },
  };
  const matchingHtml = `
    <html><body>
      <p>${proof.token.mint} ${proof.walletPublicKey} ${proof.transfer.destinationWallet}</p>
      <p>Mint authority renounced. Freeze authority disabled.</p>
      <table>
        <tr><td>${recipientOne}</td><td>100</td><td><a href="https://solscan.io/tx/${txOne}">${txOne.slice(0, 8)}...</a></td></tr>
        <tr><td>${recipientTwo}</td><td>50</td><td><a href="https://solscan.io/tx/${txTwo}">${txTwo.slice(0, 8)}...</a></td></tr>
      </table>
    </body></html>
  `;
  const missingTxHtml = matchingHtml.replace(txTwo, txTwo.slice(0, 8));
  const classicAirdropHtml = `
    <html><body>
      <div class="addr-row"><span class="addr-label">Token mint</span><code class="addr-value">${proof.token.mint}</code></div>
      <div class="addr-row"><span class="addr-label">Launch wallet</span><code class="addr-value">${proof.walletPublicKey}</code></div>
      <div class="addr-row"><span class="addr-label">Destination wallet</span><code class="addr-value">${proof.transfer.destinationWallet}</code></div>
      <p>Mint authority renounced. Freeze authority disabled.</p>
      <hr class="section-rule">
      <div class="enum-badge">[ 04 ] &nbsp; Airdrop</div>
      <h2 class="section-title">Airdrop distribution</h2>
      <h3 class="subsection">
        Delivered &middot;
        <span style="color: #2c8a52;">2 recipients</span> &middot;
        150 tokens
      </h3>
      <table>
        <thead>
          <tr><th>Recipient</th><th>Tokens</th><th>Transaction</th></tr>
        </thead>
        <tbody>
          <tr>
            <td><code>${recipientOne}</code><a href="https://solscan.io/account/${recipientOne}">view</a></td>
            <td>100</td>
            <td><a href="https://solscan.io/tx/${txOne}">${txOne.slice(0, 8)}...↗</a></td>
          </tr>
          <tr>
            <td><code>${recipientTwo}</code><a href="https://solscan.io/account/${recipientTwo}">view</a></td>
            <td>50</td>
            <td><a href="https://solscan.io/tx/${txTwo}">${txTwo.slice(0, 8)}...↗</a></td>
          </tr>
        </tbody>
      </table>
    </body></html>
  `;
  const extraClassicAirdropHtml = classicAirdropHtml
    .replace('2 recipients', '3 recipients')
    .replace('</tbody>', `
          <tr>
            <td><code>${recipientThree}</code><a href="https://solscan.io/account/${recipientThree}">view</a></td>
            <td>25</td>
            <td><a href="https://solscan.io/tx/${txThree}">${txThree.slice(0, 8)}...↗</a></td>
          </tr>
        </tbody>`);
  const matchingJson = {
    source: 'classic',
    launch: {
      mint: proof.token.mint,
      walletPublicKey: proof.walletPublicKey,
      transfer: proof.transfer,
      token: {
        authorities: {
          mintAuthorityRenounced: true,
          freezeAuthorityDisabled: true,
        },
      },
      airdrop: proof.airdrop,
    },
  };
  const extraAirdropJson = structuredClone(matchingJson);
  extraAirdropJson.launch.airdrop = {
    ...proof.airdrop,
    plannedRecipientCount: 3,
    deliveredCount: 3,
    transferred: [
      ...proof.airdrop.transferred,
      { wallet: recipientThree, tokens: 25, txId: txThree },
    ],
  };
  const rawClassicLaunchData = {
    dataVersion: 4,
    mint: proof.token.mint,
    launchWallet: proof.walletPublicKey,
    destinationWallet: proof.transfer.destinationWallet,
    transfer: {
      status: 'planned-before-sweep',
      destinationWallet: proof.transfer.destinationWallet,
    },
    token: {
      mint: proof.token.mint,
      authorities: {
        mintAuthorityRenounced: true,
        freezeAuthorityDisabled: true,
      },
    },
    airdrop: proof.airdrop,
  };

  const passResult = compareClassicReportArtifact(matchingHtml, proof, { poolTopology: {} });
  const jsonPassResult = compareClassicReportArtifact(JSON.stringify(matchingJson), proof, { poolTopology: {} });
  const extraAirdropResult = compareClassicReportArtifact(JSON.stringify(extraAirdropJson), proof, { poolTopology: {} });
  const rawJsonPassResult = compareClassicReportArtifact(JSON.stringify(rawClassicLaunchData), proof, {
    poolTopology: { sweepDestination: proof.transfer.destinationWallet },
  });
  const missingTxResult = compareClassicReportArtifact(missingTxHtml, proof, { poolTopology: {} });
  const classicHtmlPassResult = compareClassicReportArtifact(classicAirdropHtml, proof, { poolTopology: {} });
  const classicHtmlExtraResult = compareClassicReportArtifact(extraClassicAirdropHtml, proof, { poolTopology: {} });
  const fingerprint = classicComparisonProofFingerprint({
    mint: proof.token.mint,
    launchWallet: proof.walletPublicKey,
    destinationWallet: proof.transfer.destinationWallet,
    poolIds: [],
    pools: [],
    positionCount: 0,
    lockedPositionCount: 0,
    feeKeyCount: 0,
    positions: [],
    authorities: {
      mintAuthorityRenounced: true,
      freezeAuthorityDisabled: true,
    },
    airdrop: proof.airdrop,
  });
  const fingerprintData = JSON.parse(fingerprint);
  const compactProof = {
    ...proof,
    airdrop: {
      plannedRecipientCount: 2,
      deliveredCount: 2,
      failedCount: 0,
      recipients: [],
      recipientsHash: fingerprintData.airdrop.recipientsHash,
      recipientsSample: proof.airdrop.recipients.slice(0, 1),
      recipientsTruncatedCount: 1,
      transferred: [],
      transferredHash: fingerprintData.airdrop.transferredHash,
      transferredSample: proof.airdrop.transferred.slice(0, 1),
      transferredTruncatedCount: 1,
      failed: [],
      failedHash: fingerprintData.airdrop.failedHash,
      compactRows: true,
    },
  };
  const compactFingerprint = classicComparisonProofFingerprint({
    mint: compactProof.token.mint,
    launchWallet: compactProof.walletPublicKey,
    destinationWallet: compactProof.transfer.destinationWallet,
    poolIds: [],
    pools: [],
    positionCount: 0,
    lockedPositionCount: 0,
    feeKeyCount: 0,
    positions: [],
    authorities: {
      mintAuthorityRenounced: true,
      freezeAuthorityDisabled: true,
    },
    airdrop: compactProof.airdrop,
  });
  const compactProofResult = compareClassicReportArtifact(JSON.stringify(matchingJson), compactProof, { poolTopology: {} });
  const countOnlyProof = {
    ...proof,
    airdrop: {
      plannedRecipientCount: 2,
      deliveredCount: 2,
      failedCount: 0,
      recipients: [],
      transferred: [],
      failed: [],
    },
  };
  const countOnlyJson = {
    source: 'classic',
    launch: {
      mint: proof.token.mint,
      walletPublicKey: proof.walletPublicKey,
      transfer: proof.transfer,
      token: matchingJson.launch.token,
      airdrop: {
        plannedRecipientCount: 2,
        deliveredCount: 2,
        failedCount: 0,
      },
    },
  };
  const countOnlyResult = compareClassicReportArtifact(JSON.stringify(countOnlyJson), countOnlyProof, { poolTopology: {} });
  const zeroDeliveredCountProof = {
    ...proof,
    airdrop: {
      ...proof.airdrop,
      deliveredCount: 0,
    },
  };

  assert.equal(passResult.status, 'pass');
  assert.equal(passResult.rows.find((row) => row.id === 'airdrop-delivery').state, 'pass');
  assert.equal(passResult.rows.find((row) => row.id === 'airdrop-recipients').state, 'pass');
  assert.equal(passResult.rows.find((row) => row.id === 'airdrop-transactions').state, 'pass');
  assert.equal(jsonPassResult.status, 'pass');
  assert.equal(jsonPassResult.rows.find((row) => row.id === 'airdrop-recipients').state, 'pass');
  assert.equal(jsonPassResult.rows.find((row) => row.id === 'airdrop-transactions').state, 'pass');
  assert.equal(classicHtmlPassResult.status, 'pass');
  assert.equal(classicHtmlPassResult.rows.find((row) => row.id === 'airdrop-delivery').state, 'pass');
  assert.equal(classicHtmlPassResult.rows.find((row) => row.id === 'airdrop-recipients').state, 'pass');
  assert.equal(classicHtmlPassResult.rows.find((row) => row.id === 'airdrop-transactions').state, 'pass');
  assert.equal(classicHtmlExtraResult.status, 'mismatch');
  assert.equal(classicHtmlExtraResult.rows.find((row) => row.id === 'airdrop-delivery').state, 'mismatch');
  assert.equal(classicHtmlExtraResult.rows.find((row) => row.id === 'airdrop-recipients').state, 'mismatch');
  assert.equal(classicHtmlExtraResult.rows.find((row) => row.id === 'airdrop-transactions').state, 'mismatch');
  assert.match(classicHtmlExtraResult.rows.find((row) => row.id === 'airdrop-recipients').detail, /sets must match exactly/);
  assert.equal(extraAirdropResult.status, 'mismatch');
  assert.equal(extraAirdropResult.rows.find((row) => row.id === 'airdrop-delivery').state, 'mismatch');
  assert.equal(extraAirdropResult.rows.find((row) => row.id === 'airdrop-recipients').state, 'mismatch');
  assert.equal(extraAirdropResult.rows.find((row) => row.id === 'airdrop-transactions').state, 'mismatch');
  assert.match(extraAirdropResult.rows.find((row) => row.id === 'airdrop-recipients').detail, /sets must match exactly/);
  assert.equal(rawJsonPassResult.status, 'pass');
  assert.equal(rawJsonPassResult.rows.find((row) => row.id === 'destination').state, 'pass');
  assert.equal(rawJsonPassResult.rows.find((row) => row.id === 'airdrop-transactions').state, 'pass');
  assert.equal(missingTxResult.status, 'warn');
  assert.equal(missingTxResult.rows.find((row) => row.id === 'airdrop-transactions').state, 'warn');
  assert.match(fingerprint, /"recipientsHash"/);
  assert.match(fingerprint, /"transferredHash"/);
  assert.equal(compactFingerprint, fingerprint);
  assert.notEqual(compactProofResult.status, 'pass');
  assert.equal(compactProofResult.rows.find((row) => row.id === 'airdrop-compact-evidence').state, 'missing');
  assert.match(compactProofResult.rows.find((row) => row.id === 'airdrop-compact-evidence').detail, /full JSON proof/);
  assert.equal(comparisonAirdropDeliveryEvidenceState(countOnlyProof.airdrop).complete, false);
  assert.deepEqual([...comparisonAirdropDeliveryEvidenceState(countOnlyProof.airdrop).missing], [
    'recipient rows',
    'delivered rows',
    'transaction signatures',
  ]);
  assert.equal(comparisonAirdropDeliveryEvidenceState(zeroDeliveredCountProof.airdrop).complete, false);
  assert.deepEqual([...comparisonAirdropDeliveryEvidenceState(zeroDeliveredCountProof.airdrop).missing], [
    'delivered count',
  ]);
  assert.notEqual(countOnlyResult.status, 'pass');
  assert.equal(countOnlyResult.rows.find((row) => row.id === 'airdrop-delivery').state, 'missing');
  assert.equal(countOnlyResult.rows.find((row) => row.id === 'airdrop-recipients').state, 'missing');
  assert.equal(countOnlyResult.rows.find((row) => row.id === 'airdrop-transactions').state, 'missing');
  assert.match(countOnlyResult.rows.find((row) => row.id === 'airdrop-delivery').detail, /missing exact airdrop evidence/);
});

test('v2 classic artifact comparison requires structured Classic report evidence for replacement gates', () => {
  const {
    compareClassicReportArtifact,
    classicComparisonRequiredEvidence,
  } = loadClassicComparisonHarness();
  const proof = {
    walletPublicKey: 'B'.repeat(44),
    token: {
      mint: 'A'.repeat(44),
      mintAuthorityRenounced: true,
    },
    liquidity: {
      poolIds: [],
      results: [],
    },
    destinationWallet: 'C'.repeat(44),
    transfer: {
      destinationWallet: 'C'.repeat(44),
      walletEmpty: true,
    },
    airdrop: {
      plannedRecipientCount: 0,
      deliveredCount: 0,
      failedCount: 0,
    },
  };
  const config = { poolTopology: {} };
  const structuredArtifact = {
    launch: {
      mint: proof.token.mint,
      walletPublicKey: proof.walletPublicKey,
      destinationWallet: proof.destinationWallet,
      transfer: proof.transfer,
      token: {
        authorities: {
          mintAuthorityRenounced: true,
        },
      },
    },
  };
  const looseTextArtifact = [
    'Mint authority renounced.',
    proof.token.mint,
    proof.walletPublicKey,
    proof.destinationWallet,
  ].join(' ');

  const structuredResult = compareClassicReportArtifact(JSON.stringify(structuredArtifact), proof, config);
  const looseResult = compareClassicReportArtifact(looseTextArtifact, proof, config);
  const structuredEvidence = classicComparisonRequiredEvidence(structuredResult, proof, config);
  const looseEvidence = classicComparisonRequiredEvidence(looseResult, proof, config);

  assert.equal(structuredResult.status, 'pass');
  assert.equal(structuredResult.structuredEvidence, true);
  assert.equal(structuredEvidence.pass, true);
  assert.equal(looseResult.status, 'pass');
  assert.equal(looseResult.structuredEvidence, false);
  assert.equal(looseEvidence.pass, false);
  assert.match(looseEvidence.detail, /structured Classic report evidence/);
});

test('v2 persisted Classic comparison keeps structured evidence for reload-safe gates', () => {
  const persistence = loadClassicComparisonPersistenceHarness();
  const { classicComparisonRequiredEvidence } = loadClassicComparisonHarness();
  const proof = {
    walletPublicKey: 'PersistWallet111111111111111111111111111111',
    token: { mint: 'PersistMint11111111111111111111111111111111' },
    transfer: {
      destinationWallet: 'PersistDest111111111111111111111111111111',
      walletEmpty: true,
    },
  };
  const rows = [
    { id: 'mint', label: 'Token mint', state: 'pass' },
    { id: 'launch-wallet', label: 'Launch wallet', state: 'pass' },
    { id: 'destination', label: 'Destination wallet', state: 'pass' },
  ];
  const normalized = persistence.normalizeClassicReportComparison({
    input: JSON.stringify({ source: 'classic' }),
    comparedAt: new Date().toISOString(),
    result: {
      status: 'pass',
      artifactKind: 'json',
      artifactSource: 'classic',
      structuredEvidence: true,
      proofFingerprint: 'persist-proof',
      passCount: rows.length,
      warnCount: 0,
      missingCount: 0,
      mismatchCount: 0,
      fieldCount: rows.length,
      rows,
    },
  });
  const evidence = classicComparisonRequiredEvidence(normalized.result, proof, { poolTopology: {} });

  assert.equal(normalized.result.structuredEvidence, true);
  assert.equal(evidence.pass, true);
  assert.match(js, /structuredEvidence: result\.structuredEvidence === true/);
  assert.match(js, /classicComparison: null/);
  assert.match(js, /comparedAt: null/);
});

test('v2 persisted Classic comparison keeps required rows beyond legacy cutoff', () => {
  const persistence = loadClassicComparisonPersistenceHarness();
  const {
    classicComparisonRequiredEvidence,
    classicComparisonRequiredRows,
  } = loadClassicComparisonHarness();
  const proof = {
    walletPublicKey: 'PersistWallet222222222222222222222222222222',
    token: {
      mint: 'PersistMint22222222222222222222222222222222',
      mintAuthorityRenounced: true,
      freezeAuthorityDisabled: true,
      metadataUpdateAuthorityRevoked: true,
      metadataImmutable: true,
    },
    liquidity: {
      poolIds: ['PersistPool22222222222222222222222222222222'],
      results: [{
        poolId: 'PersistPool22222222222222222222222222222222',
        quoteMint: 'PersistQuote222222222222222222222222222222',
        supplyPercent: 100,
        tickSpacing: 60,
        initialPrice: 1,
        createPoolTx: 'PersistCreateTx2222222222222222222222222222',
        positionCount: 1,
        lockedPositionCount: 1,
        feeKeyCount: 1,
        mainPositions: [{
          positionNftMint: 'PersistPositionNft222222222222222222222222',
          feeKeyNftMint: 'PersistFeeKey22222222222222222222222222222',
          recipient: 'PersistFeeRecipient222222222222222222222222',
          transferredTo: 'PersistFeeRecipient222222222222222222222222',
          sharePercent: 100,
          lowerMultiplier: 1,
          upperMultiplier: 2,
          txIds: {
            open: 'PersistOpenTx22222222222222222222222222222',
            lock: 'PersistLockTx22222222222222222222222222222',
            transfer: 'PersistFeeTransferTx222222222222222222222',
          },
          locked: true,
        }],
      }],
    },
    transfer: {
      destinationWallet: 'PersistDest222222222222222222222222222222',
      walletEmpty: true,
    },
    airdrop: {
      plannedRecipientCount: 1,
      deliveredCount: 1,
      failedCount: 0,
      recipients: [{ wallet: 'PersistAirdropWallet222222222222222222222', tokens: 10 }],
      transferred: [{ wallet: 'PersistAirdropWallet222222222222222222222', tokens: 10, txId: 'PersistAirdropTx222222222222222222222222' }],
      failed: [],
    },
  };
  const config = { poolTopology: {} };
  const requiredRows = classicComparisonRequiredRows(proof, config).map((row) => ({
    ...row,
    state: 'pass',
  }));
  const fillerRows = Array.from({ length: 24 }, (_, index) => ({
    id: `filler-${index}`,
    label: `Filler ${index}`,
    state: 'pass',
  }));
  const rows = [...fillerRows, ...requiredRows];
  const normalized = persistence.normalizeClassicReportComparison({
    input: JSON.stringify({ source: 'classic', rows: rows.length }),
    comparedAt: new Date().toISOString(),
    result: {
      status: 'pass',
      artifactKind: 'json',
      artifactSource: 'classic',
      structuredEvidence: true,
      proofFingerprint: 'persist-full-proof',
      passCount: rows.length,
      warnCount: 0,
      missingCount: 0,
      mismatchCount: 0,
      fieldCount: rows.length,
      rows,
    },
  });
  const evidence = classicComparisonRequiredEvidence(normalized.result, proof, config);

  assert.ok(requiredRows.length > 15);
  assert.ok(rows.findIndex((row) => row.id === 'mint') > 20);
  assert.ok(normalized.result.rows.length > 20);
  assert.equal(normalized.result.rows.find((row) => row.id === 'airdrop-transactions')?.state, 'pass');
  assert.equal(evidence.pass, true);
  assert.match(js, /CLASSIC_REPORT_COMPARISON_ROW_LIMIT = 80/);
  assert.match(js, /slice\(0, CLASSIC_REPORT_COMPARISON_ROW_LIMIT\)/);
  assert.doesNotMatch(js, /slice\(0, 20\)/);
});

test('v2 classic artifact comparison rejects v2 report envelopes as self-artifacts', () => {
  const { compareClassicReportArtifact } = loadClassicComparisonHarness();
  const proof = {
    walletPublicKey: 'SelfWallet111111111111111111111111111111111',
    token: {
      mint: 'SelfMint1111111111111111111111111111111111',
      mintAuthorityRenounced: true,
      freezeAuthorityDisabled: true,
    },
    liquidity: {
      poolIds: [],
      results: [],
    },
    transfer: {
      destinationWallet: 'SelfDest1111111111111111111111111111111111',
    },
    airdrop: {
      plannedRecipientCount: 0,
      deliveredCount: 0,
      failedCount: 0,
    },
  };
  const v2Envelope = {
    schema: 'trebuchet-launch-report',
    version: 1,
    launch: {
      dataVersion: 8,
      source: 'trebuchet-v2',
      mint: proof.token.mint,
      launchWallet: proof.walletPublicKey,
      transfer: proof.transfer,
      token: {
        mint: proof.token.mint,
        authorities: {
          mintAuthorityRenounced: true,
          freezeAuthorityDisabled: true,
        },
      },
      reportParityAudit: { status: 'pass' },
    },
  };

  const result = compareClassicReportArtifact(JSON.stringify(v2Envelope), proof, { poolTopology: {} });
  const sourceRow = result.rows.find((row) => row.id === 'artifact-source');

  assert.equal(result.status, 'mismatch');
  assert.equal(result.artifactSource, 'trebuchet-v2');
  assert.equal(sourceRow.state, 'mismatch');
  assert.match(sourceRow.detail, /completed Classic artifact/);

  const fieldOnlyEnvelope = {
    mint: proof.token.mint,
    launchWallet: proof.walletPublicKey,
    fieldVerification: {
      source: 'trebuchet-v2-field-verification',
      ready: true,
      proofFingerprint: 'self-proof',
    },
  };
  const fieldOnlyResult = compareClassicReportArtifact(JSON.stringify(fieldOnlyEnvelope), proof, { poolTopology: {} });
  assert.equal(fieldOnlyResult.artifactSource, 'trebuchet-v2');
  assert.equal(fieldOnlyResult.rows.find((row) => row.id === 'artifact-source')?.state, 'mismatch');

  const schemaOnlyEnvelope = {
    schema: 'trebuchet-v2-proof',
    proof: {
      token: { mint: proof.token.mint },
      walletPublicKey: proof.walletPublicKey,
    },
  };
  const schemaOnlyResult = compareClassicReportArtifact(JSON.stringify(schemaOnlyEnvelope), proof, { poolTopology: {} });
  assert.equal(schemaOnlyResult.artifactSource, 'trebuchet-v2');
  assert.equal(schemaOnlyResult.rows.find((row) => row.id === 'artifact-source')?.state, 'mismatch');

  const nestedMarkerEnvelope = {
    source: 'classic',
    launch: {
      mint: proof.token.mint,
      walletPublicKey: proof.walletPublicKey,
      transfer: proof.transfer,
      token: {
        authorities: {
          mintAuthorityRenounced: true,
          freezeAuthorityDisabled: true,
        },
      },
    },
    metadata: {
      exported: {
        reportParityAudit: { status: 'pass' },
      },
    },
  };
  const nestedMarkerResult = compareClassicReportArtifact(JSON.stringify(nestedMarkerEnvelope), proof, { poolTopology: {} });
  assert.equal(nestedMarkerResult.artifactSource, 'trebuchet-v2');
  assert.equal(nestedMarkerResult.rows.find((row) => row.id === 'artifact-source')?.state, 'mismatch');

  const fieldOnlyHtml = `
    <html><body>
      <h2>Field verification packet</h2>
      <p>Field parity packet complete.</p>
      <p>${proof.token.mint}</p>
      <p>${proof.walletPublicKey}</p>
    </body></html>
  `;
  const fieldOnlyHtmlResult = compareClassicReportArtifact(fieldOnlyHtml, proof, { poolTopology: {} });
  assert.equal(fieldOnlyHtmlResult.artifactSource, 'trebuchet-v2');
  assert.equal(fieldOnlyHtmlResult.rows.find((row) => row.id === 'artifact-source')?.state, 'mismatch');

  const scriptMarkerHtml = `
    <html><body>
      <script id="trebuchet-v2-proof" type="application/json">{}</script>
      <p>${proof.token.mint}</p>
      <p>${proof.walletPublicKey}</p>
    </body></html>
  `;
  const scriptMarkerResult = compareClassicReportArtifact(scriptMarkerHtml, proof, { poolTopology: {} });
  assert.equal(scriptMarkerResult.artifactSource, 'trebuchet-v2');
  assert.equal(scriptMarkerResult.rows.find((row) => row.id === 'artifact-source')?.state, 'mismatch');
  assert.match(js, /function classicArtifactHasV2Marker/);
  assert.match(js, /classicArtifactHasV2Marker\(parsed\)/);
  assert.match(js, /Object\.values\(value\)\.some/);
  assert.match(js, /value\.fieldVerification/);
  assert.match(js, /value\.reportParityAudit/);
  assert.match(js, /schema === 'trebuchet-v2-proof'/);
  assert.match(js, /trebuchet-v2-field-verification/);
  assert.match(js, /trebuchet-v2-proof/);
  assert.match(js, /field verification packet/);
});

test('v2 app boots through the local API client when available', () => {
  assert.match(apiClientJs, /\/api\/session/);
  assert.match(apiClientJs, /x-trebuchet-session/);
  assert.match(apiClientJs, /\/api\/user-prefs/);
  assert.match(apiClientJs, /\/api\/app-version/);
  assert.match(apiClientJs, /\/api\/check-for-updates/);
  assert.match(apiClientJs, /\/api\/demo\/status/);
  assert.match(apiClientJs, /\/api\/rpc-config/);
  assert.match(apiClientJs, /\/api\/rpc-health/);
  assert.match(apiClientJs, /\/api\/launch-journals/);
  assert.match(apiClientJs, /\/api\/lp-progress/);
  assert.match(apiClientJs, /\/api\/airdrop-progress/);
  assert.match(apiClientJs, /\/api\/server-logs/);
  assert.match(apiClientJs, /\/api\/pending-wallets/);
  assert.match(apiClientJs, /\/api\/wallet-qr/);
  assert.match(apiClientJs, /\/api\/secret-pin/);
  assert.match(apiClientJs, /\/change/);
  assert.match(apiClientJs, /\/reset/);
  assert.match(apiClientJs, /\/api\/vanity-ca-candidates/);
  assert.match(apiClientJs, /vanityAvailabilityKnown/);
  assert.match(apiClientJs, /\/api\/estimate-lp-funding/);
  assert.match(apiClientJs, /\/api\/acquire-quote-tokens/);
  assert.match(apiClientJs, /\/api\/find-funder/);
  assert.match(apiClientJs, /\/api\/v2\/launch-plan/);
  assert.match(apiClientJs, /\/api\/v2\/execution-readiness/);
  assert.match(apiClientJs, /\/api\/v2\/demo-launch\/run/);
  assert.match(apiClientJs, /\/api\/v2\/wallets/);
  assert.match(apiClientJs, /\/api\/v2\/run-envelope\/arm/);
  assert.match(apiClientJs, /\/api\/publish-launch-report/);
  assert.match(apiClientJs, /\/api\/run-airdrop/);
  assert.match(apiClientJs, /\/api\/retry-airdrop/);
  assert.match(apiClientJs, /\/api\/transfer-assets/);
  assert.match(apiClientJs, /stageLaunchPlan/);
  assert.match(apiClientJs, /checkExecutionReadiness/);
  assert.match(apiClientJs, /selectRpc/);
  assert.match(apiClientJs, /addRpc/);
  assert.match(apiClientJs, /removeRpc/);
  assert.match(apiClientJs, /testRpc/);
  assert.match(apiClientJs, /runDemoLaunch/);
  assert.match(apiClientJs, /listLaunchJournals/);
  assert.match(apiClientJs, /resumeLaunchJournal/);
  assert.match(apiClientJs, /dismissLaunchJournal/);
  assert.match(apiClientJs, /getLpProgress/);
  assert.match(apiClientJs, /getAirdropProgress/);
  assert.match(apiClientJs, /getServerLogs/);
  assert.match(apiClientJs, /generateManagedWallet/);
  assert.match(apiClientJs, /importManagedWallet/);
  assert.match(apiClientJs, /resetSecretPin/);
  assert.match(apiClientJs, /publishLaunchReport/);
  assert.match(apiClientJs, /runAirdrop/);
  assert.match(apiClientJs, /retryAirdrop/);
  assert.match(apiClientJs, /sweepPendingWallet/);
  assert.match(apiClientJs, /cancelLaunchRefund/);
  assert.match(apiClientJs, /getWalletQr/);
  assert.match(apiClientJs, /revealPendingWallet/);
  assert.match(apiClientJs, /dismissPendingWallet/);
  assert.match(apiClientJs, /getSecretPinStatus/);
  assert.match(apiClientJs, /setupSecretPin/);
  assert.match(apiClientJs, /unlockSecretPin/);
  assert.match(apiClientJs, /changeSecretPin/);
  assert.match(apiClientJs, /lockSecretPin/);
  assert.match(apiClientJs, /armRunEnvelope/);
  assert.match(apiClientJs, /executeNextRunOperation/);
  assert.match(apiClientJs, /listVanityCandidates/);
  assert.match(apiClientJs, /estimateClassicFunding/);
  assert.match(apiClientJs, /acquireQuoteTokens/);
  assert.match(apiClientJs, /findFundingWallet/);
  assert.match(apiClientJs, /getAcquireQuoteTokens/);
  assert.match(apiClientJs, /cancelAcquireQuoteTokens/);
  assert.match(apiClientJs, /cancelVanityGrind/);
  assert.match(apiClientJs, /diagnoseLaunch/);
  assert.match(apiClientJs, /checkForUpdates/);
  assert.match(apiClientJs, /setUserPrefs/);
  assert.match(js, /Release state/);
  assert.match(js, /renderReleasePanel/);
  assert.match(js, /releaseTrustSummary/);
  assert.match(js, /release-trust-line/);
  assert.match(js, /Unsigned test artifact/);
  assert.match(apiClientJs, /normalizeReleaseTrust/);
  assert.match(apiClientJs, /releaseTrust: normalizeReleaseTrust\(appVersion\.releaseTrust\)/);
  assert.match(js, /window\.__showUpdateResult = applyUpdateResult/);
  assert.match(js, /data-action="check-updates"/);
  assert.match(js, /data-action="toggle-update-autocheck"/);
  assert.match(js, /data-action="open-release-page"/);
  assert.match(js, /TrebuchetV2Api/);
  assert.match(js, /bootLocalApi/);
  assert.match(js, /applyBootState/);
  assert.match(js, /currentLaunchConfig/);
  assert.match(js, /fallbackLaunchPlan/);
});

test('v2 persists report publishing preference through classic user prefs', () => {
  assert.match(js, /async function toggleReportPublishingPref\(\)/);
  assert.match(js, /setUserPrefs\(\{ publishLaunchReport: next \}\)/);
  assert.match(js, /toggleReportPublishingPref\(\)\.catch/);
  assert.doesNotMatch(
    js,
    /if \(action === 'toggle-report-publish'\) \{\s*state\.prefs\.publishLaunchReport = state\.prefs\.publishLaunchReport === false;/,
  );
});

test('v2 API client bootstraps local session and read-only app state', async () => {
  const calls = [];
  const responses = {
    '/api/session': { success: true, token: 'v2-token' },
    '/api/app-version': {
      success: true,
      version: '1.0.0',
      releaseUrl: 'https://github.com/AnOversizedMooseWithSocks/Trebuchet/releases',
      checkForUpdatesOnStartup: false,
      releaseTrust: {
        status: 'unsigned-test-artifact',
        label: 'Unsigned test artifact',
        signingStatus: 'unsigned',
        notarizationStatus: 'not-notarized',
        platform: 'darwin',
        detail: 'Current macOS release downloads are unsigned and not notarized.',
      },
    },
    '/api/user-prefs': {
      success: true,
      prefs: { demoMode: true, publishLaunchReport: false, checkForUpdatesOnStartup: false },
    },
    '/api/demo/status': { success: true, active: true, vanity: { available: true, reason: null } },
    '/api/rpc-config': {
      success: true,
      config: {
        active: 'https://rpc.example.test',
        saved: [{ name: 'Dedicated RPC', url: 'https://rpc.example.test' }],
      },
    },
    '/api/rpc-health': { success: true, health: 'good', latencyMs: 42 },
    '/api/launch-journals?includeCompleted=1': {
      success: true,
      journals: [
        {
          id: 'journal-1',
          walletPublicKey: '11112222333344445555666677778888',
          status: 'active',
          stage: 'lp_create_started',
          updatedAt: '2026-06-20T12:00:00.000Z',
        },
      ],
    },
    '/api/pending-wallets': {
      success: true,
      wallets: [{ publicKey: '99998888777766665555444433332222', hasSecretKey: true }],
    },
    '/api/secret-pin/status': {
      success: true,
      status: {
        configured: true,
        unlocked: true,
        locked: false,
        version: 2,
        kdf: 'scrypt',
        deviceSecretProtected: true,
        deviceSecretAvailable: true,
      },
    },
    '/api/vanity-ca-candidates': {
      success: true,
      candidates: [{ publicKey: 'Vanity11112222333344445555666677778888', target: 'MKT...K1T' }],
    },
    '/api/v2/wallets': {
      success: true,
      wallets: [
        {
          publicKey: 'managed11112222333344445555666677778888',
          hasSecretKey: true,
          label: 'Launch wallet',
        },
      ],
    },
    '/api/clmm-fee-tiers': {
      success: true,
      tiers: [{ index: 3, tradeFeeRate: 10000, tickSpacing: 120 }],
    },
    '/api/v2/viewport-smoke-proof': {
      success: true,
      proof: {
        artifactVersion: 1,
        kind: 'trebuchet-v2-viewport-smoke',
        passed: true,
        state: 'valid',
        detail: 'Viewport smoke passed for desktop, mobile.',
        generatedAt: '2026-06-30T00:00:00.000Z',
        command: 'npm run test:v2:viewport',
        requiredChecks: [
          'launchVisible',
          'horizontalOverflow',
          'tokenomicsChart',
          'liquidityChart',
          'fundingMeter',
          'parityPanel',
          'firstViewportFit',
        ],
        expectedRequiredChecks: [
          'launchVisible',
          'horizontalOverflow',
          'tokenomicsChart',
          'liquidityChart',
          'fundingMeter',
          'parityPanel',
          'firstViewportFit',
        ],
        viewports: [
          {
            name: 'desktop',
            width: 1440,
            height: 900,
            passed: true,
            checks: {
              launchVisible: true,
              horizontalOverflow: true,
              tokenomicsChart: true,
              liquidityChart: true,
              fundingMeter: true,
              parityPanel: true,
              firstViewportFit: true,
            },
          },
          {
            name: 'mobile',
            width: 390,
            height: 844,
            passed: true,
            checks: {
              launchVisible: true,
              horizontalOverflow: true,
              tokenomicsChart: true,
              liquidityChart: true,
              fundingMeter: true,
              parityPanel: true,
              firstViewportFit: true,
            },
          },
        ],
        assetHashes: {
          'index.html': 'a'.repeat(64),
          'styles.css': 'b'.repeat(64),
          'api-client.js': 'c'.repeat(64),
          'app.js': 'd'.repeat(64),
        },
      },
    },
  };
  const api = loadApiClient();
  const client = api.createV2ApiClient({
    locationLike: { protocol: 'http:' },
    timeoutMs: 0,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url, init });
      assert.ok(responses[url], `unexpected fetch to ${url}`);
      return jsonResponse(responses[url]);
    },
  });

  const boot = await client.bootstrap();
  assert.equal(boot.api.status, 'connected');
  assert.equal(boot.api.tokenPresent, true);
  assert.equal(boot.app.version, '1.0.0');
  assert.equal(boot.app.checkForUpdatesOnStartup, false);
  assert.equal(boot.app.releaseTrust.status, 'unsigned-test-artifact');
  assert.equal(boot.app.releaseTrust.signingStatus, 'unsigned');
  assert.equal(boot.app.releaseTrust.notarizationStatus, 'not-notarized');
  assert.match(boot.app.releaseTrust.detail, /unsigned and not notarized/);
  assert.equal(boot.demo.active, true);
  assert.equal(boot.prefs.publishLaunchReport, false);
  assert.equal(boot.rpc.label, 'Dedicated RPC');
  assert.equal(boot.rpc.saved[0].url, 'https://rpc.example.test');
  assert.equal(boot.rpc.healthLabel, 'healthy 42ms');
  assert.equal(boot.recovery.activeJournalCount, 1);
  assert.equal(boot.recovery.pendingWalletCount, 1);
  assert.equal(boot.secretPin.configured, true);
  assert.equal(boot.secretPin.unlocked, true);
  assert.equal(boot.secretPin.kdf, 'scrypt');
  assert.equal(boot.secretPin.deviceSecretProtected, true);
  assert.equal(boot.wallets.managedCount, 1);
  assert.equal(boot.wallets.managed[0].publicKey, 'managed11112222333344445555666677778888');
  assert.equal(boot.vanity.candidateCount, 1);
  assert.equal(boot.vanity.candidates[0].publicKey, 'Vanity11112222333344445555666677778888');
  assert.equal(boot.feeTiers.available, true);
  assert.equal(boot.feeTiers.tiers[0].tickSpacing, 120);
  assert.equal(boot.viewportSmoke.passed, true);
  assert.equal(boot.viewportSmoke.artifactVersion, 1);
  assert.equal(boot.viewportSmoke.kind, 'trebuchet-v2-viewport-smoke');
  assert.equal(boot.viewportSmoke.viewports.length, 2);
  assert.equal(boot.viewportSmoke.command, 'npm run test:v2:viewport');
  assert.deepEqual(boot.viewportSmoke.requiredChecks, [
    'launchVisible',
    'horizontalOverflow',
    'tokenomicsChart',
    'liquidityChart',
    'fundingMeter',
    'parityPanel',
    'firstViewportFit',
  ]);
  assert.deepEqual(boot.viewportSmoke.expectedRequiredChecks, boot.viewportSmoke.requiredChecks);
  assert.equal(boot.viewportSmoke.viewports[0].checks.fundingMeter, true);
  assert.equal(boot.viewportSmoke.assetHashes['app.js'], 'd'.repeat(64));
  assert.match(apiClientJs, /artifactVersion: proof\.artifactVersion \?\? null/);
  assert.match(apiClientJs, /kind: proof\.kind \|\| null/);
  assert.match(apiClientJs, /requiredChecks: safeArray\(proof\.requiredChecks\)/);
  assert.match(apiClientJs, /expectedRequiredChecks: safeArray\(proof\.expectedRequiredChecks\)/);
  assert.match(js, /proof\.artifactVersion !== 1 \|\| proof\.kind !== 'trebuchet-v2-viewport-smoke'/);

  assert.equal(calls.filter((call) => call.url === '/api/session').length, 1);
  for (const call of calls.filter((item) => item.url !== '/api/session')) {
    assert.equal(call.init.headers['x-trebuchet-session'], 'v2-token');
  }
});

test('v2 API client falls back cleanly for file previews', async () => {
  let called = false;
  const api = loadApiClient();
  const client = api.createV2ApiClient({
    locationLike: { protocol: 'file:' },
    fetchImpl: async () => {
      called = true;
      return jsonResponse({});
    },
  });

  const boot = await client.bootstrap();
  assert.equal(called, false);
  assert.equal(boot.api.available, false);
  assert.equal(boot.api.status, 'static');
  assert.match(boot.api.detail, /Static file preview/);
});

test('v2 static previews do not manufacture launch wallet placeholders', () => {
  assert.doesNotMatch(js, /StaticWallet/);
  assert.doesNotMatch(js, /Static wallet placeholder added/);
  assert.match(js, /Launch wallet generation requires the local Trebuchet app/);
});

test('v2 API client treats missing /api/session as static HTTP preview', async () => {
  const api = loadApiClient();
  const client = api.createV2ApiClient({
    locationLike: { protocol: 'http:' },
    timeoutMs: 0,
    fetchImpl: async () => jsonResponse({ success: false, error: 'not found' }, 404),
  });

  const boot = await client.bootstrap();
  assert.equal(boot.api.available, false);
  assert.equal(boot.api.status, 'static');
  assert.match(boot.api.detail, /Static preview/);
});

test('v2 API client stages launch plans through the authenticated local API', async () => {
  const calls = [];
  const api = loadApiClient();
  const client = api.createV2ApiClient({
    locationLike: { protocol: 'http:' },
    timeoutMs: 0,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url, init });
      if (url === '/api/session') return jsonResponse({ success: true, token: 'stage-token' });
      if (url === '/api/v2/launch-plan') {
        assert.equal(init.method, 'POST');
        assert.equal(init.headers['x-trebuchet-session'], 'stage-token');
        assert.match(init.body, /MoonKit/);
        assert.match(init.body, /StageWallet111111111111111111111111111111/);
        return jsonResponse({
          success: true,
          plan: {
            contractVersion: 1,
            source: 'local-api',
            v2LaunchConfigFingerprint: 'server-config-fingerprint',
            v2LaunchWalletFingerprint: 'StageWallet111111111111111111111111111111',
            operations: [{ id: 'v2-config-preflight', label: 'Validate', effects: [] }],
          },
        });
      }
      throw new Error(`unexpected fetch to ${url}`);
    },
  });

  const plan = await client.stageLaunchPlan({
    token: { name: 'MoonKit', symbol: 'MKT', supply: '1000000000' },
    launchSol: 3.5,
    mode: 'guarded',
    walletPublicKey: 'StageWallet111111111111111111111111111111',
  });

  assert.equal(plan.source, 'local-api');
  assert.equal(plan.v2LaunchWalletFingerprint, 'StageWallet111111111111111111111111111111');
  assert.equal(calls.filter((call) => call.url === '/api/session').length, 1);
  assert.equal(calls.filter((call) => call.url === '/api/v2/launch-plan').length, 1);
});

test('v2 API client inspects discovery mints through the authenticated local API', async () => {
  const calls = [];
  const api = loadApiClient();
  const mint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const client = api.createV2ApiClient({
    locationLike: { protocol: 'http:' },
    timeoutMs: 0,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url, init });
      if (url === '/api/session') return jsonResponse({ success: true, token: 'discovery-token' });
      if (url === '/api/v2/discovery/inspect') {
        assert.equal(init.method, 'POST');
        assert.equal(init.headers['x-trebuchet-session'], 'discovery-token');
        assert.deepEqual(JSON.parse(init.body), { mint });
        return jsonResponse({
          success: true,
          record: { id: mint, mint, name: 'USD Coin', symbol: 'USDC', score: 96 },
        });
      }
      throw new Error(`unexpected fetch to ${url}`);
    },
  });

  const record = await client.inspectDiscoveryToken(mint);
  assert.equal(record.symbol, 'USDC');
  assert.equal(calls.filter((call) => call.url === '/api/v2/discovery/inspect').length, 1);
});

test('v2 API client manages Trebuchet local wallets and run envelopes', async () => {
  const calls = [];
  const api = loadApiClient();
  const client = api.createV2ApiClient({
    locationLike: { protocol: 'http:' },
    timeoutMs: 0,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url, init });
      if (url === '/api/session') return jsonResponse({ success: true, token: 'wallet-token' });
      if (url === '/api/v2/wallets') {
        assert.equal(init.headers['x-trebuchet-session'], 'wallet-token');
        return jsonResponse({
          success: true,
          wallets: [{ publicKey: 'Wallet111', hasSecretKey: true, label: 'Launch wallet' }],
        });
      }
      if (url === '/api/v2/wallets/generate') {
        assert.equal(init.method, 'POST');
        assert.equal(init.headers['x-trebuchet-session'], 'wallet-token');
        return jsonResponse({
          success: true,
          wallet: { publicKey: 'Generated111', hasSecretKey: true, label: 'Launch wallet' },
        });
      }
      if (url === '/api/v2/wallets/import') {
        assert.equal(init.method, 'POST');
        assert.equal(init.headers['x-trebuchet-session'], 'wallet-token');
        assert.match(init.body, /seed words/);
        return jsonResponse({
          success: true,
          wallet: { publicKey: 'Imported111', hasSecretKey: true, source: 'imported-local' },
        });
      }
      if (url === '/api/wallet-qr?publicKey=Generated111') {
        assert.equal(init.headers['x-trebuchet-session'], 'wallet-token');
        return jsonResponse({
          success: true,
          publicKey: 'Generated111',
          qrCode: 'data:image/png;base64,qr',
        });
      }
      if (url === '/api/pending-wallets/reveal') {
        assert.equal(init.method, 'POST');
        assert.equal(init.headers['x-trebuchet-session'], 'wallet-token');
        assert.match(init.body, /Generated111/);
        return jsonResponse({
          success: true,
          wallet: { publicKey: 'Generated111', secretKeyB58: 'secret-b58', mnemonic: 'seed words' },
        });
      }
      if (url === '/api/pending-wallets/dismiss') {
        assert.equal(init.method, 'POST');
        assert.equal(init.headers['x-trebuchet-session'], 'wallet-token');
        assert.match(init.body, /Generated111/);
        return jsonResponse({ success: true });
      }
      if (url === '/api/transfer-assets') {
        assert.equal(init.method, 'POST');
        assert.equal(init.headers['x-trebuchet-session'], 'wallet-token');
        assert.match(init.body, /Generated111/);
        assert.match(init.body, /Sweep111/);
        return jsonResponse({
          success: true,
          destinationWallet: 'Sweep111',
          tokensTransferred: 2,
          solTransferred: 0.25,
          nftSweep: { transferred: [], errors: [] },
          tokenSweep: { transferred: [{ mint: 'Mint111' }, { mint: 'Quote111' }], errors: [] },
        });
      }
      if (url === '/api/secret-pin/status') {
        assert.equal(init.headers['x-trebuchet-session'], 'wallet-token');
        return jsonResponse({
          success: true,
          status: { configured: false, unlocked: false, locked: false },
        });
      }
      if (url === '/api/secret-pin/setup') {
        assert.equal(init.method, 'POST');
        assert.equal(init.headers['x-trebuchet-session'], 'wallet-token');
        assert.match(init.body, /1234/);
        return jsonResponse({
          success: true,
          status: { configured: true, unlocked: true, locked: false, kdf: 'scrypt' },
        });
      }
      if (url === '/api/secret-pin/unlock') {
        assert.equal(init.method, 'POST');
        assert.equal(init.headers['x-trebuchet-session'], 'wallet-token');
        assert.match(init.body, /1234/);
        return jsonResponse({
          success: true,
          status: { configured: true, unlocked: true, locked: false, kdf: 'scrypt' },
        });
      }
      if (url === '/api/secret-pin/change') {
        assert.equal(init.method, 'POST');
        assert.equal(init.headers['x-trebuchet-session'], 'wallet-token');
        assert.match(init.body, /1234/);
        assert.match(init.body, /5678/);
        return jsonResponse({
          success: true,
          status: { configured: true, unlocked: true, locked: false, kdf: 'scrypt' },
        });
      }
      if (url === '/api/secret-pin/lock') {
        assert.equal(init.method, 'POST');
        assert.equal(init.headers['x-trebuchet-session'], 'wallet-token');
        return jsonResponse({
          success: true,
          status: { configured: true, unlocked: false, locked: true, kdf: 'scrypt' },
        });
      }
      if (url === '/api/secret-pin/reset') {
        assert.equal(init.method, 'POST');
        assert.equal(init.headers['x-trebuchet-session'], 'wallet-token');
        assert.match(init.body, /RESET RECOVERY PIN/);
        return jsonResponse({
          success: true,
          status: { configured: false, unlocked: false, locked: false },
          removed: { pendingWallets: 2, vanityCAs: 3 },
        });
      }
      if (url === '/api/v2/execution-readiness') {
        assert.equal(init.method, 'POST');
        assert.equal(init.headers['x-trebuchet-session'], 'wallet-token');
        assert.match(init.body, /Generated111/);
        assert.match(init.body, /totalSol/);
        return jsonResponse({
          success: true,
          readiness: {
            status: 'ready',
            nextEndpoint: '/api/create-token',
            blockers: [],
            proof: { token: { mint: 'Mint111' }, liquidity: { poolCount: 0, results: [] } },
          },
        });
      }
      if (url === '/api/v2/demo-launch/run') {
        assert.equal(init.method, 'POST');
        assert.equal(init.headers['x-trebuchet-session'], 'wallet-token');
        assert.match(init.body, /Generated111/);
        return jsonResponse({
          success: true,
          run: {
            id: 'demo-v2-1',
            runtime: 'demo',
            token: { tokenMint: 'Mint111', symbol: 'MKT' },
            liquidity: { results: [{ poolId: 'Pool111' }] },
            transfer: { destinationWallet: 'Sweep111' },
          },
        });
      }
      if (url === '/api/v2/run-envelope/arm') {
        assert.equal(init.method, 'POST');
        assert.equal(init.headers['x-trebuchet-session'], 'wallet-token');
        assert.match(init.body, /Generated111/);
        return jsonResponse({
          success: true,
          envelope: { id: 'run-1', status: 'armed', walletPublicKey: 'Generated111' },
        });
      }
      if (url === '/api/v2/run-envelope/execute-next') {
        assert.equal(init.method, 'POST');
        assert.equal(init.headers['x-trebuchet-session'], 'wallet-token');
        assert.match(init.body, /Generated111/);
        assert.match(init.body, /\/api\/create-token/);
        assert.match(init.body, /trebuchet-mkt-dossier\.html/);
        return jsonResponse({
          success: true,
          executed: {
            endpoint: '/api/create-token',
            action: 'Create token',
            result: { tokenMint: 'Mint111', symbol: 'MKT' },
            observedWalletDelta: {
              beforeSol: 5,
              afterSol: 4.98,
              deltaSol: -0.02,
              outflowSol: 0.02,
            },
          },
          readiness: {
            status: 'ready',
            nextEndpoint: '/api/create-lp',
            blockers: [],
            proof: { token: { mint: 'Mint111' }, liquidity: { poolCount: 1, poolIds: ['Pool111'], results: [{ poolId: 'Pool111' }] } },
          },
          proof: { token: { mint: 'Mint111' }, liquidity: { poolCount: 1, poolIds: ['Pool111'], results: [{ poolId: 'Pool111' }] } },
        });
      }
      throw new Error(`unexpected fetch to ${url}`);
    },
  });

  const wallets = await client.listManagedWallets();
  const generated = await client.generateManagedWallet();
  const imported = await client.importManagedWallet('seed words');
  const qr = await client.getWalletQr(generated.publicKey);
  const revealed = await client.revealPendingWallet(generated.publicKey);
  const dismissedWallet = await client.dismissPendingWallet(generated.publicKey);
  const sweptWallet = await client.sweepPendingWallet({
    walletPublicKey: generated.publicKey,
    destinationWallet: 'Sweep111',
  });
  const cancelledWallet = await client.cancelLaunchRefund({
    walletPublicKey: generated.publicKey,
    destinationWallet: 'Sweep111',
  });
  const pinStatus = await client.getSecretPinStatus();
  const pinSetup = await client.setupSecretPin('1234');
  const pinUnlock = await client.unlockSecretPin('1234');
  const pinChange = await client.changeSecretPin({ currentPin: '1234', newPin: '5678' });
  const pinLock = await client.lockSecretPin();
  const pinReset = await client.resetSecretPin('RESET RECOVERY PIN');
  const readiness = await client.checkExecutionReadiness({
    walletPublicKey: generated.publicKey,
    config: { token: { name: 'MoonKit', symbol: 'MKT', supply: '1000' } },
    fundingEstimate: { totalSol: 1.25 },
  });
  const demoRun = await client.runDemoLaunch({
    walletPublicKey: generated.publicKey,
    config: { token: { name: 'MoonKit', symbol: 'MKT', supply: '1000' } },
  });
  const envelope = await client.armRunEnvelope({
    walletPublicKey: generated.publicKey,
    config: { token: { name: 'MoonKit', symbol: 'MKT', supply: '1000' } },
  });
  const executed = await client.executeNextRunOperation({
    walletPublicKey: generated.publicKey,
    config: { token: { name: 'MoonKit', symbol: 'MKT', supply: '1000' } },
    confirmNextEndpoint: '/api/create-token',
    localDossier: {
      status: 'downloaded',
      kind: 'local-dossier-html',
      filename: 'trebuchet-mkt-dossier.html',
      downloadedAt: '2026-06-30T00:00:00.000Z',
      dataVersion: 13,
      proofFingerprint: 'fingerprint-1',
    },
  });

  assert.equal(wallets[0].publicKey, 'Wallet111');
  assert.equal(generated.publicKey, 'Generated111');
  assert.equal(imported.publicKey, 'Imported111');
  assert.equal(qr.qrCode, 'data:image/png;base64,qr');
  assert.equal(revealed.secretKeyB58, 'secret-b58');
  assert.equal(dismissedWallet.success, true);
  assert.equal(sweptWallet.tokensTransferred, 2);
  assert.equal(sweptWallet.destinationWallet, 'Sweep111');
  assert.equal(cancelledWallet.destinationWallet, 'Sweep111');
  assert.equal(pinStatus.configured, false);
  assert.equal(pinSetup.unlocked, true);
  assert.equal(pinUnlock.kdf, 'scrypt');
  assert.equal(pinChange.unlocked, true);
  assert.equal(pinLock.locked, true);
  assert.equal(pinReset.status.configured, false);
  assert.equal(pinReset.removed.vanityCAs, 3);
  assert.equal(readiness.nextEndpoint, '/api/create-token');
  assert.equal(demoRun.runtime, 'demo');
  assert.equal(demoRun.token.tokenMint, 'Mint111');
  assert.equal(envelope.status, 'armed');
  assert.equal(executed.executed.endpoint, '/api/create-token');
  assert.equal(executed.readiness.nextEndpoint, '/api/create-lp');
  assert.equal(executed.proof.liquidity.poolIds[0], 'Pool111');
  assert.equal(calls.filter((call) => call.url === '/api/session').length, 1);
});

test('v2 API client bridges classic vanity, funding, and diagnostics APIs', async () => {
  const calls = [];
  const api = loadApiClient();
  const client = api.createV2ApiClient({
    locationLike: { protocol: 'http:' },
    timeoutMs: 0,
    fetchImpl: async (url, init = {}) => {
      calls.push({ url, init });
      if (url === '/api/session') return jsonResponse({ success: true, token: 'classic-token' });
      if (url === '/api/vanity-ca-candidates') {
        assert.equal(init.headers['x-trebuchet-session'], 'classic-token');
        return jsonResponse({ success: true, candidates: [{ publicKey: 'Vanity111' }] });
      }
      if (url === '/api/vanity-ca-candidates/remove') {
        assert.equal(init.method, 'POST');
        assert.match(init.body, /Vanity111/);
        return jsonResponse({ success: true });
      }
      if (url === '/api/cancel-vanity-grind') {
        assert.equal(init.method, 'POST');
        return jsonResponse({ success: true, cancelled: true });
      }
      if (url === '/api/estimate-lp-funding') {
        assert.equal(init.method, 'POST');
        assert.match(init.body, /allocations/);
        return jsonResponse({
          success: true,
          estimate: {
            totalSol: 4.2,
            autoSwapPlan: [{ quoteMint: 'QuoteMint111', quoteSymbol: 'USDC', targetRaw: '1000' }],
            byQuote: { ManualMint111: 2500000 },
            quoteBreakdown: [{
              label: 'Pool 2 (MANUAL): bootstrap quote-side',
              symbol: 'MANUAL',
              amount: 2.5,
              mint: 'ManualMint111',
            }],
          },
        });
      }
      if (url === '/api/clmm-fee-tiers') {
        return jsonResponse({
          success: true,
          tiers: [
            { index: 2, tradeFeeRate: 100, tickSpacing: 1 },
            { index: 3, tradeFeeRate: 10000, tickSpacing: 120 },
          ],
        });
      }
      if (url === '/api/quote-token-info') {
        assert.equal(init.method, 'POST');
        assert.match(init.body, /QuoteMint111/);
        return jsonResponse({
          success: true,
          info: {
            address: 'QuoteMint111',
            symbol: 'QUOTE',
            decimals: 6,
            priceUsd: '0.25',
            compatible: true,
            raydiumTradeable: 'yes',
            freezeAuthorityBlock: false,
            mintAuthorityWarning: false,
          },
        });
      }
      if (url === '/api/acquire-quote-tokens') {
        assert.equal(init.method, 'POST');
        assert.match(init.body, /Wallet111/);
        assert.match(init.body, /QuoteMint111/);
        return jsonResponse({ jobId: 'job-1' });
      }
      if (url === '/api/acquire-quote-tokens/job-1') {
        if (init.method === 'DELETE') return jsonResponse({ deleted: true });
        return jsonResponse({
          jobId: 'job-1',
          status: 'done',
          total: 1,
          completed: 1,
          results: [{ quoteMint: 'QuoteMint111', quoteSymbol: 'USDC', success: true, txId: 'Tx111' }],
          pendingMints: [],
          inProgressMints: [],
          error: null,
        });
      }
      if (url === '/api/check-balance-detailed') {
        assert.equal(init.method, 'POST');
        assert.match(init.body, /Wallet111/);
        return jsonResponse({
          success: true,
          balance: {
            sol: 3.5,
            tokens: {
              ManualMint111: {
                amountRaw: '2500000',
                amountUi: 2.5,
                decimals: 6,
                programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
              },
            },
          },
        });
      }
      if (url === '/api/find-funder') {
        assert.equal(init.method, 'POST');
        assert.equal(init.headers['x-trebuchet-session'], 'classic-token');
        assert.match(init.body, /Wallet111/);
        return jsonResponse({
          success: true,
          result: { funder: 'Funder111', amount: 3.25 },
        });
      }
      if (url === '/api/launch-journals?includeCompleted=1') {
        assert.equal(init.headers['x-trebuchet-session'], 'classic-token');
        return jsonResponse({ success: true, journals: [{ id: 'journal-1', status: 'failed' }] });
      }
      if (url === '/api/launch-journals/resume') {
        assert.equal(init.method, 'POST');
        assert.match(init.body, /journal-1/);
        return jsonResponse({ success: true, results: [{ poolId: 'Pool111' }] });
      }
      if (url === '/api/launch-journals/dismiss') {
        assert.equal(init.method, 'POST');
        assert.match(init.body, /journal-1/);
        return jsonResponse({ success: true, archived: true });
      }
      if (url === '/api/lp-progress?wallet=Wallet111&since=0') {
        return jsonResponse({
          success: true,
          state: { status: 'running', totalEvents: 1, events: [{ stage: 'pool_create_done', allocationIndex: 0 }] },
        });
      }
      if (url === '/api/airdrop-progress?wallet=Wallet111') {
        return jsonResponse({
          success: true,
          state: { status: 'running', total: 3, completed: 1, failedCount: 0 },
        });
      }
      if (url === '/api/run-airdrop') {
        assert.equal(init.method, 'POST');
        assert.equal(init.headers['x-trebuchet-session'], 'classic-token');
        assert.match(init.body, /Wallet111/);
        assert.match(init.body, /Recipient111/);
        return jsonResponse({
          success: true,
          airdrop: {
            transferred: [{ wallet: 'Recipient111', tokens: 100 }],
            failed: [],
          },
        });
      }
      if (url === '/api/retry-airdrop') {
        assert.equal(init.method, 'POST');
        assert.equal(init.headers['x-trebuchet-session'], 'classic-token');
        assert.match(init.body, /Wallet111/);
        assert.match(init.body, /Recipient222/);
        return jsonResponse({
          success: true,
          airdrop: {
            transferred: [{ wallet: 'Recipient222', tokens: 50 }],
            failed: [],
          },
        });
      }
      if (url === '/api/publish-launch-report') {
        assert.equal(init.method, 'POST');
        assert.equal(init.headers['x-trebuchet-session'], 'classic-token');
        assert.match(init.body, /Mint111/);
        assert.match(init.body, /Pool111/);
        assert.match(init.body, /proof-111/);
        return jsonResponse({
          success: true,
          htmlUri: 'https://arweave.test/report-html',
          jsonUri: 'https://arweave.test/report-json',
          proofFingerprint: 'proof-111',
        });
      }
      if (url === '/api/server-logs?since=0&limit=10') {
        return jsonResponse({
          entries: [{ seq: 1, level: 'log', msg: '[demo] creating pool' }],
        });
      }
      if (url === '/api/check-for-updates') {
        assert.equal(init.method, 'POST');
        assert.equal(init.headers['x-trebuchet-session'], 'classic-token');
        return jsonResponse({ success: true, ran: true });
      }
      if (url === '/api/user-prefs') {
        assert.equal(init.method, 'POST');
        assert.equal(init.headers['x-trebuchet-session'], 'classic-token');
        assert.match(init.body, /checkForUpdatesOnStartup/);
        return jsonResponse({ success: true, prefs: { checkForUpdatesOnStartup: false } });
      }
      if (url === '/api/rpc-config/test') {
        assert.equal(init.method, 'POST');
        assert.equal(init.headers['x-trebuchet-session'], 'classic-token');
        assert.match(init.body, /https:\/\/rpc2.example.test/);
        return jsonResponse({ success: true, result: { ok: true, version: '2.2.0', latencyMs: 33 } });
      }
      if (url === '/api/rpc-config/add') {
        assert.equal(init.method, 'POST');
        assert.equal(init.headers['x-trebuchet-session'], 'classic-token');
        assert.match(init.body, /Backup RPC/);
        return jsonResponse({
          success: true,
          config: {
            active: 'https://rpc2.example.test',
            saved: [{ name: 'Backup RPC', url: 'https://rpc2.example.test' }],
          },
        });
      }
      if (url === '/api/rpc-config/select') {
        assert.equal(init.method, 'POST');
        assert.equal(init.headers['x-trebuchet-session'], 'classic-token');
        assert.match(init.body, /https:\/\/rpc2.example.test/);
        return jsonResponse({
          success: true,
          config: {
            active: 'https://rpc2.example.test',
            saved: [{ name: 'Backup RPC', url: 'https://rpc2.example.test' }],
          },
        });
      }
      if (url === '/api/rpc-config/remove') {
        assert.equal(init.method, 'POST');
        assert.equal(init.headers['x-trebuchet-session'], 'classic-token');
        assert.match(init.body, /https:\/\/rpc.example.test/);
        return jsonResponse({
          success: true,
          config: {
            active: 'https://rpc2.example.test',
            saved: [{ name: 'Backup RPC', url: 'https://rpc2.example.test' }],
          },
        });
      }
      if (url === '/api/diagnose-launch?tokenMint=Mint111') {
        return jsonResponse({ success: true, report: { tokenMint: 'Mint111', pools: [] } });
      }
      throw new Error(`unexpected fetch to ${url}`);
    },
  });

  const candidates = await client.listVanityCandidates();
  await client.removeVanityCandidate('Vanity111');
  await client.cancelVanityGrind();
  const estimate = await client.estimateClassicFunding({
    allocations: [{ quoteToken: 'SOL', supplyPercent: 70, distribution: [{ sharePercent: 100 }] }],
    targetMarketCapUsd: 250000,
    publishLaunchReport: true,
  });
  const feeTiers = await client.getClmmFeeTiers();
  const quoteInfo = await client.getQuoteTokenInfo('QuoteMint111');
  const acquire = await client.acquireQuoteTokens({
    walletPublicKey: 'Wallet111',
    autoSwapPlan: estimate.autoSwapPlan,
  });
  const acquireStatus = await client.getAcquireQuoteTokens(acquire.jobId);
  const acquireClear = await client.cancelAcquireQuoteTokens(acquire.jobId);
  const balance = await client.checkDetailedBalance('Wallet111');
  const funder = await client.findFundingWallet('Wallet111');
  const journals = await client.listLaunchJournals();
  const resume = await client.resumeLaunchJournal('journal-1');
  const dismiss = await client.dismissLaunchJournal('journal-1');
  const lpProgress = await client.getLpProgress({ walletPublicKey: 'Wallet111', since: 0 });
  const airdropProgress = await client.getAirdropProgress('Wallet111');
  const airdrop = await client.runAirdrop({
    walletPublicKey: 'Wallet111',
    tokenMint: 'Mint111',
    tokenDecimals: 9,
    recipients: [{ wallet: 'Recipient111', tokens: 100 }],
  });
  const airdropRetry = await client.retryAirdrop({
    walletPublicKey: 'Wallet111',
    tokenMint: 'Mint111',
    tokenDecimals: 9,
    recipients: [{ wallet: 'Recipient222', tokens: 50 }],
  });
  const publish = await client.publishLaunchReport({
    walletPublicKey: 'Wallet111',
    mint: 'Mint111',
    poolIds: ['Pool111'],
    reportHtml: '<!doctype html><html></html>',
    launchData: { mint: 'Mint111', proofFingerprint: 'proof-111' },
    proofFingerprint: 'proof-111',
  });
  const serverLogs = await client.getServerLogs({ since: 0, limit: 10 });
  const updateCheck = await client.checkForUpdates();
  const prefs = await client.setUserPrefs({ checkForUpdatesOnStartup: false });
  const rpcTest = await client.testRpc('https://rpc2.example.test');
  const rpcAdded = await client.addRpc({ name: 'Backup RPC', url: 'https://rpc2.example.test', setActive: true });
  const rpcSelected = await client.selectRpc('https://rpc2.example.test');
  const rpcRemoved = await client.removeRpc('https://rpc.example.test');
  const report = await client.diagnoseLaunch('Mint111');

  assert.equal(candidates[0].publicKey, 'Vanity111');
  assert.equal(estimate.totalSol, 4.2);
  assert.equal(estimate.byQuote.ManualMint111, 2500000);
  assert.equal(estimate.quoteBreakdown[0].symbol, 'MANUAL');
  assert.equal(feeTiers[0].index, 2);
  assert.equal(feeTiers[1].tickSpacing, 120);
  assert.equal(quoteInfo.address, 'QuoteMint111');
  assert.equal(quoteInfo.raydiumTradeable, 'yes');
  assert.equal(quoteInfo.freezeAuthorityBlock, false);
  assert.equal(acquire.jobId, 'job-1');
  assert.equal(acquireStatus.results[0].txId, 'Tx111');
  assert.equal(acquireClear.deleted, true);
  assert.equal(balance.tokens.ManualMint111.amountRaw, '2500000');
  assert.equal(funder.funder, 'Funder111');
  assert.equal(funder.amount, 3.25);
  assert.equal(journals[0].id, 'journal-1');
  assert.equal(resume.results[0].poolId, 'Pool111');
  assert.equal(dismiss.archived, true);
  assert.equal(lpProgress.events[0].stage, 'pool_create_done');
  assert.equal(airdropProgress.completed, 1);
  assert.equal(airdrop.transferred[0].wallet, 'Recipient111');
  assert.equal(airdropRetry.transferred[0].wallet, 'Recipient222');
  assert.equal(publish.jsonUri, 'https://arweave.test/report-json');
  assert.equal(publish.proofFingerprint, 'proof-111');
  assert.equal(serverLogs[0].seq, 1);
  assert.equal(updateCheck.ran, true);
  assert.equal(prefs.checkForUpdatesOnStartup, false);
  assert.equal(rpcTest.ok, true);
  assert.equal(rpcAdded.active, 'https://rpc2.example.test');
  assert.equal(rpcSelected.active, 'https://rpc2.example.test');
  assert.equal(rpcRemoved.saved[0].name, 'Backup RPC');
  assert.equal(report.tokenMint, 'Mint111');
  assert.equal(calls.filter((call) => call.url === '/api/session').length, 1);
});
