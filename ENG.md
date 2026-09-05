# Trebuchet engineering guide

## Purpose

Trebuchet is an Electron desktop application around a local Express execution
service. The v2 terminal is the default renderer; Classic remains a compatibility
and execution-parity surface.

The central engineering rule is:

> The renderer may propose and explain work. The local server must normalize,
> revalidate, authorize, execute, journal, and prove it.

## Runtime topology

```text
Electron main process
  ├─ selects a free 127.0.0.1 port
  ├─ configures Electron safeStorage and user-data paths
  ├─ constructs and starts the Local API explicitly
  └─ opens /v2/ by default (or / for Classic)

Loopback Express service
  ├─ static v2 and Classic assets
  ├─ process-lifetime API session
  ├─ launch planning/readiness boundary
  ├─ Solana/Raydium/Metaplex execution
  ├─ local secret/config/journal stores
  └─ progress, proof, recovery, and report APIs

Renderer
  ├─ v2: public/v2/index.html + app.js + styles.css
  └─ Classic: public/index.html + generated public/app.js
```

`main.js` binds only to `127.0.0.1`. `serverMiddleware.js` rejects unapproved
Host headers, installs CSP/frame/type-sniffing headers, and requires a
process-random `x-trebuchet-session` header for protected `/api/*` calls.

## Boot modes

| Command | UI |
| --- | --- |
| `npm start` | v2 terminal |
| `npm run start:v2` | v2 terminal |
| `npm run start:classic` | Classic parchment UI |
| `TREBUCHET_UI=classic npm start` | Classic via environment override |
| `npm run web` | local Express service; `/v2/` is the v2 route |

Electron waits for the local service before loading the renderer. External
links are opened by `main.js` only after URL parsing and an HTTPS-scheme check.

## Source map

### Desktop and server

- `main.js` — Electron lifecycle, local server boot, menus, safeStorage wiring,
  update checks, and external-link policy.
- `server.js` — constructible HTTP adapter, orchestration boundary, progress,
  launch/recovery
  handlers, and report integration.
- `serverMiddleware.js` — Host defense, CSP/security headers, API session, logo
  upload limits, and packaged public-directory resolution.
- `packages/core/` — headless plan, validation, estimate, integrity, and proof
  contracts shared by every interface.
- `packages/cli/` — experimental read-only command adapter, JSON presenters,
  atomic file output, and stable exit-code mapping.
- `v2LaunchPlan.js` — compatibility export for the Core launch-plan contract,
  including Classic execution payload mapping,
  funding fingerprints, and readiness rules.

### v2 renderer

- `public/v2/index.html` — semantic shell and render targets.
- `public/v2/app.js` — state, API client, launch/recovery/discovery controllers,
  renderers, proof generation/import, and delegated interaction handling.
- `public/v2/styles.css` — v2 terminal design system and responsive behavior.
- `public/v2/viewport-smoke-proof.json` — generated proof contract consumed by
  the replacement criteria; do not hand-edit pass flags.

### Classic renderer

- `public/index.html` — Classic shell.
- `public/modules/` — Classic source modules.
- `public/app.js` — generated concatenated bundle.
- `scripts/build-app-js.mjs` — deterministic bundle builder.

Edit `public/modules/`, run `npm run build:js`, and commit the resulting
`public/app.js`. CI rebuilds and diffs it.

### Launch domain

- `tokenService.js` / `metadataUploadService.js` — mint, metadata, logo upload,
  and authority lifecycle.
- `lpService.js`, `lpDistribution.js`, `lpMath.js`, `lpFeeTiers.js` — CLMM pool,
  position, ladder, support, lock, and Fee Key behavior.
- `lpService.js` funding estimator plus `swapService.js` / `swapMath.js` —
  funding and quote acquisition. The old standalone `lpEstimate.js` was
  removed; estimator tests import the live `lpService.js` implementation.
- `walletHelpers.js` / `walletRecovery.js` — balance, sweep, and recovery rules.
- `launchJournal.js` — durable launch checkpoints.
- `launchReportService.js` — report envelope and publishing.
- `discoveryService.js` — read-only mint inspection and evidence normalization.

### Local state and secrets

- `rpcConfig.js` → `rpcConfig.json`
- `userPrefs.js` → `userPrefs.json`
- `launchJournal.js` → `launchJournals.json`
- `pendingWallets.js` → `pendingWallets.json`
- `vanityCaStore.js` → `vanityCAs.json`
- `secretPinStore.js` → `.secretPin.json`

Electron sets `TREBUCHET_CONFIG_DIR` to its user-data directory. Plain web/test
mode falls back to the source directory unless the environment overrides it.

`secretStore.js` supports:

- `pin:` records protected by the unlocked Recovery PIN data key;
- `enc:` records protected by Electron safeStorage;
- `plain:` fallback records when a secure backend is unavailable.

The plaintext fallback prevents silent loss of a recovery secret, but it is a
real security downgrade. The UI and documentation must not imply OS-keychain
protection in web mode or on a platform where Electron reports an insecure
storage backend. See [SECURITY.md](SECURITY.md).

## v2 planning boundary

`POST /api/v2/launch-plan` converts renderer input into a normalized contract:

- token metadata and normalized logo;
- selected wallet binding;
- Vanity CA targets/candidate;
- pool topology, quote venues, fee tiers, slices, ladders, support;
- preallocation and exact airdrop rows/counts;
- report and sweep policy;
- decoded operations, cost model, and guardrails.

A plan is not authority to send transactions. For a fresh live launch,
`POST /api/v2/execution-readiness` and
`POST /api/v2/run-envelope/execute-next` rebuild the relevant state from:

- the selected server-managed wallet;
- current RPC configuration;
- the normalized plan/config fingerprint;
- a fresh Classic funding estimate;
- selected-wallet on-chain balances;
- quote-token safety/route evidence;
- active launch journal and prior proof.

Known public RPCs, stale estimates, unsafe quote tokens, over-allocation,
unbacked airdrops/held reserve, invalid recipients, or an unresolved active
operation block a fresh run. Recovery/resume may remain available with warnings
so an already-started wallet is not stranded.

## Execution lifecycle

The guarded runner dispatches only the next safe Classic-backed operation:

1. create/select managed wallet and bind launch identity;
2. verify funding and quote requirements;
3. create token and metadata;
4. finish/verify authority revocation;
5. create or resume CLMM pools and positions;
6. lock positions and record Fee Key mints;
7. transfer configured Fee Keys;
8. execute/retry exact airdrop rows;
9. publish or download a proof-bound report/dossier;
10. perform the terminal token/NFT/SOL sweep.

## Concurrency and idempotency

Long-running mutation routes use a per-wallet launch-operation mutex. Token
creation, LP creation/resume, quote acquisition, airdrop, report, and sweep work
must not overlap unsafely.

When extending an operation:

- identify an on-chain or journal `alreadyDone` condition;
- persist a checkpoint after each irreversible phase;
- recheck on retry because the prior transaction may have landed;
- distinguish transient RPC weather, insufficient funds, deterministic failure,
  and unsafe/unknown state;
- preserve enough data for `diagnose`, resume, proof, and operator display;
- do not null or overwrite the active wallet identity on a rejected concurrent
  request.

## Proof architecture

Several artifacts are intentionally separate:

1. **Journal proof** — durable local execution state.
2. **Launch proof** — token, authorities, pools, positions, locks, Fee Keys,
   airdrop, report, and transfer evidence.
3. **Proof fingerprint** — stable JSON identity over concrete launch facts.
4. **Transfer evidence hash** — stable identity over the terminal sweep.
5. **Classic comparison** — structured evidence rows comparing a retained
   Classic JSON/HTML artifact with the v2 proof.
6. **Parity audit / retirement gate / field packet** — generated product
   readiness evaluations.
7. **Release attestation** — independent operator/reviewer approval bound to
   exact file hashes and repository history.

The application computes fingerprints for UI staleness and proof binding.
`packages/core/src/proof-integrity.js` independently implements the production
fingerprint and required Classic rows so the release gate does not trust
app-generated pass flags.

`scripts/production-release-gate.mjs` additionally verifies:

- non-demo completed journal proof;
- exact authority/pool/position/lock/Fee Key/airdrop/sweep records;
- exact local-dossier sweep binding;
- full raw Classic artifact and proof-derived comparison rows;
- SHA-256 of the exact evidence bytes and trimmed Classic input;
- evidence freshness;
- field-run commit ancestry;
- distinct GitHub operator and reviewer;
- macOS signing/notarization and Windows signing plan.

## API groups

The API is local-only but still treated as a security boundary.

| Group | Representative routes |
| --- | --- |
| Session/health | `/api/session`, `/api/rpc-health`, `/api/app-version` |
| v2 plan/run | `/api/v2/launch-plan`, `/api/v2/execution-readiness`, `/api/v2/run-envelope/*` |
| Wallet/PIN | `/api/v2/wallets`, `/api/secret-pin/*`, `/api/pending-wallets/*` |
| Token/LP | `/api/create-token`, `/api/finish-token-creation`, `/api/create-lp`, `/api/resume-launch` |
| Funding/quotes | `/api/estimate-lp-funding`, `/api/acquire-quote-tokens`, `/api/quote-token-info` |
| Distribution | `/api/run-airdrop`, `/api/retry-airdrop`, `/api/transfer-assets` |
| Proof/report | `/api/publish-launch-report`, `/api/v2/viewport-smoke-proof` |
| Recovery | `/api/launch-journals`, `/api/launch-journals/resume`, `/api/diagnose-launch` |
| Discovery | `/api/v2/discovery/inspect` |
| Diagnostics | `/api/lp-progress`, `/api/airdrop-progress`, `/api/server-logs` |

New protected routes belong behind `apiSessionMiddleware`; narrowly exempt a
route only when a browser primitive cannot attach the session header and the
data/action is safe.

## Image handling

The v2 renderer may normalize an oversized logo before planning. The server
remains authoritative:

- multipart memory storage;
- 100 KB upload limit;
- PNG/JPEG/GIF MIME allowlist;
- byte sniffing and dimension validation in the token pipeline;
- Classic plan maximum dimension of 1024 px and minimum dimension of 64 px.

Never trust a filename or renderer MIME type alone.

## Testing

### Baseline

```bash
npm run check:syntax
npm run check:package
npm test
```

### UI/runtime

```bash
npm run test:e2e
npm run test:e2e:v2
npm run test:v2:viewport
npm run test:electron:v2
npm run test:visual
```

The packaged Linux smoke runs:

```bash
xvfb-run -a npm run test:electron:v2:packaged
```

The viewport smoke writes a self-describing proof artifact with required check
IDs and v2 asset hashes. Product code must validate the contract and identity,
not merely read `passed: true`.

### Mainnet

`npm run smoke:mainnet:readonly` and `test/smoke-launch.test.mjs` inspect live
RPC/API behavior without signing or sending. A funded transaction test is not a
normal CI step and requires explicit authorization.

## Packaging

`package.json` contains both npm `files` and electron-builder `build.files`.
`scripts/check-package-files.mjs` computes the runtime import closure from
`main.js` and fails when a reachable module is omitted.

CI package smoke targets:

- macOS arm64;
- Windows;
- Linux plus packaged v2 Electron smoke.

Release targets:

- macOS arm64 DMG;
- macOS x64 DMG;
- Windows NSIS installer and portable EXE;
- Linux AppImage and deb.

## Release flow

1. Merge to `main`.
2. Auto-release reads merged PR labels and creates the next semantic tag.
3. Release workflow runs the production gate.
4. Platform builds produce artifacts and trust metadata.
5. UI GIF capture completes.
6. GitHub Release and checksums publish.
7. GitHub Package publishes.
8. Website deploy verifies every advertised artifact before FTP upload.

V1 tags retain the prerelease/unsigned-test policy. V2+ tags fail before build
without field evidence and signing. See [docs/releasing.md](docs/releasing.md).

## Engineering change rules

- Preserve local-first operation and explicit custody.
- Keep renderer state non-authoritative.
- Bind estimates, reports, comparisons, and local artifacts to a concrete proof
  identity.
- Record transaction signatures at the most granular recoverable unit.
- Do not treat counts as substitutes for evidence rows.
- Keep resume available when blocking a fresh launch would otherwise strand
  assets.
- Use delegated events and in-app dialogs; avoid inline handlers and native
  browser prompts.
- Keep Classic behavior changes in modules and rebuild the generated bundle.
- Add adversarial tests for forged/stale/thinned proof, not only happy paths.
- Update all affected docs in the same pull request.

## Current engineering backlog

Production blockers are tracked in [GAP_ANALYSIS.md](GAP_ANALYSIS.md). Beyond
that gate, likely work includes:

- compatible upgrades/remediation for current dependency advisories;
- further extraction of large v2 renderer/proof modules;
- optional browser-compatible read/configuration surfaces only where custody
  and dependency boundaries remain explicit;
- richer external evidence sources for Discovery.
