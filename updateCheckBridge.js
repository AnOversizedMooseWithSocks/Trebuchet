// updateCheckBridge.js
//
// Tiny shared-state module that lets main.js (which owns the
// BrowserWindow and runs the actual GitHub API call) be invoked by
// server.js (which the renderer can reach via fetch).
//
// Why this exists: the silent startup update-check needs to fire
// AFTER the splash video and the first-run disclaimer are both
// dismissed — otherwise the resulting "Update available" modal
// lands behind them and the user never sees it. The renderer is
// the only place that knows when those gates are clear, but the
// renderer can't reach main directly (no IPC, the renderer is
// fully sandboxed and talks to the local Express server via fetch).
//
// The flow:
//   1. main.js calls registerHandler(fn) at window-creation time
//   2. renderer waits for splash + disclaimer to dismiss
//   3. renderer POSTs to /api/trigger-startup-update-check
//   4. server.js's handler for that route calls trigger()
//   5. trigger() invokes the handler that main.js registered
//
// Fire-once: trigger() only invokes the handler the first time it's
// called per process. Subsequent calls (e.g. from page reloads in
// dev) are no-ops. That keeps the update-check from running
// multiple times in a single app session.

let handler = null;
let manualHandler = null;
let fired = false;

/**
 * Register the function to be called when the renderer signals that
 * the startup gates are clear. main.js calls this once at window
 * creation. Calling it again replaces the previous handler — the
 * last registration wins.
 */
export function registerHandler(fn) {
  handler = fn;
}

/**
 * Register the manual "Check for Updates" handler. Unlike the startup
 * trigger, manual checks are allowed to run repeatedly because the user
 * explicitly asked for each one.
 */
export function registerManualHandler(fn) {
  manualHandler = fn;
}

/**
 * Invoke the registered handler, but only the first time per process.
 *
 * Returns an object describing what happened:
 *   { ran: true }                                — handler was called
 *   { ran: false, reason: 'already-fired' }      — guard tripped
 *   { ran: false, reason: 'no-handler' }         — never registered
 *   { ran: false, reason: 'handler-threw' }      — handler errored
 *
 * Errors thrown by the handler are caught so a bug in the handler
 * can't take down whatever code path called trigger() (typically an
 * Express request handler that should still return 200 to the
 * renderer's fire-and-forget POST).
 */
export function trigger() {
  if (fired) return { ran: false, reason: 'already-fired' };
  fired = true;
  if (!handler) return { ran: false, reason: 'no-handler' };
  try {
    const result = handler();
    if (result && typeof result.catch === 'function') {
      result.catch((err) => console.warn('Startup update-check handler rejected:', err && err.message));
    }
    return { ran: true };
  } catch (err) {
    console.warn('Startup update-check handler threw:', err && err.message);
    return { ran: false, reason: 'handler-threw' };
  }
}

/**
 * Invoke the manual update-check handler. The result is pushed to the
 * renderer by main.js, matching the Help menu behavior.
 */
export function triggerManual() {
  if (!manualHandler) return { ran: false, reason: 'no-handler' };
  try {
    const result = manualHandler();
    if (result && typeof result.catch === 'function') {
      result.catch((err) => console.warn('Manual update-check handler rejected:', err && err.message));
    }
    return { ran: true };
  } catch (err) {
    console.warn('Manual update-check handler threw:', err && err.message);
    return { ran: false, reason: 'handler-threw' };
  }
}
