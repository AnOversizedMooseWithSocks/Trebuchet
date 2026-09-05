# Trebuchet Core

Trebuchet Core is the headless authority for launch planning, readiness,
integrity verification, and proof verification. It has no Electron, Express,
DOM, RPC, wallet-custody, or filesystem dependency.

The root `v2LaunchPlan.js`, `validators.js`, `lpConstants.js`, and
`scripts/v2-proof-integrity.mjs` files are compatibility adapters. New code
should import `@trebuchet/core`.

Core plan schemas and integrity results are public compatibility contracts.
Existing `trebuchet-v2-*` proof markers remain supported until a separately
versioned migration is available.
