// Canonical list of checks a v2 viewport-smoke proof must record, in order.
//
// server.js validates a proof artifact against this list and the smoke test
// writes it into the artifact. Both used to keep private copies, which drifted
// (the server required 7 checks while the test wrote 9), so every proof failed
// the order-and-length comparison in viewportSmokeRequiredChecksMatch().
// Keep exactly one definition.
export const V2_VIEWPORT_SMOKE_REQUIRED_CHECKS = Object.freeze([
  'launchVisible',
  'horizontalOverflow',
  'tokenomicsChart',
  'liquidityChart',
  'fundingMeter',
  'parityPanel',
  'firstViewportFit',
  'terminalPanelFit',
  'discoveryTokenViewport',
  // Accessibility evidence. The proof fails closed when this is absent or
  // false, so an inaccessible build cannot ship behind a passing manifest.
  'keyboardWalkthrough',
]);

