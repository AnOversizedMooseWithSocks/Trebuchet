function renderTokenPreview() {
  const block = document.getElementById('tokenPreviewBlock');
  if (!block) return;

  // Read all the inputs. parseNumberInput strips commas from the
  // number-formatted ones; trim whitespace from text fields.
  const nameEl = document.getElementById('tokenName');
  const symbolEl = document.getElementById('tokenSymbol');
  const descEl = document.getElementById('tokenDescription');
  const logoEl = document.getElementById('tokenLogo');

  const name = nameEl ? nameEl.value.trim() : '';
  const symbol = symbolEl ? symbolEl.value.trim() : '';
  const description = descEl ? descEl.value.trim() : '';
  const logoFile = logoEl && logoEl.files && logoEl.files[0] ? logoEl.files[0] : null;
  const animatedLogo = logoFile?.type === 'image/gif';

  // Manage the object URL lifecycle. Revoke any prior URL whenever we
  // replace or clear it. createObjectURL returns a new URL each call
  // so we must store the last one to know what to revoke.
  let logoUrl = null;
  if (logoFile) {
    if (_tokenPreviewLogoObjectUrl) URL.revokeObjectURL(_tokenPreviewLogoObjectUrl);
    logoUrl = URL.createObjectURL(logoFile);
    _tokenPreviewLogoObjectUrl = logoUrl;
  } else if (_tokenPreviewLogoObjectUrl) {
    URL.revokeObjectURL(_tokenPreviewLogoObjectUrl);
    _tokenPreviewLogoObjectUrl = null;
  }

  // Logo fallback letter — shown inside the flat logo circle that sits
  // UNDER the coin canvas. With the 3D coin active the canvas covers it;
  // it's the graceful fallback when WebGL/coin is unavailable.
  const initial = (symbol.charAt(0) || name.charAt(0) || '?').toUpperCase();
  let logoHtml;
  if (logoUrl) {
    logoHtml =
      `<span class="token-preview-logo token-preview-logo-fallback">` +
      `${escapeHtml(initial)}` +
      `<img src="${escapeHtml(logoUrl)}" alt="">` +
      `</span>`;
  } else {
    logoHtml = `<span class="token-preview-logo token-preview-logo-fallback">${escapeHtml(initial)}</span>`;
  }

  // Symbol line. Shown as a ticker with a leading "$" (e.g. $TEST), the
  // convention crypto tokens use. Placeholder italic-grey when empty;
  // keeps the same vertical space so the layout doesn't jump as the user
  // fills in.
  const symbolLine = symbol
    ? `<div class="token-preview-symbol">$${escapeHtml(symbol)}</div>`
    : `<div class="token-preview-symbol is-placeholder">Your token preview</div>`;

  // Name line. Only shown when distinct from symbol — same logic the
  // resolved-info card uses for resolved tokens. Empty string kept as
  // empty markup so spacing stays consistent (margin-top on the next
  // line handles separation regardless).
  const nameLine = (name && name !== symbol)
    ? `<div class="token-preview-name">${escapeHtml(name)}</div>`
    : '';

  // Tech facts (supply, market cap, start price, decimals) plus live pool
  // config and the running launch-cost estimate are all rendered by the
  // shared stat-grid builder, so this card and the lightweight pool/cost
  // refresh path (updatePreviewStats) always agree.
  const statsHtml = buildPreviewStatsHtml();

  // Description line — only when present; truncated to 2 lines via CSS.
  const descLine = description
    ? `<div class="token-preview-desc">${escapeHtml(description)}</div>`
    : '';

  // Header (symbol + name) divided from the stat grid; then the grid and
  // the optional description.
  const stackHtml =
    `<div class="token-preview-stack">` +
      `<div class="token-preview-head">` +
        symbolLine +
        nameLine +
      `</div>` +
      statsHtml +
      descLine +
    `</div>`;

  // Structure-preserving update. The card holds a persistent coin mount
  // (.token-preview-coin) and a persistent progress bar
  // (.token-preview-progress), plus a text stack that gets swapped. We must
  // NOT blow away the coin mount on every render — its <canvas> holds a live
  // WebGL context, and recreating it per keystroke would thrash GL contexts
  // (and hit the browser's context cap). So: build the mount + progress bar
  // once, and thereafter only replace the fallback-logo letter and the stack.
  const progressHtml =
    `<div class="token-preview-progress" id="tokenPreviewProgress">` +
      `<div class="tpp-track"><div class="tpp-fill" id="tokenPreviewProgressFill"></div></div>` +
      `<div class="tpp-label" id="tokenPreviewProgressLabel">Launch progress</div>` +
    `</div>`;

  let coinMount = block.querySelector('.token-preview-coin');
  if (!coinMount) {
    // First render: [main row: coin mount + text stack][progress bar]. The
    // fallback flat logo lives inside the mount, under where the canvas
    // attaches; the progress bar spans the full card width below the row.
    block.innerHTML =
      `<div class="token-preview-main">` +
        `<div class="token-preview-coin" id="tokenPreviewCoin">${logoHtml}</div>` +
        stackHtml +
      `</div>` +
      progressHtml;
    coinMount = block.querySelector('.token-preview-coin');
  } else {
    // Subsequent renders: update the fallback logo (preserving any canvas
    // the coin renderer attached) and swap the text stack. The coin mount
    // and progress bar persist.
    const existingCanvas = coinMount.querySelector('canvas');
    coinMount.innerHTML = logoHtml;
    if (existingCanvas) coinMount.appendChild(existingCanvas);
    const oldStack = block.querySelector('.token-preview-stack');
    if (oldStack) {
      oldStack.outerHTML = stackHtml;
    } else {
      const main = block.querySelector('.token-preview-main') || block;
      main.insertAdjacentHTML('beforeend', stackHtml);
    }
    // Guard for older markup that predates the progress bar.
    if (!block.querySelector('.token-preview-progress')) {
      block.insertAdjacentHTML('beforeend', progressHtml);
    }
  }

  // Reflect the current overall launch progress into the (re)built bar.
  if (typeof updateLaunchProgress === 'function') updateLaunchProgress();

  // Pool-chip logos can fail to load (dead/blocked URL). Image 'error' events
  // don't bubble, so we listen in the capture phase on the stable block — once
  // — and swap a failed chip logo for its letter fallback. This mirrors the
  // pool-editor's pool-logo-fail handling so the preview degrades the same way.
  if (!_previewLogoFailBound) {
    _previewLogoFailBound = true;
    block.addEventListener('error', (e) => {
      const img = e.target;
      if (!img || img.tagName !== 'IMG') return;
      if (img.dataset.action !== 'preview-pool-logo-fail') return;
      const wrapper = img.closest('.tps-pool-logo');
      if (!wrapper) return;
      wrapper.textContent = wrapper.dataset.fallbackInitial || '?';
      wrapper.classList.add('tps-pool-logo-fallback');
    }, true);
  }

  // Drive the 3D coin for still images. An animated GIF stays on the flat
  // <img> preview so the browser can advance every frame; baking it into the
  // WebGL coin texture would freeze it on the first frame.
  if (animatedLogo) {
    destroyCoinPreview();
  } else {
    updateCoinPreview(logoUrl, symbol);
  }

  // Also paint the small standalone logo thumbnail that sits next to
  // the file-picker. Same pattern as the preview card's logo: the
  // initial letter is the parent's text content, and the img — when
  // a file is selected — sits on top via CSS. Failure to decode the
  // image reveals the letter underneath. We always set both classes
  // so the grey fallback background is the baseline; with an image
  // loaded successfully, the img covers it.
  const thumb = document.getElementById('tokenLogoThumb');
  if (thumb) {
    if (logoUrl) {
      thumb.innerHTML =
        `${escapeHtml(initial)}` +
        `<img src="${escapeHtml(logoUrl)}" alt="">`;
    } else {
      thumb.innerHTML = escapeHtml(initial);
    }
  }
}

// Format a per-token USD price for the live preview. Crypto launches
// span a huge range (from $1+ "blue chip" launches to nano-cent
// memecoins) so a single fixed-decimals format doesn't cut it. We use
// a tiered approach plus parseFloat to strip any trailing zeros that
// toFixed leaves behind:
//   ≥ $1            → 2 decimals with locale commas ($1,234.56)
//   $0.01–$1        → up to 4 significant decimals ($0.5, $0.0123)
//   $0.000001–$0.01 → up to 8 significant decimals ($0.0001, $0.00012345)
//   anything tinier → scientific notation ($1.23e-10)
// Returns null for invalid/zero/negative inputs so the caller can fall
// back to a "decimals only" line.
function formatPreviewPrice(p) {
  if (!Number.isFinite(p) || p <= 0) return null;
  if (p >= 1) {
    return '$' + p.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
  if (p >= 0.01) {
    return '$' + parseFloat(p.toFixed(4)).toString();
  }
  if (p >= 0.000001) {
    return '$' + parseFloat(p.toFixed(8)).toString();
  }
  return '$' + p.toExponential(2);
}

function renderPools() {
  // Auto-expand any pool that needs attention before painting. Without
  // this, errors that develop mid-flow (resolution fails, allocation
  // gets bumped to 0%, slices stop summing to 100%) would be hidden
  // inside a collapsed card. The user can still manually re-collapse
  // a pool after fixing it; we only force-open here, never force-close.
  for (const pool of pools) {
    if (poolNeedsAttention(pool)) pool._isExpanded = true;
  }
  poolList.innerHTML = '';
  pools.forEach((pool, idx) => {
    poolList.appendChild(buildPoolNode(pool, idx));
    // Node is now in the DOM, so its depth-chart container can be found and
    // filled. Covers the initial paint and every structural re-render.
    updatePoolDepthChart(idx);
  });
  updateAllocationSummary();
  updateContinueToFundingState();
}

// ---------------------------------------------------------------------------
// Pool-rendering helpers
// ---------------------------------------------------------------------------

// Friendly label for a pool's quote token: the resolved symbol, then a
// user-supplied override, then a shortened mint address (so a raw 44-char
// address never lands in the UI), then '?'. Shared by the pool list title
// and the preview card so the two always read the same.
function poolQuoteLabel(pool) {
  if (pool.resolvedSymbol) return pool.resolvedSymbol;
  if (pool.quoteSymbolOverride) return pool.quoteSymbolOverride;
  const t = pool.quoteToken;
  if (t) return t.length > 12 ? `${t.slice(0, 4)}…${t.slice(-4)}` : t;
  return '?';
}

// Build the inner HTML of a pool's title, e.g. "Pool 1 · SOL · 90% of supply".
//
// The title carries enough info to scan a stack of pools without opening
// any of them: quote-token symbol (resolved if available, falling back to
// the user's input or a truncated mint address), and the supply allocation.
//
// When the pool has a 0% allocation, the title surfaces that inline as a
// warning rather than just sitting on the validation reasons box at the
// bottom of the step. New pools added to a fully-allocated budget land
// here and must catch the user's eye.

// Render the pool's title text (no logo — that's a sibling element in
// the header, painted separately by updatePoolLogo). The title carries
// pool number, symbol, and allocation percent, with the "Pool N" prefix
// dropped when there's only one pool (noise, not signal).
function renderPoolTitle(pool, idx) {
  const label = poolQuoteLabel(pool);
  const pct = Number(pool.supplyPercent);
  const pctNum = Number.isFinite(pct) ? pct : 0;
  const safeLabel = escapeHtml(String(label));

  // "Pool N" prefix is only useful when there are multiple pools — for
  // a single-pool launch (the most common case) it's noise, since
  // there's nothing to disambiguate against.
  const showPoolNum = pools.length > 1;
  const prefix = showPoolNum
    ? `<span class="has-text-weight-bold">Pool ${idx + 1}</span> &middot; `
    : '';

  if (pctNum === 0) {
    return prefix +
           `<span class="has-text-weight-bold">${safeLabel}</span>` +
           ` &middot; <span class="has-text-warning-dark">0% of supply — set an allocation</span>`;
  }
  return prefix +
         `<span class="has-text-weight-bold">${safeLabel}</span>` +
         ` &middot; <span class="has-text-grey">${pctNum}% of supply</span>`;
}

// Update the small logo element in a pool's header. Separate from
// renderPoolTitle so we can update logo and title independently and
// because the logo is a sibling element in the new header layout, not
// embedded in the title span. Falls back to a coloured initial-style
// circle when no image URL is available — keeps the visual rhythm
// stable rather than leaving an empty space.
function updatePoolLogo(node, pool) {
  const el = node.querySelector('[data-field="poolLogo"]');
  if (!el) return;
  const sym = pool.resolvedSymbol || pool.quoteSymbolOverride || '?';
  const initial = sym.charAt(0).toUpperCase() || '?';
  if (pool.resolvedImageUrl) {
    const safeUrl = escapeHtml(pool.resolvedImageUrl);
    el.innerHTML =
      `<img src="${safeUrl}" alt="" loading="lazy" data-action="pool-logo-fail">`;
    el.dataset.fallbackInitial = initial;
    el.classList.remove('pool-row-logo-fallback');
  } else {
    delete el.dataset.fallbackInitial;
    el.textContent = initial;
    el.classList.add('pool-row-logo-fallback');
  }
}

// Update the small "▸ configure" / "▾ collapse" / "needs attention"
// affordance on the right side of the pool header. Reflects whether
// the pool is currently expanded and whether it needs user attention.
// In the warning case, the affordance becomes a clickable hint so users
// can see at a glance what's pending without opening the pool.
function updatePoolAffordance(node, pool) {
  const el = node.querySelector('[data-field="poolAffordance"]');
  if (!el) return;
  const attention = poolNeedsAttention(pool);
  if (attention) {
    // Showing a warning takes priority — even if expanded, we want the
    // user to know there's something pending. The exact message is
    // already encoded in the pool title via renderPoolTitle()'s 0% case
    // and the resolved-info block's error states; this is just a
    // pointer to draw attention.
    el.className = 'pool-row-affordance pool-row-affordance-warn';
    el.textContent = '⚠ needs attention';
  } else if (pool._isExpanded) {
    el.className = 'pool-row-affordance';
    el.textContent = '▾ collapse';
  } else {
    el.className = 'pool-row-affordance';
    el.textContent = '▸ configure';
  }
}

// Single source of truth for "this pool needs the user to do something
// before they can launch." Used both by the new collapsed-header chrome
// (to show a warning state and label) and by the auto-expansion logic
// (to force a pool open when a collapsed view would hide the problem).
//
// Returns one of:
//   null              — pool is fine, can stay collapsed
//   'unresolved'      — resolution failed (no decimals); user must fix
//                       the address or fill in overrides
//   'price-missing'   — resolution succeeded but no USD price; user
//                       must enter one in overrides
//   'no-allocation'   — supplyPercent is 0; the pool would create with
//                       no liquidity allocation, almost always wrong
//   'slice-mismatch'  — legacy name; replaced by 'positions-mismatch'
//   'positions-mismatch' — bootstrap + slices + ladder bands don't sum
//                          to 100% of pool
//
// This intentionally doesn't account for "the user has opened the
// override section but not filled in all values" — that's a finer-
// grained validation handled by updateContinueToFundingState().
function poolNeedsAttention(pool) {
  if (!pool) return null;
  if (Number(pool.supplyPercent) === 0) return 'no-allocation';
  if (pool.resolvedSymbol && pool.resolvedDecimals == null) return 'unresolved';
  if (pool.resolvedSymbol &&
      pool.resolvedDecimals != null &&
      pool.resolvedPriceUsd == null &&
      pool.quoteUsdOverride == null) {
    return 'price-missing';
  }
  // Positions total check: under unified semantics, the sum of
  // bootstrap (if custom) + slice sharePercents + ladder band
  // supplyPercents must equal 100% of pool. If not, the pool is
  // misconfigured and we can't safely send it to the backend.
  if (Math.abs(computePoolPositionsTotal(pool) - 100) > 0.01) return 'positions-mismatch';
  return null;
}

// Compute the sum of all position percentages in a pool: bootstrap
// (if custom), all wide slices, and all ladder bands. Each is "% of
// pool" under unified semantics. The total should be 100%.
function computePoolPositionsTotal(pool) {
  const bsPct = (pool.bootstrapConfig && pool.bootstrapConfig.mode === 'custom')
    ? Number(pool.bootstrapConfig.supplyPercent) || 0
    : 0;
  const slicePct = Array.isArray(pool.distribution)
    ? pool.distribution.reduce((s, x) => s + (Number(x.sharePercent) || 0), 0)
    : 0;
  const bandPct = (pool.ladderConfig && pool.ladderConfig.mode === 'manual' && Array.isArray(pool.ladderConfig.bands))
    ? pool.ladderConfig.bands.reduce((s, b) => s + (Number(b.supplyPercent) || 0), 0)
    : 0;
  return bsPct + slicePct + bandPct;
}

function formatPercentCompact(value, maxDecimals = 4) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '0';
  return Number(n.toFixed(maxDecimals)).toString();
}

function positionSupplyPct(pool, positionPctOfPool) {
  const poolPct = Number(pool?.supplyPercent) || 0;
  const posPct = Number(positionPctOfPool) || 0;
  return (poolPct * posPct) / 100;
}

function formatPositionSupplyHint(pool, positionPctOfPool) {
  const poolPct = Number(pool?.supplyPercent) || 0;
  const supplyPct = positionSupplyPct(pool, positionPctOfPool);
  if (!Number.isFinite(poolPct) || !Number.isFinite(supplyPct) || poolPct <= 0) return '';
  return `= ${formatPercentCompact(supplyPct)}% of supply`;
}

// Absorb a delta into the wide-slices bucket to keep positions total
// at 100% after a structural toggle (bs on/off, ladder on/off). When
// delta > 0, slices need to shrink to make room. When delta < 0,
// slices need to grow to absorb. The adjustment lands on the LAST
// slice — simplest and most predictable for the user (they can see
// at a glance what changed). If absorbing fully would push the last
// slice below 0, it clamps at 0 and the user gets a positions-total
// warning to manually rebalance.
//
// Edge case: pool has no slices at all (distribution empty). Then we
// can't rebalance through slices; total just drifts and the warning
// fires. Should never happen in practice since addPool seeds one
// slice, but we guard anyway.
function rebalanceWideSlicesByDelta(pool, delta) {
  if (!Array.isArray(pool.distribution) || pool.distribution.length === 0) return;
  const lastIdx = pool.distribution.length - 1;
  const newVal = Number(pool.distribution[lastIdx].sharePercent || 0) - delta;
  pool.distribution[lastIdx].sharePercent = Math.max(0, Number(newVal.toFixed(4)));
}

function refreshPositionSupplyHints(poolIdx) {
  const pool = pools[poolIdx];
  if (!pool) return;
  const node = poolList.children[poolIdx];
  if (!node) return;

  node.querySelectorAll('[data-position-total-hint="slice"]').forEach((el, i) => {
    const slice = pool.distribution && pool.distribution[i];
    el.textContent = slice ? formatPositionSupplyHint(pool, slice.sharePercent) : '';
  });
  node.querySelectorAll('[data-position-total-hint="band"]').forEach((el, i) => {
    const band = pool.ladderConfig?.bands && pool.ladderConfig.bands[i];
    el.textContent = band ? formatPositionSupplyHint(pool, band.supplyPercent) : '';
  });
}

function fitPoolPositionsTo100(poolIdx, { quiet = false } = {}) {
  const pool = pools[poolIdx];
  if (!pool) return;
  if (!Array.isArray(pool.distribution) || pool.distribution.length === 0) {
    pool.distribution = [{ sharePercent: 0, recipient: null, useExternalRecipient: false }];
  }

  const total = computePoolPositionsTotal(pool);
  const delta = Number((100 - total).toFixed(4));
  if (Math.abs(delta) <= 0.0001) {
    if (!quiet) log(`Pool ${poolIdx + 1} positions already total 100%.`, 'info');
    return;
  }

  const lastIdx = pool.distribution.length - 1;
  const current = Number(pool.distribution[lastIdx].sharePercent) || 0;
  const next = Number((current + delta).toFixed(4));
  if (next < 0) {
    log(`Pool ${poolIdx + 1}: can't fit positions to 100% by shrinking the last main LP slice. Reduce ladder or bootstrap first.`, 'warning');
    return;
  }

  pool.distribution[lastIdx].sharePercent = next;
  refreshWideSliceInputs(poolIdx);
  updatePoolPositionsTotal(poolIdx);
  if (!quiet) {
    log(`Pool ${poolIdx + 1}: adjusted last main LP slice by ${formatPercentCompact(delta)}% of pool.`, 'info');
  }
}

function roundPoolPositionsToWholeSupply(poolIdx) {
  const pool = pools[poolIdx];
  const poolPct = Number(pool?.supplyPercent) || 0;
  if (!pool || poolPct <= 0) return;

  const refs = [];
  (pool.distribution || []).forEach((slice) => {
    if ((Number(slice.sharePercent) || 0) > 0) {
      refs.push({
        get: () => Number(slice.sharePercent) || 0,
        set: (v) => { slice.sharePercent = v; },
      });
    }
  });
  if (pool.ladderConfig?.mode === 'manual' && Array.isArray(pool.ladderConfig.bands)) {
    pool.ladderConfig.bands.forEach((band) => {
      if ((Number(band.supplyPercent) || 0) > 0) {
        refs.push({
          get: () => Number(band.supplyPercent) || 0,
          set: (v) => { band.supplyPercent = v; },
        });
      }
    });
  }

  if (refs.length === 0) return;

  const exactSupplyPcts = refs.map((ref) => positionSupplyPct(pool, ref.get()));
  const roundedSupplyPcts = exactSupplyPcts.map((pct) => Math.round(pct));
  let anchorIdx = 0;
  for (let i = 1; i < exactSupplyPcts.length; i++) {
    if (exactSupplyPcts[i] > exactSupplyPcts[anchorIdx]) anchorIdx = i;
  }

  const roundedSum = roundedSupplyPcts.reduce((s, v) => s + v, 0);
  const remainder = Number((poolPct - roundedSum).toFixed(4));
  roundedSupplyPcts[anchorIdx] = Number((roundedSupplyPcts[anchorIdx] + remainder).toFixed(4));

  if (roundedSupplyPcts.some((pct) => pct <= 0)) {
    log(`Pool ${poolIdx + 1}: at least one position is too small to round to a whole supply percent. Increase it or adjust manually.`, 'warning');
    return;
  }

  refs.forEach((ref, i) => {
    ref.set(Number(((roundedSupplyPcts[i] / poolPct) * 100).toFixed(4)));
  });
  fitPoolPositionsTo100(poolIdx, { quiet: true });
  renderPools();
  log(`Pool ${poolIdx + 1}: rounded position sizes to whole-token-supply percentages.`, 'info');
}

// Update one pool's title in place.
//
// Called from every input/state change that affects the displayed title:
// supplyPercent typing, quote-dropdown change, custom-mint typing, and
// the async resolution callback. Touches only the title element so we
// don't lose focus on whatever input the user is currently in.
// Refresh a pool's header chrome in place: title, logo, and the
// affordance hint. All three depend on overlapping fields (symbol,
// allocation, resolution status, expanded state, attention status) so
// it's simpler to update them together than to track which-affects-what.
//
// Called from every input/state change that affects the displayed
// header: supplyPercent typing, quote-dropdown change, custom-mint
// typing, and the async resolution callback. Touches only header
// elements so we don't lose focus on whatever input the user is
// currently in.
//
// (Function still named updatePoolTitle for backward compatibility with
// existing call sites — its scope grew but the name stuck.)
// Redraw one pool's liquidity depth chart in place. Cheap and idempotent:
// recomputes the profile from the pool's current config and swaps the SVG.
// Safe to call when the pool is collapsed (no container) — it just no-ops.
function updatePoolDepthChart(poolIdx) {
  const pool = pools[poolIdx];
  if (!pool) return;
  const node = poolList.children[poolIdx];
  if (!node) return;
  const wrap = node.querySelector('[data-field="depthChart"]');
  if (!wrap) return;

  // USD scaling so the quote-side support wall is comparable to the token-side
  // bands. The pool's notional is its share of the target market cap; support's
  // value is its SOL converted through the SOL pool's resolved price.
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
  // renderDepthChartSvg returns '' unless there's a ladder or a (placeable)
  // support wall — a lone wide band says nothing useful. Hide the empty
  // container so it leaves no gap.
  const html = profile ? renderDepthChartSvg(profile) : '';
  wrap.innerHTML = html;
  wrap.style.display = html ? '' : 'none';
}

function updatePoolTitle(poolIdx) {
  const pool = pools[poolIdx];
  if (!pool) return;
  const node = poolList.children[poolIdx];
  if (!node) return;
  const titleEl = node.querySelector('[data-field="poolTitle"]');
  if (titleEl) titleEl.innerHTML = renderPoolTitle(pool, poolIdx);
  updatePoolLogo(node, pool);
  updatePoolAffordance(node, pool);
  // The depth chart's shape depends on the supply split, which several live
  // edits change; refreshing here covers supplyPercent, ladder %, and
  // distribution edits (which all route through here via
  // updatePoolPositionsTotal).
  updatePoolDepthChart(poolIdx);
}

// Apply visibility rules for the per-pool override section ("manual quote
// token info"). Auto-shown when:
//   - resolution came back but with missing fields (the user has to fill
//     them in to continue), or
//   - the user already has any override value typed in (so editing stays
//     accessible without forcing them to find a toggle), or
//   - the user has explicitly opened the section via the toggle link
//     (`_overrideForceOpen`).
//
// Otherwise the section is hidden behind a small "Override resolved
// values" link — the override path stays available for power users but
// doesn't clutter the default view when resolution succeeded.
function applyOverrideVisibility(node, pool) {
  const toggle = node.querySelector('[data-action="toggle-override"]');
  const section = node.querySelector('[data-field="overrideSection"]');
  if (!toggle || !section) return;

  const hasUserOverride =
    !!pool.quoteSymbolOverride ||
    pool.quoteDecimalsOverride != null ||
    pool.quoteUsdOverride != null;
  const resolutionIncomplete =
    !!pool.resolvedSymbol &&
    (pool.resolvedDecimals == null || pool.resolvedPriceUsd == null);
  // Resolution is "fully complete" when we have all three pieces of
  // info (symbol + decimals + price) from the indexer. In that state
  // there's nothing for the user to override, so the toggle button is
  // pure clutter — hide it entirely. The button comes back the moment
  // anything's missing, or the moment the user types an override.
  const resolutionComplete =
    !!pool.resolvedSymbol &&
    pool.resolvedDecimals != null &&
    pool.resolvedPriceUsd != null;

  // When Raydium has no pool for this token, the price comes from
  // GeckoTerminal/DexScreener instead. The price IS usable (the
  // aggregators index Meteora and other DEXes) but the user may
  // reasonably want to override it — they may have better info than
  // the aggregator, especially for low-volume tokens. We make the
  // toggle BUTTON visible so the user has easy access to override,
  // but we DON'T auto-expand the section — the user trusted the
  // aggregator enough to pick this token; we shouldn't nag them by
  // shoving the override panel open by default.
  const raydiumHasNoPool = pool.resolvedRaydiumTradeable === 'no';

  const shouldShow =
    resolutionIncomplete ||
    hasUserOverride ||
    pool._overrideForceOpen === true;

  if (shouldShow) {
    section.classList.remove('hidden');
    toggle.classList.remove('hidden');
    toggle.textContent = '▾ Hide override fields';
  } else {
    section.classList.add('hidden');
    // Hide the toggle too when there's nothing to fix. Keeping it
    // visible was making the resolved-info card look cluttered with a
    // button for an action the user almost never needs to take.
    //
    // EXCEPTION: when Raydium has no pool, keep the toggle visible
    // even though resolution is technically complete via aggregator —
    // the user may want to override the aggregator price, and they
    // shouldn't have to discover a hidden control to do it.
    if (resolutionComplete && !hasUserOverride && !pool._overrideForceOpen && !raydiumHasNoPool) {
      toggle.classList.add('hidden');
    } else {
      toggle.classList.remove('hidden');
      toggle.textContent = 'Override resolved values';
    }
  }
}

// Render the resolved-info content as a multi-line block. Layout:
//
//   ┌──────────────────────────────────────────────────┐
//   │ [logo]   WETH                          ⓘ details │
//   │          Wrapped Ether (Wormhole)                │
//   │          8 decimals · $2,286.35                  │
//   └──────────────────────────────────────────────────┘
//
// Three render states match the original logic exactly:
//   - decimals missing: "Couldn't resolve" red message (hard stop, no
//     logo since there's nothing to show in the modal anyway).
//   - price missing: same layout but with a red "no USD price" line
//     in place of the price (recoverable via override fields).
//   - everything resolved: the full layout above.
//
// Used both from the initial buildPoolNode render and from the in-place
// updateQuoteResolvedDisplay() that runs after async resolution returns,
// to keep both rendering paths consistent.
function renderResolvedInfoHtml(pool) {
  // Resolution-failure case: show a clear error with a retry button.
  // This is distinct from "haven't resolved yet" (pool.resolvedSymbol
  // is null because the resolve call hasn't returned) and from "couldn't
  // read from chain" (pool.resolvedDecimals is null). pool.resolvedFailed
  // is the marker set by resolvePoolQuote when the fetch itself threw —
  // typically a network/server issue where a retry is appropriate.
  if (pool.resolvedFailed) {
    const err = escapeHtml(pool.resolvedFailedError || 'unknown error');
    return (
      `<div class="has-text-danger is-size-7">` +
      `<i class="fas fa-exclamation-circle"></i> ` +
      `Couldn't fetch quote-token info (${err}). ` +
      `<a data-action="retry-resolve" class="has-text-weight-bold">Retry</a>` +
      `</div>`
    );
  }
  if (!pool.resolvedSymbol) return '';

  const safeSym = escapeHtml(pool.resolvedSymbol);

  // Hard-stop case: on-chain read failed entirely. Single-line error,
  // no logo / name / icon. Returns flat text since the parent block
  // is a flex container — single-child works fine.
  if (pool.resolvedDecimals == null) {
    return `<div class="has-text-danger">Couldn't resolve ${safeSym} on-chain — check the address and your RPC.</div>`;
  }

  // Logo (36px circle, left column). Falls back to an initial-letter
  // circle when the image fails to load. Implemented with a structural
  // sibling fallback (the initial-letter is always in the DOM, hidden
  // behind the img) rather than an inline image-error handler with
  // interpolated content. The old approach worked but mixed HTML/JS
  // contexts in a way that's hard to audit for injection — better to
  // build it with regular HTML and CSS.
  const initial = escapeHtml((pool.resolvedSymbol.charAt(0) || '?').toUpperCase());
  let logoHtml;
  if (pool.resolvedImageUrl) {
    const safeUrl = escapeHtml(pool.resolvedImageUrl);
    // The img sits on top of the fallback span. If the img's load fails,
    // the data-action="logo-fail" listener (set up below) hides the img
    // and reveals the fallback. The initial-letter is already in the
    // markup, so the fallback content can't be injection-influenced.
    logoHtml =
      `<span class="resolved-logo resolved-logo-with-image">` +
      `<span class="resolved-logo-initial">${initial}</span>` +
      `<img src="${safeUrl}" alt="" loading="lazy" data-action="logo-fail">` +
      `</span>`;
  } else {
    logoHtml = `<span class="resolved-logo resolved-logo-fallback">${initial}</span>`;
  }

  // Name line — only shown when distinct from symbol. For a token like
  // SOL with name "Solana" we render both; for a token whose metadata
  // has identical name/symbol, we skip the line entirely.
  let nameLine = '';
  if (pool.resolvedName && pool.resolvedName !== pool.resolvedSymbol) {
    nameLine = `<div class="resolved-info-name">${escapeHtml(pool.resolvedName)}</div>`;
  }

  // Technicals line: decimals + price, OR decimals + the no-price hint.
  // Includes a small source-provenance label after the price so the user
  // knows whether the displayed number is verified against Raydium (the
  // canonical answer for pool creation) or just an aggregator estimate
  // (informational only until funding-estimate runs). Per the price-
  // safety plan's Milestone B principle: the user should see the same
  // number throughout the flow, and know where it came from.
  let techLine;
  if (pool.resolvedPriceUsd) {
    const priceTxt = `$${Number(pool.resolvedPriceUsd).toLocaleString(
      undefined,
      { maximumFractionDigits: 6 },
    )}`;
    // Translate the source label into something human-readable. Source
    // vocabulary (matches the funding-estimate + Step-2-cache convention):
    //   'sol'                    → from the SOL/USD oracle
    //   'raydium-probe'          → live Raydium swap probe (best)
    //   'raydium-probe (cached)' → recent (≤ 3 min) Step-2 probe result
    //   'user-override'          → user typed it manually
    //   'oracle'                 → aggregator (gecko/dexscreener) — used
    //                              when Raydium has no pool for this token
    //                              and we trust the aggregators (which
    //                              index Meteora/Orca/etc.) for the price
    //   (null/anything else)     → no provenance known
    let sourceLabel = '';
    const src = pool.resolvedPriceSource;
    if (src === 'raydium-probe' || src === 'raydium-probe (cached)') {
      sourceLabel = ' <span class="has-text-success is-size-7">· verified from Raydium</span>';
    } else if (src === 'sol') {
      sourceLabel = ' <span class="has-text-grey is-size-7">· from SOL/USD oracle</span>';
    } else if (src === 'user-override') {
      sourceLabel = ' <span class="has-text-grey is-size-7">· user-set</span>';
    } else if (src === 'oracle') {
      // Price came from an aggregator (GeckoTerminal/DexScreener) rather
      // than a direct Raydium probe. This can happen because:
      //   1. The quote is in KNOWN_SAFE_QUOTES (flywheels, USDC, USDT) and
      //      we deliberately skipped the probe — the aggregator price IS
      //      from the Raydium pool, just routed through Gecko.
      //   2. Raydium has no pool for this token (Meteora-only, etc.) and
      //      the aggregator picked up the price from another DEX.
      //   3. The probe was unreachable transiently.
      // We can't easily distinguish these from priceSource alone, and the
      // honest advice is the same in all three cases: the user should
      // verify the price matches their expectation before launching.
      //
      // The "verify price" label is a clickable link to the token's
      // GeckoTerminal page so the user can compare in one click. We use
      // the resolved mint (always present for non-SOL pools that reach
      // this branch); fall back to the typed quoteToken if for some
      // reason resolvedMint is null, so the link still works.
      const mint = pool.resolvedMint || pool.quoteToken || '';
      if (mint) {
        const safeMint = encodeURIComponent(mint);
        sourceLabel =
          ' <a href="https://www.geckoterminal.com/solana/tokens/' +
          safeMint +
          '" target="_blank" rel="noopener noreferrer" ' +
          'class="has-text-warning-dark is-size-7" ' +
          'title="Open this token\'s GeckoTerminal page in a new tab">' +
          '· verify price ' +
          '<i class="fas fa-external-link-alt is-size-7"></i></a>';
      } else {
        // No mint to build a URL with — fall back to bare text. Hitting
        // this branch shouldn't happen in practice (you can't reach this
        // code path without a resolved address), but defensive.
        sourceLabel = ' <span class="has-text-warning-dark is-size-7">· verify price</span>';
      }
    }
    techLine = `<div class="resolved-info-tech">${pool.resolvedDecimals} decimals · ${priceTxt}${sourceLabel}</div>`;
  } else {
    // Symbol+decimals came back from on-chain reads but neither
    // GeckoTerminal nor Jupiter could give us a USD price. Common for
    // very-low-volume tokens, including the flywheel tokens this app
    // is designed around. Tell the user clearly and point them at the
    // override fields below — applyOverrideVisibility() auto-shows
    // them when the price is missing, so the user doesn't need to
    // hunt for a toggle.
    techLine =
      `<div class="resolved-info-tech">${pool.resolvedDecimals} decimals · ` +
      `<span class="has-text-danger">no USD price — set one in the override fields below</span></div>`;
  }

  // Info icon — opens the token info modal on click. Wired via delegated
  // event handling on the pool node so this helper just emits HTML.
  const infoIcon =
    `<a class="resolved-info-icon" data-action="show-token-info" title="Token info">` +
    `<i class="fas fa-info-circle"></i> details</a>`;

  // Raydium CLMM compatibility line. We surface three states:
  //   - hard incompatible: red text, names the disallowed extensions.
  //     updateContinueToFundingState also blocks "Continue" in this case.
  //   - unknown (compatible === null): yellow note ("couldn't verify").
  //     Continue is not blocked; user can override via Advanced settings
  //     or fix RPC and retry.
  //   - compatible: nothing (silent), OR a small "Token-2022" pill when
  //     the user is dealing with a Token-2022 mint, so they know the
  //     pool will involve transfer fees / extension semantics.
  let compatLine = '';
  if (pool.resolvedCompatible === false) {
    const exts = (pool.resolvedDisallowedNames || []).join(', ');
    compatLine =
      `<div class="resolved-info-tech has-text-danger">` +
        `<i class="fas fa-exclamation-triangle"></i> ` +
        `Not compatible with Raydium CLMM — ` +
        `unsupported Token-2022 extension${exts.split(',').length === 1 ? '' : 's'}: ` +
        `${escapeHtml(exts)}` +
      `</div>`;
  } else if (pool.resolvedCompatible === null) {
    compatLine =
      `<div class="resolved-info-tech has-text-warning-dark">` +
        `<i class="fas fa-question-circle"></i> ` +
        `Couldn't verify Raydium compatibility ` +
        `(${escapeHtml(pool.resolvedCompatError || 'RPC error')})` +
      `</div>`;
  } else if (pool.resolvedIsToken2022) {
    // Compatible Token-2022. Quiet informational marker so the user
    // knows this isn't a vanilla SPL token — relevant for understanding
    // transfer fee behavior, metadata via on-chain extensions, etc.
    compatLine =
      `<div class="resolved-info-tech has-text-info">` +
        `<i class="fas fa-shield-alt"></i> ` +
        `Token-2022 (compatible)` +
      `</div>`;
  }

  // ──── Safety warning lines (per the price-safety plan, Milestone D) ────
  //
  // Three independent checks the user should see at Step 2, BEFORE
  // they invest time and SOL in funding. Each is rendered inline
  // alongside the compat info so a glance at the quote token tells
  // the whole safety story.

  // 1. Freeze authority — hard block. The token deployer can freeze
  //    the launch wallet's quote-token balance mid-launch, bricking
  //    the entire process. updateContinueToFundingState() also blocks
  //    the Continue button when this is true.
  let freezeAuthLine = '';
  if (pool.resolvedFreezeAuthorityBlock === true) {
    freezeAuthLine =
      `<div class="resolved-info-tech has-text-danger">` +
        `<i class="fas fa-exclamation-triangle"></i> ` +
        `This token has an active freeze authority. The token deployer ` +
        `can freeze your wallet's holdings, which would brick the launch.` +
      `</div>`;
  }

  // 2. Mint authority — soft warning. Supply can be inflated by the
  //    deployer at any time, which would devalue pool contents.
  //    Doesn't block the launch but the user should be cautious.
  let mintAuthLine = '';
  if (pool.resolvedMintAuthorityWarning === true) {
    mintAuthLine =
      `<div class="resolved-info-tech has-text-warning-dark">` +
        `<i class="fas fa-exclamation-circle"></i> ` +
        `This token's supply can be increased by its deployer. Be ` +
        `cautious — supply inflation could devalue the token before ` +
        `your pool is created.` +
      `</div>`;
  }

  // 3. Raydium tradeability — informational. When 'no', Trebuchet falls
  //    back to GeckoTerminal/DexScreener for the price (which index
  //    Meteora and other DEXes). When 'unknown', the probe couldn't
  //    run right now; the launch may still succeed at Step 5 with a
  //    fresh probe or aggregator fallback.
  // 3. Raydium tradeability — informational. When 'no', the price comes
  //    from aggregators instead of Raydium (we already labeled that in
  //    the techLine). When 'unknown', Raydium was unreachable at Step 2
  //    and the launch will probe again at Step 5.
  let raydiumLine = '';
  if (pool.resolvedRaydiumTradeable === 'no') {
    raydiumLine =
      `<div class="resolved-info-tech has-text-warning-dark">` +
        `<i class="fas fa-info-circle"></i> ` +
        `Raydium has no pool for this token. Please verify the price ` +
        `is accurate before launching.` +
      `</div>`;
  } else if (pool.resolvedRaydiumTradeable === 'unknown') {
    raydiumLine =
      `<div class="resolved-info-tech has-text-warning-dark">` +
        `<i class="fas fa-question-circle"></i> ` +
        `Couldn't reach the Raydium Trade API right now ` +
        `(${escapeHtml(pool.resolvedRaydiumProbeError || 'API unreachable')}). ` +
        `Trebuchet will try again at Step 5; if Raydium is still ` +
        `unreachable, you'll need to retry or set an explicit override.` +
      `</div>`;
  }

  return `${logoHtml}` +
         `<div class="resolved-info-stack">` +
         `<div class="resolved-info-top">` +
           `<span class="resolved-info-symbol">${safeSym}</span>` +
           infoIcon +
         `</div>` +
         nameLine +
         techLine +
         compatLine +
         freezeAuthLine +
         mintAuthLine +
         raydiumLine +
         `</div>`;
}

// Populate and show the token info modal for a given pool. The modal
// markup lives in index.html alongside the other modals; this just
// fills in its slots and flips the .is-active class to show it.
//
// Re-uses the same pattern as confirmDialog/cancelConfirmModal — no new
// modal infrastructure. External links are constructed from the resolved
// mint, which is the canonical address for any of the explorers.
function showTokenInfoModal(pool) {
  const modal = document.getElementById('tokenInfoModal');
  if (!modal) return;
  const body = document.getElementById('tokenInfoBody');
  if (!body) return;
  const mint = pool.resolvedMint || pool.quoteToken || '';
  const symbol = pool.resolvedSymbol || pool.quoteSymbolOverride || '?';
  const name = pool.resolvedName || symbol;
  const decimals = pool.resolvedDecimals ?? pool.quoteDecimalsOverride ?? '—';
  const priceUsd = pool.resolvedPriceUsd ?? pool.quoteUsdOverride;
  const priceTxt = priceUsd
    ? `$${Number(priceUsd).toLocaleString(undefined, { maximumFractionDigits: 8 })}`
    : '<span class="has-text-grey">unavailable</span>';

  const logoHtml = pool.resolvedImageUrl
    ? `<img src="${escapeHtml(pool.resolvedImageUrl)}" alt="" class="token-info-logo" data-action="token-info-logo-fail">`
    : '';

  const safeMint = escapeHtml(mint);
  // External explorer links. We just need the mint — every explorer
  // uses it as the canonical identifier in the URL path.
  const solscanUrl = `https://solscan.io/token/${encodeURIComponent(mint)}`;
  const geckoUrl = `https://www.geckoterminal.com/solana/tokens/${encodeURIComponent(mint)}`;
  const dexscreenerUrl = `https://dexscreener.com/solana/${encodeURIComponent(mint)}`;

  body.innerHTML = `
    <div class="token-info-header">
      ${logoHtml}
      <div class="token-info-titles">
        <div class="token-info-name">${escapeHtml(name)}</div>
        <div class="token-info-symbol">${escapeHtml(symbol)}</div>
      </div>
    </div>

    <table class="table is-narrow is-fullwidth is-size-7 mt-3 mb-3">
      <tbody>
        <tr>
          <td class="has-text-grey" style="width: 30%;">Mint</td>
          <td>
            <span class="is-family-monospace" style="word-break: break-all;">${safeMint}</span>
            <button class="button is-small is-light ml-2" data-action="copy-mint" title="Copy mint address">
              <span class="icon is-small"><i class="fas fa-copy"></i></span>
            </button>
          </td>
        </tr>
        <tr>
          <td class="has-text-grey">Decimals</td>
          <td>${escapeHtml(String(decimals))}</td>
        </tr>
        <tr>
          <td class="has-text-grey">USD price</td>
          <td>${priceTxt}</td>
        </tr>
      </tbody>
    </table>

    <p class="is-size-7 has-text-grey mb-2">View on:</p>
    <div class="buttons are-small">
      <a class="button is-light" href="${escapeHtml(solscanUrl)}" target="_blank" rel="noopener noreferrer">Solscan</a>
      <a class="button is-light" href="${escapeHtml(geckoUrl)}" target="_blank" rel="noopener noreferrer">GeckoTerminal</a>
      <a class="button is-light" href="${escapeHtml(dexscreenerUrl)}" target="_blank" rel="noopener noreferrer">DexScreener</a>
    </div>
  `;

  body.querySelectorAll('[data-action="token-info-logo-fail"]').forEach((img) => {
    img.addEventListener('error', () => {
      img.remove();
    }, { once: true });
  });

  // Wire up the copy-mint button. Clipboard write is async but we don't
  // need to await — just fire and forget, log on success.
  const copyBtn = body.querySelector('[data-action="copy-mint"]');
  if (copyBtn && mint) {
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(mint);
        log(`Mint address copied: ${mint.slice(0, 8)}…${mint.slice(-6)}`, 'info');
      } catch (e) {
        log(`Couldn't copy mint: ${e.message}`, 'warning');
      }
    });
  }

  // Wire up close handlers — close button, background click, and Esc.
  // We do this on first open rather than at init time because app.js
  // runs synchronously and is loaded before the modal markup later in
  // the body, so the elements don't exist yet when init runs. Guarded
  // with a dataset flag so we don't accumulate duplicate listeners on
  // repeat opens of the modal.
  if (!modal.dataset.closeHandlersWired) {
    const close = () => modal.classList.remove('is-active');
    const closeBtn = document.getElementById('tokenInfoCloseBtn');
    if (closeBtn) closeBtn.addEventListener('click', close);
    const bg = document.getElementById('tokenInfoBackground');
    if (bg) bg.addEventListener('click', close);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modal.classList.contains('is-active')) close();
    });
    modal.dataset.closeHandlersWired = 'true';
  }

  modal.classList.add('is-active');
}

function buildPoolNode(pool, idx) {
  const node = document.createElement('div');
  node.className = 'pool-row';

  // Delegated click handler for the resolved-info row. Handles both the
  // info-modal icon and the retry-resolve link, since both live inside
  // the resolved-info block and may be re-rendered as state changes.
  // Using delegation on the pool node means we don't need to re-attach
  // these listeners each time the inner HTML rebuilds.
  node.addEventListener('click', (e) => {
    // Info icon → open the details modal.
    if (e.target.closest('[data-action="show-token-info"]')) {
      e.preventDefault();
      showTokenInfoModal(pool);
      return;
    }
    // Retry-resolve link (shown only when a prior resolve attempt failed)
    // → re-run resolvePoolQuote. Clears the failure marker so the UI
    // shows "resolving…" again, then the resolve call either succeeds
    // (clearing resolvedFailed in its success path) or fails again
    // (re-setting it in the catch).
    if (e.target.closest('[data-action="retry-resolve"]')) {
      e.preventDefault();
      // Provisionally clear the failure state so the UI re-paints to a
      // clean "resolving" state. If the retry fails too, resolvePoolQuote
      // re-sets resolvedFailed in its catch block.
      pool.resolvedFailed = false;
      pool.resolvedFailedError = null;
      updateQuoteResolvedDisplay(idx);
      resolvePoolQuote(idx);
      return;
    }
  });

  // Logo image error handler. Uses event capture (third argument true)
  // because the `error` event doesn't bubble through normal DOM
  // propagation — listeners attached to a parent see it only on the
  // capture phase. When the img fails to load (404, CORS, etc), we add
  // .resolved-logo-img-failed to the wrapping span, which CSS uses to
  // hide the img and reveal the initial-letter fallback that's already
  // sitting underneath it. Same delegation pattern as the click handler
  // above: works across renders without re-attaching.
  node.addEventListener('error', (e) => {
    const img = e.target;
    if (!img || img.tagName !== 'IMG') return;
    if (img.dataset.action === 'logo-fail') {
      const wrapper = img.closest('.resolved-logo-with-image');
      if (wrapper) wrapper.classList.add('resolved-logo-img-failed');
      return;
    }
    if (img.dataset.action === 'pool-logo-fail') {
      const wrapper = img.closest('[data-field="poolLogo"]');
      if (!wrapper) return;
      wrapper.textContent = wrapper.dataset.fallbackInitial || '?';
      delete wrapper.dataset.fallbackInitial;
      wrapper.classList.add('pool-row-logo-fallback');
    }
  }, true);

  const header = document.createElement('div');
  header.className = 'pool-row-header';
  // Header is interactive: clicking anywhere except the trash toggles
  // the body's collapsed/expanded state. We attach the toggle to the
  // entire header (not just the left zone) so the affordance hint on
  // the right side ("▸ configure" / "▾ collapse") is also clickable —
  // it looks like a button, so it should act like one. The trash
  // button stops propagation to avoid double-firing.
  header.innerHTML = `
    <div class="pool-row-header-left">
      <span class="pool-row-logo" data-field="poolLogo"></span>
      <span data-field="poolTitle">${renderPoolTitle(pool, idx)}</span>
    </div>
    <div class="pool-row-header-right">
      <span class="pool-row-affordance" data-field="poolAffordance"></span>
      <button class="button is-danger is-small is-light" data-action="remove-pool">
        <span class="icon"><i class="fas fa-trash"></i></span>
      </button>
    </div>
  `;
  header.querySelector('[data-action="remove-pool"]').addEventListener('click', (e) => {
    e.stopPropagation(); // don't also toggle expand
    removePool(idx);
  });
  header.addEventListener('click', () => {
    pool._isExpanded = !pool._isExpanded;
    renderPools();
  });
  node.appendChild(header);

  // Populate the header's logo and affordance text. These depend on
  // resolved data plus the expansion state, so we set them after the
  // header element is in place. Both code paths below (collapsed
  // early-return and the expanded body build) need this — without it,
  // the header's logo span stays empty and the user sees just a blank
  // white circle next to the pool title.
  updatePoolLogo(node, pool);
  updatePoolAffordance(node, pool);

  // Body wrapper. Holds the form grid, resolved-info block, override
  // section, and distribution section. When the pool is collapsed,
  // we simply skip building this entirely — everything inside it is
  // unnecessary DOM. The body is rebuilt fresh on each renderPools()
  // anyway, so there's no state lost by skipping it.
  if (!pool._isExpanded) {
    return node;
  }

  const body = document.createElement('div');
  body.className = 'pool-row-body';
  node.appendChild(body);

  const row1 = document.createElement('div');
  row1.className = 'columns is-mobile is-multiline pool-row-form';
  row1.innerHTML = `
    <div class="column is-half-mobile">
      <label class="label is-small">Quote Token</label>
      <div class="select is-small is-fullwidth">
        <select data-field="quoteSelect">
          <optgroup label="Native">
            <option value="SOL">SOL</option>
          </optgroup>
          <optgroup label="Flywheels">
            <option value="HipYKXiDh3Kjd1jb7ji6jCEsKQMSGWiFJMdtvH8yb5r">$seige (Meme flywheel — recommended)</option>
            <option value="J1bZFRAFC8ALqAN7ktkcCpobgoeTGfP5Xh1BwCP1oqoj">XLRT (Reserve flywheel)</option>
          </optgroup>
          <optgroup label="Majors">
            <option value="3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh">wBTC (Wormhole)</option>
            <option value="7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs">ETH (Wormhole)</option>
          </optgroup>
          <optgroup label="Stables">
            <option value="USDC">USDC</option>
            <option value="USDT">USDT</option>
            <option value="USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB">USD1 (World Liberty Financial)</option>
          </optgroup>
          <optgroup label="Other">
            <option value="__custom">Custom mint…</option>
          </optgroup>
        </select>
      </div>
      <input class="input is-small mt-1 hidden" type="text" data-field="quoteCustom" placeholder="SPL mint address">
    </div>
    <div class="column is-narrow pool-row-allocation">
      <label class="label is-small">Allocation</label>
      <div class="field has-addons">
        <div class="control">
          <input class="input is-small" type="number" min="0" max="100" step="0.01" data-field="supplyPercent" value="${pool.supplyPercent}">
        </div>
        <div class="control"><a class="button is-small is-static">%</a></div>
      </div>
    </div>
    <div class="column">
      <label class="label is-small">Fee Tier</label>
      <div class="select is-small is-fullwidth">
        <select data-field="ammConfig">
          ${feeTiers.map((t) => {
            const pct = (t.tradeFeeRate / 10000).toString();
            const isDefault = t.index === 3;
            const isSelected = pool.ammConfigIndex === t.index;
            return `<option value="${t.index}" ${isSelected ? 'selected' : ''}>${pct}% / spacing ${t.tickSpacing}${isDefault ? ' (default)' : ''}</option>`;
          }).join('')}
        </select>
      </div>
    </div>
  `;
  body.appendChild(row1);

  const quoteSelect = row1.querySelector('[data-field="quoteSelect"]');
  const quoteCustom = row1.querySelector('[data-field="quoteCustom"]');

  // The dropdown contains a mix of uppercase symbols (SOL/USDC/USDT — these
  // are the tokens the server knows about via KNOWN_QUOTES) and raw mint
  // addresses (the curated tokens in Flywheels/Majors/Stables — these go
  // through the GeckoTerminal lookup path on resolve, same as any custom
  // mint). To decide whether the saved pool.quoteToken matches a dropdown
  // option, we collect all option values from the live <select> rather
  // than maintaining a separate hardcoded list.
  const dropdownValues = new Set(
    Array.from(quoteSelect.querySelectorAll('option'))
      .map((o) => o.value)
      .filter((v) => v && v !== '__custom')
  );

  // Match symbols case-insensitively (SOL/USDC/USDT) and mint addresses
  // case-sensitively (base58 is case-sensitive on Solana).
  const isInDropdown = (() => {
    const t = pool.quoteToken || '';
    if (dropdownValues.has(t)) return true;
    const upper = t.toUpperCase();
    if (dropdownValues.has(upper)) return true;
    return false;
  })();

  if (isInDropdown) {
    // Snap to whichever case matches the option (symbols are uppercase in
    // the dropdown; mint addresses are stored as-is).
    quoteSelect.value = dropdownValues.has(pool.quoteToken)
      ? pool.quoteToken
      : pool.quoteToken.toUpperCase();
    quoteCustom.classList.add('hidden');
  } else {
    quoteSelect.value = '__custom';
    quoteCustom.classList.remove('hidden');
    quoteCustom.value = pool.quoteToken;
  }

  // Initial resolved-info content is populated when resolvedBlock is
  // constructed below (via renderResolvedInfoHtml). No need to set it
  // here.

  // Clear every resolved-state field on the pool. Called whenever the
  // quote-token identity changes (dropdown change OR custom-address
  // change) so stale info from the prior token doesn't bleed through
  // until the new resolution returns.
  //
  // The compat fields (resolvedCompatible, resolvedIsToken2022, etc) are
  // particularly important to reset: if the previous token was flagged
  // incompatible, the red warning would persist on the new token until
  // resolvePoolQuote() returned, AND updateContinueToFundingState() would
  // keep blocking the Continue button on the stale compatible=false. By
  // resetting to compatible=null (unknown), the UI cleanly transitions
  // through "unknown" → "compatible/incompatible" as resolution
  // completes, with no stale-state lockout.
  function clearResolvedFields() {
    pool.resolvedSymbol = null;
    pool.resolvedDecimals = null;
    pool.resolvedPriceUsd = null;
    pool.resolvedMint = null;
    pool.resolvedName = null;
    pool.resolvedImageUrl = null;
    pool.resolvedCompatible = null;
    pool.resolvedIsToken2022 = false;
    pool.resolvedDisallowedNames = [];
    pool.resolvedCompatError = null;
  }

  quoteSelect.addEventListener('change', () => {
    const v = quoteSelect.value;
    if (v === '__custom') {
      quoteCustom.classList.remove('hidden');
      pool.quoteToken = quoteCustom.value || '';
    } else {
      quoteCustom.classList.add('hidden');
      pool.quoteToken = v;
    }
    clearResolvedFields();
    // Refresh the resolved-info block (now empty) and header chrome.
    updateQuoteResolvedDisplay(idx);
    // Also refresh the continue-state immediately — the previous quote
    // may have been blocking via compatible=false; clearing it should
    // unblock the button right away (subject to other pool validations).
    updateContinueToFundingState();
    resolvePoolQuote(idx);
  });
  quoteCustom.addEventListener('change', () => {
    pool.quoteToken = quoteCustom.value;
    clearResolvedFields();
    updateQuoteResolvedDisplay(idx);
    updateContinueToFundingState();
    resolvePoolQuote(idx);
  });

  row1.querySelector('[data-field="supplyPercent"]').addEventListener('input', (e) => {
    pool.supplyPercent = Number(e.target.value);
    // Pool's allocation as % of total supply is one of the inputs to
    // the bootstrap's derived supplyPercent (bs_pct = bs_usd / pool_usd
    // × 100, and pool_usd = targetMc × pool.supplyPercent / 100). If we
    // don't recompute on a pool-size change, positions total drifts and
    // the bootstrap row's hint shows stale numbers.
    recomputePoolBootstrapAndRebalance(pool);
    refreshBootstrapHint(idx);
    refreshWideSliceInputs(idx);
    updateAllocationSummary();
    updatePoolTitle(idx);
    updatePoolPositionsTotal(idx);
    updateContinueToFundingState();
  });

  row1.querySelector('[data-field="ammConfig"]').addEventListener('change', (e) => {
    pool.ammConfigIndex = Number(e.target.value);
  });

  // Resolved-info block. Multi-line layout that gives token info room
  // to breathe instead of cramming logo, name, decimals, and price onto
  // a single overflowing line. Appended after the form grid so it sits
  // between the inputs and the tier-3 action buttons. Filled by
  // renderResolvedInfoHtml() — same renderer used by the in-place
  // updateQuoteResolvedDisplay() so initial paint and post-resolution
  // refresh look identical.
  const resolvedBlock = document.createElement('div');
  resolvedBlock.className = 'resolved-info-block';
  resolvedBlock.dataset.field = 'resolvedBlock';
  resolvedBlock.innerHTML = renderResolvedInfoHtml(pool);
  // Hide the block entirely until resolution returns something — empty
  // grey card looks like a layout bug otherwise.
  if (!pool.resolvedSymbol) resolvedBlock.classList.add('hidden');
  body.appendChild(resolvedBlock);

  // Override section (manual quote token info).
  //
  // Always rendered in the DOM but visibility is controlled by the .hidden
  // class via applyOverrideVisibility() — that lets the async resolution
  // callback toggle visibility without re-rendering anything (and without
  // losing focus on whatever input the user is in). The default is hidden
  // when resolution succeeded fully, auto-shown when something failed or
  // when the user has typed an override.
  //
  // The toggle is a real button now (was a text link); same applies to
  // the distribution-section split toggle below. Tier-3 actions shouldn't
  // look like article hyperlinks.
  const actionRow = document.createElement('div');
  actionRow.className = 'pool-row-actions';
  body.appendChild(actionRow);

  const advToggle = document.createElement('button');
  advToggle.type = 'button';
  advToggle.className = 'button is-small is-light';
  advToggle.dataset.action = 'toggle-override';
  // textContent is set by applyOverrideVisibility() below
  actionRow.appendChild(advToggle);

  const adv = document.createElement('div');
  adv.className = 'advanced-section';
  adv.dataset.field = 'overrideSection';
  adv.innerHTML = `
    <p class="help mb-2">Override the auto-detected info for this quote token. Decimals are read on-chain so they should always be present; symbol comes from Metaplex metadata if available; USD price tries GeckoTerminal then Jupiter. Set anything here to override what the app found, or fill in a price if neither indexer had one.</p>
    <div class="columns is-mobile is-multiline">
      <div class="column">
        <label class="label is-small">Symbol override</label>
        <input class="input is-small" type="text" data-field="symOverride" value="${escapeAttr(pool.quoteSymbolOverride || '')}">
      </div>
      <div class="column">
        <label class="label is-small">Decimals override</label>
        <input class="input is-small" type="number" min="0" max="18" data-field="decOverride" value="${pool.quoteDecimalsOverride ?? ''}">
      </div>
      <div class="column">
        <label class="label is-small">USD price override</label>
        <input class="input is-small" type="number" min="0" step="any" data-field="usdOverride" value="${pool.quoteUsdOverride ?? ''}">
      </div>
    </div>
  `;
  body.appendChild(adv);

  // Set initial visibility + toggle text based on current resolution state.
  applyOverrideVisibility(node, pool);

  advToggle.addEventListener('click', () => {
    // Manual user toggle. Only meaningful when the section would otherwise
    // be hidden (resolution succeeded, no overrides set) — but flipping the
    // flag is harmless when conditions auto-show the section anyway.
    pool._overrideForceOpen = !pool._overrideForceOpen;
    applyOverrideVisibility(node, pool);
  });
  adv.querySelector('[data-field="symOverride"]').addEventListener('change', (e) => {
    pool.quoteSymbolOverride = e.target.value.trim() || null;
    updatePoolTitle(idx);
  });
  adv.querySelector('[data-field="decOverride"]').addEventListener('change', (e) => {
    const v = e.target.value;
    pool.quoteDecimalsOverride = v === '' ? null : Number(v);
    // Override may resolve a "price-missing" attention state; refresh
    // the header's title + affordance accordingly.
    updatePoolTitle(idx);
    updateContinueToFundingState();
  });
  adv.querySelector('[data-field="usdOverride"]').addEventListener('change', (e) => {
    const v = e.target.value;
    pool.quoteUsdOverride = v === '' ? null : Number(v);
    // Same — typing a USD override clears the price-missing warning.
    updatePoolTitle(idx);
    updateContinueToFundingState();
  });

  // Distribution section. Under the unified-positions model, slices
  // are first-class wide LP positions sharing the pool's allocation
  // alongside bootstrap and ladder bands. We always show the slice
  // row(s) — even when there's just one — so the user can see how
  // much of the pool is going to the main LP. Hiding this behind a
  // collapsed "Split fee distribution" button was confusing because
  // the user had no way to see the main LP's % allocation without
  // first expanding.
  //
  // The single-slice case is the common one and that single row
  // serves as "the main LP position." If the user wants to split fee
  // ownership across multiple wallets, they click "Add slice" and
  // the existing slice splits in half. Multiple slices = multiple
  // positions at the same wide range, each with its own Fee Key NFT.
  const distSection = document.createElement('div');
  distSection.className = 'distribution-section';
  body.appendChild(distSection);

  // Header. Text is gentler in the single-slice case (where "slice"
  // doesn't really describe anything — it's just the main LP) vs the
  // multi-slice case (where the split-into-pieces framing is accurate).
  const isSingleSlice = pool.distribution.length <= 1;
  const expandedHeader = document.createElement('div');
  expandedHeader.className = 'distribution-expanded-header';
  expandedHeader.innerHTML = isSingleSlice
    ? `<label class="label is-small mb-0">Main LP position <span class="has-text-grey has-text-weight-normal is-size-7">— wide position above launch; "Add slice" splits fee ownership across recipients</span></label>`
    : `<label class="label is-small mb-0">Main LP positions <span class="has-text-grey has-text-weight-normal is-size-7">— each is a wide position above launch with its own Fee Key</span></label>`;
  distSection.appendChild(expandedHeader);

  const sliceContainer = document.createElement('div');
  sliceContainer.className = 'distribution-slices';
  distSection.appendChild(sliceContainer);

  pool.distribution.forEach((slice, sliceIdx) => {
    sliceContainer.appendChild(buildSliceNode(pool, idx, slice, sliceIdx));
  });

  const addSliceBtn = document.createElement('button');
  addSliceBtn.className = 'button is-light is-small mt-1';
  addSliceBtn.innerHTML = '<span class="icon"><i class="fas fa-plus"></i></span><span>Add slice</span>';
  addSliceBtn.addEventListener('click', () => addSlice(idx));
  distSection.appendChild(addSliceBtn);

  // Custom Positions area. The mockup-approved order puts the whole-pool
  // liquidity depth chart at the TOP (it's the source of truth for the shape),
  // then the Ladder strategy picker, then the Support position at the bottom.
  //
  // Liquidity depth chart — a whole-pool view spanning the support buy wall
  // (below launch) and the wide + ladder positions (above launch). It sits
  // above the controls that feed it so the user reads the shape first, then
  // adjusts. updatePoolDepthChart fills it (and hides it when there's neither
  // a ladder nor support to show, so an unconfigured pool shows no empty chart).
  const depthWrap = document.createElement('div');
  depthWrap.className = 'pool-depth-chart';
  depthWrap.dataset.field = 'depthChart';
  depthWrap.style.cssText = 'margin: 18px 0 6px;';
  body.appendChild(depthWrap);

  // Ladder section: the volatility-strategy picker generates single-sided
  // bands above launch (supplyPercent of pool, lowerMultiplier, upperMultiplier
  // relative to launch). Bands are independent — they can overlap or have gaps,
  // and order doesn't matter to the backend math.
  //
  // Note: the per-pool bootstrap section used to render here too, but was
  // removed as part of the support-consolidation change. The bootstrap is now
  // always a minimal ~$1 reservation; real quote-side starting liquidity is
  // added via the Support position (below). Token-side density near launch
  // price is the Ladder's job.
  body.appendChild(buildLadderNode(pool, idx));

  // Support section: a single-sided quote-only position just below launch
  // price, backing any preallocated supply. Quote-only — does not affect
  // supplyPercent or the positions-total calculation, so it sits at the bottom
  // of the custom-positions area without participating in that math.
  body.appendChild(buildSupportNode(pool, idx));

  // Positions total indicator. Under unified semantics, bootstrap
  // (if custom) + sum(slice sharePercents) + sum(band supplyPercents)
  // must equal 100% of the pool's allocation. Rendered with a stable
  // data-attribute so updatePoolPositionsTotal() can refresh it in place.
  const positionsFooter = document.createElement('div');
  positionsFooter.className = 'position-total-actions mt-3';
  const positionsTotal = document.createElement('p');
  positionsTotal.className = 'has-text-weight-semibold mb-0';
  positionsTotal.dataset.positionsTotal = '';
  positionsFooter.appendChild(positionsTotal);

  const fitPositionsBtn = document.createElement('button');
  fitPositionsBtn.type = 'button';
  fitPositionsBtn.className = 'button is-small is-light';
  fitPositionsBtn.textContent = 'Fit 100%';
  fitPositionsBtn.title = 'Add or subtract the remainder from the last main LP slice';
  fitPositionsBtn.addEventListener('click', () => fitPoolPositionsTo100(idx));
  positionsFooter.appendChild(fitPositionsBtn);

  const roundSupplyBtn = document.createElement('button');
  roundSupplyBtn.type = 'button';
  roundSupplyBtn.className = 'button is-small is-light';
  roundSupplyBtn.textContent = 'Round Supply %';
  roundSupplyBtn.title = 'Snap position sizes to whole percentages of total token supply';
  roundSupplyBtn.addEventListener('click', () => roundPoolPositionsToWholeSupply(idx));
  positionsFooter.appendChild(roundSupplyBtn);
  body.appendChild(positionsFooter);

  // Paint the initial state.
  refreshPoolPositionsTotalNode(positionsTotal, pool);

  return node;
}

// Refresh a positions-total <p> in place with the latest sum and a
// pass/fail visual. Extracted out so both the initial render (above)
// and the in-place update from input handlers (updatePoolPositionsTotal
// below) share the same formatting logic.
function refreshPoolPositionsTotalNode(el, pool) {
  const total = computePoolPositionsTotal(pool);
  const ok = Math.abs(total - 100) <= 0.01;
  el.textContent = `Positions total: ${total.toFixed(2)}% of pool` + (ok ? ' ✓' : ' — must be 100%');
  el.classList.toggle('has-text-success', ok);
  el.classList.toggle('has-text-danger', !ok);
}

// In-place update of the positions-total indicator for one pool.
// Called from every input that changes a position's supply share:
// bootstrap supply input + SOL input, slice-share input, band supply
// input, plus add/remove operations on bands and slices.
//
// We rely on the pool's DOM node being the corresponding index'th
// child of poolList (renderPools paints them in order), and look up
// the indicator inside it via the stable data-attribute selector.
function updatePoolPositionsTotal(poolIdx) {
  const pool = pools[poolIdx];
  if (!pool) return;
  const poolNode = poolList.children[poolIdx];
  if (!poolNode) return;
  const el = poolNode.querySelector('[data-positions-total]');
  if (!el) return;
  refreshPoolPositionsTotalNode(el, pool);
  refreshPositionSupplyHints(poolIdx);
  // The positions-total state also drives the pool's "needs attention"
  // affordance, so refresh that. updatePoolTitle paints the title
  // + affordance together.
  updatePoolTitle(poolIdx);
  updateContinueToFundingState();
}

// Update one pool's bootstrap-hint text in place. Reads the live
// targetMarketCap and the pool's current bs supplyPercent + pool size
// to render "≈ X% of pool · $Y of token supply". Safe to call when
// bootstrap is in minimal mode (clears the hint) or when target mcap
// is missing (clears the hint). Used by every input handler that can
// change inputs to the derivation (the bs SOL input, the pool's
// supplyPercent input) so we keep the hint accurate without a full
// renderPools() that would lose focus.
function refreshBootstrapHint(poolIdx) {
  const pool = pools[poolIdx];
  if (!pool) return;
  const node = poolList.children[poolIdx];
  if (!node) return;
  const hint = node.querySelector('[data-bs-hint]');
  if (!hint) return;
  const isCustom = pool.bootstrapConfig?.mode === 'custom';
  if (!isCustom) { hint.textContent = ''; return; }
  const pct = Number(pool.bootstrapConfig.supplyPercent) || 0;
  const targetMc = parseNumberInput(document.getElementById('targetMarketCap'));
  if (!Number.isFinite(targetMc) || targetMc <= 0 || pct <= 0) {
    hint.textContent = '';
    return;
  }
  const poolUsd = targetMc * (Number(pool.supplyPercent) / 100);
  const bsUsd = (pct / 100) * poolUsd;
  hint.textContent = `≈ ${pct.toFixed(3)}% of pool · $${formatUsdRoughly(bsUsd)} of token supply`;
}

// Refresh wide slice input values in place after a rebalance, without
// touching whichever input the user is currently typing in. Used by
// any handler that calls rebalanceWideSlicesByDelta without doing a
// full renderPools() (typically because the user is mid-keystroke in
// an input we'd destroy on re-render).
function refreshWideSliceInputs(poolIdx) {
  const pool = pools[poolIdx];
  if (!pool) return;
  const node = poolList.children[poolIdx];
  if (!node) return;
  const inputs = node.querySelectorAll('.distribution-slices .slice-share');
  inputs.forEach((inp, i) => {
    if (pool.distribution[i] && document.activeElement !== inp) {
      inp.value = pool.distribution[i].sharePercent;
    }
  });
  refreshPositionSupplyHints(poolIdx);
}

// Build the per-pool support section shown in customize mode. Mirrors
// the bootstrap section in shape: a toggle to enable/disable, plus a
// SOL input as the canonical user-intent value. Unlike bootstrap,
// support is quote-only — it doesn't carve from supplyPercent, so the
// section has no slice-rebalancing or positions-total hooks. It's a
// pure cost-addition position.
//
// Storage: pool.supportConfig = {
//   mode: 'off' | 'custom',
//   solValue: number   (custom only; user's input — SOL value of the
//                       support deposit. Converted to USD-equivalent
//                       quote tokens by the orchestrator.)
// }
function buildSupportNode(pool, poolIdx) {
  const node = document.createElement('div');
  node.className = 'pool-support-section';

  const cfg = pool.supportConfig || { mode: 'off' };
  const isCustom = cfg.mode === 'custom';
  const solValue = Number(cfg.solValue) || 0;
  // Depth: defaults to the module default when the pool was created
  // before depth became configurable, or when mode is 'off' (in which
  // case the value is preserved but not used). Clamped for display.
  const depthPct = clampSupportDepth(
    cfg.depthPct != null ? cfg.depthPct : SUPPORT_DEFAULT_DEPTH_PCT,
  );

  // USD-equivalent display: convert SOL value through the SOL pool's
  // resolved price, if available. Falls back to no display when nothing
  // has resolved yet — same pattern as the simple-config support row.
  const solPool = pools.find((p) => (p.quoteToken || '').toUpperCase() === 'SOL');
  const solUsd = solPool && Number(solPool.resolvedPriceUsd) > 0
    ? Number(solPool.resolvedPriceUsd) : null;
  const initialHint = isCustom && solUsd && solValue > 0
    ? `≈ $${formatUsdRoughly(solValue * solUsd)} buy wall (launch to -${depthPct}%)`
    : (isCustom
        ? `(USD value will show once SOL price resolves; range -${depthPct}%)`
        : '');

  node.innerHTML = `
    <label class="label is-small mb-1 mt-3">
      <input type="checkbox" data-support-toggle ${isCustom ? 'checked' : ''}>
      Support position
    </label>
    <p class="is-size-7 has-text-grey mb-1">
      Single-sided buy-side liquidity that backs preallocated supply with an honest exit.
      The position sits just below launch price (covering down to the configured depth)
      and gives holders of preallocated tokens — team, VCs, presale contributors,
      staking rewards, utility reserves — a buy wall to sell into.
      Quote-only: doesn't carve from this pool's supply allocation.
    </p>
    <div class="slice-row support-row" ${isCustom ? '' : 'style="opacity:0.5;pointer-events:none;"'}>
      <span class="slice-label">Support</span>
      <input class="input is-small" type="number" min="0" step="0.01"
             data-support-sol-value value="${solValue}" ${isCustom ? '' : 'disabled'}
             style="width: 8rem;">
      <span style="line-height:30px;">SOL, down to&nbsp;-</span>
      <input class="input is-small" type="number"
             min="${SUPPORT_MIN_DEPTH_PCT}" max="${SUPPORT_MAX_DEPTH_PCT}" step="1"
             data-support-depth value="${depthPct}" ${isCustom ? '' : 'disabled'}
             style="width: 4.5rem;">
      <span style="line-height:30px;">% below launch</span>
      <span class="is-size-7 has-text-grey-dark" data-support-hint
            style="margin-left:0.5rem;line-height:30px;flex:1;">${escapeHtml(initialHint)}</span>
    </div>
  `;

  const toggle = node.querySelector('[data-support-toggle]');
  const solInput = node.querySelector('[data-support-sol-value]');
  const depthInput = node.querySelector('[data-support-depth]');
  const hint = node.querySelector('[data-support-hint]');

  // Helper: refresh the hint text from current config. Called after any
  // change so the display tracks state without a full re-render.
  function refreshHint() {
    const cur = pool.supportConfig || { mode: 'off' };
    if (cur.mode !== 'custom') {
      hint.textContent = '';
      return;
    }
    const sv = Number(cur.solValue) || 0;
    const dp = clampSupportDepth(cur.depthPct);
    const sp = pools.find((p) => (p.quoteToken || '').toUpperCase() === 'SOL');
    const su = sp && Number(sp.resolvedPriceUsd) > 0 ? Number(sp.resolvedPriceUsd) : null;
    if (su && sv > 0) {
      hint.textContent = `≈ $${formatUsdRoughly(sv * su)} buy wall (launch to -${dp}%)`;
    } else if (sv > 0) {
      hint.textContent = `(USD value will show once SOL price resolves; range -${dp}%)`;
    } else {
      hint.textContent = '';
    }
  }

  // Toggle: flip between off and custom. When flipping ON, restore the
  // last-known solValue + depthPct (or defaults for a fresh enable).
  // When flipping OFF, preserve both fields on the object so a re-toggle
  // restores the user's input — wire format ignores them in off-mode.
  toggle.addEventListener('change', (e) => {
    if (e.target.checked) {
      const restoredSol = Number(pool.supportConfig?.solValue) > 0
        ? Number(pool.supportConfig.solValue) : 1.0;
      const restoredDepth = clampSupportDepth(pool.supportConfig?.depthPct);
      pool.supportConfig = {
        mode: 'custom',
        solValue: restoredSol,
        depthPct: restoredDepth,
      };
    } else {
      pool.supportConfig = {
        mode: 'off',
        solValue: Number(pool.supportConfig?.solValue) || 0,
        depthPct: clampSupportDepth(pool.supportConfig?.depthPct),
      };
    }
    renderPools();
    // Allocation summary doesn't change (support is orthogonal), but
    // the continue-to-funding check might surface a related warning.
    if (typeof updateContinueToFundingState === 'function') updateContinueToFundingState();
  });

  // SOL input: canonical user-intent value. No supplyPercent to compute
  // or rebalance — support is quote-only. Just update state and the
  // hint, in place, so focus stays on the input the user is typing in.
  solInput.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    if (!Number.isFinite(v) || v < 0) return;
    pool.supportConfig = {
      mode: 'custom',
      solValue: v,
      depthPct: clampSupportDepth(pool.supportConfig?.depthPct),
    };
    refreshHint();
    updatePoolDepthChart(poolIdx);
    if (typeof updateContinueToFundingState === 'function') updateContinueToFundingState();
  });

  // Depth input: percent below launch the position covers. Same in-place
  // refresh pattern as the SOL input — don't snap the input value
  // during typing (would interrupt the user mid-keystroke); snap on blur.
  depthInput.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    if (!Number.isFinite(v)) return;
    pool.supportConfig = {
      mode: 'custom',
      solValue: Number(pool.supportConfig?.solValue) || 0,
      depthPct: v, // un-clamped during typing; clamped at use-sites
    };
    refreshHint();
    updatePoolDepthChart(poolIdx);
    if (typeof updateContinueToFundingState === 'function') updateContinueToFundingState();
  });
  depthInput.addEventListener('blur', (e) => {
    const v = clampSupportDepth(e.target.value);
    pool.supportConfig = {
      mode: 'custom',
      solValue: Number(pool.supportConfig?.solValue) || 0,
      depthPct: v,
    };
    e.target.value = v;
    refreshHint();
    updatePoolDepthChart(poolIdx);
  });

  return node;
}

function buildBootstrapNode(pool, poolIdx) {
  // Bootstrap is one of three position types (alongside wide slices
  // and ladder bands). Two states:
  //   minimal — 1-whole-token reserve, no user funds, no slot in 100%
  //   custom  — user-funded position, sized by an absolute SOL value
  //
  // The user thinks in terms of "how much starting liquidity do I want
  // to put down", not "what % of supply." So this row has a single SOL
  // input as the canonical control; the supplyPercent (% of pool) is
  // derived live and shown in the hint. Whenever solValue changes, or
  // target mcap changes, or SOL price resolves, supplyPercent is
  // recomputed and the wide slices auto-rebalance so positions total
  // stays at 100%.
  //
  // Storage: pool.bootstrapConfig = {
  //   mode: 'minimal' | 'custom',
  //   solValue: number   (custom only; user's input)
  //   supplyPercent: number   (custom only; derived from solValue)
  // }
  // The wire format conversion in buildAllocationsForApi uses
  // supplyPercent directly — solValue stays on the UI side.
  const node = document.createElement('div');
  node.className = 'pool-bootstrap-section';

  const cfg = pool.bootstrapConfig || { mode: 'minimal' };
  const isCustom = cfg.mode === 'custom';
  const solValue = Number(cfg.solValue) || 0;

  node.innerHTML = `
    <label class="label is-small mb-1 mt-3">
      <input type="checkbox" data-bs-toggle ${isCustom ? 'checked' : ''}>
      Bootstrap support liquidity
    </label>
    <p class="is-size-7 has-text-grey mb-1">
      Single full-range position centered on launch price.
      Off: a tiny ~$1 reserve that just makes the pool tradable.
      On: a meaningful starting-liquidity position. Token-side carves from this pool's allocation;
      quote-side is funded during the next step.
    </p>
    <div class="slice-row bootstrap-row" ${isCustom ? '' : 'style="opacity:0.5;pointer-events:none;"'}>
      <span class="slice-label">Bootstrap</span>
      <input class="input is-small" type="number" min="0" step="0.001"
             data-bs-sol-value value="${solValue}" ${isCustom ? '' : 'disabled'}
             style="width: 8rem;">
      <span style="line-height:30px;">SOL of starting liquidity</span>
      <span class="is-size-7 has-text-grey-dark" data-bs-hint style="margin-left:0.5rem;line-height:30px;flex:1;"></span>
    </div>
  `;

  const toggle = node.querySelector('[data-bs-toggle]');
  const solInput = node.querySelector('[data-bs-sol-value]');

  // Render the initial hint via the shared helper. Subsequent refreshes
  // also go through the helper so the rendering stays consistent.
  refreshBootstrapHint(poolIdx);

  // Toggle: flip between minimal and custom.
  //   custom default: 0.5 SOL of starting liquidity (matches simple-UI
  //   default). When flipping back to minimal, preserve solValue so
  //   re-toggling restores it without losing user input.
  // After flipping, the bs supplyPercent (derived) changes by the
  // full bs amount; rebalance wide slices accordingly so positions
  // total stays at 100%.
  toggle.addEventListener('change', (e) => {
    const oldPct = (pool.bootstrapConfig && pool.bootstrapConfig.mode === 'custom')
      ? Number(pool.bootstrapConfig.supplyPercent) || 0
      : 0;
    if (e.target.checked) {
      // Restore prior solValue if any; default to 0.5 SOL.
      const restoredSol = Number(pool.bootstrapConfig?.solValue) > 0
        ? Number(pool.bootstrapConfig.solValue) : 0.5;
      const newPct = computeBootstrapSupplyPercent(restoredSol, Number(pool.supplyPercent)) || 0;
      pool.bootstrapConfig = { mode: 'custom', solValue: restoredSol, supplyPercent: newPct };
    } else {
      // Preserve solValue on the object so re-toggle restores it. Wire
      // format ignores solValue/supplyPercent in minimal mode.
      pool.bootstrapConfig = {
        mode: 'minimal',
        solValue: Number(pool.bootstrapConfig?.solValue) || 0,
        supplyPercent: 0,
      };
    }
    const newPct = (pool.bootstrapConfig.mode === 'custom')
      ? Number(pool.bootstrapConfig.supplyPercent) || 0 : 0;
    rebalanceWideSlicesByDelta(pool, newPct - oldPct);
    renderPools();
  });

  // SOL input: canonical value. Compute new supplyPercent and rebalance
  // slices so positions total stays at 100%. We update only the hint
  // text and the positions-total indicator in place — full re-render
  // would lose focus on the input the user is typing in.
  solInput.addEventListener('input', (e) => {
    const v = Number(e.target.value);
    if (!Number.isFinite(v) || v < 0) return;
    const oldPct = Number(pool.bootstrapConfig?.supplyPercent) || 0;
    const newPct = computeBootstrapSupplyPercent(v, Number(pool.supplyPercent)) || 0;
    pool.bootstrapConfig = { mode: 'custom', solValue: v, supplyPercent: newPct };
    rebalanceWideSlicesByDelta(pool, newPct - oldPct);
    refreshBootstrapHint(poolIdx);
    refreshWideSliceInputs(poolIdx);
    updatePoolPositionsTotal(poolIdx);
  });

  return node;
}

// ---------------------------------------------------------------------------
// Custom Positions — Ladder strategy support
// ---------------------------------------------------------------------------

// Compact multiplier label for the ladder controls and chips. Mirrors the
// depth chart's formatter (k/M/B/T, scientific past a trillion) so the numbers
// read the same in the controls as on the axis.
function formatMultiplierLabel(m) {
  if (!Number.isFinite(m) || m <= 0) return '0';
  if (m >= 1e15) return m.toExponential(1).replace('e+', 'e');
  if (m >= 1e12) return `${+(m / 1e12).toFixed(1)}T`;
  if (m >= 1e9) return `${+(m / 1e9).toFixed(1)}B`;
  if (m >= 1e6) return `${+(m / 1e6).toFixed(1)}M`;
  if (m >= 1000) return `${+(m / 1000).toFixed(m < 10000 ? 1 : 0)}k`;
  return String(Math.round(m));
}

// The pool's maximum ladder ceiling, as a multiple of the launch price. We cap
// it at an honest $1B fully-diluted market cap rather than the tick range's
// true limit (which is absurd — a cheap launch has ~1e25× of tick headroom).
// Market cap scales linearly with price (supply is fixed), so the multiplier
// that reaches a $1B FDV is just CEILING_MAX_MCAP_USD ÷ launch market cap —
// needing only the market cap input, no quote price, decimals, or tick math.
// Rounded down to two significant figures for a clean cap. The backend still
// clamps any band to the real tick bound at execution, so this is purely the
// editor's ceiling.
//
// (The `pool` argument is unused — market cap is a token-level figure shared
// across pools — but kept for call-site symmetry with the other pool helpers.)
function poolMaxCeilingMultiplier(pool) {
  const mcap = parseNumberInput(document.getElementById('targetMarketCap'));
  if (!(mcap > 0)) return LADDER_CEILING_FALLBACK_MAX;
  const mult = CEILING_MAX_MCAP_USD / mcap;
  if (!(mult > 0) || !Number.isFinite(mult)) return LADDER_CEILING_FALLBACK_MAX;
  // Round down to two significant figures: clean to show, and never above $1B.
  const e = Math.floor(Math.log10(mult));
  const f = Math.pow(10, e - 1);
  return Math.max(1, Math.floor(mult / f) * f);
}

// Build the controls-help line under the ladder's Bands/Gap/Ceiling inputs.
// Shared by buildLadderNode's render and refreshLadderMcapDisplays so the
// wording lives in one place. The trailing sentence translates the current
// ceiling multiplier into the market cap it tops out at (mcap × ceiling, since
// mcap scales linearly with price) — making a bare "100,000×" legible in
// dollars and tying it to the $1B cap. Omitted until market cap is set.
function ladderControlsHelpHtml(pool, poolMax) {
  const cfg = (pool && pool.ladderConfig) || {};
  const base = `Gap is the air-pocket before the first band. Ceiling tops the ladder — default ${formatMultiplierLabel(LADDER_CEILING_DEFAULT)}×, up to a $1B market cap (${formatMultiplierLabel(poolMax)}×).`;
  const mcap = parseNumberInput(document.getElementById('targetMarketCap'));
  if (Number.isFinite(mcap) && mcap > 0 && Number(cfg.ceiling) > 0) {
    // Use the effective ceiling (clamped to the cap) for the dollar figure. In
    // steady state cfg.ceiling is already ≤ poolMax so this is a no-op; it only
    // bites while the user is typing mcap upward, before the blur-time re-clamp
    // — without it the readout would briefly show a market cap above $1B and
    // contradict the cap stated in the same sentence.
    const eff = Math.min(Number(cfg.ceiling), poolMax);
    return `${base} At ${formatMultiplierLabel(eff)}× the ladder tops out near ${formatUsdShort(mcap * eff)} market cap.`;
  }
  return base;
}

// Refresh the market-cap-derived bits of every visible ladder section in place:
// the ceiling dollar readout in the controls-help line and the ceiling input's
// max attribute (both derive from $1B ÷ mcap). Called live as the target market
// cap changes so the ladder stays honest without a full renderPools — which
// would reflow the whole pool list and could eat an in-flight click. This does
// NOT mutate band data or the stored ceiling; an over-cap ceiling is re-clamped
// on blur (see the targetMarketCap blur handler), not mid-keystroke.
function refreshLadderMcapDisplays() {
  for (let i = 0; i < pools.length; i++) {
    const pool = pools[i];
    const node = poolList.children[i];
    if (!node) continue;
    const help = node.querySelector('[data-ladder-controls-help]');
    const ceilingInput = node.querySelector('[data-ladder-ceiling]');
    if (!help && !ceilingInput) continue; // ladder off or pool collapsed
    const poolMax = poolMaxCeilingMultiplier(pool);
    if (ceilingInput) ceilingInput.max = String(Math.round(poolMax));
    if (help) help.innerHTML = ladderControlsHelpHtml(pool, poolMax);
  }
}

// Format a band multiplier for DISPLAY in the editable band-table inputs. The
// strategy generator stores precise values (e.g. 1.5613) so the band geometry
// and tick math stay exact; rendering all four decimals just makes the table
// noisy. We round only what's shown — the stored value is untouched and the
// input handlers write back only on a real user edit — so this cannot drift the
// bands or collapse a tight one. Faithful enough to edit against: two decimals
// under 10×, one decimal under 1000×, whole numbers above.
function formatBandMultiplierValue(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  if (n < 10) return String(+n.toFixed(2));
  if (n < 1000) return String(+n.toFixed(1));
  return String(Math.round(n));
}

// Strategy display metadata (name, scenario tag, and the descriptive note shown
// under the picker). The shapes themselves live in generateLadderStrategyBands.
const LADDER_STRATEGY_META = {
  dbl: { name: 'Doubling', tag: 'easy to pump', note: 'Discrete bands that double in width past the gap — thin near launch for fast early movement, with supply fanned out toward the ceiling.' },
  gapdbl: { name: 'Gapped Doubling', tag: 'stepwise', note: 'Doubling\u2019s widening bands, spaced out with an air-pocket before each — supply climbs in widening steps, leaving room between for capitulation and fresh floors.' },
  invramp: { name: 'Inverse Ramp', tag: 'locks supply high', note: 'Overlapping bands all reaching the ceiling — depth builds upward, parking the most supply high where it cannot be dumped near launch. The strongest supply-control shape.' },
  pyr: { name: 'Pyramid', tag: 'mid concentration', note: 'Overlapping bands peak in the middle of the range — supply concentrated at mid multiples, lighter at both ends.' },
  multi: { name: 'Multi-Peak', tag: 'several peaks', note: 'Several humps spread across the range — supply distributed over multiple resistance shelves rather than piled at one point, with the lowest band at the gap and the highest reaching the ceiling.' },
};

// Backfill the strategy-config fields on a pool's ladderConfig. Pools created
// before the strategy picker existed (e.g. by the simple-config sliders, which
// use generateLogSpacedBands and lay their first band at 1×) carry only
// { mode, bands }. We set sensible defaults — notably the gap and ceiling come
// from the design defaults, NOT inferred from the seeded bands, so the gap
// lands on its intended 4× rather than the 1× those bands happen to start at.
// Band count and ladder share ARE carried over from the existing bands (the
// share has to be, or the positions total would shift). Idempotent.
function ensureLadderStrategyConfig(pool) {
  if (!pool.ladderConfig) pool.ladderConfig = { mode: 'off', bands: [] };
  const cfg = pool.ladderConfig;
  const bands = Array.isArray(cfg.bands) ? cfg.bands : [];

  // True only the first time the strategy system touches this pool.
  const wasUninitialized = !LADDER_STRATEGY_IDS.includes(cfg.strategy);
  if (wasUninitialized) cfg.strategy = LADDER_DEFAULT_STRATEGY;

  if (cfg.bandCount == null) {
    cfg.bandCount = bands.length >= LADDER_MIN_BANDS ? bands.length : LADDER_DEFAULT_BANDS;
  }
  cfg.bandCount = Math.min(LADDER_MAX_BANDS, Math.max(LADDER_MIN_BANDS, Math.round(cfg.bandCount)));

  // Gap and ceiling default to the design defaults rather than being read back
  // from the seeded bands (which start at 1×, which would otherwise pin the gap
  // at 1× instead of 4×).
  if (cfg.gap == null) cfg.gap = LADDER_GAP_DEFAULT;
  cfg.gap = Math.min(LADDER_GAP_MAX, Math.max(LADDER_GAP_MIN, cfg.gap));

  if (cfg.ceiling == null) {
    const maxHi = bands.length ? Math.max(...bands.map((b) => Number(b.upperMultiplier) || 0)) : 0;
    cfg.ceiling = maxHi > 0 ? maxHi : LADDER_CEILING_DEFAULT;
  }

  // Ladder share MUST be carried over from the existing bands — defaulting it
  // would shift the pool's positions total off 100%.
  if (cfg.ladderPercent == null) {
    const sum = bands.reduce((s, b) => s + (Number(b.supplyPercent) || 0), 0);
    cfg.ladderPercent = sum > 0 ? sum : LADDER_DEFAULT_PERCENT;
  }

  // Never let the ceiling exceed the pool's honest max ($1B market cap). This
  // clamps both the default (100,000×, which is above the cap for launches over
  // ~$10k FDV) and any inferred value, so the control, the cap, and the
  // generated bands all stay consistent.
  const capMax = poolMaxCeilingMultiplier(pool);
  if (Number(cfg.ceiling) > capMax) cfg.ceiling = capMax;

  // First time the strategy system takes over a pool whose bands were seeded
  // elsewhere (the simple-config ladder, laid from 1×): regenerate them from
  // the strategy defaults so the displayed ladder matches the controls — the
  // gap moves to 4×, etc. The ladder share is unchanged, so the positions total
  // stays put and no wide-slice rebalance is needed.
  if (wasUninitialized && bands.length > 0) {
    cfg.bands = generateLadderStrategyBands({
      strategy: cfg.strategy,
      ladderPercent: cfg.ladderPercent,
      bandCount: cfg.bandCount,
      gap: cfg.gap,
      ceiling: cfg.ceiling,
    });
  }

  return cfg;
}

// Regenerate the ladder bands from the pool's current strategy config, keeping
// the pool's positions total at 100% by absorbing the band-total delta into
// the wide slices (same rebalance the toggle/add/remove paths use). Caller is
// responsible for re-rendering (renderPools) afterwards.
function regenerateLadderBands(pool) {
  const cfg = ensureLadderStrategyConfig(pool);
  const oldTotal = (cfg.mode === 'manual' && Array.isArray(cfg.bands))
    ? cfg.bands.reduce((s, b) => s + (Number(b.supplyPercent) || 0), 0)
    : 0;
  cfg.mode = 'manual';
  cfg.bands = generateLadderStrategyBands({
    strategy: cfg.strategy,
    ladderPercent: cfg.ladderPercent,
    bandCount: cfg.bandCount,
    gap: cfg.gap,
    ceiling: cfg.ceiling,
  });
  const newTotal = cfg.bands.reduce((s, b) => s + (Number(b.supplyPercent) || 0), 0);
  rebalanceWideSlicesByDelta(pool, newTotal - oldTotal);
}

// Tiny stacked depth thumbnail for a strategy chip. Same liquidity math and
// palette as the per-pool depth chart (so a chip previews the shape the chart
// will draw): a tan wide-band baseline plus the ladder bands, each band an
// equal share of the ladder supply, stacked where they overlap.
function renderLadderThumbSvg(bands, ceiling) {
  const PALETTE = ['#9a2424', '#2f6f5e', '#c0871f', '#3f5a8a', '#8a3f6a', '#5f6a2a', '#7a4a2a'];
  const WIDE = '#d8c39a';
  const NOTIONAL = 250000;
  const Lt = (v, lo, hi) => { const d = 1 / Math.sqrt(lo) - 1 / Math.sqrt(hi); return d > 0 ? v / d : 0; };

  const bs = Array.isArray(bands) ? bands : [];
  const sumW = bs.reduce((s, b) => s + (Number(b.supplyPercent) || 0), 0);
  const wideW = Math.max(0, 100 - sumW);
  const C = Math.max(Number(ceiling) || 10, ...bs.map((b) => Number(b.upperMultiplier) || 1), 10);

  const comps = [];
  if (wideW > 0) comps.push({ c: WIDE, lo: 1, hi: C, L: Lt((wideW / 100) * NOTIONAL, 1, C) });
  bs.forEach((b, i) => {
    const lo = Math.max(1, Number(b.lowerMultiplier) || 1);
    const hi = Math.max(lo * 1.0001, Number(b.upperMultiplier) || 1);
    comps.push({ c: PALETTE[i % PALETTE.length], lo, hi, L: Lt(((Number(b.supplyPercent) || 0) / 100) * NOTIONAL, lo, hi) });
  });

  const edges = new Set([1, C]);
  comps.forEach((c) => { edges.add(c.lo); edges.add(c.hi); });
  const xs = Array.from(edges).filter((x) => x >= 1 && x <= C * 1.0001).sort((a, b) => a - b);

  const W = 120; const H = 34; const plotH = H - 4; const yB = H - 2;
  const lmin = Math.log(1); const lspan = (Math.log(C) - lmin) || 1;
  const X = (x) => ((Math.log(x) - lmin) / lspan) * W;

  let maxL = 0; const segs = [];
  for (let i = 0; i < xs.length - 1; i++) {
    const lo = xs[i]; const hi = xs[i + 1];
    if (hi <= lo) continue;
    let tot = 0; const parts = [];
    comps.forEach((c) => { if (c.lo <= lo + 1e-9 && c.hi >= hi - 1e-9) { parts.push(c); tot += c.L; } });
    segs.push({ lo, hi, parts });
    if (tot > maxL) maxL = tot;
  }
  maxL = maxL || 1;

  let f = '';
  for (const sgmt of segs) {
    const xa = X(sgmt.lo); const w = X(sgmt.hi) - xa;
    if (w <= 0) continue;
    let cum = 0;
    for (const p of sgmt.parts) {
      const h = (p.L / maxL) * plotH;
      if (h <= 0) continue;
      f += `<rect x="${xa.toFixed(1)}" y="${(yB - cum - h).toFixed(1)}" width="${Math.max(0.6, w).toFixed(1)}" height="${h.toFixed(1)}" fill="${p.c}" fill-opacity="0.9"/>`;
      cum += h;
    }
  }
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="display:block;" aria-hidden="true">${f}</svg>`;
}

function buildLadderNode(pool, poolIdx) {
  // Custom Positions — Ladder. A "volatility strategy" picker generates the
  // ladder bands: pick a shape, set how many bands, the gap before the first
  // band, and the ceiling, and the bands are laid out for you. The bands stay
  // fully editable in the collapsed "Ladder positions" table — but those manual
  // edits are ephemeral: changing the strategy, band count, gap, or ceiling
  // regenerates the bands and discards them.
  //
  // The ladder's job is supply control: it relocates a slice of the pool's
  // supply to higher price ranges so it can't be dumped near launch. The depth
  // chart at the top of the pool is the source of truth for the shape.
  const node = document.createElement('div');
  node.className = 'pool-ladder-section box has-background-light p-3 mt-3 mb-0';

  const cfg = ensureLadderStrategyConfig(pool);
  const enabled = cfg.mode === 'manual';
  const poolMax = poolMaxCeilingMultiplier(pool);
  const tableOpen = !!cfg._uiTableOpen;

  node.innerHTML = `
    <label class="label is-small mb-1">
      <input type="checkbox" data-ladder-toggle ${enabled ? 'checked' : ''}>
      Ladder positions
    </label>
    <p class="is-size-7 has-text-grey mb-2">
      Single-sided positions above launch that relocate a slice of this pool's
      supply to higher price ranges — resistance going up, and supply that can't
      be dumped near launch. Pick a strategy to lay out the bands; they stay
      fully editable. Bands can overlap or leave gaps — both are valid.
    </p>
    <div class="ladder-bands-container" ${enabled ? '' : 'style="display:none;"'}>

      <div class="ladder-strategy-controls" style="display:flex;flex-wrap:wrap;gap:0.5rem 1.25rem;align-items:flex-end;margin-bottom:0.35rem;">
        <div class="field mb-0">
          <label class="label is-small mb-1">Bands</label>
          <div class="field has-addons mb-0">
            <div class="control"><button type="button" class="button is-small" data-ladder-band-dec>&minus;</button></div>
            <div class="control"><span class="button is-small is-static" data-ladder-band-count style="min-width:2.4rem;">${cfg.bandCount}</span></div>
            <div class="control"><button type="button" class="button is-small" data-ladder-band-inc>+</button></div>
          </div>
        </div>
        <div class="field mb-0">
          <label class="label is-small mb-1">Gap</label>
          <div class="field has-addons mb-0">
            <div class="control"><input class="input is-small" type="number" min="${LADDER_GAP_MIN}" max="${LADDER_GAP_MAX}" step="0.5" data-ladder-gap value="${cfg.gap}" style="width:4.5rem;"></div>
            <div class="control"><a class="button is-small is-static">× from launch</a></div>
          </div>
        </div>
        <div class="field mb-0">
          <label class="label is-small mb-1">Ceiling</label>
          <div class="field has-addons mb-0">
            <div class="control"><input class="input is-small" type="number" min="10" max="${Math.round(poolMax)}" step="1000" data-ladder-ceiling value="${cfg.ceiling}" style="width:8rem;"></div>
            <div class="control"><a class="button is-small is-static">× launch</a></div>
            <div class="control"><button type="button" class="button is-small is-light" data-ladder-ceiling-max title="Set to the max ($1B market cap)">max</button></div>
          </div>
        </div>
      </div>
      <p class="help has-text-grey mb-2" data-ladder-controls-help></p>

      <div class="ladder-strategy-chips" data-ladder-chips
           style="display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:0.4rem;margin-bottom:0.4rem;"></div>
      <p class="is-size-7 has-text-grey mb-2" data-ladder-strategy-note></p>

      <div class="ladder-positions-disclosure" data-ladder-disclosure role="button" tabindex="0"
           style="display:flex;align-items:center;gap:0.4rem;cursor:pointer;padding:0.45rem 0;border-top:1px solid rgba(0,0,0,0.08);">
        <span class="icon is-small"><i class="fas fa-chevron-${tableOpen ? 'down' : 'right'}" data-ladder-chevron></i></span>
        <span class="has-text-weight-semibold is-size-7">Ladder positions</span>
        <span class="is-size-7 has-text-grey" data-ladder-summary></span>
        <span class="is-size-7 has-text-grey" style="margin-left:auto;">tap to customize</span>
      </div>

      <div class="ladder-bands-detail" data-ladder-detail ${tableOpen ? '' : 'style="display:none;"'}>
        <div class="ladder-bands-list" data-ladder-bands></div>
        <div class="ladder-bands-actions" style="margin-top:0.5rem;">
          <button type="button" class="button is-small is-light" data-ladder-add>
            <span class="icon"><i class="fas fa-plus"></i></span><span>Add band</span>
          </button>
        </div>
        <p class="help has-text-grey mt-1">
          Manual edits here are temporary — changing the strategy, band count,
          gap, or ceiling above regenerates the bands and discards them.
        </p>
        <p class="help is-danger mt-1 hidden" data-ladder-warning></p>
      </div>

    </div>
  `;

  const toggle = node.querySelector('[data-ladder-toggle]');
  const chips = node.querySelector('[data-ladder-chips]');
  const noteEl = node.querySelector('[data-ladder-strategy-note]');
  const summaryEl = node.querySelector('[data-ladder-summary]');
  const controlsHelp = node.querySelector('[data-ladder-controls-help]');
  const bandsList = node.querySelector('[data-ladder-bands]');
  const addBtn = node.querySelector('[data-ladder-add]');
  const warning = node.querySelector('[data-ladder-warning]');
  const disclosure = node.querySelector('[data-ladder-disclosure]');
  const detail = node.querySelector('[data-ladder-detail]');
  const chevron = node.querySelector('[data-ladder-chevron]');

  // Render the current band rows (unchanged behaviour — editing a band updates
  // state in place; those edits persist until the next strategy regeneration).
  function renderBands() {
    bandsList.innerHTML = '';
    const bands = Array.isArray(pool.ladderConfig?.bands) ? pool.ladderConfig.bands : [];
    bands.forEach((band, bandIdx) => {
      bandsList.appendChild(buildBandRow(pool, poolIdx, band, bandIdx, renderBands, updateWarning));
    });
    updateWarning();
  }

  // Validate the band list and surface a warning when the total supplyPercent
  // exceeds 100% or any band has bad geometry. Backend pre-flight catches the
  // same conditions, but inline feedback during editing is friendlier.
  function updateWarning() {
    const bands = Array.isArray(pool.ladderConfig?.bands) ? pool.ladderConfig.bands : [];
    let msg = '';
    const totalPct = bands.reduce((s, b) => s + (Number(b.supplyPercent) || 0), 0);
    if (totalPct > 100) {
      msg = `Band supply totals ${totalPct.toFixed(2)}% — must be ≤ 100%.`;
    } else {
      for (let i = 0; i < bands.length; i++) {
        const b = bands[i];
        const lo = Number(b.lowerMultiplier);
        const hi = Number(b.upperMultiplier);
        if (!(lo >= 1)) { msg = `Band ${i + 1}: lower multiplier must be ≥ 1× launch price.`; break; }
        if (!(hi > lo)) { msg = `Band ${i + 1}: upper multiplier must be greater than lower.`; break; }
        if (!(b.supplyPercent > 0)) { msg = `Band ${i + 1}: supply % must be greater than 0.`; break; }
      }
    }
    if (msg) { warning.textContent = msg; warning.classList.remove('hidden'); }
    else { warning.classList.add('hidden'); }
  }

  // Render the five strategy chips, each previewing its shape with the current
  // band count / gap / ceiling. Clicking one switches the strategy and
  // regenerates the bands.
  function renderChips() {
    const lc = pool.ladderConfig;
    chips.innerHTML = '';
    LADDER_STRATEGY_IDS.forEach((id) => {
      const meta = LADDER_STRATEGY_META[id];
      const bands = generateLadderStrategyBands({ strategy: id, ladderPercent: lc.ladderPercent, bandCount: lc.bandCount, gap: lc.gap, ceiling: lc.ceiling });
      const selected = lc.strategy === id;
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'button ladder-strategy-chip';
      btn.dataset.strategy = id;
      btn.style.cssText = 'height:auto;display:block;text-align:left;padding:0.4rem 0.45rem;white-space:normal;'
        + (selected ? 'border-color:#9a2424;box-shadow:inset 0 0 0 1px #9a2424;' : '');
      btn.innerHTML = renderLadderThumbSvg(bands, lc.ceiling)
        + `<div class="is-size-7 has-text-weight-semibold" style="line-height:1.1;margin-top:0.2rem;">${meta.name}</div>`
        + `<div class="has-text-grey" style="font-size:0.65rem;line-height:1.1;">${meta.tag}</div>`;
      btn.addEventListener('click', () => {
        pool.ladderConfig.strategy = id;
        regenerateLadderBands(pool);
        renderPools();
      });
      chips.appendChild(btn);
    });
  }

  // Refresh the selected-strategy note, the disclosure summary, and the
  // controls help line from current config.
  function updateMeta() {
    const lc = pool.ladderConfig;
    const meta = LADDER_STRATEGY_META[lc.strategy] || LADDER_STRATEGY_META[LADDER_DEFAULT_STRATEGY];
    noteEl.innerHTML = `<strong>${meta.name}</strong> — ${meta.note}`;
    summaryEl.textContent = `${lc.bandCount} bands · ${meta.name} · gap ${lc.gap}× · to ${formatMultiplierLabel(lc.ceiling)}×`;
    controlsHelp.innerHTML = ladderControlsHelpHtml(pool, poolMax);
  }

  // Toggle ladder on/off. Same wide-slice rebalance as before so positions
  // total stays at 100%. Turning on with no existing bands seeds them from the
  // current strategy; existing bands are preserved across an off/on cycle.
  toggle.addEventListener('change', (e) => {
    const lc = ensureLadderStrategyConfig(pool);
    const oldTotal = (lc.mode === 'manual' && Array.isArray(lc.bands))
      ? lc.bands.reduce((s, b) => s + (Number(b.supplyPercent) || 0), 0)
      : 0;
    if (e.target.checked) {
      lc.mode = 'manual';
      if (!Array.isArray(lc.bands) || lc.bands.length === 0) {
        lc.bands = generateLadderStrategyBands({ strategy: lc.strategy, ladderPercent: lc.ladderPercent, bandCount: lc.bandCount, gap: lc.gap, ceiling: lc.ceiling });
      }
    } else {
      lc.mode = 'off'; // keep bands on the object for restoration on re-toggle
    }
    const newTotal = (lc.mode === 'manual' && Array.isArray(lc.bands))
      ? lc.bands.reduce((s, b) => s + (Number(b.supplyPercent) || 0), 0)
      : 0;
    rebalanceWideSlicesByDelta(pool, newTotal - oldTotal);
    renderPools();
  });

  // Band-count stepper.
  node.querySelector('[data-ladder-band-dec]').addEventListener('click', () => {
    const lc = pool.ladderConfig;
    if (lc.bandCount > LADDER_MIN_BANDS) { lc.bandCount -= 1; regenerateLadderBands(pool); renderPools(); }
  });
  node.querySelector('[data-ladder-band-inc]').addEventListener('click', () => {
    const lc = pool.ladderConfig;
    if (lc.bandCount < LADDER_MAX_BANDS) { lc.bandCount += 1; regenerateLadderBands(pool); renderPools(); }
  });

  // Gap and ceiling commit on change (blur/enter), not every keystroke, so
  // typing isn't interrupted by the regenerate-and-rerender.
  node.querySelector('[data-ladder-gap]').addEventListener('change', (e) => {
    let v = Number(e.target.value);
    if (!Number.isFinite(v)) v = LADDER_GAP_DEFAULT;
    v = Math.min(LADDER_GAP_MAX, Math.max(LADDER_GAP_MIN, v));
    pool.ladderConfig.gap = v;
    regenerateLadderBands(pool);
    renderPools();
  });
  node.querySelector('[data-ladder-ceiling]').addEventListener('change', (e) => {
    let v = Number(e.target.value);
    if (!Number.isFinite(v)) v = LADDER_CEILING_DEFAULT;
    const floor = Math.max(10, pool.ladderConfig.gap * 1.5);
    v = Math.min(poolMax, Math.max(floor, v));
    pool.ladderConfig.ceiling = v;
    regenerateLadderBands(pool);
    renderPools();
  });
  node.querySelector('[data-ladder-ceiling-max]').addEventListener('click', () => {
    pool.ladderConfig.ceiling = poolMax;
    regenerateLadderBands(pool);
    renderPools();
  });

  // Collapsed band table disclosure — toggled in place so we don't lose scroll
  // position; the open/closed state lives on the config so it survives the
  // full re-renders that control changes trigger.
  function setTableOpen(open) {
    pool.ladderConfig._uiTableOpen = open;
    detail.style.display = open ? '' : 'none';
    if (chevron) {
      chevron.classList.toggle('fa-chevron-down', open);
      chevron.classList.toggle('fa-chevron-right', !open);
    }
  }
  disclosure.addEventListener('click', () => setTableOpen(!pool.ladderConfig._uiTableOpen));
  disclosure.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setTableOpen(!pool.ladderConfig._uiTableOpen); }
  });

  // Add a manual band. Diverges the table from the strategy's band count until
  // the next regeneration — that's the intended ephemeral-edit behaviour. Opens
  // the table so the user sees the row they just added.
  addBtn.addEventListener('click', () => {
    const lc = ensureLadderStrategyConfig(pool);
    if (!Array.isArray(lc.bands)) lc.bands = [];
    lc.mode = 'manual';
    const newBand = { supplyPercent: 5, lowerMultiplier: 1.5, upperMultiplier: 2.0 };
    lc.bands.push(newBand);
    lc._uiTableOpen = true;
    rebalanceWideSlicesByDelta(pool, newBand.supplyPercent);
    renderPools();
  });

  // Initial paint.
  renderChips();
  updateMeta();
  renderBands();

  return node;
}

// Build a single band-row editor. Each band has three numeric inputs
// (supplyPercent of pool, lowerMultiplier, upperMultiplier) plus a
// remove button. The mcap hint below shows the dollar-value range
// based on the current target market cap input.
//
// Uses the same slice-row CSS class as wide slices and the bootstrap
// row so all positions in the pool look visually consistent.
function buildBandRow(pool, poolIdx, band, bandIdx, rerenderBands, updateWarning) {
  const row = document.createElement('div');
  row.className = 'slice-row band-row';

  row.innerHTML = `
    <span class="slice-label">Band ${bandIdx + 1}</span>
    <input class="input is-small slice-share" type="number" min="0" max="100" step="0.01"
           data-field="supplyPercent" value="${Number(band.supplyPercent)}">
    <span style="line-height:30px;">% of pool</span>
    <span class="is-size-7 has-text-grey position-total-hint" data-position-total-hint="band">${escapeHtml(formatPositionSupplyHint(pool, band.supplyPercent))}</span>
    <span class="is-size-7 has-text-grey" style="line-height:30px;">Range:</span>
    <input class="input is-small" type="number" min="1" step="0.01"
           data-field="lowerMultiplier" value="${formatBandMultiplierValue(band.lowerMultiplier)}" style="width: 5rem;">
    <span class="is-size-7" style="line-height:30px;">× to</span>
    <input class="input is-small" type="number" min="1" step="0.01"
           data-field="upperMultiplier" value="${formatBandMultiplierValue(band.upperMultiplier)}" style="width: 5rem;">
    <span class="is-size-7" style="line-height:30px;">× launch</span>
    <span class="is-size-7 has-text-grey-dark" data-mcap-hint style="line-height:30px;margin-left:0.4rem;flex:1;"></span>
    <button class="button is-danger is-small is-light" data-action="remove-band" title="Remove band">
      <span class="icon is-small"><i class="fas fa-times"></i></span>
    </button>
  `;

  const hint = row.querySelector('[data-mcap-hint]');

  // Refresh the mcap hint based on current targetMarketCap input. Called
  // on initial render and whenever the lower/upper multipliers change.
  function updateMcapHint() {
    const targetMc = parseNumberInput(document.getElementById('targetMarketCap'));
    const lo = Number(band.lowerMultiplier);
    const hi = Number(band.upperMultiplier);
    if (Number.isFinite(targetMc) && targetMc > 0 && lo > 0 && hi > 0) {
      hint.textContent = `≈ $${formatUsdRoughly(lo * targetMc)} – $${formatUsdRoughly(hi * targetMc)} mcap`;
    } else {
      hint.textContent = '';
    }
  }

  // Wire the three numeric inputs. Each updates the band object in
  // place and re-runs the cross-band validation that lights up the
  // warning paragraph below the row list. Also re-runs the pool-level
  // positions-total recompute, since changing a band's % of pool
  // changes what's left for the wide bucket.
  row.querySelector('[data-field="supplyPercent"]').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    if (Number.isFinite(v) && v >= 0) {
      band.supplyPercent = v;
      updateWarning();
      updatePoolPositionsTotal(poolIdx);
    }
  });
  row.querySelector('[data-field="lowerMultiplier"]').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    if (Number.isFinite(v) && v >= 1) {
      band.lowerMultiplier = v;
      updateMcapHint();
      updateWarning();
      updatePoolDepthChart(poolIdx);
    }
  });
  row.querySelector('[data-field="upperMultiplier"]').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    if (Number.isFinite(v) && v >= 1) {
      band.upperMultiplier = v;
      updateMcapHint();
      updateWarning();
      updatePoolDepthChart(poolIdx);
    }
  });

  row.querySelector('[data-action="remove-band"]').addEventListener('click', () => {
    // Removing a band frees up its share back to the wide bucket so
    // positions total stays at 100%. Same pattern as remove-slice and
    // the bs/ladder toggles.
    const removedShare = Number(pool.ladderConfig.bands[bandIdx].supplyPercent) || 0;
    pool.ladderConfig.bands.splice(bandIdx, 1);
    rebalanceWideSlicesByDelta(pool, -removedShare);
    renderPools();
  });

  // Initial mcap hint.
  updateMcapHint();

  return row;
}

// Format a USD number for compact display: $1.2k, $35k, $1.2M, etc.
// Used by the ladder + bootstrap dollar hints next to multiplier-based
// inputs, so user can see the absolute mcap each input maps to.
function formatUsdRoughly(value) {
  if (!Number.isFinite(value) || value <= 0) return '0';
  if (value < 1000) return value.toFixed(0);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10000 ? 1 : 0)}k`;
  if (value < 1_000_000_000) return `${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)}M`;
  return `${(value / 1_000_000_000).toFixed(1)}B`;
}

// USD formatter for the funding-step auto-swap rows. Returns a $-prefixed
// short form that handles the wide value range we see there:
//   $0.0001 / $0.05 / $1.23 / $42 / $1.2k / $5M
// Differs from formatUsdRoughly above (which omits the $ and treats
// sub-dollar as "0") because the auto-swap context routinely shows
// fractional-dollar values (memecoin acquire targets are often a few
// cents). Returns '<$0.01' rather than "$0" for the truly tiny case so
// the user knows the figure is meaningful but small.
function formatUsdShort(value) {
  if (!Number.isFinite(value) || value <= 0) return '$0';
  if (value < 0.01) return '<$0.01';
  if (value < 1) return `$${value.toFixed(2)}`;
  if (value < 1000) return `$${value.toFixed(value < 10 ? 2 : 0)}`;
  if (value < 1_000_000) return `$${(value / 1000).toFixed(value < 10000 ? 1 : 0)}k`;
  if (value < 1_000_000_000) return `$${(value / 1_000_000).toFixed(value < 10_000_000 ? 1 : 0)}M`;
  return `$${(value / 1_000_000_000).toFixed(1)}B`;
}

function buildSliceNode(pool, poolIdx, slice, sliceIdx) {
  const node = document.createElement('div');
  node.className = 'slice-row';
  // Hide the remove button when this is the only slice — removeSlice
  // short-circuits in that case anyway, and a non-functional X button
  // is more confusing than just not showing it.
  const isOnlySlice = pool.distribution.length === 1;
  // Label is "Slice N/M" only when there's more than one; for a single
  // slice the "Main LP position" header above already provides context
  // and "Slice 1/1" reads oddly.
  const labelText = isOnlySlice ? 'Slice' : `Slice ${sliceIdx + 1}/${pool.distribution.length}`;
  node.innerHTML = `
    <span class="slice-label">${labelText}</span>
    <input class="input is-small slice-share" type="number" min="0" max="100" step="0.01" value="${slice.sharePercent}">
    <span style="line-height:30px;">% of pool</span>
    <span class="is-size-7 has-text-grey position-total-hint" data-position-total-hint="slice">${escapeHtml(formatPositionSupplyHint(pool, slice.sharePercent))}</span>
    <label class="checkbox is-small" style="line-height:30px;">
      <input type="checkbox" data-field="useExternal" ${slice.useExternalRecipient ? 'checked' : ''}>
      &nbsp;Send to a different wallet
    </label>
    <input class="input is-small ${slice.useExternalRecipient ? '' : 'hidden'}" type="text" data-field="recipient" placeholder="Recipient address" value="${slice.recipient || ''}" style="flex: 1; min-width: 200px;">
    ${isOnlySlice ? '' : `<button class="button is-danger is-small is-light" data-action="remove-slice"><span class="icon is-small"><i class="fas fa-times"></i></span></button>`}
  `;

  const shareInput = node.querySelector('.slice-share');
  shareInput.addEventListener('input', (e) => {
    slice.sharePercent = Number(e.target.value);
    // Targeted update only — we used to call renderPools() here, which
    // destroyed and recreated *every* input element in *every* pool on
    // every keystroke. The browser would lose focus on the input you were
    // typing in, the cursor would reset, and typing felt broken.
    //
    // Under unified semantics, slice sharePercent is "% of pool" and
    // the constraint is at the pool level (bs + slices + bands = 100%).
    // updatePoolPositionsTotal refreshes the pool-level indicator, the
    // title affordance, and the continue button state in one shot.
    updatePoolPositionsTotal(poolIdx);
  });

  const useExt = node.querySelector('[data-field="useExternal"]');
  const recipientInput = node.querySelector('[data-field="recipient"]');

  useExt.addEventListener('change', (e) => {
    slice.useExternalRecipient = e.target.checked;
    if (e.target.checked) {
      recipientInput.classList.remove('hidden');
    } else {
      recipientInput.classList.add('hidden');
      slice.recipient = null;
      recipientInput.value = '';
    }
    updateContinueToFundingState();
  });
  recipientInput.addEventListener('change', (e) => {
    slice.recipient = e.target.value.trim() || null;
    updateContinueToFundingState();
  });

  // Remove button only rendered when there's more than one slice;
  // guard the lookup so single-slice rows don't throw.
  const removeBtn = node.querySelector('[data-action="remove-slice"]');
  if (removeBtn) {
    removeBtn.addEventListener('click', () => {
      removeSlice(poolIdx, sliceIdx);
    });
  }

  return node;
}

// Apply a resolved-info payload to a pool object. Used by both the
// fresh-fetch path and the cache-hit path so behavior is consistent.
// Mutates the pool in place; doesn't trigger any rendering.
function applyResolvedInfoToPool(pool, info) {
  if (!info) return;
  // For each field, prefer the new value when it's non-null, else
  // keep whatever's already on the pool. This protects against two
  // failure modes:
  //   1. Persisted metadata hydration (priceUsd: null in the cached
  //      entry) overwriting a fresh price that was already fetched
  //      since the page loaded.
  //   2. A partial server response (e.g. price oracle briefly down,
  //      priceUsd comes back null) clobbering a value we had.
  // For metadata fields the new value is usually the same as the
  // stored one anyway; the guard only matters for the volatile price.
  const setIfPresent = (field, value) => {
    if (value !== null && value !== undefined) pool[field] = value;
  };
  setIfPresent('resolvedSymbol', info.symbol);
  setIfPresent('resolvedDecimals', info.decimals);
  setIfPresent('resolvedPriceUsd', info.priceUsd);
  // Save the resolved on-chain mint too. Used as a display/link fallback
  // (e.g. when building Solscan or Birdeye URLs in the pool header) —
  // see the `pool.resolvedMint || pool.quoteToken` pattern elsewhere.
  setIfPresent('resolvedMint', info.address);
  // Display-only fields. Either may be null if no indexer had the
  // token; the UI handles that by hiding the logo and falling back
  // on the symbol where the name would have appeared.
  setIfPresent('resolvedName', info.name);
  setIfPresent('resolvedImageUrl', info.imageUrl);
  // Raydium CLMM compatibility info. Server-side we check whether the
  // quote token's mint program + Token-2022 extensions are allowed by
  // Raydium's on-chain `is_supported_mint` rules. The values here:
  //   compatible === true    → safe to use (either classic SPL, or
  //                            Token-2022 with allowlisted extensions,
  //                            or Token-2022 in Raydium's hardcoded
  //                            mint whitelist like PYUSD/AUSD)
  //   compatible === false   → pool creation WILL fail; we warn loudly
  //                            and disable the Continue button
  //   compatible === null    → couldn't check (mint missing on chain,
  //                            RPC down). Treat as unknown — surface
  //                            a note, don't block.
  setIfPresent('resolvedCompatible', info.compatible);
  // Boolean: a non-null incoming value wins, null/undef leaves prior.
  if (info.isToken2022 !== null && info.isToken2022 !== undefined) {
    pool.resolvedIsToken2022 = !!info.isToken2022;
  }
  // Arrays: empty array is a real value (means "no disallowed names")
  // so we update unconditionally when the response carries one.
  if (Array.isArray(info.disallowedNames)) {
    pool.resolvedDisallowedNames = info.disallowedNames;
  }
  setIfPresent('resolvedCompatError', info.compatError);

  // Step 2 Raydium-route probe results from /api/quote-token-info.
  // All three of these can legitimately be null in a fresh response
  // (server couldn't run the probe), so we use direct assignment for
  // the verdict — we WANT to clear stale values when a re-fetch finds
  // the probe couldn't run this time.
  if (info.raydiumTradeable !== undefined) {
    pool.resolvedRaydiumTradeable = info.raydiumTradeable;
  }
  // raydiumProbeError is transient — always overwrite so a successful
  // retry clears the prior error rather than leaving a phantom one.
  pool.resolvedRaydiumProbeError = info.raydiumProbeError ?? null;

  // Authority audit. Boolean true/false/null all carry meaning so we
  // pass them through directly. null = "couldn't verify" and is
  // distinct from false ("verified safe").
  if (info.freezeAuthorityBlock !== undefined) {
    pool.resolvedFreezeAuthorityBlock = info.freezeAuthorityBlock;
  }
  if (info.mintAuthorityWarning !== undefined) {
    pool.resolvedMintAuthorityWarning = info.mintAuthorityWarning;
  }

  // Price source label, so the UI can render "from Raydium" vs
  // "from external indexer" alongside the price.
  if (info.priceSource !== undefined) {
    pool.resolvedPriceSource = info.priceSource;
  }

  // Mark resolution as succeeded so the retry hint goes away.
  pool.resolvedFailed = false;
  pool.resolvedFailedError = null;
}

// Fetch quote-token info from the server, with two layers of protection
// against redundant calls:
//   1. Hard cache (quoteInfoCache) — once we've successfully fetched a
//      mint's metadata, subsequent calls within the price TTL return
//      from cache. After the price TTL, we re-fetch (and re-cache);
//      metadata never expires so it stays correct across re-fetches.
//   2. In-flight dedup (quoteInfoInFlight) — if multiple callers ask
//      for the same mint while a fetch is already pending, they all
//      await the same Promise rather than firing parallel requests.
//
// Returns the info payload (same shape the server returns), or throws
// on hard failure. Caller decides what to do on failure.
async function fetchQuoteInfoCached(quoteToken) {
  // Cache hit with fresh price → return immediately.
  const cached = quoteInfoCache.get(quoteToken);
  if (cached && (Date.now() - cached.fetchedAt) < QUOTE_PRICE_TTL_MS) {
    return cached.info;
  }
  // Another caller is already fetching this mint → await their promise.
  if (quoteInfoInFlight.has(quoteToken)) {
    return quoteInfoInFlight.get(quoteToken);
  }
  // Fresh fetch. Wrap in a promise we store so concurrent callers wait
  // on it. Clear the in-flight entry in finally{} so a failed fetch
  // doesn't poison subsequent attempts (the user can retry).
  const promise = (async () => {
    try {
      const resp = await fetch('/api/quote-token-info', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ quoteToken }),
      });
      const data = await resp.json();
      if (!data.success) {
        throw new Error(data.error || 'quote-token-info failed');
      }
      // Cache the new payload. When we had a prior cached entry
      // (stale-price refresh case), merge so the fresh response augments
      // the prior data rather than wholesale replacing it. Specifically:
      //
      // - Fields the server returned with a real (non-null) value
      //   overwrite the prior value (fresh data wins).
      // - Fields the server returned as null/undefined fall back to the
      //   prior value (we trust our cached "I know this" over a fresh
      //   "I don't know right now").
      //
      // This matters most for priceUsd. If the price oracle is briefly
      // down on a refresh, we want to keep showing the user the last
      // known price — not switch to null and break the UI. Metadata
      // fields (symbol/decimals/name/etc.) are almost always present
      // on a successful response, but the same fallback protects us
      // against any future server-side path that might return them as
      // null transiently.
      let merged;
      if (cached) {
        merged = { ...cached.info };
        for (const [k, v] of Object.entries(data.info)) {
          if (v !== null && v !== undefined) {
            merged[k] = v;
          }
        }
      } else {
        merged = data.info;
      }
      // Only cache successful resolutions — ones where we actually read
      // the mint on-chain. A response with decimals=null means the mint
      // wasn't on-chain at fetch time (transient RPC failure, or the
      // mint will exist soon). Caching that placeholder would lock the
      // user into the failure state for 60s, preventing legitimate
      // retries from going through. Without the cache write here, the
      // user retrying immediately fires a fresh network call which can
      // succeed once the chain catches up.
      //
      // Note: this guard intentionally does NOT clear the in-flight
      // map (the finally block at function end does that); we let the
      // current pending callers all receive this placeholder result so
      // they each render the failure UI, but subsequent calls don't
      // get short-circuited by a cache hit.
      if (merged && merged.decimals != null) {
        quoteInfoCache.set(quoteToken, {
          info: merged,
          fetchedAt: Date.now(),
        });
        // Mirror the static metadata fields to localStorage so the
        // next session starts with logos/symbols/decimals already
        // known. Price isn't persisted — it's always re-fetched.
        persistQuoteMeta(quoteToken, merged);
      }
      return merged;
    } finally {
      quoteInfoInFlight.delete(quoteToken);
    }
  })();
  quoteInfoInFlight.set(quoteToken, promise);
  return promise;
}

async function resolvePoolQuote(idx) {
  const pool = pools[idx];
  if (!pool || !pool.quoteToken) return;
  // Capture the quote token at call time. If pools[] gets rebuilt while
  // we're awaiting the fetch (e.g. user types in support input), the
  // pool reference here might be orphaned by the time we return. We
  // re-look-up the pool by index after the await and only apply the
  // result if the pool at that index still has the same quote token.
  const requestedQuote = pool.quoteToken;
  // Read the SOL price from the cache BEFORE we await — this is the
  // baseline we compare against to detect a "first-time" or "after-TTL"
  // SOL price arrival. We compare against the cache (not pool state)
  // because pool state gets reset to null on every rebuildPoolsFromSimple
  // call, which would otherwise make every cache-hit resolve look like
  // "SOL price just appeared" and trigger spurious rebuilds.
  //
  // The cache survives across rebuilds, so it gives a stable reference
  // point: only when the cache itself changes (cold load brings in new
  // data, or 60s TTL expires and re-fetch returns a different price)
  // do we count this as a real SOL price change worth cascading.
  const solCachedBefore = quoteInfoCache.get('SOL');
  const solUsdBefore = solCachedBefore && solCachedBefore.info && Number(solCachedBefore.info.priceUsd) > 0
    ? Number(solCachedBefore.info.priceUsd) : null;
  try {
    const info = await fetchQuoteInfoCached(requestedQuote);
    // Re-check: is the pool at this index still the one we resolved for?
    // If the user changed the quote token or pools[] was rebuilt and the
    // index now refers to a different mint, applying our stale resolution
    // would corrupt the new pool's state.
    const currentPool = pools[idx];
    if (!currentPool || currentPool.quoteToken !== requestedQuote) {
      return;
    }
    applyResolvedInfoToPool(currentPool, info);

    // Post-resolution refresh of derived values that depend on the
    // live SOL price. Bootstrap supplyPercent is derived from
    // solValue × solUsd / poolUsd, so a SOL price update changes
    // the % each pool's bootstrap takes — without this refresh,
    // the positions total would drift away from 100% (the classic
    // "99.94% on initial load with default settings" bug). The
    // rebalance helper absorbs the delta into the wide slices.
    //
    // Runs in both simple AND customize mode because in both, the
    // user's intent is the SOL value they typed; the % is derived.
    // The only path we skip is when bootstrap is in minimal mode
    // (no solValue to recompute) — handled inside the helper.
    for (const p of pools) {
      recomputePoolBootstrapAndRebalance(p);
    }
    renderPools();

    // Simple-mode follow-up: rebuild pools when the SOL price changed
    // in the CACHE (not pool state). Cache-vs-cache comparison avoids
    // the false-positive that would fire on every cache-hit resolve
    // following a rebuildPoolsFromSimple() — without this guard, every
    // user keystroke would trigger a feedback loop of rebuilds.
    //
    // Real cases this fires on:
    //   - Cold load: cache had no SOL entry, now it does
    //   - 60s TTL expiry refetch returned a different SOL price
    //
    // False cases it correctly skips:
    //   - Cache hit after rebuild: SOL price in cache is the same
    //     value as it was when we entered this function
    //   - Any non-SOL resolve: SOL cache unchanged
    if (simpleConfig.mode === 'default') {
      const solCachedAfter = quoteInfoCache.get('SOL');
      const solUsdAfter = solCachedAfter && solCachedAfter.info && Number(solCachedAfter.info.priceUsd) > 0
        ? Number(solCachedAfter.info.priceUsd) : null;
      const solPriceChanged = solUsdBefore !== solUsdAfter;
      if (solPriceChanged) {
        // Rebuild so any auto-sized derived values (support SOL value
        // when auto+preallocation are on) get a fresh computation
        // against the new SOL price and propagate to every pool.
        rebuildPoolsFromSimple();
      }
      // Skip the simple-config re-render when the user is actively
      // typing into one of its inputs. Re-rendering destroys the
      // input element they're focused on, snapping their cursor out
      // of the field mid-keystroke. The resolve's data is still
      // applied to pool state above; the next render (triggered by
      // blur or any structural change) will catch up the displays.
      //
      // Inline display updates that don't depend on a full re-render
      // (USD figures, coverage indicator) are handled by their own
      // refresh helpers — see refreshSimpleSupportDisplay / the
      // inline patches in the prealloc-pct-input handler.
      if (!isFocusInsideSimpleConfigBody()) {
        renderSimpleConfig();
      } else {
        // Lightweight refresh of the displays that depend on resolved
        // prices, without destroying the input elements. Keeps the
        // user's typing focus intact while still reflecting that
        // (e.g.) the SOL price just arrived and we now know the
        // USD value of their typed support SOL.
        refreshSimpleSupportDisplayInline();
        refreshSimplePreallocDisplayInline();
      }
    }

    // Targeted update for the per-pool resolved-info block and the
    // continue-button validation state.
    updateQuoteResolvedDisplay(idx);
    updateContinueToFundingState();

    // The largest pool's quote logo is the coin's back face. Now that
    // this pool's resolvedImageUrl/resolvedSymbol may have changed,
    // refresh the back face (debounced, no-ops if unchanged or if the
    // coin isn't running).
    refreshCoinBackFace();
  } catch (e) {
    // Resolution failed (network blip, RPC error, server error). Surface
    // this in the resolved-info block with a retry affordance, instead
    // of just logging silently. Without this, the user sees an empty
    // resolved-info area and has no obvious recovery — they'd have to
    // edit the address field and tab away to re-trigger resolution.
    //
    // Re-check the pool still exists at this index before writing the
    // failure marker — same robustness as the success path. If pools[]
    // was rebuilt mid-fetch, our failure was for an obsolete request.
    const currentPool = pools[idx];
    if (!currentPool || currentPool.quoteToken !== requestedQuote) return;
    currentPool.resolvedFailed = true;
    currentPool.resolvedFailedError = e.message || 'unknown error';
    log(`Couldn't resolve quote info for ${requestedQuote}: ${e.message}`, 'warning');
    updateQuoteResolvedDisplay(idx);
    updateContinueToFundingState();
  }
}

function updateAllocationSummary() {
  const total = pools.reduce((s, p) => s + p.supplyPercent, 0);
  document.getElementById('totalAllocPct').textContent = total.toFixed(2);
  document.getElementById('unallocatedPct').textContent = Math.max(0, 100 - total).toFixed(2);
  const note = document.getElementById('allocationSummary');
  note.classList.toggle('is-danger', total > 100);
  note.classList.toggle('is-info', total <= 100);
}

// Update one pool's resolved-quote-info display in place.
//
// Used after resolvePoolQuote() finishes its async lookup and we've
// updated pool.resolvedSymbol / decimals / priceUsd / name / imageUrl.
// Touches only the resolved-info block below the form grid, the pool
// header (which carries logo + title + affordance), and the
// override-section visibility (which depends on whether resolution
// came back complete). Everything else in the pool's DOM (including
// any input the user might be typing in) stays untouched.
//
// Also handles the empty-state case: when no resolution data is
// present (typical right after the user changes the quote-token
// dropdown), the block is hidden entirely so we don't render an
// empty grey card that looks like a layout glitch.
function updateQuoteResolvedDisplay(poolIdx) {
  const pool = pools[poolIdx];
  if (!pool) return;
  const node = poolList.children[poolIdx];
  if (!node) return;
  const block = node.querySelector('[data-field="resolvedBlock"]');
  if (block) {
    if (pool.resolvedSymbol) {
      block.innerHTML = renderResolvedInfoHtml(pool);
      block.classList.remove('hidden');
    } else {
      block.innerHTML = '';
      block.classList.add('hidden');
    }
  }
  // Refresh the title (now shows the resolved symbol and logo) and the
  // override section visibility (auto-shown when resolution came back
  // incomplete). updatePoolTitle covers logo + affordance too.
  updatePoolTitle(poolIdx);
  applyOverrideVisibility(node, pool);
}

function updateContinueToFundingState() {
  const btn = document.getElementById('continueToFundingBtn');
  if (!btn) return;
  const reasons = [];
  // Warnings are non-blocking — they surface a real concern but don't
  // disable the Continue button. The user explicitly said they want to
  // be allowed to launch with supply outside LP (presale, team alloc,
  // etc.); we just call out the choice so it isn't accidental.
  const warnings = [];

  if (pools.length === 0) reasons.push('No pools configured');
  const totalAlloc = pools.reduce((s, p) => s + p.supplyPercent, 0);
  if (totalAlloc > 100) reasons.push('Allocations exceed 100%');
  // Under-allocation: supply held outside LP. Per the spec, this is
  // allowed — "We should not prevent people from doing what they want,
  // and just warn." We do compute whether the existing support across
  // all pools covers the USD value of the preallocated supply, so the
  // warning text can be specific about what's actually risky:
  //
  //   - Preallocation with NO support → "rug risk, no backing"
  //   - Preallocation with PARTIAL support → "underbacked, support
  //     covers ~X% of preallocated value"
  //   - Preallocation with FULL support → no warning (the user has
  //     explicitly backed the held-back supply with equal-or-greater
  //     liquidity, which is the honest configuration)
  //
  // Computation:
  //   gapUsd      = (100 - totalAlloc) / 100 × marketCap
  //   supportUsd  = sum over pools of (supportConfig.solValue × solUsd)
  //   coverage    = supportUsd / gapUsd  (clamped to [0, 1] for the warning)
  //
  // When market cap or SOL price isn't available yet, we fall back to
  // the original "consider adding support" wording — we can't compute
  // coverage without prices, but we still want to surface the gap.
  if (totalAlloc < 99.99 && pools.length > 0) {
    const gap = 100 - totalAlloc;
    const gapText = (gap % 1 === 0) ? gap.toFixed(0) : gap.toFixed(1);
    const mcap = parseNumberInput(document.getElementById('targetMarketCap'));
    const solPool = pools.find((p) => (p.quoteToken || '').toUpperCase() === 'SOL');
    const solUsd = solPool && Number(solPool.resolvedPriceUsd) > 0
      ? Number(solPool.resolvedPriceUsd) : null;
    // Sum support USD across all pools that have support enabled. Each
    // pool's support is in SOL, so we multiply by the live SOL price to
    // get USD (consistent with how the funding estimate sizes it).
    let totalSupportUsd = 0;
    for (const p of pools) {
      const sc = p.supportConfig;
      if (sc && sc.mode === 'custom' && Number(sc.solValue) > 0 && solUsd) {
        totalSupportUsd += Number(sc.solValue) * solUsd;
      }
    }
    if (Number.isFinite(mcap) && mcap > 0 && solUsd) {
      const gapUsd = mcap * gap / 100;
      const coverage = gapUsd > 0 ? totalSupportUsd / gapUsd : 1;
      // Treat coverage ≥ 99.5% as "fully backed". Without this tolerance,
      // float drift between the auto-back floor calculation and this
      // check (different rounding moments, SOL price ticks between
      // reads, etc.) causes a 99.9%-coverage warning that asks the user
      // to add ~$0 / ~0.00 SOL — confusing and actionable in name only.
      // Math.round(coverage * 100) below would round 0.999 to "100%"
      // anyway, producing a "Support only backs ~100%" message that
      // contradicts itself.
      if (coverage >= 0.995) {
        // Fully backed — no warning. The preallocation is honest.
      } else if (totalSupportUsd <= 0) {
        warnings.push(
          `${gapText}% of supply (~$${formatUsdRoughly(gapUsd)}) is allocated outside LP ` +
            `with no support position backing it. This is a rug risk — add a Support ` +
            `position sized to ~$${formatUsdRoughly(gapUsd)} so holders of the preallocated ` +
            `supply have a buy wall to sell into.`,
        );
      } else {
        const coveragePct = Math.round(coverage * 100);
        const shortfallUsd = gapUsd - totalSupportUsd;
        warnings.push(
          `${gapText}% of supply (~$${formatUsdRoughly(gapUsd)}) is allocated outside LP, ` +
            `but Support only backs ~${coveragePct}% of it. Consider increasing Support ` +
            `by ~$${formatUsdRoughly(shortfallUsd)} (or in SOL terms, ` +
            `~${(shortfallUsd / solUsd).toFixed(2)} SOL) to fully back the preallocation.`,
        );
      }
    } else {
      // Fallback for when prices aren't available — generic warning.
      // No coverage math possible, so we can't be specific about how
      // much support is needed. The user will see this update once
      // prices resolve.
      warnings.push(
        `${gapText}% of supply is allocated outside LP (preallocation). ` +
          `Add a Support position to back it — without one, holders of the preallocated ` +
          `supply have no buy-side liquidity to sell into.`,
      );
    }
  }

  for (const [i, p] of pools.entries()) {
    if (!p.quoteToken) reasons.push(`Pool ${i + 1}: no quote token`);
    if (p.supplyPercent <= 0) reasons.push(`Pool ${i + 1}: 0% allocation`);
    if ((p.quoteToken || '').toUpperCase() === 'SOL' && p.supplyPercent < 1) {
      reasons.push(`Pool ${i + 1}: SOL allocation must be ≥ 1%`);
    }
    // Decimals must be resolved before we can do any launch math. If the
    // mint isn't on-chain or the user's RPC failed, p.resolvedDecimals is
    // null and the Advanced override is the only escape hatch — but if
    // they haven't supplied an override either, we can't continue.
    const hasDecimals = p.resolvedDecimals != null || p.quoteDecimalsOverride != null;
    if (!hasDecimals) {
      reasons.push(`Pool ${i + 1}: couldn't resolve decimals for ${p.resolvedSymbol || p.quoteToken}`);
    }
    const hasPrice = p.resolvedPriceUsd != null || p.quoteUsdOverride != null;
    if (!hasPrice) {
      reasons.push(`Pool ${i + 1}: no USD price for ${p.resolvedSymbol || p.quoteToken}`);
    }
    // Hard-block on known Raydium-CLMM incompatibility. We do NOT block on
    // resolvedCompatible === null (couldn't verify) — that's a soft warning,
    // user might be on a flaky RPC or the mint is new. Only resolvedCompatible
    // === false (we positively read the mint and found unsupported extensions)
    // gets blocked here. The pre-flight on the server side is a belt-and-
    // suspenders catch if this somehow gets bypassed.
    if (p.resolvedCompatible === false) {
      const exts = (p.resolvedDisallowedNames || []).join(', ');
      reasons.push(
        `Pool ${i + 1}: ${p.resolvedSymbol || p.quoteToken} is not Raydium-CLMM ` +
          `compatible (Token-2022 extensions: ${exts})`,
      );
    }

    // ──── Safety checks from price-safety-plan Milestone D ────
    //
    // Hard blocks (disable Continue button entirely):
    //   - Active freeze authority: deployer can freeze the launch
    //     wallet's quote-token balance mid-launch, bricking the
    //     process. Funds become unrecoverable through normal sweep.
    //   - Raydium has no route: pool creation will hard-fail at
    //     Step 5 anyway. Catching it here saves the user from going
    //     through Steps 3-4 (which costs SOL on fees) just to fail
    //     at the irreversible click.
    //
    // Soft warnings (allow Continue but flag the concern):
    //   - Active mint authority: supply can be inflated, devaluing
    //     pool contents. Doesn't brick the launch.
    //   - Couldn't verify Raydium liquidity: maybe Trade API is
    //     down right now; user can retry. Step 5 will hard-check.
    if (p.resolvedFreezeAuthorityBlock === true) {
      reasons.push(
        `Pool ${i + 1}: ${p.resolvedSymbol || p.quoteToken} has an active ` +
          `freeze authority. Its deployer could freeze your launch wallet's ` +
          `holdings mid-launch and brick the process.`,
      );
    }
    if (p.resolvedRaydiumTradeable === 'no') {
      // No Raydium liquidity for this token. NOT a hard block — we fall
      // back to GeckoTerminal/DexScreener which index Meteora and other
      // DEXes, so we can still get a real market price. Warn the user
      // so they're not surprised about the source. (The hasPrice check
      // above is the actual hard floor — if NO source produced a price,
      // that catches it.)
      warnings.push(
        `Pool ${i + 1}: Raydium has no pool for ${p.resolvedSymbol || p.quoteToken}. ` +
          `Verify the price is accurate before launching, or set an Advanced ` +
          `override if you know the correct value.`,
      );
    }
    if (p.resolvedMintAuthorityWarning === true) {
      warnings.push(
        `Pool ${i + 1}: ${p.resolvedSymbol || p.quoteToken}'s supply can be ` +
          `inflated by its deployer. Be aware that supply inflation could ` +
          `devalue the token before your pool is created.`,
      );
    }
    if (p.resolvedRaydiumTradeable === 'unknown') {
      warnings.push(
        `Pool ${i + 1}: couldn't reach the Raydium Trade API for ` +
          `${p.resolvedSymbol || p.quoteToken} right now. Trebuchet will ` +
          `retry at Step 5; if that also fails, you'll be asked to retry ` +
          `or set an override.`,
      );
    }
    // Pool-level positions total. Under the unified model, bootstrap
    // (if custom) + sum(slice sharePercents) + sum(band supplyPercents)
    // must equal 100% of pool. Failing this means the user has either
    // over- or under-allocated and the launch can't proceed.
    const positionsTotal = computePoolPositionsTotal(p);
    if (Math.abs(positionsTotal - 100) > 0.01) {
      reasons.push(
        `Pool ${i + 1}: positions total ${positionsTotal.toFixed(2)}% — ` +
          `bootstrap + slices + ladder must sum to 100%`,
      );
    }
    // Per-slice checks. We no longer flag a 0% slice as an error because
    // buildAllocationsForApi filters those out automatically (they
    // contribute nothing to the pool's allocation). A slice with an
    // external recipient configured but no address is still a real
    // mistake — flag it. An address that's filled in but doesn't even
    // look like base58 is also flagged here so the user sees the
    // problem on the same screen they entered it (without this check
    // the server's `normalizeDistribution` rejects with "Invalid
    // recipient address" only AFTER funding is committed).
    for (const [si, slice] of p.distribution.entries()) {
      if (slice.useExternalRecipient && !slice.recipient) {
        reasons.push(`Pool ${i + 1} slice ${si + 1}: recipient address required`);
      } else if (
        slice.useExternalRecipient &&
        slice.recipient &&
        !isPlausibleSolAddress(slice.recipient)
      ) {
        reasons.push(
          `Pool ${i + 1} slice ${si + 1}: recipient doesn't look like a valid ` +
            `Solana address`,
        );
      }
    }
  }

  // Duplicate-pool detection. Raydium derives the CLMM pool PDA from
  // (ammConfig, mintA, mintB), so two pools with the same quote token
  // AND the same fee tier collide at the on-chain account address. The
  // first createPool succeeds; the second fails at simulation with an
  // opaque "account already in use" error. No SOL is lost, but the
  // user gets a mid-launch failure with a confusing diagnostic.
  // Catching it here keeps the failure local to the form.
  //
  // Distinct fee tiers on the same quote are legitimately separate
  // pools — keyed by (normalized quote, ammConfigIndex) so they don't
  // collide here.
  const seenPoolKeys = new Map();
  for (const [i, p] of pools.entries()) {
    if (!p.quoteToken) continue;
    const quoteKey =
      (p.quoteToken || '').toUpperCase() === 'SOL' ? 'SOL' : p.quoteToken;
    const key = `${quoteKey}|${p.ammConfigIndex}`;
    if (seenPoolKeys.has(key)) {
      const firstIdx = seenPoolKeys.get(key);
      const label = p.resolvedSymbol || p.quoteToken;
      reasons.push(
        `Pool ${i + 1} duplicates Pool ${firstIdx + 1} (same ${label} ` +
          `quote at the same fee tier). Pick a different quote or a ` +
          `different fee tier — Raydium uses both to identify a pool.`,
      );
    } else {
      seenPoolKeys.set(key, i);
    }
  }

  const name = document.getElementById('tokenName')?.value.trim();
  const symbol = document.getElementById('tokenSymbol')?.value.trim();
  const supply = parseNumberInput(document.getElementById('tokenSupply'));
  const mc = parseNumberInput(document.getElementById('targetMarketCap'));
  if (!name) reasons.push('Token name required');
  if (!symbol) reasons.push('Token symbol required');
  if (!supply || supply <= 0) {
    reasons.push('Token supply must be > 0');
  } else if (supply > MAX_TOKEN_SUPPLY) {
    // Sanity cap below the on-chain u64 ceiling — see MAX_TOKEN_SUPPLY
    // definition for rationale. Surface the actual cap in the message so
    // the user can adjust without guessing what an acceptable value is.
    reasons.push(`Token supply must not exceed ${MAX_TOKEN_SUPPLY.toLocaleString()}`);
  }
  if (!mc || mc <= 0) reasons.push('Target market cap must be > 0');

  btn.disabled = reasons.length > 0;
  btn.title = reasons.join('; ');

  // Also surface reasons inline. The empty-state takes the user further than
  // a tooltip-only hint they may not even hover over.
  const reasonBox = document.getElementById('continueReasons');
  if (reasonBox) {
    // Build the blocking-reasons block (if any), then the warnings block
    // (if any). Warnings render even when reasons is empty, so a clean
    // launch with preallocation still surfaces the heads-up.
    let inner = '';
    if (reasons.length > 0) {
      const hasPoolReason = reasons.some((r) => /^Pool \d/.test(r));
      const hint = (simpleConfig.mode === 'default' && hasPoolReason)
        ? '<p class="is-size-7 mt-2 mb-0"><em>Click <strong>Customize pools manually</strong> to access pool-level controls.</em></p>'
        : '';
      inner +=
        '<strong>Cannot continue yet:</strong><ul style="margin-top: 0.25rem; margin-bottom: 0;">' +
        reasons.map((r) => `<li>${escapeHtml(r)}</li>`).join('') +
        '</ul>' + hint;
    }
    if (warnings.length > 0) {
      // Soft warnings — different prefix and styling so the user can
      // tell at a glance whether something is blocking vs informational.
      // Margin separates from the blocking-reasons block when both are
      // present.
      const sep = reasons.length > 0 ? 'margin-top: 0.75rem;' : '';
      inner += `<div style="${sep}"><strong>Heads up:</strong><ul style="margin-top: 0.25rem; margin-bottom: 0;">` +
        warnings.map((w) => `<li>${escapeHtml(w)}</li>`).join('') +
        '</ul></div>';
    }
    if (inner === '') {
      reasonBox.classList.add('hidden');
      reasonBox.innerHTML = '';
    } else {
      reasonBox.classList.remove('hidden');
      reasonBox.innerHTML = inner;
    }
  }

  // Rolling cost preview. Piggybacking on this function's existing role as
  // the central "config changed, recheck" chokepoint means we automatically
  // pick up every config-mutation site without having to thread cost-update
  // calls through 17 separate handlers. The debounce inside
  // requestCostPreviewUpdate() handles per-keystroke firing.
  requestCostPreviewUpdate();
}

// ---------------------------------------------------------------------------
// Step 2 cost preview
// ---------------------------------------------------------------------------
//
// Shows an approximate SOL cost in step 2 so users see the price impact of
// their pool/config choices BEFORE they commit to step 3 funding. Addresses
// the "sticker shock at the funding stage" complaint: users who configured
// without any cost feedback would land at step 3 surprised by how much SOL
// they needed to send.
//
// Approach: call the same /api/estimate-lp-funding endpoint that step 3
// uses, but only display the total SOL (not the full breakdown — that's
// reserved for step 3 to avoid duplicating UI). Debounced 500ms so rapid
// keystrokes don't hammer the endpoint, with a sequence number so an
// in-flight stale response can't overwrite a newer one.
//
// Hidden on steps other than 2 — step 3+ already shows the real estimate,
// and showing the preview would just add confusion.

let _costPreviewDebounceHandle = null;
let _costPreviewRequestSeq = 0;
// The most recent funding estimate, cached so the preview card can show the
// running launch cost. Set by runCostPreview() on success; cleared when the
// config can't be estimated. updatePreviewStats() reads it.
let _lastCostEstimate = null;

function setCostPreviewState(state, value) {
  const card = document.getElementById('costPreview');
  if (!card) return;
  const valueEl = document.getElementById('costPreviewValue');
  const labelEl = document.getElementById('costPreviewLabel');
  const hintEl = document.getElementById('costPreviewHint');
  if (!valueEl || !labelEl || !hintEl) return;

  // #9: the sticky-bar cost echo mirrors this card's value so the running
  // estimate stays visible after the user scrolls the inline preview away.
  // These may be absent in some embeds, so every write below is guarded.
  const stickyCost = document.getElementById('stickyCost');
  const stickyCostValue = document.getElementById('stickyCostValue');

  if (state === 'hidden') {
    card.classList.add('hidden');
    if (stickyCost) stickyCost.classList.add('hidden');
    return;
  }
  card.classList.remove('hidden');
  if (state === 'loading') {
    // Keep the previously-displayed value if we have one — clearing
    // it to "…" causes visible flicker every time the cost preview
    // re-fetches (which can happen multiple times in quick succession
    // as multiple pool resolves complete). The label changes subtly
    // to signal a refresh is in progress without removing the number
    // the user was reading.
    if (!valueEl.textContent || !valueEl.textContent.includes('SOL')) {
      // First-ever load (or post-error) — show the spinner-like
      // placeholder since there's nothing to keep displayed.
      labelEl.textContent = 'Estimating cost: ';
      valueEl.textContent = '…';
      hintEl.textContent = '(computing)';
    } else {
      // Subsequent refresh — leave the value alone, just dim the hint
      // text to a subtle "(updating…)" so the user knows a refresh is
      // in flight without losing the value they were reading.
      hintEl.textContent = '(updating…)';
    }
    return;
  }
  if (state === 'ready') {
    labelEl.textContent = 'Estimated cost: ';
    // 3 decimals matches the breakdown in step 3. Use ≈ rather than = so
    // the user reads it as "approximate" — the actual number can shift
    // slightly between this preview and step 3's estimate because the
    // server may pick up fresher SOL/quote-token prices in the interim.
    valueEl.textContent = `≈ ${Number(value).toFixed(3)} SOL`;
    hintEl.textContent = '(approximate; full breakdown shows on next step)';
    // Mirror the same value into the sticky echo and reveal it. Identical
    // formatting so the two displays never appear to disagree.
    if (stickyCostValue) stickyCostValue.textContent = `≈ ${Number(value).toFixed(3)} SOL`;
    if (stickyCost) stickyCost.classList.remove('hidden');
    return;
  }
  if (state === 'error') {
    labelEl.textContent = '';
    valueEl.textContent = "Couldn't compute preview";
    hintEl.textContent = '(full estimate will run when you click Continue)';
    // No valid number to echo — hide the sticky copy rather than leave a
    // stale value next to the step label.
    if (stickyCost) stickyCost.classList.add('hidden');
    return;
  }
}

// Decide whether the preview should run at all. We only want it on step 2
// (config stage), and only when pools are configured to a state the
// estimator can actually handle. Trying to estimate an incomplete config
// would either fail server-side (noisy) or return a misleading number
// (worse — gives the user a wrong sense of cost).
function shouldShowCostPreview() {
  if (typeof currentStep === 'number' && currentStep !== 2) return false;
  if (!Array.isArray(pools) || pools.length === 0) return false;
  // Allocation total semantics differ by mode:
  //
  //   SIMPLE mode: pool % is driven by the flywheel split slider; it
  //   always sums to (100 - preallocationPercent) exactly. Deviating
  //   from that means something is mid-rebuild and an estimate would
  //   be wrong. We check equality within a small floating-point fuzz.
  //
  //   CUSTOMIZE mode: the user freely types per-pool %. Any sum from
  //   0% up to and including 100% is a valid configuration — the gap
  //   between the sum and 100% is implicit preallocation, held back in
  //   the launch wallet with no LP cost. We only bail if the sum
  //   EXCEEDS 100% (server-side validation would reject it anyway, so
  //   no point estimating).
  //
  // Under-allocated pools in simple mode would estimate a cost for
  // missing liquidity, over-allocated in any mode would double-count.
  const isSimpleMode = !simpleConfig.mode || simpleConfig.mode === 'default';
  const total = pools.reduce((s, p) => s + (Number(p.supplyPercent) || 0), 0);
  if (isSimpleMode) {
    const preallocPct = simpleConfig.preallocationEnabled
      ? Math.max(0, Math.min(99, Number(simpleConfig.preallocationPercent) || 0))
      : 0;
    const expectedTotal = 100 - preallocPct;
    if (Math.abs(total - expectedTotal) > 0.5) return false;
  } else {
    // Customize mode — only fail on overflow. A small +0.5 tolerance
    // matches the simple-mode fuzz so rounding doesn't cause false
    // negatives right at 100%.
    if (total > 100.5) return false;
  }
  // Bail if any pool's quote isn't resolved yet. The estimator's
  // bootstrap-cost math needs the quote token's USD price, and an
  // unresolved quote produces a worst-case estimate that scares users
  // unnecessarily.
  for (const p of pools) {
    if (p.resolvedPriceUsd == null && p.quoteUsdOverride == null) {
      const sym = (p.quoteToken || '').toUpperCase();
      const isSol = sym === 'SOL';
      if (!isSol) return false;
    }
  }
  return true;
}

async function runCostPreview() {
  if (!shouldShowCostPreview()) {
    _lastCostEstimate = null;
    updatePreviewStats();
    setCostPreviewState('hidden');
    return;
  }
  const seq = ++_costPreviewRequestSeq;
  setCostPreviewState('loading');
  try {
    const allocations = buildAllocationsForApi();
    const targetMc = parseNumberInput(document.getElementById('targetMarketCap'));

    const resp = await fetch('/api/estimate-lp-funding', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ allocations, targetMarketCapUsd: targetMc, publishLaunchReport: isLaunchReportEnabled() }),
    });
    // If a newer request started while this one was in flight, drop
    // our result. Without this guard, an out-of-order response could
    // overwrite a fresher one and the user sees the wrong number.
    if (seq !== _costPreviewRequestSeq) return;
    const data = await resp.json();

    if (!data.success || !data.estimate) {
      _lastCostEstimate = null;
      updatePreviewStats();
      setCostPreviewState('error');
      return;
    }
    _lastCostEstimate = data.estimate;
    updatePreviewStats();
    // Surface the grand total (launch + airdrop execution) in the
    // cost preview card. updatePreviewStats above also adds airdrop
    // cost to its own Est. Cost tile, so the two displays agree.
    const airdropExecutionSol = computeAirdropExecutionCostSol();
    setCostPreviewState('ready', data.estimate.totalSol + airdropExecutionSol);
  } catch (e) {
    if (seq !== _costPreviewRequestSeq) return;
    // Don't surface the error message — the user will see a real one
    // when they click Continue. This preview is best-effort.
    _lastCostEstimate = null;
    updatePreviewStats();
    setCostPreviewState('error');
  }
}

function requestCostPreviewUpdate(options) {
  // Reflect pool/allocation edits in the preview card immediately (the
  // cost number itself updates a moment later when the debounced fetch
  // returns). Cheap — touches only the stat grid, not the coin.
  updatePreviewStats();

  // Hidden on non-step-2 contexts. Cancel any pending fetch and stop
  // here so a freshly-arrived step-2 view sees a clean state.
  if (!shouldShowCostPreview()) {
    if (_costPreviewDebounceHandle) {
      clearTimeout(_costPreviewDebounceHandle);
      _costPreviewDebounceHandle = null;
    }
    setCostPreviewState('hidden');
    return;
  }
  if (_costPreviewDebounceHandle) clearTimeout(_costPreviewDebounceHandle);
  // immediate=true bypasses the debounce for definitive config changes
  // (toggle changes, full re-renders) where the user expects to see the
  // new total right away — not 500ms later. Per-keystroke typing still
  // uses the debounce so we don't hammer the server.
  if (options && options.immediate) {
    runCostPreview();
  } else {
    _costPreviewDebounceHandle = setTimeout(runCostPreview, 500);
  }
}

['tokenName', 'tokenSymbol', 'tokenSupply', 'targetMarketCap'].forEach((id) => {
  bind(id, 'input', updateContinueToFundingState);
});

// targetMarketCap also drives the bootstrap supplyPercent math (the
// derived % depends on the pool's USD allocation, which is target mcap
// × pool's supplyPercent). When the user changes it on step 2, recompute
// each pool's bootstrap supplyPercent from its solValue, and rebalance
// the wide slices to absorb the delta so positions total stays at 100%.
//
// Runs in both simple AND customize mode — customize-mode users still
// have solValue as canonical, and a mcap change updates the derived %
// just like for simple-mode users. The recompute helper is a no-op when
// bootstrap is in minimal mode (no solValue to recompute).
bind('targetMarketCap', 'input', () => {
  let anyChange = false;
  for (const p of pools) {
    if (p.bootstrapConfig && p.bootstrapConfig.mode === 'custom') {
      recomputePoolBootstrapAndRebalance(p);
      anyChange = true;
    }
  }
  if (anyChange) {
    // The bootstrap dollar hint, the band mcap hints, and the positions-
    // total indicator all depend on mcap; re-render to refresh them.
    renderPools();
  } else if (simpleConfig.mode === 'customize') {
    // Customize mode with no custom-bootstrap pool: renderPools didn't fire,
    // but the depth chart's USD scaling (token-side bands vs the quote-side
    // support wall) tracks target mcap. Redraw each pool's chart live so the
    // support-vs-token balance stays honest as mcap changes. This is a pure
    // SVG redraw — it does NOT touch band supply or the ceiling cap, so it
    // can't disturb the user's configured positions mid-edit. The ceiling
    // cap (which also derives from mcap) is re-clamped on the next ladder
    // interaction via ensureLadderStrategyConfig.
    for (let i = 0; i < pools.length; i++) updatePoolDepthChart(i);
    // The ceiling cap ($1B ÷ mcap) and its dollar readout also track mcap;
    // refresh them in place too, so the whole ladder section stays honest as
    // the user types — without a reflowing renderPools.
    refreshLadderMcapDisplays();
  }
  // Preallocation display in the simple config also depends on mcap
  // (USD value of the held-back tokens). The auto-sized support value
  // also depends on mcap (preallocation USD ÷ SOL price), so we run
  // rebuildPoolsFromSimple — debounced so rapid typing doesn't fire
  // a rebuild per keystroke. The inline display helpers patch the
  // visible figures (USD, token count, coverage indicator) in place,
  // so the user sees their input reflected immediately without us
  // having to destroy and rebuild the simple-config body.
  if (simpleConfig.mode === 'default') {
    rebuildPoolsFromSimpleDebounced();
    refreshSimplePreallocDisplayInline();
    refreshSimpleSupportDisplayInline();
    // Airdrop token allocations depend on launch starting price
    // (market cap / supply), so mcap changes shift every row's
    // tokens and may flip the budget verdict.
    refreshAirdropDisplayInline();
    // Continue-state check too, since the coverage warning depends on
    // the latest support → preallocation USD comparison.
    if (typeof updateContinueToFundingState === 'function') updateContinueToFundingState();
  }
});

// Token supply input also feeds the preallocation token-count display
// (% × supply = preallocated tokens). Refresh the simple config so the
// display tracks the user's input. Token supply doesn't affect support
// sizing (support is USD-denominated via market cap, not supply), so a
// rebuild isn't strictly necessary — but we call it anyway for symmetry
// and to handle any future supply-dependent derived values cleanly.
// Debounced + inline-display approach matches the mcap handler above
// so typing into supply doesn't cost a full simple-config rebuild
// per keystroke.
bind('tokenSupply', 'input', () => {
  if (simpleConfig.mode === 'default') {
    rebuildPoolsFromSimpleDebounced();
    refreshSimplePreallocDisplayInline();
    // Total-supply directly affects the preallocation budget AND each
    // airdrop row's token count (tokens = sol × SOL_USD × supply / mcap).
    refreshAirdropDisplayInline();
  }
});

// Blur handlers: flush any pending debounced rebuild so the pools
// reflect the user's latest input before they interact with the
// rest of the form (Continue button, customize switch, etc.).
//
// Customize-mode guard: no debounced rebuild was scheduled in
// customize mode (the input handlers above gate on simple mode), so
// flushing here would unconditionally call rebuildPoolsFromSimple
// and wipe user pool customizations. Skip when in customize mode.
bind('targetMarketCap', 'blur', () => {
  if (simpleConfig.mode === 'customize') {
    // mcap drives the ladder ceiling cap ($1B ÷ mcap). If raising mcap pulled
    // the cap below a pool's configured ceiling, clamp it down and regenerate
    // that pool's bands so the chart and positions match the tighter ceiling.
    // (Lowering mcap raises the cap and never forces a clamp.) regenerate runs
    // through ensureLadderStrategyConfig, which does the clamp, and preserves
    // the positions total via its delta rebalance. Re-render only when a clamp
    // actually fired, so we don't reflow the pool list — the dollar readout and
    // cap were already refreshed live by the input handler. We must NOT rebuild
    // from simple here; that would wipe the user's customizations.
    let changed = false;
    for (const p of pools) {
      const cfg = p.ladderConfig;
      if (cfg && cfg.mode === 'manual' && Number(cfg.ceiling) > poolMaxCeilingMultiplier(p)) {
        regenerateLadderBands(p);
        changed = true;
      }
    }
    if (changed) renderPools();
    return;
  }
  flushRebuildPoolsFromSimple();
});
bind('tokenSupply', 'blur', () => {
  if (simpleConfig.mode === 'customize') return;
  flushRebuildPoolsFromSimple();
});

// Live token-preview card. The same five fields that drive the
// continue-button state (above) plus description and logo all feed
// renderTokenPreview() so the card on the right updates as the user
// types/selects. Logo uses `change` since file inputs don't fire
// `input`. Multiple listeners on tokenLogo coexist with the existing
// filename-display handler bound earlier.
['tokenName', 'tokenSymbol', 'tokenSupply', 'targetMarketCap', 'tokenDescription'].forEach((id) => {
  bind(id, 'input', renderTokenPreview);
});
bind('tokenLogo', 'change', renderTokenPreview);

// Format the two numeric inputs with thousand-separator commas as the
// user types. The format on every input event preserves the user's
// cursor position. Read sites use parseNumberInput() to strip commas
// before passing the value to Number() or the server.
['tokenSupply', 'targetMarketCap'].forEach((id) => {
  const el = document.getElementById(id);
  if (el) {
    el.addEventListener('input', () => formatNumberInput(el));
    // The HTML default values are pre-formatted, but if a user has
    // browser autofill or any other source pushes a raw number into
    // the input, run the formatter once on focus too. Cheap insurance.
    el.addEventListener('focus', () => formatNumberInput(el));
  }
});

bind('addPoolBtn', 'click', () => {
  // Suggest a useful default quote for the second/third pool: USDC if a
  // SOL pool already exists, otherwise SOL. The supplyPercent default is
  // now computed inside addPool() from the remaining budget. Open
  // expanded since the user is explicitly configuring something.
  const hasSol = pools.some((p) => (p.quoteToken || '').toUpperCase() === 'SOL');
  addPool({ quoteToken: hasSol ? 'USDC' : 'SOL', _isExpanded: true });
});

// Return-to-simple-mode button: switches from customize mode back to
// the simple toggle+dropdown UI. Wipes any pool customizations and
// rebuilds defaults from simpleConfig — but only after confirming
// with the user, since they could lose meaningful customization.
//
// Uses the HTML confirmDialog rather than window.confirm because the
// rest of the codebase does — see the Chromium-on-Windows note in
// the genericConfirmModal markup. Native confirm leaves inputs in
// the page un-clickable until the next focus cycle on some Windows
// builds.
bind('returnToSimpleBtn', 'click', async () => {
  // Detect "meaningful customization" — anything beyond the defaults
  // simpleConfig would produce. If the current pools already match
  // what rebuildPoolsFromSimple would produce, skip the confirm.
  const currentMatchesSimple = poolsMatchSimpleDefaults();
  if (!currentMatchesSimple) {
    const ok = await confirmDialog({
      title: 'Discard custom pool configuration?',
      body: '<p>Your custom pool configuration changes will be discarded and your simple-mode settings restored. Any allocations, fee tier choices, slice splits, ladder bands, or per-pool overrides you set in customize mode will be lost.</p>',
      confirmLabel: 'Switch to simple mode',
      danger: true,
    });
    if (!ok) return;
  }
  simpleConfig.mode = 'default';
  rebuildPoolsFromSimple();
  applySimpleConfigMode();
});

// Compare the current pools[] to what rebuildPoolsFromSimple() would
// produce given the current simpleConfig. Used to skip the confirm
// dialog when switching back to simple mode wouldn't actually lose
// anything (e.g. user clicked Customize but didn't change anything).
//
// Compares the things that matter for the lossiness check: pool count,
// quote tokens, allocations, fee tiers, and slice configuration.
// Resolved-info fields and underscored UI-state fields are ignored.
function poolsMatchSimpleDefaults() {
  // Build what the defaults *would* look like by simulating in a
  // throwaway array. We can't just call rebuildPoolsFromSimple()
  // because that has the side effect of mutating pools[].
  //
  // The expected distribution is per-pool: the SOL pool gets the split
  // (when split is enabled) but the flywheel pool always gets a single
  // 100% slice — matching rebuildPoolsFromSimple's behavior. Splitting
  // the flywheel side requires customize mode.
  const splitDist = buildEqualSplitDistribution(
    simpleConfig.splitEnabled ? simpleConfig.splitCount : 1,
  );
  const singleDist = buildEqualSplitDistribution(1);

  // Mirror rebuildPoolsFromSimple's preallocation scaling so the
  // expected pool sizes match what a fresh rebuild would actually
  // produce. Without this, enabling preallocation in simple mode would
  // be perpetually flagged as "drift from defaults" even though
  // customize-mode state matches it exactly.
  const preallocPct = simpleConfig.preallocationEnabled
    ? Math.max(0, Math.min(99, Number(simpleConfig.preallocationPercent) || 0))
    : 0;
  const lpBudget = 100 - preallocPct;

  let expected;
  if (simpleConfig.flywheelEnabled) {
    const fw = FLYWHEELS[simpleConfig.flywheelKey];
    if (fw && fw.available && fw.mint) {
      // Match rebuildPoolsFromSimple's clamp so the comparison uses the
      // same effective value the rebuild would produce.
      const flywheelPct = Math.max(
        FLYWHEEL_MIN_PERCENT,
        Math.min(FLYWHEEL_MAX_PERCENT, Number(simpleConfig.flywheelPercent) || DEFAULT_FLYWHEEL_PERCENT),
      );
      const solShare = 100 - flywheelPct;
      expected = [
        {
          quoteToken: 'SOL',
          supplyPercent: solShare * lpBudget / 100,
          distribution: splitDist,
        },
        {
          quoteToken: fw.mint,
          supplyPercent: flywheelPct * lpBudget / 100,
          distribution: singleDist,
        },
      ];
    } else {
      expected = [{ quoteToken: 'SOL', supplyPercent: lpBudget, distribution: splitDist }];
    }
  } else {
    expected = [{ quoteToken: 'SOL', supplyPercent: lpBudget, distribution: splitDist }];
  }

  if (pools.length !== expected.length) return false;
  for (let i = 0; i < pools.length; i++) {
    const p = pools[i];
    const e = expected[i];
    if (p.quoteToken !== e.quoteToken) return false;
    // Tolerance compare on supplyPercent — preallocation scaling can
    // produce non-integer values (e.g. 80 × 80/100 = 64) but rounding
    // through the user's last input vs. the canonical math can diverge
    // by 1 ULP. 0.01% is well below any user-visible difference.
    if (Math.abs(Number(p.supplyPercent) - e.supplyPercent) > 0.01) return false;
    if (p.ammConfigIndex !== 3) return false; // 1% is the simple default
    // Distribution shape match. Compare slice count and each slice's
    // sharePercent within a small tolerance to absorb floating-point
    // drift. recipient/useExternalRecipient must be at defaults too —
    // any user-set recipient is meaningful customization that we don't
    // want to silently lose.
    if (p.distribution.length !== e.distribution.length) return false;
    for (let j = 0; j < p.distribution.length; j++) {
      const ps = p.distribution[j];
      const es = e.distribution[j];
      if (Math.abs(Number(ps.sharePercent) - es.sharePercent) > 0.01) return false;
      if (ps.useExternalRecipient) return false;
      if (ps.recipient) return false;
    }
    // User-typed overrides count as "meaningful customization" — losing
    // a price override the user manually entered (because resolution
    // failed for their token) would be a real regression. Trigger the
    // confirm if any override is set.
    if (p.quoteSymbolOverride) return false;
    if (p.quoteDecimalsOverride != null) return false;
    if (p.quoteUsdOverride != null) return false;

    // Bootstrap and ladder customizations: compare each pool's current
    // config against what deriveBootstrapConfigFromSimple and
    // deriveLadderConfigFromSimple would produce from the current
    // simpleConfig. Any drift means the user changed something in
    // customize mode and would lose it if we silently rebuilt.
    //
    // Both helpers are pure functions of simpleConfig + pool count, so
    // calling them here is safe — no side effects, no state mutation.
    const expectedBs = deriveBootstrapConfigFromSimple(Number(p.supplyPercent), pools.length);
    const actualBs = p.bootstrapConfig || { mode: 'minimal' };
    if (actualBs.mode !== expectedBs.mode) return false;
    if (actualBs.mode === 'custom') {
      // Compare solValue (canonical user intent) rather than supplyPercent
      // (which is derived from solValue + live SOL price + mcap). A
      // supplyPercent mismatch can happen when the user hasn't touched
      // anything but the SOL price refreshed — we don't want that to
      // count as a customization.
      if (Math.abs(Number(actualBs.solValue) - Number(expectedBs.solValue)) > 0.0001) {
        return false;
      }
    }

    const expectedLd = deriveLadderConfigFromSimple();
    const actualLd = p.ladderConfig || { mode: 'off', bands: [] };
    if (actualLd.mode !== expectedLd.mode) return false;
    if (actualLd.mode === 'manual') {
      const actualBands = Array.isArray(actualLd.bands) ? actualLd.bands : [];
      const expectedBands = Array.isArray(expectedLd.bands) ? expectedLd.bands : [];
      if (actualBands.length !== expectedBands.length) return false;
      for (let bi = 0; bi < actualBands.length; bi++) {
        const ab = actualBands[bi];
        const eb = expectedBands[bi];
        if (Math.abs(Number(ab.supplyPercent) - Number(eb.supplyPercent)) > 0.01) return false;
        if (Math.abs(Number(ab.lowerMultiplier) - Number(eb.lowerMultiplier)) > 0.001) return false;
        if (Math.abs(Number(ab.upperMultiplier) - Number(eb.upperMultiplier)) > 0.001) return false;
      }
    }

    // Support config comparison. Mirrors rebuildPoolsFromSimple:
    // simple mode applies the same derived supportConfig to every
    // pool — the totalSupportSol gets split equally, so each pool's
    // expected solValue is totalSupportSol / poolCount. We compute the
    // expected config once with the actual pool count and compare it
    // against every pool's stored config (they should all be identical
    // in simple mode).
    //
    // We compare solValue (canonical) and depthPct (canonical) rather
    // than anything derived. depthPct comparison goes through
    // clampSupportDepth on both sides so an out-of-range raw value
    // (e.g. user typed 75 then it was clamped to 50) still matches.
    const expectedSupport = deriveSupportConfigFromSimple(pools.length);
    const actualSupport = p.supportConfig || { mode: 'off' };
    if (actualSupport.mode !== expectedSupport.mode) return false;
    if (actualSupport.mode === 'custom') {
      if (Math.abs(Number(actualSupport.solValue) - Number(expectedSupport.solValue)) > 0.0001) {
        return false;
      }
      if (clampSupportDepth(actualSupport.depthPct) !== clampSupportDepth(expectedSupport.depthPct)) {
        return false;
      }
    }
  }
  return true;
}

bind('continueToFundingBtn', 'click', async () => {
  // Flush any pending debounced pool rebuild so the estimator sees
  // the user's latest input. Without this, a Continue click during
  // the 250ms debounce window would send stale allocations to the
  // server and the funding estimate would be wrong.
  //
  // Customize-mode guard: no debounced rebuild was scheduled (the
  // rebuild helpers short-circuit on customize mode). The pools
  // array IS the user's source of truth here — flushing would call
  // rebuildPoolsFromSimple and silently wipe every customization
  // right before sending allocations to the server.
  if (simpleConfig.mode !== 'customize') {
    flushRebuildPoolsFromSimple();
  }
  await withRunState(async () => {
    try {
      const allocations = buildAllocationsForApi();
      const targetMc = parseNumberInput(document.getElementById('targetMarketCap'));
      const resp = await fetch('/api/estimate-lp-funding', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // targetMarketCapUsd is only used by the estimator when a custom-
        // mode bootstrap is present, but we send it unconditionally so the
        // server has it available regardless. All-minimal launches ignore it.
        body: JSON.stringify({ allocations, targetMarketCapUsd: targetMc, publishLaunchReport: isLaunchReportEnabled() }),
      });
      const data = await resp.json();
      if (!data.success) throw new Error(data.error);

      fundingRequirement = data.estimate;

      // Apply the funding-estimate's resolvedPrices back to each pool's
      // resolvedPriceUsd. Per the price-safety plan (Milestone B): the
      // user should see the same quote-token USD value everywhere —
      // Step 2 display, Step 3 cost preview, Step 5 pool creation.
      //
      // Whichever source funding-estimate used to size the bootstrap
      // and the auto-swap targets (raydium-probe, oracle, user-override,
      // or sol/USD), THAT is the price the user is implicitly
      // committing to when they click "Continue to Funding." Propagating
      // it back to the pool state means:
      //   - Step 3's renderFundingRequirements shows the right number
      //   - Step 5's drift guard compares against the right reference
      //     (it sees the override == funding-estimate price, so it
     //      detects movement SINCE funding committed, not movement
     //      between aggregator and probe at the same moment)
      //
      // We only update pools whose source isn't 'unresolved' — leaving
      // the pool's existing resolvedPriceUsd alone if funding-estimate
      // couldn't resolve a price (rare, but we don't want to clear a
      // valid Step 2 value with null).
      if (Array.isArray(fundingRequirement.resolvedPrices)) {
        for (const rp of fundingRequirement.resolvedPrices) {
          if (rp.source === 'unresolved') continue;
          if (rp.quoteUsd === null || rp.quoteUsd === undefined) continue;
          const pool = pools[rp.allocationIndex];
          if (!pool) continue;
          pool.resolvedPriceUsd = rp.quoteUsd;
          pool.resolvedPriceSource = rp.source;
        }
      }

      // Track how much of the SOL requirement has been "consumed" by
      // completed auto-swaps. The original solLamports requirement
      // includes budgeted SOL for all auto-swaps; once a swap finishes,
      // that portion is already spent, so we need to subtract its
      // estSolSpend from the effective requirement. Without this, the
      // SOL row stays red after auto-swaps complete (because the wallet
      // balance has gone down by ~$4 per swap) even though the launch
      // can proceed. See decrementSolRequirementForSwap() below.
      fundingRequirement.solCreditedForCompletedSwaps = 0;
      const manualCount = Object.keys(fundingRequirement.byQuote).length;
      const autoCount = (fundingRequirement.autoSwapPlan || []).length;
      const extras = [];
      if (autoCount) extras.push(`${autoCount} auto-swap`);
      if (manualCount) extras.push(`${manualCount} manual`);
      log(
        `Funding estimate: ${fundingRequirement.totalSol.toFixed(3)} SOL` +
        (extras.length ? ` + ${extras.join(', ')} token row${(autoCount + manualCount) === 1 ? '' : 's'}` : ''),
        'info',
      );

      const symbol = document.getElementById('tokenSymbol').value.trim() || 'token';
      const poolCount = pools.length;
      setStepSummary(2, `${symbol}, ${poolCount} pool${poolCount === 1 ? '' : 's'}`);

      renderFundingRequirements();
      activateStep(3);
      startBalancePolling();
    } catch (e) {
      log(`Funding estimation failed: ${e.message}`, 'danger');
    }
  });
});

// Back-to-configuration button on step 3 (Funding). The user has seen the
// SOL requirement and wants to adjust pool config / target mcap / etc.
// before committing funds. We just stop polling and reactivate step 2 —
// all token form values and pool state are still in memory, so the user
// picks up exactly where they left off. When they click Continue to
// Funding again, the estimate is recomputed (with their changes) and
// step 3 re-enters fresh.
//
// Funding deposits that may have already arrived in the wallet are NOT
// touched here — they're refundable through Cancel & Refund if the user
// decides to abandon the launch entirely. For a normal "re-estimate after
// edit" flow, leaving them in place is fine; they count toward the new
// estimate when the user comes back to step 3.
bind('backToConfigBtn', 'click', () => {
  // Don't allow navigation while an operation is running (e.g., an
  // auto-swap is mid-flight). The cancel button has the same guard via
  // updateCancelButtonState; mirror that here so the user can't yank
  // the rug out from under a running operation. Reuses the activity log
  // for user-facing feedback rather than a modal — operations are
  // typically short and the user will get a chance again soon.
  if (isRunningOperation) {
    log('Wait for the running operation to finish before editing the configuration.', 'warning');
    return;
  }
  if (balancePollHandle) {
    clearInterval(balancePollHandle);
    balancePollHandle = null;
  }
  // Clear step 3's summary so it doesn't read "ready" or similar when the
  // user collapses it to look at step 2.
  setStepSummary(3, '');
  // Also clear step 2's summary — the user is about to re-edit, and the
  // old "TOKEN, N pools" line would be misleading mid-edit. activateStep
  // will reset visual states; the summary needs an explicit clear.
  setStepSummary(2, '');
  log('Returned to configuration. Edit and click Continue to Funding when ready.', 'info');
  activateStep(2);
});

// Copy-wallet-address button on the funding step. The address is the
// destination for the user's manual SOL transfer; QR scanning works
// for mobile wallets but desktop wallet users typically copy-paste.
// Uses navigator.clipboard.writeText with a 1.4s visual confirmation
// (checkmark icon swap + 'Copied!' label) so the user knows it worked
// without needing a separate toast. Falls back gracefully if the
// clipboard API is unavailable (logs to activity log instead).
bind('step3WalletAddrCopyBtn', 'click', async () => {
  // Read from tempWallet rather than from the DOM textContent, since
  // the DOM string is what's displayed (potentially wrapped, with no
  // formatting differences here, but it's still cleaner to copy the
  // source of truth). tempWallet is populated by step 1's generate-
  // wallet flow and remains valid throughout the launch.
  if (!tempWallet || !tempWallet.publicKey) {
    log('No wallet address available to copy', 'warning');
    return;
  }
  const btn = document.getElementById('step3WalletAddrCopyBtn');
  const icon = btn && btn.querySelector('i');
  try {
    await navigator.clipboard.writeText(tempWallet.publicKey);
    log('Wallet address copied to clipboard', 'info');
    // Visual confirmation: swap the copy icon for a check, change the
    // button color to the "ok" tone, and revert after 1.4s. Mirrors
    // the .copy-btn.copied pattern used in the recovery-flow report.
    if (icon) {
      icon.classList.remove('fa-copy');
      icon.classList.add('fa-check');
    }
    if (btn) btn.classList.add('is-success');
    setTimeout(() => {
      if (icon) {
        icon.classList.remove('fa-check');
        icon.classList.add('fa-copy');
      }
      if (btn) btn.classList.remove('is-success');
    }, 1400);
  } catch (e) {
    log(`Couldn't copy address (${e.message})`, 'warning');
  }
});

// Reset all token/pool state to defaults so the user can start a fresh
// launch. The wallet (tempWallet) is intentionally preserved — that's the
// whole point of "start over with the same wallet." Everything else gets
// wiped: form values, pool config, simpleConfig, created-token info,
// funding state, step summaries, the cancelled-panel itself, and all the
// downstream-step DOM panels that may carry stale display data.
//
// Called by the Start Over affordance on the step-6 cancelled panel.
// Safe to call from a clean cancelled state (wallet empty / refunded);
// not intended for use mid-launch.
//
// Mirrors the per-launch state reset that happens in the generate-wallet
// handler — we want "Start Over with same wallet" to leave the UI in
// the same state as "Generate Wallet" minus the wallet itself.
function resetForNewLaunch() {
  // 1. Defensive: stop any background polling that might still be alive.
  //    The cancel paths normally clear this before showing the cancelled
  //    panel, but a future code path could land here without going
  //    through cancel; better to be idempotent.
  if (balancePollHandle) {
    clearInterval(balancePollHandle);
    balancePollHandle = null;
  }

  // 2. Wipe in-memory launch state.
  createdTokenInfo = null;
  lpResult = null;
  lastAirdropResult = null;
  restoredAirdropPayload = null;
  if (typeof _resetCachedReport === 'function') _resetCachedReport();
  fundingRequirement = { solLamports: 0, byQuote: {}, autoSwapPlan: [] };
  fundingWallet = null;
  lastSolBalance = 0;
  consecutivePollFailures = 0;
  fundingDetectionExhausted = false;
  // Auto-swap interlock — defensive reset. Cancel completion runs under
  // withRunState which would have failed if an auto-swap was mid-flight,
  // so reaching here with this flag set shouldn't be possible. Resetting
  // unconditionally keeps the state machine clean if a future code path
  // arrives here through a different route.
  isAcquireFlowRunning = false;

  // 3. Reset simpleConfig to its initial defaults so the simple-UI shows
  //    the "fresh launch" state. Mirror of the let-initializer at file top.
  //    When adding new fields to the initializer, mirror them here too —
  //    otherwise a Start Over will carry over stale values from the
  //    previous launch and the user gets a "fresh" form that isn't fresh.
  simpleConfig = {
    mode: 'default',
    flywheelEnabled: true,
    flywheelKey: 'meme',
    flywheelPercent: DEFAULT_FLYWHEEL_PERCENT,
    splitEnabled: false,
    splitCount: 1,
    bootstrapMode: 'minimal',
    bootstrapSolValue: 1,
    ladderEnabled: false,
    ladderPercent: LADDER_DEFAULT_PERCENT,
    ladderBandCount: LADDER_DEFAULT_BANDS,
    ladderStrategy: LADDER_DEFAULT_STRATEGY,
    // Preallocation defaults — disabled by default, 1% if the user
    // enables it. Auto-fit defaults on so the airdrop CSV automatically
    // raises the floor as needed. Both effective and typed values seed
    // to 1 so a fresh enable shows 1% in the input.
    preallocationEnabled: false,
    preallocationPercent: 1,
    preallocationPercentInput: 1,
    preallocationAutoFit: true,
    // Support position defaults — disabled by default. Auto-back ties
    // the SOL value to whatever fully backs the preallocation; on by
    // default so the natural "preallocation + backing" pairing is the
    // path of least resistance when the user enables both.
    supportEnabled: false,
    supportSolValue: 1,
    supportDepthPct: 10,
    supportAutoSize: true,
    // UI-only: advanced section collapsed by default so Start Over
    // produces the same minimal landing view as a fresh page load.
    _advancedExpanded: false,
    // Airdrop state — mirror of the top-of-file defaults. Without
    // resetting this, the next launch would carry over the previous
    // launch's csvText and parsed rows, which is wrong (each launch
    // has its own recipient list).
    airdrop: {
      enabled: false,
      csvText: '',
      parsedRows: [],
      parseError: null,
      budgetError: null,
      _expanded: false,
      _breakdownExpanded: false,
    },
  };

  // 4. Reset token form inputs back to their HTML defaults. These hold
  //    whatever the user typed last time; leaving them prefilled with
  //    that data would imply "we'll use this again" when in fact the
  //    user explicitly chose to start over.
  //
  //    We read each input's `defaultValue` rather than hardcoding the
  //    values here. defaultValue is the string from the HTML `value="..."`
  //    attribute — empty for inputs that don't declare one (tokenName,
  //    tokenSymbol, tokenDescription), and the displayed default for the
  //    two that do (tokenSupply = "1,000,000,000", targetMarketCap =
  //    "100,000"). This keeps the reset behaviour in sync with the HTML
  //    automatically: if those defaults are ever changed in index.html,
  //    the reset still does the right thing without needing to update
  //    this list.
  //
  //    Prior version blindly cleared targetMarketCap to '' alongside the
  //    text fields, which produced an empty market-cap field after Start
  //    Over even though a fresh app open shows "100,000" — the bug Moose
  //    flagged. The supply fix is a related tidy-up: prior code set it
  //    to '1000000000' (no commas), which display-mismatches the HTML
  //    default of '1,000,000,000'; the numeric value is identical after
  //    parseNumberInput strips commas, but visually they differ.
  const formIds = [
    'tokenName',
    'tokenSymbol',
    'tokenSupply',
    'targetMarketCap',
    'tokenDescription',
  ];
  for (const id of formIds) {
    const el = document.getElementById(id);
    if (el) el.value = el.defaultValue;
  }
  // Logo: clear both the file input and any preview thumbnail.
  // File inputs always have an empty defaultValue, so we set value=''
  // explicitly to make the intent obvious at the call site rather than
  // relying on the defaultValue happening to be empty.
  const logoEl = document.getElementById('tokenLogo');
  if (logoEl) logoEl.value = '';
  if (_tokenPreviewLogoObjectUrl) {
    URL.revokeObjectURL(_tokenPreviewLogoObjectUrl);
    _tokenPreviewLogoObjectUrl = null;
  }
  // Tear down the 3D coin's WebGL context. renderTokenPreview() will
  // re-init it lazily if the user returns to the create-token screen.
  destroyCoinPreview();
  // Reset the overall launch-progress flag so the preview card's bar starts
  // fresh for the new launch (it repaints when the card next renders).
  _launchTransferComplete = false;
  if (typeof updateLaunchProgress === 'function') updateLaunchProgress();
  const logoThumb = document.getElementById('tokenLogoThumb');
  if (logoThumb) logoThumb.classList.add('hidden');
  // Clear any stale logo validation error from a previous launch. The
  // setLogoError helper handles the hidden-class toggle so the help
  // text doesn't reserve vertical space when there's no message.
  setLogoError(null);

  // 5. Wipe pools and rebuild from the (now reset) simpleConfig defaults.
  //    rebuildPoolsFromSimple wipes pools.length=0 and re-adds the default
  //    SOL+flywheel pool split.
  pools.length = 0;
  rebuildPoolsFromSimple();
  // applySimpleConfigMode flips the visible config panel (simple vs
  // customize) based on simpleConfig.mode and re-runs the appropriate
  // renderer. We need this in case the user was in customize mode before
  // — without it the customize panel would still be visible while
  // simpleConfig says we're in default mode.
  applySimpleConfigMode();

  // 6. Reset step-2-through-6 DOM panels that may carry display state from
  //    the previous attempt. Mirror what the generate-wallet handler does
  //    so Start Over leaves the UI in the same shape as Generate Wallet.
  document.getElementById('tokenCreatedInfo')?.classList.add('hidden');
  document.getElementById('createTokenBtn')?.classList.remove('hidden');
  document.getElementById('createLpBtn')?.classList.remove('hidden');
  document.getElementById('transferAssetsBtn')?.classList.remove('hidden');
  setLpDoneVisible(false);
  document.getElementById('lpFailInfo')?.classList.add('hidden');
  document.getElementById('lpProgress')?.classList.add('hidden');
  const lpTree = document.getElementById('lpProgressTree');
  if (lpTree) lpTree.innerHTML = '';
  document.getElementById('transferResult')?.classList.add('hidden');
  document.getElementById('fundingWalletInfo')?.classList.add('hidden');
  const destWalletEl = document.getElementById('destinationWallet');
  if (destWalletEl) destWalletEl.value = '';
  // Re-hide the "View launch summary" button — runTransfer's success
  // branch reveals it, so a Start Over after a complete launch would
  // leave it visible on the fresh attempt's empty step 6 otherwise.
  document.getElementById('viewLaunchSummaryBtn')?.classList.add('hidden');
  // Defensive close of the launch-success modal. The modal is normally
  // open only after a successful step-6 transfer (after which Start
  // Over isn't typically reachable since step 6 is the terminal step),
  // but a future flow could open Start Over while the modal is up and
  // we'd want to clean up its WebGL coin context regardless. Safe to
  // call when the modal is already closed.
  if (typeof hideLaunchSuccessModal === 'function') hideLaunchSuccessModal();
  // Step 6 cancelled panel: restore normal body, hide cancelled.
  document.getElementById('step6NormalBody')?.classList.remove('hidden');
  document.getElementById('step6CancelledPanel')?.classList.add('hidden');

  // 7. Clear step summaries for steps 2-6. Step 1 stays — its summary
  //    shows the wallet abbreviation, which is still accurate.
  for (let i = 2; i <= 6; i++) setStepSummary(i, '');

  // 8. Re-render the live token preview card (now empty since form is
  //    cleared) and recompute the continue-button enabled state.
  renderTokenPreview();
  updateContinueToFundingState();
  updateCancelButtonState();

  // 9. Hand control back to step 2 and log a clear separator so the
  //    activity log makes the boundary obvious.
  log('— Started over. Configure your token and pools, then continue. —', 'info');
  activateStep(2);
}

bind('startOverBtn', 'click', resetForNewLaunch);
