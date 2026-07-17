# Trebuchet product requirements

## Product summary

Trebuchet is a local-first Solana launch terminal for operators who want to
create a token, deploy and permanently lock Raydium CLMM liquidity, distribute
Fee Key NFTs, preserve recovery state, and leave behind auditable launch proof
without surrendering custody to a hosted launch service.

The v2 terminal is the default desktop product. Classic remains available as an
explicit fallback and comparison reference while production field verification
is completed.

## Current status

v2 is a release candidate:

- product shell and Classic-backed token launch execution are implemented;
- demo, unit, package, Electron, API-backed E2E, viewport, and visual checks
  exist;
- production `v2+` publishing is fail-closed on field proof, independent
  attestation, and platform signing;
- the authorized funded mainnet field run has not yet supplied the checked-in
  release evidence;
- the staged NFT collection manifest is not yet proof of a live collection
  mint and must not be marketed as one.

See [GAP_ANALYSIS.md](GAP_ANALYSIS.md) for the release decision.

## Users

### Primary operator

A token creator who:

- controls the funding and destination wallets;
- understands that launch transactions are irreversible;
- wants local custody and inspectable execution;
- needs a guided path through funding, token authority, liquidity, locks,
  distribution, proof, and recovery.

### Recovery operator

The same creator, or a trusted technical operator, returning after an
interrupted launch to inspect a journal, unlock a recovery wallet, resume only
missing work, or sweep stranded assets.

### Auditor or reviewer

A person evaluating a launch dossier, authority posture, pool/position
transactions, Fee Key delivery, airdrop evidence, or a production release field
packet.

### Discovery user

A person inspecting public evidence about a mint. Discovery is an evidence tool,
not a recommendation or promotion surface.

## Product principles

1. **Local custody is explicit.** Core launch execution uses a
   Trebuchet-managed local signer.
2. **Renderer state is not authority.** The server normalizes and rebuilds
   readiness before dispatch.
3. **Proof beats presentation.** Counts, previews, and pass-shaped flags do not
   replace addresses, signatures, rows, and hashes.
4. **Recovery is a primary workflow.** Interrupted mainnet work must remain
   inspectable and safely resumable.
5. **Irreversible effects are decoded.** The operator sees destination, cost,
   transaction scope, and risk before arming.
6. **No false completion.** Staged, modeled, simulated, and proven states use
   different language.
7. **No hosted dependency for core execution.**
8. **No extraction or promotion layer.** Trebuchet does not take a supply cut or
   sell discovery placement.
9. **Dense terminal, not SaaS.** Operational evidence and next action dominate
   the interface.

## Product surfaces

### Launch

One cockpit with five workspaces:

- **Configure** — token metadata/logo, Vanity CA, pool topology,
  preallocation, airdrops, support, Fee Key recipients, report policy, sweep
  destination, and staged NFT collection manifest.
- **Fund** — proof-bound cost estimate, wallet balance, quote requirements,
  quote acquisition/manual prefund, and funding blockers.
- **Execute** — decoded next operation, guarded full runner, phase progress,
  retry state, signatures, and observed spend.
- **Verify** — report/dossier, proof audit, Classic comparison, final sweep,
  retirement gate, and field packet.
- **Recover** — active-launch recovery controls.

The first desktop viewport must show the active launch, next action, tokenomics,
liquidity shape, funding envelope, and execution/proof status without page-level
scrolling.

### Wallet

- Create or import one Trebuchet-managed launch wallet.
- Display funding address, QR, balances, and full copy access.
- Connect Solflare only for funding/destination convenience.
- Keep recovery wallets in a separate central inventory.
- Protect secret reveal and destructive actions with Recovery PIN state and
  typed confirmation.

### History

- List durable launch journals and execution-ledger records.
- Explain safe resume, unsafe/manual recovery, and missing work.
- Provide the multi-step Find → Unlock → Act → Verify recovery flow.
- Allow a recoverable wallet to be reused or swept when evidence permits.
- Keep Recovery PIN reset audit information.

### Discovery

- Inspect any supplied mint through the active RPC.
- Persist a local registry.
- Show authority posture, mint program/extensions, Raydium compatibility,
  routes/pools, holder/liquidity evidence, and confidence.
- Explain unavailable or risky evidence.
- Exclude social voting, paid placement, popularity feeds, and unproven claims.

### Settings

- Manage and health-check RPC endpoints.
- Strongly warn/block fresh mainnet work on public RPCs.
- Control demo mode and startup preferences.
- Set up, unlock, change, lock, or destructively reset the four-digit Recovery
  PIN.
- Check app/release state and updates.
- Expose local diagnostics.

## Core launch workflow

### 1. Wallet and launch identity

- Select, generate, or import a server-managed wallet.
- Optionally request a random mint or grind start/end Vanity CA targets.
- Persist candidate metadata without bulk-returning secret material.
- Bind the normalized plan to the selected wallet.

### 2. Token and distribution

- Validate name, symbol, description, whole-token supply, and logo.
- Accept PNG/JPEG logos and normalize oversized inputs before the Classic
  execution envelope.
- Configure SOL/quote pools, fee tiers, slices, ladders, support,
  preallocation, exact airdrop rows, and Fee Key recipients.
- Prevent allocation totals over 100%.
- Surface backing/risk for held reserve and airdrop allocation.

### 3. Planning and funding

- Build a server-normalized launch plan.
- Decode every planned operation, requirement, estimated cost, and effect.
- Attach a fresh Classic funding estimate with a matching fingerprint.
- Require a current selected-wallet balance check.
- Verify custom quote-token metadata, extensions, authority risk, and route.
- Block a fresh live launch on a known public RPC.

### 4. Guarded execution

- Require exact endpoint/operation confirmation before arming.
- Rebuild readiness server-side for every next operation.
- Serialize long-running mutation work by wallet.
- Create token and metadata.
- Verify mint, freeze, and metadata-update authority posture.
- Create/resume every planned pool and position.
- Lock positions through Burn & Earn.
- Record position NFT, Fee Key NFT, and open/lock/transfer signatures.
- Transfer configured Fee Keys.

### 5. Distribution and finalization

- Deliver exact configured airdrop rows.
- Require wallet and transaction evidence for completion.
- Publish a proof-bound report or record a downloaded local dossier.
- Preserve report/dossier staleness against proof and terminal-sweep hashes.
- Sweep tokens, NFTs, and SOL to the validated destination.
- Confirm wallet-empty terminal state without hiding individual transfer errors.

### 6. Verification

- Render token, authority, pool, position, Fee Key, airdrop, report, recovery,
  and final-sweep evidence.
- Export/import a full JSON proof with launch-config snapshot.
- Compare a retained Classic JSON/HTML artifact through structured fields.
- Generate parity audit, retirement gate, replacement criteria, and field
  verification.
- Route each blocker to a real existing action.

## NFT collection scope

The v2 plan currently includes:

- collection name and symbol;
- edition supply;
- local manifest URI/source;
- deterministic assignment seed;
- ownership-gate and metadata-standard declarations;
- a staged operation and pipeline UI.

This is configuration and product-contract work. Production acceptance for a
live NFT collection requires, at minimum:

- a real on-chain handler;
- collection and edition transaction signatures;
- durable journal/recovery fields;
- cost and partial-failure handling;
- proof/dossier rows;
- demo and non-demo tests;
- release-gate validation.

Until then, the surface must remain visibly **Draft/Staged** and must not claim
that a collection was minted.

## Recovery requirements

- Never auto-resume an unsafe unknown partial state.
- Reconcile journal claims with on-chain facts before deciding work is done.
- Preserve an original transaction ID when adopting already-landed work.
- Do not delete a wallet because SOL is low if a token/NFT account still has a
  balance or balance data is unavailable.
- Show the full destination for a sweep.
- Use the in-app typed confirmation dialog; never call browser `prompt()`.
- Keep recoverable inventory separate from the active wallet hierarchy.

## Proof requirements

A production-grade token launch proof must include:

- non-demo launch journal identity and local wallet;
- mint and authority posture;
- exact pool IDs and create transactions;
- exact position NFTs, open transactions, lock transactions, and Fee Key mints;
- Fee Key recipient and transfer transaction where configured;
- exact airdrop recipients/delivery transactions where configured;
- report URI or local dossier bound to the same proof;
- terminal destination, asset transfer evidence, wallet-empty state, and sweep
  evidence hash;
- complete launch-config snapshot.

The production release gate must recompute proof identity outside renderer/app
pass-state generation.

## Security and trust requirements

- Bind the server to loopback and reject untrusted Host headers.
- Require the process API session on protected routes.
- Apply CSP, frame denial, and MIME-sniff protection.
- Do not expose wallet secrets from list endpoints.
- Distinguish OS safeStorage, Recovery-PIN encryption, and plaintext fallback.
- Validate upload type, bytes, dimensions, and size server-side.
- Allow only parsed HTTPS external links.
- Block critical dependency advisories in CI; record and disposition high
  advisories before production.
- Publish checksums and per-platform trust state.

## Production v2 acceptance

A production `v2.0.0` is acceptable only when:

1. the exact v2-default commit has passed all PR/package/E2E checks;
2. one authorized funded `mainnet-beta` launch completes the full token,
   liquidity, Fee Key, distribution, report, and wallet-empty sweep path;
3. its full field proof passes the independent production gate;
4. a different reviewer approves the exact proof and raw Classic artifact
   hashes within 30 days;
5. the field-run commit is an ancestor of the release commit;
6. macOS artifacts are signed and notarized;
7. Windows artifacts are signed;
8. current dependency advisories have an explicit production disposition;
9. the NFT collection surface is either implemented and proven or clearly
   scoped as staged/non-live;
10. auto-release cannot publish the v2-default app under a `v1.x` tag.

## Non-goals

- Custodying user funds remotely.
- Guaranteeing price, volume, success, listings, or route availability.
- Hiding authority, preallocation, support, or fee-stream risk.
- Paid token placement or social ranking.
- Treating a wallet connection as permission for arbitrary transactions.
- Making a browser-only implementation a prerequisite for core launch
  execution.
- Claiming AI/avatar runtime output without verifiable execution.

## Success measures

- Demo and live launch completion rate.
- Safe resume rate after interruption.
- Reduction in failures caused by public RPC use.
- Percentage of completed launches with final proof/dossier.
- Percentage of configured Fee Key recipients with transfer proof.
- Exact airdrop delivery/proof completeness.
- Time to identify and act on a recovery blocker.
- Desktop/mobile critical-task completion without horizontal overflow.
- Discovery records with clearly classified evidence availability.
- Zero production releases that bypass field/signing gates.

## Future opportunities

After the production v2 token-launch gate is satisfied:

- proof-backed NFT collection execution;
- Fee Key portfolio tracking;
- richer Discovery evidence providers;
- multi-launch operations view;
- more modular v2 renderer/proof packages;
- browser-compatible read/configuration surfaces that do not weaken custody or
  execution boundaries.
