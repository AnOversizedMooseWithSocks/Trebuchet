// ===========================================================================
// Launch Success Modal
// ---------------------------------------------------------------------------
// Pops automatically after a successful step-6 transfer (the only place
// runTransfer() considers the launch "fully done"). Shows the live 3D
// coin, the token identity, a short summary of what was created, and
// a list of next-step actions: download the launch report, submit to
// Jupiter VRFD, request a CoinGecko listing, update DexScreener
// Enhanced Info, set up a community.
//
// Coin lifecycle:
//   - coinRenderer is a page-wide singleton (one WebGL context at a time),
//     and the token preview card it lives in TRAVELS with the active step
//     (steps 2-6, see relocateTokenPreview). So when this modal opens at
//     the end of step 6, the renderer is typically ALIVE and owned by the
//     step-6 preview card — the modal borrows it.
//   - showLaunchSuccessModal() destroys the live context (one context at a
//     time) and init()s on the modal's own mount, then setFaces() with the
//     user's logo (data URL) and the largest pool's quote-token logo. Same
//     data-URL trick the launch report uses, so we don't need a CORS proxy
//     for the front face; the back face goes through /api/proxy-image
//     (via proxiedImageUrl) like the step-2 preview does.
//   - hideLaunchSuccessModal() destroys the modal's context AND HANDS THE
//     COIN BACK to the step preview card via renderTokenPreview() — the
//     card is still on screen behind the modal, and without the hand-back
//     its coin stays gone after dismissal.
// ===========================================================================

// Show the launch success modal. Populates token identity, the summary
// line, and (re)initialises the 3D coin in the modal's mount.
// Reflect the permanent-report publish state in the success modal. The publish
// is kicked off during step 6, between airdrop and sweep
// (publishLaunchReportToArweave), and may still be in
// flight when this modal opens, so this is called on open and again when the
// publish settles. Reads getPublishedReport() from launch-report.js.
function renderPublishedReportCard() {
  const el = document.getElementById('launchSuccessReportLink');
  if (!el) return;
  const title = document.getElementById('launchSuccessReportLinkTitle');
  const desc = document.getElementById('launchSuccessReportLinkDesc');
  const icon = document.getElementById('launchSuccessReportLinkIcon');
  const rep = (typeof getPublishedReport === 'function') ? getPublishedReport() : null;

  // Hidden when publishing is off, was skipped, or hasn't started.
  if (!rep || rep.status === 'skipped') {
    el.classList.add('hidden');
    el.onclick = null;
    return;
  }
  el.classList.remove('hidden');

  if (rep.status === 'pending') {
    if (icon) icon.className = 'fas fa-spinner fa-spin';
    if (title) title.textContent = 'Publishing permanent report…';
    if (desc) desc.textContent = 'Writing a permanent copy to Arweave — this finishes on its own.';
    el.disabled = true;
    el.onclick = null;
  } else if (rep.status === 'done') {
    if (icon) icon.className = 'fas fa-globe';
    if (title) title.textContent = 'View the permanent report (Arweave)';
    if (desc) desc.textContent = 'A permanent, public copy of this launch, findable from the token address.';
    el.disabled = false;
    el.onclick = () => {
      try { window.open(rep.htmlUri || rep.jsonUri, '_blank', 'noopener,noreferrer'); }
      catch (err) { console.warn('Failed to open report URL:', err); }
    };
  } else {
    if (icon) icon.className = 'fas fa-rotate-right';
    if (title) title.textContent = "Report didn't publish — retry";
    if (desc) desc.textContent = 'Publishing to Arweave failed. The launch itself is unaffected; you can try again.';
    el.disabled = false;
    el.onclick = () => {
      if (typeof publishLaunchReportToArweave === 'function') publishLaunchReportToArweave();
    };
  }
}

async function showLaunchSuccessModal() {
  const modal = document.getElementById('launchSuccessModal');
  if (!modal) return;

  // ---- Lazy-wire close handlers on first open ----
  // The launch-success modal markup lives later in index.html than the
  // <script src="app.js"> tag, so any bind() called at module load gets
  // null from getElementById and silently warns "Element not found" —
  // the X, Done, backdrop-click, and Esc paths would all fail to close
  // the modal. Same lazy-init pattern showTokenomicsModal() uses (see
  // the comment around line ~9970). Guarded by a dataset flag so a
  // re-open from the step-6 "View launch summary" button doesn't stack
  // duplicate listeners.
  if (!modal.dataset.closeHandlersWired) {
    const closeBtn = document.getElementById('launchSuccessCloseBtn');
    if (closeBtn) closeBtn.addEventListener('click', hideLaunchSuccessModal);
    const doneBtn = document.getElementById('launchSuccessDoneBtn');
    if (doneBtn) doneBtn.addEventListener('click', hideLaunchSuccessModal);
    const bg = modal.querySelector('.modal-background');
    if (bg) bg.addEventListener('click', hideLaunchSuccessModal);
    // External-action delegation (Jupiter / CoinGecko / DexScreener /
    // CoinCommunities buttons). Same reason this needs to be lazy:
    // the .launch-success-actions container also lives after the
    // script tag.
    const actions = modal.querySelector('.launch-success-actions');
    if (actions) {
      actions.addEventListener('click', (e) => {
        const btn = e.target.closest('.launch-success-action[data-action="external"]');
        if (!btn) return;
        const url = btn.getAttribute('data-url');
        if (!url) return;
        try {
          window.open(url, '_blank', 'noopener,noreferrer');
        } catch (err) {
          console.warn('Failed to open external URL:', url, err);
          log(`Could not open ${url} — please copy and open it manually.`, 'warning');
        }
      });
    }
    // Download-report button. Doesn't close the modal — user may want
    // to click multiple actions in one sitting.
    const reportBtn = document.getElementById('launchSuccessReportBtn');
    if (reportBtn) reportBtn.addEventListener('click', () => downloadLaunchReport());
    modal.dataset.closeHandlersWired = 'true';
  }

  // Reflect the permanent-report publish state (kicked off at step 5). Safe to
  // call on every open; re-invoked by publishLaunchReportToArweave when the
  // async publish settles.
  renderPublishedReportCard();

  // ---- Populate identity & summary ----
  // Prefer the resolved on-chain info (createdTokenInfo, set by
  // createToken), fall back to the live form values for any field
  // that's missing — should never happen by step 6, but the safety
  // net costs nothing.
  const tokenInfo = createdTokenInfo || {};
  const symbol = tokenInfo.symbol
    || document.getElementById('tokenSymbol')?.value.trim()
    || '?';
  const name = tokenInfo.name
    || document.getElementById('tokenName')?.value.trim()
    || '';
  const mint = tokenInfo.mint || '';

  document.getElementById('launchSuccessSymbol').textContent = symbol;
  // Only show the "$SYMBOL · Name" suffix when name differs from symbol
  // (many memecoin launches have symbol === name; doubling it reads as
  // a typo).
  const nameWrap = document.getElementById('launchSuccessNameWrap');
  if (name && name !== symbol) {
    document.getElementById('launchSuccessName').textContent = name;
    nameWrap.classList.remove('hidden');
  } else {
    nameWrap.classList.add('hidden');
  }
  document.getElementById('launchSuccessMint').textContent = mint
    ? mint
    : '(mint address not available)';

  // Coin fallback letter — shown if WebGL is unavailable or the renderer
  // fails to come up. Uses the same single-letter trick as the step-2
  // preview's flat fallback.
  const initial = (symbol.charAt(0) || name.charAt(0) || '?').toUpperCase();
  const fallback = document.getElementById('launchSuccessCoinFallback');
  if (fallback) fallback.textContent = initial;

  // Summary line: pool count, locked-position count, transferred Fee
  // Keys. Computed from lpResult exactly like the launch report does
  // so the two stay consistent.
  const results = (lpResult && Array.isArray(lpResult.results)) ? lpResult.results : [];
  const summary = (typeof computeLockSummary === 'function')
    ? computeLockSummary(results)
    : { total: 0, locked: 0, totalRecipient: 0, transferred: 0, allLocked: false };
  const poolCount = results.length;
  const summaryParts = [
    `${poolCount} pool${poolCount === 1 ? '' : 's'} created`,
  ];
  if (summary.total > 0) {
    summaryParts.push(`${summary.locked} / ${summary.total} positions locked`);
  }
  if (summary.totalRecipient > 0) {
    summaryParts.push(`${summary.transferred} / ${summary.totalRecipient} Fee Key NFTs delivered`);
  }
  // A demo run must not read as a real launch. "The launch is committed
  // on-chain" in front of a first-time demo user says they just launched
  // a real token — the opposite of true. Say what actually happened, and
  // point at the natural next step.
  const closingLine = demoModeActive
    ? ' — all simulated. This was a demo: nothing was sent on-chain and no '
      + 'SOL was spent. Ready for the real thing? Click "Disable demo" in '
      + 'the amber bar at the top of the page, and set up your RPC in '
      + 'Settings first.'
    : '. Liquidity is live; the launch is committed on-chain.';
  document.getElementById('launchSuccessSummary').textContent =
    summaryParts.join(' · ') + closingLine;

  // ---- Activate the modal ----
  // Add is-active first so the mount has dimensions before the coin
  // renderer attaches (ResizeObserver in coinRenderer reads the mount's
  // computed size on init; a 0×0 mount would size the canvas to nothing).
  modal.classList.add('is-active');

  // ---- Spin up the 3D coin in the modal ----
  // Read the uploaded logo as a data URL so the renderer doesn't need
  // CORS proxying for the front face. Falls back to null if the user
  // didn't upload one or the read fails — setFaces handles a null URL
  // by leaving the front blank.
  let frontUrl = null;
  try {
    frontUrl = await readLogoAsDataUrl();
  } catch (e) {
    console.warn('Launch success modal: failed to read logo for coin:', e);
  }

  // The user may have dismissed the modal during the await above (clicked
  // close before the logo finished reading, hit Esc, or clicked the
  // backdrop). hideLaunchSuccessModal already ran in that case but found
  // no live coin to tear down — if we proceed here we'd init a WebGL
  // context inside a now-hidden modal, leaking it until the modal is
  // reopened or the page reloaded. Bailing keeps the coin lifecycle
  // honest: it only ever runs while the modal is actually visible.
  if (!modal.classList.contains('is-active')) return;

  if (typeof coinCanRun === 'function' && coinCanRun()) {
    const mount = document.getElementById('launchSuccessCoin');
    if (mount) {
      try {
        // Destroy any prior coin context first — one WebGL context at a
        // time. This is normally the step-6 preview card's LIVE coin
        // (the travelling preview card owns the renderer through steps
        // 2-6); on a re-open via "View launch summary" it's the modal's
        // own coin from the previous open. Either way init() needs the
        // singleton free. hideLaunchSuccessModal gives the coin back to
        // the preview card on close.
        if (window.coinRenderer.isActive()) {
          window.coinRenderer.destroy();
        }
        window.coinRenderer.init(mount);
        mount.classList.add('coin-live');

        // Back face: largest pool's quote-token logo, computed the same
        // way the step-2 preview does (coinBackSource → largestPool).
        const back = (typeof coinBackSource === 'function')
          ? coinBackSource()
          : { url: null, symbol: 'SOL' };

        if (back.url) {
          window.coinRenderer.setFaces(frontUrl || null, back.url, back.symbol);
        } else {
          // No back-face logo URL available — emboss the symbol text.
          // (Happens when the only pool is SOL with the default fallback
          // and resolvedImageUrl was never set, or when proxiedImageUrl
          // returns null for a non-http source.)
          window.coinRenderer.setFaces(frontUrl || null, null, back.symbol);
        }
      } catch (e) {
        // Surface to the console only — the modal still shows the
        // fallback letter, so the user isn't blocked. The launch is
        // already complete; this is pure decoration.
        console.warn('Launch success modal: failed to start 3D coin:', e);
      }
    }
  }

  // Populate the inline launch report preview inside the modal.
  renderLaunchReportPreview('modal');
}

// Hide the launch success modal and free the coin's WebGL context. Safe
// to call when the modal is already closed (no-op in that case).
function hideLaunchSuccessModal() {
  const modal = document.getElementById('launchSuccessModal');
  if (!modal) return;
  modal.classList.remove('is-active');

  // Tear down the coin. Browsers cap live WebGL contexts, so leaving
  // one alive in a hidden modal is bad citizenship. The renderer is a
  // page-wide singleton; destroying it here is safe because nothing
  // else owns it at this point in the flow (step 2's coin was already
  // destroyed when the user moved past step 2).
  try {
    if (typeof window.coinRenderer !== 'undefined' &&
        window.coinRenderer.isActive()) {
      window.coinRenderer.destroy();
    }
  } catch (e) {
    console.warn('Launch success modal: failed to tear down coin:', e);
  }

  // Drop the coin-live marker so the flat fallback shows if the modal
  // is reopened before the coin reinits (briefly visible during the
  // async showLaunchSuccessModal flow on re-open).
  const mount = document.getElementById('launchSuccessCoin');
  if (mount) mount.classList.remove('coin-live');

  // Hand the coin back to the step preview card. The modal borrowed the
  // singleton renderer from the travelling preview card (visible behind
  // the modal on step 6); without this the card's coin area stays empty
  // after dismissal — its mount still carries coin-live (hiding the flat
  // fallback) but holds no canvas. renderTokenPreview() re-renders the
  // card and its updateCoinPreview() call re-init()s the renderer into
  // the card's mount, exactly like a step relocation does. Guarded: on
  // any path where the preview card isn't rendered (coinCanRun false,
  // mount missing), updateCoinPreview is a safe no-op.
  if (typeof renderTokenPreview === 'function') {
    try {
      renderTokenPreview();
    } catch (e) {
      console.warn('Launch success modal: failed to restore preview coin:', e);
    }
  }
}

// ---- Modal close handlers wired lazily in showLaunchSuccessModal() ----
// The X button, Done button, backdrop click, report-download button, and
// external-action delegation are all wired on first open inside
// showLaunchSuccessModal rather than at module load. The reason is in the
// comment at the top of that function: the modal markup lives later in
// index.html than the <script src="app.js"> tag, so a top-level bind()
// would silently fail. Same pattern showTokenomicsModal() uses.

// Esc-to-close. This one CAN live at top level because the listener is
// attached to `document` (always exists at script parse time) and the
// modal lookup happens at runtime each time Esc is pressed. Separate
// from the EXTRA_CLOSE_MODAL_IDS list further down because that list's
// generic close just removes is-active — it doesn't tear down the coin.
// Adding our own keydown listener keeps the coin lifecycle correct
// regardless of how the modal is dismissed. Idempotency:
// hideLaunchSuccessModal is safe to call when already closed.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const modal = document.getElementById('launchSuccessModal');
  if (modal && modal.classList.contains('is-active')) {
    hideLaunchSuccessModal();
  }
});

// Re-open from the step-6 "View launch summary" button. Same path as
// the auto-open after a successful transfer — re-runs showLaunchSuccessModal,
// which re-inits the coin in the modal's mount. The button itself is
// only revealed (via classList.remove('hidden') in runTransfer) after
// a successful transfer, so clicking before then is impossible.
bind('viewLaunchSummaryBtn', 'click', () => {
  showLaunchSuccessModal();
});

function buildAllocationsForApi() {
  return pools.map((p) => {
    // Pass our resolved price through to the server as quoteUsdOverride.
    //
    // Per the price-safety plan (Milestones A + B), this no longer means
    // "skip server-side price lookup" the way it used to. The server
    // ALWAYS runs a fresh just-in-time Raydium swap probe at pool-create
    // time for non-SOL quotes. What it does with the override:
    //
    //   1. Treats it as the drift-guard reference. After the probe runs,
    //      it compares the probe value against this override. If they
    //      differ by more than the configured threshold (default 25%),
    //      it aborts the launch with a pre_flight error telling the user
    //      to refresh the funding estimate.
    //
    //   2. For SOL pools, the override is checked against the live
    //      SOL/USD oracle reading the same way. SOL rarely drifts that
    //      much in a normal funding-to-create window, but the guard is
    //      symmetric.
    //
    // What value to send: whatever the user committed to at funding time.
    // The funding-estimate response (Milestone B) propagates its
    // resolvedPrices back into pool.resolvedPriceUsd, so by the time the
    // user clicks "Create Pools" the resolvedPriceUsd holds the canonical
    // funding-estimate price. That's the price the launch math sized
    // against; that's the right drift reference.
    //
    // If the user typed an explicit override in customize mode, that
    // wins — the user is opting into a price they chose deliberately,
    // and the drift guard checks the live probe against THEIR number.
    const effectiveUsdOverride =
      p.quoteUsdOverride != null
        ? p.quoteUsdOverride
        : (p.resolvedPriceUsd != null ? Number(p.resolvedPriceUsd) : null);
    // Symbol-override resolution priority:
    //   1. User-typed override in customize mode (explicit user intent)
    //   2. Resolved symbol from tokenInfoService (GeckoTerminal / Jupiter
    //      / DexScreener) — usually present for liquid tokens
    //   3. Flywheel label — bespoke flywheel tokens may not be in price
    //      APIs yet; the label ("Reserve" / "Meme" / etc.) is a much
    //      better display string than the first 6 chars of the mint
    //   4. null — server falls back to mint.slice(0,6), which is the
    //      "we genuinely don't know" surface for arbitrary tokens
    let effectiveSymbolOverride;
    if (p.quoteSymbolOverride != null && p.quoteSymbolOverride !== '') {
      effectiveSymbolOverride = p.quoteSymbolOverride;
    } else if (p.resolvedSymbol) {
      effectiveSymbolOverride = p.resolvedSymbol;
    } else {
      const fw = Object.values(FLYWHEELS).find((f) => f.mint === p.quoteToken);
      effectiveSymbolOverride = fw ? fw.label : null;
    }
    const effectiveDecimalsOverride =
      p.quoteDecimalsOverride != null
        ? p.quoteDecimalsOverride
        : (p.resolvedDecimals != null ? Number(p.resolvedDecimals) : null);

    // Unified "% of pool" semantics in the UI: bootstrap.supplyPercent,
    // ladder band.supplyPercent, and slice.sharePercent all express
    // each position's fraction of THIS pool's allocation. They sum to
    // 100% (validated). Backend wire format uses different denominators
    // (bootstrap = % of total; ladder band = % of main; slice = % of
    // wide), so we convert here.
    const uiBsPct = (p.bootstrapConfig && p.bootstrapConfig.mode === 'custom')
      ? Number(p.bootstrapConfig.supplyPercent) || 0
      : 0;
    const ldCfg = p.ladderConfig || { mode: 'off', bands: [] };
    const uiBandPcts = (ldCfg.mode === 'manual' && Array.isArray(ldCfg.bands))
      ? ldCfg.bands.map((b) => Number(b.supplyPercent) || 0)
      : [];

    // Wire bootstrap.supplyPercent is % of TOTAL token supply. With
    // pool at X% of total and bs at Y% of pool, bs of total = X × Y / 100.
    const bootstrap = uiBsPct > 0
      ? { mode: 'custom', supplyPercent: uiBsPct * Number(p.supplyPercent) / 100 }
      : { mode: 'minimal' };

    // Wire ladder band.supplyPercent is % of MAIN (pool − bootstrap).
    // Main fraction of pool = (1 − bs/100). So wire_band_pct = ui /
    // (1 − bs/100). Clamp the divisor to avoid divide-by-zero when bs
    // is 100% (edge case: user gave the entire pool to bootstrap).
    let ladder;
    if (uiBandPcts.length > 0) {
      const mainFraction = Math.max(0.0001, 1 - uiBsPct / 100);
      ladder = {
        mode: 'manual',
        bands: ldCfg.bands.map((b) => ({
          supplyPercent: Number(b.supplyPercent) / mainFraction,
          lowerMultiplier: Number(b.lowerMultiplier),
          upperMultiplier: Number(b.upperMultiplier),
        })),
      };
    } else {
      ladder = { mode: 'off' };
    }

    // Wire distribution[].sharePercent is share of WIDE (slices among
    // themselves sum to 100). UI slice sharePercent is % of pool;
    // normalize within the slices array.
    //
    // Filter out 0% slices first — they contribute nothing to the wide
    // bucket, would normalize to 0 on the wire, and the backend's
    // normalizeDistribution() rejects sharePercent <= 0. Dropping them
    // is a no-op since they don't represent any liquidity allocation.
    // If filtering leaves the array empty (everything is in bs + bands,
    // wide is 0), we send a single placeholder 100% slice; the backend's
    // wide loop is skipped when wideBaseRaw = 0, so the value is unused.
    const nonZeroSlices = p.distribution.filter((s) => (Number(s.sharePercent) || 0) > 0);
    const totalSliceUi = nonZeroSlices.reduce((s, x) => s + (Number(x.sharePercent) || 0), 0);
    let distribution;
    if (totalSliceUi > 0) {
      distribution = nonZeroSlices.map((s) => ({
        sharePercent: (Number(s.sharePercent) || 0) / totalSliceUi * 100,
        recipient: s.useExternalRecipient ? s.recipient : null,
      }));
    } else {
      distribution = [{ sharePercent: 100, recipient: null }];
    }

    // Wire support config: { mode: 'off' } or { mode: 'custom', solValue, depthPct }.
    // The solValue is the user's canonical input in SOL; the orchestrator
    // converts to USD-equivalent raw quote units at LP-creation time
    // using the live SOL price. depthPct controls how far below launch
    // the position covers (range [1, 50], default 10). Support is
    // quote-only — no supplyPercent conversion needed since it doesn't
    // carve from token supply.
    const supportCfg = p.supportConfig || { mode: 'off' };
    const support = (supportCfg.mode === 'custom' && Number(supportCfg.solValue) > 0)
      ? {
          mode: 'custom',
          solValue: Number(supportCfg.solValue),
          // Clamp at wire-time so a transient out-of-range UI value (e.g.
          // mid-keystroke typing) never gets sent to pre-flight. Pre-flight
          // validates again with the same bounds; clamping here gives a
          // cleaner UX (user doesn't see "invalid depthPct" errors from
          // a value the UI will eventually correct on blur).
          depthPct: clampSupportDepth(supportCfg.depthPct),
        }
      : { mode: 'off' };

    return {
      quoteToken: p.quoteToken,
      supplyPercent: p.supplyPercent,
      ammConfigIndex: p.ammConfigIndex,
      quoteUsdOverride: effectiveUsdOverride,
      quoteDecimalsOverride: effectiveDecimalsOverride,
      quoteSymbolOverride: effectiveSymbolOverride,
      distribution,
      bootstrap,
      ladder,
      support,
    };
  });
}

// ===========================================================================
// STEP 3: Funding
// ===========================================================================

/**
 * Find the pool config object for a given quote mint, so we can pull
 * resolved metadata (symbol, logo, decimals) for the funding-step rows.
 * The KNOWN_QUOTES (USDC/USDT/SOL) need explicit handling because their
 * pool entries store the symbol ('USDC') in quoteToken rather than the
 * mint address.
 */
function findPoolByMint(mint) {
  return pools.find((p) => {
    const upper = (p.quoteToken || '').toUpperCase();
    if (upper === 'SOL') return false;
    if (upper === 'USDC' && mint === 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v') return true;
    if (upper === 'USDT' && mint === 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB') return true;
    return p.quoteToken === mint;
  });
}

/**
 * Build the inline-logo HTML for a pool's resolved image. Falls back
 * to a neutral placeholder when no image is available so the row
 * layout stays consistent.
 *
 * Broken URLs are handled by attachRowLogoFallbacks(), which swaps
 * failed images for placeholders without inline event handlers.
 */
function rowLogoHtml(pool) {
  if (pool && pool.resolvedImageUrl) {
    return `<img src="${escapeHtml(pool.resolvedImageUrl)}" alt="" class="row-logo" data-action="row-logo-fail">`;
  }
  return '<span class="row-logo-placeholder"></span>';
}

function replaceRowLogoWithPlaceholder(img) {
  if (!img || !img.parentNode) return;
  const placeholder = document.createElement('span');
  placeholder.className = 'row-logo-placeholder';
  img.parentNode.replaceChild(placeholder, img);
}

function attachRowLogoFallbacks(root) {
  root.querySelectorAll('[data-action="row-logo-fail"]').forEach((img) => {
    img.addEventListener('error', () => {
      replaceRowLogoWithPlaceholder(img);
    }, { once: true });
  });
}

function renderFundingRequirements() {
  document.getElementById('step3WalletAddr').textContent = tempWallet.publicKey;
  // The QR data URL is usually generated server-side with the wallet, but
  // recovered wallets from a prior session only have the public key. In that
  // case regenerate the QR lazily so the funding panel doesn't show a broken
  // image icon.
  if (tempWallet.qrCode) {
    setWalletQrImages(tempWallet.qrCode);
  } else {
    setWalletQrImages(null);
    ensureWalletQrCode(tempWallet).catch((e) => {
      log(`Couldn't render wallet QR: ${e.message}`, 'warning');
    });
  }

  // ---- Section 1: things the user must send themselves ------------------
  // SOL is always present. Manual-prefund tokens (no auto-swap route, or
  // an auto-swap row that converted after a terminal failure) live here
  // alongside SOL so the user has a single "what do I need to send?" list.
  const sendContainer = document.getElementById('balanceRows');
  sendContainer.innerHTML = '';

  // Initial "needed" display shows the RECOMMENDED total (subtotal +
  // safety buffer). This is what users should aim for when funding —
  // landing exactly on the bare minimum leaves no margin for cost
  // variance, so we encourage depositing the full recommended amount.
  //
  // pollBalances handles the green/red transition: it uses the bare
  // minimum (subtotal - credits) as the "can proceed" threshold, so the
  // row will go green once wallet >= subtotal even if below recommended.
  // When that happens, a small grey/yellow note appears next to the
  // numbers indicating the buffer is below recommended but the launch
  // can still proceed.
  // The launch's funding requirement comes from the server. The
  // airdrop execution cost (ATA rent + tx fees for the recipient
  // transfers) is computed client-side and added on top so the user
  // funds enough for the entire flow including the post-launch
  // distribution. When airdrop is disabled or empty this adds 0.
  const airdropExecutionSol = computeAirdropExecutionCostSol();
  const solReqSol = (fundingRequirement.totalSol
    || fundingRequirement.solLamports / 1e9)
    + airdropExecutionSol;
  const solRow = document.createElement('div');
  solRow.className = 'balance-row';
  solRow.dataset.kind = 'sol';
  solRow.innerHTML = `
    <span><span class="status-dot"></span><strong>SOL</strong></span>
    <span>
      <span data-field="actual">0</span> /
      <span data-field="needed">${solReqSol.toFixed(3)}</span>
      <span data-field="buffer-note" class="is-size-7 has-text-grey ml-2"></span>
    </span>
  `;
  sendContainer.appendChild(solRow);

  Object.entries(fundingRequirement.byQuote).forEach(([mint, rawAmt]) => {
    const pool = findPoolByMint(mint);
    const decimals = pool?.resolvedDecimals ?? pool?.quoteDecimalsOverride ?? 6;
    // Symbol resolution — same priority as buildAllocationsForApi:
    // user override > resolved symbol > flywheel label > mint prefix.
    // The mint-prefix fallback only fires for truly unknown tokens
    // (no price-API coverage, not a flywheel, no user override) and
    // even then is a worst-case display rather than a stable ticker.
    let symbol = pool?.resolvedSymbol ?? pool?.quoteSymbolOverride;
    if (!symbol) {
      const fw = Object.values(FLYWHEELS).find((f) => f.mint === mint);
      symbol = fw ? fw.label : mint.slice(0, 6);
    }
    // neededWhole is the precise target (what the bootstrap actually
    // needs on-chain). displayNeeded is the user-facing rounded form;
    // displayed value may have lost precision via toPrecision/floor in
    // formatTokenDisplay. Polling MUST compare against the precise
    // value (stashed on dataset) — comparing against the rounded text
    // would produce false "met" states for small fractional targets.
    const neededWhole = rawAmt / Math.pow(10, decimals);
    const displayNeeded = formatTokenDisplay(neededWhole);
    // Approximate USD value of this manual-prefund target. Uses the
    // pool's resolved price for the conversion — same source the
    // estimator and cost-preview use. Hidden when we don't have a
    // price (genuinely unpriced token).
    const priceUsd = Number(pool?.resolvedPriceUsd ?? pool?.quoteUsdOverride);
    const usdValue = Number.isFinite(priceUsd) && priceUsd > 0
      ? neededWhole * priceUsd
      : null;
    const usdChip = usdValue != null
      ? ` <span class="is-size-7 has-text-grey">(${formatUsdShort(usdValue)})</span>`
      : '';

    const row = document.createElement('div');
    row.className = 'balance-row';
    row.dataset.kind = 'token';
    row.dataset.mint = mint;
    row.dataset.decimals = decimals;
    row.dataset.target = String(neededWhole);
    row.innerHTML = `
      <span><span class="status-dot"></span>${rowLogoHtml(pool)}<strong>${escapeHtml(symbol)}</strong>${usdChip}</span>
      <span><span data-field="actual">0</span> / <span data-field="needed">${displayNeeded}</span></span>
    `;
    sendContainer.appendChild(row);
  });

  // ---- Section 2: things the system will acquire on the user's behalf ----
  // Each row shows the target amount and a status indicator. No "0 / X"
  // ratio here — it'd read as "you need to send X" which is the opposite
  // of what auto-swap means. The status text walks: Pending → Swapping…
  // → Acquired ✓ → (or, on terminal failure, the row gets converted to
  // a Section-1 manual row by convertAutoSwapRowToManual).
  const autoContainer = document.getElementById('autoSwapRows');
  const autoSection = document.getElementById('autoSwapSection');
  autoContainer.innerHTML = '';
  const autoPlan = fundingRequirement.autoSwapPlan || [];
  if (autoPlan.length > 0) {
    autoSection.style.display = '';
    for (const item of autoPlan) {
      const pool = findPoolByMint(item.quoteMint);
      // Two different "target" concepts for an auto-swap row:
      //   - acquireWhole: what the swap aims for (oversize, $2). This is
      //     what we DISPLAY ("≈ 1000") so the user sees how much we're
      //     trying to obtain.
      //   - minWhole: the actual bootstrap on-chain need ($1). This is
      //     what we use for the "met" check — a 50% partial fill of the
      //     acquire target still meets minWhole, so the row marks green
      //     and the user can proceed.
      const acquireWhole = Number(item.targetRaw) / Math.pow(10, item.quoteDecimals);
      const minWhole = Number(item.minRaw || item.targetRaw) / Math.pow(10, item.quoteDecimals);
      const displayTarget = formatTokenDisplay(acquireWhole);
      // Approximate USD value of the acquire target. item.quoteUsd is a
      // string-encoded Decimal from the server estimator (the same price
      // the swap budget was sized against). Multiplying by acquireWhole
      // gives the dollar amount the user should expect to see swapped.
      // Shown in parentheses next to the token count so the user can
      // sanity-check magnitude — "3149 tokens" is meaningless without
      // knowing each is worth $0.001, but "$3.15" is universally
      // understood. Falls back to no USD chip when price is missing.
      const quoteUsdPrice = Number(item.quoteUsd);
      const usdValue = Number.isFinite(quoteUsdPrice) && quoteUsdPrice > 0
        ? acquireWhole * quoteUsdPrice
        : null;
      const usdChip = usdValue != null
        ? ` <span class="is-size-7 has-text-grey">(${formatUsdShort(usdValue)})</span>`
        : '';

      const row = document.createElement('div');
      row.className = 'balance-row';
      row.dataset.kind = 'token-autoswap';
      row.dataset.mint = item.quoteMint;
      row.dataset.decimals = item.quoteDecimals;
      // data-target is what polling compares wallet balance against
      // for the "met" state — use the actual bootstrap need.
      row.dataset.target = String(minWhole);
      row.dataset.allocationIndex = item.allocationIndex;
      // Initial status: 'pending' (waiting for SOL + Acquire click). The
      // poll loop and Acquire handler update this as the row progresses.
      // The retry button stays hidden via CSS (.row-retry-btn) until the
      // row enters a retryable failed state — then setRowStatus reveals
      // it. Clicking it re-runs Acquire for just this one row.
      row.innerHTML = `
        <span><span class="status-dot"></span>${rowLogoHtml(pool)}<strong>${escapeHtml(item.quoteSymbol)}</strong>
          <span class="is-size-7 has-text-grey ml-2">≈ ${displayTarget}</span>${usdChip}</span>
        <span class="row-status-cell">
          <span data-field="status" class="is-size-7 has-text-grey">Pending</span>
          <button class="row-retry-btn" type="button" title="Retry this swap" aria-label="Retry">
            <i class="fas fa-redo"></i>
          </button>
        </span>
      `;
      autoContainer.appendChild(row);
    }
  } else {
    autoSection.style.display = 'none';
  }

  // Show the Acquire-quote-tokens button only if there's anything to swap.
  const acquireWrap = document.getElementById('acquireQuoteTokensWrap');
  if (acquireWrap) {
    acquireWrap.style.display = autoPlan.length > 0 ? '' : 'none';
  }

  attachRowLogoFallbacks(document.getElementById('step3-card') || document);
  renderFundingBreakdown();
}

function renderFundingBreakdown() {
  const container = document.getElementById('fundingBreakdown');
  if (!container) return;
  if (!fundingRequirement.solBreakdown && !fundingRequirement.quoteBreakdown) {
    container.innerHTML = '';
    return;
  }

  let html = '<table class="table is-narrow is-fullwidth is-size-7"><tbody>';
  for (const item of fundingRequirement.solBreakdown || []) {
    const isBuffer = /safety buffer/i.test(item.label);
    html += `<tr${isBuffer ? ' class="has-text-grey"' : ''}>
      <td>${escapeHtml(item.label)}</td>
      <td class="has-text-right is-family-monospace">${item.sol > 0 && item.sol < 0.0001 ? '< 0.0001' : item.sol.toFixed(4)} SOL</td>
    </tr>`;
  }
  for (const item of fundingRequirement.quoteBreakdown || []) {
    html += `<tr>
      <td>${escapeHtml(item.label)}</td>
      <td class="has-text-right is-family-monospace">${item.amount} ${escapeHtml(item.symbol)}</td>
    </tr>`;
  }
  // Airdrop execution cost (ATA rent + tx fees) is calculated client-
  // side since the server estimator doesn't know about the airdrop
  // list. Show as a separate line item so the user understands where
  // the SOL goes, then include in the displayed total below.
  const airdropExecutionSol = computeAirdropExecutionCostSol();
  if (airdropExecutionSol > 0) {
    const n = simpleConfig.airdrop.parsedRows.length;
    html += `<tr>
      <td>Airdrop execution (${n} recipient${n === 1 ? '' : 's'}: ATA rent + tx fees)</td>
      <td class="has-text-right is-family-monospace">${airdropExecutionSol.toFixed(4)} SOL</td>
    </tr>`;
  }
  const displayedTotal = (fundingRequirement.totalSol || 0) + airdropExecutionSol;
  html += `<tr class="has-text-weight-bold">
    <td>Total SOL</td>
    <td class="has-text-right is-family-monospace">${displayedTotal.toFixed(4)} SOL</td>
  </tr>`;
  html += '</tbody></table>';
  container.innerHTML = html;
}

function startBalancePolling() {
  if (balancePollHandle) clearInterval(balancePollHandle);
  pollBalances();
  balancePollHandle = setInterval(pollBalances, 5000);
}

async function pollBalances() {
  if (!tempWallet) return;
  try {
    const resp = await fetch('/api/check-balance-detailed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ publicKey: tempWallet.publicKey }),
    });
    const data = await resp.json();
    if (!data.success) return;

    const { sol, tokens } = data.balance;
    // -------------------------------------------------------------------
    // SOL requirement: two-threshold model.
    //
    // The funding estimate exposes three numbers:
    //   - subtotalSol: the sum of actual costs (pool creation, positions,
    //                  Arweave, token mint, plus budgeted auto-swap spend).
    //                  This is the BARE MINIMUM needed to complete the
    //                  launch successfully if every step costs exactly
    //                  what we expected.
    //   - bufferSol:   a 20% safety margin layered on top of subtotal,
    //                  to absorb variance (priority-fee spikes, slippage
    //                  overshoots on auto-swaps, etc).
    //   - totalSol:    subtotal + buffer. The "recommended" deposit
    //                  amount, shown in the cost breakdown.
    //
    // Earlier we used totalSol as a hard floor for the "met" check,
    // meaning if you'd eaten into the buffer (even by a tiny amount) the
    // launch was blocked. That's wrong — the buffer is SAFETY MARGIN,
    // not a fixed required reserve. As long as you still have enough for
    // the actual costs, you can proceed; the buffer just gives you
    // breathing room for unexpected variance.
    //
    // Now:
    //   - solMet (can proceed):    wallet >= subtotal - swapCreditApplied
    //   - solHasFullBuffer:        wallet >= total - swapCreditApplied
    //
    // The "needed" display shows the bare minimum (subtotal-credit). If
    // we're between minimum and full-recommended, a small "buffer below
    // recommended — launch may fail on cost overruns" hint shows beside
    // the row but does NOT block proceeding.
    //
    // swapCreditApplied accumulates each completed auto-swap's
    // estSolSpend (the SOL we budgeted to acquire that quote token). Once
    // a swap has actually happened, that SOL is gone from the wallet and
    // doesn't need to be reserved anymore — the credit subtracts the
    // budget from both thresholds so the user sees the requirement
    // shrink as the work completes.
    const subtotalSol = fundingRequirement.subtotalSol || 0;
    const totalSol = fundingRequirement.totalSol || (fundingRequirement.solLamports / 1e9);
    const solCredit = fundingRequirement.solCreditedForCompletedSwaps || 0;
    // Airdrop execution cost is real SOL the wallet must hold even
    // though it won't be spent until after the launch completes. Both
    // the bare-minimum threshold and the recommended threshold get
    // bumped by this — under-funding would leave the airdrop step
    // stranded after the launch finishes, with the user having to
    // top-up to complete the flow.
    const airdropExecutionSol = computeAirdropExecutionCostSol();
    const solMinNeeded = Math.max(0, subtotalSol - solCredit) + airdropExecutionSol;
    const solRecommended = Math.max(0, totalSol - solCredit) + airdropExecutionSol;
    const solMet = sol >= solMinNeeded;
    const solHasFullBuffer = sol >= solRecommended;
    // The displayed "needed" is the bare minimum — the threshold that
    // actually gates proceeding. The recommended figure is shown to the
    // side when the user is below it but above the minimum.
    const solNeeded = solMinNeeded;

    let allMet = true;
    let anyAutoSwapPending = false;

    // ---- Section 1 (Send to wallet): SOL + manual-prefund tokens. -----
    // Each row needs to be 'met' for the launch to proceed.
    document.querySelectorAll('#balanceRows .balance-row').forEach((row) => {
      const kind = row.dataset.kind;

      if (kind === 'sol') {
        row.querySelector('[data-field="actual"]').textContent = sol.toFixed(4);
        // "Needed" shows the RECOMMENDED total (with buffer), even after
        // swap credits are applied. This is what the user should aim for
        // when funding — landing exactly at the bare minimum would mean
        // any unexpected cost variance fails the launch.
        //
        // The row turns green when wallet >= bare minimum (subtotal - credit)
        // so the user can still proceed if they've slightly eaten into the
        // buffer post-funding (e.g. swaps cost a touch more than budgeted).
        // The buffer-note span surfaces the situation when this happens.
        row.querySelector('[data-field="needed"]').textContent = solRecommended.toFixed(3);
        const bufferNote = row.querySelector('[data-field="buffer-note"]');
        if (bufferNote) {
          if (!solMet) {
            // Below bare minimum — can't proceed. Show how much more SOL
            // is actually needed for the launch to be viable (not the
            // buffered amount, just enough to complete the work). This
            // gives the user a clear "send me at least X more SOL" number.
            const short = (solMinNeeded - sol).toFixed(4);
            bufferNote.textContent = `(at least ${short} more SOL needed)`;
            bufferNote.className = 'is-size-7 has-text-danger ml-2';
          } else if (!solHasFullBuffer) {
            // Above minimum, below recommended-with-buffer. Soft hint —
            // launch will work but variance has eaten into the safety
            // margin. Inform the user how much they're short of the
            // recommended buffer so they can top up if they want full safety.
            const short = (solRecommended - sol).toFixed(4);
            bufferNote.textContent = `(below recommended +${short} SOL buffer — can proceed but launch may fail on cost overruns)`;
            bufferNote.className = 'is-size-7 has-text-warning ml-2';
          } else {
            // Above recommended — full buffer intact. No annotation.
            bufferNote.textContent = '';
            bufferNote.className = 'is-size-7 has-text-grey ml-2';
          }
        }
        row.classList.toggle('met', solMet);
        if (!solMet) allMet = false;
        return;
      }

      // Manual-prefund token row: balance goes up only when the user
      // sends tokens themselves. Compares against data-target (precise)
      // not the displayed text (may be rounded by formatTokenDisplay).
      const mint = row.dataset.mint;
      const have = tokens[mint] ? tokens[mint].amountUi : 0;
      const neededWhole = Number(row.dataset.target);
      row.querySelector('[data-field="actual"]').textContent = formatTokenDisplay(have);
      const met = have >= neededWhole;
      row.classList.toggle('met', met);
      if (!met) allMet = false;
    });

    // ---- Section 2 (We'll acquire for you): auto-swap tokens. -----
    // Status text drives the visible state. Possible states:
    //   Pending          → waiting for SOL funding (or click Acquire)
    //   Ready to acquire → SOL is funded, click Acquire button
    //   Swapping…        → set by the Acquire handler during the call
    //   Acquired ✓       → balance >= target
    //   needs more SOL   → set by the Acquire handler on INSUFFICIENT_SOL
    //   failed           → set by the Acquire handler on transient errors
    //
    // Polling only updates status when the row hasn't been explicitly
    // set to a non-default state by the Acquire handler. We detect that
    // by checking for a 'sticky' marker the handler sets — anything
    // marked sticky is left alone here so we don't clobber a user-
    // facing message with a generic 'Pending'.
    document.querySelectorAll('#autoSwapRows .balance-row').forEach((row) => {
      const mint = row.dataset.mint;
      const target = Number(row.dataset.target);
      const have = tokens[mint] ? tokens[mint].amountUi : 0;
      const met = have >= target;
      row.classList.toggle('met', met);
      const status = row.querySelector('[data-field="status"]');
      const sticky = row.dataset.statusSticky === '1';

      if (met) {
        // Acquired — overrides any sticky state since we're done.
        // Also clear the retry button (the row was acquired, no need
        // to retry).
        status.textContent = 'Acquired ✓';
        status.className = 'is-size-7 has-text-success';
        row.dataset.statusSticky = '';
        row.classList.remove('row-can-retry');
        // Belt-and-suspenders SOL credit: if the row is met but its
        // plan item's credit hasn't been applied yet (e.g. swap landed
        // before our polling caught the result, or page state somehow
        // missed the onResult call), apply it here. Idempotent via the
        // _solCredited flag on the plan item.
        const planItem = (fundingRequirement.autoSwapPlan || [])
          .find((p) => p.quoteMint === mint);
        if (planItem && !planItem._solCredited && planItem.estSolSpend) {
          fundingRequirement.solCreditedForCompletedSwaps =
            (fundingRequirement.solCreditedForCompletedSwaps || 0) + planItem.estSolSpend;
          planItem._solCredited = true;
        }
      } else {
        anyAutoSwapPending = true;
        allMet = false;
        if (!sticky) {
          // Row isn't in a user-set state (failure message etc.) — write
          // the default status. Also clear retry button since these are
          // non-failure states.
          row.classList.remove('row-can-retry');
          if (solMet) {
            status.textContent = 'Ready to acquire';
            status.className = 'is-size-7 has-text-info';
          } else {
            status.textContent = 'Pending';
            status.className = 'is-size-7 has-text-grey';
          }
        }
      }
    });

    document.getElementById('continueToTokenBtn').disabled = !allMet;

    // Next-action hint: say WHY continue is disabled and what to do
    // next. A disabled button with no stated reason is a dead end — the
    // only prior cue was the small per-row status text, which is easy to
    // miss (especially "Ready to acquire", which needs a button click
    // the user may not connect to the disabled continue).
    const nextHint = document.getElementById('fundingNextHint');
    if (nextHint) {
      if (allMet) {
        nextHint.classList.add('hidden');
      } else if (!solMet) {
        nextHint.textContent = 'Waiting for SOL — send the recommended amount to the launch wallet above, then the checks update automatically.';
        nextHint.classList.remove('hidden');
      } else if (anyAutoSwapPending) {
        nextHint.textContent = 'SOL funded ✓ — click “Acquire quote tokens” to swap for the remaining pool tokens, then Continue unlocks.';
        nextHint.classList.remove('hidden');
      } else {
        nextHint.textContent = 'Waiting for the remaining token balances to arrive — the checks above update automatically.';
        nextHint.classList.remove('hidden');
      }
    }

    // Acquire-quote-tokens button: enabled when SOL is funded AND
    // there are still pending auto-swaps. Disabled-but-visible when
    // SOL is short so the user sees the button is there waiting.
    const acquireBtn = document.getElementById('acquireQuoteTokensBtn');
    if (acquireBtn) {
      acquireBtn.disabled = !solMet || !anyAutoSwapPending;
    }

    // Funder detection: re-attempt whenever SOL goes up (new deposit
    // arrived since last check) AND we don't already have a funder.
    // Previously this used a one-shot exhausted flag that, once set,
    // never tried again — so a transient RPC failure on the first
    // attempt could permanently disable detection. Now we reset the
    // flag on any balance increase, which is the only condition under
    // which a new funder could appear anyway.
    if (sol > lastSolBalance) {
      fundingDetectionExhausted = false;
    }
    if (!fundingWallet && sol > 0 && !fundingDetectionExhausted) {
      detectFundingWallet();
    }
    lastSolBalance = sol;

    // Reset the consecutive-failure counter on any successful poll.
    // (See catch block below.)
    consecutivePollFailures = 0;
  } catch (e) {
    // Polling errors mean we don't have fresh balance data. We don't
    // want to spam the log with every failed poll, but staying silent
    // forever is worse — if the user's RPC is down or the server has
    // crashed, they'd see frozen balances with no indication of why.
    // Compromise: log once at the 3rd consecutive failure (about 15s in)
    // and stay quiet after that.
    consecutivePollFailures++;
    if (consecutivePollFailures === 3) {
      log(
        'Balance polling is failing — RPC or server may be unreachable. ' +
        'Balances shown may be stale.',
        'warning',
      );
    }
  }
}

// Module-scope counter so failure logs throttle across polls.
// Reset in pollBalances() on any successful round-trip.
let consecutivePollFailures = 0;

// Tracks the SOL balance reading from the previous pollBalances cycle.
// Used to detect deposits — when sol > lastSolBalance, a new deposit
// landed and we should re-attempt funder detection (in case the first
// attempt failed with no funder and got marked exhausted).
let lastSolBalance = 0;

// Per-attempt guard so we don't keep firing detection RPC every 5s
// while the user is funding gradually. Reset when:
//   - the wallet is regenerated (entirely new session)
//   - the SOL balance goes up (new deposit, possibly from a new funder)
// Set when:
//   - detection returned no funder (the answer isn't going to change
//     without a new deposit)
let fundingDetectionExhausted = false;

async function detectFundingWallet() {
  try {
    const resp = await fetch('/api/find-funder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ publicKey: tempWallet.publicKey }),
    });
    const data = await resp.json();
    if (data.success && data.result && data.result.funder) {
      fundingWallet = data.result.funder;
      document.getElementById('fundingWalletInfo').classList.remove('hidden');
      document.getElementById('detectedFundingWallet').textContent = fundingWallet;
      log(`Funding wallet identified: ${fundingWallet} (${data.result.amount} SOL)`, 'info');
    } else {
      // No funder found — stop retrying. The detection looks at recent
      // inbound transfers; if there isn't a clear single funder, we
      // shouldn't keep asking. The user can paste their destination
      // address manually in Step 6 anyway.
      fundingDetectionExhausted = true;
    }
  } catch (e) {
    // Network/RPC failure — let the next pollBalances cycle try again
    // (don't set fundingDetectionExhausted). One failure shouldn't
    // permanently disable detection.
  }
}

bind('refreshBalanceBtn', 'click', pollBalances);

// "Pretend funding arrived (DEMO)" button. Demo mode only — the button is
// hidden in real mode (see setupDemoMode in startup.js). Sends the funding
// amounts the UI already computed (recommended SOL with a small buffer,
// plus every manual-prefund token's target) to the demo ledger, then
// refreshes balances so the green checkmarks light up. Auto-swap tokens
// are intentionally left out — those are acquired via the demo Acquire
// flow so that step stays demonstrable.
bind('demoFundBtn', 'click', async () => {
  if (!tempWallet) return;
  const btn = document.getElementById('demoFundBtn');
  setLoading(btn, true);
  try {
    // Recommended SOL (subtotal + buffer), with a little extra on top so
    // the row lands above the recommended threshold (fully green, no
    // "below recommended buffer" note).
    const recommendedSol = fundingRequirement.totalSol
      || (fundingRequirement.solLamports / 1e9)
      || 0;
    const sol = recommendedSol > 0 ? recommendedSol * 1.05 : 1;

    // Manual-prefund token rows (Section 1) carry their mint, decimals,
    // and whole-token target as data attributes.
    const tokens = [];
    document.querySelectorAll('#balanceRows .balance-row').forEach((row) => {
      if (row.dataset.kind === 'sol') return;
      const mint = row.dataset.mint;
      if (!mint) return;
      tokens.push({
        mint,
        amountUi: Number(row.dataset.target) || 0,
        decimals: Number(row.dataset.decimals) || 9,
      });
    });

    const resp = await fetch('/api/demo/inject-funds', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ publicKey: tempWallet.publicKey, sol, tokens }),
    });
    const data = await resp.json();
    if (!data.success) throw new Error(data.error || 'inject-funds failed');
    log('Demo funding injected — balances updated', 'success');
    // Pick up the new balances right away.
    pollBalances();
  } catch (e) {
    log(`Demo funding failed: ${e.message}`, 'danger');
  } finally {
    setLoading(btn, false);
  }
});

// Acquire-quote-tokens button: triggers SOL → quote-token swaps for
// every allocation the funding-estimate flagged as auto-swappable.
//
// Failure handling:
//   - The backend retries internally (multiple pools × retry ladder).
//     We don't retry from here; we just present results.
//   - SUCCESS  → row goes green, user proceeds.
//   - INSUFFICIENT_SOL → row stays auto-swap, message asks user to fund
//     more SOL. (Once they do, click Acquire again — idempotent.)
//   - NO_USABLE_POOL / ALL_ATTEMPTS_FAILED → row CONVERTS to manual-
//     prefund. The user sees the same wallet address + required amount
//     they would have seen if the estimate had routed manual upfront.
//     This is the "no friction" guarantee: even if the auto path
//     completely fails, the user has a working path forward without
//     restarting.
//   - Any other error → treated as transient, row shows retry hint.
// Set a row's status text/color/title and (optionally) mark it sticky
// so the 5s balance-poll doesn't overwrite the message. `canRetry`
// toggles the .row-can-retry class which reveals the per-row retry
// button via CSS; pass true for failure states that the user can
// recover from with another click.
//
// Module-scope (not closure-scoped to the Acquire handler) because the
// per-row retry button needs to call it too.
function setAutoSwapRowStatus(mint, text, color, { sticky = false, title = '', canRetry = false } = {}) {
  const row = document.querySelector(
    `#autoSwapRows .balance-row[data-kind="token-autoswap"][data-mint="${CSS.escape(mint)}"]`,
  );
  const status = row?.querySelector('[data-field="status"]');
  if (!row || !status) return;
  status.textContent = text;
  status.className = `is-size-7 has-text-${color}`;
  status.title = title;
  row.dataset.statusSticky = sticky ? '1' : '';
  row.classList.toggle('row-can-retry', !!canRetry);
}

// Guards against concurrent calls to runAcquireFlow. Both the bulk
// Acquire button and per-row retry buttons consult this — running two
// in parallel against the same wallet causes SOL-balance races (one
// run depletes the funded SOL faster than the other can read it).
// Backend would classify the loser as INSUFFICIENT_SOL, which is
// recoverable but noisy. Avoiding the race entirely is cleaner.
let isAcquireFlowRunning = false;

/**
 * Run the acquire-quote-tokens flow for a given subset of the plan.
 * Used by both the global Acquire button (passing all pending rows)
 * and the per-row retry button (passing just one row's plan item).
 *
 * Drives the UI state machine: Queued → Swapping → Acquired/Failed,
 * updates the top-line progress label, and emits log lines.
 *
 * Returns nothing — failures are surfaced via row states and the log,
 * not via thrown exceptions, so a single bad swap doesn't break the
 * batch. If another acquire flow is already in flight, this returns
 * immediately without doing anything (caller is expected to gate
 * its UI affordance before calling, but we double-check here).
 */
async function runAcquireFlow(planSubset, btn) {
  if (!planSubset.length) return;
  if (isAcquireFlowRunning) {
    log('Another acquire is in progress; please wait for it to finish.', 'warning');
    return;
  }
  // Set the global guard and button-loading state INSIDE try so the
  // finally block can reliably clean them up even if something between
  // here and the network call throws. Without this wrapper, an
  // unexpected exception in setLoading() or row-status-setup code
  // would leave isAcquireFlowRunning permanently true and lock out
  // future acquire attempts.
  isAcquireFlowRunning = true;
  if (btn) setLoading(btn, true);

  const counts = { success: 0, solShort: 0, converted: 0, retryable: 0 };
  let completed = 0;
  const totalPlanned = planSubset.length;

  const updateProgressLabel = () => {
    const label = document.getElementById('autoSwapProgressLabel');
    if (!label) return;
    if (completed >= totalPlanned) {
      label.textContent = `${completed} of ${totalPlanned} processed.`;
    } else {
      label.textContent = `Acquiring — ${completed} of ${totalPlanned} complete…`;
    }
  };

  // Track which rows received a `result` event from the backend. Any
  // rows still missing one after the stream closes are stragglers —
  // either the swap was still running when the connection dropped, or
  // it never got scheduled, or the response stream truncated. Either
  // way we mark them as failed-retryable so the user can recover.
  const resultsReceived = new Set();

  // Mark every selected row as "Queued" so the user sees something
  // happen immediately, even though only 4 workers are running at a
  // time on the backend. Clears any previous retry button.
  for (const item of planSubset) {
    setAutoSwapRowStatus(item.quoteMint, 'Queued', 'grey', { sticky: true });
  }
  updateProgressLabel();

  log(
    `Acquiring ${totalPlanned} quote token${totalPlanned === 1 ? '' : 's'} via Raydium swap…`,
  );

  // Per-event handlers, defined here so they close over counts/progress.
  // (We used to also have an onAttempt handler that flipped a row to
  // "Swapping…" — now done inline in the polling loop based on the
  // server's inProgressMints list, which is more accurate.)
  const onResult = (r) => {
    completed++;
    resultsReceived.add(r.quoteMint);
    if (r.success) {
      counts.success++;
      // Credit this swap's budgeted SOL against the requirement. The
      // original solLamports estimate reserved ~$4 of SOL per auto-swap;
      // now that the swap has completed (the SOL is gone), we subtract
      // that reserve so the SOL row's "needed" reflects only what's
      // still ahead (pool creation, positions, Arweave, headroom).
      //
      // We use estSolSpend from the plan item, not the swap's actual
      // SOL consumption (which we don't have a precise measurement of).
      // Slight over- or under-shoot from the actual cost is absorbed by
      // the original estimate's safety buffer.
      //
      // Guard: only credit ONCE per row. The polling loop replays the
      // full results array on every poll, so onResult might be called
      // for the same mint multiple times across retries; resultsReceived
      // catches that upstream (early-return at the top), but it's worth
      // making the credit explicitly idempotent via the plan item's
      // own flag.
      const planItem = (fundingRequirement.autoSwapPlan || [])
        .find((p) => p.quoteMint === r.quoteMint);
      if (planItem && !planItem._solCredited && planItem.estSolSpend) {
        fundingRequirement.solCreditedForCompletedSwaps =
          (fundingRequirement.solCreditedForCompletedSwaps || 0) + planItem.estSolSpend;
        planItem._solCredited = true;
      }
      setAutoSwapRowStatus(r.quoteMint, 'Acquired ✓', 'success', {
        sticky: false,
        title: r.txId ? `tx: ${r.txId}` : '',
      });
      log(
        `Acquired ${r.quoteSymbol}` +
          (r.txId ? ` (tx ${r.txId.slice(0, 8)}…)` : ' (already had enough)'),
        'success',
      );
      updateProgressLabel();
      return;
    }
    const err = String(r.error || '');
    if (err.startsWith('INSUFFICIENT_SOL')) {
      counts.solShort++;
      setAutoSwapRowStatus(r.quoteMint, 'Needs more SOL — top up & retry', 'warning', {
        sticky: true,
        title: err,
        canRetry: true,
      });
      log(`${r.quoteSymbol}: ${err}`, 'warning');
    } else if (err.startsWith('NO_USABLE_POOL') || err.startsWith('ALL_ATTEMPTS_FAILED')) {
      counts.converted++;
      convertAutoSwapRowToManual(r.quoteMint, r.quoteSymbol);
      log(
        `${r.quoteSymbol}: auto-swap unavailable, switched to manual ` +
          `(send ${r.quoteSymbol} to the wallet address above). Reason: ${err}`,
        'warning',
      );
    } else {
      counts.retryable++;
      setAutoSwapRowStatus(r.quoteMint, 'Failed — click retry', 'danger', {
        sticky: true,
        title: err,
        canRetry: true,
      });
      log(`${r.quoteSymbol}: ${err}`, 'danger');
    }
    updateProgressLabel();
  };

  // Now safe to enter the network phase — guard and loading state are
  // both set, finally will clean them up.
  try {
    // 1. POST to kick off the job. Returns immediately with { jobId }.
    //    The actual swap work runs in the background on the server.
    const resp = await fetch('/api/acquire-quote-tokens', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        walletPublicKey: tempWallet.publicKey,
        // F5: the server resolves the secret from its encrypted store using
        // the public key for real launches; only demo mode (in-memory
        // ledger, no server-side secret) still sends the key inline.
        ...(demoModeActive ? { tempWalletSecretKey: tempWallet.secretKey } : {}),
        autoSwapPlan: planSubset,
      }),
    });
    if (!resp.ok) {
      // Pull the structured body if there is one — a 409 OP_IN_FLIGHT
      // means another launch operation (a still-running acquire, or a
      // launch in progress) holds the wallet; the server's message
      // explains what to do. Anything else surfaces its error text.
      const body = await resp.json().catch(() => ({}));
      if (resp.status === 409 && body.code === 'OP_IN_FLIGHT') {
        log(body.error, 'warning');
      } else {
        log(`Acquire failed: ${body.error || `HTTP ${resp.status}`}`, 'danger');
      }
      return;
    }
    const { jobId } = await resp.json();
    if (!jobId) {
      log('Acquire failed: no jobId returned', 'danger');
      return;
    }

    // 2. Poll the job until it's done. Each poll is a fresh HTTP round-
    //    trip, naturally robust against network blips: a failed poll
    //    just retries on the next interval. Replaces our old SSE setup
    //    which was unreliable in Electron's fetch+ReadableStream layer.
    //
    //    Update strategy: on each poll, we compute the diff between the
    //    server's reported results and our local resultsReceived set,
    //    and call onResult for each newly-finished swap. Rows shown as
    //    "in progress" by the server get the "Swapping…" status, rows
    //    listed as pending stay "Queued". On a 404 (job expired), we
    //    fall back to polling on-chain balances and flagging stragglers.
    const POLL_INTERVAL_MS = 2000;
    const POLL_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes, matches server-side JOB_EXPIRY_MS
    const pollStartedAt = Date.now();
    let consecutivePollFailures = 0;
    const MAX_POLL_FAILURES = 5; // ~10 seconds of failures before giving up

    while (true) {
      // Bail out if we've been polling forever — defensive guard
      // against a runaway loop if the server gets into an odd state.
      if (Date.now() - pollStartedAt > POLL_TIMEOUT_MS) {
        log('Acquire polling timed out after 10 minutes', 'warning');
        break;
      }

      let pollResp;
      try {
        pollResp = await fetch(`/api/acquire-quote-tokens/${jobId}`);
      } catch (netErr) {
        // Network blip — retry on next interval. Only give up after
        // MAX_POLL_FAILURES consecutive failures.
        consecutivePollFailures++;
        if (consecutivePollFailures >= MAX_POLL_FAILURES) {
          log(
            `Acquire polling failed ${consecutivePollFailures} times in a row — giving up`,
            'warning',
          );
          break;
        }
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        continue;
      }

      if (pollResp.status === 404) {
        // Job is gone (expired or invalid). Could happen if the user
        // hit Acquire again, getting a new jobId, while a previous
        // poll loop is still running with the old one. Just exit
        // cleanly — the finally block will sync row states from
        // on-chain balances.
        log('Acquire job no longer tracked by server', 'info');
        break;
      }
      if (!pollResp.ok) {
        consecutivePollFailures++;
        if (consecutivePollFailures >= MAX_POLL_FAILURES) {
          log(`Acquire polling HTTP ${pollResp.status} — giving up`, 'warning');
          break;
        }
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        continue;
      }

      consecutivePollFailures = 0;
      const job = await pollResp.json();

      // Apply new results that we haven't already processed. The job's
      // results array is append-only on the server, so any entry we
      // haven't seen yet is new since our last poll.
      for (const r of job.results) {
        if (resultsReceived.has(r.quoteMint)) continue;
        // r might be the same shape as the old SSE result events —
        // onResult handles success/failure/conversion routing.
        onResult(r);
      }

      // Update in-progress rows to "Swapping…". Server reports
      // inProgressMints as an array; loop through and set status on
      // any row that isn't already met or already processed.
      //
      // The check for the `met` class is important: wallet-balance
      // polling runs on a separate ~5s interval and may have already
      // marked a row green because its on-chain balance reflects the
      // new tokens. We don't want to flip such a row back to
      // "Swapping…" — that's confusing and triggers a visible flicker.
      // The race is real because swapSolForQuote waits POST_SWAP_SETTLE_MS
      // after the tx confirms before returning, so for ~2 seconds the
      // mint is still in inProgressMints even though the on-chain
      // balance shows it's done.
      const inProgress = new Set(job.inProgressMints || []);
      for (const mint of inProgress) {
        if (resultsReceived.has(mint)) continue;
        const row = document.querySelector(
          `#autoSwapRows .balance-row[data-kind="token-autoswap"][data-mint="${CSS.escape(mint)}"]`,
        );
        if (!row || row.classList.contains('met')) continue;
        setAutoSwapRowStatus(mint, 'Swapping…', 'info', { sticky: true });
      }

      if (job.status === 'done') {
        if (job.error) {
          log(`Acquire job error: ${job.error}`, 'danger');
        }
        // Optimistically clean up the job server-side. Fire-and-forget;
        // if it fails, the server's auto-expiry will catch it in 10 min.
        fetch(`/api/acquire-quote-tokens/${jobId}`, { method: 'DELETE' })
          .catch(() => { /* ignore */ });
        break;
      }

      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }

    // Polling finished. The finally block runs the post-flow cleanup
    // pass (poll balances, flag any leftover stragglers, log summary).
  } catch (e) {
    log(`Acquire error: ${e.message}`, 'danger');
  } finally {
    // Cleanup pass. Runs in finally so it executes regardless of how
    // the try block exited (normal completion, polling timeout, network
    // error, or thrown exception). The three things we need to do
    // unconditionally on exit:
    //
    //   1. Re-poll on-chain balances first. The job's result list might
    //      have missed a swap that landed at the last moment (between
    //      the swap's confirmation and the job-state read). On-chain
    //      balance is the source of truth — polling will mark such rows
    //      Acquired ✓ via the met-class override.
    //
    //   2. Flag any leftover unresolved rows — anything in planSubset
    //      that didn't produce a result AND isn't met on-chain. These
    //      are rare with the polling architecture (only happens if the
    //      polling loop bailed early via timeout or connection failure)
    //      but we still need to give the user a recovery path.
    //
    //   3. Reset button state. setLoading(false) re-enables the button
    //      and removes the spinner. isAcquireFlowRunning=false unlocks
    //      the global guard so the user can click Acquire again.
    try {
      await pollBalances();
      let unresolvedCount = 0;
      for (const item of planSubset) {
        if (resultsReceived.has(item.quoteMint)) continue;
        const row = document.querySelector(
          `#autoSwapRows .balance-row[data-kind="token-autoswap"][data-mint="${CSS.escape(item.quoteMint)}"]`,
        );
        if (!row || row.classList.contains('met')) continue;
        unresolvedCount++;
        setAutoSwapRowStatus(item.quoteMint, 'Unresolved — click retry', 'danger', {
          sticky: true,
          title: 'No final status was received for this swap. Click retry to try again, or click "Acquire quote tokens" to retry all unresolved swaps at once.',
          canRetry: true,
        });
      }
      if (unresolvedCount > 1) {
        // Helpful hint: bulk retry is faster than clicking each row.
        log(
          `${unresolvedCount} swap${unresolvedCount === 1 ? '' : 's'} didn't complete cleanly — ` +
            `click "Acquire quote tokens" to retry all at once, or use the per-row retry buttons.`,
          'warning',
        );
      }

      const parts = [];
      if (counts.success) parts.push(`${counts.success} acquired`);
      if (counts.solShort) parts.push(`${counts.solShort} need more SOL`);
      if (counts.converted) parts.push(`${counts.converted} switched to manual`);
      if (counts.retryable) parts.push(`${counts.retryable} retryable`);
      if (unresolvedCount) parts.push(`${unresolvedCount} unresolved`);
      if (parts.length > 0) {
        log(
          `Done — ${parts.join(', ')}.`,
          counts.retryable || counts.solShort || unresolvedCount ? 'warning' : 'success',
        );
      }
    } catch (cleanupErr) {
      // Cleanup itself failed. Log but don't re-throw — we still want
      // to reset button state below so the user isn't stuck.
      console.error('Acquire flow cleanup failed:', cleanupErr);
    }

    if (btn) setLoading(btn, false);
    isAcquireFlowRunning = false;
  }
}

bind('acquireQuoteTokensBtn', 'click', async () => {
  const btn = document.getElementById('acquireQuoteTokensBtn');
  const plan = fundingRequirement.autoSwapPlan || [];
  if (plan.length === 0) return;

  // Filter to rows that aren't already satisfied. The backend handles
  // idempotency too, but skipping here saves work and avoids blinking
  // through "Queued" for rows that don't need anything.
  const pendingMints = new Set();
  document.querySelectorAll('#autoSwapRows .balance-row[data-kind="token-autoswap"]')
    .forEach((row) => {
      if (!row.classList.contains('met')) {
        pendingMints.add(row.dataset.mint);
      }
    });
  const pendingPlan = plan.filter((p) => pendingMints.has(p.quoteMint));
  if (pendingPlan.length === 0) {
    log('All auto-swap rows already satisfied — nothing to do.', 'info');
    return;
  }

  await withRunState(async () => {
    await runAcquireFlowWithAutoRetry(pendingPlan, btn);
  });
});

/**
 * Run the acquire flow, then if any stragglers remain (rows whose
 * result events never arrived even though the stream closed),
 * automatically re-run for just those rows ONCE before giving up.
 *
 * Rationale: the stream-disconnect bug we see in practice tends to be
 * transient — a second pass through the same rows usually completes
 * cleanly because the wallet's balance has stabilized (no more parallel
 * RPC contention) and the SSE stream is starting fresh. Auto-retrying
 * once handles 90%+ of these cases without making the user click anything.
 *
 * If auto-retry still leaves stragglers, the per-row retry buttons
 * and the bulk Acquire button are the remaining recovery paths.
 */
async function runAcquireFlowWithAutoRetry(planSubset, btn) {
  await runAcquireFlow(planSubset, btn);

  // Find stragglers: rows in the original plan that didn't make it
  // through. We have to look at the DOM here because runAcquireFlow
  // returns void — the row state IS the source of truth.
  const stragglers = [];
  for (const item of planSubset) {
    const row = document.querySelector(
      `#autoSwapRows .balance-row[data-kind="token-autoswap"][data-mint="${CSS.escape(item.quoteMint)}"]`,
    );
    // Skip rows that:
    //   - Don't exist anymore (converted to manual by a NO_USABLE_POOL error)
    //   - Are already met (acquired successfully)
    //   - Are in a non-retryable failure state (INSUFFICIENT_SOL, etc.)
    //     We detect this via the "Needs more SOL" status text — retrying
    //     won't help if the wallet is still short.
    if (!row) continue;
    if (row.classList.contains('met')) continue;
    const statusText = row.querySelector('[data-field="status"]')?.textContent || '';
    if (statusText.includes('Needs more SOL')) continue;
    stragglers.push(item);
  }

  if (stragglers.length === 0) return; // Clean run, nothing to retry.

  log(
    `Auto-retrying ${stragglers.length} unresolved swap${stragglers.length === 1 ? '' : 's'}…`,
    'info',
  );
  // Brief pause so the user notices the state change and so any
  // in-flight RPC operations have a moment to settle.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await runAcquireFlow(stragglers, btn);
}

// Per-row retry: delegated click handler on the auto-swap section.
// Lives at module scope so it survives row re-renders and works on
// rows added after page load. Looks up the row's mint, finds the
// corresponding plan item, and calls runAcquireFlow with just that one.
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('.row-retry-btn');
  if (!btn) return;
  const row = btn.closest('.balance-row[data-kind="token-autoswap"]');
  if (!row) return;
  const mint = row.dataset.mint;
  const planItem = (fundingRequirement.autoSwapPlan || [])
    .find((p) => p.quoteMint === mint);
  if (!planItem) {
    log('Retry: could not find plan item for this row', 'danger');
    return;
  }

  // If another acquire is already running, give the user clear visual
  // feedback rather than silently ignoring the click. Without this, the
  // user can click multiple retry buttons in a row and have no idea why
  // nothing's happening — the guard kicks in inside runAcquireFlow but
  // the rejection message only goes to the log (which most users don't
  // watch). Flash the row's status and shake the button briefly.
  if (isAcquireFlowRunning) {
    const status = row.querySelector('[data-field="status"]');
    if (status) {
      const original = { text: status.textContent, className: status.className };
      status.textContent = 'Wait — another swap is running…';
      status.className = 'is-size-7 has-text-warning';
      setTimeout(() => {
        // Only restore if nothing else has touched it (e.g. the running
        // flow finished and polling overwrote the status to Acquired ✓).
        if (status.textContent === 'Wait — another swap is running…') {
          status.textContent = original.text;
          status.className = original.className;
        }
      }, 2500);
    }
    return;
  }

  // Disable the row's button while running so the user can't fire
  // multiple parallel retries on the same row. setLoading would dim
  // the whole row visually; a simple disabled flag is less intrusive.
  btn.disabled = true;
  try {
    await withRunState(async () => {
      await runAcquireFlow([planItem], null);
    });
  } finally {
    btn.disabled = false;
  }
});

/**
 * Convert an auto-swap row to a manual-prefund row. Used when the
 * backend reports a terminal failure (no Raydium route available, or
 * all swap attempts exhausted). We move the requirement from the
 * "We'll acquire for you" section to the "Send to wallet" section so
 * the user sees exactly what they need to send themselves, with the
 * same address shown above. Polling picks up the new manual row by
 * its data-kind on the next cycle.
 *
 * After conversion:
 *   - The auto-swap section's row is removed entirely (not modified in
 *     place — fresh element created in #balanceRows).
 *   - autoSwapPlan and byQuote are updated to match the new layout.
 *   - The Acquire button hides itself if no auto rows remain.
 *   - The "send manually" tag distinguishes converted rows from the
 *     manual rows the user saw from the start (visual cue that this
 *     wasn't part of the original plan).
 */
function convertAutoSwapRowToManual(quoteMint, quoteSymbol) {
  const oldRow = document.querySelector(
    `#autoSwapRows .balance-row[data-kind="token-autoswap"][data-mint="${quoteMint}"]`,
  );
  if (!oldRow) return;
  const decimals = Number(oldRow.dataset.decimals);
  // data-target is already the actual bootstrap need (minWhole, not the
  // ambitious acquire target). The auto-swap row was DISPLAYING a higher
  // ≈ amount, but the underlying need is what we ask the user to send.
  const manualTarget = Number(oldRow.dataset.target);

  // Remove from the auto-swap section. If the section becomes empty,
  // hide it entirely so the user doesn't see a stranded header.
  oldRow.remove();
  const autoSection = document.getElementById('autoSwapSection');
  if (autoSection && document.querySelectorAll('#autoSwapRows .balance-row').length === 0) {
    autoSection.style.display = 'none';
  }

  // Build the equivalent manual-prefund row in the send section. Same
  // shape as a row created by renderFundingRequirements' Section 1
  // loop, so polling treats it identically. data-target carries the
  // precise value; the displayed text is formatted for readability.
  const pool = findPoolByMint(quoteMint);
  const displayTarget = formatTokenDisplay(manualTarget);
  // USD chip for consistency with the original Section-1 manual rows.
  // Same source-of-truth (pool's resolved price) and same formatter.
  const priceUsd = Number(pool?.resolvedPriceUsd ?? pool?.quoteUsdOverride);
  const usdValue = Number.isFinite(priceUsd) && priceUsd > 0
    ? manualTarget * priceUsd
    : null;
  const usdChip = usdValue != null
    ? ` <span class="is-size-7 has-text-grey">(${formatUsdShort(usdValue)})</span>`
    : '';
  const newRow = document.createElement('div');
  newRow.className = 'balance-row';
  newRow.dataset.kind = 'token';
  newRow.dataset.mint = quoteMint;
  newRow.dataset.decimals = decimals;
  newRow.dataset.target = String(manualTarget);
  newRow.innerHTML = `
    <span><span class="status-dot"></span>${rowLogoHtml(pool)}<strong>${escapeHtml(quoteSymbol)}</strong>${usdChip}
      <span class="tag is-warning is-light is-small ml-2">send manually</span></span>
    <span><span data-field="actual">0</span> / <span data-field="needed">${displayTarget}</span></span>
  `;
  document.getElementById('balanceRows').appendChild(newRow);
  attachRowLogoFallbacks(newRow);

  // Update fundingRequirement state to match the new layout. Also
  // credit this row's budgeted SOL back: it was reserved for the
  // auto-swap, but the swap isn't happening anymore (the user will
  // manually send the token instead). Without this, the SOL row
  // would falsely report we need extra ~$4 of SOL we no longer do.
  const removedPlanItem = (fundingRequirement.autoSwapPlan || [])
    .find((p) => p.quoteMint === quoteMint);
  if (removedPlanItem && !removedPlanItem._solCredited && removedPlanItem.estSolSpend) {
    fundingRequirement.solCreditedForCompletedSwaps =
      (fundingRequirement.solCreditedForCompletedSwaps || 0) + removedPlanItem.estSolSpend;
    // No need to mark _solCredited on a plan item we're about to drop
    // from the array, but it's cheap consistency.
    removedPlanItem._solCredited = true;
  }
  fundingRequirement.autoSwapPlan = (fundingRequirement.autoSwapPlan || [])
    .filter((p) => p.quoteMint !== quoteMint);
  if (!fundingRequirement.byQuote) fundingRequirement.byQuote = {};
  fundingRequirement.byQuote[quoteMint] = Math.ceil(manualTarget * Math.pow(10, decimals));

  // Hide the Acquire button if no auto rows remain.
  const acquireWrap = document.getElementById('acquireQuoteTokensWrap');
  if (acquireWrap && fundingRequirement.autoSwapPlan.length === 0) {
    acquireWrap.style.display = 'none';
  }
}

bind('continueToTokenBtn', 'click', () => {
  if (balancePollHandle) {
    clearInterval(balancePollHandle);
    balancePollHandle = null;
  }
  setStepSummary(3, `funded`);
  activateStep(4);
});
