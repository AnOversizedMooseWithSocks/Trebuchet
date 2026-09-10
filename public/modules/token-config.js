function addPool(initial = {}) {
  // Default supplyPercent to whatever's left of the 100% budget so we never
  // create a new pool that pushes the total over 100. Callers that pass an
  // explicit supplyPercent (wallet-generation passes 100, future presets
  // will pass their own) bypass this default unchanged. If the budget is
  // already full the new pool comes up at 0% and the validation surfaces a
  // "set an allocation" hint inline.
  const sumExisting = pools.reduce((s, p) => s + (Number(p.supplyPercent) || 0), 0);
  const defaultPct = Math.max(0, 100 - sumExisting);
  pools.push({
    quoteToken: initial.quoteToken || 'SOL',
    supplyPercent: initial.supplyPercent ?? defaultPct,
    ammConfigIndex: 3,
    quoteUsdOverride: null,
    quoteDecimalsOverride: null,
    quoteSymbolOverride: null,
    resolvedSymbol: null,
    resolvedDecimals: null,
    resolvedPriceUsd: null,
    resolvedMint: null,
    // Optional display-only fields populated by /api/quote-token-info.
    // Either may be null if no indexer (Gecko, DexScreener) had the
    // token — the UI just hides the logo or falls back to the symbol.
    resolvedName: null,
    resolvedImageUrl: null,
    // Raydium CLMM compatibility info, set by resolvePoolQuote():
    //   resolvedCompatible: true | false | null (null = couldn't check)
    //   resolvedIsToken2022: bool — true when the mint is owned by the
    //                        Token-2022 program (vs the classic SPL Token
    //                        program). Token-2022 mints with allowlisted
    //                        extensions are still compatible.
    //   resolvedDisallowedNames: [string] — friendly names of any Token-2022
    //                        extensions this mint has that Raydium CLMM
    //                        doesn't accept. Empty when compatible.
    //   resolvedCompatError: string | null — populated when the on-chain
    //                        check failed (RPC issue / mint missing).
    resolvedCompatible: null,
    resolvedIsToken2022: false,
    resolvedDisallowedNames: [],
    resolvedCompatError: null,
    // Step 2 Raydium-route probe result. Server runs a swap probe at
    // /api/quote-token-info time (per the price-safety plan's
    // Milestone D) so the user finds out early whether their chosen
    // quote token is Raydium-tradeable.
    //   'yes'      → probe succeeded, route exists. Safe to continue.
    //   'no'       → probe ran, Trade API said no route. Block continue.
    //   'unknown'  → probe couldn't run (Trade API unreachable, etc).
    //                Allow continue but warn — Step 5 will check again.
    //   null       → not yet checked (initial state before any fetch).
    resolvedRaydiumTradeable: null,
    resolvedRaydiumProbeError: null,
    // Authority audit fields from the on-chain mint read.
    //   resolvedFreezeAuthorityBlock: true means deployer can freeze
    //                                 wallet balances; hard block.
    //   resolvedMintAuthorityWarning: true means deployer can inflate
    //                                 supply; soft warning.
    //   Either may be null when the audit didn't run (RPC down, mint
    //   missing).
    resolvedFreezeAuthorityBlock: null,
    resolvedMintAuthorityWarning: null,
    // Track the provenance of resolvedPriceUsd so the UI can label
    // it appropriately ("from Raydium" is more trustworthy than
    // "from external indexer" and we want the user to know which).
    resolvedPriceSource: null,
    // Initial distribution. Defaults to a single 100% slice (one
    // position, one Fee Key NFT). The simple-config "Split the LP"
    // toggle passes a multi-slice distribution here for users who
    // want N positions, each minting its own transferable NFT.
    distribution: initial.distribution || [
      { sharePercent: 100, recipient: null, useExternalRecipient: false },
    ],
    // Per-pool bootstrap configuration.
    //   { mode: 'minimal' } — 1-whole-token reserve, narrow tick range
    //   { mode: 'custom', solValue: N, supplyPercent: M } — user-funded
    //
    // Under "user thinks in SOL" semantics, solValue is the canonical
    // input — the absolute SOL value of starting liquidity the user
    // wants on this pool. supplyPercent is DERIVED from solValue,
    // pool.supplyPercent, the target market cap, and the SOL/USD price.
    // It's recomputed any time those inputs change (the user types SOL,
    // the target mcap input is edited, the SOL price resolves), and
    // the wide slices auto-rebalance to absorb the delta so positions
    // total stays at 100%.
    //
    // supplyPercent is stored alongside solValue (rather than recomputed
    // every read) so the positions-total indicator and the wire-format
    // conversion don't have to redo the derivation logic on every paint.
    // Whenever solValue or any input it depends on changes, we call
    // recomputePoolBootstrapAndRebalance() to refresh supplyPercent and
    // rebalance slices in one shot.
    bootstrapConfig: initial.bootstrapConfig || { mode: 'minimal' },
    // Per-pool ladder configuration.
    //   { mode: 'off' } — no ladder positions
    //   { mode: 'manual', bands: [...] } — explicit list of bands
    // Each band: { supplyPercent, lowerMultiplier, upperMultiplier }
    // where multipliers are relative to launch price (e.g., 1.5–2.5 =
    // a band spanning 1.5× to 2.5× of launch price). The simple-UI
    // ladder toggle populates manual-mode bands using the log-spaced
    // preset; customize mode lets the user edit, add, or remove
    // individual bands. The wire format the backend receives is
    // always 'off' or 'manual' from the trebuchet frontend; the
    // backend's older 'simple' mode is preserved for direct API
    // users (scripts) but unused here.
    ladderConfig: initial.ladderConfig || { mode: 'off', bands: [] },
    // Per-pool support configuration.
    //   { mode: 'off' } — no support position
    //   { mode: 'custom', solValue: N } — single-sided quote position
    //                                     funded with N SOL of value
    //
    // Support is quote-only (no token supply required), so it's
    // orthogonal to the pool's supplyPercent budget and to the bootstrap
    // and ladder allocations. It exists purely as a buy wall sitting
    // just below launch price (covering down to depthPct% below, default
    // 10%), backing any preallocated supply held outside LP. Modeled with
    // the same shape as bootstrap (mode + solValue + per-position config)
    // for consistency, even though support has no derived supplyPercent
    // — it doesn't carve from anything.
    supportConfig: initial.supportConfig || { mode: 'off' },
    // UI-only: whether this pool's body is expanded in the editor. Set
    // by initialIsExpanded() at construction; the user can flip it via
    // the header click or via auto-expansion when the pool needs
    // attention. Buildmode/render code never reads this on a collapsed
    // pool, since collapsed pools only render the header strip.
    _isExpanded: initial._isExpanded ?? false,
  });
  renderPools();
  // Pool quote resolution kicks off async. For mints we've already
  // resolved this session (cached in quoteInfoCache), apply the cached
  // info SYNCHRONOUSLY first so the pool starts with resolved fields
  // populated and downstream renders don't see a transient empty
  // state. The async resolvePoolQuote still runs — it handles TTL
  // refresh and the uncached case — but the synchronous pre-fill
  // closes the race window that produced missing logos in the
  // funding step (Continue → flushRebuildPoolsFromSimple clears
  // pools → addPool creates fresh empty pools → renderFundingRequirements
  // ran before resolvePoolQuote's async microtask fired).
  const newPoolIdx = pools.length - 1;
  const newPool = pools[newPoolIdx];
  const cachedQuoteInfo = quoteInfoCache.get(newPool.quoteToken);
  if (cachedQuoteInfo && cachedQuoteInfo.info
      && typeof applyResolvedInfoToPool === 'function') {
    applyResolvedInfoToPool(newPool, cachedQuoteInfo.info);
  }
  resolvePoolQuote(newPoolIdx);
}

function removePool(idx) {
  pools.splice(idx, 1);
  renderPools();
  updateContinueToFundingState();
}

// Add a slice to a pool's distribution. Splits the last existing slice
// in half so the total wide allocation doesn't change — the user is
// subdividing for ownership splitting, not reallocating supply. The
// new slice arrives with no recipient set; user can wire one up via
// "Send to a different wallet" checkbox in the row.
function addSlice(poolIdx) {
  const p = pools[poolIdx];
  // Adding a slice always splits the LAST existing slice in half.
  // This keeps the positions total invariant — the wide bucket's
  // size doesn't change, we just subdivide it further for ownership
  // splitting.
  //
  // If there are no existing slices (edge case — distribution was
  // emptied), seed with what's left of the wide bucket after bs +
  // bands. Should never happen in practice since addPool seeds one
  // slice, but we guard so a corrupt state can still recover.
  if (p.distribution.length === 0) {
    const bsPct = (p.bootstrapConfig?.mode === 'custom')
      ? Number(p.bootstrapConfig.supplyPercent) || 0 : 0;
    const bandsPct = (p.ladderConfig?.mode === 'manual' && Array.isArray(p.ladderConfig.bands))
      ? p.ladderConfig.bands.reduce((s, b) => s + (Number(b.supplyPercent) || 0), 0) : 0;
    const widePct = Math.max(0, 100 - bsPct - bandsPct);
    p.distribution.push({ sharePercent: widePct, recipient: null, useExternalRecipient: false });
  } else {
    const last = p.distribution[p.distribution.length - 1];
    const lastShare = Number(last.sharePercent) || 0;
    const half = Number((lastShare / 2).toFixed(4));
    last.sharePercent = half;
    p.distribution.push({ sharePercent: half, recipient: null, useExternalRecipient: false });
  }
  renderPools();
}

function removeSlice(poolIdx, sliceIdx) {
  const p = pools[poolIdx];
  if (p.distribution.length <= 1) return;
  // Absorb the removed slice's share into the last remaining slice so
  // the positions total stays at whatever it was. Without this, removing
  // a slice would silently shrink the wide bucket and the user would
  // see a confusing "now total is 75%" warning that they didn't trigger
  // intentionally. The remaining slice grows to take back the freed
  // share.
  const removedShare = Number(p.distribution[sliceIdx].sharePercent) || 0;
  p.distribution.splice(sliceIdx, 1);
  if (p.distribution.length > 0) {
    const last = p.distribution[p.distribution.length - 1];
    last.sharePercent = Number(
      ((Number(last.sharePercent) || 0) + removedShare).toFixed(4),
    );
  }
  renderPools();
}

// ---------------------------------------------------------------------------
// Simple-config rendering and pool rebuild
// ---------------------------------------------------------------------------

// Rebuild the pools array from the current simpleConfig state. Always
// produces either one pool (SOL at 100%) or two pools (SOL at 90% +
// flywheel at 10%). Wipes any existing pools — this function is the
// authority on what pools look like when in default mode.
//
// Pools come up collapsed by default (since they're at trivial defaults
// with no user customization). Resolution kicks off automatically per
// the existing addPool() behavior.
//
// This is a thin wrapper around rebuildPoolsFromSimpleCore so the
// simple-mode ladder depth-chart preview refreshes after EVERY rebuild,
// no matter which input triggered it — support edits, preallocation
// auto-back, flywheel split, market cap, ladder controls. The core has
// more than one exit (the flywheel branch returns early), so centralising
// the refresh here means no exit path can forget it. updateSimpleLadderPreview
// is a no-op when the preview isn't on screen (e.g. during the init rebuild
// before the simple UI renders, or while in customize mode).
function rebuildPoolsFromSimple() {
  rebuildPoolsFromSimpleCore();
  updateSimpleLadderPreview();
}

function rebuildPoolsFromSimpleCore() {
  // Wipe the existing pool list. We assume the caller knows what they're
  // doing — switching from customize → default mode should confirm
  // before calling this.
  pools.length = 0;

  // Before deriving any pool config, ensure simpleConfig.supportSolValue
  // is at or above the auto-back floor. Without this sync, every rebuild
  // path would have to remember to seed the floor explicitly — and the
  // ones that forget (initial page load, anywhere a rebuild fires
  // without first running through a write handler) produce pools with
  // stale support values. The auto-back floor depends on SOL price; if
  // the price isn't resolved yet the floor is null and we leave stored
  // alone (the next rebuild after SOL resolves will catch up).
  //
  // We only WRITE when the floor is strictly higher than stored — the
  // auto-back promise is "no less than the floor," not "exactly the
  // floor." A user who typed a deeper-than-required wall keeps their
  // typed value.
  if (simpleConfig.supportAutoSize && simpleConfig.preallocationEnabled) {
    const rec = recommendedSupportSolForPreallocation(
      Number(simpleConfig.preallocationPercent) || 0,
    );
    if (Number.isFinite(rec) && rec > 0
        && rec > (Number(simpleConfig.supportSolValue) || 0)) {
      simpleConfig.supportSolValue = rec;
    }
  }

  // Preallocation reduces the total LP budget by that %. Pool allocations
  // (SOL + optional flywheel) get scaled proportionally to fit inside the
  // remaining LP budget so the user's intended flywheel split is preserved.
  // Default (no preallocation) is 100% to LP. When the user enables a 20%
  // preallocation with a 90/10 SOL/flywheel split, pools end up at 72%/18%
  // (sum = 80%), leaving 20% outside LP for the user to distribute as they
  // see fit (airdrop, presale, team allocation, etc.).
  const preallocPct = simpleConfig.preallocationEnabled
    ? Math.max(0, Math.min(99, Number(simpleConfig.preallocationPercent) || 0))
    : 0;
  const lpBudget = 100 - preallocPct;

  // Helper: compute the wide-bucket total for a pool given its bs + ladder
  // configs. With unified semantics, bs + sum(ladder) + sum(wide slices)
  // = 100% of pool. So wide total = 100 - bs - sum(bands). Slices then
  // split this wide total equally.
  function widePctForPool(bsCfg, ladderCfg) {
    const bsPct = bsCfg && bsCfg.mode === 'custom' ? Number(bsCfg.supplyPercent) : 0;
    const ladderTotal = ladderCfg && Array.isArray(ladderCfg.bands)
      ? ladderCfg.bands.reduce((s, b) => s + Number(b.supplyPercent || 0), 0)
      : 0;
    return Math.max(0, 100 - bsPct - ladderTotal);
  }

  if (simpleConfig.flywheelEnabled) {
    const fw = FLYWHEELS[simpleConfig.flywheelKey];
    if (fw && fw.available && fw.mint) {
      const flywheelPct = Math.max(
        FLYWHEEL_MIN_PERCENT,
        Math.min(FLYWHEEL_MAX_PERCENT, Number(simpleConfig.flywheelPercent) || DEFAULT_FLYWHEEL_PERCENT),
      );
      // Scale the SOL/flywheel split to fit inside the LP budget. The
      // user's intended ratio (flywheelPct of the LP slice) is preserved
      // — preallocation just shrinks the total they share. So if the
      // user wants 20% flywheel and 80% SOL with a 10% preallocation,
      // pools end up at 72% SOL / 18% flywheel (sum 90%) leaving 10%
      // preallocated.
      const solSharePct = 100 - flywheelPct; // share of LP budget for SOL
      const solPoolPct = solSharePct * lpBudget / 100;
      const fwPoolPct = flywheelPct * lpBudget / 100;

      // Compute bootstrap and ladder for each pool. Bootstrap is derived
      // per-pool (since the pool's supplyPercent matters for converting
      // dollar value to % of pool); ladder is the same shape on both.
      const solBs = deriveBootstrapConfigFromSimple(solPoolPct, 2);
      const solLadder = deriveLadderConfigFromSimple();
      const fwBs = deriveBootstrapConfigFromSimple(fwPoolPct, 2);
      const fwLadder = deriveLadderConfigFromSimple();

      // Support config: simple mode spreads the total support SOL
      // equally across both pools (SOL and flywheel). Each pool gets
      // totalSupportSol / 2 SOL of buy-side support — same equal-split
      // pattern as starting liquidity. This matches the spec: "spread
      // across the various pools similar to how the starting liquidity
      // feature works."
      //
      // We clone the derived config for each pool so the two pools
      // don't share the same object reference. Without this, a later
      // mutation in customize mode (e.g. user toggles support off on
      // one pool) would affect both pools. Cloning is cheap — the
      // config is a flat object with 2-3 primitive fields.
      const sharedSupport = deriveSupportConfigFromSimple(2);
      const solSupport = { ...sharedSupport };
      const fwSupport = { ...sharedSupport };

      // Distribution slices share the wide bucket. Split-the-LP applies
      // only to the SOL pool in simple mode; flywheel pool always gets
      // one slice. Each slice's sharePercent is "% of pool" (new unified
      // semantics).
      const solSplitCount = simpleConfig.splitEnabled ? simpleConfig.splitCount : 1;
      const solDistribution = buildEqualSplitDistribution(
        solSplitCount, widePctForPool(solBs, solLadder),
      );
      const fwDistribution = buildEqualSplitDistribution(
        1, widePctForPool(fwBs, fwLadder),
      );
      addPool({
        quoteToken: 'SOL',
        supplyPercent: solPoolPct,
        distribution: solDistribution,
        bootstrapConfig: solBs,
        ladderConfig: solLadder,
        supportConfig: solSupport,
      });
      addPool({
        quoteToken: fw.mint,
        supplyPercent: fwPoolPct,
        distribution: fwDistribution,
        bootstrapConfig: fwBs,
        ladderConfig: fwLadder,
        supportConfig: fwSupport,
      });
      return;
    }
    // Selected flywheel is not available (e.g. user picked it before
    // it launches, or the entry got removed); fall through to single-
    // SOL-pool default. The dropdown should prevent this in normal use.
  }

  // Default / flywheel-disabled / unavailable-flywheel case. Only one
  // pool (SOL), so splitting that pool is the only kind of split that
  // makes sense here. Preallocation still applies — the single pool's
  // allocation shrinks to the LP budget, with the remainder held back.
  const bsCfg = deriveBootstrapConfigFromSimple(lpBudget, 1);
  const ladderCfg = deriveLadderConfigFromSimple();
  const supportCfg = deriveSupportConfigFromSimple(1);
  const distribution = buildEqualSplitDistribution(
    simpleConfig.splitEnabled ? simpleConfig.splitCount : 1,
    widePctForPool(bsCfg, ladderCfg),
  );
  addPool({
    quoteToken: 'SOL',
    supplyPercent: lpBudget,
    distribution,
    bootstrapConfig: bsCfg,
    ladderConfig: ladderCfg,
    supportConfig: supportCfg,
  });
}

// Translate the simple-UI bootstrap config into a per-pool bootstrapConfig.
//
// As of the support-consolidation change, simple mode never exposes a
// custom-bootstrap control to the user — the bootstrap is always a
// minimal ~$1 reservation. Real quote-side starting liquidity is now
// added via the Support position feature (single-sided, no token-side
// thickening). Token-side density near launch is the job of the
// Ladder feature.
//
// The custom-bootstrap path is preserved in code for two reasons:
//   1. customize mode still supports per-pool bootstrap overrides
//      (the per-pool UI doesn't expose it anymore, but the data
//      pipeline still works end-to-end for any future re-introduction)
//   2. Saved configs that pre-date this change might still carry
//      bootstrapMode='custom' in their state; the existing pre-flight
//      and wire-format code handles those without regression.
//
// supplyPercent (when in custom mode) uses the live SOL price when
// available (read from the SOL pool's resolvedPriceUsd), falling back
// to $200 when no pool has resolved yet — same fallback the funding
// estimator uses. The post-resolution refresh in resolvePoolQuote
// re-runs this and updates each pool's supplyPercent + rebalances
// slices when the live price arrives.
//
// If any input is missing or invalid, we return minimal mode. That's
// the safe default — the pool will just spawn with a tradable ~$1
// reserve and the user can recover by switching to customize.
function deriveBootstrapConfigFromSimple(poolSupplyPercent, poolCount) {
  if (simpleConfig.mode !== 'default') return { mode: 'minimal' };
  if (simpleConfig.bootstrapMode !== 'custom') return { mode: 'minimal' };
  const totalSol = Number(simpleConfig.bootstrapSolValue);
  if (!Number.isFinite(totalSol) || totalSol <= 0) return { mode: 'minimal' };
  if (!Number.isFinite(poolCount) || poolCount <= 0) return { mode: 'minimal' };
  if (!Number.isFinite(poolSupplyPercent) || poolSupplyPercent <= 0) return { mode: 'minimal' };

  // Each pool gets an equal share of the total bootstrap SOL.
  const perPoolSol = totalSol / poolCount;
  // Derive supplyPercent for initial display. The on-input handlers
  // and the targetMarketCap/resolvePoolQuote hooks all recompute this
  // via computeBootstrapSupplyPercent() which uses the same logic.
  const supplyPercent = computeBootstrapSupplyPercent(perPoolSol, poolSupplyPercent);
  if (supplyPercent == null) return { mode: 'minimal' };
  return { mode: 'custom', solValue: perPoolSol, supplyPercent };
}

// Compute the supplyPercent (% of pool) for a bootstrap given:
//   solValue        — absolute SOL of starting liquidity for THIS pool
//   poolSupplyPct   — pool's allocation as % of total token supply
//
// Reads targetMarketCap from the DOM and the SOL price from the SOL
// pool's resolvedPriceUsd (falls back to $200 if unresolved). Returns
// null if any input is missing/invalid; callers treat null as "leave
// the supplyPercent alone."
function computeBootstrapSupplyPercent(solValue, poolSupplyPct) {
  const sol = Number(solValue);
  if (!Number.isFinite(sol) || sol <= 0) return null;
  if (!Number.isFinite(poolSupplyPct) || poolSupplyPct <= 0) return null;
  const targetMc = parseNumberInput(document.getElementById('targetMarketCap'));
  if (!Number.isFinite(targetMc) || targetMc <= 0) return null;
  const solPool = pools.find((p) => (p.quoteToken || '').toUpperCase() === 'SOL');
  const solUsd = solPool && Number(solPool.resolvedPriceUsd) > 0
    ? Number(solPool.resolvedPriceUsd) : 200;
  const bsUsd = sol * solUsd;
  const poolUsd = targetMc * poolSupplyPct / 100;
  if (poolUsd <= 0) return null;
  const pct = (bsUsd / poolUsd) * 100;
  if (!Number.isFinite(pct) || pct <= 0) return null;
  return pct;
}

// Refresh one pool's bootstrap supplyPercent from its stored solValue,
// then absorb the delta into the wide slices so positions total stays
// at 100%. Called from any path that can change the derived supplyPercent
// without changing user intent: targetMarketCap input, SOL price
// resolution, and the SOL input in customize mode itself.
//
// No-op when bootstrap is in minimal mode (no solValue to recompute)
// or when the recompute fails (missing mcap/price). In both cases the
// supplyPercent stays at whatever it was, so the total may drift —
// the warning indicator surfaces that to the user.
function recomputePoolBootstrapAndRebalance(pool) {
  if (!pool || !pool.bootstrapConfig || pool.bootstrapConfig.mode !== 'custom') return;
  const oldPct = Number(pool.bootstrapConfig.supplyPercent) || 0;
  const newPct = computeBootstrapSupplyPercent(
    pool.bootstrapConfig.solValue,
    Number(pool.supplyPercent),
  );
  if (newPct == null) return;
  pool.bootstrapConfig.supplyPercent = newPct;
  rebalanceWideSlicesByDelta(pool, newPct - oldPct);
}

// Translate the simple-UI support toggle into a per-pool supportConfig.
//
// Simple mode spreads the total support SOL equally across all pools —
// each pool gets totalSol / poolCount SOL of buy-side support sitting
// just below its launch price. This matches the bootstrap pattern (one
// launch-level SOL value, equal split per pool) and gives every pool a
// proportional buy wall so sellers routing into any pool find liquidity
// to land on.
//
// Customize mode reads per-pool support configs directly — users can
// tune each pool's solValue and depth independently from this simple
// derivation.
//
// Returns { mode: 'off' } when the toggle is off or any input is
// invalid. Returns the same mode/solValue/depthPct shape that
// customize-mode would produce, so rebuildPoolsFromSimple can use the
// result as-is without per-call special casing.
function deriveSupportConfigFromSimple(poolCount) {
  if (simpleConfig.mode !== 'default') return { mode: 'off' };
  if (!simpleConfig.supportEnabled) return { mode: 'off' };
  // Read the EFFECTIVE value (stored, clamped up to the auto-back
  // floor when applicable). Centralizing the clamp in
  // effectiveSupportSolValue() ensures the wire format and the inline
  // display always agree, regardless of render timing.
  const totalSol = effectiveSupportSolValue();
  if (!Number.isFinite(totalSol) || totalSol <= 0) return { mode: 'off' };
  // Defensive: callers should always pass a positive pool count, but
  // guarding here keeps the function safe if a refactor ever drops the
  // arg. Fallback to 1 pool (no division) so the user's intended SOL
  // value still lands somewhere rather than vanishing.
  const count = (Number.isFinite(poolCount) && poolCount > 0) ? poolCount : 1;
  const perPoolSol = totalSol / count;
  // Depth applies uniformly across all pools when derived from simple
  // mode. customize-mode users can edit each pool's depth separately.
  const depth = clampSupportDepth(simpleConfig.supportDepthPct);
  return { mode: 'custom', solValue: perPoolSol, depthPct: depth };
}

// Clamp a depth value into the supported [min, max] range, falling
// back to the default when the input is missing or non-finite. Used
// at every write/read site so an out-of-range value never reaches the
// backend (which has its own validation, but consistent UI defense
// keeps the user from seeing pre-flight errors for what should be a
// simple clamp).
function clampSupportDepth(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return SUPPORT_DEFAULT_DEPTH_PCT;
  return Math.max(SUPPORT_MIN_DEPTH_PCT, Math.min(SUPPORT_MAX_DEPTH_PCT, n));
}

// Compute the SOL value that would back a given preallocation percent at
// equal USD value. This is the "honest" support sizing — the buy wall
// can absorb exactly as much selling pressure as the preallocation
// could create if every preallocated token tried to dump at launch.
//
// Returns null when either input we need isn't available (no market cap
// entered yet, or no live SOL price). Callers should treat null as
// "can't recommend a value yet" and fall back to a sensible default
// (typically 1 SOL).
//
// Formula:
//   preallocUsd = (preallocPct / 100) × marketCapUsd
//   supportSol  = preallocUsd / solUsd
//
// Used both when auto-enabling support alongside preallocation, and
// when displaying the "recommended: X SOL" hint next to the support
// input so the user knows what would fully back their preallocation.
function recommendedSupportSolForPreallocation(preallocPct) {
  if (!Number.isFinite(preallocPct) || preallocPct <= 0) return null;
  const mcap = parseNumberInput(document.getElementById('targetMarketCap'));
  if (!Number.isFinite(mcap) || mcap <= 0) return null;
  // Live SOL price comes from the SOL pool's resolved info; falls back
  // to nothing rather than guessing, so we don't end up with a wildly
  // wrong recommendation when prices haven't resolved yet.
  const solPool = pools.find((p) => (p.quoteToken || '').toUpperCase() === 'SOL');
  const solUsd = solPool && Number(solPool.resolvedPriceUsd) > 0
    ? Number(solPool.resolvedPriceUsd) : null;
  if (!solUsd) return null;
  const preallocUsd = mcap * preallocPct / 100;
  return preallocUsd / solUsd;
}

// ============================================================================
// Airdrop helpers
// ============================================================================
//
// The airdrop sub-feature of preallocation lets the user supply a CSV of
// {wallet, sol_contributed} rows; we compute the token amount each
// wallet should receive at the launch starting price (= same USD value
// in tokens as they contributed in SOL).
//
// This whole feature is configured but not yet executed during a launch
// — the parsed list lives in simpleConfig.airdrop.parsedRows. A future
// step (after Burn & Earn) will perform the actual SPL transfers using
// this data; that work isn't in this file yet.

// Base58 alphabet check + length range. Real cryptographic validation
// (decode + ed25519 curve point check) requires @solana/web3.js, which
// isn't loaded in the browser. This regex catches typos and rejects
// any input with disallowed chars (most importantly the easy mix-ups:
// 0/O, I/l). The server will do full validation when the airdrop
// runs; this check is for catching obvious errors at config time.
//
// Solana addresses are 32-byte ed25519 public keys; in base58 that's
// almost always 43-44 chars, occasionally 42 if the key happens to
// start with leading zero bytes. We allow 32-44 to be generous — any
// shorter than 32 is definitely not a real key.
const SOL_BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
function isPlausibleSolAddress(s) {
  if (typeof s !== 'string') return false;
  return SOL_BASE58_RE.test(s.trim());
}

// Parse the user's airdrop CSV into structured rows. Format:
//   - First non-comment, non-blank line is the header: wallet,sol
//   - Subsequent rows are data: <address>,<sol_amount>
//   - Lines starting with # are comments (ignored)
//   - Blank lines are ignored
//   - Leading BOM (UTF-8) stripped
//   - Values may be quoted ("...") to allow commas inside (we strip)
//
// Returns { rows, error }:
//   rows: array of { wallet, sol, lineNumber } when successful
//   error: string when parsing failed; rows is empty in that case
//
// Errors include the 1-indexed line number where the problem occurred,
// so the user can locate the bad line in their source CSV.
function parseAirdropCsv(text) {
  if (!text || typeof text !== 'string') {
    return { rows: [], error: null }; // empty input isn't an error
  }
  // Strip BOM, normalize line endings.
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = normalized.split('\n');
  const rows = [];
  const seenAddresses = new Set();
  let headerSeen = false;
  for (let i = 0; i < lines.length; i++) {
    const lineNumber = i + 1;
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!trimmed) continue;                      // blank line
    if (trimmed.startsWith('#')) continue;       // comment

    // Split on the first comma only — addresses don't contain commas
    // but quoted SOL values theoretically could, and we'll strip quotes.
    const commaIdx = trimmed.indexOf(',');
    if (commaIdx < 0) {
      return {
        rows: [],
        error: `Line ${lineNumber}: missing comma (expected "wallet,sol")`,
      };
    }
    const left = trimmed.slice(0, commaIdx).trim().replace(/^"|"$/g, '');
    const right = trimmed.slice(commaIdx + 1).trim().replace(/^"|"$/g, '');

    if (!headerSeen) {
      // First content line should be the header. We're lenient about
      // exact wording — accept anything that looks like a header
      // (non-numeric right side) and use it as the header marker. This
      // way users who paste data directly without a header get a
      // helpful error rather than silent first-row consumption.
      const rightLooksNumeric = /^\d*\.?\d+$/.test(right);
      if (rightLooksNumeric) {
        return {
          rows: [],
          error: `Line ${lineNumber}: missing header row (expected "wallet,sol" as the first line)`,
        };
      }
      headerSeen = true;
      continue;
    }

    // Data row. Validate address and SOL amount.
    if (!isPlausibleSolAddress(left)) {
      return {
        rows: [],
        error: `Line ${lineNumber}: "${left.slice(0, 12)}${left.length > 12 ? '…' : ''}" is not a valid Solana address`,
      };
    }
    if (seenAddresses.has(left)) {
      return {
        rows: [],
        error: `Line ${lineNumber}: duplicate address (${left.slice(0, 8)}…) — each wallet must appear at most once`,
      };
    }
    seenAddresses.add(left);

    const sol = Number(right);
    if (!Number.isFinite(sol) || sol <= 0) {
      return {
        rows: [],
        error: `Line ${lineNumber}: "${right}" is not a positive SOL amount`,
      };
    }

    rows.push({ wallet: left, sol, lineNumber });
  }

  // A CSV with only a header (no data rows) isn't an error per se, but
  // it's almost certainly not what the user wanted. Surface that as a
  // soft message via parseError so they don't get a silent "0 rows"
  // preview.
  if (headerSeen && rows.length === 0) {
    return {
      rows: [],
      error: 'No data rows found (the CSV has a header but no wallet entries below it)',
    };
  }
  if (!headerSeen) {
    return {
      rows: [],
      error: 'No header row found (expected "wallet,sol" as the first line)',
    };
  }

  return { rows, error: null };
}

// Compute the token amount each parsed CSV row maps to, plus the USD
// equivalent of that token amount. Uses launch starting price:
//   start_price_usd_per_token = market_cap_usd / total_supply
//   tokens = (sol × SOL_USD) / start_price_usd_per_token
//          = (sol × SOL_USD × total_supply) / market_cap_usd
//
// usd is the USD value the contributor sent (sol × SOL_USD). At launch
// price, the token allocation is worth the same USD — the "fair value"
// rate. This is shown alongside the token count so the user can sanity-
// check the per-row magnitude.
//
// Returns { rows, totalTokens, totalUsd } where rows is the input with
// { tokens, usd } added. If marketCap, supply, or solUsd is missing/
// invalid, returns the input rows unchanged (tokens and usd are null)
// and the caller can show a "fill in supply / market cap first" hint.
function annotateAirdropRowsWithTokens(parsedRows) {
  const supply = parseNumberInput(document.getElementById('tokenSupply'));
  const mcap = parseNumberInput(document.getElementById('targetMarketCap'));
  const solPool = pools.find((p) => (p.quoteToken || '').toUpperCase() === 'SOL');
  const solUsd = solPool && Number(solPool.resolvedPriceUsd) > 0
    ? Number(solPool.resolvedPriceUsd) : null;

  // Without complete inputs we can still show the rows (wallet + sol)
  // but can't compute token allocations. annotate with null fields.
  const ready = Number.isFinite(supply) && supply > 0
    && Number.isFinite(mcap) && mcap > 0
    && solUsd != null;

  let totalTokens = 0;
  let totalUsd = 0;
  const rows = parsedRows.map((r) => {
    if (!ready) {
      return { ...r, tokens: null, usd: null };
    }
    const usd = r.sol * solUsd;
    const tokens = (r.sol * solUsd * supply) / mcap;
    totalTokens += tokens;
    totalUsd += usd;
    return { ...r, tokens, usd };
  });

  return { rows, totalTokens: ready ? totalTokens : null, totalUsd: ready ? totalUsd : null, ready };
}

// Check the airdrop against the preallocation supply budget.
//   budget tokens = total_supply × prealloc_pct / 100
// Returns a user-facing error string if over budget, or null if OK.
// Returns null too when we don't have enough inputs to compute the
// budget (caller handles "incomplete inputs" separately via annotate).
function airdropBudgetError(totalTokens) {
  if (totalTokens == null) return null;
  if (!simpleConfig.preallocationEnabled) {
    return 'Preallocation must be enabled to airdrop supply';
  }
  const supply = parseNumberInput(document.getElementById('tokenSupply'));
  const preallocPct = Number(simpleConfig.preallocationPercent) || 0;
  if (!Number.isFinite(supply) || supply <= 0 || preallocPct <= 0) return null;
  const budget = supply * preallocPct / 100;
  if (totalTokens > budget) {
    const overshoot = totalTokens - budget;
    const overshootPct = (overshoot / budget) * 100;
    return `Airdrop list needs ${formatTokenDisplay(totalTokens)} tokens but preallocation only holds ${formatTokenDisplay(budget)} ` +
           `(over by ${formatTokenDisplay(overshoot)}, ${overshootPct.toFixed(1)}%). ` +
           `Raise the preallocation % or reduce SOL amounts in the list.`;
  }
  return null;
}

// SOL cost to execute the airdrop transfers, in SOL. Returns 0 when
// airdrop is disabled or empty, so callers can always add this to the
// launch total without a special case.
//
// Cost model (per recipient):
//   - ATA rent exemption: ~0.00203928 SOL (canonical value for an
//     SPL token account; we assume creation since the launched token
//     is brand new so no recipient already has an ATA for it).
//   - Tx fee: 5000 lamports = 0.000005 SOL, amortized over the batch.
//
// Batching: we conservatively assume ~10 ATA-create + transfer pairs
// per transaction (the practical limit is higher but depends on
// instruction size; 10 is safely below the Solana transaction size
// cap of 1232 bytes for the typical ATA-create + transfer pattern).
//
// The actual on-chain execution uses per-recipient transactions (each
// recipient gets one tx with an idempotent ATA create + transferChecked).
// That's more conservative than the 10-per-tx batching modeled here:
// in practice the per-recipient SOL cost is the same (one ATA rent per
// recipient either way), but we pay one tx fee per recipient instead
// of one per batch. The estimate above is fractionally low by that
// margin; we leave it as-is because the safety buffer (10% on
// slippage/fee variance applied in the lpService cost estimator)
// already covers small overruns of this kind.
const AIRDROP_ATA_RENT_SOL = 0.00203928;
const AIRDROP_TX_FEE_SOL = 0.000005;
const AIRDROP_RECIPIENTS_PER_TX = 10;
function computeAirdropExecutionCostSol() {
  const airdrop = simpleConfig.airdrop;
  if (!airdrop || !airdrop.enabled || !simpleConfig.preallocationEnabled) return 0;
  const n = airdrop.parsedRows.length;
  if (n === 0) return 0;
  const numTxs = Math.ceil(n / AIRDROP_RECIPIENTS_PER_TX);
  return n * AIRDROP_ATA_RENT_SOL + numTxs * AIRDROP_TX_FEE_SOL;
}

// Build the airdrop payload to attach to the /api/transfer-assets POST.
// Returns null when no airdrop should run — caller can omit the field
// from the request body in that case and the server short-circuits.
//
// Conditions for an airdrop to run at transfer time:
//   1. We have a created-token mint to send (Step 4 completed).
//   2. Preallocation is enabled in simpleConfig.
//   3. Airdrop sub-feature is enabled with at least one parsed row.
//   4. We're in simple mode — customize mode has no airdrop UI, so
//      simpleConfig.airdrop state from a prior simple-mode session
//      shouldn't fire when the user is now configuring per-pool.
//
// All four conditions are needed: any one failing means there's
// nothing legitimate to airdrop.
function buildAirdropTransferPayload() {
  const live = buildLiveAirdropTransferPayload();
  if (live) return live;
  // Journal-restored fallback: when resuming a launch after an app
  // restart, the simple-mode airdrop config that feeds the live builder
  // is gone, but the plan was journaled at create-lp time and restored
  // by prepareRecoveredSessionFromJournal. The mint check pins the plan
  // to this exact token. The server independently skips any recipients
  // its journal already records as delivered, so replaying the full
  // plan here is safe even when the airdrop partially (or fully) ran
  // before the restart.
  if (restoredAirdropPayload
      && createdTokenInfo
      && createdTokenInfo.mint
      && restoredAirdropPayload.tokenMint === createdTokenInfo.mint
      && Array.isArray(restoredAirdropPayload.recipients)
      && restoredAirdropPayload.recipients.length > 0) {
    return restoredAirdropPayload;
  }
  return null;
}

// The live builder: reads the CURRENT simple-mode config. Split out so the
// journal-restored fallback above can wrap it without touching the logic.
function buildLiveAirdropTransferPayload() {
  if (!createdTokenInfo || !createdTokenInfo.mint) return null;
  if (simpleConfig.mode === 'customize') return null;
  if (!simpleConfig.preallocationEnabled) return null;
  const airdrop = simpleConfig.airdrop;
  if (!airdrop || !airdrop.enabled) return null;
  const rows = Array.isArray(airdrop.parsedRows) ? airdrop.parsedRows : [];
  if (rows.length === 0) return null;

  // Filter to rows with positive token amounts. annotateAirdropRowsWithTokens
  // sets tokens=null when inputs are incomplete (supply/mcap/SOL price
  // not ready); we skip those — they wouldn't be sent regardless and
  // including them would confuse the per-recipient retry logic later.
  const recipients = rows
    .filter((r) => Number.isFinite(Number(r.tokens)) && Number(r.tokens) > 0
      && typeof r.wallet === 'string' && r.wallet.length > 0)
    .map((r) => ({
      wallet: r.wallet,
      tokens: Number(r.tokens),
    }));
  if (recipients.length === 0) return null;

  return {
    tokenMint: createdTokenInfo.mint,
    tokenDecimals: createdTokenInfo.decimals,
    // Launched tokens are classic SPL (tokenService.js creates them with
    // TOKEN_PROGRAM_ID). The server defaults to false anyway but we
    // pass it explicitly so the wire format is self-describing.
    isToken2022: false,
    recipients,
  };
}

// Compute the preallocation percent the airdrop list NEEDS to fit. This
// is the airdrop's total tokens as a percent of total supply, ceil'd
// to one decimal so the % input doesn't show fiddly values like
// "12.5934567%". Returns null when we can't compute (airdrop off /
// empty / token amounts not yet ready / supply not entered).
//
// Used as the floor for auto-fit: the effective preallocation % is
// max(user_typed_percent, airdropRequiredPreallocationPercent()) when
// auto-fit is on.
function airdropRequiredPreallocationPercent() {
  const airdrop = simpleConfig.airdrop;
  if (!airdrop || !airdrop.enabled || !simpleConfig.preallocationEnabled) return null;
  if (!airdrop.parsedRows || airdrop.parsedRows.length === 0) return null;
  const supply = parseNumberInput(document.getElementById('tokenSupply'));
  if (!Number.isFinite(supply) || supply <= 0) return null;
  let totalTokens = 0;
  for (const r of airdrop.parsedRows) {
    if (r.tokens == null) return null; // inputs incomplete, can't compute
    totalTokens += r.tokens;
  }
  const requiredPct = (totalTokens / supply) * 100;
  if (!Number.isFinite(requiredPct) || requiredPct <= 0) return null;
  // Round UP to one decimal so we definitely cover the airdrop. The
  // percent input visually accepts integers but tolerates decimals
  // numerically; clamping to 99% (the input's max) prevents a runaway
  // airdrop from setting the prealloc above the input bound.
  const ceiled = Math.ceil(requiredPct * 10) / 10;
  return Math.min(99, ceiled);
}

// Recompute simpleConfig.preallocationPercent from the user's typed
// value (preallocationPercentInput) and the airdrop's required floor.
// This is the single chokepoint for the auto-fit logic — call it from
// every handler that could change either the typed value or the
// airdrop's required percentage:
//   - prealloc-% input keystrokes
//   - airdrop CSV changes
//   - token supply / market cap changes (affect airdrop required %)
//   - auto-fit toggle on/off
//   - airdrop enabled/disabled toggle
//
// Returns true if the effective percent changed, false if not (so
// callers can skip downstream refreshes when nothing changed). The
// effective percent is what every read site uses; the typed input
// is preserved separately on simpleConfig.preallocationPercentInput.
function recomputeEffectivePreallocationPercent() {
  // Fall back to the legacy preallocationPercent field when
  // preallocationPercentInput hasn't been initialized (e.g. older
  // saved configs, or first-render before the user has typed). This
  // ensures recompute doesn't silently zero out the user's value.
  const rawTyped = simpleConfig.preallocationPercentInput != null
    ? simpleConfig.preallocationPercentInput
    : simpleConfig.preallocationPercent;
  const typed = Number(rawTyped);
  const typedClamped = Math.max(0, Math.min(99,
    Number.isFinite(typed) ? typed : 0,
  ));
  // Also write back the clamped typed value so the field stays
  // canonical (next read sees the validated number).
  simpleConfig.preallocationPercentInput = typedClamped;
  let effective = typedClamped;
  if (simpleConfig.preallocationAutoFit) {
    const required = airdropRequiredPreallocationPercent();
    if (required != null && required > effective) {
      effective = required;
    }
  }
  const prev = Number(simpleConfig.preallocationPercent) || 0;
  simpleConfig.preallocationPercent = effective;
  return Math.abs(effective - prev) > 0.001;
}

// Mirror of recomputePoolBootstrapAndRebalance for support. Support has
// no derived supplyPercent (it's quote-only and doesn't carve from the
// pool's token supply), so this is purely a hook for UI refresh — it
// updates any cached display values that depend on the live SOL price.
// Currently a no-op at the data level since supportConfig only stores
// the user's canonical solValue input; the UI computes the USD-equivalent
// display value on each render.
function recomputePoolSupportAndRebalance(_pool) {
  // No-op. Reserved for future use if support gains derived state.
}

// Translate the simple-UI ladder controls into a per-pool ladderConfig.
//
// When the toggle is off (or we're in customize mode but
// rebuildPoolsFromSimple is somehow called), return { mode: 'off' }.
// When on, generate the bands for the user's chosen strategy using the
// SAME generator, gap, and ceiling-clamp that customize mode uses. The
// returned config is fully initialized — strategy, gap, ceiling,
// bandCount, and ladderPercent are all set — so switching into customize
// carries the bands through unchanged (ensureLadderStrategyConfig sees an
// initialized config and does not regenerate). That keeps the simple-mode
// depth-chart preview identical to what the user sees after customizing.
//
// Gap and ceiling are not exposed in the simple UI, so they take the
// design defaults: gap = LADDER_GAP_DEFAULT (the same 4× customize starts
// at) and ceiling = LADDER_CEILING_DEFAULT clamped down to the pool's
// honest max (CEILING_MAX_MCAP_USD / target market cap), exactly as
// poolMaxCeilingMultiplier does for customize. Reading the live market cap
// here is what keeps the clamp — and therefore the band ranges — in sync
// with customize; pools are rebuilt whenever the market cap changes, so
// the drift check stays accurate.
function deriveLadderConfigFromSimple() {
  if (simpleConfig.mode !== 'default') return { mode: 'off', bands: [] };
  if (!simpleConfig.ladderEnabled) return { mode: 'off', bands: [] };
  const supplyPercent = Math.max(
    LADDER_MIN_PERCENT,
    Math.min(LADDER_MAX_PERCENT, Number(simpleConfig.ladderPercent) || LADDER_DEFAULT_PERCENT),
  );
  const bandCount = Math.max(
    LADDER_MIN_BANDS,
    Math.min(LADDER_MAX_BANDS, Number(simpleConfig.ladderBandCount) || LADDER_DEFAULT_BANDS),
  );
  // Chosen volatility shape, falling back to the default if the stored
  // value is somehow not a known strategy id.
  const strategy = LADDER_STRATEGY_IDS.includes(simpleConfig.ladderStrategy)
    ? simpleConfig.ladderStrategy
    : LADDER_DEFAULT_STRATEGY;
  // Ceiling clamped to the pool's honest max, same as customize. We call
  // poolMaxCeilingMultiplier (which reads the live #targetMarketCap and
  // ignores its pool argument) when it's available; before it's defined
  // (it lives in a later module, so only at runtime) we fall back to the
  // raw default. Math.min means a low market cap pulls the ceiling down
  // and a high one leaves it at the default.
  const poolMax = (typeof poolMaxCeilingMultiplier === 'function')
    ? poolMaxCeilingMultiplier(null)
    : LADDER_CEILING_DEFAULT;
  const ceiling = Math.min(LADDER_CEILING_DEFAULT, poolMax);
  const gap = LADDER_GAP_DEFAULT;
  return {
    mode: 'manual',
    // Fully initialized so customize carries it through without
    // regenerating. ladderPercent is the authoritative share (customize
    // reads it directly rather than inferring it from the band sum).
    strategy,
    gap,
    ceiling,
    bandCount,
    ladderPercent: supplyPercent,
    bands: generateLadderStrategyBands({
      strategy,
      ladderPercent: supplyPercent,
      bandCount,
      gap,
      ceiling,
    }),
  };
}

// Render the simple-mode ladder depth-chart preview into #simpleLadderPreview.
//
// This is the simple-UI counterpart to updatePoolDepthChart: it charts the
// representative pool (the SOL pool, or the first pool if there's no SOL pool)
// using the same USD-notional and support scaling, so the preview is identical
// to what the user sees on that pool after switching to customize. Called after
// the pools are rebuilt (strategy / percent / band-count changes) and once on
// every simple-config render. Safe to call when the ladder is off, the
// container is absent, or no pool exists yet — in those cases it just empties
// and hides the container so it leaves no gap.
//
// computeDepthProfile and renderDepthChartSvg live in the depth-chart module,
// which is concatenated after this one; they're only referenced here at call
// time (runtime), so the forward reference is fine.
function updateSimpleLadderPreview() {
  const wrap = document.getElementById('simpleLadderPreview');
  if (!wrap) return;

  const hide = () => { wrap.innerHTML = ''; wrap.style.display = 'none'; };
  if (!simpleConfig.ladderEnabled) { hide(); return; }

  const pool = pools.find((p) => (p.quoteToken || '').toUpperCase() === 'SOL') || pools[0];
  if (!pool) { hide(); return; }
  if (typeof computeDepthProfile !== 'function' || typeof renderDepthChartSvg !== 'function') {
    hide();
    return;
  }

  // USD scaling so the quote-side support wall is comparable to the token-side
  // bands — the pool's notional is its share of the target market cap; support's
  // value is its SOL converted through the SOL pool's resolved price. Mirrors
  // updatePoolDepthChart exactly.
  const targetMc = parseNumberInput(document.getElementById('targetMarketCap'));
  const poolNotionalUsd = (Number(targetMc) > 0 && Number(pool.supplyPercent) > 0)
    ? (Number(pool.supplyPercent) / 100) * Number(targetMc)
    : 0;

  let support = null;
  const sc = pool.supportConfig;
  if (sc && sc.mode === 'custom' && Number(sc.solValue) > 0) {
    const solPool = pools.find((p) => (p.quoteToken || '').toUpperCase() === 'SOL');
    const solUsd = solPool && Number(solPool.resolvedPriceUsd) > 0 ? Number(solPool.resolvedPriceUsd) : null;
    if (solUsd) {
      support = {
        usd: Number(sc.solValue) * solUsd,
        depthPct: (typeof clampSupportDepth === 'function') ? clampSupportDepth(sc.depthPct) : (Number(sc.depthPct) || 30),
      };
    }
  }

  const profile = computeDepthProfile(pool, { poolNotionalUsd, support });
  // renderDepthChartSvg returns '' unless there's a ladder or a placeable
  // support wall; hide the empty container so it leaves no gap. compact trims
  // the caption and labels — the full explanation lives in customize mode.
  const html = profile ? renderDepthChartSvg(profile, { compact: true }) : '';
  wrap.innerHTML = html;
  wrap.style.display = html ? '' : 'none';
}

// Build the HTML body for the "Ladder strategies" info dialog — one entry per
// strategy (name, scenario tag, description), drawn from LADDER_STRATEGY_META
// so it stays in lockstep with the dropdown and the customize-mode picker.
// LADDER_STRATEGY_META lives in a later module but is only read here at call
// time, so the forward reference is fine.
function buildLadderStrategiesInfoHtml() {
  const intro = '<p style="margin-bottom: 0.75rem;">Each strategy is a different volatility shape — it spreads the same ladder supply across a different set of price ranges above launch. They all use the same allocation, band count, gap, and ceiling; only the placement and overlap of the bands changes. Pick the resistance / accumulation profile that fits your launch.</p>';
  const items = LADDER_STRATEGY_IDS.map((id) => {
    const meta = LADDER_STRATEGY_META[id] || { name: id, note: '' };
    const tag = meta.tag ? ` <span style="opacity: 0.7;">(${escapeHtml(meta.tag)})</span>` : '';
    return `<p style="margin-bottom: 0.6rem;"><strong>${escapeHtml(meta.name)}</strong>${tag}<br>${escapeHtml(meta.note || '')}</p>`;
  }).join('');
  return intro + items;
}

// Generate N log-spaced ladder bands covering [1×, ceiling×] with equal
// gap widths between bands. Each band is given an equal share of the
// total ladder supply. This is the math the backend's 'simple' mode
// used to do server-side; we do it client-side now so the bands are
// editable as manual-mode bands.
//
// Math: total log span = ln(ceiling), per-unit log = total/(2N-1)
// (N bands + N-1 gaps). Band i (0-indexed) covers
// [e^(2i × perUnit), e^((2i+1) × perUnit)].
function generateLogSpacedBands({ supplyPercent, bandCount, ceilingMultiplier }) {
  const perBandPct = supplyPercent / bandCount;
  const totalLog = Math.log(ceilingMultiplier);
  const perUnitLog = totalLog / (2 * bandCount - 1);
  const bands = [];
  for (let i = 0; i < bandCount; i++) {
    const lowerMul = Math.exp(2 * i * perUnitLog);
    const upperMul = Math.exp((2 * i + 1) * perUnitLog);
    bands.push({
      // toFixed → Number to bound trailing precision (the slider step
      // is 0.01, so 4 decimals is plenty for our needs).
      supplyPercent: Number(perBandPct.toFixed(4)),
      lowerMultiplier: Number(lowerMul.toFixed(4)),
      upperMultiplier: Number(upperMul.toFixed(4)),
    });
  }
  return bands;
}

// Strategy-based ladder generators for the Custom Positions editor. Each
// strategy is a "volatility shape": it lays single-sided token bands over
// [gap×, ceiling×] above launch, expressing where the ladder's supply should
// sit. Supply is NOT split equally across bands — each band's share is weighted
// to realise a rising depth profile (see the allocation block in
// generateLadderStrategyBands), which keeps supply out of the cheap near-launch
// range. The shapes differ in where the bands are placed and whether they
// overlap. Overlap is intentional for some shapes (inverse ramp, pyramid,
// multi-peak): the backend converts each band to ticks independently, and
// overlapping ranges stack into deeper, smoother resistance.
//
// All placement math is in log10(multiplier) space, since price ranges read
// naturally in decades (1×, 10×, 100×, …). The output is shaped exactly like
// generateLogSpacedBands so it drops straight into pool.ladderConfig.bands.
// Band widths (in log10 decades) for a "widening" ladder: `cnt` bands tiling
// `span` decades, each at least `minW` wide and each wider than the one below
// it. The widths grow geometrically by a factor chosen so they sum to `span`:
//   - Roomy span (few bands / wide ceiling): a true 2× per band (doubling),
//     because the first band is already ≥ minW.
//   - Tight span: relax the factor below 2 (bisection) so the first band still
//     clears minW while the bands still tile the span.
//   - Too tight to fit `cnt` bands even at the minimum: fall back to equal
//     widths (the gentlest fan we can manage for that many bands).
// This keeps the first band a sensible size instead of the hair-thin sliver
// that strict log-width doubling produces near launch for large band counts.
function wideningWidths(span, cnt, minW) {
  if (cnt <= 1) return [span];
  const wDbl = span / (Math.pow(2, cnt) - 1);
  if (wDbl >= minW) {
    const out = [];
    let w = wDbl;
    for (let i = 0; i < cnt; i++) { out.push(w); w *= 2; }
    return out;
  }
  if (minW * cnt >= span) return new Array(cnt).fill(span / cnt);
  // Solve (g^cnt − 1)/(g − 1) = span/minW for the growth factor g in (1, 2).
  const target = span / minW;
  const f = (g) => (Math.pow(g, cnt) - 1) / (g - 1);
  let lo = 1 + 1e-7;
  let hi = 2;
  for (let it = 0; it < 80; it++) { const g = (lo + hi) / 2; if (f(g) < target) lo = g; else hi = g; }
  const g = (lo + hi) / 2;
  const out = [];
  let w = minW;
  for (let i = 0; i < cnt; i++) { out.push(w); w *= g; }
  // Rescale away the tiny bisection drift so the widths sum to span exactly.
  const sum = out.reduce((a, b) => a + b, 0);
  return out.map((x) => (x * span) / sum);
}

// Layout for the Gapped Doubling shape: `cnt` widening bands tiling `span`
// decades with an air-pocket before each (gap = `gamma` × the preceding band's
// width). Same widening principle as wideningWidths, but the gaps consume part
// of the span, so the bands grow a little slower than they would with no gaps.
// First band floored at `minW`; growth fitted so bands + gaps fill the span.
// Returns { bands, gaps } in decades. Keeping the gap a fraction (not a full
// band width) leaves the bands enough room to visibly widen.
function gappedDoublingWidths(span, cnt, minW, gamma) {
  if (cnt <= 1) return { bands: [span], gaps: [] };
  // H(g) = total span (in units of the first band) consumed by bands + gaps
  // when widths grow by factor g.
  const H = (g) => {
    if (Math.abs(g - 1) < 1e-9) return cnt + gamma * (cnt - 1);
    return (Math.pow(g, cnt) - 1) / (g - 1) + (gamma * (Math.pow(g, cnt - 1) - 1)) / (g - 1);
  };
  const target = span / minW;
  let rho;
  let w0;
  if (H(2) <= target) { rho = 2; w0 = span / H(2); }       // roomy: doubling fits, first band ≥ minW
  else if (H(1) >= target) { rho = 1; w0 = span / H(1); }   // too tight: equal bands, first band < minW
  else {
    let lo = 1 + 1e-7;
    let hi = 2;
    for (let it = 0; it < 80; it++) { const g = (lo + hi) / 2; if (H(g) < target) lo = g; else hi = g; }
    rho = (lo + hi) / 2;
    w0 = minW;
  }
  const bands = [];
  const gaps = [];
  let w = w0;
  for (let i = 0; i < cnt; i++) { bands.push(w); if (i < cnt - 1) gaps.push(gamma * w); w *= rho; }
  // Rescale away drift so bands + gaps sum to span exactly.
  const totalW = bands.reduce((a, b) => a + b, 0) + gaps.reduce((a, b) => a + b, 0);
  const k = totalW > 0 ? span / totalW : 1;
  return { bands: bands.map((b) => b * k), gaps: gaps.map((g) => g * k) };
}

function generateLadderStrategyBands({ strategy, ladderPercent, bandCount, gap, ceiling }) {
  const n = Math.max(1, Math.round(Number(bandCount) || LADDER_DEFAULT_BANDS));
  const G = Math.max(1, Number(gap) || LADDER_GAP_DEFAULT);
  // Ceiling must sit comfortably above the gap or the ladder has no room to lay
  // out — clamp it up if the caller passed something too tight.
  const C = Math.max(G * 1.5, Number(ceiling) || LADDER_CEILING_DEFAULT);
  const pctIn = Number(ladderPercent);
  const ladderPct = Number.isFinite(pctIn) && pctIn > 0 ? pctIn : LADDER_DEFAULT_PERCENT;

  const log10 = (x) => Math.log(x) / Math.LN10;
  const pow10 = (e) => Math.pow(10, e);
  const s = log10(G);     // start of the ladder, in decades above launch
  const top = log10(C);   // ceiling, in decades
  const span = top - s;   // total decades the ladder spans

  // Each shape returns [{ lo, hi }] in multiplier units, always n bands total.
  const shapes = {
    // Doubling — discrete, non-overlapping bands that widen toward the ceiling.
    // Widths grow geometrically (a true 2× when the span allows it), but the
    // first band is floored to a sensible width rather than the hair-thin
    // sliver strict doubling would put at launch. Thin near launch, supply
    // fanned out toward the ceiling.
    dbl() {
      const widths = wideningWidths(span, n, log10(LADDER_MIN_BAND_RATIO));
      const out = [];
      let x = s;
      for (let i = 0; i < n; i++) { out.push({ lo: pow10(x), hi: pow10(x + widths[i]) }); x += widths[i]; }
      return out;
    },
    // Gapped Doubling — Doubling's widening bands, spaced out with an air-pocket
    // before each. The bands still widen toward the ceiling; the gaps (half a
    // band wide) sit between them as room for capitulation and fresh floors.
    gapdbl() {
      const { bands, gaps } = gappedDoublingWidths(span, n, log10(LADDER_MIN_BAND_RATIO), 0.5);
      const out = [];
      let x = s;
      for (let i = 0; i < n; i++) {
        out.push({ lo: pow10(x), hi: pow10(x + bands[i]) });
        x += bands[i];
        if (i < n - 1) x += gaps[i]; // air-pocket before the next band
      }
      return out;
    },
    // Inverse Ramp — overlapping bands that all reach the ceiling; lo steps up.
    // Depth builds toward the top, parking the most supply high.
    invramp() {
      const out = [];
      for (let i = 0; i < n; i++) out.push({ lo: pow10(s + (i * span) / n), hi: C });
      return out;
    },
    // Pyramid — staggered overlapping bands of equal width; depth peaks mid-range.
    pyr() {
      const st = span / (2 * n - 1);
      const W = n * st;
      const out = [];
      for (let i = 0; i < n; i++) out.push({ lo: pow10(s + i * st), hi: pow10(s + i * st + W) });
      return out;
    },
    // Multi-Peak — several humps spread across the full range. We split
    // [gap, ceiling] into `pk` equal sub-ranges and lay a small pyramid across
    // each, so depth peaks in pk places rather than one. Spanning the full range
    // (rather than a recentred slice) means the lowest band starts at the gap
    // and the highest reaches the ceiling — exactly like every other strategy.
    multi() {
      const pk = n >= 7 ? 3 : 2;
      const sizes = [];
      for (let p = 0; p < pk; p++) sizes.push(Math.floor(n / pk) + (p < (n % pk) ? 1 : 0));
      const subW = span / pk;
      const out = [];
      for (let p = 0; p < pk; p++) {
        const m = sizes[p];
        const a = s + p * subW;          // sub-range start
        const st = subW / (2 * m - 1);   // m=1 → st = subW (single full-width band)
        const W = m * st;
        for (let j = 0; j < m; j++) out.push({ lo: pow10(a + j * st), hi: pow10(a + j * st + W) });
      }
      return out;
    },
  };

  const shapeFn = shapes[strategy] || shapes[LADDER_DEFAULT_STRATEGY];
  const raw = shapeFn();
  const cnt = raw.length;

  // Guard each range first: lo ≥ 1 and hi strictly above lo (degenerate bands
  // get a hair of width), same bounds generateLogSpacedBands uses.
  const guarded = raw.map((b) => {
    const lo = Math.max(1, b.lo);
    const hi = b.hi > lo ? b.hi : lo * 1.0001;
    return { lo, hi };
  });

  // Per-band supply allocation. We deliberately do NOT split supply equally
  // across the bands. Equal supply over these ranges piles tradeable supply
  // just above launch — the bottom bands sit in a tiny price window, so a buyer
  // can sweep the majority of the ladder cheaply (the exact failure we're
  // guarding against), and the depth chart spikes into thin towers near launch.
  //
  // Instead we target a RISING liquidity-depth profile and back out the supply
  // each band needs to realise it. A position's chart depth over [lo,hi] is
  // supply ÷ (1/√lo − 1/√hi); so to place a relative depth d on a band we give
  // it supply ∝ d × (1/√lo − 1/√hi). Choosing d that rises with the band index
  // moves supply up into the higher, expensive-to-acquire ranges and flattens
  // the spikes. The rise is steeper for the supply-control strategies (inverse
  // ramp) and gentler for the easy-to-pump one (doubling); the others sit in
  // between and lean on their range geometry for their distinctive shape.
  const RISE = { dbl: 1, gapdbl: 1, invramp: 2, pyr: 1, multi: 1 };
  const exp = RISE[strategy] != null ? RISE[strategy] : 1;
  const depthCoef = (b) => (1 / Math.sqrt(b.lo) - 1 / Math.sqrt(b.hi)) || 1e-9;
  const weights = guarded.map((b, i) => Math.pow(i + 1, exp) * depthCoef(b));
  const wSum = weights.reduce((a, w) => a + w, 0) || 1;

  // Per-band floor so the weighting can never starve a band down to a dead,
  // not-worth-opening position. Capped at a third of the equal-split share so
  // the floors always leave the weighting room to work (and never sum above the
  // ladder's own share). With the floor reserved, the remainder is distributed
  // by weight — the two together always sum back to ladderPct.
  const sMin = Math.min(0.5, ladderPct / (3 * cnt));
  const distributable = Math.max(0, ladderPct - sMin * cnt);

  return guarded.map((b, i) => ({
    supplyPercent: Number((sMin + (distributable * weights[i]) / wSum).toFixed(4)),
    lowerMultiplier: Number(b.lo.toFixed(4)),
    upperMultiplier: Number(b.hi.toFixed(4)),
  }));
}

// Valid strategy ids in display order (Doubling is the default and first).
const LADDER_STRATEGY_IDS = ['dbl', 'gapdbl', 'invramp', 'pyr', 'multi'];
// otherwise re-render the simple config (and destroy the focused
// element) — typing into a numeric input fires that input's handler
// AND any async work (resolvePoolQuote completing, etc.) that wants
// to re-render. We suppress the re-render when focus is in the body
// so the user's typing isn't interrupted; the next render (triggered
// by blur or by a structural change like toggling a feature) catches
// up the displays.
//
// Implementation note: document.activeElement is a stable read in
// every browser; checking `body.contains(activeElement)` correctly
// returns false when focus is anywhere else on the page, including
// the page-level mcap/tokenSupply/lockPositions inputs (which live
// outside simpleConfigBody).
function isFocusInsideSimpleConfigBody() {
  const body = document.getElementById('simpleConfigBody');
  if (!body) return false;
  const focused = document.activeElement;
  if (!focused || focused === document.body) return false;
  return body.contains(focused);
}

// Debounce for rebuildPoolsFromSimple. Numeric inputs (preallocation %,
// support SOL, support depth) fire their handler on EVERY keystroke,
// and each rebuild fires resolvePoolQuote for each pool — which is
// cheap (cache hits) but pegs the event loop and produces visible
// work flicker (pool list re-renders, brief "resolving" states). A
// 250ms debounce collapses rapid typing into a single rebuild after
// the user pauses. We still call it synchronously on blur and on
// non-typing events (toggle changes, dropdown selects) so structural
// updates remain instant.
//
// The flush helper runs a rebuild immediately and clears any pending
// debounce — it's called from blur handlers and the Continue click
// to guarantee the pools reflect the user's latest input before any
// follow-on action (estimator call, mode switch, etc.).
let _rebuildDebounceHandle = null;
function rebuildPoolsFromSimpleDebounced() {
  if (_rebuildDebounceHandle != null) {
    clearTimeout(_rebuildDebounceHandle);
  }
  _rebuildDebounceHandle = setTimeout(() => {
    _rebuildDebounceHandle = null;
    rebuildPoolsFromSimple();
  }, 250);
}
function flushRebuildPoolsFromSimple() {
  if (_rebuildDebounceHandle != null) {
    clearTimeout(_rebuildDebounceHandle);
    _rebuildDebounceHandle = null;
  }
  // Always run the rebuild on flush, even if no debounce was pending.
  // Blur handlers and Continue clicks call flush as a "commit now"
  // signal — they need the pool state current, and a no-op flush
  // would let stale state slip through if (e.g.) the user typed and
  // then waited >250ms before blurring (debounce fired, no-op flush
  // is fine) versus typed and blurred immediately (debounce pending,
  // flush triggers it). The unconditional rebuild covers both paths.
  rebuildPoolsFromSimple();
}

// =============================================================
// Mode-aware prealloc/airdrop refresh helpers.
//
// The preallocation and airdrop handlers fire from BOTH modes —
// the same #preallocationBlock DOM is relocated between simple
// and customize containers, so the same handlers run regardless.
// But the right follow-on behavior differs:
//
//   SIMPLE mode: pool sizes are DERIVED from simpleConfig (the
//   flywheel split slider + preallocation %). A change to the
//   prealloc % means pool sizes change. rebuildPoolsFromSimple
//   regenerates pools from the new simpleConfig and renderSimpleConfig
//   rebuilds the whole config DOM to reflect derived state.
//
//   CUSTOMIZE mode: pool sizes are USER-SET. Each pool's
//   supplyPercent, fee tier, slice splits, ladder bands, etc. are
//   things the user typed. rebuildPoolsFromSimple here would
//   `pools.length = 0` and rebuild from the simple defaults —
//   destroying every customization. We must NOT do that. The
//   preallocation % is independent: it just tells the allocator
//   "hold back X% of total supply for the launch wallet" and
//   leaves the user's per-pool config alone.
//
// preallocRebuildIfApplicable: replaces rebuildPoolsFromSimple()
//   in prealloc/airdrop handlers. No-op in customize mode.
// preallocRerenderIfApplicable: replaces renderSimpleConfig() in
//   prealloc/airdrop handlers. In customize mode it refreshes the
//   inline prealloc displays (breakdown table, auto-fit hint,
//   in-place prealloc input value) without a full DOM rebuild,
//   which would lose focus and pool DOM state.
// =============================================================
function preallocRebuildIfApplicable() {
  if (simpleConfig.mode === 'customize') {
    // In customize mode pool sizes are user-controlled, not derived.
    // Skip the rebuild entirely.
    return;
  }
  rebuildPoolsFromSimple();
}
function preallocRebuildDebouncedIfApplicable() {
  if (simpleConfig.mode === 'customize') return;
  rebuildPoolsFromSimpleDebounced();
}
function preallocRerenderIfApplicable() {
  if (simpleConfig.mode === 'customize') {
    // Customize mode: refresh ONLY the parts of the page that depend
    // on preallocation/airdrop state. Don't call renderSimpleConfig
    // (which rebuilds the whole simple-config DOM and would force the
    // preallocation block to be re-built and re-relocated — losing
    // input focus and forcing a paint flash).
    //
    // The pool list itself stays put — user pool config is unaffected
    // by prealloc changes in this mode.
    if (typeof refreshSimplePreallocDisplayInline === 'function') {
      refreshSimplePreallocDisplayInline();
    }
    if (typeof refreshSimplePreallocAutoFitHint === 'function') {
      refreshSimplePreallocAutoFitHint();
    }
    if (typeof refreshAirdropDisplayInline === 'function') {
      refreshAirdropDisplayInline();
    }
    if (typeof refreshAirdropCostDisplays === 'function') {
      refreshAirdropCostDisplays();
    }
    if (typeof updateAllocationSummary === 'function') {
      updateAllocationSummary();
    }
    return;
  }
  renderSimpleConfig();
}

// Effective support SOL value — the stored value, clamped up to the
// auto-back floor when Auto-back is on and preallocation is enabled.
// This is the single source of truth for "what SOL value should we
// actually use right now?". Used by the inline display refresh, by
// deriveSupportConfigFromSimple (for the wire format), and by the
// render-time display computation in renderSimpleConfig. Keeping the
// clamp logic in one place avoids the prior bug where the floor was
// only applied at render time, leaving the wire format and inline
// displays stale during typing (when the focus guard skips render).
//
// Returns the stored value as-is if Auto-back is off, preallocation
// is off, or the recommended floor can't be computed (e.g. cold SOL
// price cache, no market cap entered yet).
function effectiveSupportSolValue() {
  const stored = Number(simpleConfig.supportSolValue) || 0;
  if (!simpleConfig.supportAutoSize || !simpleConfig.preallocationEnabled) {
    return stored;
  }
  const rec = recommendedSupportSolForPreallocation(
    Number(simpleConfig.preallocationPercent) || 0,
  );
  if (!Number.isFinite(rec) || rec <= 0) return stored;
  return rec > stored ? rec : stored;
}

// Standalone version of the in-render refreshSimpleSupportDisplay
// helper. Re-queries the DOM each call rather than closing over the
// element references, so it can be invoked from anywhere (e.g. from
// resolvePoolQuote's completion path when we want to refresh the
// display without doing a full re-render that would steal input
// focus). Safe to call when the simple config isn't rendered (the
// querySelector returns null and the function bails).
function refreshSimpleSupportDisplayInline() {
  const supportDisplay = document.getElementById('simpleSupportDisplay');
  if (!supportDisplay) return;
  const sp = pools.find((p) => (p.quoteToken || '').toUpperCase() === 'SOL');
  const solUsd = sp && Number(sp.resolvedPriceUsd) > 0 ? Number(sp.resolvedPriceUsd) : null;
  // Read the EFFECTIVE value (clamped to floor) so the display reflects
  // what's actually going to land in the wire format — not just what
  // the user has typed. During typing with Auto-back on, a value below
  // the floor still shows the floor's USD figure here, so the user
  // sees the honest buy-wall size.
  const sv = effectiveSupportSolValue();
  const dp = clampSupportDepth(simpleConfig.supportDepthPct);
  const usd = solUsd && sv > 0 ? sv * solUsd : null;

  let text;
  if (usd != null) {
    text = `≈ $${formatUsdRoughly(usd)} buy wall, launch to -${dp}%`;
  } else if (sv > 0) {
    text = `(USD value will show once SOL price resolves; range -${dp}%)`;
  } else {
    text = `single-sided quote liquidity covering -${dp}% below launch`;
  }

  if (simpleConfig.preallocationEnabled && usd != null) {
    const mcap = parseNumberInput(document.getElementById('targetMarketCap'));
    const pp = Number(simpleConfig.preallocationPercent) || 0;
    if (Number.isFinite(mcap) && mcap > 0 && pp > 0) {
      const preallocUsd = mcap * pp / 100;
      const coverage = preallocUsd > 0 ? usd / preallocUsd : 1;
      if (coverage >= 1) {
        text += ` · fully backs preallocation ✓`;
      } else {
        const pct = Math.round(coverage * 100);
        text += ` · backs ${pct}% of preallocation`;
      }
    }
  }
  supportDisplay.textContent = text;
}

// Same idea for the preallocation display — refresh the inline text
// values (token count, USD figure) without touching the input element
// the user is typing into. Reads target market cap and token supply
// from their page-level input elements; both live outside the simple
// config body so they survive any render.
function refreshSimplePreallocDisplayInline() {
  const preallocDisplay = document.getElementById('simplePreallocDisplay');
  if (!preallocDisplay) return;
  const tsi = parseNumberInput(document.getElementById('tokenSupply'));
  const tmi = parseNumberInput(document.getElementById('targetMarketCap'));
  const pp = Number(simpleConfig.preallocationPercent) || 0;
  const tk = Number.isFinite(tsi) && tsi > 0 && pp > 0 ? tsi * pp / 100 : null;
  const us = Number.isFinite(tmi) && tmi > 0 && pp > 0 ? tmi * pp / 100 : null;
  preallocDisplay.textContent = (tk != null && us != null)
    ? `≈ ${tk.toLocaleString(undefined, { maximumFractionDigits: 0 })} tokens · $${formatUsdRoughly(us)}`
    : (tk != null
        ? `≈ ${tk.toLocaleString(undefined, { maximumFractionDigits: 0 })} tokens`
        : (us != null
            ? `≈ $${formatUsdRoughly(us)}`
            : 'enter supply and market cap above to see values'));
}

// Update the auto-fit hint annotation next to the preallocation display.
// Shows "⇡ auto-fit: 10% → 20.1% to cover airdrop" when the effective
// preallocation % is higher than what the user typed (because the
// airdrop list demanded more). The input itself displays the effective
// value; this hint exists so the user understands that the input value
// is NOT their last-typed value but a transient auto-fit bump. Hidden
// when typed == effective or auto-fit is off.
function refreshSimplePreallocAutoFitHint() {
  const hint = document.getElementById('simplePreallocAutoFitHint');
  if (!hint) return;
  const autoFitOn = simpleConfig.preallocationAutoFit !== false;
  const typed = Number(simpleConfig.preallocationPercentInput) || 0;
  const eff = Number(simpleConfig.preallocationPercent) || 0;
  const raised = autoFitOn && simpleConfig.preallocationEnabled
    && Math.abs(eff - typed) > 0.05;
  if (raised) {
    // Tell the user the input value isn't their typed value — auto-fit
    // raised it. Showing both numbers (`from X% to Y%`) makes the gap
    // visible at a glance and signals "this is a transient bump; your
    // typed floor is preserved."
    hint.textContent = `⇡ auto-fit: ${typed}% → ${eff.toFixed(eff % 1 === 0 ? 0 : 1)}% to cover airdrop`;
    hint.style.display = '';
  } else {
    hint.style.display = 'none';
  }
}

// Format a SOL total with magnitude-appropriate precision. Avoids
// float-tail noise on small contributions (1.0000000001 SOL) and
// useless decimals on large totals (1,234.567 SOL).
function formatSolTotal(s) {
  if (!Number.isFinite(s) || s <= 0) return '0';
  if (s < 1) return s.toFixed(4);
  if (s < 1000) return s.toFixed(2);
  return s.toLocaleString(undefined, { maximumFractionDigits: 0 });
}

// Truncate a base58 address with a middle ellipsis: first 6 chars,
// ellipsis, last 6 chars. Short enough to fit a table cell, distinctive
// enough that the user can verify against their CSV. The full address
// remains in simpleConfig.airdrop.parsedRows for execution.
function truncateAddressMiddle(s, head = 6, tail = 6) {
  if (typeof s !== 'string') return '';
  return s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`;
}

// Build the airdrop sub-section's content (error notification + wallet/
// SOL totals line). NO per-wallet table — that lives in the unified
// preallocation breakdown table outside the airdrop panel. This helper
// is for the contents of [data-airdrop-results].
//
// Reads from simpleConfig.airdrop (parsedRows, parseError, budgetError)
// which the caller is responsible for populating before invoking.
function buildAirdropResultsHtml() {
  const airdrop = simpleConfig.airdrop;
  let totalTokens = 0;
  let totalReady = true;
  let totalSol = 0;
  for (const r of airdrop.parsedRows) {
    totalSol += r.sol;
    if (r.tokens == null) { totalReady = false; continue; }
    totalTokens += r.tokens;
  }
  const supply = parseNumberInput(document.getElementById('tokenSupply'));
  const pPct = Number(simpleConfig.preallocationPercent) || 0;
  const budgetTokens = (Number.isFinite(supply) && supply > 0 && pPct > 0)
    ? supply * pPct / 100 : null;
  const walletCountText = `${airdrop.parsedRows.length} wallet${airdrop.parsedRows.length === 1 ? '' : 's'}`;
  const solTotalText = `${formatSolTotal(totalSol)} SOL contributed`;
  const summaryLineHtml = (() => {
    if (airdrop.parsedRows.length === 0) return '';
    if (budgetTokens == null || !totalReady) {
      return `<p class="is-size-7 has-text-grey mt-2 mb-0">${walletCountText} · ${solTotalText} (enter supply, market cap, and let SOL price resolve to see token amounts)</p>`;
    }
    const usedPct = (totalTokens / budgetTokens) * 100;
    const colorClass = airdrop.budgetError ? 'has-text-danger' : 'has-text-success';
    return `<p class="is-size-7 mt-2 mb-0 ${colorClass}">
      ${walletCountText} · ${solTotalText} · ${formatTokenDisplay(totalTokens)} of ${formatTokenDisplay(budgetTokens)} budget tokens (${usedPct.toFixed(1)}%)
    </p>`;
  })();
  const errorHtml = (() => {
    const err = airdrop.parseError || airdrop.budgetError;
    if (!err) return '';
    return `<div class="notification is-danger is-light py-2 px-3 mt-2 mb-0 is-size-7">
      <strong>⚠</strong> ${escapeHtml(err)}
    </div>`;
  })();
  // Soft duration warning for very large lists. No cap — the airdrop runs
  // sequentially (pacing + per-tx confirmation), so a big list is purely a
  // time commitment, and that's the user's call. ~4s/recipient matches the
  // estimate runTransfer logs at execution time.
  const sizeWarningHtml = (() => {
    const n = airdrop.parsedRows.length;
    if (n <= 1000) return '';
    const estMinutes = Math.ceil((n * 4) / 60);
    return `<div class="notification is-warning is-light py-2 px-3 mt-2 mb-0 is-size-7">
      <strong>⚠</strong> ${n.toLocaleString()} recipients is a lot — the airdrop sends
      one transaction per wallet and will take roughly ${estMinutes} minutes during the
      final transfer. The app must stay open the whole time. Delivery is tracked
      per-recipient, so if anything interrupts it, a retry only sends to wallets
      that haven't received theirs yet.
    </div>`;
  })();
  return errorHtml + sizeWarningHtml + summaryLineHtml;
}

// Render (or hide) the pre-transfer airdrop summary panel in step 6.
// Shows BEFORE the user clicks Transfer Assets so the airdrop step isn't
// a surprise. Safe to call anytime — it derives state from
// buildAirdropTransferPayload() and bails to "hidden" when no airdrop
// payload is currently warranted (no preallocation, customize mode,
// empty CSV, etc).
//
// Triggered from activateStep when entering step 6 and from runTransfer
// after a successful sweep clears the panel out of the way.
function renderAirdropPreTransferSummary() {
  const panel = document.getElementById('airdropPreTransferSummary');
  if (!panel) return;
  const payload = buildAirdropTransferPayload();
  if (!payload || !payload.recipients || payload.recipients.length === 0) {
    panel.classList.add('hidden');
    return;
  }
  panel.classList.remove('hidden');
  const n = payload.recipients.length;
  const totalTokens = payload.recipients.reduce(
    (s, r) => s + (Number(r.tokens) || 0), 0,
  );
  const fmtTokens = (v) => Number(v).toLocaleString(
    undefined, { maximumFractionDigits: 4 },
  );

  const countEl = document.getElementById('airdropPreCount');
  if (countEl) countEl.textContent = String(n);
  const sEl = document.getElementById('airdropPreCountS');
  if (sEl) sEl.textContent = n === 1 ? '' : 's';
  const tokensEl = document.getElementById('airdropPreTokens');
  if (tokensEl) tokensEl.textContent = fmtTokens(totalTokens);

  const list = document.getElementById('airdropPreRecipientList');
  if (list) {
    list.innerHTML = payload.recipients.map((r) => {
      const wAddr = String(r.wallet || '');
      const tokens = fmtTokens(r.tokens);
      // <code> for semantic correctness — wallet addresses are
      // code-like identifiers. The global CSS gives <code> a subtle
      // parchment-tinted background (not Bulma's default stark white)
      // that fits the theme. Full address (no truncation): there's
      // plenty of room here, and showing 44 chars lets the user
      // visually verify rather than trusting a 6+6 truncation that
      // can collide between similar-prefix wallets.
      return `<div class="is-size-7" style="margin: 0.15rem 0; word-break: break-all;">
        <code style="font-size: 11px;">${escapeHtml(wAddr || '—')}</code>
        <span class="has-text-grey"> · </span>
        ${escapeHtml(tokens)} tokens
      </div>`;
    }).join('');
  }
}

function hideAirdropPreTransferSummary() {
  const panel = document.getElementById('airdropPreTransferSummary');
  if (panel) panel.classList.add('hidden');
}

// Build the unified "Where does the preallocation go?" breakdown table.
// Lives directly under the preallocation row, ABOVE the airdrop sub-
// section. Three render variants:
//
//   - Preallocation OFF: returns empty string (table not shown).
//   - Preallocation ON, no airdrop (or airdrop disabled / empty rows):
//     single "Launch wallet" row holding the entire preallocation, plus
//     the total row.
//   - Preallocation ON, airdrop enabled with rows:
//     "Airdrop (N wallets)" collapsible row showing the airdrop total,
//     "Launch wallet" row with the leftover, and the total row. When the
//     airdrop row is expanded (controlled by simpleConfig.airdrop
//     ._breakdownExpanded), the per-wallet rows render beneath it.
//
// Returns just the inner <table> contents — caller wraps in any
// container needed. Empty string when there's nothing to show.
function buildPreallocationBreakdownHtml() {
  if (!simpleConfig.preallocationEnabled) return '';

  const supply = parseNumberInput(document.getElementById('tokenSupply'));
  const mcap = parseNumberInput(document.getElementById('targetMarketCap'));
  const pPct = Number(simpleConfig.preallocationPercent) || 0;
  if (!Number.isFinite(supply) || supply <= 0 || pPct <= 0) {
    // Without supply / prealloc%, we can't compute concrete numbers.
    // Show a gentle prompt rather than an empty section.
    return `<p class="is-size-7 has-text-grey mt-2 mb-0">
      Enter supply above to see the preallocation breakdown.
    </p>`;
  }
  const totalTokens = supply * pPct / 100;
  const totalUsd = Number.isFinite(mcap) && mcap > 0 ? mcap * pPct / 100 : null;

  // Format helpers used in every row, hoisted here so we don't re-define
  // them across the branches below.
  const fmtTokens = (n) => n.toLocaleString(undefined, { maximumFractionDigits: 0 });
  const fmtPct = (n) => n.toFixed(2) + '%';
  const fmtUsd = (n) => n != null ? `$${formatUsdRoughly(n)}` : '<span class="has-text-grey">—</span>';

  const airdrop = simpleConfig.airdrop;
  const airdropActive = airdrop.enabled && airdrop.parsedRows.length > 0;

  // Compute airdrop totals only when actually active. Otherwise the
  // whole preallocation is "leftover" sitting in the launch wallet.
  let airdropTokens = 0;
  let airdropTokensReady = true;
  let airdropSol = 0;
  if (airdropActive) {
    for (const r of airdrop.parsedRows) {
      airdropSol += r.sol;
      if (r.tokens == null) { airdropTokensReady = false; continue; }
      airdropTokens += r.tokens;
    }
  }

  // When over-budget, the displayed table clamps the airdrop row to
  // the budget (per UX decision — show what would actually happen,
  // not a negative leftover row). The error message above the table
  // surfaces the overage. When the airdrop row's token total is
  // unknown (incomplete inputs), the leftover can't be computed
  // either — show "—" for both.
  const airdropTokensDisplay = airdropTokensReady
    ? Math.min(airdropTokens, totalTokens)
    : null;
  const leftoverTokens = airdropTokensReady
    ? Math.max(0, totalTokens - airdropTokens)
    : null;
  const airdropPct = (airdropTokensDisplay != null && totalTokens > 0)
    ? (airdropTokensDisplay / supply) * 100 : null;
  const leftoverPct = (leftoverTokens != null && supply > 0)
    ? (leftoverTokens / supply) * 100 : null;
  const airdropUsd = (airdropPct != null && Number.isFinite(mcap) && mcap > 0)
    ? mcap * airdropPct / 100 : null;
  const leftoverUsd = (leftoverPct != null && Number.isFinite(mcap) && mcap > 0)
    ? mcap * leftoverPct / 100 : null;

  // Build per-wallet rows for the expanded airdrop section. Each row is
  // a <tr> with a leading indent (left padding) to visually nest under
  // the airdrop summary row. Initial visibility tracks the persisted
  // _breakdownExpanded state so re-renders don't collapse a row group
  // the user just opened. The click handler toggles both the state
  // and the display style.
  const initialWalletRowDisplay = airdrop._breakdownExpanded ? '' : 'none';
  const MAX_WALLET_ROWS = 10;
  const walletRowsHtml = airdropActive
    ? airdrop.parsedRows.slice(0, MAX_WALLET_ROWS).map((r) => {
        const tokensCell = r.tokens != null ? fmtTokens(r.tokens) : '<span class="has-text-grey">—</span>';
        const pctCell = (r.tokens != null && supply > 0)
          ? fmtPct((r.tokens / supply) * 100)
          : '<span class="has-text-grey">—</span>';
        const usdCell = r.usd != null ? `$${formatUsdRoughly(r.usd)}` : '<span class="has-text-grey">—</span>';
        return `<tr data-airdrop-wallet-row style="display: ${initialWalletRowDisplay};">
          <td class="is-family-monospace is-size-7" style="padding-left: 2.25rem;">${escapeHtml(truncateAddressMiddle(r.wallet))}
            <span class="has-text-grey is-size-7 ml-2">${r.sol} SOL</span></td>
          <td class="has-text-right">${tokensCell}</td>
          <td class="has-text-right has-text-grey is-size-7">${pctCell}</td>
          <td class="has-text-right has-text-grey is-size-7">${usdCell}</td>
        </tr>`;
      }).join('')
    : '';
  const moreRowsCount = airdropActive
    ? Math.max(0, airdrop.parsedRows.length - MAX_WALLET_ROWS)
    : 0;
  const moreRowsHtml = moreRowsCount > 0
    ? `<tr data-airdrop-wallet-row style="display: ${initialWalletRowDisplay};">
        <td colspan="4" class="has-text-grey has-text-centered is-size-7" style="padding-left: 2.25rem;">
          <em>… and ${moreRowsCount} more recipient${moreRowsCount === 1 ? '' : 's'} (full list will be processed at distribution time)</em>
        </td>
      </tr>`
    : '';

  // Airdrop summary row — clickable, with a chevron that rotates when
  // expanded. The chevron's state is tracked via
  // simpleConfig.airdrop._breakdownExpanded so it survives re-renders.
  // Click handler in renderSimpleConfig toggles the data-* attribute
  // and the wallet-row display.
  const chevronClass = airdrop._breakdownExpanded ? 'fa-chevron-down' : 'fa-chevron-right';
  const airdropSummaryRowHtml = airdropActive
    ? `<tr data-airdrop-summary-row class="is-clickable" style="cursor: pointer;">
        <td>
          <span class="icon is-small mr-1" style="transition: transform 0.15s;"><i class="fas ${chevronClass}"></i></span>
          <strong>Airdrop</strong>
          <span class="has-text-grey is-size-7 ml-1">(${airdrop.parsedRows.length} wallet${airdrop.parsedRows.length === 1 ? '' : 's'} · ${formatSolTotal(airdropSol)} SOL)</span>
        </td>
        <td class="has-text-right">${airdropTokensDisplay != null ? fmtTokens(airdropTokensDisplay) : '<span class="has-text-grey">—</span>'}</td>
        <td class="has-text-right has-text-grey is-size-7">${airdropPct != null ? fmtPct(airdropPct) : '<span class="has-text-grey">—</span>'}</td>
        <td class="has-text-right has-text-grey is-size-7">${fmtUsd(airdropUsd)}</td>
      </tr>`
    : '';

  // Launch wallet row — shows the leftover (or the full preallocation
  // when airdrop isn't active). The hint text differs by case so the
  // user understands what these tokens are for.
  const launchWalletTokens = airdropActive ? leftoverTokens : totalTokens;
  const launchWalletPct = airdropActive ? leftoverPct : pPct;
  const launchWalletUsd = airdropActive ? leftoverUsd : totalUsd;
  const launchWalletHint = airdropActive
    ? 'unallocated — held in launch wallet for manual distribution after launch'
    : 'held in launch wallet for manual distribution after launch';
  const launchWalletRowHtml = `
    <tr>
      <td>
        <strong>Launch wallet</strong>
        <span class="has-text-grey is-size-7 ml-2">${launchWalletHint}</span>
      </td>
      <td class="has-text-right">${launchWalletTokens != null ? fmtTokens(launchWalletTokens) : '<span class="has-text-grey">—</span>'}</td>
      <td class="has-text-right has-text-grey is-size-7">${launchWalletPct != null ? fmtPct(launchWalletPct) : '<span class="has-text-grey">—</span>'}</td>
      <td class="has-text-right has-text-grey is-size-7">${fmtUsd(launchWalletUsd)}</td>
    </tr>
  `;

  // Total row — boldface, no hint text. Matches the funding breakdown
  // table style on step 3 (`has-text-weight-bold` plus monospace
  // numbers via the existing td styling).
  const totalRowHtml = `
    <tr class="has-text-weight-bold" style="border-top: 1px solid var(--rule, rgba(28,22,16,0.15));">
      <td>Total preallocation</td>
      <td class="has-text-right">${fmtTokens(totalTokens)}</td>
      <td class="has-text-right">${fmtPct(pPct)}</td>
      <td class="has-text-right">${fmtUsd(totalUsd)}</td>
    </tr>
  `;

  return `
    <table class="table is-narrow is-fullwidth is-size-7 mt-2 mb-0" style="background: transparent;">
      <thead>
        <tr>
          <th>Recipient</th>
          <th class="has-text-right">Tokens</th>
          <th class="has-text-right">% of supply</th>
          <th class="has-text-right">≈ USD</th>
        </tr>
      </thead>
      <tbody>
        ${airdropSummaryRowHtml}
        ${walletRowsHtml}
        ${moreRowsHtml}
        ${launchWalletRowHtml}
        ${totalRowHtml}
      </tbody>
    </table>
  `;
}

// Re-parse the airdrop CSV and re-render the results area in place
// (without re-rendering the whole simple-config — that would steal
// focus from the textarea). Called from the textarea/file/clear
// handlers, and also from the prealloc-% input handler since changing
// the prealloc % changes the budget and may flip the budget verdict.
function refreshAirdropDisplayInline() {
  const details = document.getElementById('simpleAirdropDetails');
  if (!details) return;
  const airdrop = simpleConfig.airdrop;

  // Step 1: parse + annotate. parsedRows feeds both the budget check
  // and the auto-fit floor calculation. Annotation adds per-row token
  // amounts based on supply / market cap / SOL price; rows without
  // those inputs land as { tokens: null, usd: null }.
  const parse = parseAirdropCsv(airdrop.csvText || '');
  const annotated = annotateAirdropRowsWithTokens(parse.rows);
  airdrop.parsedRows = annotated.rows;
  airdrop.parseError = parse.error;

  // Step 2: recompute the effective preallocation %. Auto-fit reads
  // parsedRows we just populated above; without this step running
  // BEFORE the budget check, the budget would test against the stale
  // pre-CSV percentage and fire a false "over budget" error even when
  // auto-fit has already raised the budget to accommodate.
  const effChanged = recomputeEffectivePreallocationPercent();

  // Step 3: now check the budget against the freshly-computed
  // effective %. With auto-fit on this almost never fires; with
  // auto-fit off it surfaces the over-budget condition for the user
  // to fix manually.
  airdrop.budgetError = airdropBudgetError(annotated.totalTokens);

  // Step 4: cascade auto-fit side-effects (support SOL, prealloc
  // display, hint, pool rebuild) if the effective % moved.
  if (effChanged) {
    // Cascade auto-fit side-effects (support SOL, prealloc display,
    // hint, pool rebuild). Customize-mode guard: skip the simple-mode
    // support-side-effects and the destructive pool rebuild. The
    // inline display refreshers (support display, prealloc display)
    // are safe no-ops when their target elements aren't visible.
    if (simpleConfig.mode !== 'customize') {
      if (simpleConfig.preallocationEnabled && simpleConfig.supportAutoSize) {
        const recommendedSol = recommendedSupportSolForPreallocation(
          simpleConfig.preallocationPercent,
        );
        if (recommendedSol != null && recommendedSol > 0
            && recommendedSol > (Number(simpleConfig.supportSolValue) || 0)) {
          simpleConfig.supportSolValue = recommendedSol;
        }
      }
    }
    // Push the new effective percent into the % input element itself
    // so the user sees the value that's actually in use. We preserve
    // the user's last-typed value separately on
    // simpleConfig.preallocationPercentInput — when the airdrop is
    // trimmed and the effective drops back below the typed floor,
    // the input will display the typed floor again.
    //
    // Guard: don't write the input value if the user is currently
    // focused there typing. Clobbering a focused field would steal
    // their input mid-keystroke. The auto-fit hint annotation gives
    // them a separate signal in that case.
    const pctInputEl = document.getElementById('simplePreallocPctInput');
    if (pctInputEl && document.activeElement !== pctInputEl) {
      const eff = Number(simpleConfig.preallocationPercent) || 0;
      pctInputEl.value = eff.toFixed(eff % 1 === 0 ? 0 : 1);
    }
    // Same trick for the support SOL input — the cascade may have bumped
    // simpleConfig.supportSolValue (auto-back raising the floor to back
    // the new preallocation %). Without pushing the new value back to
    // the input element here, the user sees a stale number in the
    // support field while the "$X buy wall" display text correctly
    // reflects the new value — a confusing contradiction.
    //
    // Same focus guard as above: don't clobber the user's in-progress
    // typing. The refreshSimpleSupportDisplayInline call below updates
    // the secondary "$X buy wall" text either way.
    if (simpleConfig.mode !== 'customize') {
      const supportSolEl = document.getElementById('simpleSupportSolInput');
      if (supportSolEl && simpleConfig.supportAutoSize
          && document.activeElement !== supportSolEl) {
        const sv = Number(simpleConfig.supportSolValue) || 0;
        supportSolEl.value = sv.toFixed(Math.abs(sv) >= 10 ? 1 : 3);
      }
    }
    refreshSimplePreallocDisplayInline();
    refreshSimplePreallocAutoFitHint();
    refreshSimpleSupportDisplayInline();
    // Customize-mode guard: rebuildPoolsFromSimpleDebounced would
    // schedule a destructive rebuild that wipes user pool customizations
    // when it fires 250ms later. Use the mode-aware helper instead.
    preallocRebuildDebouncedIfApplicable();
    // Auto-fit raised the effective preallocation %, which raised the
    // auto-back support SOL, which raises the server-side cost estimate
    // (more SOL committed to the support position = more SOL the user
    // must fund). The pool-rebuild above schedules in 250ms; we also
    // need to schedule a fresh cost-preview fetch so _lastCostEstimate
    // updates. Without this, refreshAirdropCostDisplays at the bottom
    // of this function would refresh the displayed total using the
    // STALE _lastCostEstimate.totalSol, and the user wouldn't see the
    // support bump until something else triggered a fetch (toggling
    // prealloc — which is exactly the workaround the user reported).
    if (typeof requestCostPreviewUpdate === 'function') {
      requestCostPreviewUpdate();
    }
  }

  // Step 5: render the file name placeholder + clear button state.
  const fileName = document.getElementById('simpleAirdropFileName');
  if (fileName) {
    fileName.textContent = airdrop.csvText
      ? `${airdrop.parsedRows.length} row${airdrop.parsedRows.length === 1 ? '' : 's'} loaded`
      : 'no file chosen';
  }
  const clearBtn = document.getElementById('simpleAirdropClearBtn');
  if (clearBtn) {
    clearBtn.disabled = !airdrop.csvText;
  }

  // Step 6: render the airdrop results panel (error + summary line).
  // Reads airdrop.budgetError which we set in step 3 against the
  // post-auto-fit effective %.
  const interior = details.querySelector('[data-airdrop-results]');
  if (interior) {
    interior.innerHTML = buildAirdropResultsHtml();
  }

  // Step 7: render the breakdown table. Reads the effective preallo­
  // cation % and the parsed airdrop rows; both have been updated by
  // the steps above.
  const breakdownContainer = document.querySelector('[data-prealloc-breakdown]');
  if (breakdownContainer) {
    breakdownContainer.innerHTML = buildPreallocationBreakdownHtml();
  }

  // Step 8: refresh the displayed cost. Airdrop execution cost (ATA
  // rent + tx fees) rolls into the Est. Cost shown on the token
  // preview card AND the cost preview card. Both surfaces need to
  // track row-count changes.
  refreshAirdropCostDisplays();
}

// Push the current airdrop execution cost into the two on-screen cost
// surfaces (preview card's Est. Cost tile, and the cost preview card
// below the form). Both add the airdrop cost on top of the server's
// launch funding estimate. Safe to call any time — no-op when
// _lastCostEstimate hasn't arrived yet (cost preview card stays in
// whatever state it was; updatePreviewStats handles its own missing-
// data case).
//
// Used as the single chokepoint for "airdrop changed, refresh displayed
// cost" so the airdrop toggle, CSV edits, and any future trigger can
// all funnel through the same path. Without this, each new trigger
// would need to remember to call both updatePreviewStats and
// setCostPreviewState individually.
function refreshAirdropCostDisplays() {
  if (typeof updatePreviewStats === 'function') {
    updatePreviewStats();
  }
  if (_lastCostEstimate && Number.isFinite(_lastCostEstimate.totalSol)
      && typeof setCostPreviewState === 'function') {
    const airdropExecutionSol = computeAirdropExecutionCostSol();
    setCostPreviewState('ready', _lastCostEstimate.totalSol + airdropExecutionSol);
  }
}

// Paint the simple-config UI into #simpleConfigBody. Called whenever
// simpleConfig changes or when switching mode. Uses textContent /
// dataset on the elements we listen to, but constructs them with
// innerHTML for terseness — none of the values are user-controlled
// strings, so injection isn't a concern.
function renderSimpleConfig() {
  const body = document.getElementById('simpleConfigBody');
  if (!body) return;

  // Preserve the page scroll position across the full innerHTML rebuild
  // below. This section is wiped and rebuilt on every toggle; while
  // body.innerHTML is momentarily empty the page collapses to a shorter
  // height, the browser clamps the scroll offset to the new (smaller)
  // maximum, and it is not restored when the content re-expands — so the
  // page lurches. It's most visible with a tall section (preallocation +
  // airdrop loaded) and a control toggled near the bottom (ladder, split).
  // Capturing the offset here and restoring it at the end of this function
  // pins the view so the control the user just clicked stays put.
  const _scroller = document.scrollingElement || document.documentElement;
  const _savedScrollTop = _scroller.scrollTop;

  // Detach the Lock-liquidity field (if it's currently inside body
  // from a prior render) before we wipe body.innerHTML. The field is
  // a single canonical DOM element that lives at #lockPositionsField,
  // physically moved between simple-mode and customize-mode slots by
  // applySimpleConfigMode + relocateLockPositionsField. Without this
  // detach, body.innerHTML='...' would destroy the element along with
  // its event listeners and state, breaking the toggle.
  //
  // We move it temporarily to its page-level home; the post-render
  // relocateLockPositionsField call moves it back into the new slot
  // inside the freshly-rendered Advanced details.
  const lockField = document.getElementById('lockPositionsField');
  const pageHome = document.getElementById('lockPositionsSlotPage');
  if (lockField && pageHome && lockField.parentElement !== pageHome) {
    pageHome.appendChild(lockField);
  }

  // Defensive: remove any existing #preallocationBlock from the DOM
  // before rebuilding. Unlike lockField (which is a long-lived element
  // with persistent state we want to preserve), the preallocation
  // block's contents are entirely state-driven — renderSimpleConfig
  // will build a fresh block with fresh handlers as part of the
  // innerHTML below. Without this cleanup, a previously-relocated
  // block (e.g. moved to #customizePreallocSlot when the user was in
  // customize mode) would persist after the rebuild and create
  // duplicate IDs, breaking getElementById calls in refresh paths.
  document.querySelectorAll('#preallocationBlock').forEach((b) => b.remove());

  // Defensive: if simpleConfig.flywheelKey points at an unavailable
  // flywheel (e.g. someone re-flagged 'reserve' as unavailable, or a
  // future session-restore path loaded a stale key), fall back to the
  // first available one. Without this, the dropdown would render with
  // a disabled option pre-selected, which is awkward and confusing.
  const currentFw = FLYWHEELS[simpleConfig.flywheelKey];
  if (!currentFw || !currentFw.available) {
    const firstAvailable = Object.values(FLYWHEELS).find((fw) => fw.available);
    if (firstAvailable) {
      simpleConfig.flywheelKey = firstAvailable.key;
    }
  }

  // Build the list of <option> entries from FLYWHEELS, marking
  // unavailable ones as disabled so users see them but can't pick them.
  const options = Object.values(FLYWHEELS).map((fw) => {
    const selected = fw.key === simpleConfig.flywheelKey ? 'selected' : '';
    const disabled = !fw.available ? 'disabled' : '';
    return `<option value="${escapeHtml(fw.key)}" ${selected} ${disabled}>${escapeHtml(fw.label)}</option>`;
  }).join('');

  const dropdownDisabled = !simpleConfig.flywheelEnabled ? 'disabled' : '';
  const checked = simpleConfig.flywheelEnabled ? 'checked' : '';
  // Slider value — clamp at render time too, in case anything pushed it
  // out of range. The defensive clamp in rebuildPoolsFromSimple is the
  // ultimate authority but it's nicer if the UI shows the right number.
  const sliderValue = Math.max(
    FLYWHEEL_MIN_PERCENT,
    Math.min(FLYWHEEL_MAX_PERCENT, Number(simpleConfig.flywheelPercent) || DEFAULT_FLYWHEEL_PERCENT),
  );

  // Split-LP state. Slider value clamped here too — same belt-and-
  // suspenders rationale as the flywheel slider above.
  const splitChecked = simpleConfig.splitEnabled ? 'checked' : '';
  const splitSliderDisabled = !simpleConfig.splitEnabled ? 'disabled' : '';
  const splitValue = Math.max(
    SPLIT_MIN_COUNT,
    Math.min(SPLIT_MAX_COUNT, Number(simpleConfig.splitCount) || 1),
  );
  const splitReadoutText = `${splitValue} ${splitValue === 1 ? 'position' : 'positions'}`;

  // Help text varies based on toggle state. When on, describe what the
  // flywheel does. When off, describe what the simple SOL launch does.
  const helpText = simpleConfig.flywheelEnabled
    ? 'A flywheel routes a portion of trade fees into a reserve token like XLRT, building accumulation pressure on it. Recommended for most launches.'
    : 'Your token will launch in a single SOL pool with all supply allocated. No flywheel mechanic — simple and standard.';

  // Ladder state. Disabled sliders when toggle is off — keeps the visible
  // values but conveys "this isn't doing anything" to the user.
  const ladderChecked = simpleConfig.ladderEnabled ? 'checked' : '';
  const ladderSlidersDisabled = simpleConfig.ladderEnabled ? '' : 'disabled';
  const ladderPercent = Math.max(
    LADDER_MIN_PERCENT,
    Math.min(LADDER_MAX_PERCENT, Number(simpleConfig.ladderPercent) || LADDER_DEFAULT_PERCENT),
  );
  const ladderBandCount = Math.max(
    LADDER_MIN_BANDS,
    Math.min(LADDER_MAX_BANDS, Number(simpleConfig.ladderBandCount) || LADDER_DEFAULT_BANDS),
  );
  // Selected ladder strategy (volatility shape), defaulting to Doubling
  // if the stored value isn't a known strategy id. LADDER_STRATEGY_IDS
  // and LADDER_STRATEGY_META are resolved at render time (runtime), so
  // referencing them here is safe even though META lives in a later
  // module.
  const ladderStrategy = LADDER_STRATEGY_IDS.includes(simpleConfig.ladderStrategy)
    ? simpleConfig.ladderStrategy
    : LADDER_DEFAULT_STRATEGY;

  // Preallocation state. Inputs only matter when the toggle is on; we
  // still render their values (just disabled) so the user can see what
  // would happen at re-enable. Clamp the percent input to (0, 99] —
  // 100% preallocation means no LP at all, which isn't a launch.
  //
  // Refresh the effective preallocation percent before reading: that
  // way handlers that mutated csvText or other inputs since the last
  // render see their effects propagate to the displayed values here.
  // (No-op when the value is already current.)
  recomputeEffectivePreallocationPercent();
  const preallocChecked = simpleConfig.preallocationEnabled ? 'checked' : '';
  const preallocDisabled = simpleConfig.preallocationEnabled ? '' : 'disabled';
  // EFFECTIVE percent — what every downstream computation should use.
  // Includes the auto-fit floor.
  const preallocPct = Math.max(0, Math.min(
    99, Number(simpleConfig.preallocationPercent) || 1,
  ));
  // TYPED percent — what the user last typed into the input. Shown in
  // the input itself so auto-fit's bumps don't clobber what the user
  // typed. When auto-fit is off these are the same value.
  const preallocPctInputValue = Math.max(0, Math.min(
    99, Number(simpleConfig.preallocationPercentInput) || preallocPct,
  ));
  // Auto-fit state and a hint string for when auto-fit raised the
  // effective above the typed. We only show the hint when there's an
  // actual discrepancy and the user might wonder where the bump came
  // from — otherwise it'd just be visual noise.
  const autoFitChecked = simpleConfig.preallocationAutoFit !== false ? 'checked' : '';
  const autoFitRaised = simpleConfig.preallocationAutoFit !== false
    && Math.abs(preallocPct - preallocPctInputValue) > 0.05;

  // Airdrop shortfall: the airdrop list needs MORE tokens than the
  // effective preallocation reserves. Reachable two ways — auto-fit is
  // off and the typed percent is too low, or auto-fit is on but the list
  // needs more than the 99% clamp. Either way the launch proceeds happily
  // and the airdrop then runs the wallet dry partway down the list, so
  // some recipients silently get nothing. Warn at config time, where it
  // is still a one-number fix.
  const airdropNeedPct = airdropRequiredPreallocationPercent();
  const airdropShortfallPct = (Number.isFinite(airdropNeedPct) && airdropNeedPct > preallocPct + 0.05)
    ? Number((airdropNeedPct - preallocPct).toFixed(2))
    : null;

  // Compute display values for the preallocation row. Token amount uses
  // the total supply input (or 0 if unset). USD value uses the
  // targetMarketCap input. Both gracefully degrade to a dash when the
  // user hasn't entered the relevant input yet — the row stays readable.
  const totalSupplyInput = parseNumberInput(document.getElementById('tokenSupply'));
  const targetMcInput = parseNumberInput(document.getElementById('targetMarketCap'));
  const preallocTokens = preallocChecked && Number.isFinite(totalSupplyInput) && totalSupplyInput > 0
    ? totalSupplyInput * preallocPct / 100
    : null;
  const preallocUsd = preallocChecked && Number.isFinite(targetMcInput) && targetMcInput > 0
    ? targetMcInput * preallocPct / 100
    : null;
  const preallocDisplayText = (preallocTokens != null && preallocUsd != null)
    ? `≈ ${preallocTokens.toLocaleString(undefined, { maximumFractionDigits: 0 })} tokens · $${formatUsdRoughly(preallocUsd)}`
    : (preallocTokens != null
        ? `≈ ${preallocTokens.toLocaleString(undefined, { maximumFractionDigits: 0 })} tokens`
        : (preallocUsd != null
            ? `≈ $${formatUsdRoughly(preallocUsd)}`
            : 'enter supply and market cap above to see values'));

  // Support state. The SOL input is independent of preallocation in
  // shape (you can technically have support without preallocation —
  // it's just extra buy-side liquidity below launch), but it's most
  // useful when there IS preallocation to back. The help text spells
  // that out. We disable the input when the toggle is off (consistent
  // with how the bootstrap row works) but don't gate enabling support
  // on preallocation being on — let the user combine them as they like.
  const supportChecked = simpleConfig.supportEnabled ? 'checked' : '';
  // Depth is clamped to the supported range at render time, same belt-
  // and-suspenders pattern as the other percent sliders. The input
  // accepts integers between the min and max constants.
  const supportDepthPct = clampSupportDepth(simpleConfig.supportDepthPct);

  // Auto-back state: when on AND preallocation is also on, the SOL
  // input value is clamped to a floor equal to the preallocation USD
  // value (the user can still type a larger value for a deeper wall).
  // Without preallocation enabled there's nothing to back, so the
  // Auto-back checkbox is disabled.
  const supportAutoChecked = simpleConfig.supportAutoSize ? 'checked' : '';
  // SOL input is enabled whenever support is on. Auto-back doesn't
  // lock the input — it only enforces a MINIMUM. The clamp happens
  // at write-time in the input handler. Depth input follows the
  // toggle only; user-tunable regardless of auto-back state.
  const supportSolDisabled = simpleConfig.supportEnabled ? '' : 'disabled';
  const supportDepthDisabled = simpleConfig.supportEnabled ? '' : 'disabled';

  // Compute the displayed SOL value via the shared helper, which
  // applies the auto-back floor when applicable. Mirror the clamped
  // value into stored state so subsequent reads from
  // simpleConfig.supportSolValue (other UI paths, customize-mode
  // switch) see the same value the user is seeing.
  const displayedSupportSol = effectiveSupportSolValue();
  if (simpleConfig.supportAutoSize
      && simpleConfig.preallocationEnabled
      && displayedSupportSol > (Number(simpleConfig.supportSolValue) || 0)) {
    simpleConfig.supportSolValue = displayedSupportSol;
  }
  // USD-equivalent of the support SOL value, using the live SOL price
  // from the SOL pool if available. Falls back to no display when
  // nothing's resolved yet — better to show nothing than show a wrong
  // number.
  const solPoolForSupport = pools.find((p) => (p.quoteToken || '').toUpperCase() === 'SOL');
  const solUsdForSupport = solPoolForSupport && Number(solPoolForSupport.resolvedPriceUsd) > 0
    ? Number(solPoolForSupport.resolvedPriceUsd)
    : null;
  const supportUsd = supportChecked && solUsdForSupport && displayedSupportSol > 0
    ? displayedSupportSol * solUsdForSupport
    : null;
  // Build the static display text — same logic as refreshSimpleSupportDisplay
  // (which runs on subsequent input events) so the initial render matches
  // what the user sees after typing. Includes the preallocation-coverage
  // indicator when both features are on, so the rug-resistance link is
  // visible at first paint.
  let supportDisplayText;
  if (supportUsd != null) {
    supportDisplayText = `≈ $${formatUsdRoughly(supportUsd)} buy wall, launch to -${supportDepthPct}%`;
  } else if (supportChecked && displayedSupportSol > 0) {
    supportDisplayText = `(USD value will show once SOL price resolves; range -${supportDepthPct}%)`;
  } else {
    supportDisplayText = `single-sided quote liquidity covering -${supportDepthPct}% below launch`;
  }
  if (simpleConfig.preallocationEnabled && supportUsd != null) {
    const _mcap = parseNumberInput(document.getElementById('targetMarketCap'));
    const _pp = Number(simpleConfig.preallocationPercent) || 0;
    if (Number.isFinite(_mcap) && _mcap > 0 && _pp > 0) {
      const _preallocUsd = _mcap * _pp / 100;
      const _coverage = _preallocUsd > 0 ? supportUsd / _preallocUsd : 1;
      if (_coverage >= 1) {
        supportDisplayText += ` · fully backs preallocation ✓`;
      } else {
        supportDisplayText += ` · backs ${Math.round(_coverage * 100)}% of preallocation`;
      }
    }
  }

  // ---- Airdrop sub-section state ---------------------------------------
  // The airdrop UI sits inside the preallocation block — disabled when
  // preallocation is off. Re-parse the user's CSV every render so the
  // preview/errors stay in sync with simpleConfig.airdrop.csvText.
  // (The textarea handler keeps csvText in sync with the user's typing,
  // then triggers a render; render does the parse from there.)
  const airdrop = simpleConfig.airdrop;
  const airdropEnabled = airdrop.enabled && simpleConfig.preallocationEnabled;
  const airdropParse = parseAirdropCsv(airdrop.csvText || '');
  const airdropAnnotated = annotateAirdropRowsWithTokens(airdropParse.rows);
  const airdropBudgetErr = airdropBudgetError(airdropAnnotated.totalTokens);
  // Persist computed results on the airdrop state so other code paths
  // (e.g. a future "execute airdrop" step) can read them without re-
  // parsing. parsedRows holds the token-annotated rows; parseError
  // carries any CSV-format problem; budgetError flags over-budget.
  airdrop.parsedRows = airdropAnnotated.rows;
  airdrop.parseError = airdropParse.error;
  airdrop.budgetError = airdropBudgetErr;

  // Build the airdrop results HTML once via the same helper the
  // in-place refresh path uses, so first-paint and subsequent updates
  // produce identical markup. Reads simpleConfig.airdrop which we just
  // populated above (parsedRows, parseError, budgetError).
  const airdropResultsHtml = buildAirdropResultsHtml();

  body.innerHTML = `
    <div class="simple-config-row">
      <label class="simple-config-toggle">
        <input type="checkbox" id="simpleFlywheelToggle" ${checked}>
        <strong>Use a flywheel</strong>
      </label>
      <a class="is-size-7 ml-2" id="simpleFlywheelLearnMore" href="#" role="button"
         aria-haspopup="dialog" aria-controls="flywheelInfoModal">Learn more</a>
      <div class="select is-small simple-config-dropdown" ${dropdownDisabled}>
        <select id="simpleFlywheelSelect" ${dropdownDisabled}>
          ${options}
        </select>
      </div>
      <div class="simple-config-slider" ${dropdownDisabled}>
        <input type="range" id="simpleFlywheelSlider"
               min="${FLYWHEEL_MIN_PERCENT}" max="${FLYWHEEL_MAX_PERCENT}" step="1"
               value="${sliderValue}" ${dropdownDisabled}>
        <span class="simple-config-slider-value" id="simpleFlywheelSliderValue">${sliderValue}%</span>
      </div>
    </div>
    <p class="simple-config-help-text">${escapeHtml(helpText)}</p>

    <details id="simpleAdvancedDetails"${simpleConfig._advancedExpanded ? ' open' : ''} style="margin-top: 1rem; border-top: 1px dashed var(--rule, rgba(28,22,16,0.15)); padding-top: 0.75rem;">
      <summary style="font-weight: 600; user-select: none; padding: 0.25rem 0;">
        <span class="icon is-small" style="margin-right: 0.25rem;"><i class="fas fa-cog"></i></span>
        Advanced options
        ${(simpleConfig.splitEnabled
            || simpleConfig.ladderEnabled
            || simpleConfig.preallocationEnabled
            || simpleConfig.supportEnabled)
          // Render each active feature as its own pill with a real
          // gap between them. Earlier the names were joined with " · "
          // into a SINGLE pill, which read as one long label rather
          // than a list of independent toggles. Separate pills make
          // it visually obvious that each is its own switch — turning
          // one off should make one pill disappear.
          ? [
              simpleConfig.preallocationEnabled ? 'preallocation' : null,
              simpleConfig.supportEnabled ? 'support' : null,
              simpleConfig.splitEnabled ? 'split LP' : null,
              simpleConfig.ladderEnabled ? 'ladder' : null,
            ].filter(Boolean).map((label) =>
              `<span style="font-weight: normal; font-size: 0.85em; margin-left: 0.4rem; color: var(--ink-soft, #4a3b27); background: var(--gold-soft, #cda14a); padding: 0.15rem 0.55rem; border-radius: 999px; border: 1px solid var(--gold, #b88a2a);">${label}</span>`
            ).join('')
          : `<span class="is-size-7 has-text-grey" style="font-weight: normal; margin-left: 0.5rem;">— preallocation, support, LP splitting, ladder, pool customization</span>`}
      </summary>
      <div style="margin-top: 0.75rem;">
        <!--
          Preallocation block — wrapped in a single #preallocationBlock
          div so the entire section (toggle row, warning, help text,
          airdrop sub-section, breakdown table) can be relocated as a
          unit between this simple-mode Advanced slot and the
          customize-mode #customizePreallocSlot above the pool list.
          Handlers wired on its children survive the move via
          appendChild — that's the same pattern lockPositionsField uses.
          See renderSimpleConfig's tail and applySimpleConfigMode for
          the relocation calls.
        -->
        <div id="preallocationBlock">
        <div class="simple-config-row">
          <label class="simple-config-toggle">
            <input type="checkbox" id="simplePreallocToggle" ${preallocChecked}>
            <strong>Preallocate supply</strong>
          </label>
          <div class="simple-config-slider">
            <!-- step="any", NOT "1": auto-fit computes this value ceil'd to
                 one decimal (e.g. 12.5% to cover an airdrop), so the app
                 itself puts off-grid values here. With step="1" the browser
                 marks the field :invalid and the spinner arrows SNAP to the
                 integer grid — click up on 12.5 and it jumps to 13, losing
                 the auto-fit floor. That snapping is the "values jump
                 around" symptom. -->
            <input class="input is-small" type="number" min="0" max="99" step="any"
                   id="simplePreallocPctInput"
                   style="width: 6rem;"
                   value="${preallocPct.toFixed(preallocPct % 1 === 0 ? 0 : 1)}" ${preallocDisabled}>
            <span class="simple-config-slider-value" id="simplePreallocPctUnit">% of supply</span>
          </div>
          <label class="simple-config-toggle" style="margin-left:0.5rem;" title="When on, the preallocation % is automatically raised (never lowered) to fit the airdrop list. Your typed value acts as a minimum. If the airdrop changes, the floor follows.">
            <input type="checkbox" id="simplePreallocAutoFitToggle" ${autoFitChecked} ${preallocChecked ? '' : 'disabled'}>
            <span class="is-size-7">Auto-fit airdrop</span>
          </label>
          ${simpleConfig.mode === 'customize' ? '' : `
          <label class="simple-config-toggle" style="margin-left:0.5rem;" title="When on, the Support position's SOL value is automatically pinned to a minimum that fully backs the preallocated supply. You can still set a larger Support value for a deeper buy wall.">
            <input type="checkbox" id="simplePreallocAutoBackToggle" ${supportAutoChecked} ${preallocChecked ? '' : 'disabled'}>
            <span class="is-size-7">Auto-back with support</span>
          </label>`}
          <div class="simple-config-slider-value" id="simplePreallocDisplay" style="font-style: italic; color: var(--text-muted, #666);">${escapeHtml(preallocDisplayText)}</div>
          <span class="is-size-7 has-text-warning-dark ml-2" id="simplePreallocAutoFitHint" style="font-style: normal;${autoFitRaised ? '' : ' display: none;'}">⇡ auto-fit: ${preallocPctInputValue}% → ${preallocPct.toFixed(preallocPct % 1 === 0 ? 0 : 1)}% to cover airdrop</span>
        </div>
        <div id="simpleAirdropShortfallWarning" class="notification is-danger is-light py-2 px-3 mt-2 mb-0 is-size-7${airdropShortfallPct ? '' : ' hidden'}">
          <strong>⚠ Your airdrop needs more tokens than you've preallocated.</strong>
          The list requires about ${airdropShortfallPct ? airdropNeedPct.toFixed(1) : '0'}% of supply but only ${preallocPct.toFixed(preallocPct % 1 === 0 ? 0 : 1)}% is reserved.
          If you launch like this the airdrop will run out partway down the list and later recipients will receive nothing.
          Turn on <strong>Auto-fit airdrop</strong>, raise the preallocation percentage, or shorten the list.
        </div>
        <div id="simplePreallocWarning" class="notification is-warning is-light py-2 px-3 mt-2 mb-0 is-size-7${preallocChecked && !simpleConfig.supportEnabled ? '' : ' hidden'}">
          <strong>⚠ Preallocation is unbacked.</strong>
          Without a Support position, holders of preallocated supply have no buy-side liquidity to sell into — this is the textbook rug shape.
          ${simpleConfig.mode === 'customize'
            ? 'Add a support position to one of your pools to provide an honest exit.'
            : '<a href="#" id="simplePreallocEnableSupport"><strong>Enable Support position</strong></a> to add an honest exit.'}
        </div>
        <p class="simple-config-help-text">Holds back a percentage of total supply from LP — for team/VC tokens, presales, airdrops, staking rewards, or any utility reserve. ${simpleConfig.mode === 'customize'
          ? 'You control pool allocations directly; the preallocation simply sits outside your pools.'
          : 'Pool allocations scale down to fit the remaining budget, preserving your flywheel split.'} The preallocated tokens stay in the launch wallet for you to distribute after launch.${simpleConfig.mode === 'customize' ? '' : ' With <strong>Auto-back with support</strong> on, the Support position below is pinned to a minimum SOL value that equals the preallocation\'s USD value — preventing an unbacked-supply rug.'}</p>

        <!--
          Airdrop sub-section. Nested under preallocation because it
          consumes preallocated supply; disabled (and visually muted)
          when preallocation is off. The collapsible <details> remembers
          its expand/collapse state via simpleConfig.airdrop._expanded so
          a render triggered by typing (e.g. CSV textarea input event)
          doesn't snap the section shut.

          When enabled, the user uploads or pastes a CSV with header
          "wallet,sol". We parse on every keystroke, validate addresses
          and amounts, compute per-row token allocations at the launch
          starting price, and check the total against the preallocation
          budget. Errors render in a red notification; the rows render
          in a preview table with the budget verdict line below.

          Sits ABOVE the breakdown table because the user's action
          (configuring the airdrop) flows naturally into the result
          (the table showing how preallocation gets split). Reversed
          order would be backwards — table first then the inputs that
          produced it.
        -->
        <details id="simpleAirdropDetails"${airdrop._expanded ? ' open' : ''} class="mt-2"
                 style="${simpleConfig.preallocationEnabled ? '' : 'opacity: 0.55; pointer-events: none;'} background: var(--paper-card, #e9dcbf); border: 1px solid var(--rule, rgba(28,22,16,0.15)); border-radius: 4px; padding: 0.6rem 0.85rem;">
          <summary style="user-select: none; padding: 0.15rem 0;">
            <label class="simple-config-toggle" style="display: inline-flex;">
              <input type="checkbox" id="simpleAirdropToggle" ${airdropEnabled ? 'checked' : ''} ${simpleConfig.preallocationEnabled ? '' : 'disabled'}>
              <strong>Airdrop to wallet list</strong>
            </label>
            <span class="is-size-7 has-text-grey ml-2">distribute preallocated supply to contributors based on SOL sent</span>
          </summary>
          <div class="mt-2" style="${airdropEnabled ? '' : 'opacity: 0.55; pointer-events: none;'}">
            <p class="is-size-7 has-text-grey mb-2">
              CSV format: first line <code>wallet,sol</code>, then one row per recipient. Each wallet's token allocation is computed at the launch starting price (the USD value of the SOL they sent, converted to tokens at <em>market cap ÷ supply</em>). Lines starting with <code>#</code> are treated as comments.
              <a href="#" id="simpleAirdropSampleLink"><strong>Download sample CSV</strong></a>
            </p>
            <div class="field is-grouped is-align-items-flex-start">
              <div class="control">
                <div class="file is-small has-name">
                  <label class="file-label">
                    <input class="file-input" type="file" id="simpleAirdropFileInput" accept=".csv,text/csv,text/plain" ${airdropEnabled ? '' : 'disabled'}>
                    <span class="file-cta">
                      <span class="file-icon"><i class="fas fa-upload"></i></span>
                      <span class="file-label">Upload CSV</span>
                    </span>
                    <span class="file-name" id="simpleAirdropFileName">${airdrop.csvText ? `${airdrop.parsedRows.length} row${airdrop.parsedRows.length === 1 ? '' : 's'} loaded` : 'no file chosen'}</span>
                  </label>
                </div>
              </div>
              <div class="control">
                <button class="button is-small is-light" id="simpleAirdropClearBtn" ${airdrop.csvText ? '' : 'disabled'}>
                  <span class="icon is-small"><i class="fas fa-times"></i></span>
                  <span>Clear</span>
                </button>
              </div>
            </div>
            <textarea class="textarea is-small is-family-monospace" id="simpleAirdropCsvText"
                      placeholder="wallet,sol&#10;FSfR6uRBJPbGiBSAtR7b7LrgAVu77WrTe7HT7J3afWdz,0.5&#10;CVeDKELHaC76REcBnkrQGV5XX6wJKoYpdLu6E8vEHiPS,1.25"
                      rows="4"
                      style="font-size: 0.8em; background-color: var(--paper-deep, #e4d6b3); border-color: var(--rule, rgba(28,22,16,0.15));"
                      ${airdropEnabled ? '' : 'disabled'}>${escapeHtml(airdrop.csvText || '')}</textarea>
            <!--
              Results container — the error notification, preview table,
              and budget-line are rendered here. Marked with a data
              attribute so refreshAirdropDisplayInline() can target it
              for in-place updates without re-rendering the whole
              section (which would steal focus from the textarea).
              The same buildAirdropResultsHtml() helper produces this
              markup both at first paint and on every subsequent
              keystroke, so the rendering stays consistent.
            -->
            <div data-airdrop-results>${airdropResultsHtml}</div>
          </div>
        </details>

        <!--
          Preallocation breakdown table. Shows where the preallocation
          goes: airdrop recipients (when enabled) and the launch wallet
          (everything not airdropped). When airdrop is active, the
          "Airdrop" row is clickable to expand the full per-wallet list
          beneath it; collapsed by default since wallet lists can be
          long.

          Always rendered when preallocation is on, regardless of
          whether airdrop is enabled — so a user with a 10% prealloc
          and no airdrop sees a single "Launch wallet: 100% of preallo­
          cation" row, which is the right answer for that case.

          Sits BELOW the airdrop sub-section: the user configures the
          airdrop above, then sees the resulting allocation summarised
          in this table.

          buildPreallocationBreakdownHtml() handles all the rendering
          logic (preallocation OFF returns ''); refresh-paths update
          the [data-prealloc-breakdown] container in place.
        -->
        <div data-prealloc-breakdown class="mt-2"${preallocChecked ? '' : ' style="display: none;"'}>${buildPreallocationBreakdownHtml()}</div>
        </div><!-- /#preallocationBlock -->

        <div class="simple-config-row" id="simpleSupportRow"${preallocChecked && !simpleConfig.supportEnabled ? ' style="outline:2px solid #f5d76e; border-radius:4px; padding:0.25rem 0.5rem; margin-left:-0.5rem;"' : ''}>
          <label class="simple-config-toggle">
            <input type="checkbox" id="simpleSupportToggle" ${supportChecked}>
            <strong>Add support position</strong>
          </label>
          <div class="simple-config-slider">
            <!-- step="any", NOT "0.1": auto-back computes this from the
                 preallocation's USD value and it renders to three decimals
                 (e.g. 12.346), which is off the 0.1 grid. Same failure as
                 the preallocation field above — :invalid styling plus
                 spinner arrows snapping the value to the nearest grid
                 point instead of incrementing from it. -->
            <input class="input is-small" type="number" min="0" step="any"
                   id="simpleSupportSolInput"
                   style="width: 7rem;"
                   value="${Number(displayedSupportSol).toFixed(Math.abs(displayedSupportSol) >= 10 ? 1 : 3)}" ${supportSolDisabled}>
            <span class="simple-config-slider-value" id="simpleSupportSolUnit">SOL</span>
          </div>
          <div class="simple-config-slider">
            <span class="simple-config-slider-value" style="line-height:30px;">depth</span>
            <input class="input is-small" type="number"
                   min="${SUPPORT_MIN_DEPTH_PCT}" max="${SUPPORT_MAX_DEPTH_PCT}" step="1"
                   id="simpleSupportDepthInput"
                   style="width: 4.5rem;"
                   value="${supportDepthPct}" ${supportDepthDisabled}>
            <span class="simple-config-slider-value">%</span>
          </div>
          <div class="simple-config-slider-value" id="simpleSupportDisplay" style="font-style: italic; color: var(--text-muted, #666);">${escapeHtml(supportDisplayText)}</div>
        </div>
        <p class="simple-config-help-text">Single-sided buy-side liquidity sitting just below launch price — quote-only, so it doesn't carve from your token-side allocation. The depth setting controls how far the buy wall extends. The SOL you commit gets split evenly across every pool (SOL pool plus any flywheel pools). When <strong>Auto-back with support</strong> is on in the Preallocate row above, this SOL value is silently bumped up to whatever's needed to fully back the preallocation — type more if you want a deeper wall, but the minimum holds. For token-side density near launch price (resistance / accumulation bands), see Ladder positions below. Customize mode lets you tune each pool independently with per-pool depth.</p>
        <div class="simple-config-row">
          <label class="simple-config-toggle">
            <input type="checkbox" id="simpleSplitToggle" ${splitChecked}>
            <strong>Split the LP</strong>
          </label>
          <div class="simple-config-slider" ${splitSliderDisabled}>
            <input type="range" id="simpleSplitSlider"
                   min="${SPLIT_MIN_COUNT}" max="${SPLIT_MAX_COUNT}" step="1"
                   value="${splitValue}" ${splitSliderDisabled}>
            <span class="simple-config-slider-value" id="simpleSplitSliderValue">${splitReadoutText}</span>
          </div>
        </div>
        <p class="simple-config-help-text">Splits the SOL pool into multiple positions, each minting its own transferable Fee Key NFT (when Lock liquidity is enabled below) — useful if you want to give away or sell partial fee streams. To split the flywheel pool too, use Customize.</p>
        <div class="simple-config-row">
          <label class="simple-config-toggle">
            <input type="checkbox" id="simpleLadderToggle" ${ladderChecked}>
            <strong>Ladder positions</strong>
          </label>
          <div class="simple-config-slider" ${ladderSlidersDisabled}>
            <input type="range" id="simpleLadderPercentSlider"
                   min="${LADDER_MIN_PERCENT}" max="${LADDER_MAX_PERCENT}" step="5"
                   value="${ladderPercent}" ${ladderSlidersDisabled}>
            <span class="simple-config-slider-value" id="simpleLadderPercentValue">${ladderPercent}% supply</span>
          </div>
          <div class="simple-config-slider" ${ladderSlidersDisabled}>
            <input type="range" id="simpleLadderBandsSlider"
                   min="${LADDER_MIN_BANDS}" max="${LADDER_MAX_BANDS}" step="1"
                   value="${ladderBandCount}" ${ladderSlidersDisabled}>
            <span class="simple-config-slider-value" id="simpleLadderBandsValue">${ladderBandCount} bands</span>
          </div>
          <div id="simpleLadderStrategyRow" style="flex: 0 0 100%; display: ${simpleConfig.ladderEnabled ? 'flex' : 'none'}; gap: 1.25rem; flex-wrap: wrap; align-items: flex-start; margin-top: 0.25rem;">
            <div style="flex: 1 1 17rem; min-width: 15rem;">
              <div style="display: flex; align-items: center; gap: 0.4rem; margin-bottom: 0.4rem;">
                <strong style="font-size: 0.9rem;">Strategy</strong>
                <button type="button" class="button is-small" id="simpleLadderInfo"
                        title="Explain the ladder strategies" aria-label="Explain the ladder strategies"
                        style="padding: 0 0.4rem; height: 1.5rem; line-height: 1; font-size: 0.9rem;">&#9432;</button>
              </div>
              <div class="select is-small simple-config-dropdown">
                <select id="simpleLadderStrategy">
                  ${LADDER_STRATEGY_IDS.map((id) => {
                    const meta = LADDER_STRATEGY_META[id] || { name: id };
                    const selected = id === ladderStrategy ? 'selected' : '';
                    const label = meta.tag ? `${meta.name} \u2014 ${meta.tag}` : meta.name;
                    return `<option value="${id}" ${selected}>${escapeHtml(label)}</option>`;
                  }).join('')}
                </select>
              </div>
              <p class="simple-config-help-text" id="simpleLadderStrategyNote" style="margin: 0.5rem 0 0 0;">${escapeHtml((LADDER_STRATEGY_META[ladderStrategy] || {}).note || '')}</p>
            </div>
            <div id="simpleLadderPreview" style="flex: 2 1 20rem; min-width: 16rem;"></div>
          </div>
        </div>
        <p class="simple-config-help-text">Splits a portion of each pool's supply across discrete price bands following your chosen strategy (see the info button by the Strategy dropdown), climbing toward a high-multiple ceiling with gaps between bands for breakouts. Each band acts as resistance on the way up and support on the way back down. Smooths supply distribution so 90% isn't gobbled up by the time you hit 10× — leaves room for higher-mcap accumulation. The rest of the pool stays in a wide position covering all prices.</p>
        <div class="simple-config-customize-row" style="margin-top: 0.75rem;">
          <button type="button" class="button is-link is-light" id="simpleCustomizeBtn">
            <span class="icon"><i class="fas fa-sliders-h"></i></span>
            <span>Customize pools manually</span>
          </button>
          <p class="simple-config-help-text" style="margin-top: 0.5rem;">Switches to per-pool editing — pick the quote token, fee tier, and allocation for each pool individually, and configure support/ladder positions per-pool. The current simple-mode settings carry over as the starting point.</p>
        </div>
        <!--
          Slot for the Lock-liquidity checkbox. The element lives at the
          page level in index.html (#lockPositionsField) so customize
          mode can also access it; applySimpleConfigMode() relocates
          the element here when simple mode is active, and moves it
          back to its page-level home when switching to customize mode.
          Single source of truth, no duplicated state.
        -->
        <div id="lockPositionsSlotSimple" style="margin-top: 0.75rem; border-top: 1px dashed var(--rule, rgba(28,22,16,0.08)); padding-top: 0.5rem;"></div>
      </div>
    </details>
  `;

  // Wire up listeners. These elements are recreated on every render,
  // so attaching directly is fine — they're discarded along with the
  // innerHTML on the next render.
  const toggle = body.querySelector('#simpleFlywheelToggle');
  const select = body.querySelector('#simpleFlywheelSelect');
  const slider = body.querySelector('#simpleFlywheelSlider');
  const sliderReadout = body.querySelector('#simpleFlywheelSliderValue');
  const learnMoreLink = body.querySelector('#simpleFlywheelLearnMore');
  const splitToggle = body.querySelector('#simpleSplitToggle');
  const splitSlider = body.querySelector('#simpleSplitSlider');
  const splitReadout = body.querySelector('#simpleSplitSliderValue');
  const ladderToggle = body.querySelector('#simpleLadderToggle');
  const ladderPctSlider = body.querySelector('#simpleLadderPercentSlider');
  const ladderPctReadout = body.querySelector('#simpleLadderPercentValue');
  const ladderBandsSlider = body.querySelector('#simpleLadderBandsSlider');
  const ladderBandsReadout = body.querySelector('#simpleLadderBandsValue');
  const ladderStrategySelect = body.querySelector('#simpleLadderStrategy');
  const ladderInfoBtn = body.querySelector('#simpleLadderInfo');
  const ladderStrategyNote = body.querySelector('#simpleLadderStrategyNote');
  const customizeBtn = body.querySelector('#simpleCustomizeBtn');

  // Learn-more link — opens the static flywheel explainer modal. The link
  // sits next to the toggle so the user can discover what flywheels do
  // before deciding to enable one. preventDefault on the click so the
  // href="#" doesn't scroll the page or change the URL hash.
  if (learnMoreLink) {
    learnMoreLink.addEventListener('click', (e) => {
      e.preventDefault();
      openFlywheelInfoModal();
    });
  }

  toggle.addEventListener('change', (e) => {
    simpleConfig.flywheelEnabled = e.target.checked;
    rebuildPoolsFromSimple();
    renderSimpleConfig();
    // No explicit renderPools() — rebuildPoolsFromSimple invokes
    // addPool which already paints the pool list.
  });

  select.addEventListener('change', (e) => {
    simpleConfig.flywheelKey = e.target.value;
    rebuildPoolsFromSimple();
    renderSimpleConfig();
  });

  // Slider has two events:
  //   - `input` fires continuously as the user drags. We update the
  //     readout live so they see the value moving with the thumb, but
  //     don't rebuild pools on every pixel — that would fire a quote
  //     resolution per pixel.
  //   - `change` fires on mouseup / keyboard commit. We rebuild pools
  //     here, once per drag.
  slider.addEventListener('input', (e) => {
    sliderReadout.textContent = `${e.target.value}%`;
  });
  slider.addEventListener('change', (e) => {
    simpleConfig.flywheelPercent = Number(e.target.value);
    rebuildPoolsFromSimple();
    // Don't re-render the simple-config UI on slider change — that
    // would destroy the slider element mid-drag-cycle on some browsers
    // and feels jumpy. The readout is already in sync from the input
    // handler above; pool list (hidden in default mode anyway) is
    // refreshed by addPool calls inside rebuildPoolsFromSimple.
  });

  // Split-LP toggle: enable/disable splitting. State persists so the
  // slider value sticks across uncheck→check cycles. Any change here
  // requires re-rendering the simple-config UI to flip the slider's
  // disabled visual state.
  splitToggle.addEventListener('change', (e) => {
    simpleConfig.splitEnabled = e.target.checked;
    rebuildPoolsFromSimple();
    renderSimpleConfig();
  });

  // Split slider follows the same input/change split as the flywheel
  // slider — live readout on input, pool rebuild on commit.
  splitSlider.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    splitReadout.textContent = `${v} ${v === 1 ? 'position' : 'positions'}`;
  });
  splitSlider.addEventListener('change', (e) => {
    simpleConfig.splitCount = Number(e.target.value);
    rebuildPoolsFromSimple();
  });

  // Bootstrap mode toggle: switch between minimal and custom. State
  // persists across toggle off/on cycles (the SOL value is kept), so a
  // user who accidentally untoggles doesn't lose their entered amount.
  // Ladder toggle: enable/disable the ladder feature. State persists
  // (percent + band count are kept), and the sliders flip between
  // enabled/disabled via re-render. rebuildPoolsFromSimple regenerates
  // each pool's ladderConfig so the bands are populated/cleared.
  ladderToggle.addEventListener('change', (e) => {
    simpleConfig.ladderEnabled = e.target.checked;
    rebuildPoolsFromSimple();
    renderSimpleConfig();
  });

  // Ladder slider handlers update state on each tick and refresh just
  // the readout text — no full re-render needed for the simple UI
  // (rest of it is invariant under these changes). We do rebuild pools
  // so each pool's ladderConfig gets fresh bands sized for the new value
  // (in case the user switches to customize); rebuildPoolsFromSimple also
  // refreshes the depth-chart preview, so it tracks the change live.
  ladderPctSlider.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    simpleConfig.ladderPercent = Number.isFinite(v) ? v : LADDER_DEFAULT_PERCENT;
    ladderPctReadout.textContent = `${simpleConfig.ladderPercent}% supply`;
    rebuildPoolsFromSimple();
  });
  ladderBandsSlider.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    simpleConfig.ladderBandCount = Number.isInteger(v) ? v : LADDER_DEFAULT_BANDS;
    ladderBandsReadout.textContent = `${simpleConfig.ladderBandCount} bands`;
    rebuildPoolsFromSimple();
  });

  // Strategy dropdown: store the chosen shape, update the inline note, then
  // rebuild the pools so their ladderConfigs carry the new strategy's bands
  // (the rebuild also refreshes the preview). Like the sliders, no full
  // re-render — the rest of the simple UI is invariant under a strategy change.
  if (ladderStrategySelect) {
    ladderStrategySelect.addEventListener('change', (e) => {
      const id = LADDER_STRATEGY_IDS.includes(e.target.value)
        ? e.target.value : LADDER_DEFAULT_STRATEGY;
      simpleConfig.ladderStrategy = id;
      if (ladderStrategyNote) {
        ladderStrategyNote.textContent = (LADDER_STRATEGY_META[id] || {}).note || '';
      }
      rebuildPoolsFromSimple();
    });
  }

  // Info button: open a read-only dialog explaining every strategy. Reuses
  // the generic confirm modal in info-only mode (no Cancel). Always
  // enabled — it's purely educational, useful even before the ladder is on.
  if (ladderInfoBtn) {
    ladderInfoBtn.addEventListener('click', () => {
      confirmDialog({
        title: 'Ladder strategies',
        body: buildLadderStrategiesInfoHtml(),
        confirmLabel: 'Got it',
        hideCancel: true,
      });
    });
  }

  // Populate the preview now (and on every re-render this wiring runs).
  // Safe to call when the ladder is off — it just clears and hides.
  updateSimpleLadderPreview();

  // Preallocation toggle: enable/disable the preallocation feature.
  // When enabled, the % value (kept in state) determines how much of
  // total supply is held back from LP — pools scale down proportionally.
  // Full re-render so the input enables/disables and the help text
  // updates. rebuildPoolsFromSimple regenerates each pool with the new
  // scaling.
  const preallocToggle = body.querySelector('#simplePreallocToggle');
  const preallocPctInput = body.querySelector('#simplePreallocPctInput');
  const preallocDisplay = body.querySelector('#simplePreallocDisplay');
  if (preallocToggle) {
    preallocToggle.addEventListener('change', (e) => {
      simpleConfig.preallocationEnabled = e.target.checked;
      // When the user turns preallocation ON, auto-enable support and
      // pre-size its SOL value to match the preallocation's USD value.
      // This is the rug-resistance link: preallocation without support
      // is a rug, so the natural default is "both on, sized to match."
      //
      // The user can still disable support manually after this (we
      // warn but don't block — same posture as the spec says: "We
      // should not prevent people from doing what they want, and just
      // warn"). They can also override the SOL value if they want a
      // deeper or shallower buy wall than the equal-value default.
      //
      // When preallocation is turned OFF, we don't touch support —
      // support-only is a legitimate configuration (extra buy-side
      // liquidity below launch, no preallocation to back). Leaving the
      // user's prior support state alone respects their choice.
      if (simpleConfig.preallocationEnabled && simpleConfig.mode !== 'customize') {
        // Simple-mode-only support-seeding cascade. In customize mode
        // support is configured per-pool and simpleConfig.supportSolValue
        // / supportEnabled aren't read by the customize-mode pool
        // configuration. Skipping this avoids silently mutating
        // simple-mode state from a customize-mode action.
        //
        // Refresh the effective preallocation percent before reading it
        // — auto-fit may want to bump it based on an airdrop CSV that
        // was entered while preallocation was off. Without this, the
        // support SOL would size to the stale percent.
        recomputeEffectivePreallocationPercent();
        const recommendedSol = recommendedSupportSolForPreallocation(
          Number(simpleConfig.preallocationPercent) || 0,
        );
        // Seed the SOL value to at least the recommended floor when:
        //   (a) support was off (fresh enable — natural to seed it)
        //   (b) support was on but at a value below the new floor —
        //       Auto-back's promise is "no less than required to back"
        // If the user had support on with a value already at or above
        // the floor, leave it alone. We never DECREASE a user's value
        // — Auto-back is a minimum, not an assignment.
        const currentSol = Number(simpleConfig.supportSolValue) || 0;
        const needsSeed = recommendedSol != null && recommendedSol > 0
          && (!simpleConfig.supportEnabled || recommendedSol > currentSol);
        if (needsSeed) {
          simpleConfig.supportSolValue = recommendedSol;
        }
        // Auto-back defaults ON when enabling preallocation — the
        // standard backed configuration. The user can untick the
        // Auto-back box if they want to set a smaller (or zero) value.
        simpleConfig.supportAutoSize = true;
        // Auto-enable support regardless — even if we couldn't compute
        // a value, the user gets the toggle on so they see the section
        // and understand support is the way to make preallocation
        // honest. They can adjust the SOL value manually.
        simpleConfig.supportEnabled = true;
      } else if (simpleConfig.preallocationEnabled) {
        // Customize mode: still recompute the effective percent so the
        // airdrop auto-fit math has a fresh number to work from, but
        // skip every simple-mode-support side-effect.
        recomputeEffectivePreallocationPercent();
      }
      preallocRebuildIfApplicable();
      preallocRerenderIfApplicable();
      // Allocation summary depends on preallocation; refresh it so the
      // user sees the new breakdown without having to switch modes.
      if (typeof updateAllocationSummary === 'function') updateAllocationSummary();
      if (typeof updateContinueToFundingState === 'function') updateContinueToFundingState();
      // Airdrop execution cost contributes to Est. Cost only when
      // preallocation is enabled (computeAirdropExecutionCostSol
      // returns 0 when prealloc is off). When the user toggles prealloc
      // off with airdrop on, the airdrop cost portion of Est. Cost
      // should disappear immediately rather than waiting for the
      // server cost re-estimate to come back.
      refreshAirdropCostDisplays();
      // Toggle changes are definitive; bypass the cost-preview debounce
      // so the user sees the support-inclusive total immediately rather
      // than waiting 500ms (prealloc enable auto-enables support too).
      requestCostPreviewUpdate({ immediate: true });
    });
  }
  if (preallocPctInput) {
    preallocPctInput.addEventListener('input', (e) => {
      const v = Number(e.target.value);
      // Clamp at write-time so the state never holds a value outside
      // the displayed range. 99% is the practical upper bound — 100%
      // means no LP at all, which isn't a launch.
      //
      // The typed value goes into preallocationPercentInput; the
      // EFFECTIVE percent (which auto-fit may raise) is computed
      // separately by recomputeEffectivePreallocationPercent. That
      // way the user's typed value survives airdrop bumps and is
      // visible if they ever turn auto-fit off.
      simpleConfig.preallocationPercentInput = Math.max(0, Math.min(99,
        Number.isFinite(v) ? v : 0,
      ));
      recomputeEffectivePreallocationPercent();
      // Keep the support SOL value at or above the preallocation floor
      // as long as Auto-back is on. Auto-back enforces a MINIMUM — if
      // the user typed a higher value manually (deeper wall than the
      // preallocation requires), we leave their value alone. If the
      // floor rises above what they typed (preallocation % increased),
      // we silently bump it up to the new floor.
      //
      // Customize-mode guard: simple-mode support is not the customize-
      // mode support (which is per-pool). Skip this side-effect in
      // customize mode to avoid silently mutating unused state.
      if (simpleConfig.mode !== 'customize'
          && simpleConfig.preallocationEnabled
          && simpleConfig.supportAutoSize) {
        const recommendedSol = recommendedSupportSolForPreallocation(
          simpleConfig.preallocationPercent,
        );
        if (recommendedSol != null && recommendedSol > 0
            && recommendedSol > (Number(simpleConfig.supportSolValue) || 0)) {
          simpleConfig.supportSolValue = recommendedSol;
        }
      }
      preallocRebuildDebouncedIfApplicable();
      // Refresh inline displays without re-rendering. Using the
      // standalone helpers (rather than the in-render closures) so
      // this code path is identical whether we re-render or not.
      refreshSimplePreallocDisplayInline();
      // Also refresh the support displays since the SOL value may have
      // changed in sync (Auto-back floor bump). We have to touch the
      // input element's value directly because that element is what
      // the user sees — not just the textContent span.
      const supportSolEl = body.querySelector('#simpleSupportSolInput');
      if (supportSolEl && simpleConfig.supportAutoSize) {
        // Only overwrite the input value if the user isn't currently
        // focused there. Writing to an unfocused input is safe; writing
        // to a focused one would clobber whatever they're typing.
        if (document.activeElement !== supportSolEl) {
          supportSolEl.value = Number(simpleConfig.supportSolValue).toFixed(
            Math.abs(simpleConfig.supportSolValue) >= 10 ? 1 : 3,
          );
        }
      }
      refreshSimpleSupportDisplayInline();
      // Budget verdict for the airdrop depends on the prealloc %.
      // Refresh in-place so the verdict color/text updates without
      // re-rendering the simple-config (which would steal focus
      // from the prealloc input).
      refreshAirdropDisplayInline();
      if (typeof updateAllocationSummary === 'function') updateAllocationSummary();
      if (typeof updateContinueToFundingState === 'function') updateContinueToFundingState();
    });
    // On blur, flush any pending debounced rebuild so the pool state
    // is current before the user can interact with the rest of the
    // form (Continue button, customize switch, etc.). Without the
    // flush, the user could click Continue during the 250ms debounce
    // window and the funding estimator would see stale pool state.
    //
    // Customize-mode guard: no debounced rebuild was scheduled in
    // customize mode (preallocRebuildDebouncedIfApplicable was a
    // no-op), so we must skip the flush — flushRebuildPoolsFromSimple
    // unconditionally calls rebuildPoolsFromSimple, which would wipe
    // user pool customizations.
    preallocPctInput.addEventListener('blur', () => {
      if (simpleConfig.mode === 'customize') return;
      flushRebuildPoolsFromSimple();
    });
  }

  // ---- Airdrop handlers ---------------------------------------------------
  //
  // The airdrop toggle, file upload, textarea, and clear button all live
  // inside the preallocation block. The textarea handler is the hot path
  // (fires on every keystroke), so it does an IN-PLACE refresh of just
  // the airdrop interior — no full re-render, which would steal focus
  // and reset caret position. The toggle and clear paths go through
  // renderSimpleConfig() since they change the section's overall
  // enabled state.
  const airdropToggle = body.querySelector('#simpleAirdropToggle');
  const airdropDetails = body.querySelector('#simpleAirdropDetails');
  const airdropCsvText = body.querySelector('#simpleAirdropCsvText');
  const airdropFileInput = body.querySelector('#simpleAirdropFileInput');
  const airdropFileName = body.querySelector('#simpleAirdropFileName');
  const airdropClearBtn = body.querySelector('#simpleAirdropClearBtn');
  const airdropSampleLink = body.querySelector('#simpleAirdropSampleLink');

  // Toggle the <details> expanded state and keep it in sync with stored
  // simpleConfig so re-renders preserve it. The native toggle event
  // fires AFTER the open attr changes, so we read it directly here.
  if (airdropDetails) {
    airdropDetails.addEventListener('toggle', () => {
      simpleConfig.airdrop._expanded = airdropDetails.open;
    });
  }

  // The airdrop checkbox sits inside a <label> inside the <summary>.
  // Native <summary> behavior toggles the parent <details> on any
  // click within the summary — including clicks on the checkbox.
  // Without intervention, clicking the checkbox would both flip the
  // checkbox AND toggle the details panel, doing two things at once.
  // Stop click propagation at the label so the summary's default
  // toggle handler never sees the event.
  //
  // Previously achieved with an inline onclick attribute; moved here
  // so the security-hygiene test (which forbids inline event handlers
  // for CSP cleanliness) stays green.
  if (airdropToggle) {
    const wrappingLabel = airdropToggle.closest('label');
    if (wrappingLabel) {
      wrappingLabel.addEventListener('click', (e) => e.stopPropagation());
    }
  }

  // Enable/disable the airdrop. When enabling, expand the section
  // automatically (otherwise the user clicks the toggle then has to
  // click again to expand — annoying). Disable doesn't auto-collapse.
  if (airdropToggle) {
    airdropToggle.addEventListener('change', (e) => {
      simpleConfig.airdrop.enabled = e.target.checked;
      if (simpleConfig.airdrop.enabled) {
        simpleConfig.airdrop._expanded = true;
      }
      preallocRerenderIfApplicable();
      // Airdrop execution cost contributes to the displayed Est. Cost.
      // Toggling airdrop on/off changes whether that contribution
      // counts (computeAirdropExecutionCostSol returns 0 when off).
      // renderSimpleConfig doesn't touch the cost displays itself, so
      // refresh them here.
      refreshAirdropCostDisplays();
    });
  }

  // Preallocation breakdown table — the airdrop summary row is
  // clickable to expand/collapse the per-wallet rows beneath it.
  // Delegation lets us survive renderSimpleConfig rebuilds (the block
  // itself is rebuilt, but document persists). We bind on document
  // rather than body because the preallocation block can be relocated
  // OUTSIDE of body (into #customizePreallocSlot) in customize mode —
  // a body-bound listener would miss clicks once the block has moved.
  //
  // Bind ONCE across the app's lifetime via a dataset flag on
  // documentElement (which is stable). The flag prevents listener
  // accumulation across re-renders.
  if (!document.documentElement.dataset.airdropBreakdownBound) {
    document.documentElement.dataset.airdropBreakdownBound = '1';
    document.addEventListener('click', (e) => {
      const summaryRow = e.target.closest('[data-airdrop-summary-row]');
      if (!summaryRow) return;
      // Don't toggle if the user clicked a link/button inside the row.
      if (e.target.closest('a, button')) return;
      const willExpand = !simpleConfig.airdrop._breakdownExpanded;
      simpleConfig.airdrop._breakdownExpanded = willExpand;
      // Toggle each wallet row's visibility. Scope to the breakdown's
      // immediate container so we only affect rows in the SAME table
      // the user clicked — if (somehow) multiple breakdown tables
      // existed concurrently we wouldn't toggle the wrong one.
      const breakdownContainer = summaryRow.closest('[data-prealloc-breakdown]') || document;
      breakdownContainer.querySelectorAll('[data-airdrop-wallet-row]').forEach((row) => {
        row.style.display = willExpand ? '' : 'none';
      });
      // Rotate the chevron icon. The icon is the first <i> inside the
      // first <span class="icon"> in the row.
      const icon = summaryRow.querySelector('.icon i');
      if (icon) {
        icon.classList.toggle('fa-chevron-right', !willExpand);
        icon.classList.toggle('fa-chevron-down', willExpand);
      }
    });
  }

  // The airdrop refresh + results-builder helpers are top-level
  // functions (defined alongside refreshSimplePreallocDisplayInline)
  // so the prealloc-% input handler can call them when the budget
  // changes. Handlers below reference them directly.

  // Textarea input handler — fires per-keystroke. Update state, refresh
  // the display in-place. No full re-render: the textarea must keep
  // focus and caret position.
  if (airdropCsvText) {
    airdropCsvText.addEventListener('input', (e) => {
      simpleConfig.airdrop.csvText = e.target.value;
      refreshAirdropDisplayInline();
    });
  }

  // File upload handler — read the file, push contents into the
  // textarea, then refresh in-place. We intentionally update the
  // textarea (rather than just the stored csvText) so the user can
  // see/edit the uploaded content.
  if (airdropFileInput) {
    airdropFileInput.addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      // Guard against huge files — a presale with 100k contributors is
      // ~5MB at 50 bytes/line. Larger than that is almost certainly a
      // mistake (wrong file selected) and would freeze the parser.
      if (file.size > 5 * 1024 * 1024) {
        simpleConfig.airdrop.parseError = `File too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Maximum is 5 MB — split into smaller batches if needed.`;
        refreshAirdropDisplayInline();
        return;
      }
      try {
        const text = await file.text();
        simpleConfig.airdrop.csvText = text;
        if (airdropCsvText) airdropCsvText.value = text;
        refreshAirdropDisplayInline();
      } catch (err) {
        simpleConfig.airdrop.parseError = `Couldn't read file: ${err.message}`;
        refreshAirdropDisplayInline();
      }
    });
  }

  // Clear button — wipe csvText and parsed state, refresh in-place.
  if (airdropClearBtn) {
    airdropClearBtn.addEventListener('click', () => {
      simpleConfig.airdrop.csvText = '';
      simpleConfig.airdrop.parsedRows = [];
      simpleConfig.airdrop.parseError = null;
      simpleConfig.airdrop.budgetError = null;
      if (airdropCsvText) airdropCsvText.value = '';
      if (airdropFileInput) airdropFileInput.value = '';
      refreshAirdropDisplayInline();
    });
  }

  // Sample-CSV download link. We construct a data: URL with a small
  // example so users can see the format without hunting through docs.
  // The wallet addresses in the sample are real-but-arbitrary Solana
  // addresses (just for format demonstration — they're not associated
  // with this app or the user).
  if (airdropSampleLink) {
    airdropSampleLink.addEventListener('click', (e) => {
      e.preventDefault();
      const sample =
        '# Airdrop CSV — first line is the header, then one row per recipient.\n' +
        '# Comments (lines starting with #) and blank lines are ignored.\n' +
        '# The SOL column is what each wallet contributed; token allocation\n' +
        '# is computed at the launch starting price (market cap / supply).\n' +
        'wallet,sol\n' +
        'FSfR6uRBJPbGiBSAtR7b7LrgAVu77WrTe7HT7J3afWdz,0.5\n' +
        'CVeDKELHaC76REcBnkrQGV5XX6wJKoYpdLu6E8vEHiPS,1.25\n' +
        '8i2NtsSoJqZDMCpe9fV5gbRdDQkGMQFMtLttuB2Z2gdw,0.1\n';
      const blob = new Blob([sample], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'trebuchet-airdrop-sample.csv';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      // Free the object URL after the click handler runs — the
      // download will already have started.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  }

  // Support toggle: enable/disable the support position. Like the
  // bootstrap toggle, just flipping this on/off swaps the per-pool
  // supportConfig between { mode: 'off' } and { mode: 'custom', solValue }.
  // Full re-render so the SOL input enables/disables.
  const supportToggle = body.querySelector('#simpleSupportToggle');
  const supportSolInput = body.querySelector('#simpleSupportSolInput');
  const supportDepthInput = body.querySelector('#simpleSupportDepthInput');
  const supportDisplay = body.querySelector('#simpleSupportDisplay');

  // Shared in-place refresh for the support hint text. Reads the latest
  // simpleConfig values and the live SOL price; writes a context-appropriate
  // string into the hint span. Keeps the depth value in the display synced
  // with whichever input the user just touched. Avoiding a full re-render
  // here lets the user keep typing in the SOL or depth input without
  // losing focus or caret position.
  //
  // When preallocation is also enabled, the hint additionally calls out
  // whether the current SOL value backs the preallocation fully (≥ 100%),
  // partially (1-99%), or not at all (0). This gives the user immediate
  // feedback on whether they've sized support honestly without having to
  // wait for the Continue-button warning to fire.
  function refreshSimpleSupportDisplay() {
    if (!supportDisplay) return;
    const sp = pools.find((p) => (p.quoteToken || '').toUpperCase() === 'SOL');
    const solUsd = sp && Number(sp.resolvedPriceUsd) > 0 ? Number(sp.resolvedPriceUsd) : null;
    // Use the effective value (with auto-back floor applied) so the
    // displayed USD and coverage match what the wire format will send.
    const sv = effectiveSupportSolValue();
    const dp = clampSupportDepth(simpleConfig.supportDepthPct);
    const usd = solUsd && sv > 0 ? sv * solUsd : null;

    // Base hint (always shown when support is on).
    let text;
    if (usd != null) {
      text = `≈ $${formatUsdRoughly(usd)} buy wall, launch to -${dp}%`;
    } else if (sv > 0) {
      text = `(USD value will show once SOL price resolves; range -${dp}%)`;
    } else {
      text = `single-sided quote liquidity covering -${dp}% below launch`;
    }

    // Backing indicator (only shown when preallocation is also enabled).
    // Surfaces the coverage ratio inline so the user sees right away
    // whether they're fully backing the preallocation.
    if (simpleConfig.preallocationEnabled && usd != null) {
      const mcap = parseNumberInput(document.getElementById('targetMarketCap'));
      const pp = Number(simpleConfig.preallocationPercent) || 0;
      if (Number.isFinite(mcap) && mcap > 0 && pp > 0) {
        const preallocUsd = mcap * pp / 100;
        const coverage = preallocUsd > 0 ? usd / preallocUsd : 1;
        if (coverage >= 1) {
          text += ` · fully backs preallocation ✓`;
        } else {
          const pct = Math.round(coverage * 100);
          text += ` · backs ${pct}% of preallocation`;
        }
      }
    }
    supportDisplay.textContent = text;
  }

  if (supportToggle) {
    supportToggle.addEventListener('change', (e) => {
      simpleConfig.supportEnabled = e.target.checked;
      // When the user re-enables support after disabling it (with
      // preallocation still on), restore the auto-link by default —
      // they presumably want the support to back the preallocation,
      // which is what the toggle is for. This mirrors the
      // preallocation-toggle behavior (re-enable seeds a clean state).
      if (simpleConfig.supportEnabled && simpleConfig.preallocationEnabled) {
        simpleConfig.supportAutoSize = true;
      }
      rebuildPoolsFromSimple();
      renderSimpleConfig();
      if (typeof updateContinueToFundingState === 'function') updateContinueToFundingState();
      // Toggle changes are definitive (not per-keystroke), so bypass
      // the cost-preview debounce — the user sees the updated number
      // immediately rather than waiting 500ms.
      requestCostPreviewUpdate({ immediate: true });
    });
  }

  // Auto-back-with-support toggle. Lives on the Preallocate row but
  // controls the support sizing: when on, the support SOL value is
  // clamped to a minimum equal to the preallocation USD value. The
  // user can still set a LARGER value (deeper wall) — the clamp only
  // prevents going below the floor. Disabled when preallocation is off,
  // since there's no preallocation USD to back. State name kept as
  // `supportAutoSize` for backward compat with saved configs and the
  // existing derive/wire-format code.
  const preallocAutoBackToggle = body.querySelector('#simplePreallocAutoBackToggle');
  if (preallocAutoBackToggle) {
    preallocAutoBackToggle.addEventListener('change', (e) => {
      simpleConfig.supportAutoSize = e.target.checked;
      // Enabling auto-back: bump the support SOL value up to the
      // required minimum if it's currently below. Also flip support
      // on if it was off — auto-back without support enabled is a
      // no-op and confuses the user.
      if (e.target.checked) {
        if (!simpleConfig.supportEnabled) {
          simpleConfig.supportEnabled = true;
        }
        const rec = recommendedSupportSolForPreallocation(
          Number(simpleConfig.preallocationPercent) || 0,
        );
        if (Number.isFinite(rec) && rec > (Number(simpleConfig.supportSolValue) || 0)) {
          simpleConfig.supportSolValue = rec;
        }
      }
      rebuildPoolsFromSimple();
      renderSimpleConfig();
      if (typeof updateContinueToFundingState === 'function') updateContinueToFundingState();
    });
  }

  // Auto-fit airdrop toggle. When on, the effective preallocation %
  // is automatically raised (but never lowered) to fit the airdrop
  // list. The typed % acts as a minimum floor. Toggling this triggers
  // a full re-render so the prealloc display and breakdown reflect
  // the change immediately.
  const preallocAutoFitToggle = body.querySelector('#simplePreallocAutoFitToggle');
  if (preallocAutoFitToggle) {
    preallocAutoFitToggle.addEventListener('change', (e) => {
      simpleConfig.preallocationAutoFit = e.target.checked;
      // Recompute the effective percent now — this either bumps it
      // up (auto-fit turned ON with an airdrop demand above the typed
      // floor) or returns it to the typed value (auto-fit turned OFF
      // with auto-fit previously holding a higher value).
      recomputeEffectivePreallocationPercent();
      // Auto-back sizing depends on the effective preallocation %.
      // If auto-back is also on, bump the support SOL to track the
      // new effective preallocation USD value. Customize mode skips
      // this — simple-mode support is irrelevant when each pool has
      // its own support.
      if (simpleConfig.mode !== 'customize'
          && simpleConfig.preallocationEnabled
          && simpleConfig.supportAutoSize) {
        const rec = recommendedSupportSolForPreallocation(
          simpleConfig.preallocationPercent,
        );
        if (Number.isFinite(rec) && rec > (Number(simpleConfig.supportSolValue) || 0)) {
          simpleConfig.supportSolValue = rec;
        }
      }
      preallocRebuildIfApplicable();
      preallocRerenderIfApplicable();
      if (typeof updateContinueToFundingState === 'function') updateContinueToFundingState();
    });
  }
  // Preallocation-warning "Enable Support position" link: a one-click
  // fix for the most common case where the warning fires. Turning
  // support on here also re-establishes the auto-link by default,
  // since the user is asking for the standard backed configuration.
  const preallocEnableSupportLink = body.querySelector('#simplePreallocEnableSupport');
  if (preallocEnableSupportLink) {
    preallocEnableSupportLink.addEventListener('click', (e) => {
      e.preventDefault();
      simpleConfig.supportEnabled = true;
      simpleConfig.supportAutoSize = true;
      rebuildPoolsFromSimple();
      renderSimpleConfig();
      if (typeof updateContinueToFundingState === 'function') updateContinueToFundingState();
    });
  }
  if (supportSolInput) {
    supportSolInput.addEventListener('input', (e) => {
      const typed = Number(e.target.value);
      const safeTyped = Number.isFinite(typed) && typed >= 0 ? typed : 0;
      // When Auto-back is on with preallocation enabled, clamp the
      // typed value to the required minimum. We silently bump UP (the
      // user can always go higher for a deeper wall, but not below
      // what's needed to back the preallocation). When Auto-back is
      // off, the user has full control — accept whatever they typed.
      //
      // Note: we don't write the clamped value back to the input
      // element here (would fight the user's typing). The clamp is
      // applied to stored state only; the displayed input will catch
      // up on blur or any subsequent render. refreshSimpleSupportDisplay
      // is called below to update the inline USD/coverage display so
      // the user immediately sees the effective value at work.
      let effective = safeTyped;
      if (simpleConfig.supportAutoSize && simpleConfig.preallocationEnabled) {
        const rec = recommendedSupportSolForPreallocation(
          Number(simpleConfig.preallocationPercent) || 0,
        );
        if (Number.isFinite(rec) && rec > safeTyped) {
          effective = rec;
        }
      }
      simpleConfig.supportSolValue = effective;
      rebuildPoolsFromSimpleDebounced();
      refreshSimpleSupportDisplay();
      if (typeof updateContinueToFundingState === 'function') updateContinueToFundingState();
    });
    // On blur, snap the visible input value to whatever was actually
    // stored. If Auto-back clamped the user's input upward, this is
    // when we honestly show them the value we're using. Without this,
    // a user who typed "1" with a required minimum of "5" would see
    // their "1" sitting in the field even though the stored value is
    // "5" — confusing. Also flushes any pending debounced rebuild.
    supportSolInput.addEventListener('blur', () => {
      flushRebuildPoolsFromSimple();
      const stored = Number(simpleConfig.supportSolValue) || 0;
      const typed = Number(supportSolInput.value);
      if (Number.isFinite(typed) && Math.abs(typed - stored) > 1e-9) {
        // Match the same formatting used at render time.
        supportSolInput.value = stored.toFixed(Math.abs(stored) >= 10 ? 1 : 3);
      }
    });
  }
  if (supportDepthInput) {
    supportDepthInput.addEventListener('input', (e) => {
      // Clamp at write-time so state never holds an out-of-range value.
      // We don't snap the input itself back to the clamped value during
      // typing — that would fight the user mid-keystroke (e.g. clearing
      // "1" to retype "20" would briefly read as out-of-range). The
      // clamp happens at use-sites (rebuildPoolsFromSimple, wire format,
      // display refresh), so storage is always safe.
      const v = Number(e.target.value);
      simpleConfig.supportDepthPct = Number.isFinite(v) ? v : SUPPORT_DEFAULT_DEPTH_PCT;
      rebuildPoolsFromSimpleDebounced();
      refreshSimpleSupportDisplay();
      if (typeof updateContinueToFundingState === 'function') updateContinueToFundingState();
    });
    // On blur, snap a clamped-but-out-of-range value back into the
    // visible input. This is the right time to "correct" what the user
    // typed — they've finished and we're showing them the value we'll
    // actually use. Keeps the displayed value honest without interrupting
    // their typing flow. flushRebuildPoolsFromSimple runs an immediate
    // rebuild so the clamped value lands in pool state before any
    // follow-on action (e.g. Continue click).
    supportDepthInput.addEventListener('blur', (e) => {
      const v = clampSupportDepth(e.target.value);
      simpleConfig.supportDepthPct = v;
      e.target.value = v;
      flushRebuildPoolsFromSimple();
      refreshSimpleSupportDisplay();
    });
  }

  // Persist the open/closed state of the Advanced options section
  // across re-renders. Without this, any input event that triggers a
  // re-render (e.g. typing in the support SOL input) would snap the
  // section closed mid-interaction. The toggle event fires whenever
  // the user opens or closes the <details> element.
  const advancedDetails = body.querySelector('#simpleAdvancedDetails');
  if (advancedDetails) {
    advancedDetails.addEventListener('toggle', () => {
      simpleConfig._advancedExpanded = advancedDetails.open;
    });
  }

  customizeBtn.addEventListener('click', () => {
    // Switch into customize mode. Pools stay as they are — user starts
    // tuning from the current state. The Customize button (now hidden)
    // is replaced by a "Use a preset instead" affordance in
    // the customize-mode container that switches back.
    simpleConfig.mode = 'customize';
    applySimpleConfigMode();
  });

  // Move the Lock-liquidity field into the Advanced slot. We detached
  // it at the top of this function (before the innerHTML rebuild) and
  // parked it at the page-level home; now that the new Advanced slot
  // exists in the DOM, move it there. This keeps the field visible
  // inside Advanced in simple mode while preserving its identity as
  // a single DOM element.
  relocateLockPositionsField('simple');

  // Relocate the preallocation block based on mode. In simple mode it
  // stays where renderSimpleConfig just rendered it (inside the
  // Advanced details). In customize mode we move it to the slot above
  // the pool list. Same appendChild move pattern as lockPositionsField:
  // handlers wired by the prealloc/airdrop setup above are attached
  // directly to the block's children, so they survive the move.
  relocatePreallocationBlock();

  // Restore the scroll offset captured at the top, now that every DOM
  // mutation (the innerHTML rebuild plus the relocate moves above) has
  // settled. Done synchronously inside the change handler, so the view is
  // pinned before the browser paints — no visible jump.
  _scroller.scrollTop = _savedScrollTop;
}

// Move the #preallocationBlock element between its two homes:
//
//   simpleConfig.mode === 'default'   → leave it inside the simple
//                                        container's Advanced section
//                                        (its natural location after
//                                        renderSimpleConfig)
//   simpleConfig.mode === 'customize' → into #customizePreallocSlot,
//                                        which lives above the pool
//                                        list in customize mode
//
// Idempotent: re-running with the same mode is a no-op (appendChild
// of an already-correct parent does nothing). Safe to call whenever
// the mode might have changed without tracking previous mode.
function relocatePreallocationBlock() {
  const block = document.getElementById('preallocationBlock');
  if (!block) return;
  if (simpleConfig.mode === 'customize') {
    const slot = document.getElementById('customizePreallocSlot');
    if (slot && block.parentElement !== slot) {
      slot.appendChild(block);
    }
  }
  // Simple mode: block already sits in the simple container's Advanced
  // section where renderSimpleConfig placed it. No move needed.
}

