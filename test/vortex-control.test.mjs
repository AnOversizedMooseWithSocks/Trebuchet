// Pure geometry and share math for the 3D vortex control. The module is a
// classic browser script, so it is loaded in a VM sandbox the way the repo
// tests public/v2/api-client.js.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(path.join(REPO, 'public', 'v2', 'vortex.js'), 'utf8');

function loadVortex() {
  const sandbox = { Math, Number, String, Array, Object, JSON, Infinity };
  sandbox.window = sandbox;
  vm.runInNewContext(source, sandbox, { filename: 'vortex.js' });
  return sandbox.TrebuchetV2Vortex;
}

function pools(solPercent = 70, corePercent = 30) {
  return [
    { id: 'sol', symbol: 'SOL', percent: solPercent, minPercent: 10, feeTier: 8 },
    { id: 'quote', symbol: 'FLY', percent: corePercent, minPercent: 10, maxPercent: 30, feeTier: 5 },
  ];
}

test('bands stack down a funnel: wide mouth first, narrow throat last', () => {
  const vortex = loadVortex();
  const bands = vortex.layoutBands(pools());
  assert.equal(bands.length, 2);
  assert.equal(bands[0].symbol, 'SOL');
  assert.equal(bands[1].symbol, 'FLY');

  // The mouth is above the throat and wider than it.
  assert.ok(bands[0].yTop < bands[1].yTop);
  assert.ok(bands[0].rTop > bands[1].rBottom);
  // Radii shrink monotonically toward the throat.
  assert.ok(bands[0].rTop > bands[0].rBottom);
  assert.ok(bands[0].rBottom >= bands[1].rBottom);
  // Bands tile the funnel without gaps.
  assert.equal(bands[0].yBottom, bands[1].yTop);
  assert.equal(bands[1].yBottom, vortex.constants.Y_BOTTOM);
});

test('the wider market occupies the taller span', () => {
  const vortex = loadVortex();
  const [sol, core] = vortex.layoutBands(pools(70, 30));
  assert.ok((sol.yBottom - sol.yTop) > (core.yBottom - core.yTop));
});

test('a zero-share pool still gets a visible, grabbable ring', () => {
  const vortex = loadVortex();
  const bands = vortex.layoutBands(pools(100, 0));
  assert.equal(bands.length, 2, 'the 0% core is still rendered');
  assert.ok(bands[1].yBottom - bands[1].yTop > 4, 'it has visual thickness');
  assert.ok(bands[1].rTop > 0);
});

test('dragging a ring down grows the mouth and shrinks the throat', () => {
  const vortex = loadVortex();
  const model = pools();
  // The boundary currently sits at t=0.7 (SOL holds 70%).
  assert.ok(Math.abs(vortex.boundaryDeltaForUpper(model, 0, 0.7)) < 0.05, 'the current boundary needs no change');

  // Dragging it down to t=0.9 must hand 20 points to SOL.
  const down = vortex.boundaryDeltaForUpper(model, 0, 0.9);
  assert.equal(Math.round(down), 20);
  const opened = vortex.transferShare(model, 0, down);
  assert.equal(opened[0].percent, 90);
  assert.equal(opened[1].percent, 10);

  // Dragging up is clamped by the core's 30% ceiling.
  const up = vortex.boundaryDeltaForUpper(model, 0, 0.5);
  assert.equal(Math.round(up), -20);
  const clamped = vortex.transferShare(model, 0, up);
  assert.equal(clamped[1].percent, 30);
  assert.equal(clamped[0].percent, 70);
});

test('share moves between neighbours and the total is preserved', () => {
  const vortex = loadVortex();
  const model = pools();
  const total = (list) => list.reduce((sum, pool) => sum + pool.percent, 0);
  const nudged = vortex.transferShare(model, 0, 5);
  assert.equal(nudged[0].percent, 75);
  assert.equal(nudged[1].percent, 25);
  assert.equal(total(nudged), total(model));

  const floored = vortex.transferShare(model, 0, 100);
  assert.equal(floored[1].percent, 10, 'the core cannot go below its floor');
  assert.equal(floored[0].percent, 90);
});

test('funnel paths close and trace elliptical rims', () => {
  const vortex = loadVortex();
  const [band] = vortex.layoutBands(pools());
  const path = vortex.funnelPath(band);
  assert.match(path, /^M /);
  assert.match(path, /A /, 'uses elliptical arcs for the rims');
  assert.match(path, /Z$/);
  assert.match(vortex.helixPath(), /^M /, 'the helix is a path');
});

test('fee tiers map to spin speed and colour', () => {
  const vortex = loadVortex();
  assert.ok(vortex.spinForFeeTier(3).speed > vortex.spinForFeeTier(8).speed);
  assert.match(vortex.spinForFeeTier(3).color, /^#/);
  assert.match(vortex.spinForFeeTier(undefined).color, /^#/);
});

test('mount renders the funnel, bands and draggable boundaries', () => {
  const vortex = loadVortex();
  const host = { innerHTML: '', querySelector: () => null, querySelectorAll: () => [] };
  const control = vortex.mount(host, {
    read: () => ({
      pools: [
        { id: 'sol', symbol: 'SOL', percent: 70, minPercent: 10, feeTier: 8 },
        { id: 'quote', symbol: 'FLY', percent: 30, minPercent: 10, maxPercent: 30, feeTier: 5 },
      ],
      depositSol: 1.287,
    }),
  });
  assert.ok(control && typeof control.render === 'function');
  assert.match(host.innerHTML, /Flywheel vortex/);
  assert.match(host.innerHTML, /FLY core at 30%/);
  assert.match(host.innerHTML, /SOL 70%/);
  assert.match(host.innerHTML, /1\.287 SOL/);
  assert.match(host.innerHTML, /vortex-slice/);
  assert.match(host.innerHTML, /vortex-rim/);
  assert.match(host.innerHTML, /vortex-helix/);
  assert.match(host.innerHTML, /vortex-boundary/);
  assert.match(host.innerHTML, /role="slider"/);
});

// --- multi-token (ring) coverage -----------------------------------------

function ringPools() {
  return [
    { id: 'sol', symbol: 'SOL', mint: 'So11111111111111111111111111111111111111112', percent: 70, minPercent: 10, feeTier: 8 },
    { id: 'custom-0', symbol: 'MEME2', mint: '2vGfseKJFt6iakqFrWoeDdSz8dweWYk5xPXV9uvVXRAT', percent: 10, feeTier: 5 },
    { id: 'custom-1', symbol: 'MEME3', mint: 'FLFLJp1XTPrY7iLoKXZ9ZVZHGfxZMQMdPZtZCxfjHtsm', percent: 10, feeTier: 5 },
    { id: 'quote', symbol: 'FLY', mint: 'FLY3ytMF4wyGQcVPo2RZ5FTFsf7JEBj4DrtucnRqrFLY', percent: 10, minPercent: 10, maxPercent: 30, feeTier: 5 },
  ];
}

test('ring sectors tile a full turn in proportion to share', () => {
  const vortex = loadVortex();
  const ring = vortex.layoutRing(ringPools());
  assert.equal(ring.length, 4);
  const totalSweep = ring.reduce((sum, segment) => sum + segment.sweep, 0);
  assert.ok(Math.abs(totalSweep - 360) < 0.01, 'sectors cover the whole ring');
  // Consecutive sectors share a boundary (no gaps, no overlap).
  for (let i = 1; i < ring.length; i += 1) {
    assert.ok(Math.abs(ring[i].angleStart - ring[i - 1].angleEnd) < 1e-9);
  }
  // The largest holder gets the widest arc.
  const sol = ring.find((segment) => segment.symbol === 'SOL');
  const meme = ring.find((segment) => segment.symbol === 'MEME2');
  assert.ok(sol.sweep > meme.sweep);
});

test('a zero-share token still gets a visible arc', () => {
  const vortex = loadVortex();
  const ring = vortex.layoutRing([
    { id: 'sol', symbol: 'SOL', percent: 100, feeTier: 8 },
    { id: 'a', symbol: 'A', percent: 0, feeTier: 5 },
    { id: 'b', symbol: 'B', percent: 0, feeTier: 5 },
  ]);
  assert.equal(ring.length, 3);
  for (const segment of ring) assert.ok(segment.sweep > 5, 'every token has an arc');
  assert.ok(Math.abs(ring.reduce((sum, s) => sum + s.sweep, 0) - 360) < 0.01);
});

test('dragging a ring boundary moves supply between neighbours', () => {
  const vortex = loadVortex();
  const pools = ringPools();

  // Boundary 0 sits where SOL ends: t = 0.7 of the turn.
  const atCurrent = vortex.ringBoundaryDeltaForUpper(pools, 0, -90 + 0.7 * 360);
  assert.ok(Math.abs(atCurrent) < 0.05, 'the current boundary needs no change');

  // Rotating it clockwise (further along the turn) grows the band before it:
  // SOL takes the share the next memecoin gives up.
  const forward = vortex.ringBoundaryDeltaForUpper(pools, 0, -90 + 0.8 * 360);
  assert.ok(forward > 0, 'clockwise grows the preceding band');
  const grown = vortex.transferShare(pools, 0, forward);
  assert.equal(grown[0].percent, 80);
  assert.equal(grown[1].percent, 0);

  // Rotating it anti-clockwise hands SOL's share to the next memecoin.
  const backward = vortex.ringBoundaryDeltaForUpper(pools, 0, -90 + 0.6 * 360);
  assert.ok(backward < 0, 'anti-clockwise shrinks the preceding band');
  const given = vortex.transferShare(pools, 0, backward);
  assert.equal(given[0].percent, 60);
  assert.equal(given[1].percent, 20);
});

test('four-token ring renders sectors, hub, cascade and boundaries', () => {
  const vortex = loadVortex();
  const host = { innerHTML: '', querySelector: () => null, querySelectorAll: () => [] };
  vortex.mount(host, { read: () => ({ pools: ringPools(), depositSol: 1.287 }) });
  assert.match(host.innerHTML, /vortex-sector/);
  assert.match(host.innerHTML, /vortex-hub/);
  assert.match(host.innerHTML, /vortex-cascade/);
  assert.match(host.innerHTML, /vortex-circulation/);
  assert.match(host.innerHTML, /MEME2 10%/);
  assert.match(host.innerHTML, /2vGf|2vGfseKJ/ , 'the mint is labelled');
  assert.equal((host.innerHTML.match(/vortex-boundary/g) || []).length, 3, 'three draggable boundaries');
  assert.match(host.innerHTML, /vortex-mode/, 'the funnel/ring switch is offered');
  assert.match(host.innerHTML, /Tokens<\/small><strong>4/);
});

// --- spin / balance coverage ---------------------------------------------

test('balancing evens the memecoins and leaves the inflow alone', () => {
  const vortex = loadVortex();
  const pools = [
    { id: 'sol', symbol: 'SOL', percent: 70, minPercent: 10 },
    { id: 'a', symbol: 'MEME2', percent: 4.8, minPercent: 0 },
    { id: 'b', symbol: 'MEME3', percent: 15.2, minPercent: 0 },
    { id: 'quote', symbol: 'FLY', percent: 10, minPercent: 10, maxPercent: 30 },
  ];
  const balanced = vortex.balancedTargets(pools, { fixedIndex: 0 });
  assert.equal(balanced[0].percent, 70, 'the SOL inflow is fixed');
  assert.equal(balanced[1].percent, 10);
  assert.equal(balanced[2].percent, 10);
  assert.equal(balanced[3].percent, 10);
  // The total is preserved.
  assert.ok(Math.abs(balanced.reduce((sum, p) => sum + p.percent, 0) - 100) < 0.05);
});

test('balancing respects floors and ceilings by water-filling', () => {
  const vortex = loadVortex();
  const pools = [
    { id: 'sol', symbol: 'SOL', percent: 40, minPercent: 10 },
    { id: 'quote', symbol: 'FLY', percent: 50, minPercent: 10, maxPercent: 20 },
    { id: 'a', symbol: 'MEME2', percent: 5, minPercent: 0 },
    { id: 'b', symbol: 'MEME3', percent: 5, minPercent: 0 },
  ];
  const balanced = vortex.balancedTargets(pools, { fixedIndex: 0 });
  const quote = balanced.find((p) => p.id === 'quote');
  assert.equal(quote.percent, 20, 'the capped pool pins at its ceiling');
  // Whatever is left is shared evenly by the two uncapped pools.
  const others = balanced.filter((p) => ['a', 'b'].includes(p.id));
  assert.equal(others[0].percent, others[1].percent);
  assert.ok(Math.abs(balanced.reduce((sum, p) => sum + p.percent, 0) - 100) < 0.05);
});

test('the spin interpolates from the current split to the target', () => {
  const vortex = loadVortex();
  const from = [
    { id: 'sol', symbol: 'SOL', percent: 70 },
    { id: 'a', symbol: 'MEME2', percent: 0 },
    { id: 'b', symbol: 'MEME3', percent: 30 },
  ];
  const to = vortex.balancedTargets(from, { fixedIndex: 0 });
  const start = vortex.interpolateShares(from, to, 0);
  const middle = vortex.interpolateShares(from, to, 0.5);
  const end = vortex.interpolateShares(from, to, 1);
  assert.deepEqual(start.map((p) => p.percent), from.map((p) => p.percent));
  assert.equal(middle[1].percent, 7.5);
  assert.equal(middle[2].percent, 22.5);
  assert.deepEqual(end.map((p) => p.percent), to.map((p) => p.percent));
});

test('the ring offers the balance control and counter-rotating flow', () => {
  const vortex = loadVortex();
  const host = { innerHTML: '', querySelector: () => null, querySelectorAll: () => [] };
  vortex.mount(host, { read: () => ({ pools: ringPools(), depositSol: 1 }) });
  assert.match(host.innerHTML, /data-vortex-balance/);
  assert.match(host.innerHTML, /vortex-swirl/);
  assert.match(host.innerHTML, /class="vortex-swirl is-reverse"/, 'adjacent sectors counter-rotate');
});

test('balancing fixes SOL by identity and normalises an oversubscribed split', () => {
  const vortex = loadVortex();
  // Ring order: memecoins first, SOL third — index 0 is NOT the inflow.
  const pools = [
    { id: 'a', symbol: 'MEME2', percent: 10, minPercent: 0 },
    { id: 'b', symbol: 'MEME3', percent: 10, minPercent: 0 },
    { id: 'sol', symbol: 'SOL', percent: 90, minPercent: 10 },
    { id: 'quote', symbol: 'FLY', percent: 10, minPercent: 10, maxPercent: 30 },
  ];
  const balanced = vortex.balancedTargets(pools, { fixedId: 'sol' });
  const sol = balanced.find((p) => p.id === 'sol');
  assert.equal(sol.percent, 90, 'SOL is fixed wherever it sits in the order');
  const total = balanced.reduce((sum, p) => sum + p.percent, 0);
  assert.ok(Math.abs(total - 100) < 0.05, `total normalises to 100 (got ${total})`);
  // The capped flywheel pool pins at its floor and nothing overflows.
  assert.equal(balanced.find((p) => p.id === 'quote').percent, 10);

  // A normal split still evens out.
  const even = vortex.balancedTargets([
    { id: 'a', symbol: 'MEME2', percent: 4.8, minPercent: 0 },
    { id: 'b', symbol: 'MEME3', percent: 15.2, minPercent: 0 },
    { id: 'sol', symbol: 'SOL', percent: 70, minPercent: 10 },
    { id: 'quote', symbol: 'FLY', percent: 10, minPercent: 10, maxPercent: 30 },
  ], { fixedId: 'sol' });
  assert.equal(even.find((p) => p.id === 'a').percent, 10);
  assert.equal(even.find((p) => p.id === 'b').percent, 10);
  assert.equal(even.find((p) => p.id === 'quote').percent, 10);
  assert.equal(even.reduce((sum, p) => sum + p.percent, 0), 100);
});
