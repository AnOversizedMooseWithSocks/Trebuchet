import test from 'node:test';
import assert from 'node:assert/strict';

// Tests for updateCheckBridge.js — the tiny module that lets server.js
// invoke a callback registered by main.js, used to defer the silent
// startup update-check until the renderer signals that splash and
// disclaimer are dismissed.
//
// The module holds module-level state (handler + fired flag), so each
// test needs a fresh import. Same `?case=N` pattern as the other
// state-holding modules' tests (user-prefs.test.mjs etc).

let importCounter = 0;
async function importFreshBridge() {
  return import(new URL(`../updateCheckBridge.js?case=${++importCounter}`, import.meta.url));
}

test('trigger() invokes the registered handler', async () => {
  const bridge = await importFreshBridge();
  let called = false;
  bridge.registerHandler(() => { called = true; });

  const result = bridge.trigger();
  assert.equal(called, true);
  assert.deepEqual(result, { ran: true });
});

test('trigger() is fire-once — repeat calls return already-fired', async () => {
  // This is the core guarantee. The renderer might POST to the
  // trigger endpoint more than once (page reload in dev, retry on
  // network blip, whatever). We only want the silent check to run
  // the first time per process.
  const bridge = await importFreshBridge();
  let callCount = 0;
  bridge.registerHandler(() => { callCount++; });

  const first  = bridge.trigger();
  const second = bridge.trigger();
  const third  = bridge.trigger();

  assert.equal(callCount, 1, 'handler should run exactly once');
  assert.deepEqual(first,  { ran: true });
  assert.deepEqual(second, { ran: false, reason: 'already-fired' });
  assert.deepEqual(third,  { ran: false, reason: 'already-fired' });
});

test('trigger() without a registered handler reports no-handler and does not throw', async () => {
  // In web mode (npm run web), there's no Electron and so main.js
  // never registers a handler. The server endpoint should still
  // respond cleanly to a renderer POST rather than throwing.
  const bridge = await importFreshBridge();
  const result = bridge.trigger();
  assert.deepEqual(result, { ran: false, reason: 'no-handler' });
});

test('trigger() still consumes the fire-once budget when no handler is registered', async () => {
  // If the renderer POSTs in web mode (no handler), then somehow
  // Electron gets attached partway through and registers a handler,
  // we do NOT want the next POST to fire the late-registered handler.
  // That would defeat the "once per process" guarantee.
  const bridge = await importFreshBridge();

  const first = bridge.trigger(); // no handler registered yet
  assert.deepEqual(first, { ran: false, reason: 'no-handler' });

  let called = false;
  bridge.registerHandler(() => { called = true; });

  const second = bridge.trigger();
  assert.equal(called, false, 'late-registered handler must not run after fire-once budget is spent');
  assert.deepEqual(second, { ran: false, reason: 'already-fired' });
});

test('a handler that throws does not propagate the error to the caller', async () => {
  // The server endpoint that calls trigger() runs in an Express
  // request handler — an uncaught throw there would crash the
  // request. The bridge catches handler errors so a buggy handler
  // can't bring down the response.
  const bridge = await importFreshBridge();
  bridge.registerHandler(() => {
    throw new Error('boom');
  });

  // Should not throw. The error gets reported in the result instead.
  const result = bridge.trigger();
  assert.deepEqual(result, { ran: false, reason: 'handler-threw' });
});

test('a later registerHandler replaces the previous one', async () => {
  // Tests the "last registration wins" semantic. Useful if main.js
  // ever recreates its window (e.g. macOS dock-icon re-launch) and
  // registers a new handler bound to the new window — the new one
  // should win. Not currently exercised by the codebase, but the
  // semantic is worth pinning so we don't break it accidentally.
  const bridge = await importFreshBridge();
  let firstCalled = false;
  let secondCalled = false;
  bridge.registerHandler(() => { firstCalled = true; });
  bridge.registerHandler(() => { secondCalled = true; });

  bridge.trigger();
  assert.equal(firstCalled, false);
  assert.equal(secondCalled, true);
});

test('triggerManual invokes the manual handler without consuming startup fire-once', async () => {
  const bridge = await importFreshBridge();
  let startupCount = 0;
  let manualCount = 0;
  bridge.registerHandler(() => { startupCount++; });
  bridge.registerManualHandler(() => { manualCount++; });

  const manual = bridge.triggerManual();
  const startup = bridge.trigger();

  assert.deepEqual(manual, { ran: true });
  assert.deepEqual(startup, { ran: true });
  assert.equal(manualCount, 1);
  assert.equal(startupCount, 1);
});

test('triggerManual can run repeatedly for explicit user checks', async () => {
  const bridge = await importFreshBridge();
  let manualCount = 0;
  bridge.registerManualHandler(() => { manualCount++; });

  assert.deepEqual(bridge.triggerManual(), { ran: true });
  assert.deepEqual(bridge.triggerManual(), { ran: true });

  assert.equal(manualCount, 2);
});

test('triggerManual reports no-handler and catches handler errors', async () => {
  const bridge = await importFreshBridge();

  assert.deepEqual(bridge.triggerManual(), { ran: false, reason: 'no-handler' });

  bridge.registerManualHandler(() => {
    throw new Error('boom');
  });
  assert.deepEqual(bridge.triggerManual(), { ran: false, reason: 'handler-threw' });
});

test('triggerManual does not surface async handler rejections', async () => {
  const bridge = await importFreshBridge();
  bridge.registerManualHandler(async () => {
    throw new Error('async boom');
  });

  assert.deepEqual(bridge.triggerManual(), { ran: true });
  await new Promise((resolve) => setTimeout(resolve, 0));
});
