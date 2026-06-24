// ===========================================================================
// Launch recovery — reconstruct LP results from a journal's event log
// ---------------------------------------------------------------------------
// Background
// ----------
// A multi-pool launch records two complementary kinds of LP state in its
// journal:
//
//   1. lp.results / lp.partialResults — the structured, authoritative result
//      objects. These are written only when an allocation FINISHES Phase 1:
//      the orchestrator emits a complete `phase1_pool_done` result, which the
//      server folds into lp.partialResults (see applyLpEventToResults).
//
//   2. journal.events — a flat, append-only log of granular progress events
//      (pool_create_done, main_open_done, ladder_open_done, ...). One is
//      written for every step, whether or not the allocation it belongs to
//      ever finishes.
//
// The gap this module closes
// --------------------------
// If a launch dies PART-WAY through an allocation's Phase 1 — pool created,
// some main slices opened, then a failure before that allocation completes —
// no `phase1_pool_done` is ever emitted for it, so (1) stays empty for that
// allocation. The pool and the positions that DID open are real and on-chain,
// still owned by the launch wallet, but the structured results never mention
// them. A resume that consults only (1) sees nothing to carry forward, tries
// to recreate the already-existing pool, and fails — which is exactly the
// failure this code path was built to recover from.
//
// This module reconstructs the missing structured result for such an
// allocation from the granular events in (2). The reconstructed result is a
// resume HINT, not a source of truth: it carries the pool id and the position
// NFTs (with their open tx ids) so the orchestrator can adopt the pool and
// recover each open's tx id. createSinglePool re-scans the wallet on resume
// and reconciles against on-chain state, so a reconstructed result that is
// slightly stale or over-complete cannot cause a duplicate open or a double
// spend — it only ever lets the resume skip work that is already done.
//
// Both exported functions are pure and dependency-free so they can be unit
// tested against captured journals with no chain connection.
//
// Event vocabulary (must stay in sync with createSinglePool in lpService.js,
// which emits these; the orchestrator wraps each with an allocationIndex):
//
//   pool_create_done    { allocationIndex, poolId, txId }
//   pool_adopted        { allocationIndex, poolId, txId }   // a prior resume already adopted it
//   main_open_done      { allocationIndex, sliceIndex, nftMint, txId }
//   main_open_skip      { allocationIndex, sliceIndex, nftMint }   // carried forward by a prior resume
//   ladder_open_done    { allocationIndex, bandIndex, nftMint, txId }
//   ladder_open_skip    { allocationIndex, bandIndex, nftMint }
//   support_open_done   { allocationIndex, nftMint, txId }
//   support_open_skip   { allocationIndex, nftMint }
//   bootstrap_open_done { allocationIndex, nftMint, txId, tickLower, tickUpper }
// ===========================================================================

// A blank per-allocation result in the shape the orchestrator's resume path
// reads: poolId + txIds.createPool to adopt the pool, the three position
// arrays as tx-id hints, and bootstrap. Fields the orchestrator recomputes
// on-chain (slice shares, recipients, tick ranges for main/ladder/support)
// are intentionally absent — supplying stale copies would be misleading and
// they're never read on the resume path.
function emptyAllocation(allocationIndex) {
  return {
    allocationIndex,
    poolId: null,
    txIds: { createPool: null },
    mainPositions: [],
    ladderPositions: [],
    supportPositions: [],
    bootstrap: null,
  };
}

// Upsert a position into an array keyed by an index field (sliceIndex for
// main, bandIndex for ladder). A later event for the same index updates the
// existing entry instead of duplicating it. This matters specifically for a
// re-resumed launch: it re-emits an *_open_skip for a slice an earlier
// attempt already opened with an *_open_done. The skip carries no tx id, so
// we keep the open tx id the original done captured (openTxId || existing)
// rather than nulling it.
function upsertIndexedPosition(list, indexKey, indexValue, nftMint, openTxId) {
  let entry = list.find((p) => p[indexKey] === indexValue);
  if (!entry) {
    entry = { [indexKey]: indexValue, nftMint: null, locked: false, txIds: { open: null } };
    list.push(entry);
  }
  if (nftMint) entry.nftMint = nftMint;
  entry.txIds.open = openTxId || entry.txIds.open || null;
  return entry;
}

// Support positions carry no index in their open event, so they're keyed by
// nftMint. There is normally a single support position per allocation, but
// keying by mint handles any count without duplicating.
function upsertSupportPosition(list, nftMint, openTxId) {
  if (!nftMint) return null;
  let entry = list.find((p) => p.nftMint === nftMint);
  if (!entry) {
    entry = { nftMint, locked: false, txIds: { open: null } };
    list.push(entry);
  }
  entry.txIds.open = openTxId || entry.txIds.open || null;
  return entry;
}

// Reconstruct per-allocation LP results from a journal's granular Phase-1
// events. Returns only allocations that got as far as creating (or adopting)
// a pool — without a pool id there is nothing for the orchestrator to adopt,
// and a poolId-less entry would be filtered out downstream regardless.
function reconstructPartialResultsFromEvents(journal) {
  const events = Array.isArray(journal && journal.events) ? journal.events : [];
  const byAlloc = new Map();
  const ensure = (allocationIndex) => {
    if (!byAlloc.has(allocationIndex)) {
      byAlloc.set(allocationIndex, emptyAllocation(allocationIndex));
    }
    return byAlloc.get(allocationIndex);
  };

  for (const event of events) {
    if (!event || typeof event.stage !== 'string') continue;
    // Every Phase-1 event the orchestrator emits carries an allocationIndex.
    // Events without one (wallet_generated, journal_archived, lp_*_failed
    // summaries, ...) are not allocation-scoped and are skipped.
    const ai = event.allocationIndex;
    if (!Number.isInteger(ai)) continue;

    switch (event.stage) {
      case 'pool_create_done':
      case 'pool_adopted': {
        const a = ensure(ai);
        if (event.poolId) a.poolId = event.poolId;
        a.txIds.createPool = event.txId || a.txIds.createPool || null;
        break;
      }
      case 'main_open_done':
      case 'main_open_skip': {
        if (!Number.isInteger(event.sliceIndex)) break;
        upsertIndexedPosition(ensure(ai).mainPositions, 'sliceIndex', event.sliceIndex, event.nftMint, event.txId);
        break;
      }
      case 'ladder_open_done':
      case 'ladder_open_skip': {
        if (!Number.isInteger(event.bandIndex)) break;
        upsertIndexedPosition(ensure(ai).ladderPositions, 'bandIndex', event.bandIndex, event.nftMint, event.txId);
        break;
      }
      case 'support_open_done':
      case 'support_open_skip': {
        upsertSupportPosition(ensure(ai).supportPositions, event.nftMint, event.txId);
        break;
      }
      case 'bootstrap_open_done': {
        ensure(ai).bootstrap = {
          nftMint: event.nftMint || null,
          locked: false,
          tickLower: Number.isFinite(event.tickLower) ? event.tickLower : null,
          tickUpper: Number.isFinite(event.tickUpper) ? event.tickUpper : null,
          txIds: { open: event.txId || null, lock: null },
        };
        break;
      }
      default:
        break;
    }
  }

  const out = [];
  for (const a of byAlloc.values()) {
    if (!a.poolId) continue;
    a.mainPositions.sort((x, y) => x.sliceIndex - y.sliceIndex);
    a.ladderPositions.sort((x, y) => x.bandIndex - y.bandIndex);
    out.push(a);
  }
  out.sort((x, y) => x.allocationIndex - y.allocationIndex);
  return out;
}

// Merge stored structured results with event-reconstructed ones, keyed by
// allocationIndex. Reconstructed entries are seeded first so a stored result
// for the same allocation OVERRIDES it: stored results are authoritative —
// they hold the complete Phase-1 result (slice shares, recipients) plus
// lock/transfer state from later phases that the granular open events don't
// describe. Reconstruction therefore only ever FILLS allocations the stored
// results don't already cover (the mid-Phase-1 failure case); for a normally
// completed launch the stored results win and reconstruction is a no-op.
function mergePriorResults(storedResults, reconstructed) {
  const byAlloc = new Map();
  for (const r of Array.isArray(reconstructed) ? reconstructed : []) {
    if (r && Number.isInteger(r.allocationIndex)) byAlloc.set(r.allocationIndex, r);
  }
  for (const r of Array.isArray(storedResults) ? storedResults : []) {
    if (r && Number.isInteger(r.allocationIndex)) byAlloc.set(r.allocationIndex, r);
  }
  return [...byAlloc.values()]
    .filter((r) => r && r.poolId)
    .sort((x, y) => (x.allocationIndex ?? 0) - (y.allocationIndex ?? 0));
}

export { reconstructPartialResultsFromEvents, mergePriorResults };
