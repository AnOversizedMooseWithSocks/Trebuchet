# Trebuchet PRD

## Summary

Trebuchet is a local-first Solana token launch application. It helps a user mint an SPL token, configure one or more Raydium CLMM liquidity pools, lock positions through Burn & Earn, transfer Fee Key NFTs, sweep remaining assets to a destination wallet, and produce an auditable launch report.

The product posture is deliberately anti-extractive: no launch fee, no supply cut, no hosted custody, no middleman. The user runs the app on their own machine, uses their own RPC endpoint, and signs with a launch-specific temporary wallet.

Trebuchet currently ships as an Electron desktop app backed by a local Express server and browser UI. v2 should become the main product identity: a modern wallet-like launch console with a local SPA/WASM path, a browser-extension direction, and Discovery for tokens that meet Trebuchet standards for liquidity diversity, holder distribution, authority posture, and launch provenance.

## Problem

Launching a token with honest liquidity is operationally hard. A credible launch requires many steps that are easy to misconfigure or partially complete:

- RPC endpoints can throttle mid-launch.
- Token metadata and authority settings must be correct before the token becomes immutable.
- CLMM pool creation has several price, tick, mint-order, rent, and quote-token edge cases.
- Liquidity positions need to be opened, locked, recorded, and sometimes split among recipients.
- Airdrops and preallocations create holder-trust risks unless backed by visible support liquidity.
- Partial failures can leave durable on-chain state that must be resumed, not blindly retried.
- Teams need a post-launch report that proves what happened.

Most existing launch tools either abstract this away by taking custody/fees, or expose enough raw mechanics that non-specialists can make expensive mistakes. Trebuchet should be the credible local tool for users who want control, transparency, and recoverability.

## Users

### Primary Users

- Independent token creators launching a meme, community, brand, or utility token.
- Small teams that want locked liquidity and transferable fee streams without giving away supply allocations.
- Technically capable operators who can obtain a dedicated RPC endpoint and verify wallet addresses.

### Secondary Users

- Advisors, contributors, or partners receiving Fee Key NFTs.
- Investors, community members, and listing reviewers reading the launch report.
- Power users experimenting with pool splits, flywheel quote tokens, ladder bands, preallocations, support positions, and airdrops.

### Future Users

- Browser-extension users who want Trebuchet to behave like a wallet/signing surface.
- Web users who want a local SPA/WASM experience without installing an unsigned desktop binary.
- Discovery users who want to evaluate whether a launched token meets Trebuchet standards.

## Product Principles

- **Local first.** Private keys, temporary wallets, and launch state should stay on the user machine unless the user explicitly publishes or transfers assets.
- **No hidden economics.** Trebuchet does not take supply, fees, or custody.
- **Recoverable over clever.** Partial on-chain work must be resumable or explicitly swept; the app should not invite duplicate execution.
- **Opinionated honesty.** The app should warn about public RPC, unsafe preallocations, unlocked liquidity, authority risks, and destination-wallet irreversibility.
- **Auditability.** Every material launch artifact should appear in a shareable report.
- **Power with guardrails.** Advanced pool topology should be possible, but defaults should protect most users from obvious footguns.
- **Modern but not hypey.** v1 uses an engineering-manuscript identity; v2 can be cleaner and more wallet-like, but should remain sober and utilitarian.

## Current Product Scope

### Core Launch Flow

Trebuchet’s main user journey is a six-step launch:

1. **Generate temporary wallet**
   - Create a launch-specific keypair.
   - Show public key, QR code, and recovery phrase.
   - Store encrypted recovery material using the OS-safe storage path where available.

2. **Configure token and pools**
   - Token name, symbol, supply, description, and logo.
   - Target market cap and launch price.
   - SOL pool by default.
   - Optional flywheel pool using known quote tokens.
   - Optional LP splits into multiple Fee Key NFTs.
   - Optional starting liquidity, ladder positions, preallocation, support position, and airdrop.
   - Manual/custom pool configuration for advanced users.
   - Tokenomics visualization before funding.

3. **Fund wallet**
   - Estimate required SOL and quote-token funding.
   - Warn against public RPC usage.
   - Poll wallet balances.
   - Allow quote-token acquisition through swap flow when routeable.
   - Let users edit configuration before on-chain work begins.

4. **Create token**
   - Upload metadata and logo.
   - Mint SPL token.
   - Transfer supply to temporary wallet.
   - Revoke mint, freeze, and metadata update authorities.

5. **Create pools and positions**
   - Create CLMM pools and main positions.
   - Open ladder and bootstrap positions.
   - Lock positions through Burn & Earn.
   - Transfer Fee Key NFTs to configured recipients.
   - Surface phase progress, partial failures, and resume actions.

6. **Sweep assets**
   - Transfer Fee Key NFTs first.
   - Execute configured airdrop and track progress.
   - Sweep unallocated tokens and remaining SOL.
   - Produce or re-download launch report.

### Supporting Product Surfaces

- RPC management panel with saved endpoints, active selection, connection testing, and health display.
- Demo Mode for simulated launches without spending SOL.
- Activity/server log panel.
- Pending wallet recovery.
- Launch journal recovery and resume.
- Cancel & Refund flow.
- Update checking and release notes.
- Launch report publishing.
- Solflare browser-wallet integration in the frontend.
- Vanity wallet generation and streaming cancellation.

## Product Decisions

- v2 should become Trebuchet's primary identity and product shell. Keep the parchment v1 UI available as Classic only until v2 reaches feature parity, then retire it.
- Discovery MVP should be evidence-first: Trebuchet launch reports plus on-chain verification of authorities, pools, locks, holders, and liquidity.
- Discovery should include any token that can satisfy Trebuchet standards, not only Trebuchet-launched tokens. Trebuchet-launched tokens may have stronger provenance because their reports are richer.
- Cut user ratings, bookmarks, social signals, and synced preferences from the Discovery MVP.
- The browser extension should only sign narrow, human-readable actions: site connect, message signing, simulated transactions, wallet-safe transfers, and explicit Trebuchet launch-session approvals.
- Browser/WASM should start with configuration, demo mode, scoring, reports, validation, and wallet-adapter signing. Full Raydium/Metaplex launch orchestration remains Electron/local-backend until the dependency graph proves browser-safe.
- Unsafe preallocation and support configurations should be blocked by default, with advanced override only after an explicit consequence screen.

## v2 Product Direction

The untracked `public/v2/` mockup explores a future wallet-app shell:

- Minimal Trebuchet branding and navigation.
- Wallet-style topbar and connect state.
- Launch desk with staged transactions and extension approval window.
- Portfolio, permissions, transaction queue, extension policy controls, history.
- Discovery view for coins that meet Trebuchet standards.

v2 should not simply reskin v1. It should make Trebuchet feel like a wallet and launch operating system:

- A local app users can open as a trusted signer, evaluator, and launch cockpit.
- A browser-compatible SPA/WASM path to avoid desktop signing/notarization friction where possible.
- A Chrome extension direction for connected-site approvals.
- Discovery as a credibility layer, not a market-pump feed.
- A Classic path only while v2 reaches functional parity with the current launch flow.

## Discovery Requirements

Discovery should show coins that meet or nearly meet Trebuchet standards. It is not a price leaderboard, social feed, paid placement surface, or opinion market.

The MVP data source should be Trebuchet launch reports plus on-chain verification. Broader token inclusion is allowed when evidence can be gathered from public chain/indexer APIs and presented with confidence labels.

### Required Signals

- Liquidity diversity:
  - Number of pools.
  - Largest pool concentration.
  - Route depth and quote diversity.
- Holder distribution:
  - Top holder concentration.
  - Active holder count.
  - Known team/vesting/preallocation wallets when available.
- Authority posture:
  - Mint authority revoked.
  - Freeze authority revoked.
  - Metadata update authority revoked or explicitly disclosed.
  - Transfer fees, Token-2022 extensions, or other mint constraints disclosed.
- Launch provenance:
  - Pool-lock proof.
  - Fee Key ownership/transfer records.
  - Launch report or equivalent on-chain/off-chain audit facts.
- Market health:
  - Sustained volume.
  - Wash-trade suspicion.
  - Price/liquidity drift warnings.

### Discovery UX

- Show a Trebuchet quality score and evidence confidence.
- Explain why each token passes or is on the watchlist.
- Avoid oversized cards; use dense rows and evidence-first metrics.
- Make standards visible before the list.
- Keep user ratings, bookmarks, notes, and social voting out of the MVP.
- Clearly label any simulated/mock data until real indexers are connected.

## Functional Requirements

### P0

- Launch flow must protect against duplicate long-running operations on the same temporary wallet.
- RPC configuration must strongly steer users away from public mainnet RPC.
- Token metadata validation must enforce Solana/Metaplex limits before transaction submission.
- Funding estimator must include rent, fees, liquidity, quote-token needs, and safety buffer.
- Pool creation must record enough recoverable state to resume partial launches.
- Burn & Earn lock output must record Fee Key NFT mints, not just position NFTs.
- Sweep must prioritize Fee Key NFTs and prevent concurrent airdrop/sweep operations.
- Launch report must include token, pool, position, lock, transfer, and verification data.
- Demo Mode must mirror real-launch payload shape closely enough for user training.
- Release downloads must disclose signing/notarization status.

### P1

- Improve v2 as a production-grade shell rather than a static mockup.
- Implement local SPA/WASM mode for users who cannot or do not want to run unsigned desktop binaries.
- Define browser-extension permissions and a narrow connected-site signing workflow.
- Promote Discovery from mock data to a real local/indexed data model.
- Add richer health checks for RPC latency, throttling, and provider capability.
- Add more explicit preflight checks for pool topology and price drift.
- Improve report publishing status and retry handling.

### P2

- Multi-launch dashboard.
- Team/member Fee Key portfolio tracking.
- In-app education for flywheel risks and discovery standards.
- Optional external indexer integration.
- Signed/notarized desktop builds once credentials exist.

## Non-Goals

- Trebuchet does not custody user funds.
- Trebuchet does not guarantee token success, price performance, volume, or listings.
- Trebuchet does not promote tokens.
- Trebuchet should not hide irreversible on-chain actions behind marketing copy.
- Discovery should not become paid placement.
- Discovery should not ship social ratings or popularity mechanics in the MVP.
- The app should not depend on a hosted Trebuchet backend for core launch execution.

## Success Metrics

- Launch completion rate in Demo Mode and real mode.
- Reduction in partial-launch failures caused by public RPC usage.
- Successful resume rate after recoverable failures.
- Number of launch reports downloaded or published.
- Time from wallet generation to completed sweep.
- Number of users who run a demo launch before mainnet.
- Discovery: percentage of listed coins with complete evidence fields.
- v2: task completion on mobile-width and desktop-width layouts without horizontal overflow.

## Key Risks

- Solana/Raydium/Metaplex SDK changes can break launch flows.
- Public RPC or weak RPC providers can cause expensive mid-flow failures.
- Unsigned macOS artifacts can trigger “app is damaged” warnings.
- Browser-only/WASM mode may not support every native or Node dependency.
- Discovery scoring can create perceived endorsement or legal/reputational exposure.
- App complexity can overwhelm first-time token creators.
