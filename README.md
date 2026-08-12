# Trebuchet

A local-first Solana token launch terminal.

[![CI](https://github.com/AnOversizedMooseWithSocks/Trebuchet/actions/workflows/ci.yml/badge.svg)](https://github.com/AnOversizedMooseWithSocks/Trebuchet/actions/workflows/ci.yml)

Trebuchet creates an SPL token, revokes its authorities, opens single-sided
Raydium CLMM liquidity, locks positions through Burn & Earn, transfers the
resulting Fee Key NFTs, publishes or downloads a launch dossier, and sweeps the
temporary launch wallet. The signer and launch journal stay on the operator's
machine; core execution does not depend on a hosted Trebuchet backend.

The desktop app opens Trebuchet by default. The parchment interface remains
available as **Classic** while Trebuchet completes production field verification.

## Release status

The Trebuchet desktop application is a release candidate, not a published
`v2.0.0` production release.

- The Trebuchet desktop shell, guarded execution bridge, recovery flows, proof export,
  packaged runtime smoke, API-backed E2E, viewport checks, and Classic fallback
  are implemented and tested.
- A `v2+` tag fails closed unless the repository contains a recent, non-demo
  mainnet field proof and a separate two-person release attestation bound to the
  exact evidence bytes and release history.
- A `v2+` tag also requires signed and notarized macOS builds and signed Windows
  builds. It cannot fall back to unsigned test artifacts.
- Existing `v1.x` release notes disclose artifact trust. Always verify the
  release notes and `SHA256SUMS.txt` before installing.

See [the production gap](GAP_ANALYSIS.md), [the release runbook](docs/releasing.md),
and [the field-evidence procedure](release-evidence/v2/README.md).

## Safety first

A token launch sends irreversible mainnet transactions. Before a live run:

- Use a dedicated Solana RPC. Public mainnet endpoints are deliberately blocked
  for a fresh launch because throttling can leave partially completed work.
- Run **Practice run** first. Demo mode exercises the same product stages without
  sending transactions.
- Confirm the full sweep destination. Compact addresses are displayed in crypto
  style as at least the first and last four characters, for example
  `ABCD…WXYZ`, but destructive confirmations show the full value.
- Keep the Recovery PIN available. Do not discard a recovery wallet until its
  balances and launch journal have been verified.
- Treat every cost estimate as an estimate. RPC fees, rent, quote acquisition,
  price movement, and route availability can change before execution.

Trebuchet does not guarantee price performance, volume, listings, successful
route execution, or token adoption.

## Install and run

Requirements:

- Node.js `22.12.0` (the version used in CI)
- npm
- A C compiler for the optional/native Vanity CA grinder
- A dedicated RPC for a live launch

```bash
git clone https://github.com/AnOversizedMooseWithSocks/Trebuchet.git
cd Trebuchet
npm ci
npm start
```

Useful launch variants:

```bash
npm start              # Trebuchet desktop
npm run start:v2       # compatibility alias for the current Trebuchet shell
npm run start:classic  # parchment Classic fallback
npm run web            # local Express app; open /v2/ for the Trebuchet shell
```

The Electron process starts an authenticated loopback Express server on a free
port and opens the selected UI in a sandboxed browser window.

### Experimental read-only CLI

Trebuchet now includes a headless command surface for deterministic planning
and verification. It cannot create wallets or send transactions yet.

```bash
npm run cli -- doctor
npm run cli -- plan build --config launch.json --out plan.json
npm run cli -- plan verify plan.json
npm run cli -- estimate --plan plan.json
npm run cli -- proof verify proof.json
```

Add `--json` for the versioned `trebuchet-cli-result/v1` machine-output
contract. See [packages/cli/README.md](packages/cli/README.md) for exit codes
and current safety limits.

## Terminal map

### Launch

Launch is organized around the six decisions and actions a user actually takes:

- **Launch wallet** — select the temporary, locally controlled signer.
- **Token & pools** — define the token, choose the simple liquidity recipe, and
  expand optional distribution controls only when they are needed.
- **Fund wallet** — calculate the requirement, verify the wallet balance, and
  acquire or manually deposit any required quote tokens.
- **Create token** — review the permanent token facts, create the mint and
  metadata, and confirm the authority posture.
- **Create liquidity** — create pools and positions, lock liquidity, and deliver
  the Fee Keys.
- **Finish launch** — complete airdrops, sweep remaining assets to their final
  destination, and save the launch proof.

Recovery and release-comparison diagnostics remain available from History and
the collapsed diagnostics area; they are not presented as launch phases.

### Wallet

Wallet shows the selected Trebuchet-managed launch wallet, its balances, funding
address, copy/QR actions, and wallet operations. Oversized PNG/JPEG token logos
are normalized before they enter the Classic upload envelope; the live plan
enforces the Classic 100 KB and 1024 px limits.

Recovery wallets are not presented as children of the active wallet. They live
in the central recovery inventory and History workspace, where they can be
inspected, unlocked, reused, swept, or discarded with explicit confirmation.

Solflare can be connected as a funding/destination convenience. It is not used
as the Trebuchet launch signer.

### Discovery

Discovery is a personal, local token network rather than a global promotional
feed. Trebuchet-managed wallets are remembered as public-address seeds, and an
operator can add up to 25 watch-only wallet addresses explicitly. Managed
wallets do not consume those watch-only slots. A bounded scan reads
the fungible tokens held by those wallets, follows qualifying top holders one
hop, and ranks up to ten adjacent tokens with an explainable network score.
Executable/non-wallet seeds, obvious program-controlled owners, and NFT-like
receipts are excluded; repeated holder evidence is required when coverage
permits, and the relationship graph is stored only in the local
`personalDiscovery.json` profile file.

The network score measures personal holder overlap, not safety. Selecting a
known or discovered token runs the separate evidence inspection for authority,
Token-2022 compatibility, Raydium route, market, concentration, provenance, and
confidence. Unavailable evidence is labeled unavailable; it is not invented.

### History

History owns durable recovery and audit work:

- safe resume plans for launch journals;
- unsafe/manual recovery blockers;
- pending and recovery-wallet inventory;
- wallet reuse and typed sweep confirmation;
- execution ledger and observed spend;
- Recovery PIN reset audit records.

The UI uses in-app typed confirmations. It does not depend on browser
`prompt()`, which Electron does not support.

### Settings

Settings contains RPC selection and health, demo mode, Recovery PIN lifecycle,
update checks, startup preferences, release state, and local diagnostics.

## Live launch sequence

1. **Choose a launch wallet.** Trebuchet generates or imports one managed local
   wallet and records a durable journal identity.
2. **Review token and pools.** Add token metadata and logo, choose a random or
   Vanity CA, and use the simple liquidity recipe unless the launch needs quote
   pools, allocation, support, airdrops, or custom Fee Key routing. Reviewing
   the plan binds the normalized configuration to the selected wallet.
3. **Fund the launch wallet.** Calculate the current requirement, check the
   selected wallet on-chain, and acquire or manually deposit required quote
   tokens.
4. **Create the token.** Confirm the decoded operation, create metadata and mint
   supply, then verify mint, freeze, and metadata-update authority posture.
5. **Create and lock liquidity.** Create each CLMM pool, open every planned
   position, lock it through Burn & Earn, record the Fee Key NFT, and transfer
   configured Fee Keys.
6. **Finish and save proof.** Deliver configured airdrops, sweep tokens, NFTs,
   and SOL to the destination, produce the final report or local dossier, and
   retain the recovery journal until every asset is accounted for.

Interrupted work is resumable only when on-chain and journal evidence make the
next action safe. Trebuchet does not pretend an unknown partial state is
complete.

## Pool and distribution controls

- **SOL and quote pools** — use the built-in SOL, USDC, Meme, or Reserve venues,
  or verify a custom quote mint before a fresh live run.
- **Main slices** — divide a pool into multiple positions and optionally send
  Fee Key NFTs to different recipients.
- **Ladders** — distribute launched-token liquidity across simple or manual
  price bands.
- **Support** — add quote-side support below the launch price.
- **Preallocation** — hold supply outside LPs. The funding/readiness layer
  requires visible backing evidence for risky held-reserve configurations.
- **Airdrops** — attach exact recipient rows. Completion requires delivered rows
  and transaction signatures, not just a recipient count.
- **Burn & Earn** — lock positions and preserve the Fee Key NFT that claims
  trading fees.

Pairing with another token couples the launch to that token's liquidity,
authority posture, extensions, route availability, and price risk. A successful
metadata lookup is not the same as a safe quote venue.

## Proof and recovery model

Trebuchet maintains several different records because they answer different
questions:

- The **launch journal** records durable local execution checkpoints.
- The **execution ledger** explains what the guarded runner attempted.
- The **launch dossier/report** presents token, pool, position, lock, Fee Key,
  airdrop, and sweep evidence.
- The **field-verification packet** evaluates live proof, report proof, Classic
  comparison, proof audit, and replacement criteria.
- The **production attestation** is a separate reviewer decision over the exact
  field-evidence and raw Classic artifact hashes.

The production release gate independently recomputes the launch proof
fingerprint and terminal-sweep hash. Mutually consistent app-generated pass
flags are not sufficient by themselves.

## Release authenticity

Tagged releases are built from a clean checkout in GitHub Actions. Published
releases include `SHA256SUMS.txt`, per-platform trust metadata, and release notes
that identify signed, notarized, unsigned, or unsigned-test artifacts.

```bash
shasum -a 256 -c SHA256SUMS.txt
```

For the complete trust and publishing model, see
[docs/releasing.md](docs/releasing.md).

## Development

Common commands:

| Command | Purpose |
| --- | --- |
| `npm run check:syntax` | Parse-check runtime JavaScript. |
| `npm run check:package` | Verify packaged runtime import coverage. |
| `npm test` | Run the Node test suite. |
| `npm run test:cli` | Verify the experimental CLI contract and binary. |
| `npm run cli -- doctor --json` | Check the headless CLI/Core runtime. |
| `npm run test:e2e` | Run the Classic Playwright flow. |
| `npm run test:e2e:v2` | Run the API-backed Trebuchet flow. |
| `npm run test:e2e:devnet` | Run the secret-gated funded devnet transaction smoke. |
| `npm run test:v2:viewport` | Verify the Trebuchet desktop/mobile cockpit and proof contract. |
| `npm run test:electron:v2` | Smoke the Trebuchet Electron runtime. |
| `npm run test:electron:v2:packaged` | Smoke a packaged Trebuchet application. |
| `npm run test:visual` | Compare UI screenshots with visual goldens. |
| `npm run test:visual:golden:linux` | Regenerate canonical Linux goldens in the pinned CI container. |
| `npm run shots` | Regenerate the Classic reference walkthrough. |
| `npm run shots:marketing` | Regenerate the current Trebuchet website screenshots and social preview. |
| `npm run smoke:mainnet:readonly` | Run read-only mainnet compatibility probes. |
| `npm run build:c` | Build the native Vanity CA helper. |
| `npm run build:js` | Rebuild Classic `public/app.js` from `public/modules/`. |

Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request and
[ENG.md](ENG.md) before changing execution, storage, proof, or packaging code.
Dependency and secret-handling constraints are documented in
[SECURITY.md](SECURITY.md).

## Documentation map

| Document | Audience |
| --- | --- |
| [PRD.md](PRD.md) | Product scope, requirements, and acceptance criteria. |
| [DESIGN.md](DESIGN.md) | Trebuchet visual and interaction contract. |
| [ENG.md](ENG.md) | Runtime architecture, APIs, state, tests, and release engineering. |
| [CLI_UX_GAP_ANALYSIS.md](CLI_UX_GAP_ANALYSIS.md) | Refactor plan for a stable CLI/core and independently evolving desktop UX. |
| [GAP_ANALYSIS.md](GAP_ANALYSIS.md) | Remaining gap from release candidate to the production 2.0 release. |
| [SECURITY.md](SECURITY.md) | Local security model and dependency risk snapshot. |
| [docs/releasing.md](docs/releasing.md) | Tagging, signing, artifacts, and publishing. |
| [release-evidence/v2/README.md](release-evidence/v2/README.md) | Authorized field-run and attestation procedure. |

## License

MIT. Third-party fonts, icons, audio, and other assets retain their respective
licenses.
