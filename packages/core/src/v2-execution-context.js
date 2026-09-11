// V2 execution context contract for Trebuchet Core.
//
// This is the idempotency heart of a launch: given a launch journal (the
// checkpoint trail written after each irreversible phase) and the client
// request body, buildV2ExecutionContext folds them into the execution
// context that decides what a resume must do and what it must NOT redo:
//
//   - tokenCreated / tokenNeedsFinish / metadataRevealPending
//   - priorResults: reconstructed pool results (structured results merged
//     with position-NFT evidence recovered from the raw event log)
//   - resume / failedLaunch / liquidityComplete / transferComplete
//
// Everything here is pure: no I/O, no chain, no custody. The app supplies
// the journal it looked up; a headless runner supplies the same journal
// from the Core launch-journal store. Both get byte-identical decisions.
//
// Extracted from server.js so the sealed runner and CLI can resume with
// the exact same idempotency contract the desktop app uses.

import { tokenCreationComplete } from './launch-journal.js';

export const V2_LP_RECOVERABLE_STAGES = new Set([
  'lp_created',
  'transfer_started',
  'transfer_partial',
  'transfer_failed',
]);

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

export function journalResultList(journal) {
  const lp = journal?.lp || {};
  const source = Array.isArray(lp.partialResults) && lp.partialResults.length > 0
    ? lp.partialResults
    : (Array.isArray(lp.results) ? lp.results : []);
  return cloneJson(source);
}

function upsertJournalResult(results, nextResult) {
  const idx = results.findIndex((r) => r.allocationIndex === nextResult.allocationIndex);
  if (idx >= 0) {
    results[idx] = { ...results[idx], ...nextResult };
  } else {
    results.push(nextResult);
  }
  results.sort((a, b) => (a.allocationIndex ?? 0) - (b.allocationIndex ?? 0));
}

function resultForEvent(results, event) {
  return results.find((r) => r.allocationIndex === event.allocationIndex);
}

function normalizeJournalDistribution(allocation) {
  return Array.isArray(allocation?.distribution) && allocation.distribution.length > 0
    ? allocation.distribution
    : [{ sharePercent: 100, recipient: null }];
}

function journalAllocationForEvent(journal, event) {
  const index = Number(event?.allocationIndex);
  const allocations = journal?.poolPlan?.allocations;
  return Number.isInteger(index) && Array.isArray(allocations) ? allocations[index] : null;
}

function journalResultSkeleton(journal, event) {
  const allocationIndex = Number(event?.allocationIndex);
  if (!Number.isInteger(allocationIndex) || !event?.poolId) return null;
  const allocation = journalAllocationForEvent(journal, event) || {};
  return {
    allocationIndex,
    quoteSymbol: allocation.quoteSymbolOverride || allocation.quoteSymbol || allocation.quoteToken || null,
    quoteAddress: allocation.quoteMint || allocation.quoteToken || null,
    supplyPercent: allocation.supplyPercent ?? null,
    poolId: event.poolId,
    mainPositions: [],
    ladderPositions: [],
    supportPositions: [],
    bootstrap: null,
    txIds: { createPool: event.txId || null },
    phase1Complete: false,
  };
}

function ensureResultForEvent(results, event, journal) {
  let result = resultForEvent(results, event);
  if (result || !event?.poolId) return result;
  result = journalResultSkeleton(journal, event);
  if (!result) return null;
  upsertJournalResult(results, result);
  return resultForEvent(results, event);
}

function upsertIndexedPosition(list, indexKey, index, position) {
  if (!Number.isInteger(index) || !position?.nftMint) return false;
  const existingIndex = list.findIndex((item) => Number(item?.[indexKey]) === index);
  if (existingIndex >= 0) {
    list[existingIndex] = { ...list[existingIndex], ...position };
  } else {
    list.push(position);
  }
  list.sort((a, b) => Number(a?.[indexKey] ?? 0) - Number(b?.[indexKey] ?? 0));
  return true;
}

function positionForIndex(list, indexKey, index) {
  if (!Array.isArray(list)) return null;
  const numericIndex = Number(index);
  return list.find((item) => Number(item?.[indexKey]) === numericIndex) || list[numericIndex] || null;
}

export function hasOpenedPhase1Position(result) {
  return [
    ...(Array.isArray(result?.mainPositions) ? result.mainPositions : []),
    ...(Array.isArray(result?.ladderPositions) ? result.ladderPositions : []),
    ...(Array.isArray(result?.supportPositions) ? result.supportPositions : []),
  ].some((position) => position?.nftMint);
}

export function isResumeCheckpointResult(result) {
  if (!result?.poolId) return false;
  return result.phase1Complete !== false || hasOpenedPhase1Position(result);
}

export function eventDerivedPriorResults(journal) {
  const results = [];
  const events = Array.isArray(journal?.events) ? journal.events : [];
  for (const event of events) {
    applyLpEventToResults(results, event, journal);
  }
  return results.filter(isResumeCheckpointResult);
}

export function mergeResultCheckpoint(base, overlay) {
  if (!base) return overlay;
  const merged = { ...base, ...overlay };
  for (const key of ['mainPositions', 'ladderPositions', 'supportPositions']) {
    const byIndex = new Map();
    const indexKey = key === 'mainPositions' ? 'sliceIndex'
      : key === 'ladderPositions' ? 'bandIndex'
        : 'supportIndex';
    for (const position of [
      ...(Array.isArray(base?.[key]) ? base[key] : []),
      ...(Array.isArray(overlay?.[key]) ? overlay[key] : []),
    ]) {
      const index = Number(position?.[indexKey] ?? 0);
      if (Number.isFinite(index)) byIndex.set(index, position);
    }
    merged[key] = [...byIndex.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, position]) => position);
  }
  merged.txIds = { ...(base.txIds || {}), ...(overlay.txIds || {}) };
  merged.bootstrap = overlay.bootstrap || base.bootstrap || null;
  return merged;
}

export function applyLpEventToResults(results, event, journal = null) {
  if (event.stage === 'phase1_pool_done' && event.result) {
    upsertJournalResult(results, { ...event.result, phase1Complete: true });
    return true;
  }

  if (event.stage === 'pool_create_done' && event.poolId) {
    const existing = resultForEvent(results, event);
    const skeleton = journalResultSkeleton(journal, event);
    if (!skeleton) return false;
    upsertJournalResult(results, mergeResultCheckpoint(existing, skeleton));
    return true;
  }

  if (event.stage === 'main_open_done') {
    const result = ensureResultForEvent(results, event, journal);
    if (!result) return false;
    const sliceIndex = Number(event.sliceIndex);
    const distribution = normalizeJournalDistribution(journalAllocationForEvent(journal, event));
    const slice = distribution[sliceIndex] || {};
    const position = {
      sliceIndex,
      sharePercent: Number.isFinite(Number(slice.sharePercent)) ? Number(slice.sharePercent) : null,
      tickLower: Number.isFinite(event.tickLower) ? event.tickLower : null,
      tickUpper: Number.isFinite(event.tickUpper) ? event.tickUpper : null,
      nftMint: event.nftMint,
      locked: false,
      recipient: slice.recipient || null,
      transferredTo: null,
      baseAmountRaw: event.baseAmountRaw || null,
      txIds: { open: event.txId || null, lock: null, transfer: null },
    };
    result.mainPositions = Array.isArray(result.mainPositions) ? result.mainPositions : [];
    return upsertIndexedPosition(result.mainPositions, 'sliceIndex', sliceIndex, position);
  }

  if (event.stage === 'ladder_open_done') {
    const result = ensureResultForEvent(results, event, journal);
    if (!result) return false;
    const bandIndex = Number(event.bandIndex);
    const position = {
      bandIndex,
      tickLower: Number.isFinite(event.tickLower) ? event.tickLower : null,
      tickUpper: Number.isFinite(event.tickUpper) ? event.tickUpper : null,
      nftMint: event.nftMint,
      locked: false,
      baseAmountRaw: event.baseAmountRaw || null,
      txIds: { open: event.txId || null, lock: null },
    };
    result.ladderPositions = Array.isArray(result.ladderPositions) ? result.ladderPositions : [];
    return upsertIndexedPosition(result.ladderPositions, 'bandIndex', bandIndex, position);
  }

  if (event.stage === 'support_open_done') {
    const result = ensureResultForEvent(results, event, journal);
    if (!result) return false;
    const supportIndex = Number.isFinite(Number(event.supportIndex)) ? Number(event.supportIndex) : 0;
    const position = {
      supportIndex,
      tickLower: Number.isFinite(event.tickLower) ? event.tickLower : null,
      tickUpper: Number.isFinite(event.tickUpper) ? event.tickUpper : null,
      depthPct: Number.isFinite(Number(event.depthPct)) ? Number(event.depthPct) : null,
      quoteRaw: event.quoteAmountRaw || null,
      nftMint: event.nftMint,
      locked: false,
      txIds: { open: event.txId || null, lock: null },
    };
    result.supportPositions = Array.isArray(result.supportPositions) ? result.supportPositions : [];
    return upsertIndexedPosition(result.supportPositions, 'supportIndex', supportIndex, position);
  }

  if (event.stage === 'bootstrap_open_done' || event.stage === 'bootstrap_open_recovered') {
    const result = ensureResultForEvent(results, event, journal) || resultForEvent(results, event);
    if (!result) return false;
    result.bootstrap = {
      nftMint: event.nftMint || null,
      locked: false,
      tickLower: Number.isFinite(event.tickLower) ? event.tickLower : null,
      tickUpper: Number.isFinite(event.tickUpper) ? event.tickUpper : null,
      txIds: { open: event.txId || null, lock: null },
    };
    return true;
  }

  const result = resultForEvent(results, event);
  if (!result) return false;

  if (event.stage === 'main_lock_done' || event.stage === 'main_lock_recovered') {
    const pos = positionForIndex(result.mainPositions, 'sliceIndex', event.sliceIndex);
    if (!pos) return false;
    pos.locked = true;
    pos.feeKeyNftMint = event.feeKeyNftMint || pos.feeKeyNftMint || null;
    pos.txIds = { ...(pos.txIds || {}), lock: event.txId || null };
    return true;
  }

  if (event.stage === 'ladder_lock_done' || event.stage === 'ladder_lock_recovered') {
    const pos = positionForIndex(result.ladderPositions, 'bandIndex', event.bandIndex);
    if (!pos) return false;
    pos.locked = true;
    pos.feeKeyNftMint = event.feeKeyNftMint || pos.feeKeyNftMint || null;
    pos.txIds = { ...(pos.txIds || {}), lock: event.txId || null };
    return true;
  }

  if (event.stage === 'support_lock_done' || event.stage === 'support_lock_recovered') {
    const pos = positionForIndex(result.supportPositions, 'supportIndex', event.supportIndex);
    if (!pos) return false;
    pos.locked = true;
    pos.feeKeyNftMint = event.feeKeyNftMint || pos.feeKeyNftMint || null;
    pos.txIds = { ...(pos.txIds || {}), lock: event.txId || null };
    return true;
  }

  if (event.stage === 'bootstrap_lock_done' || event.stage === 'bootstrap_lock_recovered') {
    if (!result.bootstrap) return false;
    result.bootstrap.locked = true;
    result.bootstrap.feeKeyNftMint = event.feeKeyNftMint || result.bootstrap.feeKeyNftMint || null;
    result.bootstrap.txIds = { ...(result.bootstrap.txIds || {}), lock: event.txId || null };
    return true;
  }

  if (event.stage === 'main_transfer_done' || event.stage === 'main_transfer_recovered') {
    const pos = positionForIndex(result.mainPositions, 'sliceIndex', event.sliceIndex);
    if (!pos) return false;
    pos.transferredTo = event.recipient || pos.recipient || null;
    pos.txIds = { ...(pos.txIds || {}), transfer: event.txId || null };
    return true;
  }

  return false;
}

export function priorResultsFromJournal(journal) {
  const lp = journal?.lp || {};
  const source = Array.isArray(lp.results) && lp.results.length > 0
    ? lp.results
    : (Array.isArray(lp.partialResults) ? lp.partialResults : []);
  const byAllocation = new Map();
  for (const result of cloneJson(source).filter(isResumeCheckpointResult)) {
    byAllocation.set(result.allocationIndex, result);
  }
  for (const result of eventDerivedPriorResults(journal)) {
    const existing = byAllocation.get(result.allocationIndex);
    byAllocation.set(result.allocationIndex, mergeResultCheckpoint(existing, result));
  }
  return [...byAllocation.values()]
    .filter(isResumeCheckpointResult)
    .sort((a, b) => Number(a.allocationIndex ?? 0) - Number(b.allocationIndex ?? 0));
}

export function hasCompletedLpResults(journal) {
  const lp = journal?.lp || {};
  return (
    V2_LP_RECOVERABLE_STAGES.has(journal?.stage) &&
    Array.isArray(lp.results) &&
    lp.results.length > 0 &&
    !lp.failedPhase
  );
}

export function unsafeCreatedPoolEvents(journal, priorResults) {
  const completedAllocations = new Set(priorResults.map((r) => r.allocationIndex));
  return (journal.events || []).filter(
    (event) =>
      event.stage === 'pool_create_done' &&
      !completedAllocations.has(event.allocationIndex),
  );
}

export function latestEventsByIndex(events, stage, indexKey, allocationIndex) {
  const byIndex = new Map();
  for (const event of events || []) {
    if (event.stage !== stage || event.allocationIndex !== allocationIndex) continue;
    const idx = Number(event[indexKey]);
    if (!Number.isInteger(idx) || idx < 0) continue;
    byIndex.set(idx, event);
  }
  return [...byIndex.entries()]
    .sort(([a], [b]) => a - b)
    .map(([index, event]) => ({ index, event }));
}

export function v2TransferSweepErrorCount(transfer = {}) {
  const tokenErrors = Array.isArray(transfer.tokenTransferErrors)
    ? transfer.tokenTransferErrors
    : Array.isArray(transfer.tokenSweep?.errors) ? transfer.tokenSweep.errors : [];
  const nftErrors = Array.isArray(transfer.nftTransferErrors)
    ? transfer.nftTransferErrors
    : Array.isArray(transfer.nftSweep?.errors) ? transfer.nftSweep.errors : [];
  return tokenErrors.length + nftErrors.length + (transfer.solSweepError ? 1 : 0);
}

export function v2TransferHasWalletEmptyFinalSweepEvidence(transfer = null) {
  return Boolean(
    transfer
    && typeof transfer === 'object'
    && String(transfer.destinationWallet || '').trim()
    && transfer.status !== 'planned-before-sweep'
    && transfer.walletEmpty === true
    && v2TransferSweepErrorCount(transfer) === 0
  );
}

/**
 * Fold a launch journal + request body into the idempotent execution
 * context. Pure: the caller (app or runner) supplies the journal it
 * looked up. Mirrors the server's v2ExecutionContextFromJournal exactly.
 */
export function buildV2ExecutionContext({ journal, body = {} } = {}) {
  const priorResults = journal ? priorResultsFromJournal(journal) : [];
  const lpResults = Array.isArray(journal?.lp?.results) ? journal.lp.results : [];
  const lpComplete = lpResults.length > 0 && !journal?.lp?.failedPhase;
  const terminalTransfer = journal?.transfer || body.transfer || null;
  const tokenMint = journal?.token?.mint || body.tokenMint || null;
  const creationComplete = tokenCreationComplete(journal, tokenMint);
  const tokenNeedsFinish = Boolean(tokenMint && !creationComplete);
  return {
    tokenMint,
    tokenCreated: creationComplete || (!journal && body.tokenCreated === true),
    tokenNeedsFinish,
    metadataRevealPending: journal?.token?.sealedMetadataPending === true,
    createdTokenInfo: journal?.token || body.createdTokenInfo,
    priorResults: priorResults.length ? priorResults : body.priorResults,
    resume: body.resume === true || journal?.status === 'failed' || Boolean(journal?.lp?.failedPhase),
    failedLaunch: body.failedLaunch === true || journal?.status === 'failed',
    liquidityComplete: lpComplete || hasCompletedLpResults(journal) || body.liquidityComplete === true || body.lpComplete === true,
    transferComplete: v2TransferHasWalletEmptyFinalSweepEvidence(terminalTransfer),
    journal,
  };
}