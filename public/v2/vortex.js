// Vortex allocation control.
//
// Informed by the Navier-Stokes result: a vortex that spirals inward and
// stretches along its axis while its core shrinks, speeds up, and keeps total
// energy finite. The control is that vortex, in two topologies:
//
//   FUNNEL (2 bands)          RING (3+ bands)
//   wide mouth = SOL inflow   quote memecoins on one annulus,
//   rings      = quote pools  arranged in circulation order,
//   throat     = flywheel     the launched token as the hub,
//   sink       = sweep        arrows = the cascade into the core
//
// Shared meaning:
//   band span / arc   -> share of supply
//   colour / spin     -> fee tier (orange fast, teal slow)
//   the hub / throat  -> the launched token (the sink for captured fees)
//   constant deposit  -> energy stays finite while you drag
//
// The ring is the interesting case: with four tokens the allocation is a real
// simplex (three boundaries), adjacent pairs can counter-rotate, and supply
// cascades ring -> hub the way a stretched vortex feeds its core.
//
// Rendering is a plain SVG projection (isometric funnel, or annular sectors)
// with no CSS 3D transform, so the pointer maps straight into viewBox
// coordinates and dragging stays exact.
//
// Loaded as a classic script; exposes window.TrebuchetV2Vortex. Pure geometry
// and share math are exercised by test/vortex-control.test.mjs in a VM sandbox.

(function initVortexControl(global) {
  'use strict';

  const TAU = Math.PI * 2;
  const DEG = Math.PI / 180;
  const VIEW = 360;
  const AXIS_X = VIEW / 2;
  const AXIS_Y = VIEW / 2;
  const Y_TOP = 58;
  const Y_BOTTOM = 322;
  const R_TOP = 118;
  const R_BOTTOM = 30;
  const PERSPECTIVE = 0.38;
  const MIN_VISUAL_SPAN = 0.045;
  const RING_INNER = 62;
  const RING_OUTER = 132;
  const MIN_ARC_DEG = 14; // a 0% memecoin still needs a grabbable arc

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const roundPercent = (value) => Math.round(value * 10) / 10;

  const yForT = (t) => Y_TOP + clamp(t, 0, 1) * (Y_BOTTOM - Y_TOP);
  const tForY = (y) => clamp((y - Y_TOP) / (Y_BOTTOM - Y_TOP), 0, 1);
  const radiusForT = (t) => R_TOP + (R_BOTTOM - R_TOP) * clamp(t, 0, 1);
  const tForRingAngle = (deg) => ((((deg + 90) % 360) + 360) % 360) / 360;

  function sharesOf(pools) {
    const usable = (Array.isArray(pools) ? pools : []).filter((pool) => pool && pool.id);
    const total = usable.reduce((sum, pool) => sum + Math.max(0, Number(pool.percent) || 0), 0);
    return usable.map((pool) => (
      total > 0 ? Math.max(0, Number(pool.percent) || 0) / total : 0
    ));
  }

  /**
   * Concentric funnel bands, mouth first. Zero-share bands keep a minimum
   * visual span so there is always a boundary to grab.
   */
  function layoutBands(pools = []) {
    const usable = (Array.isArray(pools) ? pools : []).filter((pool) => pool && pool.id);
    const shares = sharesOf(usable);
    const visual = shares.map((share) => Math.max(share, MIN_VISUAL_SPAN));
    const visualTotal = visual.reduce((sum, value) => sum + value, 0) || 1;

    let t = 0;
    return usable.map((pool, index) => {
      const span = visual[index] / visualTotal;
      const tTop = t;
      const tBottom = index === usable.length - 1 ? 1 : Math.min(1, t + span);
      t = tBottom;
      return {
        ...pool,
        share: shares[index],
        tTop,
        tBottom,
        yTop: yForT(tTop),
        yBottom: yForT(tBottom),
        rTop: radiusForT(tTop),
        rBottom: radiusForT(tBottom),
        midY: (yForT(tTop) + yForT(tBottom)) / 2,
        midRadius: (radiusForT(tTop) + radiusForT(tBottom)) / 2,
      };
    });
  }

  /**
   * Annular sectors around the hub, in circulation order. Sectors always sum
   * to a full turn; minimum arcs are normalised away so a 0% memecoin is
   * visible without distorting the ring.
   */
  function layoutRing(pools = []) {
    const usable = (Array.isArray(pools) ? pools : []).filter((pool) => pool && pool.id);
    const shares = sharesOf(usable);
    const raw = shares.map((share) => Math.max(share * 360, MIN_ARC_DEG));
    const rawTotal = raw.reduce((sum, value) => sum + value, 0) || 360;

    let angle = -90;
    return usable.map((pool, index) => {
      const sweep = (raw[index] / rawTotal) * 360;
      const angleStart = angle;
      const angleEnd = angle + sweep;
      angle = angleEnd;
      const mid = (angleStart + angleEnd) / 2;
      return {
        ...pool,
        share: shares[index],
        angleStart,
        angleEnd,
        sweep,
        midAngle: mid,
        labelX: AXIS_X + ((RING_INNER + RING_OUTER) / 2) * Math.cos(mid * DEG),
        labelY: AXIS_Y + ((RING_INNER + RING_OUTER) / 2) * Math.sin(mid * DEG),
      };
    });
  }

  /**
   * Move `delta` points of share across the boundary between band `index` and
   * `index + 1`. Positive grows the upper/earlier band.
   */
  function transferShare(pools, index, delta) {
    const next = (Array.isArray(pools) ? pools : []).map((pool) => ({ ...pool, percent: Number(pool.percent) }));
    const upper = next[index];
    const lower = next[index + 1];
    if (!upper || !lower) return next;
    const upperMin = Number.isFinite(upper.minPercent) ? upper.minPercent : 0;
    const lowerMin = Number.isFinite(lower.minPercent) ? lower.minPercent : 0;
    const upperMax = Number.isFinite(upper.maxPercent) ? upper.maxPercent : Infinity;
    const lowerMax = Number.isFinite(lower.maxPercent) ? lower.maxPercent : Infinity;

    const maxGrow = Math.min(upperMax - upper.percent, lower.percent - lowerMin);
    const maxShrink = Math.min(upper.percent - upperMin, lowerMax - lower.percent);
    const applied = delta >= 0
      ? Math.min(delta, Math.max(0, maxGrow))
      : Math.max(delta, -Math.max(0, maxShrink));
    upper.percent = roundPercent(upper.percent + applied);
    lower.percent = roundPercent(lower.percent - applied);
    return next;
  }

  /**
   * How much the bands before `index` must gain for the boundary to sit at `t`
   * (0 = start of the order, 1 = end). Sign matches transferShare.
   */
  function boundaryDeltaForUpper(pools, index, t) {
    const bands = layoutBands(pools);
    const below = bands.slice(index + 1);
    if (!below.length) return 0;
    const currentInner = below.reduce((sum, band) => sum + Math.max(0, Number(band.percent) || 0), 0);
    const desiredInner = (1 - clamp(t, 0, 1)) * 100;
    return currentInner - desiredInner;
  }

  /** Same, but the boundary position comes from an angle around the ring. */
  function ringBoundaryDeltaForUpper(pools, index, deg) {
    return boundaryDeltaForUpper(pools, index, tForRingAngle(deg));
  }

  /**
   * Even out the pools around the ring, leaving `fixedIndex` (the inflow, SOL)
   * alone. Minimums and maximums are honoured by water-filling: a pool that is
   * pinned at its floor takes less, and the remainder is shared again.
   */
  function balancedTargets(pools, { fixedIndex = 0, fixedId = null } = {}) {
    const list = (Array.isArray(pools) ? pools : []).map((pool) => ({ ...pool, percent: Number(pool.percent) }));
    // Fix the inflow by identity when it is given: in the ring the memecoins
    // come first, so "index 0" is not necessarily SOL.
    const resolvedIndex = fixedId
      ? Math.max(0, list.findIndex((pool) => pool.id === fixedId))
      : fixedIndex;
    const fixed = list[resolvedIndex];
    const movable = list.filter((_, index) => index !== resolvedIndex);
    if (!movable.length || !fixed) return list;

    // Distribute the remainder around the fixed pool, so the result is a valid
    // 100% allocation even if the incoming split did not add up.
    const pool = Math.max(0, 100 - Math.max(0, Number(fixed.percent) || 0));
    let remaining = pool;
    let pending = movable.slice();
    const pinned = new Map();

    // Water-fill: repeatedly assign an equal share, pin anything outside its
    // bounds, and redistribute what is left.
    while (pending.length) {
      const share = remaining / pending.length;
      let pinnedThisPass = false;
      for (const item of pending.slice()) {
        const min = Number.isFinite(item.minPercent) ? item.minPercent : 0;
        const max = Number.isFinite(item.maxPercent) ? item.maxPercent : Infinity;
        if (share < min || share > max) {
          const value = clamp(share, min, max);
          pinned.set(item.id, roundPercent(value));
          remaining -= value;
          pending = pending.filter((candidate) => candidate.id !== item.id);
          pinnedThisPass = true;
        }
      }
      if (!pinnedThisPass) {
        for (const item of pending) pinned.set(item.id, roundPercent(share));
        pending = [];
      }
      if (remaining <= 0.0001) {
        for (const item of pending) pinned.set(item.id, roundPercent(Number.isFinite(item.minPercent) ? item.minPercent : 0));
        pending = [];
      }
    }

    return list.map((item, index) => (
      index === resolvedIndex ? { ...item, percent: roundPercent(Number(item.percent) || 0) } : { ...item, percent: pinned.get(item.id) ?? item.percent }
    ));
  }

  /** Linear interpolation between two allocations, for the spin animation. */
  function interpolateShares(from, to, progress) {
    const t = clamp(progress, 0, 1);
    return (Array.isArray(from) ? from : []).map((pool, index) => {
      const start = Number(pool.percent) || 0;
      const end = Number(to?.[index]?.percent ?? start) || 0;
      return { ...pool, percent: roundPercent(start + (end - start) * t) };
    });
  }

  function spinForFeeTier(feeTier) {
    const tier = Number(feeTier);
    if (!Number.isFinite(tier)) return { speed: 1, color: '#4fd1c5' };
    if (tier <= 3) return { speed: 1.6, color: '#f6ad55' };
    if (tier <= 5) return { speed: 1.2, color: '#ed8936' };
    return { speed: 0.9, color: '#4fd1c5' };
  }

  const polar = (cx, cy, r, deg) => [cx + r * Math.cos(deg * DEG), cy + r * Math.sin(deg * DEG)];

  function frontArc(r, y) {
    const ry = r * PERSPECTIVE;
    return `M ${(AXIS_X - r).toFixed(2)} ${y.toFixed(2)} A ${r.toFixed(2)} ${ry.toFixed(2)} 0 0 0 ${(AXIS_X + r).toFixed(2)} ${y.toFixed(2)}`;
  }

  function backArc(r, y) {
    const ry = r * PERSPECTIVE;
    return `M ${(AXIS_X - r).toFixed(2)} ${y.toFixed(2)} A ${r.toFixed(2)} ${ry.toFixed(2)} 0 0 1 ${(AXIS_X + r).toFixed(2)} ${y.toFixed(2)}`;
  }

  /** One frustum slice of the funnel. */
  function funnelPath(band) {
    const { rTop, rBottom, yTop, yBottom } = band;
    return [
      `M ${(AXIS_X - rTop).toFixed(2)} ${yTop.toFixed(2)}`,
      `A ${rTop.toFixed(2)} ${(rTop * PERSPECTIVE).toFixed(2)} 0 0 0 ${(AXIS_X + rTop).toFixed(2)} ${yTop.toFixed(2)}`,
      `L ${(AXIS_X + rBottom).toFixed(2)} ${yBottom.toFixed(2)}`,
      `A ${rBottom.toFixed(2)} ${(rBottom * PERSPECTIVE).toFixed(2)} 0 0 1 ${(AXIS_X - rBottom).toFixed(2)} ${yBottom.toFixed(2)}`,
      'Z',
    ].join(' ');
  }

  /** Open arc at a radius, used for the per-sector swirl flow. */
  function arcPath(r, angleStart, angleEnd) {
    const [x0, y0] = polar(AXIS_X, AXIS_Y, r, angleStart);
    const [x1, y1] = polar(AXIS_X, AXIS_Y, r, angleEnd);
    const large = Math.abs(angleEnd - angleStart) > 180 ? 1 : 0;
    const sweepFlag = angleEnd >= angleStart ? 1 : 0;
    return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r.toFixed(2)} ${r.toFixed(2)} 0 ${large} ${sweepFlag} ${x1.toFixed(2)} ${y1.toFixed(2)}`;
  }

  /** One annular sector of the ring. */
  function sectorPath(segment, rInner = RING_INNER, rOuter = RING_OUTER) {
    const [x0, y0] = polar(AXIS_X, AXIS_Y, rOuter, segment.angleStart);
    const [x1, y1] = polar(AXIS_X, AXIS_Y, rOuter, segment.angleEnd);
    const [x2, y2] = polar(AXIS_X, AXIS_Y, rInner, segment.angleEnd);
    const [x3, y3] = polar(AXIS_X, AXIS_Y, rInner, segment.angleStart);
    const large = segment.sweep > 180 ? 1 : 0;
    return [
      `M ${x0.toFixed(2)} ${y0.toFixed(2)}`,
      `A ${rOuter} ${rOuter} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`,
      `L ${x2.toFixed(2)} ${y2.toFixed(2)}`,
      `A ${rInner} ${rInner} 0 ${large} 0 ${x3.toFixed(2)} ${y3.toFixed(2)}`,
      'Z',
    ].join(' ');
  }

  /** The helix inside the funnel: radius shrinks toward the throat. */
  function helixPath(turns = 3.4, steps = 180) {
    const points = [];
    for (let i = 0; i <= steps; i += 1) {
      const t = i / steps;
      const r = radiusForT(t) * 0.92;
      const angle = t * turns * TAU - Math.PI / 2;
      const x = AXIS_X + r * Math.cos(angle);
      const y = yForT(t) + r * PERSPECTIVE * 0.6 * Math.sin(angle);
      points.push(`${x.toFixed(2)} ${y.toFixed(2)}`);
    }
    return `M ${points.join(' L ')}`;
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]));
  }

  function shortMint(mint) {
    const value = String(mint || '').trim();
    if (!value) return '';
    return value.length <= 12 ? value : `${value.slice(0, 4)}…${value.slice(-4)}`;
  }

  /**
   * Mount the control. `read()` returns
   *   { pools: [{ id, symbol, mint?, percent, minPercent?, maxPercent?, feeTier? }],
   *     depositSol?, sweepDestination?, symbol? }
   * and `write(pools)` receives the updated percentages.
   */
  function mount(host, { read, write } = {}) {
    if (!host || typeof read !== 'function') return null;
    let drag = null;
    let mode = null; // 'ring' | 'funnel', chosen from the band count unless pinned
    let pinnedMode = null;
    let preview = null; // transient allocation shown while the ring spins

    const poolState = () => {
      const model = read() || {};
      return Array.isArray(model.pools) ? model.pools : [];
    };

    const currentMode = () => {
      if (pinnedMode) return pinnedMode;
      if (mode) return mode;
      return poolState().length >= 3 ? 'ring' : 'funnel';
    };

    const render = () => {
      const model = read() || {};
      const pools = preview || (Array.isArray(model.pools) ? model.pools : []);
      mode = pools.length >= 3 ? 'ring' : 'funnel';
      const activeMode = currentMode();
      const bands = activeMode === 'ring' ? layoutRing(pools) : layoutBands(pools);
      const deposit = Number(model.depositSol);
      const core = pools[pools.length - 1] || null;
      const total = pools.reduce((sum, pool) => sum + Math.max(0, Number(pool.percent) || 0), 0);

      const bandMarkup = activeMode === 'ring'
        ? bands.map((segment, index) => {
          const { color } = spinForFeeTier(segment.feeTier);
          const opacity = 0.18 + Math.min(0.36, (Number(segment.percent) || 0) / 200);
          return `
            <g class="vortex-band" data-band="${index}">
              <path class="vortex-sector" d="${sectorPath(segment)}"
                    fill="${color}" fill-opacity="${opacity.toFixed(2)}"
                    stroke="${color}" stroke-opacity="0.5" stroke-width="1">
                <title>${escapeHtml(segment.symbol)} · ${segment.percent}%${segment.mint ? ` · ${escapeHtml(segment.mint)}` : ''}</title>
              </path>
              <path class="vortex-swirl ${index % 2 ? 'is-reverse' : ''}"
                    d="${arcPath((RING_INNER + RING_OUTER) / 2, segment.angleStart + 3, Math.max(segment.angleStart + 4, segment.angleEnd - 3))}"
                    fill="none" stroke="rgba(255,255,255,0.45)" stroke-width="1.3" stroke-dasharray="3 7">
                <title>${escapeHtml(segment.symbol)} circulation</title>
              </path>
              <text class="vortex-band-label" x="${segment.labelX.toFixed(2)}" y="${segment.labelY.toFixed(2)}"
                    text-anchor="middle" fill="${color}">
                ${escapeHtml(segment.symbol)} ${segment.percent}%
              </text>
              ${segment.mint ? `<text class="vortex-band-mint" x="${segment.labelX.toFixed(2)}" y="${(segment.labelY + 11).toFixed(2)}" text-anchor="middle">${escapeHtml(shortMint(segment.mint))}</text>` : ''}
            </g>`;
        }).join('')
        : bands.map((band, index) => {
          const { color } = spinForFeeTier(band.feeTier);
          const opacity = 0.16 + Math.min(0.34, (Number(band.percent) || 0) / 220);
          return `
            <g class="vortex-band" data-band="${index}">
              <path class="vortex-slice" d="${funnelPath(band)}"
                    fill="url(#vortexBand${index % 3})" fill-opacity="${opacity.toFixed(2)}"
                    stroke="${color}" stroke-opacity="0.45" stroke-width="1"></path>
              <path class="vortex-rim vortex-rim-back" d="${backArc(band.rTop, band.yTop)}"
                    fill="none" stroke="${color}" stroke-opacity="0.25" stroke-width="1"></path>
              <path class="vortex-rim vortex-rim-front" d="${frontArc(band.rBottom, band.yBottom)}"
                    fill="none" stroke="${color}" stroke-opacity="0.55" stroke-width="1.25"></path>
              <text class="vortex-band-label" x="${(AXIS_X + band.midRadius + 8).toFixed(2)}"
                    y="${band.midY.toFixed(2)}" fill="${color}">
                ${escapeHtml(band.symbol)} ${band.percent}%
              </text>
            </g>`;
        }).join('');

      // Cascade: each quote ring feeds the hub, the way a stretched vortex
      // feeds its core.
      const cascade = activeMode === 'ring'
        ? bands.slice(0, -1).map((segment) => {
          const [x1, y1] = polar(AXIS_X, AXIS_Y, RING_INNER - 2, segment.midAngle);
          const [x2, y2] = polar(AXIS_X, AXIS_Y, RING_INNER * 0.42, segment.midAngle);
          return `<path class="vortex-cascade" d="M ${x1.toFixed(2)} ${y1.toFixed(2)} L ${x2.toFixed(2)} ${y2.toFixed(2)}"
            stroke="${spinForFeeTier(segment.feeTier).color}" stroke-opacity="0.35" stroke-width="1.1"
            marker-end="url(#vortexArrow)"></path>`;
        }).join('')
        : '';

      const handles = activeMode === 'ring'
        ? bands.slice(0, -1).map((segment, index) => {
          const [x, y] = polar(AXIS_X, AXIS_Y, (RING_INNER + RING_OUTER) / 2, segment.angleEnd);
          return `
            <g class="vortex-boundary" data-boundary="${index}" role="slider" tabindex="0"
               aria-label="Adjust the boundary between ${escapeHtml(segment.symbol)} and ${escapeHtml(bands[index + 1]?.symbol || 'the core')}"
               aria-valuenow="${segment.percent}" aria-valuemin="0" aria-valuemax="100">
              <circle class="vortex-handle" cx="${x.toFixed(2)}" cy="${y.toFixed(2)}" r="8"></circle>
            </g>`;
        }).join('')
        : bands.slice(0, -1).map((band, index) => {
          const y = band.yBottom;
          const r = band.rBottom;
          return `
            <g class="vortex-boundary" data-boundary="${index}" role="slider" tabindex="0"
               aria-label="Adjust the boundary between ${escapeHtml(band.symbol)} and ${escapeHtml(bands[index + 1]?.symbol || 'the core')}"
               aria-valuenow="${band.percent}" aria-valuemin="0" aria-valuemax="100">
              <ellipse class="vortex-handle-ring" cx="${AXIS_X}" cy="${y.toFixed(2)}"
                       rx="${r.toFixed(2)}" ry="${(r * PERSPECTIVE).toFixed(2)}"></ellipse>
              <circle class="vortex-handle" cx="${AXIS_X}" cy="${(y + r * PERSPECTIVE).toFixed(2)}" r="8"></circle>
            </g>`;
        }).join('');

      const hubMarkup = activeMode === 'ring'
        ? `
          <circle class="vortex-hub" cx="${AXIS_X}" cy="${AXIS_Y}" r="${(RING_INNER * 0.42).toFixed(2)}"
                  fill="url(#vortexThroat)"></circle>
          <text class="vortex-hub-label" x="${AXIS_X}" y="${AXIS_Y - 2}" text-anchor="middle">
            ${escapeHtml(core?.symbol || 'core')}</text>
          <text class="vortex-hub-value" x="${AXIS_X}" y="${AXIS_Y + 12}" text-anchor="middle">
            ${core ? `${core.percent}%` : '—'}</text>`
        : `
          <ellipse cx="${AXIS_X}" cy="${Y_BOTTOM}" rx="${(R_BOTTOM * 0.72).toFixed(2)}"
                   ry="${(R_BOTTOM * 0.72 * PERSPECTIVE).toFixed(2)}" fill="url(#vortexThroat)"></ellipse>
          <text class="vortex-sink" x="${AXIS_X}" y="${(Y_BOTTOM + 3).toFixed(2)}" text-anchor="middle"
                fill="#1a202c" font-size="8.5">sink</text>
          <text class="vortex-inflow" x="${AXIS_X}" y="${(Y_TOP - 10).toFixed(2)}" text-anchor="middle"
                fill="rgba(255,255,255,0.55)" font-size="9">inflow</text>`;

      const circulation = activeMode === 'ring'
        ? `<circle class="vortex-circulation" cx="${AXIS_X}" cy="${AXIS_Y}"
             r="${((RING_INNER + RING_OUTER) / 2).toFixed(2)}" fill="none"
             stroke="rgba(255,255,255,0.32)" stroke-width="1" stroke-dasharray="6 10"></circle>`
        : `<path class="vortex-helix" d="${helixPath()}" fill="none"
             stroke="rgba(255,255,255,0.42)" stroke-width="1.1" stroke-dasharray="5 7"></path>`;

      host.innerHTML = `
        <div class="vortex-head">
          <span class="eyebrow">Flywheel vortex</span>
          <span class="vortex-head-actions">
            <strong>${core ? `${escapeHtml(core.symbol)} core at ${core.percent}%` : 'No pools configured'}</strong>
            <button class="pill-button vortex-mode" type="button" data-vortex-balance
                    title="Spin the ring until the memecoins hold equal shares"
                    ${pools.length < 3 ? 'disabled' : ''}>Balance</button>
            <button class="pill-button vortex-mode" type="button" data-vortex-mode="${activeMode === 'ring' ? 'funnel' : 'ring'}"
                    title="Switch between the circulation ring and the funnel">${activeMode === 'ring' ? 'Funnel' : 'Ring'}</button>
          </span>
        </div>
        <div class="vortex-stage">
          <svg class="vortex-svg" viewBox="0 0 ${VIEW} ${VIEW}" role="img"
               aria-label="Pool allocation ${activeMode}: ${pools.map((p) => `${p.symbol} ${p.percent}%`).join(', ')}">
            <defs>
              <linearGradient id="vortexBand0" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="#4fd1c5"></stop>
                <stop offset="100%" stop-color="#2c7a7b"></stop>
              </linearGradient>
              <linearGradient id="vortexBand1" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="#f6ad55"></stop>
                <stop offset="100%" stop-color="#c05621"></stop>
              </linearGradient>
              <linearGradient id="vortexBand2" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="#e2e8f0"></stop>
                <stop offset="100%" stop-color="#718096"></stop>
              </linearGradient>
              <radialGradient id="vortexThroat" cx="50%" cy="50%" r="50%">
                <stop offset="0%" stop-color="#ffffff" stop-opacity="0.95"></stop>
                <stop offset="100%" stop-color="#f6ad55" stop-opacity="0.15"></stop>
              </radialGradient>
              <marker id="vortexArrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill="rgba(255,255,255,0.55)"></path>
              </marker>
            </defs>
            ${activeMode === 'funnel' ? `<ellipse class="vortex-mouth" cx="${AXIS_X}" cy="${Y_TOP}" rx="${R_TOP}" ry="${(R_TOP * PERSPECTIVE).toFixed(2)}" fill="none" stroke="rgba(255,255,255,0.22)" stroke-width="1"></ellipse>` : ''}
            ${bandMarkup}
            ${cascade}
            ${circulation}
            ${hubMarkup}
            ${handles}
          </svg>
        </div>
        <div class="vortex-readout">
          <span><small>Deposit</small><strong>${Number.isFinite(deposit) ? `${deposit.toFixed(3)} SOL` : '—'}</strong></span>
          <span><small>Tokens</small><strong>${pools.length}</strong></span>
          <span><small>Total</small><strong>${total.toFixed(1)}%</strong></span>
        </div>
        <p class="vortex-hint">${activeMode === 'ring'
          ? 'Drag a boundary around the ring to move supply between memecoins. Arrows show the cascade into the core.'
          : 'Drag a ring down the funnel to send supply into the core. The throat spins fastest; total deposit stays finite.'}</p>
      `;
      bindPointer();
    };

    const applyDelta = (boundaryIndex, delta) => {
      if (!Number.isFinite(delta) || Math.abs(delta) < 0.05) return;
      const next = transferShare(poolState(), boundaryIndex, delta);
      if (typeof write === 'function') write(next);
      render();
    };

    // Spin the ring to an even split: the allocation animates, so the operator
    // sees the supply move between memecoins before it is committed.
    function spinToBalance() {
      const from = poolState();
      if (from.length < 3) return;
      const target = balancedTargets(from, { fixedId: 'sol', fixedIndex: 0 });
      const duration = 900;
      const now = () => (global.performance?.now ? global.performance.now() : Date.now());
      const started = now();
      const step = () => {
        const progress = clamp((now() - started) / duration, 0, 1);
        preview = interpolateShares(from, target, progress);
        render();
        if (progress < 1) {
          global.requestAnimationFrame(step);
          return;
        }
        preview = null;
        const settled = interpolateShares(from, target, 1);
        if (typeof write === 'function') write(settled);
        render();
      };
      global.requestAnimationFrame(step);
    }

    function bindPointer() {
      host.querySelector('[data-vortex-balance]')?.addEventListener('click', spinToBalance);
      const modeButton = host.querySelector('[data-vortex-mode]');
      modeButton?.addEventListener('click', () => {
        pinnedMode = modeButton.dataset.vortexMode;
        render();
      });
      if (!host.querySelector('.vortex-svg')) return;

      // The SVG is re-queried on every call: each update re-renders the
      // control and replaces the element, and measuring a detached node
      // returns a zero-size rect (which used to make the drag snap back).
      const pointFor = (event) => {
        const live = host.querySelector('.vortex-svg');
        if (!live) return null;
        const rect = live.getBoundingClientRect();
        if (!rect.width || !rect.height) return null;
        return {
          x: (event.clientX - rect.left) * (VIEW / rect.width),
          y: (event.clientY - rect.top) * (VIEW / rect.height),
        };
      };

      let frame = null;
      let pending = null;
      const flush = () => {
        frame = null;
        if (!drag || !pending) return;
        const point = pending;
        pending = null;
        const activeMode = currentMode();
        const delta = activeMode === 'ring'
          ? ringBoundaryDeltaForUpper(poolState(), drag.index, Math.atan2(point.y - AXIS_Y, point.x - AXIS_X) / DEG)
          : boundaryDeltaForUpper(poolState(), drag.index, tForY(point.y));
        if (Math.abs(delta) < 0.05) return;
        applyDelta(drag.index, delta);
      };

      const onMove = (event) => {
        if (!drag) return;
        const point = pointFor(event);
        if (!point) return;
        pending = point;
        if (frame == null) frame = global.requestAnimationFrame(flush);
      };

      const stop = () => {
        drag = null;
        pending = null;
        if (frame != null && global.cancelAnimationFrame) global.cancelAnimationFrame(frame);
        frame = null;
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', stop);
        window.removeEventListener('pointercancel', stop);
      };

      host.querySelectorAll('.vortex-boundary').forEach((handle) => {
        handle.addEventListener('pointerdown', (event) => {
          event.preventDefault();
          drag = { index: Number(handle.dataset.boundary) };
          if (handle.setPointerCapture) {
            try { handle.setPointerCapture(event.pointerId); } catch { /* ignore */ }
          }
          window.addEventListener('pointermove', onMove);
          window.addEventListener('pointerup', stop);
          window.addEventListener('pointercancel', stop);
        });
        handle.addEventListener('keydown', (event) => {
          const index = Number(handle.dataset.boundary);
          if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
            event.preventDefault();
            applyDelta(index, 1);
          } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
            event.preventDefault();
            applyDelta(index, -1);
          }
        });
      });
    }

    render();
    return {
      render: () => {
        mode = null;
        render();
      },
      get mode() { return currentMode(); },
    };
  }

  global.TrebuchetV2Vortex = {
    layoutBands,
    layoutRing,
    transferShare,
    boundaryDeltaForUpper,
    ringBoundaryDeltaForUpper,
    balancedTargets,
    interpolateShares,
    spinForFeeTier,
    funnelPath,
    sectorPath,
    helixPath,
    yForT,
    tForY,
    radiusForT,
    tForRingAngle,
    mount,
    constants: { VIEW, AXIS_X, AXIS_Y, Y_TOP, Y_BOTTOM, R_TOP, R_BOTTOM, PERSPECTIVE, RING_INNER, RING_OUTER },
  };
}(typeof window !== 'undefined' ? window : globalThis));
